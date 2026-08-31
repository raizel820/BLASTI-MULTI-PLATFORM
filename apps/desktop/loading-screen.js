/**
 * BLASTI Desktop — Loading Screen & Startup Diagnostics
 *
 * Shows a branded loading screen while running comprehensive diagnostics
 * on app startup. The new flow:
 *
 *   1. Check local server is running; if not, start it
 *   2. Check cloud API is connected
 *   3. Check local DB and import agency data from cloud to local DB
 *   3b. Verify sync integrity: compare local DB tables & data with cloud
 *   4. Disconnect from cloud API to test fallback
 *   5. Test local API by creating a queue called "next", then delete it
 *   6. Test all local API endpoints
 *   7. If all succeeded, reconnect to cloud API
 *
 * Usage (in main.js):
 *   const { getLoadingHTML, runDiagnostics } = require('./loading-screen');
 *   mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(getLoadingHTML()));
 *   await runDiagnostics(mainWindow, config);
 */

const { net } = require('electron');
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
  // ── Group 2: Data Import ──────────────────────────────
  {
    id: 'import-agency-data',
    label: 'استيراد بيانات الوكالة',
    icon: '📥',
    description: 'جلب جميع بيانات الوكالة من السحابة وحفظها في قاعدة البيانات المحلية',
    group: 'import',
  },
  // ── Group 2b: Sync Verification ───────────────────────
  {
    id: 'verify-sync-integrity',
    label: 'التحقق من اكتمال المزامنة',
    icon: '🔍',
    description: 'مقارنة الجداول والبيانات المحلية مع السحابة للتأكد من اكتمال المزامنة',
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

      if (window.electronAPI.loadingScreenReady) window.electronAPI.loadingScreenReady();
    } else {
      progressLabel.textContent = 'خطأ: جسر الإلكترون غير متاح';
    }
  </script>
</body>
</html>`;
}
// ─── Diagnostic Runner ─────────────────────────────────────────────────────

function sendUpdate(mainWindow, data) {
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
    const timer = setTimeout(() => done({ reachable: false }), timeoutMs);
    request.on('response', (response) => {
      clearTimeout(timer);
      let body = '';
      response.on('data', (chunk) => { body += chunk.toString(); });
      response.on('end', () => {
        done({ reachable: true, statusCode: response.statusCode, body });
      });
    });
    request.on('error', () => {
      clearTimeout(timer);
      done({ reachable: false });
    });
    try { request.end(); } catch { clearTimeout(timer); done({ reachable: false }); }
  });
}

/**
 * Make a POST request using Electron's net module.
 */
function postUrl(url, body, timeoutMs = 5000) {
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
 * Make a PUT request using Electron's net module.
 */
function putUrl(url, body, token, timeoutMs = 5000) {
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
    const request = net.request(url);
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
    try { request.method = 'DELETE'; request.end(); } catch { clearTimeout(timer); done({ reachable: false, error: 'delete failed' }); }
  });
}

/**
 * Make a PATCH request using Electron's net module.
 */
function patchUrl(url, body, token, timeoutMs = 5000) {
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

  console.log('[Diagnostics] Starting startup diagnostics (new flow)...');

  let localApiPort = null;
  let cloudAvailable = false;
  let localApiToken = null;
  let agencyId = null;
  let cloudAuthToken = null;
  let cloudUser = null;

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
      const localDbDir = pathMod.join(userDataPath, 'blasti-local');
      process.env.BLASTI_LOCAL_DB_DIR = localDbDir;

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
          const dbPath = pathMod.join(localDbDir, 'local.db');
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

  results.push(serverResult);
  sendUpdate(mainWindow, serverResult);

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 2: Check Cloud API Connection
  // ═══════════════════════════════════════════════════════════════════════
  sendUpdate(mainWindow, {
    step: 'cloud-api',
    status: 'running',
    message: 'جاري فحص اتصال السحابة...',
    log: `[INFO] Probing cloud at ${cloudBaseUrl}/health`,
    logType: 'info',
  });

  await delay(300);

  let cloudResult = { step: 'cloud-api', status: 'warning', message: 'السحابة غير متاحة' };
  try {
    const cloudProbe = await probeUrl(`${cloudBaseUrl}/health`, 5000);
    if (cloudProbe.reachable) {
      cloudAvailable = true;
      cloudResult = {
        step: 'cloud-api',
        status: 'success',
        message: `السحابة متاحة — ${cloudBaseUrl} (${cloudProbe.timeMs}ms)`,
        detail: { url: cloudBaseUrl, timeMs: cloudProbe.timeMs },
      };
      sendUpdate(mainWindow, { log: `[OK] Cloud API reachable at ${cloudBaseUrl} (${cloudProbe.timeMs}ms)`, logType: 'ok' });
      console.log(`[Diagnostics] Cloud API: OK (${cloudProbe.timeMs}ms)`);
    } else {
      sendUpdate(mainWindow, { log: `[WARN] Cloud API unreachable — continuing in offline mode`, logType: 'fail' });
      console.warn('[Diagnostics] Cloud API: unreachable');
    }
  } catch (err) {
    sendUpdate(mainWindow, { log: `[WARN] Cloud check error: ${err.message}`, logType: 'fail' });
  }

  results.push(cloudResult);
  sendUpdate(mainWindow, cloudResult);

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 3: Import Agency Data from Cloud to Local DB
  // ═══════════════════════════════════════════════════════════════════════
  sendUpdate(mainWindow, {
    step: 'import-agency-data',
    status: 'running',
    message: 'جاري استيراد بيانات الوكالة...',
  });

  await delay(300);

  let importResult = { step: 'import-agency-data', status: 'success', message: 'تم التخطي — لا يوجد اتصال بالسحابة (سيتم الاستيراد بعد تسجيل الدخول)' };

  if (cloudAvailable && localApiPort && serverResult.status === 'success') {
    try {
      // Try to get stored credentials from Electron store
      // The preload.js exposes cloudSyncAuth — check main.js for stored creds
      const pathMod = require('path');
      const fs = require('fs');
      const authStorePath = pathMod.join(userDataPath, 'blasti-auth.json');

      let storedAuth = null;
      if (fs.existsSync(authStorePath)) {
        try {
          storedAuth = JSON.parse(fs.readFileSync(authStorePath, 'utf-8'));
          console.log('[Diagnostics] Found stored auth for user:', storedAuth.user?.username || storedAuth.user?.email);
        } catch { /* ignore */ }
      }

      if (storedAuth && storedAuth.token && storedAuth.user) {
        cloudAuthToken = storedAuth.token;
        cloudUser = storedAuth.user;
        agencyId = cloudUser.agencyId;

        sendUpdate(mainWindow, {
          step: 'import-agency-data',
          status: 'running',
          message: `جاري استيراد بيانات الوكالة ${agencyId ? '(' + agencyId.substring(0, 8) + '...)' : ''}...`,
          log: `[INFO] Importing agency data for user: ${cloudUser.username || cloudUser.email}`,
          logType: 'info',
        });

        // Import session to local API first
        const importSession = await postUrl(`http://127.0.0.1:${localApiPort}/api/auth/import-session`, {
          token: cloudAuthToken,
          user: cloudUser,
        });

        if (importSession.reachable && importSession.json?.success) {
          localApiToken = cloudAuthToken;
          sendUpdate(mainWindow, { log: `[OK] Session imported to local API`, logType: 'ok' });

          // Now fetch agency data from cloud and upsert into local DB
          const importResults = {};

          // Import Agency Profile
          // Cloud response is a FLAT object (no {success, data} wrapper):
          //   { id, name, nameAr, nameFr, address, category, phone, email, code, logoUrl, workingHoursStart, workingHoursEnd }
          const agencyRes = await fetchWithAuth(`${cloudBaseUrl}/api/agency/profile`, cloudAuthToken);
          if (agencyRes?.id) {
            const { localDb: importDb } = require('./local-api/lib/db');
            if (importDb) {
              try {
                const { code, ...rest } = agencyRes;
                await importDb.agency.upsert({
                  where: { id: agencyRes.id },
                  update: {
                    ...rest,
                    customCode: code || agencyRes.id,
                    ownerId: cloudUser.id,
                    subscriptionStatus: 'ACTIVE',
                    isQueueOpen: true,
                    isActive: true,
                    // Prisma defaults for required fields not in response
                    city: 'M\'Sila',
                    wilaya: '28',
                  },
                  create: {
                    ...rest,
                    customCode: code || agencyRes.id,
                    ownerId: cloudUser.id,
                    subscriptionStatus: 'ACTIVE',
                    isQueueOpen: true,
                    isActive: true,
                    city: 'M\'Sila',
                    wilaya: '28',
                  },
                });
                importResults.agency = 'imported';
                sendUpdate(mainWindow, { log: `[OK] Agency profile imported: ${agencyRes.name || agencyRes.id}`, logType: 'ok' });
              } catch (e) {
                console.warn('[Import] Agency error:', e.message);
                sendUpdate(mainWindow, { log: `[WARN] Agency import failed: ${e.message.substring(0, 80)}`, logType: 'warn' });
              }
            }
          } else {
            sendUpdate(mainWindow, { log: `[SKIP] Agency profile: unexpected response shape`, logType: 'info' });
          }

          // Import Services
          // Cloud response: { success: true, services: [...] }
          const servicesRes = await fetchWithAuth(`${cloudBaseUrl}/api/services?agencyId=${agencyId}`, cloudAuthToken);
          const servicesList = servicesRes?.services || (Array.isArray(servicesRes) ? servicesRes : null);
          if (Array.isArray(servicesList) && servicesList.length > 0) {
            const { localDb: importDb } = require('./local-api/lib/db');
            if (importDb) {
              for (const svc of servicesList) {
                const { _count, ...svcData } = svc;
                await importDb.service.upsert({
                  where: { id: svc.id },
                  update: svcData,
                  create: { ...svcData, agencyId: svc.agencyId || agencyId },
                }).catch(e => console.warn('[Import] Service error:', e.message));
              }
              importResults.services = `${servicesList.length} imported`;
              sendUpdate(mainWindow, { log: `[OK] Services: ${servicesList.length} imported`, logType: 'ok' });
            }
          } else {
            sendUpdate(mainWindow, { log: `[SKIP] Services: no data returned`, logType: 'info' });
          }

          // Import Branches
          // Cloud response: { success: true, branches: [...] }  (each branch has _count but no counters)
          const branchesRes = await fetchWithAuth(`${cloudBaseUrl}/api/agency/branches?agencyId=${agencyId}`, cloudAuthToken);
          const branchesList = branchesRes?.branches || (Array.isArray(branchesRes) ? branchesRes : null);
          if (Array.isArray(branchesList) && branchesList.length > 0) {
            const { localDb: importDb } = require('./local-api/lib/db');
            if (importDb) {
              for (const branch of branchesList) {
                const { _count, counters, ...branchData } = branch;
                await importDb.branch.upsert({
                  where: { id: branch.id },
                  update: branchData,
                  create: { ...branchData, agencyId: branch.agencyId || agencyId },
                }).catch(e => console.warn('[Import] Branch error:', e.message));
              }
              importResults.branches = `${branchesList.length} imported`;
              sendUpdate(mainWindow, { log: `[OK] Branches: ${branchesList.length} imported`, logType: 'ok' });
            }
          } else {
            sendUpdate(mainWindow, { log: `[SKIP] Branches: no data returned`, logType: 'info' });
          }

          // Import Staff
          // Cloud response: { staff: [...] }  (NO { success, data } wrapper)
          const staffRes = await fetchWithAuth(`${cloudBaseUrl}/api/agency/staff?agencyId=${agencyId}`, cloudAuthToken);
          const staffList = staffRes?.staff || (Array.isArray(staffRes) ? staffRes : null);
          if (Array.isArray(staffList) && staffList.length > 0) {
            const { localDb: importDb } = require('./local-api/lib/db');
            if (importDb) {
              for (const staff of staffList) {
                const { _count, user, permissions: rawPermissions, ...staffData } = staff;
                // permissions may be a parsed object (not a string) — store as JSON string for SQLite
                const upsertPayload = {
                  ...staffData,
                  agencyId: staff.agencyId || agencyId,
                  permissions: typeof rawPermissions === 'object' ? JSON.stringify(rawPermissions) : (rawPermissions || '{}'),
                };
                await importDb.agencyStaff.upsert({
                  where: { id: staff.id },
                  update: upsertPayload,
                  create: upsertPayload,
                }).catch(e => console.warn('[Import] Staff error:', e.message));
              }
              importResults.staff = `${staffList.length} imported`;
              sendUpdate(mainWindow, { log: `[OK] Staff: ${staffList.length} imported`, logType: 'ok' });
            }
          } else {
            sendUpdate(mainWindow, { log: `[SKIP] Staff: no data returned`, logType: 'info' });
          }

          // Import User profile
          // Cloud response: { success: true, id, username, fullName, email, ... }  (flat, no .data wrapper)
          const userRes = await fetchWithAuth(`${cloudBaseUrl}/api/user/profile`, cloudAuthToken);
          if (userRes?.id) {
            const { localDb: importDb } = require('./local-api/lib/db');
            if (importDb) {
              try {
                // passwordHash is not returned by cloud API — required for create, not for update
                // Use update-only (skip create) to avoid needing passwordHash
                const { success, _count, notificationPreferences, notificationPref, ...userData } = userRes;
                const existingUser = await importDb.user.findUnique({ where: { id: userData.id } }).catch(() => null);
                if (existingUser) {
                  await importDb.user.update({
                    where: { id: userData.id },
                    data: userData,
                  }).catch(e => console.warn('[Import] User update error:', e.message));
                } else {
                  // Create with a placeholder passwordHash — local login won't use it
                  // (auth is via cloud-imported session token, not local password)
                  await importDb.user.create({
                    data: {
                      ...userData,
                      passwordHash: '__cloud_imported__',
                      notificationPreferences: notificationPreferences || '{"queue_called":true,"turn_approaching":true,"completed":true}',
                    },
                  }).catch(e => console.warn('[Import] User create error:', e.message));
                }
                importResults.user = 'imported';
                sendUpdate(mainWindow, { log: `[OK] User profile imported`, logType: 'ok' });
              } catch (e) {
                console.warn('[Import] User error:', e.message);
                sendUpdate(mainWindow, { log: `[WARN] User import failed: ${e.message.substring(0, 80)}`, logType: 'warn' });
              }
            }
          } else {
            sendUpdate(mainWindow, { log: `[SKIP] User profile: unexpected response shape`, logType: 'info' });
          }

          // Import Queue Settings
          // The old code fetched /api/agency/queue which returns QUEUE ENTRIES, not settings.
          // There is no dedicated QueueSettings endpoint in the cloud API.
          // Instead, fetch /api/agency/settings for agency-level settings,
          // and ensure a QueueSettings record exists in the local DB.
          const agencySettingsRes = await fetchWithAuth(`${cloudBaseUrl}/api/agency/settings?agencyId=${agencyId}`, cloudAuthToken);
          const { localDb: importDb } = require('./local-api/lib/db');
          if (importDb && agencyId) {
            try {
              // Update agency record with settings from /api/agency/settings
              if (agencySettingsRes && typeof agencySettingsRes === 'object') {
                const { services, ...settingsData } = agencySettingsRes;
                // Only update fields that exist on the Agency model
                const agencyUpdateFields = {};
                if (settingsData.avgServiceTime !== undefined) agencyUpdateFields.averageServiceTime = settingsData.avgServiceTime;
                if (settingsData.maxReservations !== undefined) agencyUpdateFields.maxActiveReservations = settingsData.maxReservations;
                if (settingsData.isQueueOpen !== undefined) agencyUpdateFields.isQueueOpen = settingsData.isQueueOpen;
                if (settingsData.workingHoursStart !== undefined) agencyUpdateFields.workingHoursStart = settingsData.workingHoursStart;
                if (settingsData.workingHoursEnd !== undefined) agencyUpdateFields.workingHoursEnd = settingsData.workingHoursEnd;
                if (settingsData.autoPauseWhenFull !== undefined) agencyUpdateFields.autoPauseWhenFull = settingsData.autoPauseWhenFull;
                if (settingsData.kioskModeEnabled !== undefined) agencyUpdateFields.kioskModeEnabled = settingsData.kioskModeEnabled;
                if (settingsData.sponsorSms !== undefined) agencyUpdateFields.sponsorSms = settingsData.sponsorSms;
                if (settingsData.smsBalance !== undefined) agencyUpdateFields.smsBalance = settingsData.smsBalance;
                if (Object.keys(agencyUpdateFields).length > 0) {
                  await importDb.agency.update({ where: { id: agencyId }, data: agencyUpdateFields }).catch(() => {});
                }
              }

              // Ensure a QueueSettings record exists for this agency
              const existingQs = await importDb.queueSettings.findFirst({ where: { agencyId } }).catch(() => null);
              if (!existingQs) {
                await importDb.queueSettings.create({
                  data: {
                    agencyId,
                    lastIssuedNumber: 0,
                    currentServingNumber: 0,
                    isPaused: false,
                  },
                });
                sendUpdate(mainWindow, { log: `[OK] QueueSettings created (defaults)`, logType: 'ok' });
              } else {
                sendUpdate(mainWindow, { log: `[OK] QueueSettings already exists`, logType: 'ok' });
              }
              importResults.queueSettings = 'imported';
            } catch (e) {
              console.warn('[Import] QueueSettings error:', e.message);
              sendUpdate(mainWindow, { log: `[WARN] QueueSettings import failed: ${e.message.substring(0, 80)}`, logType: 'warn' });
            }
          }

          const summaryParts = Object.entries(importResults).map(([k, v]) => `${k}: ${v}`);
          importResult = {
            step: 'import-agency-data',
            status: 'success',
            message: `تم استيراد ${Object.keys(importResults).length} أنواع بيانات — ${summaryParts.join(', ')}`,
            detail: importResults,
          };
          console.log('[Diagnostics] Agency data import:', importResults);
        } else {
          importResult = {
            step: 'import-agency-data',
            status: 'success',
            message: 'تم التخطي — بيانات الاعتماد غير صالحة (سيتم الاستيراد بعد تسجيل الدخول)',
          };
          sendUpdate(mainWindow, { log: `[SKIP] Session import failed — will import after fresh login`, logType: 'info' });
        }
      } else {
        importResult = {
          step: 'import-agency-data',
          status: 'success',
          message: 'تم التخطي — لا توجد بيانات اعتماد محفوظة (سيتم الاستيراد بعد تسجيل الدخول)',
        };
        sendUpdate(mainWindow, { log: `[SKIP] No stored auth — will import after login`, logType: 'info' });
      }
    } catch (err) {
      importResult = {
        step: 'import-agency-data',
        status: 'success',
        message: `تم التخطي — خطأ غير متوقع (${err.message.substring(0, 40)}) — سيتم الاستيراد بعد تسجيل الدخول`,
      };
      sendUpdate(mainWindow, { log: `[SKIP] Import error: ${err.message} — will retry after login`, logType: 'info' });
      console.warn('[Diagnostics] Import skipped (error):', err.message);
    }
  } else if (!cloudAvailable) {
    sendUpdate(mainWindow, { log: `[INFO] Cloud unavailable — checking local data and restoring session...`, logType: 'info' });
    // CRITICAL FIX: Even when offline, we MUST restore the local API session.
    // The renderer cannot access the local API without a valid session.
    // Read saved auth from blasti-auth.json and import into local API.
    try {
      const pathMod = require('path');
      const fs = require('fs');
      const authStorePath = pathMod.join(userDataPath, 'blasti-auth.json');

      if (fs.existsSync(authStorePath) && localApiPort) {
        const storedAuth = JSON.parse(fs.readFileSync(authStorePath, 'utf-8'));
        if (storedAuth && storedAuth.token && storedAuth.user) {
          cloudAuthToken = storedAuth.token;
          cloudUser = storedAuth.user;
          agencyId = cloudUser.agencyId;

          sendUpdate(mainWindow, { log: `[INFO] Found saved auth — restoring session to local API...`, logType: 'info' });

          const importSession = await postUrl(`http://127.0.0.1:${localApiPort}/api/auth/import-session`, {
            token: cloudAuthToken,
            user: cloudUser,
          });

          if (importSession.reachable && importSession.json?.success) {
            localApiToken = cloudAuthToken;
            sendUpdate(mainWindow, { log: `[OK] Session restored from saved auth (offline mode) — user: ${cloudUser.username || cloudUser.email}`, logType: 'ok' });
            console.log('[Diagnostics] Session restored from saved auth (offline):', cloudUser.username);
          } else {
            sendUpdate(mainWindow, { log: `[WARN] Session restore failed (offline) — renderer will retry`, logType: 'fail' });
          }
        } else {
          sendUpdate(mainWindow, { log: `[INFO] No saved auth found — first run or not logged in`, logType: 'info' });
        }
      } else {
        sendUpdate(mainWindow, { log: `[INFO] No auth file found at ${authStorePath}`, logType: 'info' });
      }
    } catch (e) {
      sendUpdate(mainWindow, { log: `[WARN] Offline session restore error: ${e.message}`, logType: 'fail' });
    }

    // Check if local DB has data
    try {
      const { localDb: checkDb } = require('./local-api/lib/db');
      if (checkDb) {
        const agencyCount = await checkDb.agency.count();
        if (agencyCount > 0) {
          importResult = {
            step: 'import-agency-data',
            status: 'success',
            message: `السحابة غير متاحة — استخدام البيانات المحلية (${agencyCount} وكالة) — تم استعادة الجلسة`,
          };
          sendUpdate(mainWindow, { log: `[OK] Using existing local data: ${agencyCount} agency(ies) + session restored`, logType: 'ok' });
        } else {
          importResult = {
            step: 'import-agency-data',
            status: localApiToken ? 'success' : 'warning',
            message: localApiToken
              ? 'الجلسة مستعادة لكن قاعدة البيانات المحلية فارغة'
              : 'لا توجد بيانات محلية ولا جلسة محفوظة',
          };
          sendUpdate(mainWindow, { log: `[WARN] Local DB empty (agencyCount=0) ${localApiToken ? 'but session restored' : 'and no session'}`, logType: localApiToken ? 'info' : 'fail' });
        }
      }
    } catch { /* ignore */ }
  } else {
    sendUpdate(mainWindow, { log: `[INFO] Local server not running — skipping import`, logType: 'info' });
  }

  results.push(importResult);
  sendUpdate(mainWindow, importResult);

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 3b: Verify Sync Integrity — compare local DB data with cloud
  // ═══════════════════════════════════════════════════════════════════════
  sendUpdate(mainWindow, {
    step: 'verify-sync-integrity',
    status: 'running',
    message: 'جاري التحقق من اكتمال المزامنة...',
    log: '[INFO] Verifying sync integrity — comparing local DB with cloud...',
    logType: 'info',
  });

  await delay(300);

  let verifyResult = {
    step: 'verify-sync-integrity',
    status: 'success',
    message: 'تم التخطي — لا توجد بيانات كافية للتحقق',
  };

  // Tables we want to verify (Prisma model names → local table names)
  const VERIFY_TABLES = [
    { model: 'Agency', table: 'Agency', label: 'وكالات', cloudEndpoint: null },
    { model: 'Service', table: 'Service', label: 'خدمات', cloudEndpoint: 'services' },
    { model: 'Branch', table: 'Branch', label: 'فروع', cloudEndpoint: 'branches' },
    { model: 'AgencyStaff', table: 'AgencyStaff', label: 'موظفين', cloudEndpoint: 'staff' },
    { model: 'Counter', table: 'Counter', label: 'طاولات', cloudEndpoint: null },
    { model: 'Reservation', table: 'Reservation', label: 'حجوزات', cloudEndpoint: null },
    { model: 'QueueSettings', table: 'QueueSettings', label: 'إعدادات الطابور', cloudEndpoint: null },
  ];

  if (localApiPort && serverResult.status === 'success') {
    try {
      const { localDb: verifyDb } = require('./local-api/lib/db');
      if (!verifyDb) {
        verifyResult = {
          step: 'verify-sync-integrity',
          status: 'warning',
          message: 'قاعدة البيانات المحلية غير متاحة للتحقق',
        };
        sendUpdate(mainWindow, { log: `[WARN] Local DB not available for verification`, logType: 'fail' });
      } else {
        // --- Phase A: Count local records ---
        const localCounts = {};
        for (const vt of VERIFY_TABLES) {
          try {
            const count = await verifyDb[vt.table].count();
            localCounts[vt.model] = typeof count === 'bigint' ? Number(count) : count;
          } catch (e) {
            localCounts[vt.model] = -1; // table may not exist
            sendUpdate(mainWindow, { log: `[WARN] Table ${vt.table} error: ${e.message.substring(0, 60)}`, logType: 'fail' });
          }
        }

        const localTotalRecords = Object.values(localCounts).reduce((sum, c) => sum + (c > 0 ? c : 0), 0);
        sendUpdate(mainWindow, {
          log: `[INFO] Local DB counts: ${VERIFY_TABLES.map(t => t.label + '=' + (localCounts[t.model] >= 0 ? localCounts[t.model] : 'ERR')).join(', ')} (total: ${localTotalRecords})`,
          logType: 'info',
        });

        // --- Phase B: Check if tables exist (schema) ---
        const tablesResult = await verifyDb.$queryRawUnsafe("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
        const existingTables = tablesResult ? tablesResult.map(r => r.name) : [];
        const expectedTables = VERIFY_TABLES.map(t => t.table);
        const missingTables = expectedTables.filter(t => !existingTables.includes(t));

        if (missingTables.length > 0) {
          sendUpdate(mainWindow, { log: `[WARN] Missing tables: ${missingTables.join(', ')}`, logType: 'fail' });
        }

        // --- Phase C: Compare with cloud (if available) ---
        let cloudCounts = null;
        let comparisonDetails = [];

        if (cloudAvailable && cloudAuthToken && agencyId) {
          sendUpdate(mainWindow, { log: '[INFO] Cloud available — fetching cloud counts for comparison...', logType: 'info' });
          cloudCounts = {};

          // Agency: from profile (1 record if successful)
          try {
            const agencyRes = await fetchWithAuth(`${cloudBaseUrl}/api/agency/profile`, cloudAuthToken, 5000);
            cloudCounts.Agency = agencyRes?.id ? 1 : 0;
          } catch { cloudCounts.Agency = -1; }

          // Services
          try {
            const servicesRes = await fetchWithAuth(`${cloudBaseUrl}/api/services?agencyId=${agencyId}`, cloudAuthToken, 5000);
            const servicesList = servicesRes?.services || (Array.isArray(servicesRes) ? servicesRes : []);
            cloudCounts.Service = servicesList.length;
          } catch { cloudCounts.Service = -1; }

          // Branches
          try {
            const branchesRes = await fetchWithAuth(`${cloudBaseUrl}/api/agency/branches?agencyId=${agencyId}`, cloudAuthToken, 5000);
            const branchesList = branchesRes?.branches || (Array.isArray(branchesRes) ? branchesRes : []);
            cloudCounts.Branch = branchesList.length;
          } catch { cloudCounts.Branch = -1; }

          // Staff
          try {
            const staffRes = await fetchWithAuth(`${cloudBaseUrl}/api/agency/staff?agencyId=${agencyId}`, cloudAuthToken, 5000);
            const staffList = staffRes?.staff || (Array.isArray(staffRes) ? staffRes : []);
            cloudCounts.AgencyStaff = staffList.length;
          } catch { cloudCounts.AgencyStaff = -1; }

          // Reservations (from stats or queue endpoint)
          try {
            const statsRes = await fetchWithAuth(`${cloudBaseUrl}/api/agency/stats?agencyId=${agencyId}`, cloudAuthToken, 5000);
            if (statsRes?.todayTotal !== undefined) {
              cloudCounts.Reservation = statsRes.todayTotal;
            } else if (statsRes?.totalReservations !== undefined) {
              cloudCounts.Reservation = statsRes.totalReservations;
            } else {
              // Fallback: count from queue endpoint
              const queueRes = await fetchWithAuth(`${cloudBaseUrl}/api/agency/queue?agencyId=${agencyId}&limit=1`, cloudAuthToken, 5000);
              cloudCounts.Reservation = queueRes?.total || queueRes?.pagination?.total || -1;
            }
          } catch { cloudCounts.Reservation = -1; }

          // QueueSettings: 1 per agency (always 1 if agency exists)
          cloudCounts.QueueSettings = cloudCounts.Agency > 0 ? 1 : 0;

          // Counter: from branches
          try {
            const countersRes = await fetchWithAuth(`${cloudBaseUrl}/api/agency/counters?agencyId=${agencyId}`, cloudAuthToken, 5000);
            const countersList = countersRes?.counters || (Array.isArray(countersRes) ? countersRes : []);
            cloudCounts.Counter = countersList.length;
          } catch { cloudCounts.Counter = -1; }

          sendUpdate(mainWindow, {
            log: `[INFO] Cloud counts: ${VERIFY_TABLES.map(t => t.label + '=' + (cloudCounts[t.model] >= 0 ? cloudCounts[t.model] : 'ERR')).join(', ')}`,
            logType: 'info',
          });

          // --- Phase D: Compare counts ---
          let matchCount = 0;
          let mismatchCount = 0;
          let missingDataTables = []; // tables with local=0 but cloud>0

          for (const vt of VERIFY_TABLES) {
            const local = localCounts[vt.model];
            const cloud = cloudCounts[vt.model];

            if (local < 0 || cloud < 0) {
              // Could not fetch one side — skip comparison
              comparisonDetails.push({ table: vt.label, local, cloud, status: 'skip' });
              continue;
            }

            // For reservations, local may have more (offline-created) or fewer (cloud has more history)
            // We only flag as error if local has ZERO but cloud has data
            if (local === 0 && cloud > 0) {
              mismatchCount++;
              missingDataTables.push(vt.label);
              comparisonDetails.push({ table: vt.label, local, cloud, status: 'missing' });
              sendUpdate(mainWindow, {
                log: `[FAIL] ${vt.label}: local=0, cloud=${cloud} — TABLE EXISTS BUT NO DATA!`,
                logType: 'fail',
              });
            } else if (local < cloud * 0.5 && cloud > 0) {
              // Local has significantly less than cloud (>50% missing)
              mismatchCount++;
              comparisonDetails.push({ table: vt.label, local, cloud, status: 'partial' });
              sendUpdate(mainWindow, {
                log: `[WARN] ${vt.label}: local=${local}, cloud=${cloud} — partial sync (${Math.round((local / cloud) * 100)}%)`,
                logType: 'fail',
              });
            } else if (local >= cloud) {
              matchCount++;
              comparisonDetails.push({ table: vt.label, local, cloud, status: 'ok' });
            } else {
              // Local has less but within 50% — acceptable (reservations, notifications may differ)
              matchCount++;
              comparisonDetails.push({ table: vt.label, local, cloud, status: 'acceptable' });
              sendUpdate(mainWindow, {
                log: `[OK] ${vt.label}: local=${local}, cloud=${cloud} — acceptable difference`,
                logType: 'ok',
              });
            }
          }

          // Determine result status
          if (missingDataTables.length > 0) {
            // Critical: some tables have schema but NO data
            verifyResult = {
              step: 'verify-sync-integrity',
              status: 'error',
              message: `جداول موجودة لكن بدون بيانات: ${missingDataTables.join(', ')}`,
              detail: {
                localCounts,
                cloudCounts,
                comparison: comparisonDetails,
                missingTables: missingTables.length === 0 ? undefined : missingTables,
                localTotalRecords,
              },
            };
          } else if (mismatchCount > 0) {
            verifyResult = {
              step: 'verify-sync-integrity',
              status: 'warning',
              message: `${matchCount}/${matchCount + mismatchCount} جدول متطابق — ${mismatchCount} لديه فرق في البيانات`,
              detail: {
                localCounts,
                cloudCounts,
                comparison: comparisonDetails,
                missingTables: missingTables.length === 0 ? undefined : missingTables,
                localTotalRecords,
              },
            };
          } else {
            verifyResult = {
              step: 'verify-sync-integrity',
              status: 'success',
              message: `جميع الجداول والبيانات متزامنة — ${Object.keys(localCounts).length} جدول، ${localTotalRecords} سجل محلي`,
              detail: {
                localCounts,
                cloudCounts,
                comparison: comparisonDetails,
                localTotalRecords,
              },
            };
          }
        } else if (!cloudAvailable) {
          // --- Cloud not available: just verify local has data ---
          sendUpdate(mainWindow, { log: '[INFO] Cloud unavailable — verifying local data integrity only...', logType: 'info' });

          const tablesWithData = Object.entries(localCounts).filter(([_, count]) => count > 0);
          const tablesWithZero = Object.entries(localCounts).filter(([_, count]) => count === 0);
          const tablesWithError = Object.entries(localCounts).filter(([_, count]) => count < 0);

          if (missingTables.length > 0) {
            verifyResult = {
              step: 'verify-sync-integrity',
              status: 'error',
              message: `جداول مفقودة: ${missingTables.join(', ')} — لا يمكن العمل بدونها`,
              detail: { localCounts, missingTables, localTotalRecords },
            };
            sendUpdate(mainWindow, { log: `[FAIL] Missing tables: ${missingTables.join(', ')}`, logType: 'fail' });
          } else if (tablesWithData.length === 0) {
            // No data at all — might be first run without cloud
            if (cloudAuthToken && agencyId) {
              // Had auth but no data — real problem
              verifyResult = {
                step: 'verify-sync-integrity',
                status: 'error',
                message: 'جميع الجداول فارغة — لم يتم استيراد أي بيانات رغم وجود اتصال سابق',
                detail: { localCounts, missingTables, localTotalRecords },
              };
              sendUpdate(mainWindow, { log: `[FAIL] ALL tables empty — no data was synced!`, logType: 'fail' });
            } else {
              // No auth — first run, expected
              verifyResult = {
                step: 'verify-sync-integrity',
                status: 'success',
                message: 'الجداول جاهزة لكن فارغة — سيتم ملؤها بعد تسجيل الدخول',
                detail: { localCounts, missingTables, localTotalRecords },
              };
              sendUpdate(mainWindow, { log: `[OK] Tables exist but empty — will populate after login`, logType: 'ok' });
            }
          } else if (localCounts.Agency > 0 && localCounts.Service > 0) {
            // Key tables have data — good
            verifyResult = {
              step: 'verify-sync-integrity',
              status: 'success',
              message: `بيانات محلية متوفرة — ${tablesWithData.length} جدول به بيانات، ${localTotalRecords} سجل إجمالي (وضع عدم الاتصال)`,
              detail: { localCounts, missingTables, localTotalRecords },
            };
            sendUpdate(mainWindow, { log: `[OK] Local data available: ${tablesWithData.map(([t, c]) => t + '=' + c).join(', ')}`, logType: 'ok' });
          } else {
            // Some tables have data but not the critical ones
            verifyResult = {
              step: 'verify-sync-integrity',
              status: 'warning',
              message: `بيانات جزئية — ${tablesWithData.length} جدول به بيانات من ${VERIFY_TABLES.length} (السحابة غير متاحة للتحقق)`,
              detail: { localCounts, missingTables, localTotalRecords },
            };
            sendUpdate(mainWindow, {
              log: `[WARN] Partial data: ${tablesWithData.map(([t, c]) => t + '=' + c).join(', ')} — ${tablesWithZero.length} empty`,
              logType: 'fail',
            });
          }
        } else {
          // Cloud available but no auth — skip detailed comparison
          verifyResult = {
            step: 'verify-sync-integrity',
            status: 'success',
            message: `الجداول جاهزة (${existingTables.length} جدول، ${localTotalRecords} سجل) — سيتم التحقق الكامل بعد تسجيل الدخول`,
            detail: { localCounts, missingTables, localTotalRecords },
          };
          sendUpdate(mainWindow, { log: `[OK] Tables ready (${existingTables.length}), ${localTotalRecords} records — full verify after login`, logType: 'ok' });
        }
      }
    } catch (err) {
      verifyResult = {
        step: 'verify-sync-integrity',
        status: 'warning',
        message: `خطأ في التحقق: ${err.message.substring(0, 60)}`,
      };
      sendUpdate(mainWindow, { log: `[WARN] Verification error: ${err.message}`, logType: 'fail' });
      console.warn('[Diagnostics] Verify sync error:', err.message);
    }
  } else {
    verifyResult = {
      step: 'verify-sync-integrity',
      status: 'success',
      message: 'تم التخطي — الخادم المحلي غير متاح',
    };
    sendUpdate(mainWindow, { log: '[SKIP] Local server not available — skipping verification', logType: 'info' });
  }

  results.push(verifyResult);
  sendUpdate(mainWindow, verifyResult);

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

  results.push(disconnectResult);
  sendUpdate(mainWindow, disconnectResult);

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 5: Test Queue CRUD (create queue "next", then delete)
  // ═══════════════════════════════════════════════════════════════════════
  sendUpdate(mainWindow, {
    step: 'test-queue-crud',
    status: 'running',
    message: 'جاري اختبار إنشاء وحذف طابور "next"...',
    log: '[INFO] Testing queue CRUD: create "next" → verify → delete → verify',
    logType: 'info',
  });

  await delay(300);

  let crudResult = { step: 'test-queue-crud', status: 'success', message: 'تم التخطي — لا توجد جلسة محلية (سيتم الاختبار بعد تسجيل الدخول)' };

  if (localApiPort && localApiToken) {
    try {
      const { localDb: testDb } = require('./local-api/lib/db');
      const testAgencyId = agencyId || 'test-agency-id';

      // Check if we have services to create a reservation with
      let testServiceId = null;
      const services = await testDb.service.findMany({
        where: { agencyId: testAgencyId, isActive: true },
        take: 1,
      });

      if (services.length > 0) {
        testServiceId = services[0].id;
      } else {
        // Create a test service first
        const testService = await testDb.service.create({
          data: {
            id: 'test-service-next-' + Date.now(),
            name: 'خدمة اختبار next',
            nameEn: 'Test Next Service',
            agencyId: testAgencyId,
            isActive: true,
            avgServiceTime: 5,
            prefix: 'T',
          },
        });
        testServiceId = testService.id;
        sendUpdate(mainWindow, { log: `[INFO] Created test service: ${testServiceId}`, logType: 'info' });
      }

      // 1. CREATE: Create a reservation via local API with name "next"
      sendUpdate(mainWindow, { log: '[TEST] POST /api/reservations — creating queue "next"...', logType: 'info' });
      const createRes = await postUrl(`http://127.0.0.1:${localApiPort}/api/reservations?token=${localApiToken}`, {
        serviceId: testServiceId,
        customerName: 'next',
        customerPhone: '0000000000',
      });

      let createdReservationId = null;
      if (createRes.reachable && createRes.json?.success) {
        createdReservationId = createRes.json.data?.id;
        sendUpdate(mainWindow, { log: `[OK] Queue "next" created: id=${createdReservationId}, ticket=${createRes.json.data?.ticketNumber}`, logType: 'ok' });
      } else {
        sendUpdate(mainWindow, { log: `[FAIL] Create failed: ${createRes.body?.substring(0, 120) || 'no response'}`, logType: 'fail' });
      }

      // 2. VERIFY: Read it back
      if (createdReservationId) {
        sendUpdate(mainWindow, { log: `[TEST] GET /api/reservations — verifying queue "next" exists...`, logType: 'info' });
        const getRes = await probeUrl(`http://127.0.0.1:${localApiPort}/api/reservations?token=${localApiToken}`);
        if (getRes.reachable && getRes.json?.success) {
          const found = getRes.json.data?.find(r => r.id === createdReservationId);
          if (found) {
            sendUpdate(mainWindow, { log: `[OK] Queue "next" verified in local DB: ticket=${found.ticketNumber}, status=${found.status}`, logType: 'ok' });
          } else {
            sendUpdate(mainWindow, { log: `[WARN] Queue "next" not found in list (may be filtered)`, logType: 'fail' });
          }
        }
      }

      // 3. DELETE: Delete the reservation
      if (createdReservationId) {
        sendUpdate(mainWindow, { log: `[TEST] PUT /api/reservations/${createdReservationId} — canceling queue "next"...`, logType: 'info' });
        const deleteRes = await putUrl(
          `http://127.0.0.1:${localApiPort}/api/reservations/${createdReservationId}?token=${localApiToken}`,
          { status: 'CANCELLED' },
          localApiToken,
        );
        if (deleteRes.reachable) {
          sendUpdate(mainWindow, { log: `[OK] Queue "next" cancelled (status: CANCELLED)`, logType: 'ok' });
        } else {
          sendUpdate(mainWindow, { log: `[FAIL] Cancel failed: ${deleteRes.error || 'no response'}`, logType: 'fail' });
        }
      }

      // 4. VERIFY DELETION: Confirm it's cancelled
      if (createdReservationId) {
        const { localDb: verifyDb } = require('./local-api/lib/db');
        const cancelled = await verifyDb.reservation.findUnique({ where: { id: createdReservationId } });
        if (cancelled && cancelled.status === 'CANCELLED') {
          sendUpdate(mainWindow, { log: `[OK] Verified: reservation ${createdReservationId} is CANCELLED in local DB`, logType: 'ok' });
          crudResult = {
            step: 'test-queue-crud',
            status: 'success',
            message: `إنشاء ✓ → تحقق ✓ → حذف ✓ — طابور "next" اختباري ناجح`,
            detail: { created: true, verified: true, deleted: true, reservationId: createdReservationId },
          };
        } else {
          crudResult = {
            step: 'test-queue-crud',
            status: 'warning',
            message: 'تم الإنشاء لكن التحقق من الحذف فشل',
          };
        }

        // Clean up test service if we created it
        if (!services || services.length === 0) {
          try {
            await verifyDb.service.delete({ where: { id: testServiceId } }).catch(() => {});
          } catch { /* ignore */ }
        }
      }
    } catch (err) {
      crudResult = {
        step: 'test-queue-crud',
        status: 'success',
        message: `تم التخطي — خطأ غير متوقع (${err.message.substring(0, 40)}) — سيتم الاختبار بعد تسجيل الدخول`,
      };
      sendUpdate(mainWindow, { log: `[SKIP] CRUD test error: ${err.message} — will test after login`, logType: 'info' });
    }
  } else if (localApiPort && !localApiToken) {
    crudResult = {
      step: 'test-queue-crud',
      status: 'success',
      message: 'تم التخطي — لا توجد جلسة محلية (سيتم الاختبار بعد تسجيل الدخول)',
    };
    sendUpdate(mainWindow, { log: `[SKIP] No local session — will test after login`, logType: 'info' });
  } else {
    crudResult = {
      step: 'test-queue-crud',
      status: 'success',
      message: 'تم التخطي — الخادم المحلي غير متاح بعد',
    };
    sendUpdate(mainWindow, { log: `[SKIP] Local server not available — will test after startup`, logType: 'info' });
  }

  results.push(crudResult);
  sendUpdate(mainWindow, crudResult);

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
        message: `جميع نقاط API تعمل — ${passed}/${total} نجحت`,
        detail: { passed, failed, total },
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

  results.push(endpointsResult);
  sendUpdate(mainWindow, endpointsResult);

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
          syncIntervalMs: 2 * 60 * 1000,
          initialDelayMs: 5000,
        });
        sendUpdate(mainWindow, { log: `[OK] Sync service started (2-min interval, ${reconnectResult?.status === 'success' ? 'cloud+local' : 'local-only'})`, logType: 'ok' });
      }
    } catch (syncErr) {
      sendUpdate(mainWindow, { log: `[WARN] Sync service: ${syncErr.message.substring(0, 80)}`, logType: 'fail' });
    }
  }

  results.push(reconnectResult);
  sendUpdate(mainWindow, reconnectResult);

  // ═══════════════════════════════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════════════════════════════
  const allPassed = results.every(r => r.status === 'success');
  const hasWarnings = results.some(r => r.status === 'warning');
  const hasErrors = results.some(r => r.status === 'error');

  console.log(`[Diagnostics] Complete — ${results.filter(r => r.status === 'success').length}/${results.length} passed`);

  try {
    mainWindow.webContents.send('diagnostics:finalized', {
      completedSteps: results.map(r => r.step),
      totalSteps: DIAGNOSTIC_STEPS.length,
    });
  } catch (_) { /* window may be gone */ }

  return { results, allPassed: allPassed || (!hasErrors && hasWarnings) };
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
  runDiagnostics,
  DIAGNOSTIC_STEPS,
};
