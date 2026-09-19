/**
 * BLASTI Desktop — Loading Screen & Startup Diagnostics
 *
 * TWO launch gates (layered):
 *
 *   1. DEV GATE (getLoadingHTML) — the full diagnostics console (step grid,
 *      live log, per-step badges). ACTIVE ONLY IN DEV MODE (isDev). It runs
 *      the diagnostics visibly, then hands off to the consumer gate.
 *
 *   2. CONSUMER GATE (getConsumerGateHTML) — the customer-facing splash that
 *      shows on EVERY launch. Uses the app's REAL logo and name exactly as
 *      the web app brands them. In production it runs behind the same
 *      diagnostics: the user sees only the branded animation — and, ONLY if
 *      a fatal diagnostic error exists at the end, an error panel that
 *      BLOCKS launch (retry / quit). In dev mode it is shown after the dev
 *      gate passed, as animation-only (no diagnostics UI).
 *
 * Diagnostics flow (unchanged — runDiagnostics):
 *
 *   1. Check local server is running; if not, start it
 *   2. Check cloud API is connected
 *   3. Initialize local workspace: gated v2 initial sync with per-stage
 *      progress (IPC bridge primary, local-API HTTP fallback). Replaces the
 *      old hand-rolled per-table importer. Launch is gated on local DB
 *      readiness (fresh install offline is blocked; READY installs launch).
 *   3b. Verify: light local DB readiness snapshot via GET /api/db-status
 *   4. Disconnect from cloud API to test fallback
 *   5. Test local API by creating a queue called "next", then delete it
 *   6. Test all local API endpoints
 *   7. If all succeeded, reconnect to cloud API
 *
 * Usage (in main.js):
 *   const { getLoadingHTML, getConsumerGateHTML, runDiagnostics } = require('./loading-screen');
 *   mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(gateHTML()));
 *   await runDiagnostics(mainWindow, config);
 */

const { net } = require('electron');
const path = require('path');
const fs = require('fs');
const appVersion = require('../../package.json').version;

// ─── Diagnostic Step Definition ───────────────────────────────────────────

const DIAGNOSTIC_STEPS = [
  // ── Group 1: Core Infrastructure ─────────────────────
  {
    id: 'local-server',
    label: 'الخادم المحلي (localhost:3080)',
    icon: '🔧',
    description: 'التحقق من تشغيل الخادم المحلي وبدءه إذا لزم الأمر',
    group: 'core',
  },
  {
    id: 'cloud-api',
    label: 'خادم السحابة',
    icon: '☁️',
    description: 'التحقق من اتصال السحابة',
    group: 'core',
  },
  // ── Group 2: Workspace Initialization (gated v2 initial sync) ────────
  {
    id: 'initial-sync',
    label: 'تهيئة مساحة العمل المحلية',
    icon: '📥',
    description: 'استيراد بيانات الوكالة من السحابة إلى قاعدة البيانات المحلية (مزامنة أولية مرحلية) مع منع الدخول لوضع فارغ',
    group: 'import',
  },
  // ── Group 2b: Local DB Verification ───────────────────
  {
    id: 'verify',
    label: 'التحقق من قاعدة البيانات المحلية',
    icon: '🔍',
    description: 'فحص جاهزية قاعدة البيانات المحلية وعدد السجلات المستوردة',
    group: 'verify',
  },
  // ── Group 3: Offline Fallback Test ────────────────────
  {
    id: 'disconnect-cloud',
    label: 'فصل السحابة (اختبار)',
    icon: '🔌',
    description: 'فصل مؤقت عن السحابة لاختبار الوضع المحلي',
    group: 'offline-test',
  },
  {
    id: 'test-queue-crud',
    label: 'اختبار إنشاء/حذف طابور',
    icon: '🧪',
    description: 'إنشاء طابور "next" ثم حذفه للتأكد من عمل قاعدة البيانات المحلية',
    group: 'offline-test',
  },
  {
    id: 'test-all-endpoints',
    label: 'اختبار جميع نقاط API المحلية',
    icon: '🔗',
    description: 'فحص شامل لكل نقاط نهاية الخادم المحلي',
    group: 'offline-test',
  },
  // ── Group 4: Reconnect ───────────────────────────────
  {
    id: 'reconnect-cloud',
    label: 'إعادة الاتصال بالسحابة',
    icon: '🌐',
    description: 'إعادة الاتصال بخادم السحابة بعد نجاح الاختبارات',
    group: 'reconnect',
  },
];

// ─── Loading Screen HTML ─────────────────────────────────────────────────

function getLoadingHTML() {
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BLASTI</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      --primary: #48C9B0;
      --primary-dark: #3bae99;
      --primary-glow: rgba(72, 201, 176, 0.3);
      --bg: #0a0f1a;
      --bg-card: rgba(255, 255, 255, 0.04);
      --bg-card-hover: rgba(255, 255, 255, 0.07);
      --text: #e8edf5;
      --text-dim: #7a8599;
      --text-bright: #ffffff;
      --success: #34d399;
      --warning: #fbbf24;
      --error: #f87171;
      --border: rgba(255, 255, 255, 0.06);
    }
    body {
      font-family: 'Cairo', 'Segoe UI', 'Noto Sans Arabic', -apple-system, sans-serif;
      background: var(--bg); color: var(--text);
      height: 100vh; overflow: hidden; direction: rtl;
    }
    .bg-gradient {
      position: fixed; inset: 0;
      background:
        radial-gradient(ellipse at 20% 50%, rgba(72,201,176,0.08) 0%, transparent 50%),
        radial-gradient(ellipse at 80% 20%, rgba(72,201,176,0.05) 0%, transparent 50%),
        radial-gradient(ellipse at 50% 80%, rgba(56,189,248,0.04) 0%, transparent 50%);
      z-index: 0;
    }
    .bg-grid {
      position: fixed; inset: 0;
      background-image:
        linear-gradient(rgba(255,255,255,0.02) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255,255,255,0.02) 1px, transparent 1px);
      background-size: 60px 60px; z-index: 0;
    }

    /* === LAYOUT: single page, grid === */
    .page {
      position: relative; z-index: 1;
      display: grid;
      grid-template-rows: auto 1fr 1fr auto;
      height: 100vh;
      gap: 0;
    }

    /* --- Header --- */
    .header {
      display: flex; align-items: center; gap: 1rem;
      padding: 0.6rem 1rem;
      border-bottom: 1px solid var(--border);
      background: rgba(10, 15, 26, 0.8);
      backdrop-filter: blur(12px);
    }
    .brand-logo {
      width: 36px; height: 36px; flex-shrink: 0;
      background: linear-gradient(135deg, var(--primary), var(--primary-dark));
      border-radius: 10px; display: flex; align-items: center; justify-content: center;
      font-size: 1.1rem; color: white;
      box-shadow: 0 4px 16px var(--primary-glow);
    }
    .brand-info { flex-shrink: 0; min-width: 0; }
    .brand-name { font-size: 1rem; font-weight: 800; color: var(--text-bright); line-height: 1.2; }
    .brand-sub { font-size: 0.6rem; color: var(--text-dim); }
    .brand-version {
      font-size: 0.55rem; color: var(--primary); font-weight: 600;
      background: rgba(72, 201, 176, 0.1); padding: 1px 6px;
      border-radius: 4px; display: inline-block; margin-top: 2px;
      border: 1px solid rgba(72, 201, 176, 0.2);
    }
    .header-progress { flex: 1; min-width: 100px; }
    .progress-row {
      display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.2rem;
    }
    .progress-label { font-size: 0.65rem; color: var(--text-dim); font-weight: 600; }
    .progress-pct { font-size: 0.7rem; color: var(--primary); font-weight: 700; font-variant-numeric: tabular-nums; margin-right: auto; }
    .progress-track { height: 3px; background: var(--border); border-radius: 3px; overflow: hidden; }
    .progress-fill {
      height: 100%; width: 0%;
      background: linear-gradient(90deg, var(--primary), var(--primary-dark));
      border-radius: 3px; transition: width 0.5s cubic-bezier(0.4, 0, 0.2, 1);
      box-shadow: 0 0 10px var(--primary-glow);
    }

    /* --- Steps Section (top half) --- */
    .steps-section {
      display: flex;
      flex-direction: column;
      padding: 0.6rem 1rem 0.4rem;
      overflow: hidden;
      border-bottom: 1px solid var(--border);
      gap: 0.35rem;
    }
    .group-block {}
    .group-label {
      font-size: 0.6rem; font-weight: 700; color: var(--primary);
      text-transform: uppercase; letter-spacing: 0.5px;
      padding: 0.2rem 0;
      opacity: 0; transition: opacity 0.3s ease;
    }
    .group-label.visible { opacity: 1; }
    .steps-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0.3rem;
    }
    .steps-grid.single { grid-template-columns: 1fr; }
    .step-row {
      display: flex; align-items: center; gap: 0.45rem;
      padding: 0.32rem 0.5rem;
      border-radius: 7px;
      opacity: 0; transform: translateY(6px);
      transition: all 0.25s ease;
      background: var(--bg-card);
      border: 1px solid var(--border);
    }
    .step-row.visible { opacity: 1; transform: translateY(0); }
    .step-row.running { background: var(--bg-card-hover); border-color: rgba(72,201,176,0.15); }
    .step-row.success { background: rgba(52,211,153,0.04); border-color: rgba(52,211,153,0.12); }
    .step-row.warning { background: rgba(251,191,36,0.04); border-color: rgba(251,191,36,0.12); }
    .step-row.error { background: rgba(248,113,113,0.04); border-color: rgba(248,113,113,0.12); }

    .step-ico {
      width: 26px; height: 26px; border-radius: 6px; flex-shrink: 0;
      display: flex; align-items: center; justify-content: center;
      font-size: 0.78rem; background: rgba(255,255,255,0.03);
      border: 1px solid var(--border);
    }
    .step-row.running .step-ico { border-color: rgba(72,201,176,0.3); }
    .step-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
    .step-name { font-size: 0.7rem; font-weight: 700; color: var(--text-bright); line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .step-desc {
      font-size: 0.58rem; color: var(--text-dim); line-height: 1.2;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .step-badge {
      flex-shrink: 0; width: 20px; height: 20px;
      display: flex; align-items: center; justify-content: center;
    }
    .spinner {
      width: 14px; height: 14px; border: 2px solid rgba(72,201,176,0.2);
      border-top-color: var(--primary); border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .badge { width: 16px; height: 16px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 0.55rem; }
    .badge.ok { background: rgba(52,211,153,0.15); color: var(--success); }
    .badge.warn { background: rgba(251,191,36,0.15); color: var(--warning); }
    .badge.fail { background: rgba(248,113,113,0.15); color: var(--error); }

    /* --- Log Section (bottom half): 2 columns --- */
    .log-section {
      display: grid;
      grid-template-columns: 1fr 260px;
      gap: 0;
      overflow: hidden;
    }
    .log-col {
      display: flex; flex-direction: column;
      padding: 0.5rem 1rem;
      border-left: 1px solid var(--border);
      overflow: hidden;
    }
    .log-title {
      font-size: 0.6rem; font-weight: 700; color: var(--primary);
      text-transform: uppercase; letter-spacing: 0.5px;
      padding-bottom: 0.35rem;
      border-bottom: 1px solid var(--border);
      margin-bottom: 0.35rem;
      flex-shrink: 0;
    }
    .log-box {
      flex: 1; overflow-y: auto; border-radius: 6px;
      background: rgba(0,0,0,0.2); border: 1px solid var(--border);
      padding: 0.4rem 0.5rem;
    }
    .log-box::-webkit-scrollbar { width: 3px; }
    .log-box::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 3px; }
    .log-line {
      font-size: 0.6rem; font-family: 'Fira Code', 'Consolas', monospace;
      color: var(--text-dim); line-height: 1.6; direction: ltr; text-align: left;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .log-line.ok { color: var(--success); }
    .log-line.fail { color: var(--error); }
    .log-line.info { color: var(--primary); }

    /* --- Side Panel (stats + launch) --- */
    .side-panel {
      display: flex; flex-direction: column;
      padding: 0.5rem 1rem;
      overflow: hidden;
      gap: 0.5rem;
    }
    .side-title {
      font-size: 0.6rem; font-weight: 700; color: var(--primary);
      text-transform: uppercase; letter-spacing: 0.5px;
      padding-bottom: 0.35rem;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }
    .stats-row {
      display: flex; gap: 0.8rem; flex-shrink: 0;
    }
    .stat { display: flex; align-items: center; gap: 0.25rem; font-size: 0.65rem; color: var(--text-dim); }
    .stat-dot { width: 6px; height: 6px; border-radius: 50%; }
    .stat-dot.g { background: var(--success); }
    .stat-dot.y { background: var(--warning); }
    .stat-dot.r { background: var(--error); }
    .stat b { color: var(--text); }
    .side-spacer { flex: 1; min-height: 0; }

    /* --- Footer --- */
    .footer {
      padding: 0.6rem 1rem;
      border-top: 1px solid var(--border);
      background: rgba(10, 15, 26, 0.8);
      backdrop-filter: blur(12px);
      display: flex; align-items: center; justify-content: center; gap: 1rem;
      opacity: 0; transition: opacity 0.4s ease;
      min-height: 48px;
    }
    .footer.visible { opacity: 1; }
    .launch-btn {
      background: linear-gradient(135deg, var(--primary), var(--primary-dark));
      color: white; border: none; padding: 0.5rem 1.8rem; border-radius: 9px;
      font-size: 0.82rem; font-weight: 700; cursor: pointer;
      font-family: 'Cairo', 'Segoe UI', sans-serif;
      box-shadow: 0 4px 16px var(--primary-glow);
      animation: pulse-glow 2s ease-in-out infinite;
    }
    .launch-btn:hover { box-shadow: 0 6px 24px rgba(72,201,176,0.4); }
    @keyframes pulse-glow {
      0%, 100% { box-shadow: 0 4px 16px var(--primary-glow); }
      50% { box-shadow: 0 4px 28px rgba(72,201,176,0.5); }
    }
    .footer-hint { font-size: 0.65rem; color: var(--text-dim); }

    /* --- Error Banner (replaces launch button on failure) --- */
    .error-banner {
      padding: 0.6rem 1rem;
      border-top: 1px solid rgba(248,113,113,0.2);
      background: rgba(248,113,113,0.05);
      backdrop-filter: blur(12px);
      display: none; align-items: center; justify-content: center; gap: 1rem;
      min-height: 48px;
      opacity: 0; transition: opacity 0.4s ease;
    }
    .error-banner.visible { display: flex; opacity: 1; }
    .error-icon { font-size: 1.2rem; flex-shrink: 0; }
    .error-msg { font-size: 0.75rem; color: var(--error); font-weight: 700; }
    .error-detail { font-size: 0.6rem; color: var(--text-dim); max-width: 300px; text-align: center; line-height: 1.4; }
    .retry-btn {
      background: rgba(248,113,113,0.1); color: var(--error);
      border: 1px solid rgba(248,113,113,0.2); padding: 0.4rem 1.2rem; border-radius: 8px;
      font-size: 0.75rem; font-weight: 700; cursor: pointer;
      font-family: 'Cairo', 'Segoe UI', sans-serif;
      transition: background 0.2s;
      flex-shrink: 0;
    }
    .retry-btn:hover { background: rgba(248,113,113,0.2); }
    .quit-btn {
      background: rgba(255,255,255,0.05); color: var(--text-dim);
      border: 1px solid var(--border); padding: 0.4rem 1rem; border-radius: 8px;
      font-size: 0.7rem; font-weight: 600; cursor: pointer;
      font-family: 'Cairo', 'Segoe UI', sans-serif;
      transition: background 0.2s;
      flex-shrink: 0;
    }
    .quit-btn:hover { background: rgba(255,255,255,0.1); }

    @media (max-width: 700px) {
      .steps-grid { grid-template-columns: 1fr; }
      .log-section { grid-template-columns: 1fr; }
      .log-col { border-left: none; }
    }
  </style>
</head>
<body>
  <div class="bg-gradient"></div>
  <div class="bg-grid"></div>
  <div class="page">
    <!-- HEADER -->
    <div class="header">
      <div class="brand-logo">ب</div>
      <div class="brand-info">
        <div class="brand-name">BLASTI</div>
        <div class="brand-sub">بلاصتي — نظام إدارة الطوابير</div>
        <div class="brand-version">v${appVersion}</div>
      </div>
      <div class="header-progress">
        <div class="progress-row">
          <span class="progress-label" id="progressLabel">جاري الفحص...</span>
          <span class="progress-pct" id="progressPercent">0%</span>
        </div>
        <div class="progress-track">
          <div class="progress-fill" id="progressBar"></div>
        </div>
      </div>
    </div>

    <!-- STEPS SECTION (top half: multi-column grid) -->
    <div class="steps-section" id="stepsList"></div>

    <!-- LOG SECTION (bottom half: log + side panel) -->
    <div class="log-section">
      <div class="log-col">
        <div class="log-title">سجل العمليات المباشر</div>
        <div class="log-box" id="logPanel"></div>
      </div>
      <div class="side-panel">
        <div class="side-title">الملخص</div>
        <div class="stats-row">
          <div class="stat"><span class="stat-dot g"></span> <b id="passCount">0</b> نجح</div>
          <div class="stat"><span class="stat-dot y"></span> <b id="warnCount">0</b> تحذير</div>
          <div class="stat"><span class="stat-dot r"></span> <b id="failCount">0</b> فشل</div>
        </div>
        <div class="side-spacer"></div>
        <div id="sideLaunchArea" style="display:none">
          <button class="launch-btn" style="width:100%" onclick="window.electronAPI && window.electronAPI.finishLoading()" id="launchBtn">بدء التطبيق</button>
          <div style="font-size:0.6rem;color:var(--text-dim);text-align:center;margin-top:0.3rem" id="sideLaunchHint">جميع الفحوصات مكتملة</div>
        </div>
      </div>
    </div>

    <!-- FOOTER: launch button (success only) -->
    <div class="footer" id="launchSection">
      <button class="launch-btn" onclick="window.electronAPI && window.electronAPI.finishLoading()" id="footerLaunchBtn">بدء التطبيق</button>
      <span class="footer-hint" id="launchHint">جميع الفحوصات مكتملة — جاهز للعمل</span>
    </div>

    <!-- ERROR BANNER (shown instead of launch on failure) -->
    <div class="error-banner" id="errorBanner">
      <span class="error-icon">⚠️</span>
      <div>
        <div class="error-msg" id="errorMsg">بعض الفحوصات لم تنجح</div>
        <div class="error-detail" id="errorDetail">لا يمكن بدء التطبيق حتى تنجح جميع الفحوصات</div>
      </div>
      <button class="retry-btn" onclick="location.reload()">إعادة المحاولة</button>
      <button class="quit-btn" onclick="window.electronAPI && window.electronAPI.quitApp()">إغلاق</button>
    </div>
  </div>

  <script>
    var STEPS = ${JSON.stringify(DIAGNOSTIC_STEPS)};
    var stepsList = document.getElementById('stepsList');
    var progressBar = document.getElementById('progressBar');
    var progressPercent = document.getElementById('progressPercent');
    var progressLabel = document.getElementById('progressLabel');
    var launchSection = document.getElementById('launchSection');
    var footerLaunchBtn = document.getElementById('footerLaunchBtn');
    var launchHint = document.getElementById('launchHint');
    var errorBanner = document.getElementById('errorBanner');
    var errorMsg = document.getElementById('errorMsg');
    var errorDetail = document.getElementById('errorDetail');
    var sideLaunchArea = document.getElementById('sideLaunchArea');
    var logPanel = document.getElementById('logPanel');

    var GROUP_LABELS = { 'core': 'البنية الأساسية', 'import': 'استيراد البيانات', 'verify': 'التحقق من المزامنة', 'offline-test': 'اختبار الوضع المحلي', 'reconnect': 'إعادة الاتصال' };
    var passCount = 0, warnCount = 0, failCount = 0, allDone = false;

    // Build step cards in multi-column grid layout
    var lastGroup = null;
    var currentGroupBlock = null;
    var currentGrid = null;

    STEPS.forEach(function(step) {
      if (step.group && step.group !== lastGroup) {
        lastGroup = step.group;
        // Close previous grid if exists
        if (currentGrid) currentGroupBlock.appendChild(currentGrid);
        // Create new group block
        currentGroupBlock = document.createElement('div');
        currentGroupBlock.className = 'group-block';
        var h = document.createElement('div');
        h.className = 'group-label'; h.id = 'group-' + step.group;
        h.textContent = GROUP_LABELS[step.group] || step.group;
        currentGroupBlock.appendChild(h);
        // Create grid for step rows
        currentGrid = document.createElement('div');
        currentGrid.className = 'steps-grid';
        stepsList.appendChild(currentGroupBlock);
      }
      if (!currentGrid) {
        currentGrid = document.createElement('div');
        currentGrid.className = 'steps-grid';
        stepsList.appendChild(currentGrid);
      }
      var row = document.createElement('div');
      row.className = 'step-row'; row.id = 'step-' + step.id;
      row.title = step.description;
      row.innerHTML = '<div class="step-ico">' + step.icon + '</div>' + '<div class="step-body">' + '<div class="step-name">' + step.label + '</div>' + '<div class="step-desc" id="detail-' + step.id + '">' + step.description + '</div>' + '</div>' + '<div class="step-badge" id="status-' + step.id + '"></div>';
      currentGrid.appendChild(row);
    });
    // Close last grid
    if (currentGrid && currentGroupBlock) currentGroupBlock.appendChild(currentGrid);

    // Make single-item grids span full width
    document.querySelectorAll('.group-block').forEach(function(block) {
      var rows = block.querySelectorAll('.step-row');
      var grid = block.querySelector('.steps-grid');
      if (grid && rows.length === 1) grid.classList.add('single');
    });

    function updateProgress() {
      var done = STEPS.filter(function(s) {
        var el = document.getElementById('step-' + s.id);
        return el && (el.classList.contains('success') || el.classList.contains('warning') || el.classList.contains('error'));
      }).length;
      var pct = Math.round((done / STEPS.length) * 100);
      progressBar.style.width = pct + '%';
      progressPercent.textContent = pct + '%';
    }

    function addLog(text, type) {
      var line = document.createElement('div');
      line.className = 'log-line ' + (type || '');
      line.textContent = text;
      line.title = text;
      logPanel.appendChild(line);
      logPanel.scrollTop = logPanel.scrollHeight;
    }

    function finalize() {
      document.getElementById('passCount').textContent = passCount;
      document.getElementById('warnCount').textContent = warnCount;
      document.getElementById('failCount').textContent = failCount;

      if (failCount === 0) {
        // ALL PASSED (warnings are OK — they represent expected skip conditions)
        progressLabel.textContent = warnCount > 0 ? 'اكتمل الفحص — مع تحذيرات' : 'اكتمل الفحص';
        progressLabel.style.color = '';
        launchSection.classList.add('visible');
        sideLaunchArea.style.display = 'block';
        launchHint.textContent = warnCount > 0
          ? 'جميع الفحوصات مكتملة — جاهز للعمل (مع تحذيرات)'
          : 'جميع الفحوصات مكتملة — جاهز للعمل';
        setTimeout(function() {
          if (window.electronAPI && window.electronAPI.finishLoading) window.electronAPI.finishLoading();
        }, 1500);
      } else {
        // ERRORS ONLY — block launch
        var blockedSteps = [];
        STEPS.forEach(function(s) {
          var el = document.getElementById('step-' + s.id);
          if (el && el.classList.contains('error')) {
            var statusEl = document.getElementById('status-' + s.id);
            blockedSteps.push('✗ ' + s.label);
          }
        });
        progressLabel.textContent = 'فشل الفحص — لا يمكن بدء التطبيق';
        progressLabel.style.color = '#f87171';
        progressBar.style.background = 'linear-gradient(90deg, #f87171, #dc2626)';
        errorMsg.textContent = failCount + ' فحص فشل — التطبيق لن يبدأ';
        errorDetail.textContent = 'الفحوصات التالية لم تنجح: ' + blockedSteps.join(' | ');
        errorBanner.classList.add('visible');
        // DO NOT show launch button, DO NOT auto-launch
      }
    }

    if (window.electronAPI) {
      window.electronAPI.onDiagnosticsUpdate(function(data) {
        var card = document.getElementById('step-' + data.step);
        var statusEl = document.getElementById('status-' + data.step);
        var detailEl = document.getElementById('detail-' + data.step);
        if (!card) return;
        card.classList.add('visible');
        var stepDef = STEPS.find(function(s) { return s.id === data.step; });
        if (stepDef && stepDef.group) { var g = document.getElementById('group-' + stepDef.group); if (g) g.classList.add('visible'); }
        if (data.status === 'running') {
          card.className = 'step-row visible running';
          statusEl.innerHTML = '<div class="spinner"></div>';
          if (data.message) detailEl.textContent = data.message;
        } else if (data.status === 'success') {
          card.className = 'step-row visible success';
          statusEl.innerHTML = '<div class="badge ok">✓</div>';
          if (data.message) detailEl.textContent = data.message;
          passCount++; updateProgress();
        } else if (data.status === 'warning') {
          card.className = 'step-row visible warning';
          statusEl.innerHTML = '<div class="badge warn">⚠</div>';
          if (data.message) detailEl.textContent = data.message;
          warnCount++; updateProgress();
        } else if (data.status === 'error') {
          card.className = 'step-row visible error';
          statusEl.innerHTML = '<div class="badge fail">✗</div>';
          if (data.message) detailEl.textContent = data.message;
          failCount++; updateProgress();
        }
        if (data.log) addLog(data.log, data.logType || 'info');
        var totalDone = passCount + warnCount + failCount;
        if (totalDone === STEPS.length && !allDone) { allDone = true; finalize(); }
      });

      window.electronAPI.onDiagnosticsFinalized(function(data) {
        if (allDone) return;
        allDone = true;
        STEPS.forEach(function(step) {
          var card = document.getElementById('step-' + step.id);
          if (!card) return;
          if (!card.classList.contains('success') && !card.classList.contains('warning') && !card.classList.contains('error')) {
            card.className = 'step-row visible error';
            failCount++;
            var s = document.getElementById('status-' + step.id);
            var d = document.getElementById('detail-' + step.id);
            if (s) s.innerHTML = '<div class="badge fail">✗</div>';
            if (d) d.textContent = 'لم يتم الفحص';
          }
        });
        updateProgress(); finalize();
      });

      // ── Initial-sync progress listener (channel 'initial-sync:progress') ──
      // main.js (agent 7-b) forwards runInitialSync emitFn events here via
      // webContents.send. Event shapes (apps/desktop/local-api/initial-sync.js):
      //   SYNC_STARTED         { agencyId, syncId, totalStages, snapshotSequence, resuming, resumeStage }
      //   SYNC_STAGE_STARTED   { stage, stageLabel, stageIndex, totalStages, mandatory }
      //   SYNC_STAGE_PROGRESS  { stage, current, total, percentage, batch }
      //   SYNC_STAGE_COMPLETED { stage, stageLabel, count }
      //   SYNC_ERROR           { stage, stageLabel?, error, retryable, skipped?, authFailure? }
      //   SYNC_WARNING         { stage, message, originalSequence?, currentSequence? }
      //   SYNC_COMPLETED       { agencyId, syncId, totalRecords, duration, snapshotSequence, alreadyInitialized? }
      var STAGE_AR = {
        agency: 'الوكالة', users: 'المستخدمون', services: 'الخدمات', branches: 'الفروع',
        counters: 'طاولات الخدمة', agencyStaff: 'الموظفون', queueSettings: 'إعدادات الطابور',
        smsSettings: 'إعدادات SMS', paymentSettings: 'إعدادات الدفع', reservations: 'الحجوزات',
        reviews: 'التقييمات', favorites: 'المفضلة', faqs: 'الأسئلة الشائعة',
        notifications: 'الإشعارات', announcements: 'الإعلانات', globalAnnouncements: 'الإعلانات العامة',
        transactions: 'المعاملات', subscriptionPlans: 'خطط الاشتراك', planFeatures: 'ميزات الخطة',
        validation: 'التحقق من السلامة', discovery: 'استكشاف المراحل', 'race-condition': 'فحص التزامن'
      };
      function stageLabelAr(id, fallback) { return STAGE_AR[id] || fallback || id || ''; }

      if (window.electronAPI.onInitialSyncProgress) {
        window.electronAPI.onInitialSyncProgress(function(evt) {
          if (!evt || !evt.type) return;
          var detailEl = document.getElementById('detail-initial-sync');
          try {
            switch (evt.type) {
              case 'SYNC_STARTED':
                addLog(evt.resuming
                  ? '[INFO] استكمال الاستيراد الأولي — من المرحلة ' + (evt.resumeStage || '')
                  : '[INFO] بدء الاستيراد الأولي — ' + (evt.totalStages || '?') + ' مراحل', 'info');
                break;
              case 'SYNC_STAGE_STARTED':
                if (detailEl) detailEl.textContent = 'استيراد بيانات الوكالة… ' + stageLabelAr(evt.stage, evt.stageLabel) + ' ' + ((evt.stageIndex || 0) + 1) + '/' + (evt.totalStages || '?');
                break;
              case 'SYNC_STAGE_PROGRESS':
                if (detailEl) detailEl.textContent = 'استيراد بيانات الوكالة… ' + stageLabelAr(evt.stage) + ' ' + (evt.current || 0) + (evt.total ? '/' + evt.total : '') + ' سجل';
                break;
              case 'SYNC_STAGE_COMPLETED':
                addLog('[OK] ' + stageLabelAr(evt.stage, evt.stageLabel) + ': ' + (evt.count || 0) + ' سجل', 'ok');
                break;
              case 'SYNC_WARNING':
                addLog('[WARN] ' + stageLabelAr(evt.stage) + ': ' + (evt.message || ''), 'warn');
                break;
              case 'SYNC_ERROR':
                addLog('[FAIL] ' + stageLabelAr(evt.stage, evt.stageLabel) + ': ' + (evt.error || 'خطأ غير معروف') + (evt.skipped ? ' (سيتم التخطي)' : ''), 'fail');
                break;
              case 'SYNC_COMPLETED':
                if (detailEl) detailEl.textContent = evt.alreadyInitialized
                  ? 'مساحة العمل مهيأة مسبقًا'
                  : 'اكتمل الاستيراد — ' + (evt.totalRecords || 0) + ' سجل';
                addLog(evt.alreadyInitialized
                  ? '[OK] مساحة العمل مهيأة مسبقًا — لا حاجة لإعادة الاستيراد'
                  : '[OK] اكتمل الاستيراد الأولي — ' + (evt.totalRecords || 0) + ' سجل' + (evt.duration ? ' في ' + Math.round(evt.duration / 1000) + ' ثانية' : ''), 'ok');
                break;
            }
          } catch (e) { /* never let a UI update break the gate */ }
        });
      }

      // Bridge used by the main-process diagnostics runner (runDiagnostics)
      // to trigger the initial sync through the IPC channel — window.electronAPI
      // only exists in this renderer context, not in the main process.
      // Returns { success, totalRecords?, error? } or { unavailable: true }.
      window.__blastiRunInitialSync = function() {
        if (!window.electronAPI || !window.electronAPI.initialCloudSync) {
          return Promise.resolve({ unavailable: true });
        }
        return window.electronAPI.initialCloudSync().then(function(r) {
          return r || { success: false, error: 'استجابة فارغة من جسر المزامنة' };
        }).catch(function(e) {
          return { unavailable: true, error: (e && e.message) || 'IPC failed' };
        });
      };

      if (window.electronAPI.loadingScreenReady) window.electronAPI.loadingScreenReady();
    } else {
      progressLabel.textContent = 'خطأ: جسر الإلكترون غير متاح';
    }
  </script>
</body>
</html>`;
}

// ─── Consumer Launch Gate ─────────────────────────────────────────────────
//
// The customer-facing splash. Layered ON TOP of the dev gate:
//   • PRODUCTION ('production' mode): shown on EVERY launch instead of the
//     dev console. The same diagnostics run in the main process behind it —
//     the user sees only the branded animation. If a FATAL error exists when
//     diagnostics finish, the gate reveals a compact error panel and BLOCKS
//     launch (retry / quit). On success it plays a short "ready" animation
//     and auto-launches.
//   • DEV ('dev-handoff' mode): shown AFTER the dev gate passed, with
//     animation only — no diagnostics UI, no error UI (the dev gate already
//     enforced that). main.js drives the actual app load after the animation.
//
// Branding: uses the app's REAL logo and name exactly as the web app
// (apps/web/public/logo.png + "BLASTI" + Arabic subtitle). The logo is
// embedded as a base64 data URI so the data:-URL gate needs no file:// access.

let _consumerLogoDataUrl = null;

function getConsumerLogoDataUrl() {
  if (_consumerLogoDataUrl !== null) return _consumerLogoDataUrl;
  // Same file the web app brands with, resolved for dev (monorepo), asar and
  // extraResources layouts. First hit wins; empty string = tasteful fallback.
  const candidates = [
    path.join(__dirname, 'assets', 'logo.png'),
    (typeof process !== 'undefined' && process.resourcesPath)
      ? path.join(process.resourcesPath, 'assets', 'logo.png')
      : null,
    path.join(__dirname, '..', 'web', 'public', 'logo.png'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        const buf = fs.readFileSync(candidate);
        if (buf && buf.length > 0) {
          _consumerLogoDataUrl = 'data:image/png;base64,' + buf.toString('base64');
          return _consumerLogoDataUrl;
        }
      }
    } catch { /* try next candidate */ }
  }
  _consumerLogoDataUrl = '';
  return _consumerLogoDataUrl;
}

/**
 * Build the consumer-facing launch gate.
 * @param {{ mode?: 'production' | 'dev-handoff' }} opts
 *   - 'production': diagnostics-aware (error panel + blocked launch on fatal
 *     errors; success animation + auto-launch otherwise).
 *   - 'dev-handoff': animation-only pass-through shown after the dev gate.
 */
function getConsumerGateHTML(opts = {}) {
  const mode = opts.mode === 'dev-handoff' ? 'dev-handoff' : 'production';
  const minDisplayMs = mode === 'dev-handoff' ? 1400 : 2400;
  const logoUrl = getConsumerLogoDataUrl();

  const logoMarkup = logoUrl
    ? `<img class="logo-img" src="${logoUrl}" alt="BLASTI" draggable="false" />`
    : `<div class="logo-fallback">ب</div>`;

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BLASTI</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      --primary: #48C9B0;
      --primary-dark: #3bae99;
      --primary-glow: rgba(72, 201, 176, 0.35);
      --bg: #0a0f1a;
      --text: #e8edf5;
      --text-dim: #7a8599;
      --success: #34d399;
      --error: #f87171;
      --border: rgba(255, 255, 255, 0.08);
    }
    html, body { height: 100%; }
    body {
      font-family: 'Cairo', 'Segoe UI', 'Noto Sans Arabic', -apple-system, sans-serif;
      background: var(--bg);
      color: var(--text);
      overflow: hidden;
      direction: rtl;
      display: flex; align-items: center; justify-content: center;
    }
    .glow {
      position: fixed; inset: 0; pointer-events: none;
      background:
        radial-gradient(ellipse at 50% 38%, rgba(72,201,176,0.14) 0%, transparent 55%),
        radial-gradient(ellipse at 20% 80%, rgba(72,201,176,0.06) 0%, transparent 50%),
        radial-gradient(ellipse at 85% 15%, rgba(56,189,248,0.05) 0%, transparent 50%);
    }
    .stage {
      position: relative; z-index: 1;
      display: flex; flex-direction: column; align-items: center;
      gap: 0; text-align: center;
      width: min(560px, 92vw);
    }
    .logo-wrap {
      width: 108px; height: 108px;
      border-radius: 28px;
      background: rgba(255,255,255,0.03);
      border: 1px solid var(--border);
      display: flex; align-items: center; justify-content: center;
      box-shadow: 0 12px 48px rgba(72,201,176,0.18), 0 0 0 1px rgba(72,201,176,0.08);
      animation: logo-float 3.2s ease-in-out infinite;
      overflow: hidden;
    }
    .logo-img { width: 82%; height: 82%; object-fit: contain; }
    .logo-fallback {
      width: 100%; height: 100%;
      display: flex; align-items: center; justify-content: center;
      font-size: 3rem; font-weight: 800; color: white;
      background: linear-gradient(135deg, var(--primary), var(--primary-dark));
    }
    @keyframes logo-float {
      0%, 100% { transform: translateY(0); box-shadow: 0 12px 48px rgba(72,201,176,0.18), 0 0 0 1px rgba(72,201,176,0.08); }
      50% { transform: translateY(-8px); box-shadow: 0 22px 64px rgba(72,201,176,0.30), 0 0 0 1px rgba(72,201,176,0.14); }
    }
    .brand-name {
      margin-top: 1.4rem;
      font-size: 2rem; font-weight: 800; letter-spacing: 0.5px;
      background: linear-gradient(90deg, #34d399, #2dd4bf);
      -webkit-background-clip: text; background-clip: text;
      -webkit-text-fill-color: transparent; color: transparent;
      animation: brand-in 0.7s cubic-bezier(0.2, 0.8, 0.2, 1) both;
    }
    .brand-sub {
      margin-top: 0.35rem;
      font-size: 0.85rem; color: var(--text-dim); font-weight: 600;
      animation: brand-in 0.7s 0.1s cubic-bezier(0.2, 0.8, 0.2, 1) both;
    }
    @keyframes brand-in {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .loader {
      margin-top: 2rem;
      width: 220px; height: 4px; border-radius: 4px;
      background: rgba(255,255,255,0.06);
      overflow: hidden; position: relative;
    }
    .loader-fill {
      position: absolute; top: 0; height: 100%; width: 45%;
      border-radius: 4px;
      background: linear-gradient(90deg, transparent, var(--primary), transparent);
      animation: loader-sweep 1.3s cubic-bezier(0.4, 0, 0.2, 1) infinite;
    }
    @keyframes loader-sweep {
      from { right: -45%; }
      to { right: 100%; }
    }
    .status {
      margin-top: 0.9rem;
      font-size: 0.72rem; color: var(--text-dim);
      min-height: 1.1em; transition: opacity 0.3s ease;
    }
    .success-badge {
      display: none;
      margin-top: 2rem;
      align-items: center; gap: 0.5rem;
      padding: 0.55rem 1.3rem;
      border-radius: 999px;
      background: rgba(52, 211, 153, 0.08);
      border: 1px solid rgba(52, 211, 153, 0.25);
      color: var(--success); font-size: 0.85rem; font-weight: 700;
    }
    .success-badge.visible { display: inline-flex; animation: success-pop 0.45s cubic-bezier(0.2, 1.4, 0.4, 1) both; }
    .success-badge .check {
      width: 20px; height: 20px; border-radius: 50%;
      background: var(--success); color: #052e22;
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 0.7rem; font-weight: 900;
    }
    @keyframes success-pop {
      from { opacity: 0; transform: scale(0.75); }
      to { opacity: 1; transform: scale(1); }
    }
    .stage.done .loader, .stage.done .status { display: none; }

    /* ── Error panel: ONLY revealed when diagnostics report a fatal error ── */
    .error-panel {
      display: none;
      margin-top: 1.6rem;
      width: 100%;
      padding: 1.1rem 1.2rem;
      border-radius: 16px;
      background: rgba(248, 113, 113, 0.05);
      border: 1px solid rgba(248, 113, 113, 0.22);
      text-align: right;
      animation: brand-in 0.4s ease both;
    }
    .error-panel.visible { display: block; }
    .error-panel .err-title {
      display: flex; align-items: center; gap: 0.55rem;
      font-size: 0.95rem; font-weight: 800; color: var(--error);
    }
    .error-panel .err-list {
      margin-top: 0.7rem;
      display: flex; flex-direction: column; gap: 0.45rem;
      max-height: 168px; overflow-y: auto;
    }
    .error-panel .err-item {
      font-size: 0.72rem; line-height: 1.55; color: var(--text);
      background: rgba(248, 113, 113, 0.06);
      border: 1px solid rgba(248, 113, 113, 0.14);
      border-radius: 10px; padding: 0.5rem 0.7rem;
    }
    .error-panel .err-item b { color: var(--error); font-weight: 700; }
    .error-panel .err-actions {
      margin-top: 1rem; display: flex; gap: 0.6rem; justify-content: center;
    }
    .btn {
      border: none; cursor: pointer; border-radius: 10px;
      font-family: inherit; font-weight: 700; font-size: 0.78rem;
      padding: 0.55rem 1.4rem; transition: background 0.2s, box-shadow 0.2s;
    }
    .btn-retry {
      background: linear-gradient(135deg, var(--primary), var(--primary-dark));
      color: white; box-shadow: 0 4px 16px var(--primary-glow);
    }
    .btn-retry:hover { box-shadow: 0 6px 24px rgba(72,201,176,0.45); }
    .btn-quit {
      background: rgba(255,255,255,0.05); color: var(--text-dim);
      border: 1px solid var(--border);
    }
    .btn-quit:hover { background: rgba(255,255,255,0.1); }
    .stage.failed .loader, .stage.failed .status { display: none; }

    .version {
      position: fixed; bottom: 14px; inset-inline-start: 0; inset-inline-end: 0;
      text-align: center;
      font-size: 0.62rem; color: rgba(122, 133, 153, 0.6);
      letter-spacing: 0.4px;
    }
  </style>
</head>
<body>
  <div class="glow"></div>
  <div class="stage" id="stage">
    <div class="logo-wrap" id="logoWrap">${logoMarkup}</div>
    <div class="brand-name">BLASTI</div>
    <div class="brand-sub">بلاصتي — نظام إدارة الطوابير</div>
    <div class="loader"><div class="loader-fill"></div></div>
    <div class="status" id="statusText">جاري تجهيز التطبيق…</div>
    <div class="success-badge" id="successBadge"><span class="check">✓</span> جاهز</div>

    <div class="error-panel" id="errorPanel">
      <div class="err-title">⚠️ تعذر تشغيل التطبيق</div>
      <div class="err-list" id="errList"></div>
      <div class="err-actions">
        <button class="btn btn-retry" id="retryBtn">إعادة المحاولة</button>
        <button class="btn btn-quit" id="quitBtn">إغلاق التطبيق</button>
      </div>
    </div>
  </div>

  <div class="version">BLASTI Desktop v${appVersion}</div>

  <script>
    var MODE = ${JSON.stringify(mode)};
    var MIN_DISPLAY_MS = ${minDisplayMs};
    var loadedAt = Date.now();
    var stage = document.getElementById('stage');
    var statusText = document.getElementById('statusText');
    var successBadge = document.getElementById('successBadge');
    var errorPanel = document.getElementById('errorPanel');
    var errList = document.getElementById('errList');
    var finished = false;

    // Rotating gentle status hints (animation only — never diagnostic detail;
    // detail is intentionally reserved for the error panel and the dev gate).
    var HINTS = [
      'جاري تجهيز التطبيق…',
      'التحقق من مساحة العمل المحلية…',
      'استعادة بيانات الوكالة…',
      'التحقق من الاتصال…'
    ];
    var hintIndex = 0;
    var hintTimer = setInterval(function() {
      hintIndex = (hintIndex + 1) % HINTS.length;
      statusText.style.opacity = '0';
      setTimeout(function() {
        if (!finished) {
          statusText.textContent = HINTS[hintIndex];
          statusText.style.opacity = '1';
        }
      }, 280);
    }, 2600);

    function showSuccess() {
      if (finished) return;
      finished = true;
      clearInterval(hintTimer);
      stage.classList.add('done');
      successBadge.classList.add('visible');
      if (MODE === 'production') {
        // Auto-launch once the success animation has been visible long enough
        // (MIN_DISPLAY guarantees the splash never just flashes by).
        var wait = Math.max(700, MIN_DISPLAY_MS - (Date.now() - loadedAt));
        setTimeout(function() {
          if (window.electronAPI && window.electronAPI.finishLoading) window.electronAPI.finishLoading();
        }, wait);
      }
      // 'dev-handoff': main.js drives the app load — animation only here.
    }

    function showError(errors) {
      if (finished) return;
      finished = true;
      clearInterval(hintTimer);
      stage.classList.add('failed');
      errList.innerHTML = '';
      var list = (errors && errors.length) ? errors : [{ step: '', message: 'فشل غير معروف أثناء فحوصات التشغيل' }];
      list.slice(0, 6).forEach(function(e) {
        var row = document.createElement('div');
        row.className = 'err-item';
        var label = e && e.step ? '<b>' + String(e.step) + ':</b> ' : '';
        row.innerHTML = label + String((e && e.message) || 'خطأ غير معروف').replace(/[<&]/g, '');
        errList.appendChild(row);
      });
      errorPanel.classList.add('visible');
    }

    if (window.electronAPI) {
      if (window.electronAPI.retryLoading) {
        document.getElementById('retryBtn').addEventListener('click', function() {
          // Full, correct retry: the main process reloads this gate and
          // re-runs the whole diagnostics suite (a data:-URL reload alone
          // could never re-run main-process diagnostics).
          errorPanel.classList.remove('visible');
          finished = false;
          window.electronAPI.retryLoading();
        });
      }
      document.getElementById('quitBtn').addEventListener('click', function() {
        if (window.electronAPI.quitApp) window.electronAPI.quitApp();
      });
      if (window.electronAPI.onConsumerGateSuccess) {
        window.electronAPI.onConsumerGateSuccess(function() { showSuccess(); });
      }
      if (window.electronAPI.onConsumerGateError) {
        window.electronAPI.onConsumerGateError(function(payload) { showError(payload && payload.errors); });
      }
      if (window.electronAPI.loadingScreenReady) window.electronAPI.loadingScreenReady();
    } else {
      // No bridge (e.g. preview outside Electron) — keep the animation alive
      // but never self-launch; the main-process timeout owns that decision.
      statusText.textContent = 'جاري تجهيز التطبيق…';
    }

    if (MODE === 'dev-handoff') {
      // Pure pass-through: brief branded animation then success sweep.
      setTimeout(showSuccess, 350);
    }
  </script>
</body>
</html>`;
}
// ─── Diagnostic Runner ─────────────────────────────────────────────────────

function sendUpdate(mainWindow, data) {
  // Mirror every diagnostics log line into the main-process console so the
  // `bun run electron:dev` output alone is enough to isolate failures.
  if (data && data.log) {
    const line = `[Diagnostics] ${data.log}`;
    if (data.logType === 'fail') console.error(line);
    else if (data.logType === 'warn') console.warn(line);
    else console.log(line);
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.send('diagnostics:update', data);
    } catch (e) {
      console.warn('[Diagnostics] Failed to send update:', e.message);
    }
  }
}

function probeUrl(url, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const request = net.request(url);
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      try { request.abort(); } catch { /* ignore */ }
      resolve({ ...result, timeMs: Date.now() - start });
    };
    const timer = setTimeout(() => done({ reachable: false, error: 'timeout' }), timeoutMs);
    request.on('response', (response) => {
      clearTimeout(timer);
      let body = '';
      response.on('data', (chunk) => { body += chunk.toString(); });
      response.on('end', () => {
        done({ reachable: true, statusCode: response.statusCode, body });
      });
    });
    request.on('error', (err) => {
      clearTimeout(timer);
      done({ reachable: false, error: err?.message || 'connection failed' });
    });
    try { request.end(); } catch (err) { clearTimeout(timer); done({ reachable: false, error: err?.message || 'request failed' }); }
  });
}

/**
 * Make a POST request using Electron's net module.
 *
 * CRITICAL (Task 14, corrected in Task 17): the HTTP method MUST be passed
 * in the OPTIONS OBJECT at construction time — `net.request({ method, url })`.
 * The Task 14 attempt assigned `request.method = 'POST'` AFTER construction,
 * but Electron's ClientRequest.method is not a writable instance property:
 * the assignment is silently ignored and the request still went out as GET.
 * That one ineffective fix is why field round 6 STILL showed all three
 * symptoms at once:
 *   1. cloud probe: GET /api/sync/pull → 404 (no GET route) while the engine's
 *      real POST pulled pages fine → false "cloud does not host the sync API";
 *   2. local POST /api/auth/import-session → GET → 404 → in-process fallback
 *      (plus the misleading `no route matched: GET /api/auth/import-session`);
 *   3. queue-CRUD: the "create" POST actually executed the GET list handler
 *      → `{success:true, data:[...]}` → `data.id === undefined` → the test
 *      printed "Queue created: id=undefined" and nothing was ever created.
 */
function postUrl(url, body, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const request = net.request({ method: 'POST', url });
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      try { request.abort(); } catch { /* ignore */ }
      resolve({ ...result, timeMs: Date.now() - start });
    };
    const timer = setTimeout(() => done({ reachable: false, error: 'timeout' }), timeoutMs);
    request.on('response', (response) => {
      clearTimeout(timer);
      let bodyStr = '';
      response.on('data', (chunk) => { bodyStr += chunk.toString(); });
      response.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(bodyStr); } catch { /* ignore */ }
        done({ reachable: true, statusCode: response.statusCode, body: bodyStr, json: parsed });
      });
    });
    request.on('error', (err) => {
      clearTimeout(timer);
      done({ reachable: false, error: err.message });
    });
    request.setHeader('Content-Type', 'application/json');
    try {
      request.write(JSON.stringify(body));
      request.end();
    } catch { clearTimeout(timer); done({ reachable: false, error: 'write failed' }); }
  });
}

/**
 * Make an authenticated POST request using Electron's net module.
 * Used by the startup gate for local-API endpoints that require a Bearer
 * token (e.g. POST /api/sync/initial-sync/run).
 */
function postAuthUrl(url, body, token, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const start = Date.now();
    // Method MUST be in the construction options — see the postUrl note.
    const request = net.request({ method: 'POST', url });
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      try { request.abort(); } catch { /* ignore */ }
      resolve({ ...result, timeMs: Date.now() - start });
    };
    const timer = setTimeout(() => done({ reachable: false, error: 'timeout' }), timeoutMs);
    if (token) request.setHeader('Authorization', 'Bearer ' + token);
    request.setHeader('Content-Type', 'application/json');
    request.on('response', (response) => {
      clearTimeout(timer);
      let bodyStr = '';
      response.on('data', (chunk) => { bodyStr += chunk.toString(); });
      response.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(bodyStr); } catch { /* ignore */ }
        done({ reachable: true, statusCode: response.statusCode, body: bodyStr, json: parsed });
      });
    });
    request.on('error', (err) => {
      clearTimeout(timer);
      done({ reachable: false, error: err.message });
    });
    try {
      request.write(JSON.stringify(body));
      request.end();
    } catch { clearTimeout(timer); done({ reachable: false, error: 'write failed' }); }
  });
}

/**
 * Make a PUT request using Electron's net module.
 */
function putUrl(url, body, token, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const start = Date.now();
    // Method MUST be in the construction options — see the postUrl note.
    const request = net.request({ method: 'PUT', url });
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      try { request.abort(); } catch { /* ignore */ }
      resolve({ ...result, timeMs: Date.now() - start });
    };
    const timer = setTimeout(() => done({ reachable: false, error: 'timeout' }), timeoutMs);
    if (token) request.setHeader('Authorization', 'Bearer ' + token);
    request.setHeader('Content-Type', 'application/json');
    request.on('response', (response) => {
      clearTimeout(timer);
      let bodyStr = '';
      response.on('data', (chunk) => { bodyStr += chunk.toString(); });
      response.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(bodyStr); } catch { /* ignore */ }
        done({ reachable: true, statusCode: response.statusCode, body: bodyStr, json: parsed });
      });
    });
    request.on('error', (err) => {
      clearTimeout(timer);
      done({ reachable: false, error: err.message });
    });
    try {
      request.write(JSON.stringify(body));
      request.end();
    } catch { clearTimeout(timer); done({ reachable: false, error: 'write failed' }); }
  });
}

/**
 * Make a DELETE request using Electron's net module.
 */
function deleteUrl(url, token, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const start = Date.now();
    // Method MUST be in the construction options (the historic in-try
    // `request.method = 'DELETE'` assignment was silently ignored — GET).
    const request = net.request({ method: 'DELETE', url });
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      try { request.abort(); } catch { /* ignore */ }
      resolve({ ...result, timeMs: Date.now() - start });
    };
    const timer = setTimeout(() => done({ reachable: false, error: 'timeout' }), timeoutMs);
    if (token) request.setHeader('Authorization', 'Bearer ' + token);
    request.on('response', (response) => {
      clearTimeout(timer);
      let bodyStr = '';
      response.on('data', (chunk) => { bodyStr += chunk.toString(); });
      response.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(bodyStr); } catch { /* ignore */ }
        done({ reachable: true, statusCode: response.statusCode, body: bodyStr, json: parsed });
      });
    });
    request.on('error', (err) => {
      clearTimeout(timer);
      done({ reachable: false, error: err.message });
    });
    try { request.end(); } catch { clearTimeout(timer); done({ reachable: false, error: 'delete failed' }); }
  });
}

/**
 * Make a PATCH request using Electron's net module.
 */
function patchUrl(url, body, token, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const start = Date.now();
    // Method MUST be in the construction options — see the postUrl note.
    const request = net.request({ method: 'PATCH', url });
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      try { request.abort(); } catch { /* ignore */ }
      resolve({ ...result, timeMs: Date.now() - start });
    };
    const timer = setTimeout(() => done({ reachable: false, error: 'timeout' }), timeoutMs);
    if (token) request.setHeader('Authorization', 'Bearer ' + token);
    request.setHeader('Content-Type', 'application/json');
    request.on('response', (response) => {
      clearTimeout(timer);
      let bodyStr = '';
      response.on('data', (chunk) => { bodyStr += chunk.toString(); });
      response.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(bodyStr); } catch { /* ignore */ }
        done({ reachable: true, statusCode: response.statusCode, body: bodyStr, json: parsed });
      });
    });
    request.on('error', (err) => {
      clearTimeout(timer);
      done({ reachable: false, error: err.message });
    });
    try {
      request.write(JSON.stringify(body));
      request.end();
    } catch { clearTimeout(timer); done({ reachable: false, error: 'write failed' }); }
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Main Diagnostics Flow ─────────────────────────────────────────────────

async function runDiagnostics(mainWindow, config) {
  const { cloudBaseUrl, isDev, userDataPath } = config;
  const results = [];

  /**
   * Compute the diagnostics verdict, notify the renderer, and return the
   * launch-gate result. Used by the normal end-of-run path and by the
   * early-return when the local database fails startup initialization.
   */
  function finalizeDiagnostics() {
    const allPassed = results.every(r => r.status === 'success');
    const hasWarnings = results.some(r => r.status === 'warning');
    const hasErrors = results.some(r => r.status === 'error');

    const successCount = results.filter(r => r.status === 'success').length;
    console.log(`[Diagnostics] Complete — ${successCount}/${results.length} passed`);
    // Full per-step breakdown — the console alone isolates which steps
    // failed and why (the loading-screen panel shows the same, truncated).
    // Problem 5 (review): results are grouped by EVIDENCE CLASS —
    //   STRUCTURAL   → routes exist and answer with a valid shape
    //   BEHAVIORAL   → real agency data present, offline mutations work
    //   CONNECTIVITY → cloud origin reachable, sync API actually hosted
    //   INITIALIZATION → workspace state machine (NOT_INITIALIZED→READY)
    // "29/29 endpoints passed" is STRUCTURAL evidence only and must never
    // be read as "the desktop can operate offline".
    const STEP_CATEGORY = {
      'local-server': 'STRUCTURAL',
      'test-all-endpoints': 'STRUCTURAL',
      'test-queue-crud': 'BEHAVIORAL',
      'verify': 'BEHAVIORAL',
      'cloud-api': 'CONNECTIVITY',
      'reconnect-cloud': 'CONNECTIVITY',
      'disconnect-cloud': 'CONNECTIVITY',
      'initial-sync': 'INITIALIZATION',
    };
    const workspaceVerifiedReady = (() => {
      const r = results.find(x => x.step === 'verify');
      return !!(r && r.status === 'success' && r.detail && r.detail.readiness && r.detail.readiness.ready === true);
    })();

    // ── Launch-readiness vs cloud-sync separation (offline-first) ─────────
    // Three-level model (strict about invariants, flexible about temporary
    // conditions):
    //   FATAL (blocks)      → local DB broken, schema incompatible, workspace
    //                         not READY when it must be (fresh install offline,
    //                         failed import) — already reported as errors above
    //                         and left untouched here.
    //   RECOVERABLE (warn)  → cloud API unreachable / sync endpoint missing /
    //                         reconnect failure ONCE the local workspace is
    //                         READY. The queue keeps operating from SQLite,
    //                         mutations queue in the outbox, and the engine
    //                         replays them when connectivity returns. Blocking
    //                         a READY desktop because the CLOUD is down would
    //                         contradict the offline-first design.
    //   DIAGNOSTIC (report) → route-probe inconsistencies are reported
    //                         truthfully with their evidence class; they do
    //                         not gate launch on their own.
    if (workspaceVerifiedReady) {
      for (const r of results) {
        if (r.status === 'error' && STEP_CATEGORY[r.step] === 'CONNECTIVITY') {
          r.status = 'warning';
          r.downgradedFromError = true;
          r.message = `${r.message} — [مساحة العمل جاهزة: يعمل محليًا، المزامنة ستُستأنف تلقائيًا]`;
          console.log(`[Diagnostics] Launch gate: ${r.step} error DOWNGRADED to warning — workspace is READY, cloud unavailability degrades synchronization, not the desktop (offline-first). Local queue remains fully usable; the engine replays automatically when connectivity returns.`);
        }
      }
    } else {
      console.log('[Diagnostics] Launch gate: workspace NOT verified READY — connectivity errors stay FATAL (a fresh/uninitialized install requires the cloud for the first import).');
    }
    console.log('[Diagnostics] ────── RESULTS BREAKDOWN ──────');
    for (const r of results) {
      const icon = r.status === 'success' ? '✓' : r.status === 'warning' ? '▲' : '✗';
      const category = STEP_CATEGORY[r.step] || 'GENERAL';
      console.log(`[Diagnostics] ${icon} [${String(r.status).toUpperCase()}] (${category}) ${r.step} — ${r.message || '(no message)'}`);
      if (r.detail && r.status !== 'success') {
        try { console.log(`[Diagnostics]     ${r.step} detail: ${JSON.stringify(r.detail).substring(0, 600)}`); } catch { /* ignore */ }
      }
    }
    if (!workspaceVerifiedReady) {
      console.log('[Diagnostics] NOTE: structural tests (endpoint probes) prove ROUTES answer — NOT that the workspace can operate offline. Offline-readiness requires INITIALIZATION=READY + behavioral tests passing.');
    }
    const finalErrors = results.filter(r => r.status === 'error');
    const finalWarnings = results.filter(r => r.status === 'warning');
    if (finalErrors.length) console.error(`[Diagnostics] ${finalErrors.length} ERROR(S) → ${finalErrors.map(r => r.step).join(', ')}`);
    if (finalWarnings.length) console.warn(`[Diagnostics] ${finalWarnings.length} WARNING(S) → ${finalWarnings.map(r => r.step).join(', ')}`);
    if (!finalErrors.length && !finalWarnings.length) console.log('[Diagnostics] All checks passed cleanly.');

    try {
      mainWindow.webContents.send('diagnostics:finalized', {
        completedSteps: results.map(r => r.step),
        totalSteps: DIAGNOSTIC_STEPS.length,
      });
    } catch (_) { /* window may be gone */ }

    return { results, allPassed: allPassed || (!hasErrors && hasWarnings) };
  }

  console.log('[Diagnostics] Starting startup diagnostics (new flow)...');

  let localApiPort = null;
  let cloudAvailable = false;
  let localApiToken = null;
  let agencyId = null;
  let cloudAuthToken = null;
  let cloudUser = null;

  // ── Per-step console detail (isolation aid) ─────────────────────────────
  // Every result is printed with a status icon, step name, human message and
  // compact detail JSON — the console alone is enough to triage failures.
  const STATUS_ICON = { success: '✓', warning: '▲', error: '✗' };
  function pushResult(result) {
    results.push(result);
    sendUpdate(mainWindow, result);
    const icon = STATUS_ICON[result.status] || '·';
    let line = `[Diagnostics] ${icon} ${result.step}: ${String(result.status).toUpperCase()}${result.message ? ` — ${result.message}` : ''}`;
    if (result.detail) {
      try {
        const d = JSON.stringify(result.detail);
        if (d && d !== '{}') line += ` | detail: ${d.substring(0, 300)}`;
      } catch { /* non-serializable detail */ }
    }
    (result.status === 'error' ? console.error : result.status === 'warning' ? console.warn : console.log)(line);
  }

  // ── 0. Load stored credentials (BEFORE every step) ──────────────────────
  // Moved ahead of the cloud probe so the sync-endpoint validation can
  // authenticate — some API builds answer 404 for unauthenticated requests,
  // which previously produced false "misconfigured origin" verdicts.
  let storedAuth = null;
  try {
    const pathMod = require('path');
    const fs = require('fs');
    const authStorePath = pathMod.join(userDataPath, 'blasti-auth.json');
    if (fs.existsSync(authStorePath)) {
      try {
        storedAuth = JSON.parse(fs.readFileSync(authStorePath, 'utf-8'));
        const u = storedAuth.user || {};
        console.log(`[Diagnostics] Stored auth: user=${u.username || u.email || '?'} agency=${u.agencyId ? String(u.agencyId).substring(0, 8) + '…' : 'none'} token=${storedAuth.token ? `present (${String(storedAuth.token).length} chars)` : 'MISSING'}`);
      } catch (parseErr) {
        console.warn(`[Diagnostics] Stored auth file malformed (${authStorePath}): ${parseErr.message}`);
      }
    } else {
      console.log('[Diagnostics] No stored auth file (blasti-auth.json) — onboarding path');
    }
  } catch (authErr) {
    console.warn('[Diagnostics] Could not read stored auth:', authErr.message);
  }

  if (storedAuth && storedAuth.token && storedAuth.user) {
    // ── 0b. "Keep signed in on this device" gate (Task 14) ──────────
    // LocalDeviceCredential enables offline unlock; the keep_signed_in
    // preference (persisted in _sync_meta by the local API) decides whether
    // the stored session is restored AUTOMATICALLY or the user must unlock
    // with their password. Only an explicit 'false' changes behavior — the
    // default (unset) keeps the historic always-restore semantics. Read
    // from the authoritative local DB; a fresh/unreadable DB keeps the
    // default (the gate is best-effort by design).
    try {
      const { localDb: earlyDb } = require('./local-api/lib/db');
      if (earlyDb) {
        const keepRows = await earlyDb.$queryRawUnsafe("SELECT value FROM \"_sync_meta\" WHERE key = 'keep_signed_in'").catch(() => null);
        if (keepRows && keepRows[0] && String(keepRows[0].value) === 'false') {
          console.log('[Diagnostics] Keep signed in is OFF for this device — stored session NOT auto-restored (password unlock required)');
          sendUpdate(mainWindow, { log: '[INFO] Keep signed in is off — unlock with your password to continue', logType: 'info' });
          storedAuth = null;
        }
      }
    } catch { /* default remains auto-restore */ }
  }

  if (storedAuth && storedAuth.token && storedAuth.user) {
    cloudAuthToken = storedAuth.token;
    cloudUser = storedAuth.user;
    agencyId = cloudUser.agencyId || null;
  }

  const hasStoredSession = !!(cloudAuthToken && cloudUser);

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 1: Check/Start Local Server
  // ═══════════════════════════════════════════════════════════════════════
  sendUpdate(mainWindow, {
    step: 'local-server',
    status: 'running',
    message: 'جاري فحص الخادم المحلي...',
  });

  await delay(300);

  let serverResult = { step: 'local-server', status: 'error', message: 'فشل تشغيل الخادم المحلي' };

  try {
    // First check if the server is already running
    const healthCheck = await probeUrl('http://127.0.0.1:3080/api/health', 2000);

    if (healthCheck.reachable && healthCheck.statusCode === 200) {
      localApiPort = 3080;
      serverResult = {
        step: 'local-server',
        status: 'success',
        message: `الخادم المحلي يعمل بالفعل على المنفذ ${localApiPort} (${healthCheck.timeMs}ms)`,
        detail: { port: localApiPort, responseTime: healthCheck.timeMs },
      };
      sendUpdate(mainWindow, { ...serverResult, log: `[OK] Local server already running on :${localApiPort}`, logType: 'ok' });
      console.log(`[Diagnostics] Local server already running on :${localApiPort}`);
    } else {
      // Need to start the server — initialize DB first
      sendUpdate(mainWindow, {
        step: 'local-server',
        status: 'running',
        message: 'جاري تهيئة قاعدة البيانات المحلية...',
        log: '[INFO] Server not running — initializing database...',
        logType: 'info',
      });

      const pathMod = require('path');
      const fs = require('fs');
      // Single authoritative DB dir (spec §5/§6): main.js already resolved
      // <userData>/blasti-local at module scope. Do NOT override a value set
      // by main — this is a consistency assertion, not a second decision.
      const localDbDir = pathMod.join(userDataPath, 'blasti-local');
      if (!process.env.BLASTI_LOCAL_DB_DIR) {
        process.env.BLASTI_LOCAL_DB_DIR = localDbDir;
      }

      if (!fs.existsSync(localDbDir)) {
        fs.mkdirSync(localDbDir, { recursive: true });
      }

      // Initialize Prisma DB
      const dbModule = require('./local-api/lib/db');
      let localDb = dbModule.localDb;
      const { setupPragmas, getDbStatus, reinitClient, generatePrismaClient } = dbModule;
      let dbStatus = getDbStatus();

      if ((!localDb || !dbStatus.ready) && dbStatus.hasPrismaClient) {
        if (reinitClient()) {
          localDb = dbModule.localDb;
          dbStatus = getDbStatus();
        }
      }
      if ((!localDb || !dbStatus.ready) && !dbStatus.hasPrismaClient) {
        sendUpdate(mainWindow, {
          step: 'local-server',
          status: 'running',
          message: 'جاري إنشاء عميل قاعدة البيانات...',
          log: '[INFO] Generating Prisma client...',
          logType: 'info',
        });
        if (generatePrismaClient() && reinitClient()) {
          localDb = dbModule.localDb;
          dbStatus = getDbStatus();
        }
      }

      if (!localDb || !dbStatus.ready) {
        serverResult = {
          step: 'local-server',
          status: 'error',
          message: `قاعدة البيانات غير متاحة — ${dbStatus.error || 'خطأ غير معروف'}`,
        };
      } else {
        // Controlled NON-DESTRUCTIVE schema lifecycle (spec §1-§4): resolves
        // the authoritative path, migrates a legacy DB (copy+verify),
        // creates/adopts/upgrades the schema without ever dropping tables,
        // and verifies required tables + integrity. Replaces the old
        // `prisma db push --accept-data-loss` startup push entirely.
        try {
          const dbReadyResult = await dbModule.ensureDatabaseReady();
          if (!dbReadyResult.ok) {
            console.error('[Diagnostics] Local DB schema initialization FAILED:', dbReadyResult.error);
            serverResult = {
              step: 'local-server',
              status: 'error',
              message: `فشل تهيئة قاعدة البيانات المحلية — ${dbReadyResult.error || 'خطأ غير معروف'}`,
            };
            pushResult(serverResult);
            // Jump to summary — later steps cannot run without a DB.
            return finalizeDiagnostics();
          }
        } catch (dbReadyErr) {
          console.error('[Diagnostics] ensureDatabaseReady threw:', dbReadyErr.message);
        }
        await setupPragmas();
        await localDb.$queryRaw`SELECT 1 as ok`;

        sendUpdate(mainWindow, {
          step: 'local-server',
          status: 'running',
          message: 'جاري تشغيل الخادم المحلي...',
          log: '[INFO] Database OK, starting local API server...',
          logType: 'info',
        });

        // Start the local API server
        const localApi = require('./local-api/index');
        const startResult = await localApi.startLocalApi(
          null,
          localApi.DEFAULT_PORT,
        );
        localApiPort = startResult.port;

        // Verify it responds
        let verifyCheck = await probeUrl(`http://127.0.0.1:${localApiPort}/api/health`, 3000);
        if (!verifyCheck.reachable) {
          await delay(1000);
          verifyCheck = await probeUrl(`http://127.0.0.1:${localApiPort}/api/health`, 3000);
        }

        if (verifyCheck.reachable) {
          // Read the authoritative path from the DB manager (never recompute).
          const dbPath = dbModule.getDbStatus().path || pathMod.join(localDbDir, 'local.db');
          const dbSize = fs.existsSync(dbPath) ? `${Math.round(fs.statSync(dbPath).size / 1024)}KB` : 'جديد';
          serverResult = {
            step: 'local-server',
            status: 'success',
            message: `الخادم المحلي يعمل على المنفذ ${localApiPort} — قاعدة بيانات ${dbSize} (${verifyCheck.timeMs}ms)`,
            detail: { port: localApiPort, responseTime: verifyCheck.timeMs, dbSize },
          };
          sendUpdate(mainWindow, { log: `[OK] Local server started on :${localApiPort} (DB: ${dbSize})`, logType: 'ok' });
        } else {
          serverResult = {
            step: 'local-server',
            status: 'error',
            message: `الخادم لم يستجب على المنفذ ${localApiPort}`,
          };
        }
      }
    }
  } catch (err) {
    serverResult = {
      step: 'local-server',
      status: 'error',
      message: `فشل: ${err.message.substring(0, 80)}`,
    };
    console.error('[Diagnostics] Local server error:', err.message);
  }

  pushResult(serverResult);

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 2: Check Cloud API Connection
  // ═══════════════════════════════════════════════════════════════════════
  sendUpdate(mainWindow, {
    step: 'cloud-api',
    status: 'running',
    message: 'جاري فحص اتصال السحابة...',
    log: `[INFO] Probing cloud at ${cloudBaseUrl}/api/health`,
    logType: 'info',
  });

  await delay(300);

  let cloudResult = { step: 'cloud-api', status: 'warning', message: 'السحابة غير متاحة' };
  try {
    // A generic health ping is NOT sufficient (spec §13): a static web host
    // can answer while every /api/* route 404s. Validate BOTH the health
    // endpoint AND a real sync endpoint before declaring the cloud OK.
    const healthUrl = `${cloudBaseUrl}/api/health`;
    const cloudProbe = await probeUrl(healthUrl, 5000);
    console.log(`[Diagnostics] Cloud probe GET ${healthUrl} → ${cloudProbe.reachable ? `HTTP ${cloudProbe.statusCode} (${cloudProbe.timeMs}ms)` : `UNREACHABLE (${cloudProbe.error || 'no connection'})`}`);
    const healthOk = cloudProbe.reachable && cloudProbe.statusCode === 200;

    // Server identity (isolation aid): distinguishes "outdated @blasti/api
    // build" from "a completely different service occupying the port" — the
    // two possible causes when health answers 200 but sync routes 404.
    // @blasti/api /api/health returns { status, service: '@blasti/api', version, ... }.
    let cloudIdentity = null;
    try {
      const healthJson = cloudProbe.body ? JSON.parse(cloudProbe.body) : null;
      if (healthJson && typeof healthJson === 'object') {
        cloudIdentity = { service: healthJson.service || healthJson.name || null, version: healthJson.version || null };
      }
    } catch { /* non-JSON health body — identity unrecognized */ }
    console.log(`[Diagnostics] Cloud identity: ${cloudIdentity && cloudIdentity.service
      ? `${cloudIdentity.service} v${cloudIdentity.version || '?'}`
      : `UNRECOGNIZED (body: ${String(cloudProbe.body || '').replace(/\s+/g, ' ').trim().substring(0, 120) || 'empty'})`}`);

    if (healthOk) {
      // Probe POST /api/sync/pull — WITH the stored token when available:
      // a REAL sync API answers 200/400/401/403/422/500, a static host (or
      // an outdated API build) answers 404. Authenticated probing avoids
      // false "misconfigured origin" verdicts on APIs that 404 when
      // unauthenticated.
      //
      // P0-2 (field round 4): a single 404 observation used to permanently
      // decide "cloud unavailable" and wedge initialization — while the
      // realtime socket proved seconds later that /api/sync/pull WAS live
      // (the cloud API was simply still registering routes / restarting).
      // The probe now RETRIES (1.2s → 2.4s) and re-reads the health payload
      // between attempts: `bootId` changes prove a process restart happened
      // mid-probe; `sync.registered` distinguishes a stale build from a
      // process split (two binaries answering the same origin).
      const syncProbeUrl = `${cloudBaseUrl}/api/sync/pull`;
      const probeBody = { agencyId: agencyId || 'diagnostics-probe' };

      const readHealthMeta = (probe) => {
        try {
          const j = probe && probe.body ? JSON.parse(probe.body) : null;
          return j && typeof j === 'object' ? {
            bootId: j.bootId || null,
            syncRegistered: !!(j.sync && j.sync.registered === true),
            syncRoutes: Array.isArray(j.sync && j.sync.routes) ? j.sync.routes : null,
          } : null;
        } catch { return null; }
      };
      const healthMeta0 = readHealthMeta(cloudProbe);
      if (healthMeta0) {
        console.log(`[Diagnostics] Cloud health meta: bootId=${healthMeta0.bootId ? String(healthMeta0.bootId).substring(0, 8) + '…' : 'n/a (old build)'} | syncRoutesRegistered=${healthMeta0.syncRegistered ? 'true (' + (healthMeta0.syncRoutes || []).length + ' routes)' : 'false/unknown'}`);
      }

      let syncProbe = cloudAuthToken
        ? await postAuthUrl(syncProbeUrl, probeBody, cloudAuthToken, 5000)
        : await postUrl(syncProbeUrl, probeBody, 5000);
      let syncStatus = syncProbe?.statusCode || 0;
      let attempt = 1;
      const MAX_SYNC_PROBE_ATTEMPTS = 3;
      const PROBE_RETRY_DELAYS = [1200, 2400];
      let recoveredOnAttempt = 0;
      let bootIdChanged = false;

      while (syncStatus === 404 && attempt < MAX_SYNC_PROBE_ATTEMPTS) {
        const waitMs = PROBE_RETRY_DELAYS[attempt - 1] || 2000;
        console.log(`[Diagnostics] Sync probe got 404 (attempt ${attempt}/${MAX_SYNC_PROBE_ATTEMPTS}) — the cloud API may still be registering routes — retrying in ${waitMs}ms...`);
        sendUpdate(mainWindow, { log: `[INFO] Sync endpoint 404 — retrying (attempt ${attempt + 1}/${MAX_SYNC_PROBE_ATTEMPTS}, the cloud API may still be starting)...`, logType: 'info' });
        await delay(waitMs);
        // Re-read health between attempts: a bootId change proves the cloud
        // process restarted under us (the 404 came from the dying process).
        const healthRetry = await probeUrl(healthUrl, 4000);
        const healthMetaRetry = readHealthMeta(healthRetry);
        if (healthMeta0?.bootId && healthMetaRetry?.bootId && healthMeta0.bootId !== healthMetaRetry.bootId) {
          bootIdChanged = true;
          console.log(`[Diagnostics] Cloud bootId CHANGED between probes (${String(healthMeta0.bootId).substring(0, 8)} → ${String(healthMetaRetry.bootId).substring(0, 8)}) — the cloud API restarted mid-probe`);
        }
        syncProbe = cloudAuthToken
          ? await postAuthUrl(syncProbeUrl, probeBody, cloudAuthToken, 5000)
          : await postUrl(syncProbeUrl, probeBody, 5000);
        syncStatus = syncProbe?.statusCode || 0;
        attempt++;
        if (syncStatus > 0 && syncStatus !== 404) recoveredOnAttempt = attempt;
      }

      const syncBody = String(syncProbe?.body || '').replace(/\s+/g, ' ').trim().substring(0, 140);
      console.log(`[Diagnostics] Cloud sync probe POST ${syncProbeUrl} (${cloudAuthToken ? 'with stored token' : 'NO token'}, attempt ${attempt}/${MAX_SYNC_PROBE_ATTEMPTS}) → ${syncProbe?.reachable ? `HTTP ${syncStatus}` : `UNREACHABLE (${syncProbe?.error || 'no connection'})`}${syncBody ? ` | body: ${syncBody}` : ''}`);
      // 401/403 → the route EXISTS but rejected the credential (expired
      // token): origin is correct, re-login fixes it. 404 (after retries) →
      // this origin does not host the sync API.
      const authRejected = syncStatus === 401 || syncStatus === 403;
      const syncEndpointOk = syncStatus > 0 && syncStatus !== 404;
      if (syncEndpointOk && !authRejected) {
        cloudAvailable = true;
        cloudResult = {
          step: 'cloud-api',
          status: 'success',
          message: `السحابة متاحة — ${cloudBaseUrl} (${cloudProbe.timeMs}ms)${recoveredOnAttempt ? ` — نجحت في المحاولة ${recoveredOnAttempt}` : ''}`,
          detail: {
            url: cloudBaseUrl,
            timeMs: cloudProbe.timeMs,
            healthStatus: cloudProbe.statusCode,
            syncEndpointStatus: syncStatus,
            recoveredOnAttempt: recoveredOnAttempt || undefined,
            bootIdChangedMidProbe: bootIdChanged || undefined,
          },
        };
        if (recoveredOnAttempt) {
          sendUpdate(mainWindow, { log: `[OK] Sync API recovered on attempt ${recoveredOnAttempt} — the cloud API was still starting (transient 404)`, logType: 'ok' });
        }
        sendUpdate(mainWindow, { log: `[OK] Cloud API verified at ${cloudBaseUrl} (health ${cloudProbe.statusCode}, sync endpoint ${syncStatus})`, logType: 'ok' });
      } else if (authRejected) {
        // Origin hosts the sync API — the credential is the problem, not the URL.
        cloudAvailable = true;
        cloudResult = {
          step: 'cloud-api',
          status: 'warning',
          message: `واجهة المزامنة موجودة لكن رفضت المصادقة (HTTP ${syncStatus}) — أعد تسجيل الدخول`,
          detail: { url: cloudBaseUrl, healthStatus: cloudProbe.statusCode, syncEndpointStatus: syncStatus, syncBody: syncBody || undefined },
        };
        sendUpdate(mainWindow, { log: `[WARN] Sync API present at ${cloudBaseUrl} but auth rejected (HTTP ${syncStatus}) — re-login will refresh the token`, logType: 'warn' });
      } else if (syncStatus === 404) {
        // Classification (isolation aid), now WITH health-declared route info:
        //   syncRegistered=true  + still 404 → PROCESS SPLIT (two binaries
        //     answering the same origin, e.g. IPv4/IPv6 listeners) or a proxy;
        //   syncRegistered=false/absent + @blasti/api identity → STALE BUILD;
        //   identity unrecognized → WRONG SERVICE on the port.
        const isBlastiApi = !!(cloudIdentity && cloudIdentity.service === '@blasti/api');
        let cloudFixHint;
        if (healthMeta0?.syncRegistered) {
          cloudFixHint = 'The health endpoint DECLARES the v2 sync routes registered, yet POST /api/sync/pull 404s — two different processes are likely answering the same origin (check IPv4/IPv6 duplicate listeners: netstat -ano | findstr :3003) or a proxy is stripping the path. Kill every process on :3003 and start ONE apps/api from the current checkout (cd apps/api && bun run dev).';
        } else if (isBlastiApi) {
          cloudFixHint = 'The process DID identify as @blasti/api but does not declare the v2 sync routes (health.sync.registered is missing/false) — its RUNNING BUILD predates the v2 sync routes. Restart the cloud API from the current checkout (cd apps/api && bun run dev) so /api/sync/* gets registered.';
        } else {
          cloudFixHint = 'The process on this port did NOT identify as @blasti/api — start apps/api on this port (cd apps/api && bun run dev) or set BLASTI_CLOUD_URL to the origin that hosts the v2 sync API.';
        }
        cloudResult = {
          step: 'cloud-api',
          status: 'error',
          message: `خادم السحابة لا يستضيف واجهة المزامنة — ${cloudBaseUrl} أرجع 404 لـ /api/sync/pull (بعد ${attempt} محاولات)`,
          detail: {
            url: cloudBaseUrl,
            healthStatus: cloudProbe.statusCode,
            syncEndpointStatus: syncStatus,
            probedWithToken: !!cloudAuthToken,
            attempts: attempt,
            cloudIdentity: cloudIdentity || 'unrecognized',
            healthSyncDeclared: healthMeta0 ? healthMeta0.syncRegistered : 'unknown',
            bootIdChangedMidProbe: bootIdChanged || undefined,
            syncBody: syncBody || undefined,
            fixHint: cloudFixHint,
          },
        };
        sendUpdate(mainWindow, { log: `[ERROR] ${cloudBaseUrl} does not host the sync API (/api/sync/pull → 404 after ${attempt} attempts${cloudAuthToken ? ', with the stored token' : ''}). ${cloudFixHint}`, logType: 'fail' });
      } else {
        cloudResult = {
          step: 'cloud-api',
          status: 'warning',
          message: 'السحابة غير متاحة',
          detail: { url: cloudBaseUrl, healthStatus: cloudProbe.statusCode, syncProbeError: syncProbe?.error || 'unreachable' },
        };
        sendUpdate(mainWindow, { log: `[WARN] Cloud sync probe unreachable — continuing in offline mode (${syncProbe?.error || 'no connection'})`, logType: 'fail' });
      }
    } else {
      cloudResult = {
        step: 'cloud-api',
        status: 'warning',
        message: 'السحابة غير متاحة',
        detail: { url: cloudBaseUrl, healthStatus: cloudProbe.statusCode || null, error: cloudProbe.error || 'unreachable' },
      };
      sendUpdate(mainWindow, { log: `[WARN] Cloud API unreachable — continuing in offline mode (${cloudBaseUrl}/api/health ${cloudProbe.error || 'no connection'})`, logType: 'fail' });
    }
  } catch (err) {
    sendUpdate(mainWindow, { log: `[WARN] Cloud check error: ${err.message}`, logType: 'fail' });
  }

  pushResult(cloudResult);

  // ═══════════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════
  // STEP 3: Initialize Local Workspace (gated v2 initial sync)
  // ═══════════════════════════════════════════════════════════════════════
  // Local-first launch gate (spec §5/§7/§8). The hand-rolled per-table
  // importer (Agency/Services/Branches/Counters/Staff upserts with a hardcoded
  // "M'Sila" city fallback) that previously lived here was REMOVED — the
  // authoritative initializer is local-api/initial-sync.js runInitialSync
  // (19-stage, state machine in AgencyLocalState). It MUST run inside the
  // local API process state, so this gate drives it either:
  //   - Primary:  IPC bridge → window.electronAPI.initialCloudSync()
  //               (preload → ipcMain 'cloud-sync:initial-sync', rewired by
  //               agent 7-b to runInitialSync + forwards per-stage progress
  //               events on the 'initial-sync:progress' channel)
  //   - Fallback: POST http://127.0.0.1:{port}/api/sync/initial-sync/run
  //               (local API HTTP route exposed by agent 7-b)
  //
  // Gate behavior matrix:
  //   fresh (NOT_INITIALIZED) + online  → run sync → READY → launch
  //   fresh (NOT_INITIALIZED) + offline → BLOCKED: first setup needs internet
  //   READY + online                    → skip run (already initialized) → launch
  //   READY + offline                   → launch (offline-ready)
  sendUpdate(mainWindow, {
    step: 'initial-sync',
    status: 'running',
    message: 'جاري تهيئة مساحة العمل المحلية...',
  });

  await delay(300);

  let initResult = {
    step: 'initial-sync',
    status: 'success',
    message: 'تم التخطي — لا توجد بيانات اعتماد محفوظة (سيتم الاستيراد بعد تسجيل الدخول)',
  };

  // ── 3.0 Credentials were loaded before STEP 1 (step 0) so the cloud
  // probe could authenticate. Here we only summarize + probe local state.
  console.log(`[Diagnostics] Session: ${hasStoredSession ? `stored (${cloudUser.username || cloudUser.email || 'unknown user'})` : 'none'} | agencyId: ${agencyId ? String(agencyId).substring(0, 8) + '…' : 'none'}`);

  // Single local probe of the workspace state (initializationStatus, readiness).
  // Tolerant: the /api/db-status contract fields land with agent 7-b; when the
  // route or fields are missing we fall back to the legacy tolerant behavior.
  let preDbStatus = null;
  if (localApiPort && serverResult.status === 'success') {
    try {
      const dbStatusRes = await fetchWithAuth(
        `http://127.0.0.1:${localApiPort}/api/db-status`,
        localApiToken || cloudAuthToken,
        5000,
      );
      if (dbStatusRes && typeof dbStatusRes === 'object') preDbStatus = dbStatusRes;
    } catch { /* route may not exist yet — tolerated */ }
  }
  const preInitStatus = preDbStatus?.initializationStatus || null; // NOT_INITIALIZED | INITIALIZING | READY | FAILED | null
  const alreadyReady = preInitStatus === 'READY';

  // ── 3.1 Import session to local API (needed for authenticated local ops) ─
  // This runs in BOTH online and offline modes — offline it restores the
  // session so the renderer can talk to the local API after launch.
  let sessionImported = false;
  if (localApiPort && serverResult.status === 'success' && hasStoredSession) {
    // Identity probe (isolation aid): confirms WHAT is actually serving the
    // local port before we trust any of its answers. blasti-local answers
    // /api/discover with { service: 'blasti-local', version, mode }.
    let localIdentity = null;
    try {
      const discoverRes = await probeUrl(`http://127.0.0.1:${localApiPort}/api/discover`, 3000);
      if (discoverRes.reachable && discoverRes.body) {
        try {
          const dj = JSON.parse(discoverRes.body);
          localIdentity = { service: dj.service || null, version: dj.version || null, mode: dj.mode || null };
        } catch { /* non-JSON — identity unrecognized */ }
      }
    } catch { /* probe failure tolerated — identity stays null */ }
    console.log(`[Diagnostics] Local API identity on :${localApiPort} → ${localIdentity && localIdentity.service
      ? `${localIdentity.service} v${localIdentity.version || '?'} (${localIdentity.mode || 'unknown mode'})`
      : 'UNRECOGNIZED — the process serving this port did not answer /api/discover as blasti-local'}`);

    const importUrl = `http://127.0.0.1:${localApiPort}/api/auth/import-session`;
    try {
      const importSession = await postUrl(importUrl, {
        token: cloudAuthToken,
        user: cloudUser,
      });
      if (importSession.reachable && importSession.json?.success) {
        localApiToken = cloudAuthToken;
        sessionImported = true;
        sendUpdate(mainWindow, {
          log: `[OK] Session imported to local API — user: ${cloudUser.username || cloudUser.email}`,
          logType: 'ok',
        });
      } else {
        const importBody = String(importSession.body || '').replace(/\s+/g, ' ').trim().substring(0, 120);
        sendUpdate(mainWindow, {
          log: `[WARN] Session import failed (HTTP ${importSession.statusCode || 'n/a'})${importBody ? ` — ${importBody}` : ' — no response body'} — continuing`,
          logType: 'warn',
        });
        console.log(`[Diagnostics] Session import failed: POST ${importUrl} → HTTP ${importSession.statusCode || 'n/a'} | body: ${importBody || '(none)'} | local identity: ${localIdentity ? localIdentity.service : 'unrecognized'}`);
        // ── Isolation hint + in-process fallback ─────────────────────────
        // POST /api/auth/import-session is registered in THIS checkout; a 404
        // from the local notFound handler means the RUNNING local-api code is
        // older than this checkout (stale process or stale file). Recover by
        // importing the session directly in-process — the same primitives the
        // IPC handlers (local-api:set-session / cloud-sync:set-auth) use:
        try {
          const localApiModule = require('./local-api/index');
          localApiModule.setSession(cloudAuthToken, cloudUser);
          try {
            const syncServiceModule = require('./local-api/sync-service');
            syncServiceModule.setAuth(cloudAuthToken, cloudUser);
          } catch (authErr) {
            console.warn('[Diagnostics] SyncService setAuth fallback skipped:', authErr.message);
          }
          localApiToken = cloudAuthToken;
          sessionImported = true;
          console.log(`[Diagnostics] Session import FALLBACK via in-process setSession+setAuth succeeded — user: ${cloudUser.username || cloudUser.email || cloudUser.id || 'unknown'}`);
          sendUpdate(mainWindow, {
            log: `[OK] Session restored via in-process fallback (HTTP import was rejected) — user: ${cloudUser.username || cloudUser.email}`,
            logType: 'ok',
          });
        } catch (fallbackErr) {
          console.error('[Diagnostics] Session fallback FAILED:', fallbackErr.message);
        }
      }
    } catch (e) {
      sendUpdate(mainWindow, { log: `[WARN] Session import error: ${e.message}`, logType: 'warn' });
    }
  }

  // ── 3.2 Run the v2 initial sync (only when needed) ──────────────────────
  // Skip when: no stored session (user will login → login flow triggers sync),
  // local server down, or workspace already READY.
  //
  // P0 (initialization deadlock, field round 4): `cloudAvailable` from the
  // ONE step-2 probe used to gate this step — a transient 404 (cloud API
  // still registering routes) permanently deferred initialization while the
  // realtime socket proved the cloud reachable moments later. The decision
  // now belongs to the ENGINE's initialization coordinator
  // (sync-service.ensureWorkspaceInitialized), which re-probes the sync
  // routes authoritatively at attempt time, is single-flight and
  // rate-limited, and delegates the import to initial-sync.js (the single
  // initialization owner). A "cloud unavailable" verdict can no longer
  // wedge the workspace — it only defers it to the next trigger.
  const mustRunSync = hasStoredSession && localApiPort
    && serverResult.status === 'success' && !alreadyReady;

  let syncOutcome = null; // { success, totalRecords?, error?, alreadyInitialized?, skipped? }
  let syncAttempted = false;

  if (mustRunSync) {
    sendUpdate(mainWindow, {
      step: 'initial-sync',
      status: 'running',
      message: 'جاري استيراد بيانات الوكالة...',
      log: `[INFO] Initial sync starting for agency ${agencyId ? agencyId.substring(0, 8) + '…' : '(unknown)'} — v2 staged protocol`,
      logType: 'info',
    });

    // Forward the initializer's engine events into the loading log panel so
    // the user sees stage-by-stage progress (the coordinator re-emits the
    // runInitialSync event stream through the engine's event bus).
    let unsubscribeProgress = null;
    try {
      const ssForEvents = require('./local-api/sync-service');
      unsubscribeProgress = ssForEvents.onSyncEvent(function (evt) {
        if (!evt || !evt.type) return;
        if (evt.type === 'SYNC_STAGE_STARTED') {
          sendUpdate(mainWindow, { step: 'initial-sync', status: 'running', log: `[SYNC] المرحلة: ${evt.stageLabel || evt.stage} (${(evt.stageIndex ?? 0) + 1}/${evt.totalStages ?? '?'})`, logType: 'info' });
        } else if (evt.type === 'SYNC_STAGE_COMPLETED') {
          sendUpdate(mainWindow, { step: 'initial-sync', status: 'running', log: `[SYNC] اكتملت المرحلة: ${evt.stageLabel || evt.stage} — ${evt.count ?? 0} سجل`, logType: 'info' });
        } else if (evt.type === 'SYNC_ERROR') {
          sendUpdate(mainWindow, { step: 'initial-sync', status: 'running', log: `[SYNC] خطأ في ${evt.stage || 'الاستيراد'}: ${String(evt.error || '').substring(0, 120)}`, logType: 'fail' });
        } else if (evt.type === 'SYNC_WARNING') {
          sendUpdate(mainWindow, { step: 'initial-sync', status: 'running', log: `[SYNC] تحذير: ${String(evt.message || '').substring(0, 120)}`, logType: 'warn' });
        }
      });
    } catch { /* event forwarding is best-effort */ }

    // ── Primary path: in-process initialization coordinator ─────────────
    // Runs in THIS (main) process — no IPC bridge, no HTTP hop, no stale
    // route dependency. The engine was possibly not started yet (startSync
    // normally happens in step 7), so start it first (idempotent).
    try {
      const syncService = require('./local-api/sync-service');
      const { localDb: syncDb } = require('./local-api/lib/db');
      if (syncDb) {
        try {
          if (!syncService.getStatus()?.isStarted) {
            // Long first-cycle delay: the coordinator below OWNS the first
            // post-init cycle; the engine's own startup cycle must not race it.
            await syncService.startSync({
              localDb: syncDb,
              cloudBaseUrl,
              deviceId: 'desktop-diagnostics',
              initialDelayMs: 30000,
            });
            console.log('[Diagnostics] Sync engine started early (step 3) for initialization coordination');
          }
        } catch (startErr) {
          console.warn('[Diagnostics] Early engine start failed (continuing):', startErr.message);
        }
        // Guarantee the coordinator has credentials (step 3.1 may have restored
        // the session via the in-process fallback; make it explicit here).
        try { syncService.setAuth(cloudAuthToken, cloudUser); } catch { /* tolerated */ }
        syncAttempted = true;
        syncOutcome = await syncService.ensureWorkspaceInitialized('diagnostics');
        if (syncOutcome && syncOutcome.skipped) {
          console.log(`[Diagnostics] Init coordinator deferred initial sync (${syncOutcome.skipped})`);
        }
      }
    } catch (inProcErr) {
      console.warn('[Diagnostics] In-process init coordinator failed:', inProcErr.message);
    } finally {
      try { if (unsubscribeProgress) unsubscribeProgress(); } catch { /* best-effort */ }
    }

    // ── Fallback paths: IPC bridge → local API HTTP route ───────────────
    // Only used when the in-process coordinator could not produce a result
    // (module load failure). A definitive coordinator result is honored.
    if (!syncOutcome && mainWindow && !mainWindow.isDestroyed()) {
      try {
        const bridgeResult = await Promise.race([
          mainWindow.webContents.executeJavaScript(
            '(window.__blastiRunInitialSync ? window.__blastiRunInitialSync() : Promise.resolve({ unavailable: true }))',
            true,
          ),
          new Promise((resolve) => setTimeout(() => resolve({ timeout: true, error: 'IPC bridge timed out' }), 10 * 60 * 1000)),
        ]);
        if (bridgeResult && (bridgeResult.unavailable || bridgeResult.timeout)) {
          sendUpdate(mainWindow, {
            log: `[INFO] IPC bridge unavailable (${bridgeResult.error || 'no handler'}) — trying local API HTTP endpoint`,
            logType: 'info',
          });
        } else if (bridgeResult) {
          syncAttempted = true;
          syncOutcome = { via: 'ipc', ...bridgeResult };
        }
      } catch (bridgeErr) {
        sendUpdate(mainWindow, {
          log: `[WARN] IPC bridge error: ${String(bridgeErr?.message || bridgeErr).substring(0, 80)} — trying local API HTTP endpoint`,
          logType: 'warn',
        });
      }
    }
    if (!syncOutcome && localApiPort) {
      try {
        const httpRes = await postAuthUrl(
          `http://127.0.0.1:${localApiPort}/api/sync/initial-sync/run`,
          {},
          cloudAuthToken,
          10 * 60 * 1000,
        );
        if (httpRes.reachable && httpRes.statusCode === 404) {
          sendUpdate(mainWindow, {
            log: '[INFO] /api/sync/initial-sync/run not available yet — workspace will initialize after login',
            logType: 'info',
          });
        } else if (httpRes.reachable && httpRes.json) {
          syncAttempted = true;
          syncOutcome = { via: 'http', ...httpRes.json };
        } else {
          sendUpdate(mainWindow, {
            log: `[WARN] HTTP initial-sync endpoint failed (HTTP ${httpRes.statusCode || 'unreachable'})`,
            logType: 'warn',
          });
        }
      } catch (httpErr) {
        sendUpdate(mainWindow, {
          log: `[WARN] HTTP initial-sync error: ${String(httpErr?.message || httpErr).substring(0, 80)}`,
          logType: 'warn',
        });
      }
    }

    if (syncOutcome?.skipped === 'cloud-unavailable') {
      sendUpdate(mainWindow, {
        log: '[INFO] Cloud sync API not reachable at decision time — initialization deferred to the engine (auto-retries when the cloud becomes reachable)',
        logType: 'info',
      });
    } else if (syncOutcome?.skipped === 'auth-rejected') {
      sendUpdate(mainWindow, {
        log: '[WARN] Cloud sync API rejected the stored token — re-login will refresh it',
        logType: 'warn',
      });
    } else if (syncOutcome?.skipped === 'ready' || syncOutcome?.alreadyInitialized) {
      sendUpdate(mainWindow, { log: '[OK] Workspace already initialized (READY) — skipped re-import', logType: 'ok' });
    } else if (syncOutcome?.success === false && syncOutcome?.error) {
      sendUpdate(mainWindow, { log: `[FAIL] Initial sync failed: ${String(syncOutcome.error).substring(0, 120)}`, logType: 'fail' });
    } else if (syncOutcome?.success === true) {
      sendUpdate(mainWindow, { log: `[OK] Initial sync completed — ${syncOutcome.totalRecords ?? 0} records imported`, logType: 'ok' });
    }
  } else if (alreadyReady) {
    sendUpdate(mainWindow, {
      log: '[INFO] Local workspace already READY — skipping initial sync',
      logType: 'info',
    });
  } else if (!hasStoredSession) {
    sendUpdate(mainWindow, {
      log: '[SKIP] No stored auth — workspace will initialize after login',
      logType: 'info',
    });
  } else if (!cloudAvailable) {
    sendUpdate(mainWindow, {
      log: '[INFO] Cloud unavailable — checking local workspace for offline readiness...',
      logType: 'info',
    });
  }

  // ── 3.3 Post-run readiness gate (GET /api/db-status) ────────────────────
  // readiness.ready === true  → launch
  // readiness.ready === false → block (with retry) unless the user has never
  //                             logged in (onboarding: import happens after
  //                             login) or the workspace is READY-but-offline.
  let postDbStatus = null;
  if (localApiPort && serverResult.status === 'success') {
    try {
      const postRes = await fetchWithAuth(
        `http://127.0.0.1:${localApiPort}/api/db-status`,
        localApiToken || cloudAuthToken,
        5000,
      );
      if (postRes && typeof postRes === 'object' && (postRes.readiness || postRes.initializationStatus !== undefined)) {
        postDbStatus = postRes;
      }
    } catch { /* tolerated — handled as unknown readiness below */ }
  }

  const readiness = postDbStatus?.readiness || null;
  const postInitStatus = postDbStatus?.initializationStatus ?? preInitStatus;
  const isReady = readiness ? readiness.ready === true : null; // null = contract missing (tolerated)

  // Compact per-table counts summary for the log panel (best effort)
  let countsSummary = null;
  {
    const counts = postDbStatus?.counts;
    if (counts && typeof counts === 'object') {
      const pickCount = (obj, name) => {
        const keys = Object.keys(obj);
        const exact = keys.find(k => k.toLowerCase() === name.toLowerCase());
        return exact !== undefined ? obj[exact] : undefined;
      };
      const wanted = [
        ['agency', 'وكالات'], ['service', 'خدمات'], ['branch', 'فروع'],
        ['counter', 'طاولات'], ['agencyStaff', 'موظفين'], ['reservation', 'حجوزات'],
      ];
      countsSummary = wanted
        .map(([key, label]) => `${label}=${pickCount(counts, key) ?? '؟'}`)
        .join('، ');
    }
  }

  if (isReady === true) {
    // READY (fresh+online completed, or ready+online, or ready+offline)
    initResult = {
      step: 'initial-sync',
      status: 'success',
      message: !cloudAvailable
        ? 'جاهز للعمل دون اتصال'
        : 'مساحة العمل المحلية جاهزة',
      detail: {
        initializationStatus: postInitStatus,
        counts: postDbStatus?.counts || undefined,
        recordsImported: syncOutcome?.totalRecords,
        via: syncOutcome?.via,
      },
    };
    if (countsSummary) {
      sendUpdate(mainWindow, { log: `[OK] السجلات المحلية: ${countsSummary}`, logType: 'ok' });
    }
    if (syncOutcome?.totalRecords !== undefined && !syncOutcome?.alreadyInitialized) {
      sendUpdate(mainWindow, { log: `[OK] Initial sync imported ${syncOutcome.totalRecords} records (via ${syncOutcome.via})`, logType: 'ok' });
    }
    console.log('[Diagnostics] Local workspace READY — gate passed');
  } else if (isReady === false) {
    const failReason = readiness?.reason || postDbStatus?.lastError || (syncOutcome?.error ?? 'سبب غير معروف');
    if (syncAttempted && cloudAvailable) {
      // Sync ran (or was attempted) and the workspace is still not ready —
      // a real failure: block launch, the error banner offers retry.
      initResult = {
        step: 'initial-sync',
        status: 'error',
        message: `فشل تهيئة مساحة العمل المحلية — ${String(failReason).substring(0, 90)}`,
        detail: { reason: failReason, lastError: postDbStatus?.lastError, initializationStatus: postInitStatus },
      };
      sendUpdate(mainWindow, {
        log: `[FAIL] Workspace not ready: ${String(failReason).substring(0, 120)}`,
        logType: 'fail',
      });
    } else if (!cloudAvailable && postInitStatus !== 'READY') {
      // Fresh install offline — the desktop must NOT enter an empty dashboard
      // (spec §5). Block with a clear Arabic message.
      initResult = {
        step: 'initial-sync',
        status: 'error',
        message: 'الإعداد الأول يتطلب اتصالاً بالإنترنت لاستيراد بيانات الوكالة',
        detail: {
          initializationStatus: postInitStatus,
          offline: true,
          hasStoredSession,
          cloudBaseUrl,
          readinessReason: readiness?.reason || undefined,
          hint: 'root cause is usually in the cloud-api step result above',
        },
      };
      sendUpdate(mainWindow, { log: `[FAIL] Workspace not ready while cloud unavailable (status=${postInitStatus}, session=${hasStoredSession ? 'present' : 'none'}) — see the cloud-api step above for the root cause`, logType: 'fail' });
    } else {
      // Not ready but this is expected onboarding (never logged in) —
      // the login flow triggers the initial sync after successful auth.
      initResult = {
        step: 'initial-sync',
        status: 'success',
        message: 'سيتم استيراد بيانات الوكالة بعد تسجيل الدخول',
        detail: { initializationStatus: postInitStatus },
      };
      sendUpdate(mainWindow, { log: '[SKIP] Workspace not initialized — will import after login', logType: 'info' });
    }
  } else {
    // readiness contract missing (agent 7-b route not landed) — tolerant
    // legacy behavior so startup is never bricked by a missing probe route.
    if (syncOutcome?.success === true) {
      initResult = {
        step: 'initial-sync',
        status: 'success',
        message: syncOutcome.alreadyInitialized
          ? 'مساحة العمل المحلية مهيأة مسبقًا'
          : `تم استيراد بيانات الوكالة (${syncOutcome.totalRecords ?? 0} سجل)`,
        detail: { via: syncOutcome.via, totalRecords: syncOutcome.totalRecords },
      };
      sendUpdate(mainWindow, { log: `[OK] Initial sync OK via ${syncOutcome.via} — ${syncOutcome.totalRecords ?? 0} records`, logType: 'ok' });
    } else if (syncOutcome?.success === false) {
      initResult = {
        step: 'initial-sync',
        status: 'error',
        message: `فشل استيراد بيانات الوكالة — ${String(syncOutcome.error || 'خطأ غير معروف').substring(0, 90)}`,
        detail: { via: syncOutcome.via, error: syncOutcome.error },
      };
      sendUpdate(mainWindow, { log: `[FAIL] Initial sync failed: ${String(syncOutcome.error || '').substring(0, 120)}`, logType: 'fail' });
    } else if (!cloudAvailable && hasStoredSession) {
      // Offline with a session: rely on whatever local data exists.
      initResult = {
        step: 'initial-sync',
        status: 'success',
        message: sessionImported
          ? 'السحابة غير متاحة — العمل بالبيانات المحلية (الجلسة مستعادة)'
          : 'السحابة غير متاحة — تعذر استعادة الجلسة (سيتم الطلب بعد الاتصال)',
        detail: { offline: true, sessionImported },
      };
      sendUpdate(mainWindow, { log: `[INFO] Offline mode — session ${sessionImported ? 'restored' : 'NOT restored'}`, logType: 'info' });
    } else {
      initResult = {
        step: 'initial-sync',
        status: 'success',
        message: hasStoredSession
          ? 'تم التخطي — تعذر تشغيل الاستيراد الأولي (سيتم الاستيراد بعد تسجيل الدخول)'
          : 'تم التخطي — لا توجد بيانات اعتماد محفوظة (سيتم الاستيراد بعد تسجيل الدخول)',
      };
    }
  }

  pushResult(initResult);

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 3b: Verify — local DB readiness snapshot (light, single local call)
  // ═══════════════════════════════════════════════════════════════════════
  // Replaces the old hand-rolled local↔cloud count comparison. The v2 sync
  // state machine validates integrity itself (mandatory stages + validation
  // step); here we only log a compact table-count summary from /api/db-status.
  sendUpdate(mainWindow, {
    step: 'verify',
    status: 'running',
    message: 'جاري التحقق من قاعدة البيانات المحلية...',
    log: '[INFO] Verifying local DB readiness via /api/db-status...',
    logType: 'info',
  });

  await delay(200);

  let verifyResult = {
    step: 'verify',
    status: 'success',
    message: 'تم التخطي — الخادم المحلي غير متاح',
  };

  if (localApiPort && serverResult.status === 'success') {
    try {
      const statusRes = await fetchWithAuth(
        `http://127.0.0.1:${localApiPort}/api/db-status`,
        localApiToken || cloudAuthToken,
        5000,
      );

      if (statusRes && typeof statusRes === 'object' && (statusRes.counts || statusRes.readiness)) {
        // Compact counts table (Agency/Service/Branch/Counter/QueueSettings/Reservation)
        const COUNT_LABELS = [
          ['agency', 'وكالات'], ['service', 'خدمات'], ['branch', 'فروع'],
          ['counter', 'طاولات'], ['queueSettings', 'إعدادات الطابور'], ['reservation', 'حجوزات'],
        ];
        const counts = statusRes.counts || {};
        const pickCount = (obj, name) => {
          if (!obj || typeof obj !== 'object') return undefined;
          const keys = Object.keys(obj);
          const exact = keys.find(k => k.toLowerCase() === name.toLowerCase());
          return exact !== undefined ? obj[exact] : undefined;
        };
        const cells = COUNT_LABELS.map(([key, label]) => {
          const v = pickCount(counts, key);
          return `${label}=${v === undefined ? '؟' : v}`;
        });
        const totalRecords = Object.values(counts)
          .filter(v => typeof v === 'number')
          .reduce((sum, v) => sum + v, 0);

        sendUpdate(mainWindow, {
          log: `[INFO] جدول السجلات المحلية: ${cells.join(' | ')} (المجموع: ${totalRecords})`,
          logType: 'info',
        });

        if (statusRes.readiness?.ready === true) {
          verifyResult = {
            step: 'verify',
            status: 'success',
            message: `البيانات المحلية مكتملة — ${cells.join('، ')}`,
            detail: { counts: statusRes.counts, readiness: statusRes.readiness },
          };
        } else if (statusRes.readiness) {
          const reason = statusRes.readiness.reason || statusRes.lastError || 'غير جاهز';
          if (!cloudAuthToken) {
            // Never logged in — empty tables are the expected onboarding state.
            verifyResult = {
              step: 'verify',
              status: 'success',
              message: 'الجداول جاهزة لكن فارغة — سيتم ملؤها بعد تسجيل الدخول',
              detail: { counts: statusRes.counts, readiness: statusRes.readiness },
            };
            sendUpdate(mainWindow, { log: '[SKIP] Tables empty (no session yet) — will populate after login', logType: 'info' });
          } else {
            // A session exists but the workspace is incomplete — block.
            verifyResult = {
              step: 'verify',
              status: 'error',
              message: `قاعدة البيانات غير مكتملة — ${String(reason).substring(0, 90)}`,
              detail: { counts: statusRes.counts, readiness: statusRes.readiness, lastError: statusRes.lastError },
            };
            sendUpdate(mainWindow, { log: `[FAIL] DB not ready: ${String(reason).substring(0, 120)}`, logType: 'fail' });
          }
        } else {
          // Counts present but no readiness object (pre-7-b db-status) — tolerant.
          verifyResult = {
            step: 'verify',
            status: 'success',
            message: `سجلات محلية: ${cells.join('، ')}`,
            detail: { counts: statusRes.counts },
          };
        }
      } else {
        verifyResult = {
          step: 'verify',
          status: 'success',
          message: 'تم التخطي — حالة قاعدة البيانات غير متاحة بعد',
        };
        sendUpdate(mainWindow, { log: '[INFO] /api/db-status contract not available yet — skipping verification', logType: 'info' });
      }
    } catch (err) {
      verifyResult = {
        step: 'verify',
        status: 'warning',
        message: `خطأ في التحقق: ${err.message.substring(0, 60)}`,
      };
      sendUpdate(mainWindow, { log: `[WARN] Verification error: ${err.message}`, logType: 'fail' });
      console.warn('[Diagnostics] Verify error:', err.message);
    }
  } else {
    sendUpdate(mainWindow, { log: '[SKIP] Local server not available — skipping verification', logType: 'info' });
  }

  pushResult(verifyResult);

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 4: Disconnect Cloud (simulate offline) to test fallback
  // ═══════════════════════════════════════════════════════════════════════
  sendUpdate(mainWindow, {
    step: 'disconnect-cloud',
    status: 'running',
    message: 'جاري فصل السحابة مؤقتًا لاختبار الوضع المحلي...',
    log: '[INFO] Simulating cloud disconnection for offline test...',
    logType: 'info',
  });

  await delay(500);

  let disconnectResult;
  if (cloudAvailable) {
    // Verify cloud is truly unreachable by testing against an invalid URL
    // In real scenario, cloud is still reachable but we simulate offline by
    // only using local API for the following tests
    disconnectResult = {
      step: 'disconnect-cloud',
      status: 'success',
      message: 'تم فصل السحابة مؤقتًا — اختبار الوضع المحلي',
      detail: { simulated: true, cloudWasAvailable: true },
    };
    sendUpdate(mainWindow, { log: `[OK] Cloud disconnected (simulated) — testing local API`, logType: 'ok' });
    console.log('[Diagnostics] Simulated cloud disconnection for offline test');
  } else {
    disconnectResult = {
      step: 'disconnect-cloud',
      status: 'success',
      message: 'السحابة غير متاحة بالفعل — اختبار الوضع المحلي',
      detail: { simulated: false, cloudWasAvailable: false },
    };
    sendUpdate(mainWindow, { log: `[OK] Cloud was already offline — proceeding with local test`, logType: 'ok' });
  }

  pushResult(disconnectResult);

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 5: Test Queue CRUD (create queue "next", then delete) — BEHAVIORAL
  // ═══════════════════════════════════════════════════════════════════════
  // P0-4 (field round 4): this test used Prisma fields that do not exist on
  // the Service model (nameEn, avgServiceTime), crashed, and was then
  // reported as SKIP→SUCCESS — a false-positive diagnostic. Verdicts are now
  // honest: unexpected errors FAIL the step, precondition-missing SKIPs are
  // reported as warnings, and the behavioral test only runs when the
  // workspace is actually READY (an uninitialized DB says nothing about
  // offline operability).
  sendUpdate(mainWindow, {
    step: 'test-queue-crud',
    status: 'running',
    message: 'جاري اختبار إنشاء وحذف طابور "next"...',
    log: '[INFO] Testing queue CRUD: create "next" → verify → delete → verify',
    logType: 'info',
  });

  await delay(300);

  // No verdict is pre-assigned: EVERY path below must produce an explicit,
  // truthful verdict. If the flow ever falls through without one, the final
  // guard reports an ERROR — a missing verdict is itself a test failure
  // (the historic bug: the stale "no session" placeholder survived a RUN
  // and was reported as the step's result).
  let crudResult = null;

  if (localApiPort && localApiToken && isReady !== true) {
    // Behavioral test on an uninitialized workspace is meaningless — the DB
    // has no agency data yet (initialization pending). Say so honestly.
    crudResult = {
      step: 'test-queue-crud',
      status: 'warning',
      message: 'تم التخطي — مساحة العمل غير مهيأة بعد (الاختبار السلوكي يتطلب READY)',
      detail: { initializationStatus: postInitStatus || 'unknown' },
    };
    sendUpdate(mainWindow, { log: `[SKIP] Workspace not initialized (${postInitStatus || 'unknown'}) — behavioral CRUD test deferred`, logType: 'warn' });
  } else if (localApiPort && localApiToken) {
    let testServiceId = null;
    let createdTestService = false;
    try {
      const { localDb: testDb } = require('./local-api/lib/db');
      const testAgencyId = agencyId || 'test-agency-id';

      // Check if we have services to create a reservation with
      const services = await testDb.service.findMany({
        where: { agencyId: testAgencyId, isActive: true },
        take: 1,
      });

      if (services.length > 0) {
        testServiceId = services[0].id;
      } else {
        // Create a test service first — fields MUST match the Prisma Service
        // model (name/nameAr/nameFr/description/prefix; NO nameEn, NO
        // avgServiceTime — those crashed this test in the field).
        const testService = await testDb.service.create({
          data: {
            id: 'test-service-next-' + Date.now(),
            name: 'خدمة اختبار next',
            nameAr: 'خدمة اختبار next',
            nameFr: 'Service de test next',
            description: 'Diagnostic CRUD test service (auto-removed)',
            agencyId: testAgencyId,
            isActive: true,
            prefix: 'T',
          },
        });
        testServiceId = testService.id;
        createdTestService = true;
        sendUpdate(mainWindow, { log: `[INFO] Created test service: ${testServiceId}`, logType: 'info' });
      }

      // ── 1. CREATE — a REAL POST (method is set in net.request options). ──
      // Assertions are strict (field round 6 review): the step may only claim
      // success when the response says success AND carries a reservation id
      // AND a ticket number. The historic bug read the GET-list response
      // `{success:true, data:[...]}` as a create and printed id=undefined.
      sendUpdate(mainWindow, { log: '[TEST] POST /api/reservations — creating queue "next"...', logType: 'info' });
      const createRes = await postUrl(`http://127.0.0.1:${localApiPort}/api/reservations?token=${localApiToken}`, {
        serviceId: testServiceId,
        walkInCustomerName: 'next',
        isWalkIn: true,
        customerPhone: '0000000000',
      });

      const createdReservationId = createRes?.reachable && createRes.json?.success
        ? (typeof createRes.json.data?.id === 'string' ? createRes.json.data.id : null)
        : null;
      const createdTicket = createRes?.json?.data
        ? (createRes.json.data.displayNumber || createRes.json.data.queueNumber || createRes.json.data.ticketNumber || null)
        : null;

      if (!createRes?.reachable) {
        crudResult = {
          step: 'test-queue-crud',
          status: 'error',
          message: `فشل الاتصال عند إنشاء الطابور — ${createRes?.error || 'لا استجابة'}`,
          detail: { phase: 'create', reachable: false, error: createRes?.error || null },
        };
        sendUpdate(mainWindow, { log: `[FAIL] Create request did not reach the local API: ${createRes?.error || 'no response'}`, logType: 'fail' });
      } else if (!createRes.json?.success) {
        const body = String(createRes.body || '').replace(/\s+/g, ' ').trim().substring(0, 160);
        crudResult = {
          step: 'test-queue-crud',
          status: 'error',
          message: `فشل إنشاء الطابور (HTTP ${createRes.statusCode || '؟'})`,
          detail: { phase: 'create', httpStatus: createRes.statusCode || null, body: body || undefined },
        };
        sendUpdate(mainWindow, { log: `[FAIL] Create failed: HTTP ${createRes.statusCode || '؟'} ${body}`, logType: 'fail' });
      } else if (!createdReservationId || !createdTicket) {
        // success:true WITHOUT a usable id/ticket is a contract violation —
        // never report it as created (field round 6: "id=undefined, ticket=undefined").
        crudResult = {
          step: 'test-queue-crud',
          status: 'error',
          message: 'استجابة الإنشاء غير مكتملة — نجاح منطقي بدون معرف أو رقم تذكرة',
          detail: { phase: 'create-contract', hasId: !!createdReservationId, hasTicket: !!createdTicket, responseKeys: Object.keys(createRes.json || {}) },
        };
        sendUpdate(mainWindow, { log: `[FAIL] Create response contract violation: success=true but id=${createdReservationId ? 'present' : 'MISSING'}, ticket=${createdTicket ? 'present' : 'MISSING'} — NOT reporting a creation`, logType: 'fail' });
      } else {
        sendUpdate(mainWindow, { log: `[OK] Queue "next" created: id=${createdReservationId}, ticket=${createdTicket}`, logType: 'ok' });

        // ── 2. VERIFY (list) — advisory only; SQLite below is authoritative. ──
        sendUpdate(mainWindow, { log: `[TEST] GET /api/reservations — verifying queue "next" exists...`, logType: 'info' });
        let listWarning = null;
        const getRes = await probeUrl(`http://127.0.0.1:${localApiPort}/api/reservations?token=${localApiToken}`);
        if (getRes.reachable && getRes.json?.success) {
          const found = Array.isArray(getRes.json.data) && getRes.json.data.find(r => r.id === createdReservationId);
          if (found) {
            sendUpdate(mainWindow, { log: `[OK] Queue "next" verified in list: ticket=${found.displayNumber || found.queueNumber || found.ticketNumber}, status=${found.status}`, logType: 'ok' });
          } else {
            listWarning = 'created reservation not present in GET /api/reservations list (may be filtered)';
            sendUpdate(mainWindow, { log: `[WARN] Queue "next" not found in list (may be filtered) — SQLite check below is authoritative`, logType: 'warn' });
          }
        } else {
          listWarning = 'list probe failed (' + (getRes.error || ('HTTP ' + (getRes.statusCode || '?'))) + ')';
          sendUpdate(mainWindow, { log: `[WARN] List probe failed — SQLite check below is authoritative`, logType: 'warn' });
        }

        // ── 3. CANCEL — the REAL cancel route (transactional + outbox). ──
        // PUT /api/reservations/:id does NOT accept `status` (400: no valid
        // fields) — the historic cancel here silently no-opped while the
        // "reachable" flag made it look successful.
        sendUpdate(mainWindow, { log: `[TEST] POST /api/queue/cancel/${createdReservationId} — canceling queue "next"...`, logType: 'info' });
        const cancelRes = await postAuthUrl(
          `http://127.0.0.1:${localApiPort}/api/queue/cancel/${createdReservationId}`,
          {},
          localApiToken,
        );
        if (!cancelRes?.reachable) {
          crudResult = {
            step: 'test-queue-crud',
            status: 'error',
            message: `فشل الاتصال عند إلغاء الطابور — ${cancelRes?.error || 'لا استجابة'}`,
            detail: { phase: 'cancel', reservationId: createdReservationId, ticket: createdTicket, error: cancelRes?.error || null },
          };
          sendUpdate(mainWindow, { log: `[FAIL] Cancel request did not reach the local API: ${cancelRes?.error || 'no response'}`, logType: 'fail' });
        } else if (!cancelRes.json?.success) {
          const body = String(cancelRes.body || '').replace(/\s+/g, ' ').trim().substring(0, 160);
          crudResult = {
            step: 'test-queue-crud',
            status: 'error',
            message: `فشل إلغاء الطابور (HTTP ${cancelRes.statusCode || '؟'})`,
            detail: { phase: 'cancel', reservationId: createdReservationId, ticket: createdTicket, httpStatus: cancelRes.statusCode || null, body: body || undefined },
          };
          sendUpdate(mainWindow, { log: `[FAIL] Cancel failed: HTTP ${cancelRes.statusCode || '؟'} ${body}`, logType: 'fail' });
        } else {
          sendUpdate(mainWindow, { log: `[OK] Queue "next" cancelled via /api/queue/cancel`, logType: 'ok' });

          // ── 4. VERIFY CANCELLATION in SQLite (authoritative). ──
          const { localDb: verifyDb } = require('./local-api/lib/db');
          const cancelled = await verifyDb.reservation.findUnique({ where: { id: createdReservationId } });
          if (cancelled && cancelled.status === 'CANCELLED') {
            sendUpdate(mainWindow, { log: `[OK] Verified in SQLite: reservation ${createdReservationId} is CANCELLED`, logType: 'ok' });
            crudResult = {
              step: 'test-queue-crud',
              status: 'success',
              message: `إنشاء ✓ (تذكرة ${createdTicket}) → تحقق ✓ → إلغاء ✓ → تحقق SQLite ✓`,
              detail: {
                created: true, verifiedInList: !listWarning, cancelled: true, sqliteVerified: true,
                reservationId: createdReservationId, ticket: createdTicket,
                listWarning: listWarning || undefined,
              },
            };
          } else {
            crudResult = {
              step: 'test-queue-crud',
              status: 'error',
              message: 'التحقق النهائي في SQLite فشل — الحالة ليست CANCELLED',
              detail: {
                phase: 'sqlite-verify', reservationId: createdReservationId, ticket: createdTicket,
                found: !!cancelled, status: cancelled?.status || null, listWarning: listWarning || undefined,
              },
            };
            sendUpdate(mainWindow, { log: `[FAIL] SQLite verify failed: reservation ${cancelled ? 'exists but status=' + cancelled.status : 'NOT FOUND'}`, logType: 'fail' });
          }
        }
      }

      // Clean up test service if we created it (best-effort, never masks the verdict)
      if (createdTestService && testServiceId) {
        try {
          const { localDb: cleanupDb } = require('./local-api/lib/db');
          await cleanupDb.service.delete({ where: { id: testServiceId } }).catch(() => {});
        } catch { /* ignore */ }
      }
    } catch (err) {
      // P0-4: an unexpected error is a REAL failure, not a skip. The old
      // code reported error→SKIP→SUCCESS, hiding broken diagnostics.
      crudResult = {
        step: 'test-queue-crud',
        status: 'error',
        message: `فشل اختبار الطابور السلوكي — ${String(err.message || err).substring(0, 90)}`,
        detail: { error: String(err.message || err).substring(0, 300) },
      };
      console.error('[Diagnostics] CRUD test FAILED:', err.message);
      sendUpdate(mainWindow, { log: `[FAIL] Queue CRUD test error: ${err.message} — see detail in the results breakdown`, logType: 'fail' });
    }
  } else if (localApiPort && !localApiToken) {
    crudResult = {
      step: 'test-queue-crud',
      status: 'warning',
      message: 'تم التخطي — لا توجد جلسة محلية (سيتم الاختبار بعد تسجيل الدخول)',
    };
    sendUpdate(mainWindow, { log: `[SKIP] No local session — will test after login`, logType: 'warn' });
  } else {
    crudResult = {
      step: 'test-queue-crud',
      status: 'warning',
      message: 'تم التخطي — الخادم المحلي غير متاح بعد',
    };
    sendUpdate(mainWindow, { log: `[SKIP] Local server not available — will test after startup`, logType: 'warn' });
  }

  // Final guard: a run without a verdict is itself a failure (never report
  // a stale placeholder as the outcome).
  if (!crudResult) {
    crudResult = {
      step: 'test-queue-crud',
      status: 'error',
      message: 'الاختبار السلوكي لم ينتج حكمًا — عيب في تشخيصات بدء التشغيل نفسها',
      detail: { localApiPort, hadToken: !!localApiToken, initializationStatus: postInitStatus || 'unknown' },
    };
    console.error('[Diagnostics] CRUD test produced NO verdict — reporting as error');
  }

  pushResult(crudResult);

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 6: Test ALL Local API Endpoints
  // ═══════════════════════════════════════════════════════════════════════
  sendUpdate(mainWindow, {
    step: 'test-all-endpoints',
    status: 'running',
    message: 'جاري اختبار جميع نقاط API المحلية...',
    log: '[INFO] Testing all local API endpoints...',
    logType: 'info',
  });

  await delay(300);

  let endpointsResult = { step: 'test-all-endpoints', status: 'error', message: 'لم يتم الاختبار' };

  if (localApiPort) {
    const endpointTests = [
      // Public endpoints (no auth)
      { method: 'GET', path: '/health', needAuth: false },
      { method: 'GET', path: '/api/health', needAuth: false },
      { method: 'GET', path: '/api/discover', needAuth: false },
      { method: 'GET', path: '/api/probe', needAuth: false },
      { method: 'GET', path: '/api/sync/status', needAuth: false },
      { method: 'GET', path: '/api/db-status', needAuth: false },
      { method: 'GET', path: '/api/sync-status', needAuth: false },
    ];

    // Auth-protected endpoints (only test if we have a session)
    if (localApiToken) {
      endpointTests.push(
        { method: 'GET', path: '/api/auth/session', needAuth: true },
        { method: 'GET', path: '/api/agency/profile', needAuth: true },
        { method: 'GET', path: '/api/agency/dashboard', needAuth: true },
        { method: 'GET', path: '/api/agency/settings', needAuth: true },
        { method: 'GET', path: '/api/agency/queue', needAuth: true },
        { method: 'GET', path: '/api/agency/stats', needAuth: true },
        { method: 'GET', path: '/api/agency/services', needAuth: true },
        { method: 'GET', path: '/api/agency/activity', needAuth: true },
        { method: 'GET', path: '/api/agency/history', needAuth: true },
        { method: 'GET', path: '/api/agency/announcements', needAuth: true },
        { method: 'GET', path: '/api/agency/analytics', needAuth: true },
        { method: 'GET', path: '/api/services', needAuth: true },
        { method: 'GET', path: '/api/agency/branches', needAuth: true },
        { method: 'GET', path: '/api/agency/counters', needAuth: true },
        { method: 'GET', path: '/api/agency/staff', needAuth: true },
        { method: 'GET', path: '/api/reservations', needAuth: true },
        { method: 'GET', path: '/api/queue/active', needAuth: true },
        { method: 'GET', path: '/api/queue/today', needAuth: true },
        { method: 'GET', path: '/api/notifications', needAuth: true },
        { method: 'GET', path: '/api/user/profile', needAuth: true },
        { method: 'GET', path: '/api/pending-mutations', needAuth: true },
        { method: 'GET', path: '/api/pending-mutations/count', needAuth: false },
      );
    }

    let passed = 0;
    let failed = 0;
    const failedEndpoints = [];

    // BUG FIX: Run all endpoint probes in parallel instead of sequentially.
    // Sequential 3s timeouts could take up to 84s (28 endpoints × 3s).
    // Parallel with 2s timeout = max ~2s total.
    const probePromises = endpointTests.map(async (ep) => {
      const url = `http://127.0.0.1:${localApiPort}${ep.path}${ep.needAuth ? '?token=' + localApiToken : ''}`;
      const label = `${ep.method} ${ep.path}`;

      try {
        const res = await probeUrl(url, 2000);
        const isOk = res.reachable && (res.statusCode >= 200 && res.statusCode < 300);
        const isExpectedAuthFail = res.reachable && res.statusCode === 401 && ep.needAuth;

        if (isOk) {
          return { ok: true };
        } else if (isExpectedAuthFail) {
          return { ok: true };
        } else if (res.reachable) {
          return { ok: false, label, status: res.statusCode };
        } else {
          return { ok: false, label, status: 'unreachable' };
        }
      } catch {
        return { ok: false, label, status: 'error' };
      }
    });

    const probeResults = await Promise.all(probePromises);
    for (const r of probeResults) {
      if (r.ok) {
        passed++;
        sendUpdate(mainWindow, { log: `  [OK] (parallel probe passed)`, logType: 'ok' });
      } else {
        failed++;
        failedEndpoints.push({ label: r.label, status: r.status });
        sendUpdate(mainWindow, { log: `  [FAIL] ${r.label} → ${r.status}`, logType: 'fail' });
      }
    }

    const total = endpointTests.length;
    if (failed === 0) {
      endpointsResult = {
        step: 'test-all-endpoints',
        status: 'success',
        // STRUCTURAL evidence only — route existence + valid shapes. When the
        // workspace is not READY this must not be read as offline-operability.
        message: isReady === true
          ? `جميع نقاط API تعمل — ${passed}/${total} نجحت`
          : `جميع نقاط API تعمل (هيكلية فقط — مساحة العمل غير مهيأة) — ${passed}/${total} نجحت`,
        detail: { passed, failed, total, structuralOnly: isReady !== true },
      };
    } else if (passed > failed) {
      endpointsResult = {
        step: 'test-all-endpoints',
        status: 'warning',
        message: `${passed}/${total} نجحت — ${failed} فشلت: ${failedEndpoints.map(e => e.label).join(', ')}`,
        detail: { passed, failed, total, failedEndpoints },
      };
    } else {
      // BUG FIX: When offline, some endpoints may fail (e.g. auth-gated ones
      // before session restore). Don't block launch — treat as warning, not error.
      // The local API is running and can serve requests after login/session restore.
      endpointsResult = {
        step: 'test-all-endpoints',
        status: 'warning',
        message: `${passed}/${total} نجحت — ${failed} فشلت: ${failedEndpoints.map(e => e.label).join(', ')}`,
        detail: { passed, failed, total, failedEndpoints },
      };
    }
    console.log(`[Diagnostics] Endpoint tests: ${passed}/${total} passed, ${failed} failed`);
  } else {
    endpointsResult = {
      step: 'test-all-endpoints',
      status: 'error',
      message: 'الخادم المحلي غير متاح',
    };
  }

  pushResult(endpointsResult);

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 7: Reconnect to Cloud API
  // ═══════════════════════════════════════════════════════════════════════
  sendUpdate(mainWindow, {
    step: 'reconnect-cloud',
    status: 'running',
    message: 'جاري إعادة الاتصال بالسحابة...',
    log: '[INFO] Reconnecting to cloud API...',
    logType: 'info',
  });

  await delay(500);

  let reconnectResult;

  if (cloudAvailable) {
    // BUG FIX: Only re-probe cloud if it was previously reachable.
    // If step 2 already showed cloud unreachable, probing again just
    // wastes 5 seconds offline.
    const cloudReconnect = await probeUrl(`${cloudBaseUrl}/health`, 3000);
    if (cloudReconnect.reachable) {
      reconnectResult = {
        step: 'reconnect-cloud',
        status: 'success',
        message: `تم إعادة الاتصال بالسحابة — ${cloudBaseUrl} (${cloudReconnect.timeMs}ms)`,
        detail: { url: cloudBaseUrl, timeMs: cloudReconnect.timeMs },
      };
      sendUpdate(mainWindow, { log: `[OK] Cloud reconnected: ${cloudBaseUrl} (${cloudReconnect.timeMs}ms)`, logType: 'ok' });
      console.log(`[Diagnostics] Cloud reconnected (${cloudReconnect.timeMs}ms)`);
    } else {
      reconnectResult = {
        step: 'reconnect-cloud',
        status: 'warning',
        message: 'فشل إعادة الاتصال — التطبيق سيعمل في الوضع المحلي',
      };
      sendUpdate(mainWindow, { log: `[WARN] Cloud reconnect failed — staying in offline mode`, logType: 'fail' });
    }
  } else {
    reconnectResult = {
      step: 'reconnect-cloud',
      status: 'warning',
      message: 'السحابة غير متاحة — التطبيق سيعمل في الوضع المحلي',
    };
    sendUpdate(mainWindow, { log: `[WARN] Cloud still unavailable — offline mode`, logType: 'fail' });
  }

  // Always start the sync service if local API is running, even if cloud
  // is unreachable. The sync service handles "local-only" mode gracefully
  // and will sync when the cloud becomes available later.
  if (localApiPort) {
    try {
      const { localDb: syncDb } = require('./local-api/lib/db');
      if (syncDb) {
        const syncService = require('./local-api/sync-service');
        // startSync() has an internal guard against double-starting
        await syncService.startSync({
          localDb: syncDb,
          cloudBaseUrl,
          deviceId: 'desktop-' + require('crypto').randomBytes(4).toString('hex'),
          // Use the engine default (30s) — the historic 2-minute override
          // here silently slowed realtime reconciliation for this path.
          initialDelayMs: 5000,
        });
        sendUpdate(mainWindow, { log: `[OK] Sync service started (30s interval, ${reconnectResult?.status === 'success' ? 'cloud+local' : 'local-only'})`, logType: 'ok' });
      }
    } catch (syncErr) {
      sendUpdate(mainWindow, { log: `[WARN] Sync service: ${syncErr.message.substring(0, 80)}`, logType: 'fail' });
    }
  }

  pushResult(reconnectResult);

  // ═══════════════════════════════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════════════════════════════
  return finalizeDiagnostics();
}


// ─── Helper: Fetch with Auth (for cloud API) ──────────────────────────────

/**
 * Fetch from the cloud API using Electron's net module with Bearer auth.
 * Returns parsed JSON body or null on failure.
 */
function fetchWithAuth(url, token, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const request = net.request(url);
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      try { request.abort(); } catch { /* ignore */ }
      resolve(result);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    if (token) request.setHeader('Authorization', 'Bearer ' + token);
    let body = '';
    request.on('response', (response) => {
      clearTimeout(timer);
      // Check HTTP status — 2xx only. 401/403 means expired/invalid token.
      if (response.statusCode >= 400) {
        console.warn(`[fetchWithAuth] HTTP ${response.statusCode} from ${url}`);
        response.on('data', () => {}); // drain
        response.on('end', () => done(null));
        return;
      }
      response.on('data', (chunk) => { body += chunk.toString(); });
      response.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          done(parsed);
        } catch {
          done(null);
        }
      });
    });
    request.on('error', () => {
      clearTimeout(timer);
      done(null);
    });
    try { request.end(); } catch { clearTimeout(timer); done(null); }
  });
}

// ─── Module Exports ────────────────────────────────────────────────────────

module.exports = {
  getLoadingHTML,
  getConsumerGateHTML,
  runDiagnostics,
  DIAGNOSTIC_STEPS,
};
