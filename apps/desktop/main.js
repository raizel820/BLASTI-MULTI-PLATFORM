/**
 * BLASTI Desktop — Electron Main Process
 *
 * @blasti/desktop Electron shell for the BLASTI (بلاصتي) queue management app.
 *
 * Strategy: Remote web app shell
 *   • ALWAYS opens on the agency sign-in page (/agency/login) — the consumer
 *     marketing landing page (SPA root '/') is for the web app only.
 *   • Development: loads http://localhost:3000/agency/login (Next.js dev server)
 *   • Production:  loads /agency/login on the deployed web URL or the bundled
 *                  static files. Falls back to an offline page when unreachable.
 *
 * Features:
 *   - Deep link protocol registration (blasti://)
 *   - System tray with minimize-to-tray on close
 *   - Native OS notifications
 *   - Dock/taskbar badge counts
 *   - Content Security Policy headers
 *   - Single-instance lock
 *   - Auto-update support (via electron-updater, optional)
 */

const {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  Notification,
  net,
  Tray,
  Menu,
  session,
  dialog,
} = require('electron');
const path = require('path');
const fs = require('fs');

// ─── Persistent File Logger (Task 49) ────────────────────────────────────────
// Mirrors every console line into <userData>/logs/main.log so startup failures
// on end-user machines are ALWAYS diagnosable. The installed app once sat in
// Task Manager with no window and no visible error anywhere — from now on the
// reason is always in the log file (%APPDATA%\BLASTI\logs\main.log).
let logFilePath = null;
function initFileLogger() {
  if (logFilePath) return logFilePath;
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    logFilePath = path.join(dir, 'main.log');
    // Rotate: keep the log small (main.old.log = previous run's log)
    try {
      const st = fs.statSync(logFilePath);
      if (st.size > 2 * 1024 * 1024) {
        fs.renameSync(logFilePath, path.join(dir, 'main.old.log'));
      }
    } catch { /* first run — nothing to rotate */ }
    fs.appendFileSync(
      logFilePath,
      `\n===== LAUNCH ${new Date().toISOString()} — v${app.getVersion()} (${app.isPackaged ? 'packaged' : 'dev'}, electron ${process.versions.electron}) =====\n`
    );
    return logFilePath;
  } catch { return null; }
}
initFileLogger();
// logs-1 — main-process RING BUFFER: the last 300 console lines stay in
// memory so the renderer's remote logger (lib/remote-logger.ts) can merge
// them into every desktop upload — Electron-only failures (updater waiter,
// local API, installer) land in the SAME per-UID vault as the UI logs.
const _mainLogRing = [];
function pushMainLog(level, line) {
  try {
    _mainLogRing.push(`[${new Date().toISOString()}] [${level}] ${line}`);
    if (_mainLogRing.length > 300) _mainLogRing.splice(0, _mainLogRing.length - 300);
  } catch { /* never let logging break the app */ }
}
(function mirrorConsoleToFile() {
  const fmt = (a) => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack || a.message;
    try { return JSON.stringify(a); } catch { return String(a); }
  };
  for (const level of ['log', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      try {
        const line = args.map(fmt).join(' ');
        pushMainLog(level, line);
        const file = logFilePath || initFileLogger();
        if (file) fs.appendFileSync(file, `[${new Date().toISOString()}] [${level}] ${line}\n`);
      } catch { /* never let logging break the app */ }
    };
  }
})();

// ─── .env loading (MUST run before anything reads BLASTI_* variables) ──────
// Electron does not read .env files, and OS env vars from the BUILD machine
// do not travel into the packaged installer. loadDesktopEnv() fills
// process.env from (first match wins, OS environment always overrides):
//   1. <resources>\.env   packaged only — editable AFTER install (no rebuild)
//   2. apps/desktop/.env  dev directory; baked into app.asar when packaged
// See load-env.js for the full contract. Without this, the ".env" workflow
// documented in .env.example silently did nothing (cloud URL stayed at the
// http://localhost:3003 default on every installed machine).
// Task 65: remember whether the OS environment ALREADY carried a cloud URL
// BEFORE any .env file is applied — used below to label the source of the
// effective Cloud API URL in the startup banner. (Snapshot FIRST: after the
// loader runs, a .env-filled value is indistinguishable from an OS one.)
const OS_HAD_CLOUD_URL = !!(process.env.BLASTI_CLOUD_URL || process.env.BLASTI_API_URL);
const DESKTOP_ENV_LOAD = require('./load-env').loadDesktopEnv({ isPackaged: app.isPackaged });

// ─── Monorepo Module Resolution ────────────────────────────────────────────
// In bun workspaces, packages are hoisted to the root node_modules.
// Electron uses Node.js require() which may not follow bun's symlink structure.
// Set NODE_PATH to include the monorepo root's node_modules so Electron can
// find hoisted dependencies like @prisma/client, hono, etc.
const MONOREPO_ROOT = path.resolve(__dirname, '../..');
const rootModules = path.join(MONOREPO_ROOT, 'node_modules');

// Build NODE_PATH with all possible module locations
const nodePaths = [
  rootModules,
  // Include the Prisma generated client output dir (avoids bun symlink issues)
  path.join(MONOREPO_ROOT, 'node_modules', '.prisma', 'client'),
];

// Add bun's internal hoisting directory — scan for ALL cached packages
const bunModules = path.join(MONOREPO_ROOT, 'node_modules/.bun');
if (fs.existsSync(bunModules)) {
  try {
    const bunDirs = fs.readdirSync(bunModules);
    for (const dir of bunDirs) {
      // Each bun package is at node_modules/.bun/<pkg-name>@<hash>/node_modules/
      // We want to add ALL of these to NODE_PATH so require() can find them
      const pkgModulesPath = path.join(bunModules, dir, 'node_modules');
      if (fs.existsSync(pkgModulesPath)) {
        nodePaths.push(pkgModulesPath);
      }
    }
    console.log(`[BLASTI Desktop] Added ${nodePaths.length - 1} bun module paths to NODE_PATH`);
  } catch { /* ignore */ }
}

// Set NODE_PATH and reinitialize module resolution
process.env.NODE_PATH = nodePaths.join(path.delimiter);
// Node.js caches NODE_PATH at startup — _initPaths() reloads it
require('module')._initPaths();

// ─── Environment Detection ────────────────────────────────────────────────────
// Bun workspaces pass ELECTRON_DEV=1 via the dev script.
// Also check NODE_ENV, --dev flag, or electron-is-dev package.

const isDev =
  process.env.NODE_ENV === 'development' ||
  !!process.env.ELECTRON_DEV ||
  (process.argv && process.argv.includes('--dev')) ||
  // Task 55: electron-is-dev ≥3 is ESM-only. Under Electron 42 (Node ≥22,
  // where require(esm) is enabled by default) require('electron-is-dev')
  // returns the module NAMESPACE object (null prototype) instead of
  // throwing. That object is truthy, poisoned this `||` chain in every
  // PACKAGED build, and templating `${isDev}` then threw
  // "Cannot convert object to primitive value" — killing the whenReady
  // chain before the window could open (the root cause of the
  // "running in Task Manager but never opens" bug). Dev runs never hit it
  // because ELECTRON_DEV/NODE_ENV short-circuit the chain earlier.
  // electron-is-dev is literally just `!app.isPackaged` — use the native.
  !app.isPackaged;

// ─── LAN mode default (kiosk/desktop discovery on the local network) ────────
// The embedded local API binds 127.0.0.1 by default, which made kiosks and
// TV boards on the office Wi-Fi unable to discover or pair with the desktop
// ("desktop app could not discover kiosk devices"). In PACKAGED builds LAN
// mode is ON by default: the local API binds 0.0.0.0, CORS accepts private
// http origins and the UDP discovery beacon runs (local-api/index.js +
// local-api/lib/lan-origin.js). Dev runs stay loopback-only unless the
// operator opts in with BLASTI_ENABLE_LAN=1 / BLASTI_LAN_BIND=lan.
// Explicit env always wins over the default.
if (!process.env.BLASTI_ENABLE_LAN && !process.env.BLASTI_LAN_BIND) {
  if (!isDev) {
    process.env.BLASTI_ENABLE_LAN = '1';
    console.log('[BLASTI Desktop] LAN mode enabled by default (packaged build) — local API is discoverable on the LAN');
  } else {
    console.log('[BLASTI Desktop] LAN mode off in dev (set BLASTI_ENABLE_LAN=1 to enable kiosk discovery)');
  }
}

// ─── Authoritative Local Database Path (single source of truth) ───────────
// ═══════════════════════════════════════════════════════════════════════════
// EXACTLY ONE local database location exists:
//     <app.getPath('userData')>/blasti-local/local.db
// i.e. %APPDATA%/@blasti/desktop/blasti-local/local.db on Windows.
//
// This MUST be set BEFORE any module under ./local-api is required —
// historically lib/db.js computed its own path (~/.blasti/local) at module
// load while the loading screen set a different one (userData/blasti-local),
// producing two divergent databases depending on require order. lib/db.js
// also self-heals: if the env arrives after client creation it rebinds
// (reconcileClientWithEnv) and migrates any legacy DB (copy + verify).
function setAuthoritativeDbPath() {
  const dbDir = path.join(app.getPath('userData'), 'blasti-local');
  if (!process.env.BLASTI_LOCAL_DB_DIR) {
    process.env.BLASTI_LOCAL_DB_DIR = dbDir;
    console.log('[BLASTI Desktop] Authoritative local DB dir:', dbDir);
  } else if (path.resolve(process.env.BLASTI_LOCAL_DB_DIR) !== path.resolve(dbDir)) {
    console.warn('[BLASTI Desktop] BLASTI_LOCAL_DB_DIR override in effect:', process.env.BLASTI_LOCAL_DB_DIR);
  }
}
try {
  // userData is resolvable at module scope in the Electron main process.
  setAuthoritativeDbPath();
} catch (err) {
  console.warn('[BLASTI Desktop] Could not resolve userData yet — will set when app is ready:', err.message);
}

// ─── Parent-Process Identity (Task 2-b, sub-task 5) ──────────────────────
// Exported for the embedded local API: the module can verify its host is
// alive and self-terminate if it is ever moved OUT of the Electron process
// (a future child-process spawn layout). In the current in-process layout
// the check is a no-op (the parent IS this process) — see the
// BLASTI_LOCAL_API_CHILD watchdog in local-api/index.js.
try { process.env.BLASTI_PARENT_PID = String(process.pid); } catch { /* ignore */ }

// ─── Local FILE store dir (Round 15) ─────────────────────────────────────
// Uploads (avatars, logos, receipts, documents, …) are stored LOCALLY FIRST
// in an organized layout (<bucket>/<yyyy>/<mm>/…) under the Electron
// userData dir — sibling of the local DB — and mirrored to the cloud by the
// file-sync worker (local-api/lib/file-sync.js). Set BEFORE any local-api
// module loads, same contract as BLASTI_LOCAL_DB_DIR.
function setAuthoritativeFilesDir() {
  const filesDir = path.join(app.getPath('userData'), 'blasti-files');
  if (!process.env.BLASTI_LOCAL_FILES_DIR) {
    process.env.BLASTI_LOCAL_FILES_DIR = filesDir;
    console.log('[BLASTI Desktop] Local file store dir:', filesDir);
  } else if (path.resolve(process.env.BLASTI_LOCAL_FILES_DIR) !== path.resolve(filesDir)) {
    console.warn('[BLASTI Desktop] BLASTI_LOCAL_FILES_DIR override in effect:', process.env.BLASTI_LOCAL_FILES_DIR);
  }
}
try {
  setAuthoritativeFilesDir();
} catch (err) {
  console.warn('[BLASTI Desktop] Could not resolve userData for the file store yet — will set when app is ready:', err.message);
}

// ─── Cloud API Base URL (single source of truth) ────────────────────────────
// One resolution used by diagnostics, sync service, local API fallbacks and
// the web shell. Precedence: BLASTI_CLOUD_URL > BLASTI_API_URL > default.
// Self-hosted (VPS) deployments: set BLASTI_CLOUD_URL to the origin that
// serves the Hono API (apps/api, port 3003) — e.g. https://api.your-domain.tld
// — unless the API is served under the same hostname via reverse proxy
// (spec §13).
//
// Task 74 — field report: a packaged build produced on a fresh machine (no
// apps/desktop/.env — it is gitignored — and no OS variable) kept the DEV
// fallback http://localhost:3003 → the cloud probe failed → the launch gate
// blocked with the misleading "first setup needs an internet connection"
// error even though the PC was online. The full resolution order is now:
//   1. OS environment  (BLASTI_CLOUD_URL / BLASTI_API_URL)
//   2. .env files      (load-env.js: resources\.env > apps/desktop/.env)
//   3. build-stamp.json cloudBaseUrl — baked at BUILD time by scripts/prebuild.js
//   4. packaged production fallback (the VPS the release APK is locked to)
//   5. dev fallback localhost:3003   (dev runs only — never packaged apps)
const DEV_CLOUD_FALLBACK = 'http://localhost:3003';
// Same server as apps/mobile/.env.production. Used ONLY when a PACKAGED build
// finds no configuration anywhere. To repoint an installed app without
// rebuilding, create <install>\resources\.env with BLASTI_CLOUD_URL="…".
const PRODUCTION_CLOUD_FALLBACK = 'http://129.151.242.219';

/** The cloudBaseUrl baked by scripts/prebuild.js into build-stamp.json, if any. */
function readBuildStampCloudUrl() {
  try {
    const stamp = require('./build-stamp.json');
    const url = stamp && typeof stamp.cloudBaseUrl === 'string' ? stamp.cloudBaseUrl : '';
    return /^https?:\/\//i.test(url) ? url.replace(/\/+$/, '') : null;
  } catch { return null; } // no stamp (dev) / unreadable / field absent
}

function resolveCloudBaseUrl() {
  const strip = (u) => String(u || '').replace(/\/+$/, '');
  const key = process.env.BLASTI_CLOUD_URL ? 'BLASTI_CLOUD_URL'
    : (process.env.BLASTI_API_URL ? 'BLASTI_API_URL' : '');
  const raw = key ? process.env[key] : '';
  const base = strip(raw);
  // Task 65 — field report: BLASTI_CLOUD_URL="http://203.0.113.10/api" made
  // diagnostics probe http://…/api/api/health → 404 → "cloud unreachable"
  // → first-run initial sync FATAL. BLASTI always appends /api/* itself
  // (login proxy, sync, realtime and diagnostics all do base + '/api/…'),
  // and the Caddy site serves /api/* at the ORIGIN root, so the value must
  // be the bare origin. Auto-correct this exact mistake and say so loudly.
  if (/\/api$/i.test(base)) {
    const fixed = strip(base.replace(/\/api$/i, ''));
    if (/^https?:\/\//i.test(fixed) && fixed.length > 'http://x'.length) {
      console.warn('[BLASTI Desktop] ' + key + '="' + raw + '" ends with "/api" — auto-corrected to "' + fixed + '"');
      console.warn('[BLASTI Desktop] BLASTI_CLOUD_URL must be the server ORIGIN only (no path) — the app appends /api/* itself.');
      return fixed;
    }
  }
  if (base) return base;
  if (app.isPackaged) {
    // A packaged app must NEVER fall back to the dev-only localhost:3003 —
    // nothing listens there on an end-user machine (Task 74).
    const stamped = readBuildStampCloudUrl();
    if (stamped) return stamped;
    return PRODUCTION_CLOUD_FALLBACK;
  }
  return DEV_CLOUD_FALLBACK;
}
const CLOUD_BASE_URL = resolveCloudBaseUrl();
// Publish for every other module (local API initial-sync route, sync service,
// loading-screen fallbacks) so they can never resolve a different origin.
process.env.BLASTI_CLOUD_URL = CLOUD_BASE_URL;

// Task 65: make the effective cloud URL IMPOSSIBLE to miss at startup.
// The #1 misconfiguration report is "the desktop app is not using my VPS" —
// this banner is the authoritative answer, printed once, in plain sight
// (also mirrored into main.log by the console-mirror above).
const cloudUrlSource = (() => {
  if (OS_HAD_CLOUD_URL) return 'OS environment variable';
  const provider = ((DESKTOP_ENV_LOAD && DESKTOP_ENV_LOAD.loaded) || []).find(
    (l) => l && ((l.filled || []).includes('BLASTI_CLOUD_URL') || (l.filled || []).includes('BLASTI_API_URL'))
  );
  if (provider) return provider.file;
  if (app.isPackaged) {
    // Task 74: packaged builds are never "unconfigured" — the stamp or the
    // production fallback below always applies.
    if (readBuildStampCloudUrl()) return 'baked at build time (build-stamp.json)';
    return 'packaged production default (VPS)';
  }
  return null; // dev run with no configuration — localhost:3003 default
})();
if (cloudUrlSource) {
  console.log('[BLASTI Desktop] Cloud API → ' + CLOUD_BASE_URL + '  [source: ' + cloudUrlSource + ']');
  if (cloudUrlSource === 'packaged production default (VPS)') {
    console.warn('[BLASTI Desktop] No cloud URL was configured on the build machine or at runtime —');
    console.warn('[BLASTI Desktop] using the built-in production VPS. To override, set BLASTI_CLOUD_URL');
    console.warn('[BLASTI Desktop] in <install>\\resources\\.env and restart (no rebuild needed).');
  }
} else {
  console.warn('[BLASTI Desktop] Cloud API → ' + CLOUD_BASE_URL + '  [source: built-in default — NO cloud URL configured]');
  console.warn('[BLASTI Desktop] Login, sync and realtime will target ' + CLOUD_BASE_URL + '.');
  console.warn('[BLASTI Desktop] To use your VPS instead, set one of (first that exists wins):');
  console.warn('[BLASTI Desktop]   1. OS environment variable  BLASTI_CLOUD_URL="https://your-vps-domain"');
  console.warn('[BLASTI Desktop]   2. apps/desktop/.env        BLASTI_CLOUD_URL="https://your-vps-domain"');
  console.warn('[BLASTI Desktop]   3. project root .env        BLASTI_CLOUD_URL="https://your-vps-domain"  (BLASTI_* keys only)');
  console.warn('[BLASTI Desktop] Then restart the app. See apps/desktop/.env.example and DEPLOY-GUIDE.md.');
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEV_URL = 'http://localhost:3000';
// Task 58: the packaged UI is served by the EMBEDDED local API from the
// bundled static export (app.asar/out). Two broken ideas are now dead:
//   - loading http://localhost:3000 when packaged (no dev server exists on
//     the user's machine → the window sat on a blue screen forever), and
//   - file:// loading of out/index.html (Next's absolute /_next/* asset
//     paths resolve against the filesystem root → blank shell).
// The local API (already running on :3080 before the window loads) serves
// every asset over http instead. NOTE: BLASTI_API_URL is the CLOUD base url
// (see resolveCloudBaseUrl) — it must never be the window URL.
const PROD_URL = 'http://127.0.0.1:3080/';
const PROTOCOL = 'blasti';

// Path to bundled static web files (from Next.js export)
const STATIC_WEB_DIR = path.join(__dirname, 'out');

// ─── Start Page ───────────────────────────────────────────────────────────────
// The desktop console is agency-only: it must ALWAYS open on the agency
// sign-in screen (/agency/login — the dedicated addressable route). The
// consumer marketing landing page is the SPA root '/' and belongs to the web
// app only; the desktop app must never boot onto it.
const START_PATH = '/agency/login';

/** Join START_PATH onto a base origin (tolerates trailing slashes). */
function withStartPath(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '') + START_PATH;
}

/**
 * The bundled static export's copy of the agency login page, if packaged.
 * Next.js writes page-style files (agency/login.html) when trailingSlash is
 * off and directory-style (agency/login/index.html) when on — accept both.
 * Returns null when the bundled export predates the route.
 */
function bundledLoginFile() {
  const candidates = [
    path.join(STATIC_WEB_DIR, 'agency', 'login.html'),
    path.join(STATIC_WEB_DIR, 'agency', 'login', 'index.html'),
  ];
  for (const candidate of candidates) {
    try { if (fs.existsSync(candidate)) return candidate; } catch { /* ignore */ }
  }
  return null;
}

// Task 49: asset resolution that works BOTH in dev and in the packaged app.
// electron-builder ships `assets/` via extraResources (outside the asar), so
// __dirname-based paths point into app.asar and never exist once installed.
function getAssetPath(...segments) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'assets', ...segments);
  }
  return path.join(__dirname, 'assets', ...segments);
}

// Keep global references to prevent garbage collection
let mainWindow = null;
let tray = null;
let isQuitting = false;

// ─── Global Error Handling (Task 49 hardening) ───────────────────────────────
// Prevent silent crashes — log all unhandled errors to the file log, and when
// no window is visible yet, SURFACE the error in a dialog. The old behavior
// (console-only, keep process alive) is exactly how "BLASTI sits in Task
// Manager but never opens a window" could happen without any visible clue.
let _fatalBoxAt = 0;
function showFatalErrorBox(title, message) {
  try {
    const now = Date.now();
    if (now - _fatalBoxAt < 15000) return; // rate-limit: max one box per 15s
    _fatalBoxAt = now;
    const file = logFilePath || initFileLogger();
    dialog.showErrorBox(
      title,
      message +
        '\n\nTechnical details were written to:\n' +
        (file || path.join(app.getPath('userData'), 'logs', 'main.log'))
    );
  } catch { /* never throw from the fatal-error path */ }
}

process.on('uncaughtException', (err) => {
  console.error('[BLASTI Desktop] UNCAUGHT EXCEPTION:', err && (err.stack || err.message) || err);
  requestRendererLogFlush(); // STRICT LOGS (0.6.30): main errors reach the vault in seconds
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) {
    showFatalErrorBox(
      'BLASTI — error',
      'The BLASTI process hit an unexpected error before the window opened:\n\n' +
        ((err && (err.message || String(err))) || 'unknown')
    );
  }
});

process.on('unhandledRejection', (reason) => {
  console.error('[BLASTI Desktop] UNHANDLED REJECTION:', reason && (reason.stack || reason.message) || reason);
  requestRendererLogFlush();
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) {
    showFatalErrorBox(
      'BLASTI — error',
      'A startup step failed before the window opened:\n\n' +
        ((reason && (reason.message || String(reason))) || 'unknown')
    );
  }
});

// ─── STRICT LOGS (0.6.30) — main→renderer flush request ────────────────────
// The remote logger lives in the renderer; when the MAIN process hits an
// error (uncaughtException / unhandledRejection / updater / installer) it
// pushes a flush request so the merged ring (which already carries the main
// lines) uploads within seconds instead of the next 30 s tick.
let lastFlushRequestAt = 0;
function requestRendererLogFlush() {
  // Throttle: main errors can burst — one flush request per 10 s is plenty.
  const now = Date.now();
  if (now - lastFlushRequestAt < 10_000) return;
  lastFlushRequestAt = now;
  for (const win of BrowserWindow.getAllWindows()) {
    try { if (!win.isDestroyed()) win.webContents.send('logs:flush-requested'); } catch { /* window gone */ }
  }
}

// Task 2-b (sub-task 5): SIGINT/SIGTERM must run the SAME embedded-service
// teardown as a UI quit — a terminal Ctrl+C (dev) or a process-manager stop
// used to leave the :3080 server + timers to the OS's mercy.
for (const _sig of ['SIGINT', 'SIGTERM']) {
  process.on(_sig, () => {
    console.log('[BLASTI Desktop] Received ' + _sig + ' — shutting down embedded services');
    shutdownEmbeddedServices('signal:' + _sig);
    killBlastiChildProcessTree();
    try { app.quit(); } catch { process.exit(0); }
    // Hard backstop if Electron refuses to exit promptly.
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

// ─── Session Purge (Task 2-b, sub-task 3) ─────────────────────────────────────
// The durable session file (userData/blasti-auth.json) exists ONLY for
// remember-me logins. The renderer reports the decision with
// cloud-sync:set-auth { rememberMe }:
//   rememberMe=true  → file persisted (historic behavior).
//   rememberMe=false → file DELETED + _ephemeralSessionActive=true so the
//                      before-quit purge deletes it again even if an older
//                      remember-me login wrote it meanwhile. Closing and
//                      re-opening the app then always requires a fresh login.
let _ephemeralSessionActive = false;

function authFilePath() {
  try { return path.join(app.getPath('userData'), 'blasti-auth.json'); }
  catch { return null; }
}

/** Delete the durable session file (best-effort — never throws). */
function purgeDurableAuthFile(reason) {
  try {
    const p = authFilePath();
    if (p && fs.existsSync(p)) {
      fs.unlinkSync(p);
      console.log('[BLASTI Desktop] Durable session file removed (' + reason + '):', p);
    }
  } catch (err) {
    console.warn('[BLASTI Desktop] Could not remove the session file (' + reason + '):', err && err.message);
  }
}

// ─── Embedded Services Shutdown (Task 2-b, sub-task 5) ────────────────────────
// The local API (Hono on :3080), the realtime socket, the file-sync worker,
// the LAN beacon and the sync engine all run INSIDE this Electron main
// process — they die with the process ONLY if the process actually exits.
// Historically the app stayed alive after the window closed (hide-to-tray +
// the tray/LAN keep-alive in window-all-closed), so the local API kept
// serving after the user "closed the app". shutdownEmbeddedServices() is the
// ONE idempotent teardown called from EVERY exit path (before-quit, quit,
// window-all-closed, SIGINT/SIGTERM, uncaught fatal) — double quits are
// guarded by _embeddedShutdownDone.
let _embeddedShutdownDone = false;

function shutdownEmbeddedServices(reason) {
  if (_embeddedShutdownDone) return;
  _embeddedShutdownDone = true;
  console.log('[BLASTI Desktop] Shutting down embedded services (' + (reason || 'quit') + ')');

  // 1. Tell the renderer to purge non-persisted (non remember-me) session
  //    state while it can still run JS. Best-effort: the window may already
  //    be gone; the boot purge (auth-storage.enforcePersistencePolicyAtBoot)
  //    and the file purge below are the backstops.
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app:quitting', { reason: reason || 'quit' });
    }
  } catch { /* window gone */ }

  // 2. Stop the cloud sync engine (timers, socket, watchdog).
  try {
    const syncService = require('./local-api/sync-service');
    if (typeof syncService.stopSync === 'function') syncService.stopSync();
  } catch (err) {
    console.warn('[BLASTI Desktop] Sync engine stop failed (non-fatal):', err && err.message);
  }

  // 3. Stop the embedded local API: closes the realtime socket server, the
  //    HTTP server (:3080), the file-sync worker and disconnects the DB.
  try {
    const localApi = require('./local-api/index');
    if (typeof localApi.stopLocalApi === 'function') localApi.stopLocalApi();
  } catch (err) {
    console.warn('[BLASTI Desktop] Local API stop failed (non-fatal):', err && err.message);
  }

  // 4. LAN discovery beacon.
  try { stopLanBeacon(); } catch { /* not started */ }

  // 5. Purge non-persisted session material:
  //    - an ephemeral (non remember-me) login must never leave the durable
  //      auth file behind;
  //    - a remember-me login keeps its file BY DESIGN (that is the feature).
  if (_ephemeralSessionActive) {
    purgeDurableAuthFile('ephemeral session purge on shutdown');
  }

  console.log('[BLASTI Desktop] Embedded services stopped');
}

// Windows: belt-and-braces tree-kill for the (in-process) local API. Today
// the API shares this process, so the OS reaping this process kills it; if a
// future build spawns the API as a CHILD process, _blastiChildPids lets the
// same shutdown path taskkill the whole tree (/T) so nothing can outlive the
// app holding :3080.
const _blastiChildPids = [];
function registerBlastiChildPid(pid) {
  if (typeof pid === 'number' && pid > 0 && _blastiChildPids.indexOf(pid) === -1) {
    _blastiChildPids.push(pid);
  }
}
function killBlastiChildProcessTree() {
  if (process.platform !== 'win32') {
    for (const pid of _blastiChildPids) {
      try { process.kill(-pid); } catch { /* not a group leader / already gone */ }
    }
    return;
  }
  for (const pid of _blastiChildPids) {
    try {
      // /T = tree (children too), /F = force. taskkill is always on PATH.
      require('child_process').execSync('taskkill /PID ' + pid + ' /T /F', { stdio: 'ignore' });
      console.log('[BLASTI Desktop] taskkill tree for child pid', pid);
    } catch { /* already exited */ }
    // Task 2-b-1: taskkill needs the process name/enumeration to work; a child
    // spawned with { detached: true } became a PROCESS GROUP LEADER, and
    // process.kill(-pid) signals the whole group directly. Best-effort: if the
    // group is already gone (taskkill above succeeded) this throws and is
    // ignored — both paths together cover normal AND detached children.
    try { process.kill(-pid); } catch { /* not a group leader / already gone */ }
  }
}

// Task 2-b-1: absolute last-resort teardown hook. 'exit' fires on EVERY way
// the process can die (normal quit, process.exit, signal-after-teardown) —
// including the hard-quit backstop below — so the child-tree kill runs even
// on exit paths that bypass the Electron lifecycle events.
process.on('exit', () => {
  try { killBlastiChildProcessTree(); } catch { /* exit must never throw */ }
});

// ─── Process Keep-Alive ─────────────────────────────────────────────────────────
// Prevent premature exit when running through bun run --filter or other process managers.
// Without this, bun may consider the process "done" when the synchronous portion completes,
// even though the Electron event loop (timers, HTTP server, Socket.IO) should keep it alive.
// This timer is a safety net — it should never fire because Electron's own event loop
// keeps the process alive via the HTTP server (port 3080), Socket.IO, and discovery beacon.
const _keepAlive = setInterval(() => {
  // Intentionally empty — keeps the Node.js event loop alive as a safety net
}, 60000);
process.on('before-quit', () => clearInterval(_keepAlive));
process.on('exit', () => clearInterval(_keepAlive));

// ─── LAN Discovery Helpers ────────────────────────────────────────────────────

/**
 * Get the first non-internal IPv4 address of this machine.
 * Used by the UDP beacon and the /api/discover endpoint.
 */
function getLocalIP() {
  const os = require('os');
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // Skip internal and non-IPv4 addresses
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '0.0.0.0';
}

/**
 * Get a human-friendly display name for this machine.
 * Uses os.hostname() which returns the computer name on all platforms.
 * On Windows: "DESKTOP-ABC123" or a custom PC name.
 * On Mac: "Johns-MacBook-Pro.local".
 * On Linux: the configured hostname.
 *
 * Falls back to "BLASTI Desktop" if hostname is empty or generic.
 */
function getMachineDisplayName() {
  const os = require('os');
  let hostname = os.hostname();

  // Fallback if hostname is empty or just "localhost"
  if (!hostname || hostname === 'localhost' || hostname === '127.0.0.1') {
    hostname = 'BLASTI Desktop';
  }

  // Strip ".local" suffix on macOS for cleaner display
  if (hostname.endsWith('.local')) {
    hostname = hostname.slice(0, -6);
  }

  return hostname;
}

/**
 * Get the network interface name associated with the local IP.
 * E.g., "Wi-Fi", "Ethernet", "en0" — helps users identify which network.
 */
function getNetworkInterfaceName() {
  const os = require('os');
  const interfaces = os.networkInterfaces();
  const localIP = getLocalIP();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal && iface.address === localIP) {
        return name;
      }
    }
  }
  return null;
}

// ─── LAN Discovery Beacon (Task 2-b) ────────────────────────────────────────
// Broadcasts a small JSON payload every 3s on UDP :3081 (255.255.255.255 and
// each interface's subnet broadcast address):
//     { service:'blasti-local', name, hostname, lanIp, httpPort }
// The discovery scanner (apps/desktop/local-api/lib/discovery-scanner.js,
// phase 'beacon') consumes these and surfaces the machine as a high-
// confidence BLASTI device — this is what lets kiosk shells / other desktops
// find this machine without a port scan. Runs ONLY in LAN mode; every step
// is guarded so a UDP failure can never affect the app.
const BEACON_PORT = 3081;
const BEACON_INTERVAL_MS = 3000;
let beaconSocket = null;
let beaconInterval = null;

/** Build the beacon payload (mirrors the /api/discover beacon identity). */
function buildBeaconPayload() {
  // R-21F: merge the offline-authority fields (role/term/specScore/instance/
  // agency) so peer desktops can run the election off beacons alone. The
  // local-api's lan-authority module fills these once it boots; before that
  // (and on any error) the beacon stays exactly the historic identity payload.
  let extras = {};
  try { extras = require('./local-api/lib/lan-authority').publicBeaconExtras() || {}; } catch { extras = {}; }
  return JSON.stringify({
    service: 'blasti-local',
    name: getMachineDisplayName(),
    hostname: getMachineDisplayName(),
    lanIp: getLocalIP(),
    httpPort: 3080,
    ...extras,
  });
}

/** All broadcast addresses worth announcing on (subnets + global broadcast). */
function getBeaconBroadcastAddresses() {
  const targets = new Set(['255.255.255.255']);
  try {
    const os = require('os');
    const interfaces = os.networkInterfaces();
    for (const addrs of Object.values(interfaces)) {
      for (const iface of addrs || []) {
        if (iface.family !== 'IPv4' || iface.internal) continue;
        if (iface.broadcast) targets.add(iface.broadcast);
      }
    }
  } catch { /* global broadcast alone is fine */ }
  return Array.from(targets);
}

function startLanBeacon() {
  if (beaconSocket || beaconInterval) return; // already running
  let lanMode = false;
  try { lanMode = require('./local-api/lib/lan-origin').resolveLanBind().lan; } catch { lanMode = false; }
  if (!lanMode) {
    console.log('[BLASTI Desktop] Discovery beacon not started (loopback bind — kiosks cannot reach this host)');
    return;
  }
  try {
    const dgram = require('dgram');
    beaconSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    beaconSocket.on('error', () => { /* best-effort — keep broadcasting */ });
    beaconSocket.bind(() => {
      try { beaconSocket.setBroadcast(true); } catch { /* ignore */ }
    });
    beaconInterval = setInterval(() => {
      try {
        const payload = Buffer.from(buildBeaconPayload());
        for (const target of getBeaconBroadcastAddresses()) {
          try {
            beaconSocket.send(payload, 0, payload.length, BEACON_PORT, target, () => {});
          } catch { /* skip dead broadcast target */ }
        }
      } catch { /* non-fatal */ }
    }, BEACON_INTERVAL_MS);
    // Send one immediately so a fresh kiosk finds us within seconds.
    setImmediate(() => {
      try {
        const payload = Buffer.from(buildBeaconPayload());
        beaconSocket.send(payload, 0, payload.length, BEACON_PORT, '255.255.255.255', () => {});
      } catch { /* non-fatal */ }
    });
    console.log(`[BLASTI Desktop] LAN discovery beacon broadcasting on UDP :${BEACON_PORT} every ${BEACON_INTERVAL_MS / 1000}s`);
  } catch (err) {
    console.warn('[BLASTI Desktop] Discovery beacon unavailable (non-fatal):', err && err.message);
    stopLanBeacon();
  }
}

function stopLanBeacon() {
  if (beaconInterval) { clearInterval(beaconInterval); beaconInterval = null; }
  if (beaconSocket) {
    try { beaconSocket.close(); } catch { /* already closed */ }
    beaconSocket = null;
  }
}

// ─── Single Instance Lock ─────────────────────────────────────────────────────

// UPDATE-0.6.14 — update-waiter bail-out, BEFORE the single-instance lock.
// The in-app updater spawns a COPY of this executable as a detached "waiter"
// (`blasti.exe --blasti-update-waiter <oldPid> <installer> <appExe> <log>`)
// whose only job is to wait for THIS app to exit, run the NSIS installer
// silently, and relaunch the freshly installed build. The waiter must never
// touch the single-instance lock (the real app may still be running), never
// create windows, and never start the local API — it is pure Node scripting
// inside Electron: no cmd.exe, no PowerShell, nothing an antivirus can
// heuristically block between "app closed" and "installer ran".
const UPDATE_WAITER_ARGS = (() => {
  try {
    const idx = process.argv.indexOf('--blasti-update-waiter');
    if (idx === -1) return null;
    const rest = process.argv.slice(idx + 1);
    const [oldPid, installer, appExe, logFile] = rest;
    if (!installer || !appExe) return null;
    return {
      oldPid: parseInt(oldPid, 10) || 0,
      installer,
      appExe,
      logFile: logFile || '',
    };
  } catch { return null; }
})();

/**
 * UPDATE-0.6.14 — the waiter entry point, dispatched BEFORE the single-
 * instance lock / any window / the local API. Pure Node: wait for the app
 * process to exit → run the NSIS installer with /S → wait for the installer
 * → relaunch the app → log every step to install-log.txt (same file the
 * PowerShell leg used, so field diagnostics stay in one place).
 *
 * MUST live before (outside) the main-app `else` bail-out block — the waiter
 * branch never executes that block.
 */
function runUpdateWaiterMode(w) {
  const cp = require('child_process');
  const appendLog = (msg) => {
    console.log(`[BLASTI update-waiter] ${msg}`);
    if (!w.logFile) return;
    try { fs.appendFileSync(w.logFile, `['${new Date().toISOString()}'] ${msg}\n`); } catch { /* best effort */ }
  };
  appendLog(`waiter started (pid ${process.pid}) — waiting for app pid ${w.oldPid} to exit before running ${path.basename(w.installer)}`);

  const relaunch = () => {
    try {
      const c = cp.spawn(w.appExe, [], { detached: true, stdio: 'ignore', windowsHide: true });
      c.unref();
      appendLog('app relaunched');
    } catch (err) {
      appendLog('relaunch failed: ' + (err && err.message));
    }
    // Give the log a beat to flush, then leave (the waiter must not hold
    // anything open — the installer may still be finishing its cleanup).
    setTimeout(() => { try { app.exit(0); } catch { process.exit(0); } }, 300);
  };

  const runInstaller = () => {
    if (!fs.existsSync(w.installer)) {
      appendLog('installer file missing — nothing to do');
      setTimeout(() => { try { app.exit(1); } catch { process.exit(1); } }, 300);
      return;
    }
    appendLog('app exited — running installer /S');
    let child;
    try {
      child = cp.spawn(w.installer, ['/S'], { stdio: 'ignore', windowsHide: true });
    } catch (err) {
      appendLog('installer spawn failed: ' + (err && err.message));
      relaunch();
      return;
    }
    // Hard ceiling: a wedged installer must not keep the app closed forever —
    // after 20 minutes relaunch whatever is installed.
    const timer = setTimeout(() => {
      appendLog('installer timeout (20 min) — relaunching');
      relaunch();
    }, 20 * 60 * 1000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      appendLog(`installer finished (exit ${code === null || code === undefined ? 'n/a' : code})`);
      relaunch();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      appendLog('installer error: ' + (err && err.message));
      relaunch();
    });
  };

  // Poll for the old process to fully exit (releases every file lock), up to
  // 30s; proceed anyway afterwards — the NSIS script closes a still-running
  // app in silent mode on its own. `process.kill(pid, 0)` THROWS when the
  // process is gone, so "probe succeeded" ⇔ still alive.
  //
  // 0.6.38 FIELD FIX — the main pid vanishing is NOT the whole app: Electron
  // child processes (GPU / renderer / crashpad) can outlive it for seconds
  // while still holding locks on blasti.exe and app.asar. A silent NSIS run
  // started in that window fails instantly with NO error and the old version
  // stays installed (the "app closes → relaunches → still 0.6.x" loop). The
  // waiter now ALSO waits until the app exe OPENS FOR WRITING — the precise
  // pure-Node signal that every process using the image is really gone
  // (Windows refuses write access to a running image), capped at 10s.
  let waitedMs = 0;
  let exeWaitedMs = 0;
  const probe = () => {
    let alive = false;
    try { process.kill(w.oldPid, 0); alive = true; } catch { alive = false; }
    return alive;
  };
  const exeUnlocked = () => {
    try {
      const fd = fs.openSync(w.appExe, 'r+');
      fs.closeSync(fd);
      return true;
    } catch { return false; }
  };
  const pollLoop = () => {
    if (!probe()) {
      if (exeWaitedMs >= 10_000 || exeUnlocked()) {
        if (exeWaitedMs > 0) appendLog(`exe unlocked after ${exeWaitedMs}ms — every app process is gone`);
        runInstaller();
        return;
      }
      exeWaitedMs += 250;
      if (exeWaitedMs === 250) appendLog('app exited — waiting for the exe to unlock (all processes gone)…');
      setTimeout(pollLoop, 250);
      return;
    }
    if (waitedMs >= 30000) {
      appendLog('app still running after 30s — proceeding (NSIS closes it in silent mode)');
      runInstaller();
      return;
    }
    waitedMs += 500;
    setTimeout(pollLoop, 500);
  };
  if (w.oldPid > 0) pollLoop();
  else runInstaller();
}

if (UPDATE_WAITER_ARGS) {
  runUpdateWaiterMode(UPDATE_WAITER_ARGS);
} else {

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // Task 42: a second launch usually just means "the app is in the tray —
  // show its window" (the running instance restores its window through its
  // second-instance handler and this process quits silently). BUT when the
  // ALREADY-RUNNING instance is an OLDER BUILD (e.g. left in the tray across
  // an app update), silently quitting makes the user believe they just
  // launched the NEW build while they keep testing the OLD one — the exact
  // "rebuilt but the old bug is still there" loop reported repeatedly for the
  // desktop branch list. Detect the running instance's build identity via its
  // local API health endpoint and warn LOUDLY when it is stale/old.
  // (Node http — Electron's net module is only usable after the ready event;
  // dialog.showErrorBox is explicitly safe before ready.)
  ;(async () => {
    // Task 49: the running instance's local API may still be STARTING (e.g. a
    // double-launch right after install) — probe up to 5 times before
    // concluding that the lock holder is a frozen/zombie process.
    const probeHealth = () => new Promise((resolve) => {
      try {
        const http = require('http');
        const req = http.get('http://127.0.0.1:3080/api/health', { timeout: 1500 }, (res) => {
          let body = '';
          res.on('data', (ch) => { body += ch.toString(); });
          res.on('end', () => {
            try {
              const j = JSON.parse(body);
              // mode:'local' is the cross-version BLASTI local-API fingerprint
              // (older builds return { status, mode, uptime, dbReady } with no
              // service/version — the absence of a version IS the staleness
              // signal, so resolve the parsed body whenever mode==='local').
              resolve(j && j.mode === 'local' ? j : null);
            } catch { resolve(null); }
          });
        });
        req.on('timeout', () => { try { req.destroy(); } catch { /* */ } resolve(null); });
        req.on('error', () => resolve(null));
      } catch { resolve(null); }
    });

    try {
      let running = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        running = await probeHealth();
        if (running) break;
        await new Promise((r) => setTimeout(r, 500));
      }

      const myVersion = app.getVersion();
      const runningVersion = running && typeof running.version === 'string' ? running.version : null;
      const compareVersions = (a, b) => {
        const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
        const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
          const d = (pa[i] || 0) - (pb[i] || 0);
          if (d !== 0) return d;
        }
        return 0;
      };
      const staleRunning = !!running && (!runningVersion || compareVersions(runningVersion, myVersion) < 0);

      if (staleRunning) {
        console.warn(`[BLASTI Desktop] Second launch aborted — an ${runningVersion ? 'OLDER (v' + runningVersion + ')' : 'STALE/UNIDENTIFIED'} BLASTI instance still owns the workspace (local API on :3080). The user must exit it fully (tray → Exit / Task Manager) before the new build can run.`);
        try {
          dialog.showErrorBox(
            'BLASTI — a previous instance is still running',
            'An older BLASTI instance is still running in the background and owns the local workspace, so the updated app cannot start.\n\n' +
              'Exit it completely: right-click the BLASTI icon in the system tray (near the clock) → Exit — or open Task Manager and end any running BLASTI process. Then launch the app again.\n\n' +
              '—\nنسخة قديمة من BLASTI لا تزال تعمل في الخلفية وتحجز مساحة العمل المحلية، لذا لا يمكن تشغيل النسخة المحدّثة.\n\n' +
              'أغلقها تمامًا: انقر بزر الفأرة الأيمن على أيقونة BLASTI بجوار الساعة → Exit، أو من مدير المهام أنهِ أي عملية BLASTI، ثم شغّل التطبيق من جديد.'
          );
        } catch { /* dialog unavailable — still quit below */ }
      } else if (!running) {
        // Task 49: the single-instance lock is taken but NO healthy BLASTI
        // local API answered after ~5 probes — a frozen/zombie BLASTI process
        // (hung before its API started) holds the lock. Quitting silently here
        // made the app appear as "running in Task Manager but never opens".
        console.warn('[BLASTI Desktop] Second launch aborted — the lock is held by a FROZEN instance (no healthy local API on :3080).');
        try {
          dialog.showErrorBox(
            'BLASTI — a frozen instance is blocking startup',
            'A BLASTI process is already running but is not responding, so a new window cannot open.\n\n' +
              'Fix: open Task Manager (Ctrl+Shift+Esc) → find every BLASTI process → End task for each one. Then launch BLASTI again.\n\n' +
              '—\nهناك عملية BLASTI مجمدة تعمل حاليًا وتمنع فتح نافذة جديدة.\n' +
              'الحل: افتح مدير المهام (Ctrl+Shift+Esc) → ابحث عن كل عمليات BLASTI → اختر End task لكل منها، ثم شغّل BLASTI من جديد.'
          );
        } catch { /* dialog unavailable — still quit below */ }
      } else {
        console.log('[BLASTI Desktop] Second instance detected — the running instance will show its window (running identity: ' + (running ? (runningVersion ? 'v' + runningVersion : 'old-shape health') : 'not up yet') + ', this launcher: v' + myVersion + ')');
      }
    } finally {
      app.quit();
    }
  })();
} else {
  app.on('second-instance', (_event, commandLine) => {
    // Task 49: the window may be HIDDEN (close → tray) or MINIMIZED.
    // .focus() alone does NOT reveal a hidden window and .restore() alone does
    // not raise it — that combination made the app look like "running in Task
    // Manager but never opens". Always restore → show → focus; recreate the
    // window entirely if it no longer exists.
    if (!mainWindow || mainWindow.isDestroyed()) {
      try { createWindow(); } catch (err) {
        console.error('[BLASTI Desktop] Failed to recreate window on second-instance:', err && err.message);
      }
    } else {
      try {
        if (mainWindow.isMinimized()) mainWindow.restore();
        if (!mainWindow.isVisible()) mainWindow.show();
        mainWindow.focus();
      } catch (err) {
        console.warn('[BLASTI Desktop] Could not reveal window on second-instance:', err && err.message);
      }
    }

    // Parse deep link from second-instance command line
    const url = commandLine.find((arg) => arg.startsWith(`${PROTOCOL}://`));
    if (url && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('deep-link', url);
    }
  });
}

// ─── Offline HTML Fallback ────────────────────────────────────────────────────

const OFFLINE_HTML = `<!DOCTYPE html>
<html lang="en" dir="rtl">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>BLASTI — غير متصل</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans Arabic', Roboto, sans-serif;
      background: #f9fafb;
      color: #374151;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 2rem;
      direction: rtl;
    }
    .container { text-align: center; max-width: 420px; }
    .icon { font-size: 4rem; margin-bottom: 1rem; }
    h1 { font-size: 1.5rem; font-weight: 700; margin-bottom: 0.5rem; color: #111827; }
    p { font-size: 0.95rem; line-height: 1.6; color: #6b7280; margin-bottom: 1.5rem; }
    .url { font-size: 0.8rem; color: #9ca3af; word-break: break-all; margin-bottom: 1.5rem; direction: ltr; }
    button {
      background: #48C9B0;
      color: #fff;
      border: none;
      padding: 0.65rem 1.5rem;
      border-radius: 8px;
      font-size: 0.95rem;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s;
    }
    button:hover { background: #3bae99; }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">📡</div>
    <h1>غير متصل بالإنترنت</h1>
    <p>لا يمكن الوصول إلى الخادم حالياً. يرجى التحقق من اتصال الإنترنت والمحاولة مرة أخرى.</p>
    <div class="url" id="target-url"></div>
    <button onclick="retry()">إعادة المحاولة</button>
  </div>
  <script>
    // contextIsolation is true — use window.electronAPI exposed by preload
    const targetUrl = '${isDev ? DEV_URL : PROD_URL}';
    document.getElementById('target-url').textContent = targetUrl;
    function retry() {
      if (window.electronAPI && window.electronAPI.retryOffline) {
        window.electronAPI.retryOffline();
      } else {
        window.location.reload();
      }
    }
    // Auto-retry every 15 seconds
    setInterval(retry, 15000);
  </script>
</body>
</html>`;

// ─── Content Security Policy ──────────────────────────────────────────────────

function setCSP() {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    // Task 59: Electron applies onHeadersReceived CSP to data: URLs too.
    // The launch gate (and the offline/error pages) are first-party data:
    // pages that RELY on inline scripts — under the production CSP
    // (script-src 'self') Chromium silently refused to execute the whole
    // gate script, so the packaged app sat on the loading screen forever
    // (empirically proven: with CSP → no loading:ready; without → received).
    // data: pages here are always our own generated HTML — skip the CSP.
    if (details.url.startsWith('data:')) {
      return callback({ responseHeaders: details.responseHeaders });
    }
    const csp = [
      "default-src 'self'",
      // Allow scripts from self and eval (Next.js HMR in dev).
      // Task 59: 'unsafe-inline' is REQUIRED in production too — the Next.js
      // static export embeds its hydration payload as INLINE scripts
      // (self.__next_f.push(...) in out/index.html). Blocking them renders
      // the UI but it never becomes interactive. Static exports cannot use
      // nonce-based CSP (no server), so inline is unavoidable (same choice
      // Capacitor makes for the identical web build on mobile).
      isDev ? "script-src 'self' 'unsafe-eval' 'unsafe-inline'" : "script-src 'self' 'unsafe-inline'",
      // Allow styles from self and inline (needed for styled-components / Tailwind)
      "style-src 'self' 'unsafe-inline'",
      // Allow images from self, data URIs, and blob URIs — PLUS the http
      // origins that serve user-uploaded files:
      //   - the embedded local API (http://127.0.0.1:3080 and
      //     http://localhost:3080) serves uploaded avatars/logos in
      //     local-first mode (localizeFileUrl rewrites stored cloud URLs
      //     to these). Without them every uploaded profile image is
      //     CSP-blocked and the UI shows the generic placeholder forever.
      //   - localhost:3000/3003 cover dev-server and cloud-served files.
      "img-src 'self' data: blob: https: http://127.0.0.1:3080 http://localhost:3080 http://localhost:3000 http://localhost:3003 http://localhost:* http://127.0.0.1:*",
      // Allow fonts from self
      "font-src 'self' data:",
      // Allow connections to self, localhost (dev), 127.0.0.1 (local API),
      // LAN IPs (192.168.x, 10.x, 172.16-31.x), and the production API.
      // Using http: and ws: schemes to allow LAN discovery without listing every IP.
      isDev
        ? "connect-src 'self' http: https: ws: wss:"
        : "connect-src 'self' https: http: ws: wss:",
      // Allow media from self and blob URIs (for camera/audio features)
      "media-src 'self' blob:",
      // Block object/embed/applet
      "object-src 'none'",
    ].join('; ');

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });
}

// ─── Tray Setup ───────────────────────────────────────────────────────────────

function createTray() {
  // Task 49: resolve via getAssetPath — inside the installed app the tray icon
  // lives in <resources>/assets (extraResources), NOT inside app.asar.
  const iconPath = getAssetPath('tray-icon.png');
  console.log('[BLASTI Desktop] Tray icon path:', iconPath, fs.existsSync(iconPath) ? '(found)' : '(MISSING)');

  try {
    tray = new Tray(iconPath);
  } catch {
    // If the tray icon doesn't exist, we'll skip tray creation
    // The app will just close normally on window-all-closed
    tray = null;
    return;
  }

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'فتح BLASTI',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    { type: 'separator' },
    {
      label: 'خروج',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setToolTip('BLASTI - بلاصتي');
  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.focus();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    }
  });
}

// ─── Window Creation ──────────────────────────────────────────────────────────

// Flag to track whether diagnostics have completed and the main app should load
let diagnosticsDone = false;
let diagnosticsAllPassed = false; // true only when ALL checks passed (no errors, no warnings)
let loadingScreenActive = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'BLASTI - بلاصتي',
    backgroundColor: '#0a0f1a',
    // Always show immediately for loading screen
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // Needed for some IPC patterns
      // Task 65: hand the resolved CLOUD base URL to the renderer WITHOUT a
      // sync IPC roundtrip. The preload script parses this flag out of
      // process.argv and exposes it as window.electronAPI.cloudBaseUrl, so
      // the web bundle's few direct-cloud calls (session healing, browser
      // sync fallback) target the SAME server the main process uses.
      additionalArguments: ['--blasti-cloud-url=' + CLOUD_BASE_URL],
    },
  });

  // Show window immediately for loading screen
  mainWindow.show();
  mainWindow.focus();

  // ── Handle page load failures gracefully ────────────────────────────────
  // When loadURL fails (e.g. dev server not running), show an error page.
  // We use did-fail-load instead of .catch() because Electron destroys
  // the webContents before promise rejection fires in some cases.
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDesc, validatedURL) => {
    // Ignore subresource failures (images, scripts, etc.) — only handle main frame
    if (!event.isMainFrame()) return;
    // Ignore aborts (user navigation cancel) and -3 (aborted by loadURL override)
    if (errorCode === -3) return;
    // Ignore our own data: pages (loading screen, error pages)
    if (validatedURL.startsWith('data:')) return;

    // If loading screen is active, don't replace it with error page
    if (loadingScreenActive) return;

    console.warn('[BLASTI Desktop] Page load failed (' + errorCode + '): ' + validatedURL);

    // Show the window even though content failed
    if (!mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show();
      mainWindow.focus();
    }

    // Load error page
    const errorHTML = buildErrorPage(errorCode, errorDesc, validatedURL);
    mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(errorHTML));
  });

  // Load the loading screen first (not the web app yet)
  loadLoadingScreen();

  // Open DevTools in development mode
  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // Open external links in system browser (not in Electron window)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Handle navigation — prevent the app from navigating away from the web app
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowedOrigins = [
      'http://localhost:3000',
      // Task 58: the packaged UI origin is the embedded local API.
      'http://localhost:3080',
      'http://127.0.0.1:3080',
      PROD_URL,
    ];

    // Allow local file:// navigation (bundled static files)
    const isLocalFile = url.startsWith('file://');

    const isAllowed = isLocalFile || allowedOrigins.some(
      (origin) => url.startsWith(origin) || url.startsWith(`${origin}/`)
    );

    // Allow if it's within the app origins or local files
    if (isAllowed) {
      return;
    }

    // Allow same-origin hash navigation (e.g. http://localhost:3000/#/dashboard)
    const currentUrl = mainWindow.webContents.getURL();
    try {
      const currentOrigin = new URL(currentUrl).origin;
      const targetOrigin = new URL(url).origin;
      if (currentOrigin === targetOrigin) {
        return;
      }
    } catch { /* invalid URL, block it */ }

    // Block everything else
    event.preventDefault();
    shell.openExternal(url);
  });

  // R-36: Windows cold-start deep link — when the OS LAUNCHES the app BY a
  // blasti:// link (the desktop app was closed when the Chargily payment
  // bounce fired), the URL arrives in process.argv instead of a
  // second-instance/open-url event. Forward it to the renderer once the SPA
  // has actually loaded (one-shot — did-finish-load refires on reloads).
  let _coldStartDeepLinkSent = false;
  mainWindow.webContents.on('did-finish-load', () => {
    if (_coldStartDeepLinkSent) return;
    try {
      const deepUrl = (process.argv || []).find(
        (a) => typeof a === 'string' && a.startsWith(PROTOCOL + '://')
      );
      if (deepUrl) {
        _coldStartDeepLinkSent = true;
        console.log('[BLASTI Desktop] Cold-start deep link:', deepUrl);
        mainWindow.webContents.send('deep-link', deepUrl);
      }
    } catch (err) {
      console.warn('[BLASTI Desktop] Cold-start deep-link parse failed:', err && err.message);
    }
  });

  // ── Window Close → QUIT the app (Task 2-b, sub-task 5) ──────────────────
  // USER BUG FIXED: "desktop app keeps local api running even when the desktop
  // app is closed." The previous behavior hid the window to the tray and kept
  // the whole process — including the embedded local API on :3080, the sync
  // engine and the LAN beacon — running invisibly. Closing the window now
  // means closing the app: the full embedded-service shutdown runs and the
  // process exits. The tray icon remains available WHILE the app is running
  // (open / exit actions); closing the window is the documented exit gesture.
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      isQuitting = true;
      app.quit();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Broadcast maximize state changes to the renderer
  mainWindow.on('maximize', () => {
    mainWindow?.webContents.send('window:maximized-changed', true);
  });

  mainWindow.on('unmaximize', () => {
    mainWindow?.webContents.send('window:maximized-changed', false);
  });
}

/**
 * Load the app — with offline fallback.
 *
 * Strategy:
 *   Development: loads http://localhost:3000 (Next.js dev server)
 *   Production (bundled): loads from the `out/` directory (bundled static files)
 *   Production (remote): if BLASTI_REMOTE_URL is set, loads from remote URL instead
 *
 * When bundled static files exist, the app works fully offline.
 * API calls still go to the remote server (configured via BLASTI_API_URL).
 */
// ─── Error Page Builder ─────────────────────────────────────────────────────
// Generates a standalone HTML error page to display when URL loading fails.
function buildErrorPage(errorCode, errorDesc, url) {
  const title = isDev ? 'BLASTI Desktop — Development Mode' : 'BLASTI — Connection Error';
  const body = isDev
    ? '<p>The Next.js development server is not running.</p>' +
      '<p>Start it in a separate terminal:</p>' +
      '<code>bun run dev:web</code>' +
      '<p>Then click Retry or press F5 to reload.</p>'
    : '<p>Could not reach the server. Please check your connection and try again.</p>' +
      '<p>URL: <span style="color:#48C9B0;word-break:break-all">' + url + '</span></p>';

  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0"/>' +
    '<title>' + title + '</title>' +
    '<style>*{margin:0;padding:0;box-sizing:border-box}' +
    'body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;' +
    'background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;' +
    'min-height:100vh;padding:2rem}' +
    '.container{text-align:center;max-width:500px}' +
    '.icon{font-size:4rem;margin-bottom:1rem}' +
    'h1{font-size:1.5rem;font-weight:700;margin-bottom:.5rem;color:#f8fafc}' +
    'p{font-size:.95rem;line-height:1.7;color:#94a3b8;margin-bottom:1.5rem}' +
    'code{background:#1e293b;padding:.75rem 1rem;border-radius:8px;display:block;font-size:.9rem;' +
    'color:#48C9B0;margin-bottom:1.5rem;border:1px solid #334155}' +
    'button{background:#48C9B0;color:#fff;border:none;padding:.65rem 1.5rem;border-radius:8px;' +
    'font-size:.95rem;font-weight:600;cursor:pointer;margin:.25rem;transition:background .2s}' +
    'button:hover{background:#3bae99}' +
    'button.secondary{background:#334155}' +
    'button.secondary:hover{background:#475569}' +
    '</style></head><body><div class="container">' +
    '<div class="icon">\u{1F680}</div>' +
    '<h1>' + title + '</h1>' + body +
    '<button onclick="location.reload()">Retry</button>' +
    '<button class="secondary" onclick="window.close()">Close</button>' +
    '</div></body></html>';
}

function loadApp() {
  if (isDev) {
    // Development: probe localhost:3000 first to check if Next.js dev server is running.
    // If it's not running, immediately show an error page with instructions.
    // This avoids the hidden-window problem when loadURL silently fails.
    console.log('[BLASTI Desktop] Checking if dev server is running at ' + DEV_URL + '...');

    const probe = net.request(DEV_URL);
    let settled = false;

    const loadDevPage = () => {
      if (settled) return;
      settled = true;
      try { probe.abort(); } catch { /* ignore */ }
      console.log('[BLASTI Desktop] Loading ' + withStartPath(DEV_URL));
      mainWindow.loadURL(withStartPath(DEV_URL));
    };

    const showErrorPage = () => {
      if (settled) return;
      settled = true;
      try { probe.abort(); } catch { /* ignore */ }
      console.warn('[BLASTI Desktop] Dev server not running at ' + DEV_URL + ' — showing error page');
      const errorHTML = buildErrorPage(-102, 'ERR_CONNECTION_REFUSED', DEV_URL);
      mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(errorHTML)).catch(() => {
        // Last resort: show the window even with blank content
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show();
          mainWindow.focus();
        }
      });
    };

    // Quick timeout: 2 seconds is enough to detect connection refused
    const timeout = setTimeout(() => {
      console.warn('[BLASTI Desktop] Dev server probe timed out');
      showErrorPage();
    }, 2000);

    probe.on('response', () => {
      clearTimeout(timeout);
      loadDevPage();
    });

    probe.on('error', () => {
      clearTimeout(timeout);
      showErrorPage();
    });

    try { probe.end(); } catch { showErrorPage(); }
    return;
  }

  // Check if bundled static files exist
  const indexPath = path.join(STATIC_WEB_DIR, 'index.html');
  const hasBundledFiles = fs.existsSync(indexPath);

  // If BLASTI_REMOTE_URL is set, prefer remote loading
  const remoteUrl = process.env.BLASTI_REMOTE_URL;

  if (remoteUrl) {
    // Explicit remote URL mode — probe the START PAGE (agency login), not the
    // bare origin. If the deployed web build predates /agency/login (4xx/5xx),
    // open the remote origin itself instead of a dead 404 screen.
    const startUrl = withStartPath(remoteUrl);
    const request = net.request(startUrl);
    let settled = false;
    const fallback = () => {
      if (settled) return;
      settled = true;
      try { request.abort(); } catch { /* ignore */ }
      if (hasBundledFiles) {
        mainWindow.loadFile(bundledLoginFile() || indexPath);
      } else {
        mainWindow.loadURL(
          `data:text/html;charset=utf-8,${encodeURIComponent(OFFLINE_HTML)}`
        );
      }
    };
    // Electron's net.request does NOT have setTimeout — use a manual timer
    const timeout = setTimeout(fallback, 5000);
    request.on('response', (res) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      const status = (res && res.statusCode) || 0;
      if (status > 0 && status < 400) {
        mainWindow.loadURL(startUrl);
      } else {
        console.warn('[BLASTI Desktop] ' + startUrl + ' answered ' + status + ' — loading the remote origin instead');
        mainWindow.loadURL(remoteUrl);
      }
    });
    request.on('error', () => {
      clearTimeout(timeout);
      fallback();
    });
    try { request.end(); } catch { fallback(); }
    return;
  }

  // Default production: the embedded local API serves the bundled static
  // export over http (Task 58) — absolute /_next/* paths only work over an
  // http origin. loadFile() is now the last-ditch fallback only.
  if (hasBundledFiles) {
    // Open the agency login page. When the bundled export predates the
    // /agency/login route (loginFile === null), keep the legacy '/' behavior.
    const loginFile = bundledLoginFile();
    const startUrl = loginFile ? withStartPath(PROD_URL) : PROD_URL;
    console.log('[BLASTI Desktop] Bundled UI found — loading ' + startUrl);
    mainWindow.loadURL(startUrl).catch((loadErr) => {
      console.warn('[BLASTI Desktop] loadURL(' + startUrl + ') failed:', loadErr && loadErr.message, '— falling back to file://');
      mainWindow.loadFile(loginFile || indexPath).catch(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(OFFLINE_HTML));
        }
      });
    });
    return;
  }

  // Fallback: try remote URL
  const request = net.request(PROD_URL);
  let settled = false;
  const fallback = () => {
    if (settled) return;
    settled = true;
    try { request.abort(); } catch { /* ignore */ }
    mainWindow.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(OFFLINE_HTML)}`
    );
  };
  // Electron's net.request does NOT have setTimeout — use a manual timer
  const timeout = setTimeout(fallback, 5000);
  request.on('response', () => {
    clearTimeout(timeout);
    if (settled) return;
    settled = true;
    mainWindow.loadURL(PROD_URL);
  });
  request.on('error', () => {
    clearTimeout(timeout);
    fallback();
  });
  try { request.end(); } catch { fallback(); }
}

// ─── Loading Screen ───────────────────────────────────────────────────────────

// Track which launch gate is currently loaded in the window:
//   'dev'      → the full diagnostics console (DEV MODE ONLY)
//   'consumer' → the branded customer-facing splash (shown on EVERY launch;
//                in production it hosts the same diagnostics invisibly and
//                reveals an error panel ONLY when a fatal check fails)
let launchGateMode = 'dev';
let diagnosticsRunning = false;

/**
 * Build the launch gate HTML for the CURRENT run mode.
 * DEV:      the diagnostics console runs first (existing behavior).
 * PROD:     the consumer gate runs the diagnostics invisibly — errors are
 *           revealed only if they exist when the suite finishes; otherwise
 *           the user sees just the branded animation and a pass.
 */
function buildGateHTML() {
  const { getLoadingHTML, getConsumerGateHTML } = require('./loading-screen');
  if (isDev) {
    launchGateMode = 'dev';
    return getLoadingHTML();
  }
  launchGateMode = 'consumer';
  return getConsumerGateHTML({ mode: 'production' });
}

/**
 * Show the branded loading screen while diagnostics run.
 * This is the FIRST thing the user sees on app launch.
 */
function loadLoadingScreen() {
  loadingScreenActive = true;
  try {
    const html = buildGateHTML();
    mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    console.log(`[BLASTI Desktop] Launch gate displayed (mode: ${launchGateMode}${isDev ? ', dev' : ''})`);
  } catch (err) {
    console.error('[BLASTI Desktop] Failed to load loading screen:', err.message);
    // Fallback: just load the app directly
    loadingScreenActive = false;
    loadApp();
  }
}

/**
 * DEV-MODE HANDOFF: the dev gate passed → show the consumer gate as a pure
 * animation layer ("passing UI"), then load the app. No diagnostics UI here
 * — the dev gate already enforced every check; this is the same branded
 * splash production users see, so dev launches look like real launches.
 */
function showConsumerHandoff() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const { getConsumerGateHTML } = require('./loading-screen');
    launchGateMode = 'consumer';
    const html = getConsumerGateHTML({ mode: 'dev-handoff' });
    mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    console.log('[BLASTI Desktop] Dev gate passed — consumer gate animation (handoff)');
  } catch (err) {
    console.warn('[BLASTI Desktop] Consumer handoff failed — launching directly:', err.message);
    finishLoadingAndLoadApp();
    return;
  }
  // Main-driven load: the handoff gate is animation-only and never calls
  // finishLoading itself, so this timer is the single launch authority.
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      finishLoadingAndLoadApp();
    }
  }, 2000);
}

/**
 * Called when diagnostics are done (or user clicks "Launch" on error).
 * Dismisses the loading screen and loads the main web app.
 * Task 59: idempotent — the renderer (loading:finish) AND the main-process
 * fallback timer can both call this; only the first call may load the app.
 */
let appLoadStarted = false;
function finishLoadingAndLoadApp() {
  if (appLoadStarted) {
    console.log('[BLASTI Desktop] App load already started — ignoring duplicate launch trigger');
    return;
  }
  if (!mainWindow || mainWindow.isDestroyed()) return;
  appLoadStarted = true;
  loadingScreenActive = false;
  console.log('[BLASTI Desktop] Loading complete — loading main app');
  loadApp();
}

// Task 59: ready-signal latch — the gate script sends 'loading:ready' the
// moment it executes, often BEFORE runStartupDiagnostics registers its
// once() listener (the old code then sat through a pointless 5s timeout on
// every launch). Record the arrival at all times.
let gateReadyReceived = false;
ipcMain.on('loading:ready', () => { gateReadyReceived = true; });

/**
 * Run the startup diagnostics suite (the launch gate's engine).
 * Extracted from app.whenReady so the consumer gate's RETRY can re-run the
 * whole suite with fresh flags — a simple page reload could never do that.
 */
async function runStartupDiagnostics() {
  if (diagnosticsRunning) {
    console.warn('[BLASTI Desktop] Diagnostics already running — retry ignored');
    return;
  }
  diagnosticsRunning = true;
  try {
    // The gate renderer must register its IPC listeners before events flow.
    // Without this, early IPC events may fire before the renderer is ready.
    // Task 59: skip the wait entirely when the latch already caught the
    // signal (typical case — the gate executes its script within ms).
    if (!gateReadyReceived) {
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          console.warn('[BLASTI Desktop] Loading screen ready signal timed out — proceeding anyway');
          resolve();
        }, 5000);

        ipcMain.once('loading:ready', () => {
          clearTimeout(timeout);
          console.log('[BLASTI Desktop] Loading screen ready — starting diagnostics');
          resolve();
        });
      });
    } else {
      console.log('[BLASTI Desktop] Loading screen ready already received — starting diagnostics immediately');
    }

    const { runDiagnostics } = require('./loading-screen');
    const userDataPath = app.getPath('userData');
    const cloudBaseUrl = process.env.BLASTI_CLOUD_URL || CLOUD_BASE_URL;

    const diagResult = await runDiagnostics(mainWindow, {
      cloudBaseUrl,
      isDev: isDev,
      userDataPath,
    });

    console.log(`[Diagnostics] All checks done — allPassed: ${diagResult.allPassed}`);

    // Mark diagnostics complete. Allow launch if no errors (warnings are OK — they
    // represent expected skip conditions like no auth before first login).
    diagnosticsDone = true;
    const hasErrors = diagResult.results.some(r => r.status === 'error');
    diagnosticsAllPassed = !hasErrors;
    console.log(`[Diagnostics] allPassed: ${diagnosticsAllPassed} — ${diagResult.results.filter(r => r.status === 'success').length}/${diagResult.results.length} success, ${diagResult.results.filter(r => r.status === 'warning').length} warnings, ${diagResult.results.filter(r => r.status === 'error').length} errors`);

    // ── Task 33-C: AUTH-REJECTED routing (never downgraded, never a dead end) ──
    // A step failure carrying authRejected (the reachable cloud confirmed the
    // stored session is no longer authorized) is a FATAL verdict that is
    // never downgraded to a warning. But blocking the launch gate outright
    // would leave the user on a dead-end error panel with no way to sign in
    // again — the user requirement is a LOGIN SCREEN. When auth-rejection is
    // the ONLY fatal condition (no stale session was restored — it was
    // rejected and the workspace locked), send the auth:revoked IPC and load
    // the app: the renderer starts logged out and its auth-provider routes
    // to the login form. Any OTHER fatal error still blocks the gate below.
    const authRejectedErrors = (diagResult.results || []).filter(r =>
      r && r.status === 'error' &&
      (r.authRejected === true || (r.detail && (r.detail.authRejected === true || r.detail.code === 'AUTHORIZATION_REVOKED'))));
    const otherErrors = (diagResult.results || []).filter(r => r && r.status === 'error' && authRejectedErrors.indexOf(r) === -1);
    if (hasErrors && otherErrors.length === 0 && authRejectedErrors.length > 0) {
      console.warn('[Diagnostics] AUTH-REJECTED verdict — the stale session is blocked; routing to the login screen (auth:revoked IPC + app load) instead of a dead-end gate');
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          const firstDetail = authRejectedErrors[0] && authRejectedErrors[0].detail;
          mainWindow.webContents.send('auth:revoked', {
            reason: (firstDetail && firstDetail.reason) || 'token-rejected',
          });
        }
      } catch (_) { /* window gone */ }
      finishLoadingAndLoadApp();
      return; // finally below resets diagnosticsRunning
    }

    // ── Consumer gate outcome (production) ─────────────────────────────
    // The consumer gate shows NO diagnostics detail while running. Only the
    // END verdict reaches it: errors → compact error panel + blocked launch;
    // otherwise → success animation + auto-launch via loading:finish.
    if (launchGateMode === 'consumer' && mainWindow && !mainWindow.isDestroyed()) {
      if (hasErrors) {
        const errors = diagResult.results
          .filter(r => r.status === 'error')
          .map(r => ({ step: r.step, message: r.message || 'فشل غير معروف' }));
        console.warn(`[BLASTI Desktop] Consumer gate: ${errors.length} fatal error(s) — launch BLOCKED`);
        try {
          mainWindow.webContents.send('consumer-gate:error', { errors });
        } catch (_) { /* window gone */ }
      } else {
        console.log('[BLASTI Desktop] Consumer gate: all checks passed — showing pass animation');
        try {
          mainWindow.webContents.send('consumer-gate:success', {});
        } catch (_) { /* window gone */ }
        // Task 59: renderer-independent safety net. The gate script normally
        // plays the success animation and calls loading:finish — but a single
        // syntax error in the generated gate HTML once killed that whole
        // script (v0.3.3 shipped with `HINTSintIndex]`), leaving the user on
        // the gate FOREVER with a green checkmark. If the app has not loaded
        // 12s after the pass verdict, launch from the main process instead.
        // finishLoadingAndLoadApp is idempotent, so a healthy gate finishing
        // at ~2.5s makes this a no-op.
        setTimeout(() => {
          if (!diagnosticsDone || !diagnosticsAllPassed) return; // state changed (retry etc.)
          if (!mainWindow || mainWindow.isDestroyed()) return;
          console.warn('[BLASTI Desktop] Fallback: app not loaded 12s after pass verdict — launching from main process');
          finishLoadingAndLoadApp();
        }, 12000);
      }
    }
  } catch (err) {
    console.error('[Diagnostics] Failed to run diagnostics:', err.message);
    // Diagnostics themselves crashed — do NOT auto-launch.
    // The loading screen will show whatever steps completed. If the local API
    // step never reported a status, the user will see an incomplete set of
    // steps and can click "Launch" manually if they choose to proceed.
    diagnosticsDone = true;
    diagnosticsAllPassed = false; // crashed = not all passed
    if (launchGateMode === 'dev') {
      // Send the finalized event so the dev gate knows diagnostics are done
      // (even though some steps were skipped due to the crash).
      try {
        mainWindow.webContents.send('diagnostics:update', {
          step: 'local-server',
          status: 'error',
          message: `فشل تشغيل الفحوصات: ${err.message.substring(0, 80)}`,
        });
        mainWindow.webContents.send('diagnostics:finalized', {
          completedSteps: ['local-server', 'cloud-api'],
          totalSteps: 7,
        });
      } catch (_) { /* window may be gone */ }
    } else if (mainWindow && !mainWindow.isDestroyed()) {
      // Consumer gate: reveal the crash as the error it is — launch blocked.
      try {
        mainWindow.webContents.send('consumer-gate:error', {
          errors: [{ step: 'diagnostics', message: `فشل تشغيل الفحوصات: ${err.message.substring(0, 140)}` }],
        });
      } catch (_) { /* window may be gone */ }
    }
  } finally {
    diagnosticsRunning = false;
  }
}

// ─── IPC Handlers ─────────────────────────────────────────────────────────────

// Platform info
ipcMain.handle('get-platform', () => ({
  platform: process.platform,
  arch: process.arch,
  electronVersion: process.versions.electron,
  chromeVersion: process.versions.chrome,
  nodeVersion: process.versions.node,
}));

// logs-1 — renderer's remote logger merges these main-process lines into its
// periodic /api/logs uploads (see apps/web/src/lib/remote-logger.ts).
ipcMain.handle('get-recent-main-logs', () => _mainLogRing.slice(-120));

// ─── STRICT LOGS (0.6.30) — diagnostic tails for the remote-logger flush ────
// The local API's rolling diag file and the updater's install log hold most
// desktop failures — the renderer merges their tails into every flush so
// LAN-side errors and installer problems reach the SAME cloud vault.
ipcMain.handle('get-recent-diag-logs', () => {
  const out = { diag: [], install: [] };
  try {
    const diagFile = path.join(app.getPath('userData'), 'logs', 'local-api-diag.log');
    if (fs.existsSync(diagFile)) {
      const raw = fs.readFileSync(diagFile, 'utf8').split('\n');
      out.diag = raw.slice(-120);
    }
  } catch { /* diag log unreadable — skip */ }
  try {
    const installFile = path.join(UPDATES_DIR(), 'install-log.txt');
    if (fs.existsSync(installFile)) {
      const raw = fs.readFileSync(installFile, 'utf8').split('\n');
      out.install = raw.slice(-60);
    }
  } catch { /* install log unreadable — skip */ }
  return out;
});

// Loading screen: user clicked "Launch App" — only proceed if ALL checks passed
ipcMain.on('loading:finish', () => {
  if (diagnosticsDone && diagnosticsAllPassed) {
    if (isDev && launchGateMode === 'dev') {
      // DEV LAYERING: dev gate passed → show the consumer gate as animation
      // only, then load the app (same launch experience as production).
      showConsumerHandoff();
    } else {
      finishLoadingAndLoadApp();
    }
  } else if (diagnosticsDone && !diagnosticsAllPassed) {
    console.warn('[BLASTI Desktop] Launch blocked — not all diagnostics passed');
  }
});

// Consumer gate error panel: full retry — reload the gate and re-run the
// ENTIRE diagnostics suite with fresh flags (not just a page reload, which
// could never re-run main-process diagnostics).
ipcMain.on('loading:retry', () => {
  if (diagnosticsRunning) {
    console.warn('[BLASTI Desktop] Retry ignored — diagnostics already running');
    return;
  }
  if (!diagnosticsDone) {
    console.warn('[BLASTI Desktop] Retry ignored — diagnostics not finished yet');
    return;
  }
  diagnosticsDone = false;
  diagnosticsAllPassed = false;
  appLoadStarted = false; // Task 59: allow a fresh launch after a retry
  console.log('[BLASTI Desktop] Launch retry requested — reloading gate and re-running diagnostics');
  loadLoadingScreen();
  runStartupDiagnostics().catch((err) => {
    console.error('[BLASTI Desktop] Retry diagnostics crashed:', err.message);
  });
});

// Window controls
ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:maximize', () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow?.maximize();
  }
});
ipcMain.on('window:close', () => {
  // Task 2-b (sub-task 5): the renderer's close affordance now performs a
  // REAL quit — the embedded local API must die with the app (same policy as
  // the titlebar X button in createWindow).
  isQuitting = true;
  app.quit();
});
ipcMain.handle('window:is-maximized', () => mainWindow?.isMaximized() ?? false);

// App quit
ipcMain.on('app:quit', () => {
  isQuitting = true;
  app.quit();
});

// Notifications
ipcMain.on('notification:send', (_event, { title, body }) => {
  if (Notification.isSupported()) {
    const notification = new Notification({
      title,
      body,
      icon: getAssetPath('icon.png'),
    });

    notification.on('click', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
      mainWindow?.webContents.send('notification:clicked', { title, body });
    });

    notification.show();
  }
});

// Notification click listener
ipcMain.on('notification:on-click', (_event) => {
  // The click is handled per-notification in the notification:send handler above,
  // which forwards the event to the renderer via 'notification:clicked'
});

// Badge (dock/taskbar)
ipcMain.on('badge:set', (_event, count) => {
  if (process.platform === 'darwin') {
    app.dock.setBadge(count > 0 ? String(count) : '');
  } else if (process.platform === 'win32') {
    // Windows: use overlay icon for badge
    // This requires a small badge image; we skip for now unless an asset exists
    if (count > 0) {
      try {
        const badgePath = getAssetPath('badge.png');
        const { nativeImage } = require('electron');
        const badgeImage = nativeImage.createFromPath(badgePath);
        if (!badgeImage.isEmpty()) {
          mainWindow?.setOverlayIcon(badgeImage, String(count));
        }
      } catch {
        // Badge image not available, skip
      }
    } else {
      mainWindow?.setOverlayIcon(null, '');
    }
  }
});

// App version
ipcMain.handle('app:version', () => app.getVersion());

// Offline retry
ipcMain.on('offline:retry', () => {
  if (mainWindow) loadApp();
});

// ─── App Update Delivery (Public App Settings → desktop client) ─────────────
// Full in-app update flow requested by the Public App Settings rebuild:
//   • updates:check         → PUBLIC GET /api/app-versions/check (platform+version)
//   • updates:download      → streams the installer to <userData>/updates/ with
//                             live progress events on 'update:progress' and a
//                             final 'update:downloaded' event (preload exposes both)
//   • updates:install       → runs the downloaded NSIS installer AFTER this app
//                             has fully quit (cmd waits 4s → silent /S install)
//   • updates:network-info  → best-effort Wi-Fi detection for "auto-download
//                             only on Wi-Fi" (unknown → treated as Wi-Fi)
// The legacy 'update:install' channel stays wired: it now prefers a locally
// downloaded installer and only falls back to opening the pushed URL.
const os = require('os');

const UPDATE_PLATFORM = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
const UPDATES_DIR = () => path.join(app.getPath('userData'), 'updates');
let activeUpdateDownload = null; // { version, url, dest } while running
let lastDownloadedInstaller = null; // absolute path of the last completed download

function sendUpdateProgress(payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    try { if (!win.isDestroyed()) win.webContents.send('update:progress', payload); } catch { /* window gone */ }
  }
}

function resolveUpdateUrl(url) {
  let u = String(url || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) {
    const base = (process.env.BLASTI_CLOUD_URL || CLOUD_BASE_URL || '').replace(/\/+$/, '');
    if (base) u = base + (u.startsWith('/') ? u : '/' + u);
  }
  return u;
}

ipcMain.handle('updates:check', async () => {
  try {
    const base = (process.env.BLASTI_CLOUD_URL || CLOUD_BASE_URL || '').replace(/\/+$/, '');
    if (!base) return { success: false, error: 'no-cloud-url' };
    const url = `${base}/api/app-versions/check?platform=${UPDATE_PLATFORM}&version=${encodeURIComponent(app.getVersion())}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    clearTimeout(timer);
    if (!res.ok) return { success: false, error: `http-${res.status}` };
    const data = await res.json();
    console.log('[BLASTI Desktop] updates:check →', data && data.updateAvailable
      ? `v${data.currentVersion} → v${data.latestVersion} (mandatory: ${data.isMandatory})` : 'up to date');
    return data;
  } catch (err) {
    console.warn('[BLASTI Desktop] updates:check failed:', err && err.message);
    return { success: false, error: (err && err.message) || 'check-failed' };
  }
});

ipcMain.handle('updates:download', async (_e, payload) => {
  const { url, version, fileHash, fileSize } = payload || {};
  const resolved = resolveUpdateUrl(url);
  if (!resolved) return { status: 'error', error: 'missing-url' };
  if (activeUpdateDownload) return { status: 'busy', version: activeUpdateDownload.version };

  const fileName = path.basename(resolved.split('?')[0]) || `BLASTI-Setup-${version || 'update'}.exe`;
  const dest = path.join(UPDATES_DIR(), /^BLASTI-Setup-.*\.exe$/i.test(fileName) ? fileName : `BLASTI-Setup-${version || 'update'}.exe`);
  try { fs.mkdirSync(path.dirname(dest), { recursive: true }); } catch { /* exists */ }

  activeUpdateDownload = { version: version || '', url: resolved, dest, fileHash: String(fileHash || ''), fileSize: Number(fileSize || 0) };
  console.log('[BLASTI Desktop] updates:download →', resolved, '→', dest);
  (async () => {
    let lastSentPercent = -1;
    let lastSentAt = 0;
    const emit = (received, total) => {
      const percent = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;
      const now = Date.now();
      if (percent !== lastSentPercent && (now - lastSentAt > 250 || percent === 100)) {
        lastSentPercent = percent;
        lastSentAt = now;
        sendUpdateProgress({ status: 'downloading', percent, receivedBytes: received, totalBytes: total, version: activeUpdateDownload.version });
      }
    };
    try {
      const received = await downloadUpdateFile(resolved, dest, emit);
      lastDownloadedInstaller = dest;
      // INSTALL FIX (0.6.30): the field bug "app closes and nothing happens"
      // was a CORRUPTED installereaching the NSIS run — /S fails instantly and
      // silently, the app had already quit. Verify size + sha256 BEFORE the
      // downloaded state is announced; a bad file is deleted and re-downloadable.
      const verify = await verifyDownloadedInstaller(dest, activeUpdateDownload.fileHash, activeUpdateDownload.fileSize);
      if (!verify.ok) {
        console.warn('[BLASTI Desktop] update download FAILED INTEGRITY CHECK:', verify.error);
        try { fs.unlinkSync(dest); } catch { /* already gone */ }
        lastDownloadedInstaller = null;
        requestRendererLogFlush();
        sendUpdateProgress({ status: 'error', error: verify.error, version: activeUpdateDownload.version });
        return;
      }
      sendUpdateProgress({ status: 'downloaded', percent: 100, receivedBytes: received, totalBytes: received, filePath: dest, version: activeUpdateDownload.version });
      for (const win of BrowserWindow.getAllWindows()) {
        try { if (!win.isDestroyed()) win.webContents.send('update:downloaded', { filePath: dest, version: activeUpdateDownload.version }); } catch { /* window gone */ }
      }
      console.log('[BLASTI Desktop] update downloaded + verified:', dest, `(${received} bytes, sha256 ${verify.sha256.slice(0, 12)}…)`);
    } catch (err) {
      console.warn('[BLASTI Desktop] update download failed:', err && err.message);
      sendUpdateProgress({ status: 'error', error: (err && err.message) || 'download-failed', version: activeUpdateDownload ? activeUpdateDownload.version : '' });
      try { fs.unlinkSync(dest); } catch { /* nothing to clean */ }
    } finally {
      activeUpdateDownload = null;
    }
  })();
  return { status: 'started', dest };
});

/** INSTALL FIX — size + sha256 gate every downloaded installer must pass. */
async function verifyDownloadedInstaller(filePath, expectedHash, expectedSize) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0) return { ok: false, error: 'empty-download' };
    if (expectedSize && stat.size !== expectedSize) {
      return { ok: false, error: `size-mismatch (${stat.size} != ${expectedSize})` };
    }
    const crypto = require('crypto');
    const sha256 = await new Promise((resolve, reject) => {
      const h = crypto.createHash('sha256');
      const s = fs.createReadStream(filePath);
      s.on('data', (chunk) => h.update(chunk));
      s.on('error', reject);
      s.on('end', () => resolve(h.digest('hex')));
    });
    if (expectedHash && expectedHash.length >= 16 && sha256 !== expectedHash) {
      return { ok: false, error: `hash-mismatch (got ${sha256.slice(0, 12)}…, want ${String(expectedHash).slice(0, 12)}…)`, sha256 };
    }
    return { ok: true, sha256 };
  } catch (err) {
    return { ok: false, error: `verify-failed: ${(err && err.message) || err}` };
  }
}

// ─── Fast parallel update downloader ─────────────────────────────────────────
// The old single-connection fetch felt dramatically slower than the browser
// download from the landing page on long-fat links (single TCP stream on a
// high-latency route). This downloader:
//   • uses Electron's net.fetch (system proxy + HTTP/2 aware) when available,
//   • probes Range support and downloads in 3 PARALLEL chunks for files
//     larger than 8 MB (multiplies the effective throughput exactly like a
//     browser's parallel-connection behaviour),
//   • falls back to a single resumed stream (Range: bytes=<have>-) when the
//     server ignores ranges or a chunk fails,
//   • never buffers the file in memory (positional fs writes / streaming).
const UPDATE_PARALLEL_MIN_BYTES = 8 * 1024 * 1024;
const UPDATE_PARTS = 3;

function updateFetch(url, init) {
  // Electron net.fetch honors the OS proxy and TLS stack — prefer it; the
  // global (undici) fetch is the universal fallback (dev + tests).
  try {
    const { net } = require('electron');
    if (net && typeof net.fetch === 'function') return net.fetch(url, init);
  } catch { /* not available — fall through */ }
  return fetch(url, init);
}

function semverGreaterThan(a, b) {
  const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

async function downloadUpdateFile(url, dest, emit) {
  // ── Probe: size + Range support in one cheap ranged request. ──────────────
  let total = 0;
  let ranges = false;
  try {
    const probe = await updateFetch(url, { headers: { Range: 'bytes=0-0' }, redirect: 'follow' });
    if (probe.status === 206) {
      ranges = true;
      const cr = probe.headers.get('content-range') || '';
      const m = /\/(\d+)\s*$/.exec(cr);
      if (m) total = parseInt(m[1], 10);
    } else if (probe.ok) {
      total = Number(probe.headers.get('content-length') || 0);
    }
    try { await probe.body?.cancel(); } catch { /* already closed */ }
  } catch { /* probe failure is non-fatal — the real request rechecks */ }

  // Large file + server-side ranges → parallel chunked download.
  if (ranges && total >= UPDATE_PARALLEL_MIN_BYTES) {
    try {
      const got = await downloadParallelRanges(url, dest, total, emit);
      return got;
    } catch (err) {
      console.warn('[BLASTI Desktop] parallel download failed — falling back to single stream:', err && err.message);
    }
  }
  return downloadSingleStream(url, dest, emit);
}

async function downloadParallelRanges(url, dest, total, emit) {
  const parts = [];
  const boundaries = [];
  for (let i = 0; i <= UPDATE_PARTS; i++) boundaries.push(Math.round((total * i) / UPDATE_PARTS));
  for (let i = 0; i < UPDATE_PARTS; i++) {
    parts.push({ start: boundaries[i], end: boundaries[i + 1] - 1, received: 0 });
  }
  // Preallocate the file to the exact final size so positional writes never
  // race ahead of the file length.
  try {
    const fd0 = fs.openSync(dest, 'w');
    fs.truncateSync(fd0, total);
    fs.closeSync(fd0);
  } catch { /* keep going — writes still create it */ }

  const receivedRef = { value: 0 };
  const throttle = { last: 0 };
  await Promise.all(parts.map(async (part) => {
    const res = await updateFetch(url, {
      headers: { Range: `bytes=${part.start}-${part.end}` },
      redirect: 'follow',
    });
    if (res.status !== 206) throw new Error(`range-http-${res.status}`);
    const nodeStream = require('stream').Readable.fromWeb(res.body);
    await new Promise((resolveP, rejectP) => {
      const fd = fs.openSync(dest, 'r+');
      let pos = part.start;
      nodeStream.on('data', (chunk) => {
        fs.writeSync(fd, chunk, 0, chunk.length, pos);
        pos += chunk.length;
        part.received = pos - part.start;
        receivedRef.value += chunk.length;
        const now = Date.now();
        if (now - throttle.last > 250) {
          throttle.last = now;
          emit(Math.min(receivedRef.value, total), total);
        }
      });
      nodeStream.on('error', (e) => { try { fs.closeSync(fd); } catch { /* closed */ } rejectP(e); });
      nodeStream.on('end', () => { try { fs.closeSync(fd); } catch { /* closed */ } resolveP(); });
    });
    if (part.start + part.received !== part.end + 1) throw new Error('range-short-read');
  }));
  return total;
}

async function downloadSingleStream(url, dest, emit) {
  // Resume: keep an existing partial file and continue from its length.
  let have = 0;
  try { have = fs.statSync(dest).size; } catch { /* fresh download */ }
  const res = await updateFetch(url, have > 0
    ? { headers: { Range: `bytes=${have}-` }, redirect: 'follow' }
    : { redirect: 'follow' });
  if (!res.ok) throw new Error(`http-${res.status}`);
  const resumed = res.status === 206;
  if (!resumed && have > 0) { try { fs.unlinkSync(dest); } catch { /* gone */ } have = 0; }
  const total = resumed
    ? (parseInt((/\/(\d+)\s*$/.exec(res.headers.get('content-range') || '') || [])[1] || '0', 10))
    : Number(res.headers.get('content-length') || 0) + have;
  let received = have;
  emit(received, total);
  const fileStream = fs.createWriteStream(dest, resumed ? { flags: 'r+', start: have } : { flags: 'w' });
  const nodeStream = require('stream').Readable.fromWeb(res.body);
  await new Promise((resolveP, rejectP) => {
    nodeStream.on('data', (chunk) => {
      received += chunk.length;
      fileStream.write(chunk);
      emit(received, total);
    });
    nodeStream.on('error', rejectP);
    fileStream.on('error', rejectP);
    nodeStream.on('end', () => fileStream.end(resolveP));
  });
  return received;
}

/**
 * INSTALL FIX (0.6.30) — the OLD flow quit unconditionally 300 ms after
 * spawning the installer, so every spawn failure looked like "the app just
 * closed". The rewrite:
 *   1. verifies the downloaded installer again before touching it,
 *   2. only schedules app.quit() AFTER the spawned helper process is
 *      CONFIRMED alive (pid + still running 900 ms later),
 *   3. returns { ok:false } instead of quitting when every launcher leg
 *      fails — the renderer keeps running, tells the user, and offers the
 *      manual "open installer file" fallback (updates:open-installer).
 */
async function installDownloadedUpdate() {
  const installer = lastDownloadedInstaller || (() => {
    try {
      const files = fs.readdirSync(UPDATES_DIR()).filter((f) => /\.(exe|dmg|appimage|deb)$/i.test(f))
        .map((f) => ({ f, t: fs.statSync(path.join(UPDATES_DIR(), f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      return files.length ? path.join(UPDATES_DIR(), files[0].f) : null;
    } catch { return null; }
  })();
  if (!installer || !fs.existsSync(installer)) return { ok: false, error: 'no-download' };

  const stat = fs.statSync(installer);
  if (!stat.isFile() || stat.size === 0) {
    console.warn('[BLASTI Desktop] updates:install → downloaded file is empty/corrupt, refusing to quit:', installer);
    try { fs.unlinkSync(installer); } catch { /* keep */ }
    lastDownloadedInstaller = null;
    return { ok: false, error: 'corrupt-download' };
  }
  console.log('[BLASTI Desktop] updates:install → installing:', installer, `(${stat.size} bytes)`);

  const procAlive = (pid) => new Promise((resolve) => {
    try {
      process.kill(pid, 0); // signal 0 = existence probe
      setTimeout(() => {
        try { process.kill(pid, 0); resolve(true); } catch { resolve(false); }
      }, 900);
    } catch { resolve(false); }
  });

  const quitForUpdate = () => {
    setTimeout(() => { try { app.quit(); } catch { /* already quitting */ } }, 300);
  };

  if (process.platform === 'win32') {
    // UPDATE-0.6.14 — per-user installs (the DEFAULT for this app:
    // nsis.perMachine:false) go through the self-contained Electron waiter:
    // copy of our own exe that waits for this process to exit, runs the NSIS
    // installer with /S directly (CreateProcessW — Unicode-safe, no cmd /
    // PowerShell interpreter for an AV to block), waits for it to finish and
    // relaunches the app. FIELD ROOT CAUSE of "app closes and nothing
    // happens": the previous flow depended on `powershell -EncodedCommand`,
    // which endpoint antivirus suites heuristically kill, leaving the
    // installer unlaunched with no visible error.
    if (app.isPackaged && isPerUserWindowsInstall()) {
      const pid = spawnUpdateWaiter(installer);
      if (pid && await procAlive(pid)) {
        console.log('[BLASTI Desktop] update waiter confirmed alive (pid', pid + ') — quitting for install');
        quitForUpdate();
        return { ok: true };
      }
      console.warn('[BLASTI Desktop] update waiter did not stay alive — trying the PowerShell leg');
    }
    // Fallbacks: dev runs (not packaged), per-machine (Program Files) installs
    // (the PowerShell leg elevates via UAC — a non-elevated silent install
    // into Program Files ALWAYS fails silently), or a failed waiter copy.
    const psPid = spawnSilentWindowsInstall(installer, { elevate: app.isPackaged && !isPerUserWindowsInstall() });
    if (psPid && await procAlive(psPid)) {
      console.log('[BLASTI Desktop] PowerShell installer leg confirmed alive (pid', psPid + ') — quitting for install');
      quitForUpdate();
      return { ok: true };
    }
    // 0.6.30: NEVER quit on a failed spawn — report the failure instead so
    // the user keeps their session and can run the installer manually.
    console.error('[BLASTI Desktop] every installer launcher failed — the app stays open (manual install available)');
    requestRendererLogFlush();
    sendUpdateProgress({ status: 'error', error: 'install-spawn-failed', version: '' });
    return { ok: false, error: 'install-spawn-failed' };
  }

  // macOS / Linux: open the artifact with the OS handler.
  let opened = false;
  try { require('child_process').spawn('xdg-open', [installer], { detached: true, stdio: 'ignore' }).unref(); opened = true; } catch { /* fallthrough */ }
  if (!opened) { try { await shell.openPath(installer); opened = true; } catch { /* last try */ } }
  if (!opened) return { ok: false, error: 'install-spawn-failed' };
  quitForUpdate();
  return { ok: true };
}

/** True when the running exe lives under %LOCALAPPDATA% (per-user NSIS install). */
function isPerUserWindowsInstall() {
  if (process.platform !== 'win32') return false;
  try {
    const exe = path.resolve(process.execPath).toLowerCase();
    const lad = process.env.LOCALAPPDATA ? path.resolve(process.env.LOCALAPPDATA).toLowerCase() : '';
    return !!lad && exe.startsWith(lad + path.sep);
  } catch { return false; }
}

/**
 * UPDATE-0.6.14 — spawn the detached update waiter (a COPY of this exe so
 * the NSIS install can freely replace the running app's files; the waiter's
 * image name differs from blasti.exe so the installer's silent close-app
 * step never kills it). Returns false when the copy/spawn fails so the
 * caller can fall back to the PowerShell leg.
 */
function spawnUpdateWaiter(installerPath) {
  const cp = require('child_process');
  try {
    fs.mkdirSync(UPDATES_DIR(), { recursive: true });
  } catch { /* exists */ }
  const waiterPath = path.join(UPDATES_DIR(), 'blasti-update-waiter.exe');
  const logFile = path.join(UPDATES_DIR(), 'install-log.txt');
  try {
    try { fs.unlinkSync(waiterPath); } catch { /* absent or locked by an old waiter */ }
    fs.copyFileSync(process.execPath, waiterPath);
    // 0.6.30: prove the copy — a zero-byte waiter spawns nothing.
    const ws = fs.statSync(waiterPath);
    if (ws.size !== fs.statSync(process.execPath).size) throw new Error('waiter copy truncated');
  } catch (err) {
    console.warn('[BLASTI Desktop] waiter copy failed — falling back to PowerShell leg:', err && err.message);
    return null;
  }
  try {
    const child = cp.spawn(
      waiterPath,
      ['--blasti-update-waiter', String(process.pid), installerPath, process.execPath, logFile],
      { detached: true, stdio: 'ignore', windowsHide: true },
    );
    child.on('error', (err) => console.warn('[BLASTI Desktop] waiter spawn error:', err.message));
    child.unref();
    if (!child.pid) return null;
    console.log('[BLASTI Desktop] update waiter spawned:', waiterPath, 'pid', child.pid);
    return child.pid;
  } catch (err) {
    console.warn('[BLASTI Desktop] waiter spawn failed — falling back to PowerShell leg:', err && err.message);
    return null;
  }
}

/**
 * UPDATE-0.6.14 — runUpdateWaiterMode lives near the top of the file (before
 * the single-instance bail-out) because the waiter branch NEVER executes the
 * main-app else block this function used to sit in.
 */

// ─── Windows silent install + relaunch (Unicode-safe) ────────────────────────
// FIELD ROOT CAUSE (updates "succeed" but the old version stays installed):
//   1. The old flow launched the installer through `cmd.exe /c timeout … && "…"`,
//      which is fragile on Windows accounts with non-ASCII names (e.g. Arabic
//      "C:\Users\عماد الدين\…") depending on the system code page, and the
//      fixed 4s head start races the app shutdown — if blasti.exe still holds
//      a file lock, a SILENT (/S) NSIS install fails with NO error dialog and
//      the old files simply remain.
//   2. Nothing relaunched the app after a silent install, so a failed install
//      looked exactly like "nothing happened".
// The new flow runs ONE PowerShell script passed as -EncodedCommand
// (UTF-16LE base64 — immune to every code-page issue):
//   • polls until OUR process has fully exited (up to 30s),
//   • runs the NSIS installer silently (/S) and WAITS for it,
//   • relaunches the freshly installed app,
//   • appends every step to <userData>\updates\install-log.txt so failures
//     are diagnosable from the field.
// UPDATE-0.6.14: `{ elevate: true }` runs the installer via -Verb RunAs (UAC)
// — REQUIRED for per-machine (Program Files) installs, where a non-elevated
// silent install always fails with no visible error. Per-user installs use
// the Electron waiter leg instead; this PowerShell leg remains the fallback
// and the per-machine path.
function spawnSilentWindowsInstall(installerPath, opts = {}) {
  const elevate = opts.elevate === true;
  const cp = require('child_process');
  const pid = process.pid;
  const appExe = process.execPath;
  const logFile = path.join(UPDATES_DIR(), 'install-log.txt');
  const q = (s) => String(s).replace(/'/g, "''"); // PS single-quote escape
  const ps = [
    `$log='${q(logFile)}'`,
    `try{Add-Content -Path $log -Value ("['" + (Get-Date -Format s) + "'] install started: " + '${
      q(installerPath)
    }')}catch{}`,
    `for($i=0;$i -lt 60;$i++){ if(-not (Get-Process -Id ${pid} -ErrorAction SilentlyContinue)){break}; Start-Sleep -Milliseconds 500 }`,
    `try{Add-Content -Path $log -Value ("['" + (Get-Date -Format s) + "'] app exited — running installer /S${elevate ? ' (elevated)' : ''}")}catch{}`,
    `try{ Start-Process -FilePath '${q(installerPath)}' -ArgumentList '/S' -Wait -WindowStyle Hidden${elevate ? ' -Verb RunAs' : ''} | Out-Null; Add-Content -Path $log -Value ("['" + (Get-Date -Format s) + "'] installer finished (exit " + $LASTEXITCODE + ")") }catch{ Add-Content -Path $log -Value ("['" + (Get-Date -Format s) + "'] installer FAILED: " + $_.Exception.Message) }`,
    `try{ if(Test-Path '${q(appExe)}'){ Start-Process -FilePath '${q(appExe)}'; Add-Content -Path $log -Value ("['" + (Get-Date -Format s) + "'] app relaunched") } }catch{}`,
  ].join('; ');
  try {
    const encoded = Buffer.from(ps, 'utf16le').toString('base64');
    const child = cp.spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { detached: true, stdio: 'ignore', windowsHide: true, cwd: os.tmpdir() });
    child.on('error', (err) => console.warn('[BLASTI Desktop] installer spawn failed:', err.message));
    child.unref();
    // 0.6.30: the caller confirms the process STAYS alive before quitting —
    // AV-killed PowerShell legs used to leave the app closed with no install.
    return child.pid || null;
  } catch (err) {
    console.warn('[BLASTI Desktop] installer spawn threw:', err && err.message);
    return null;
  }
}

// ─── Boot-time update self-heal (auto-update: download → install → restart) ──
// If a downloaded installer is sitting in <userData>\updates whose version is
// NEWER than the running app, a previous silent install did not complete
// (locked files, power loss, killed installer…). Finish the job right at boot:
// run that installer silently and exit — the relaunch comes back as the new
// version. This closes the "success message but still the old version" loop
// permanently, even when the NSIS run itself failed once.
/**
 * 0.6.38 — surface the waiter/PowerShell install log inside main.log. The
 * silent NSIS run writes its steps + exit code ONLY to
 * <userData>\updates\install-log.txt; without this echo a failed update
 * ("app closed, still the old version") shipped ZERO evidence in the log the
 * user sends us. Last 15 lines, only when the log changed in the last 24h.
 */
function echoInstallLogTail() {
  try {
    const logFile = path.join(UPDATES_DIR(), 'install-log.txt');
    const stat = fs.statSync(logFile);
    if (Date.now() - stat.mtimeMs > 24 * 3600_000) return;
    const lines = fs.readFileSync(logFile, 'utf8').split(/\r?\n/).filter(Boolean).slice(-15);
    console.log(`[BLASTI Desktop] install-log.txt (last ${lines.length} line(s), age ${Math.round((Date.now() - stat.mtimeMs) / 60000)}min):`);
    for (const line of lines) console.log(`[BLASTI Desktop]   | ${line}`);
  } catch { /* no log yet — nothing was ever installed */ }
}

function selfHealPendingInstaller() {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  // 0.6.38 — echo the waiter/PowerShell install log into main.log: the silent
  // NSIS run leaves its exit code ONLY there, and without this line the
  // "app closed → relaunch → still the old version" loop is undiagnosable
  // from a shipped main.log alone.
  echoInstallLogTail();
  try {
    const dir = UPDATES_DIR();
    const files = fs.readdirSync(dir).filter((f) => /^BLASTI-Setup-(\d+\.\d+\.\d+[^\s]*)\.exe$/i.test(f));
    if (!files.length) return;
    const current = app.getVersion();
    const pending = files
      .map((f) => ({ f, ver: /^BLASTI-Setup-(\d+\.\d+\.\d+[^\s]*)\.exe$/i.exec(f)[1], t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .filter((e) => semverGreaterThan(e.ver, current))
      .sort((a, b) => b.t - a.t);
    if (!pending.length) return;
    const target = path.join(dir, pending[0].f);
    // Never self-heal on top of a download that is still being written.
    try { fs.accessSync(target); } catch { return; }
    const stat = fs.statSync(target);
    if (Date.now() - stat.mtimeMs < 60_000) return; // still downloading
    console.log(`[BLASTI Desktop] self-heal: finishing pending update ${pending[0].ver} (running ${current}) →`, target);

    // 0.6.38 SELF-HEAL LOOP GUARD — the field log showed the app quit for the
    // SAME pending installer 3 times in 20 seconds: a silent install that
    // fails instantly (locked files, disk, AV) used to bounce the app forever
    // — "the desktop app closes itself after downloading the update". Track
    // attempts per installer file: after 2 quits within 10 minutes STOP
    // auto-quitting, tell the renderer, and let the user install manually
    // (the installer stays in updates\ and updates:open-installer opens it).
    const statePath = path.join(dir, 'selfheal-state.json');
    let attempts = { file: '', count: 0, at: 0 };
    try { attempts = JSON.parse(fs.readFileSync(statePath, 'utf8')) || attempts; } catch { /* fresh */ }
    const sameRun = attempts.file === pending[0].f && (Date.now() - attempts.at) < 10 * 60_000;
    if (sameRun && attempts.count >= 2) {
      console.error(`[BLASTI Desktop] self-heal: ${attempts.count} install attempts for ${pending[0].f} did not take effect — stopping auto-quit (manual install required). See install-log.txt echo above.`);
      sendUpdateProgress({ status: 'error', error: 'selfheal-gave-up', version: pending[0].ver });
      requestRendererLogFlush();
      return;
    }
    try {
      fs.writeFileSync(statePath, JSON.stringify({
        file: pending[0].f,
        count: sameRun ? attempts.count + 1 : 1,
        at: Date.now(),
      }));
    } catch { /* guard is best-effort */ }

    // UPDATE-0.6.14 — same launcher decision as updates:install (waiter for
    // per-user installs, elevated PowerShell for per-machine installs).
    if (!spawnUpdateWaiter(target)) {
      spawnSilentWindowsInstall(target, { elevate: !isPerUserWindowsInstall() });
    }
    setTimeout(() => { try { app.quit(); } catch { /* already quitting */ } }, 1500);
  } catch (err) {
    console.warn('[BLASTI Desktop] self-heal check failed:', err && err.message);
  }
}

ipcMain.handle('updates:install', async () => {
  const result = await installDownloadedUpdate();
  if (!result.ok) {
    // 0.6.30 — tell the renderer the install did NOT start; it keeps the
    // user's session alive and shows the manual-open-installer fallback.
    for (const win of BrowserWindow.getAllWindows()) {
      try { if (!win.isDestroyed()) win.webContents.send('update:install-failed', { error: result.error }); } catch { /* gone */ }
    }
  }
  return result;
});

/** Manual fallback — open the downloaded installer in Explorer's handler. */
ipcMain.handle('updates:open-installer', async () => {
  const installer = lastDownloadedInstaller || (() => {
    try {
      const files = fs.readdirSync(UPDATES_DIR()).filter((f) => /\.(exe|dmg|appimage|deb)$/i.test(f))
        .map((f) => ({ f, t: fs.statSync(path.join(UPDATES_DIR(), f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      return files.length ? path.join(UPDATES_DIR(), files[0].f) : null;
    } catch { return null; }
  })();
  if (!installer || !fs.existsSync(installer)) return { ok: false, error: 'no-download' };
  const result = await shell.openPath(installer);
  return { ok: !result, error: result || undefined, path: installer };
});

/** Relaunch AFTER a successful delta apply — the new asar loads on boot. */
ipcMain.handle('updates:relaunch-after-delta', () => {
  try {
    console.log('[BLASTI Desktop] relaunching after delta update…');
    app.relaunch();
    setTimeout(() => { try { app.exit(0); } catch { /* falling */ } }, 250);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// ─── Delta Updates (0.6.30) — apply the differential chain in place ──────────
// payload: { hops: [{ url, sha256, size, fromVersion, toVersion, fromArtifactHash }],
//            target: { version, asarSha256, runtimeKey, nativeFingerprint } }
// The renderer resolves the URLs to absolute cloud paths; every hop is
// downloaded to <userData>/updates/, sha-verified, then applied IN ORDER:
//   hop patch = BLSTRLS1 { asar delta (→ new app.asar) + out tree patch }
// A failure anywhere keeps the running install intact (asar swap is atomic
// rename; the tree patch is verified per file) and returns { ok:false } so
// the renderer falls back to the full installer download.
ipcMain.handle('updates:install-delta', async (_e, payload) => {
  const hops = Array.isArray(payload && payload.hops) ? payload.hops : [];
  const target = (payload && payload.target) || {};
  if (hops.length === 0) return { ok: false, error: 'no-hops' };
  const fsDelta = require('@blasti/binary-delta');
  const resourcesPath = process.resourcesPath || path.join(path.dirname(process.execPath), 'resources');
  const asarPath = path.join(resourcesPath, 'app.asar');
  const unpackedTree = path.join(resourcesPath, 'app.asar.unpacked');
  const sendStage = (percent, stage) => sendUpdateProgress({ status: 'downloading', percent, receivedBytes: percent, totalBytes: 100, version: target.version || '', stage });
  try {
    if (!fs.existsSync(asarPath)) return { ok: false, error: 'asar-not-found' };

    // 1) Verify the CURRENT asar against the FIRST hop's anchor.
    const firstAnchor = hops[0].fromArtifactHash || '';
    if (firstAnchor) {
      sendStage(2, 'verify-current');
      const currentSha = await fsDelta.sha256OfFile(asarPath);
      if (currentSha !== firstAnchor) {
        console.warn('[BLASTI Desktop] delta chain anchor mismatch: local asar', currentSha.slice(0, 12), '≠ expected', firstAnchor.slice(0, 12));
        return { ok: false, error: 'asar-anchor-mismatch' };
      }
    }

    // 2) Download every hop patch + verify sha256.
    const hopFiles = [];
    let doneBytes = 0;
    const totalBytes = hops.reduce((s, h) => s + (h.size || 0), 0) || 1;
    for (let i = 0; i < hops.length; i++) {
      const hop = hops[i];
      const url = resolveUpdateUrl(hop.url);
      if (!url) return { ok: false, error: 'hop-url-missing' };
      const dest = path.join(UPDATES_DIR(), `delta-${hop.fromVersion}-to-${hop.toVersion}-${Date.now()}.patch`);
      try { fs.mkdirSync(UPDATES_DIR(), { recursive: true }); } catch { /* exists */ }
      sendStage(Math.round((doneBytes / totalBytes) * 90), 'download');
      const size = await downloadUpdateFile(url, dest, (received, total) => {
        sendStage(Math.round(((doneBytes + Math.min(received, total)) / totalBytes) * 90), 'download');
      });
      const dl = await verifyDownloadedInstaller(dest, hop.sha256, size);
      if (!dl.ok) {
        try { fs.unlinkSync(dest); } catch { /* keep */ }
        return { ok: false, error: `hop-verify-failed: ${dl.error}` };
      }
      doneBytes += size;
      hopFiles.push(dest);
    }

    // 3) Apply the hops in order. `currentAsar` chains: hop k+1's asar delta
    // applies to hop k's RESULT (that is what the server diffed against).
    let appliedAsar = 0;
    let appliedTree = 0;
    let currentAsar = asarPath;
    const stashedAsars = [];
    for (let i = 0; i < hopFiles.length; i++) {
      const patchBuf = fs.readFileSync(hopFiles[i]);
      const parsed = fsDelta.parseReleasePatch(patchBuf);
      const hop = hops[i];
      if (parsed.header.fromVersion !== hop.fromVersion || parsed.header.toVersion !== hop.toVersion) {
        return { ok: false, error: `hop-version-mismatch (${parsed.header.fromVersion}→${parsed.header.toVersion})` };
      }
      if (parsed.header.asar) {
        sendStage(92, `apply-asar-${i + 1}`);
        const newAsar = path.join(UPDATES_DIR(), `app.asar.hop${i}`);
        await fsDelta.applyDeltaToFile(currentAsar, patchBuf, newAsar); // verify sha256 inside
        appliedAsar++;
        stashedAsars.push(newAsar);
        currentAsar = newAsar;
      }
      if (parsed.header.tree) {
        sendStage(94, `apply-tree-${i + 1}`);
        const treePart = extractTreePart(patchBuf, parsed);
        const result = fsDelta.applyTreePatch(unpackedTree, treePart);
        if (result.failed.length > 0) {
          console.error('[BLASTI Desktop] tree patch failures:', result.failed.slice(0, 5));
          return { ok: false, error: `tree-patch-failed:${result.failed[0].p}` };
        }
        appliedTree++;
      }
    }

    // 4) Atomic asar swap: only the LAST chained result goes live.
    if (appliedAsar > 0) {
      sendStage(98, 'swap-asar');
      const finalAsar = stashedAsars[stashedAsars.length - 1];
      const backup = path.join(UPDATES_DIR(), 'app.asar.pre-delta');
      try { fs.unlinkSync(backup); } catch { /* absent */ }
      try {
        fs.renameSync(asarPath, backup);
      } catch (err) {
        // Windows file lock → schedule the swap for the next boot instead of
        // failing outright (boot-time self-heal finishes the job).
        console.warn('[BLASTI Desktop] asar rename blocked at runtime — scheduling boot swap:', err.message);
        fs.writeFileSync(path.join(UPDATES_DIR(), 'asar-pending.json'), JSON.stringify({
          pendingAsar: finalAsar,
          targetVersion: target.version || '',
          at: new Date().toISOString(),
        }, null, 2));
        return { ok: true, pendingBootSwap: true };
      }
      fs.copyFileSync(finalAsar, asarPath);
      try { fs.unlinkSync(finalAsar); } catch { /* cleanup */ }
      try { fs.unlinkSync(backup); } catch { /* keep one generation */ }
    }

    sendStage(100, 'done');
    console.log(`[BLASTI Desktop] delta chain applied: ${hops.map((h) => `${h.fromVersion}→${h.toVersion}`).join(', ')} (asar hops: ${appliedAsar}, tree hops: ${appliedTree})`);
    // Clean the downloaded hop files.
    for (const f of hopFiles) { try { fs.unlinkSync(f); } catch { /* best effort */ } }
    return { ok: true, version: target.version || '' };
  } catch (err) {
    console.error('[BLASTI Desktop] delta install failed:', err && (err.stack || err.message));
    requestRendererLogFlush();
    return { ok: false, error: `delta-failed: ${(err && err.message) || err}` };
  }
});

/** Split a BLSTRLS1 release patch into its TREE part (BLSTOUT1 bytes). */
function extractTreePart(releasePatchBuf, parsed) {
  let offset = 12 + releasePatchBuf.readUInt32BE(8);
  const header = parsed.header;
  if (header.asar) offset += header.asar.size;
  if (header.tree) return releasePatchBuf.subarray(offset, offset + header.tree.size);
  throw new Error('release patch has no tree part');
}

/** Boot-time completion of a delta asar swap the running app could not do. */
function selfHealPendingAsarSwap() {
  try {
    const markerPath = path.join(UPDATES_DIR(), 'asar-pending.json');
    if (!fs.existsSync(markerPath)) return;
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    fs.unlinkSync(markerPath);
    if (!marker.pendingAsar || !fs.existsSync(marker.pendingAsar)) return;
    const resourcesPath = process.resourcesPath || path.join(path.dirname(process.execPath), 'resources');
    const asarPath = path.join(resourcesPath, 'app.asar');
    try {
      const backup = path.join(UPDATES_DIR(), 'app.asar.pre-delta');
      try { fs.renameSync(asarPath, backup); } catch { /* may still be locked */ }
      fs.copyFileSync(marker.pendingAsar, asarPath);
      fs.unlinkSync(marker.pendingAsar);
      console.log('[BLASTI Desktop] boot self-heal: pending delta asar swap completed →', marker.targetVersion);
      setTimeout(() => { try { app.relaunch(); app.exit(0); } catch { /* fallthrough */ } }, 1200);
    } catch (err) {
      console.warn('[BLASTI Desktop] boot asar swap failed:', err.message);
    }
  } catch { /* marker unreadable — ignore */ }
}

ipcMain.handle('updates:network-info', () => {
  // Best-effort Wi-Fi/metered classification for "auto-download on Wi-Fi only".
  // Uncertainty NEVER blocks a download (isWifi defaults true when unknown).
  try {
    const ifaces = os.networkInterfaces() || {};
    let wifi = false;
    let ethernet = false;
    for (const [name, addrs] of Object.entries(ifaces)) {
      const active = (addrs || []).some((a) => !a.internal && (a.family === 'IPv4' || a.family === 4));
      if (!active) continue;
      const n = String(name).toLowerCase();
      if (/wi-?fi|wlan|wl[pxs]?[0-9]*/.test(n)) wifi = true;
      else if (/eth|en[0-9]|eno|ens/.test(n)) ethernet = true;
    }
    return { isWifi: wifi || (!wifi && !ethernet), connectionType: wifi ? 'wifi' : ethernet ? 'ethernet' : 'unknown', isUnmetered: true };
  } catch {
    return { isWifi: true, connectionType: 'unknown', isUnmetered: true };
  }
});

// Legacy channel (older renderer builds): prefer the local installer; fall
// back to opening the pushed downloadUrl in the browser as before.
ipcMain.on('update:install', () => {
  try {
    const haveLocal = lastDownloadedInstaller && fs.existsSync(lastDownloadedInstaller);
    if (haveLocal) {
      void installDownloadedUpdate();
      return;
    }
    const telemetry = require('./device-telemetry');
    const payload = telemetry.getLastUpdatePayload();
    const url = resolveUpdateUrl(payload && payload.downloadUrl);
    if (url) {
      console.log('[BLASTI Desktop] update:install → opening installer download:', url);
      shell.openExternal(url);
    } else {
      console.log('[BLASTI Desktop] update:install — no pushed download URL available');
    }
  } catch (err) {
    console.warn('[BLASTI Desktop] update:install failed:', err && err.message);
  }
});

// LAN server info IPC — returns connection details for the local LAN server
ipcMain.handle('lan:server-info', () => {
  if (!localServer) return null;
  return {
    ip: getLocalIP(),
    port: 3080,
    webPort: 3000,
    apiPort: 3003,
    hostname: require('os').hostname(),
  };
});

// Deep link handling from renderer
ipcMain.on('deep-link:open', (_event, url) => {
  if (mainWindow && url) {
    mainWindow.webContents.send('deep-link', url);
  }
});

// Phase 8c: Silent Print IPC Handlers
// Uses ipcMain.handle (async) so the print dialog never blocks the UI thread.

/**
 * Silent print — prints the current page without showing a dialog.
 * Options can include: deviceName, pageSize, etc. (Electron print options)
 * Returns { success: boolean, error?: string }
 */
ipcMain.handle('printer:print-silent', async (event, options = {}) => {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  if (!win) {
    const result = { success: false, error: 'No window available for printing' };
    event.sender.send('printer:print-result', result);
    return result;
  }

  try {
    // List available printers first to detect "no printer" scenario
    const printers = win.webContents.getPrintersAsync
      ? await win.webContents.getPrintersAsync()
      : [];

    // getPrintersAsync is Electron 22+; fall back gracefully on older versions
    if (Array.isArray(printers) && printers.length === 0) {
      const result = { success: false, error: 'No printers available on this system' };
      event.sender.send('printer:print-result', result);
      return result;
    }

    // If the caller specified a deviceName, verify it exists
    if (options.deviceName && Array.isArray(printers)) {
      const found = printers.some((p) => p.name === options.deviceName);
      if (!found) {
        const result = { success: false, error: `Printer "${options.deviceName}" not found` };
        event.sender.send('printer:print-result', result);
        return result;
      }
    }

    return await new Promise((resolve) => {
      win.webContents.print(
        { silent: true, ...options },
        (success, errorType) => {
          if (!success) {
            console.error('[BLASTI Desktop] Silent print failed:', errorType);
            const result = { success: false, error: errorType || 'Unknown print error' };
            event.sender.send('printer:print-result', result);
            resolve(result);
          } else {
            const result = { success: true };
            event.sender.send('printer:print-result', result);
            resolve(result);
          }
        }
      );
    });
  } catch (err) {
    console.error('[BLASTI Desktop] Silent print exception:', err);
    const result = {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
    event.sender.send('printer:print-result', result);
    return result;
  }
});

/**
 * Get printers — returns the list of available printers on the system.
 * Async so it never blocks the UI thread.
 */
ipcMain.handle('get-printers', async () => {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  if (!win) {
    return [];
  }

  try {
    // Electron 22+ provides getPrintersAsync()
    if (typeof win.webContents.getPrintersAsync === 'function') {
      return await win.webContents.getPrintersAsync();
    }
    // Fallback for older Electron versions (synchronous, but still wrapped in handle)
    return win.webContents.getPrinters ? win.webContents.getPrinters() : [];
  } catch (err) {
    console.error('[BLASTI Desktop] Failed to list printers:', err);
    return [];
  }
});

// ─── TV Screen / Second Monitor ─────────────────────────────────────────────
let tvWindow = null;

/**
 * Open a fullscreen TV display board on a second monitor (HDMI).
 * Falls back to the primary display if no second monitor is detected.
 *
 * IPC: 'tv-screen:open' — accepts { url: string }
 */
ipcMain.handle('tv-screen:open', async (event, { url } = {}) => {
  const { screen } = require('electron');
  const displays = screen.getAllDisplays();

  // Pick the external/second display, or fall back to primary
  let targetDisplay = displays.find((d) => d.bounds.x !== 0 || d.bounds.y !== 0);
  if (!targetDisplay && displays.length > 0) {
    targetDisplay = displays[0];
  }
  if (!targetDisplay) {
    console.error('[BLASTI Desktop] No displays found');
    return { success: false, error: 'No displays available' };
  }

  // Close existing TV window if open
  if (tvWindow && !tvWindow.isDestroyed()) {
    tvWindow.close();
    tvWindow = null;
  }

  const tvUrl = url || `${DEV_URL}/?mode=device&type=TV`;

  tvWindow = new BrowserWindow({
    x: targetDisplay.bounds.x,
    y: targetDisplay.bounds.y,
    width: targetDisplay.bounds.width || 1920,
    height: targetDisplay.bounds.height || 1080,
    fullscreen: true,
    kiosk: true, // Prevents user from exiting (Esc won't work — Ctrl+Alt+Del to exit)
    title: 'BLASTI TV Display — بلاصتي',
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  tvWindow.loadURL(tvUrl);
  tvWindow.setMenuBarVisibility(false);

  // Reopen on second display if display config changes
  screen.on('display-added', () => {
    if (tvWindow && !tvWindow.isDestroyed()) {
      const newDisplays = screen.getAllDisplays();
      const ext = newDisplays.find((d) => d.bounds.x !== 0 || d.bounds.y !== 0);
      if (ext) {
        tvWindow.setBounds(ext.bounds);
        tvWindow.setFullScreen(true);
      }
    }
  });

  console.log(`[BLASTI Desktop] TV screen opened on display: x=${targetDisplay.bounds.x}, y=${targetDisplay.bounds.y}, ${targetDisplay.bounds.width}x${targetDisplay.bounds.height}`);

  return { success: true, display: { x: targetDisplay.bounds.x, y: targetDisplay.bounds.y, width: targetDisplay.bounds.width, height: targetDisplay.bounds.height } };
});

/**
 * Close the TV screen window.
 * IPC: 'tv-screen:close'
 */
ipcMain.handle('tv-screen:close', () => {
  if (tvWindow && !tvWindow.isDestroyed()) {
    tvWindow.close();
    tvWindow = null;
    return { success: true };
  }
  return { success: false, error: 'No TV window open' };
});

/**
 * Check if a TV screen window is currently open.
 * IPC: 'tv-screen:status'
 */
ipcMain.handle('tv-screen:status', () => {
  return {
    isOpen: !!tvWindow && !tvWindow.isDestroyed(),
  };
});

// ─── Protocol Registration ────────────────────────────────────────────────────

app.setAsDefaultProtocolClient(PROTOCOL);

// macOS: handle open-url event
app.on('open-url', (_event, url) => {
  if (url && url.startsWith(`${PROTOCOL}://`)) {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      mainWindow.webContents.send('deep-link', url);
    }
  }
});

// ─── App Lifecycle ────────────────────────────────────────────────────────────

// Phase 8d: Local-First Node Server for LAN Kiosk tablets
// Serves a minimal Express + Socket.IO server alongside Electron
// When external internet drops, LAN tablets can still connect to this local server
let localServer = null;

// ─── Sync Transformers (module-scope so all routes can use them) ────────────
// Convert between local SQLite format (snake_case, epoch ms, 0/1 booleans)
// and WatermelonDB client format (snake_case, epoch ms, 0/1 booleans).
// They're nearly identical, but we normalize timestamps and booleans.

function _transformLocalChangesForClient(localChanges) {
  // Local DB already stores data in WDB-compatible format (snake_case, epoch ms, 0/1)
  // Just pass through — the client expects this exact shape.
  return localChanges;
}

function _transformClientChangesToLocal(clientChanges) {
  // Client (WDB) sends snake_case table names with snake_case fields.
  // Local DB uses the same format. Just pass through.
  // Exception: convert ISO date strings to epoch ms if present.
  const result = {};

  for (const [table, modelChanges] of Object.entries(clientChanges)) {
    result[table] = {
      created: (modelChanges.created || []).map(_normalizeClientRecord),
      updated: (modelChanges.updated || []).map(_normalizeClientRecord),
      deleted: modelChanges.deleted || [],
    };
  }

  return result;
}

function _normalizeClientRecord(record) {
  const result = { ...record };

  // Convert ISO date strings to epoch ms for date columns
  const dateFields = ['joined_at', 'called_at', 'completed_at', 'cancelled_at', 'paused_at',
                      'created_at', 'updated_at'];
  for (const field of dateFields) {
    if (typeof result[field] === 'string' && result[field].match(/^\d{4}-\d{2}-\d{2}T/)) {
      result[field] = new Date(result[field]).getTime();
    }
  }

  return result;
}

// ─── Task 33-C: authorization-revoked bridge (sync engine → renderer) ────────
// When the sync engine CONFIRMS the cloud has rejected the session (401/403
// verified through the refresh-session discriminator — a network failure
// never revokes), the workspace locks and the renderer must force a logout →
// login screen. Direct module subscription (same pattern as the mutation
// listener self-wiring): events fire even before a window exists (guarded).
try {
  const syncServiceForEvents = require('./local-api/sync-service');
  syncServiceForEvents.onSyncEvent((evt) => {
    if (!evt || evt.type !== 'authorization-revoked') return;
    console.warn('[Main] Authorization revoked by cloud — notifying renderer:', evt.reason || 'unknown');
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('auth:revoked', { reason: evt.reason || 'token-rejected' });
      }
    } catch (_) { /* window gone */ }
  });
  console.log('[Main] Sync event bridge wired (authorization-revoked → auth:revoked IPC)');
} catch (bridgeErr) {
  console.warn('[Main] Could not wire the authorization-revoked bridge:', bridgeErr.message);
}

// ─── IPC: Auth bridge for cloud sync ────────────────────────────────────────
// The renderer process (which has access to NextAuth cookies) sends the JWT
// token to the main process so the cloud sync loop can authenticate.

/**
 * v2: Run the stage-based initial sync (local-api/initial-sync.js) using the
 * current session, then initialize the sync engine's pull cursor from the
 * snapshot sequence and start the background engine. Shared by the
 * cloud-sync:set-auth login flow and the cloud-sync:initial-sync IPC bridge
 * (used by the loading screen).
 */
// Single-flight guard (spec §29): the login form, auth-provider reload,
// fetch-with-retry and store rehydration can all call set-auth within seconds.
// One authoritative initial-sync job per session — concurrent callers join
// the in-flight promise instead of starting duplicate imports.
let _initialSyncInFlight = null;

async function _runInitialSyncFromSession() {
  if (_initialSyncInFlight) {
    console.log('[IPC] Initial sync already in flight — coalescing');
    return _initialSyncInFlight;
  }
  _initialSyncInFlight = _runInitialSyncFromSessionInner().finally(() => {
    _initialSyncInFlight = null;
  });
  return _initialSyncInFlight;
}

async function _runInitialSyncFromSessionInner() {
  const localApi = require('./local-api/index');
  let session = localApi.getSession();
  if (!session || !session.token || !session.user) {
    // Fall back to the persisted auth file (loading-screen flow).
    try {
      const authPath = path.join(app.getPath('userData'), 'blasti-auth.json');
      if (fs.existsSync(authPath)) {
        session = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
      }
    } catch { /* ignore malformed auth file */ }
  }
  if (!session || !session.token || !session.user) {
    return { success: false, error: 'No active session — login first' };
  }

  const { localDb } = require('./local-api/lib/db');
  const cloudUrl = process.env.BLASTI_CLOUD_URL || CLOUD_BASE_URL;

  // Readiness gate: an already-READY workspace must NEVER re-import.
  // (Prevents the historic "Auth set — triggering immediate initial sync"
  // spam and pointless re-downloads on every session restore.)
  try {
    const { checkInitialSyncStatus } = require('./local-api/initial-sync');
    const status = await checkInitialSyncStatus(localDb, session.user.agencyId);
    if (status && status.status === 'READY') {
      console.log('[IPC] Workspace already READY — skipping initial sync');
      const syncServiceReady = require('./local-api/sync-service');
      try {
        if (localDb && !syncServiceReady.getStatus()?.isStarted) {
          syncServiceReady.startSync({
            localDb,
            cloudBaseUrl: cloudUrl,
            agencyId: session.user.agencyId || '',
          });
          console.log('[IPC] Sync service started (already-READY path) — cloud:', cloudUrl);
        }
      } catch (startErr) {
        console.warn('[IPC] Failed to start sync service (READY path):', startErr.message);
      }
      return { success: true, totalRecords: 0, duration: 0, alreadyInitialized: true };
    }
  } catch (statusErr) {
    console.warn('[IPC] Could not read initialization status (continuing):', statusErr.message);
  }

  const { runInitialSync } = require('./local-api/initial-sync');
  // "data loading failed" investigation — the initial sync runs concurrently
  // with the renderer's first dashboard load; its duration and outcome go
  // into the SAME rolling diag file the local API writes to.
  const { diagLog } = require('./local-api/lib/diag-log');
  const initialSyncStartedAt = Date.now();
  diagLog('INITIAL-SYNC start (user=' + (session.user.username || session.user.id) + ', agency=' + (session.user.agencyId || 'none') + ', cloud=' + cloudUrl + ')');
  const result = await runInitialSync({
    agencyId: session.user.agencyId,
    cloudAuthToken: session.token,
    cloudUrl: cloudUrl,
    db: localDb,
    // Task 48: session identity → stale-generation pre-flight (Step 0b) —
    // detects the re-seeded cloud (same email, new user id) and rebuilds the
    // local mirror BEFORE the staged import instead of crashing on P2002.
    sessionUserId: session.user.id || null,
    sessionUserEmail: session.user.email || null,
    sessionUserUsername: session.user.username || null,
    emitFn: (evt) => console.log('[InitialSync evt]', evt.type, evt.stage || ''),
  });
  diagLog('INITIAL-SYNC finished in ' + ((Date.now() - initialSyncStartedAt) / 1000).toFixed(1) + 's — success=' + (result ? !!result.success : 'null') +
    (result && result.success ? ' totalRecords=' + (result.totalRecords ?? '?') : ' error=' + (result && result.error ? result.error : 'unknown')));

  const syncService = require('./local-api/sync-service');
  if (result && result.success && typeof result.snapshotSequence === 'number') {
    // CURSOR INVARIANT (field round 6): prefer the BRIDGE's final sequence —
    // it proves ledger coverage up to F; the raw snapshotSequence (S) would
    // re-pull S..F (harmless but wasteful) and never explains a jump.
    const adoptedSeq = (typeof result.bridgeFinalSequence === 'number' && result.bridgeFinalSequence >= result.snapshotSequence)
      ? result.bridgeFinalSequence
      : result.snapshotSequence;
    await syncService.setInitialCursor(adoptedSeq, { source: 'ipc-post-init', snapshotSequence: result.snapshotSequence, bridgeFinalSequence: result.bridgeFinalSequence ?? null }).catch(() => {});
  }

  // Start the background engine after the initializer finishes (success OR
  // failure — an offline failure recovers via the pull-from-0 path once
  // connectivity returns). Starting after completion avoids racing the
  // staged import.
  try {
    if (localDb && !syncService.getStatus()?.isStarted) {
      syncService.startSync({
        localDb,
        cloudBaseUrl: cloudUrl,
        agencyId: session.user.agencyId || '',
      });
      console.log('[IPC] Sync service started after initial sync — cloud:', cloudUrl);
    }
  } catch (startErr) {
    console.warn('[IPC] Failed to start sync service after initial sync:', startErr.message);
  }

  return result;
}

ipcMain.handle('cloud-sync:set-auth', async (_event, { token, user, rememberMe, freshSignup }) => {
  try {
    const syncService = require('./local-api/sync-service');
    syncService.setAuth(token, user);

    // ── v2 initial sync: stage-based initializer ────────────────────────
    // Replaces the old syncService.initialSync() (deleted). Runs the
    // per-stage import, sets the engine cursor from the snapshot sequence,
    // then starts the background engine.
    try {
      // Import the session into the local API first so the initializer and
      // any local business calls during import have a session available.
      const localApi = require('./local-api/index');
      localApi.setSession(token, user);
      // Task 33-C: the renderer just completed a REAL cloud login (the cloud
      // validated the credentials) — this is fresh proof of authorization.
      // Record AUTHORIZED and lift any previous workspace lock.
      try {
        if (typeof localApi.markAuthorizationAuthorized === 'function') {
          await localApi.markAuthorizationAuthorized();
        }
      } catch (authzErr) {
        console.warn('[IPC] Could not mark authorization AUTHORIZED:', authzErr.message);
      }
    } catch (sessionErr) {
      console.warn('[IPC] Failed to import session to local API (early):', sessionErr.message);
    }
    try {
      if (freshSignup === true) {
        // 0.6.20 fresh-signup fix — the account was JUST created from this
        // very device: there is no agency (and no server data) to import.
        // Running the staged workspace import here played a fake "importing
        // your data" process and left the post-login gate on UNKNOWN → 75s
        // timeout → "failed". The REAL import is triggered by the
        // create-agency flow's setSessionToken call once the agency (and its
        // agencyId) exists — normal login paths are unaffected.
        console.log('[IPC] Fresh signup — skipping workspace initial import (no agency exists yet; the create-agency flow triggers the real import)');
      } else {
        _runInitialSyncFromSession().then((result) => {
          if (result && result.success) {
            if (result.alreadyInitialized) {
              console.log('[IPC] Initial sync skipped — workspace already READY');
            } else {
              console.log('[IPC] Initial sync after login: imported', result.totalRecords, 'records in', Math.round((result.duration || 0) / 1000) + 's');
            }
          } else {
            console.warn('[IPC] Initial sync after login failed:', result && result.error);
          }
        }).catch((err) => {
          console.warn('[IPC] Initial sync after login error:', err.message);
        });
      }
    } catch (initErr) {
      console.warn('[IPC] Failed to launch initial sync:', initErr.message);
    }

    // Persist auth to file so the loading screen can import agency data on next launch.
    // Task 2-b (sub-task 3) — REMEMBER-ME ENFORCEMENT (main-process side):
    //   rememberMe=true  → the durable file is written (session survives restarts).
    //   rememberMe=false → NO durable copy; any PREVIOUS durable copy is deleted
    //                      (a fresh non-remember login must not revive an older
    //                      remembered session) and the before-quit purge deletes
    //                      it again in case anything re-wrote it meanwhile.
    // Callers that do not send rememberMe keep the historic durable behavior.
    try {
      const authPath = authFilePath();
      const isRememberLogin = rememberMe === true;
      _ephemeralSessionActive = !isRememberLogin;
      if (isRememberLogin) {
        fs.writeFileSync(authPath, JSON.stringify({ token, user }, null, 2));
        console.log('[IPC] Cloud sync auth saved to', authPath, '(remember-me session)');
      } else {
        purgeDurableAuthFile('non remember-me login');
        console.log('[IPC] Non remember-me login — session kept in memory only (no auth file will survive this run)');
      }
    } catch (saveErr) {
      console.warn('[IPC] Failed to apply auth file policy:', saveErr.message);
    }

    return { success: true };
  } catch (err) {
    console.error('[IPC] cloud-sync:set-auth failed:', err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('cloud-sync:clear-auth', async () => {
  try {
    const syncService = require('./local-api/sync-service');
    syncService.clearAuth();

    // Remove persisted auth file
    try {
      purgeDurableAuthFile('logout / clear-auth');
    } catch { /* ignore */ }

    // Clear local API session
    try {
      const localApi = require('./local-api/index');
      localApi.clearSession();
    } catch { /* ignore */ }

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── 0.6.20 — Full local reset ("fresh install") ─────────────────────────
// Backs the sidebar "Reset app data" action (desktop only). Wipes EVERYTHING
// the app stored on this device and relaunches as if freshly installed:
//   renderer side → cookies, localStorage, sessionStorage, IndexedDB
//                   (WatermelonDB), service workers, HTTP cache
//   main side    → the local SQLite workspace DB (blasti-local/), the local
//                  file store (blasti-files/), the durable auth file
//                  (blasti-auth.json), the local API session and the logs
// The CLOUD account and its data are never touched — after the relaunch the
// user logs in again and everything re-syncs from scratch.
ipcMain.handle('app:clear-all-data', async () => {
  try {
    console.log('[IPC] app:clear-all-data — wiping all local data (fresh-install reset)');

    // 1) Stop the engines FIRST: the background sync must not rewrite the
    //    auth file or the DB while we delete them, and the SQLite handle
    //    must be released before the files are removed.
    try {
      const syncService = require('./local-api/sync-service');
      if (typeof syncService.stopSync === 'function') syncService.stopSync();
      syncService.clearAuth();
    } catch (err) { console.warn('[Reset] sync engine stop failed (non-fatal):', err.message); }
    try {
      const localApi = require('./local-api/index');
      localApi.clearSession();
      if (typeof localApi.stopLocalApi === 'function') localApi.stopLocalApi();
    } catch (err) { console.warn('[Reset] local API stop failed (non-fatal):', err.message); }
    try { stopLanBeacon(); } catch { /* not started */ }

    // 2) Delete the main-process data directories + durable auth file.
    //    rmSync with retry — a just-closed SQLite handle can take a beat to
    //    release on Windows (EBUSY/EPERM).
    const rmWithRetry = (target, attempts = 3) => {
      for (let i = 1; i <= attempts; i++) {
        try {
          fs.rmSync(target, { recursive: true, force: true });
          console.log('[Reset] removed', target);
          return true;
        } catch (err) {
          if (i === attempts) { console.warn('[Reset] could not remove', target, ':', err.message); return false; }
          const wait = 250 * i;
          const until = Date.now() + wait;
          while (Date.now() < until) { /* sync spin — process is exiting anyway */ }
        }
      }
      return false;
    };
    const userData = app.getPath('userData');
    rmWithRetry(path.join(userData, 'blasti-local'));   // local SQLite workspace DB
    rmWithRetry(path.join(userData, 'blasti-files'));   // local file store (cloud keeps the mirrored copies)
    rmWithRetry(path.join(userData, 'logs'));           // diagnostic logs
    try { purgeDurableAuthFile('fresh-install reset'); } catch { /* already gone */ }

    // 3) Wipe the renderer session storage (cookies, localStorage,
    //    sessionStorage, IndexedDB, service workers, caches).
    try {
      const ses = (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.session)
        || session.defaultSession;
      await ses.clearStorageData({
        storages: [
          'cookies', 'localstorage', 'sessionstorage', 'indexdb',
          'serviceworkers', 'cachestoragedata', 'shadercache', 'websql',
        ],
      });
      await ses.clearCache();
      await ses.clearHostResolverCache();
      console.log('[Reset] renderer session storage wiped');
    } catch (err) { console.warn('[Reset] session wipe failed (non-fatal):', err.message); }

    // 4) Relaunch as a fresh install (same args — dev flags preserved).
    console.log('[Reset] relaunching app fresh');
    app.relaunch({ args: process.argv.slice(1) });
    app.exit(0);
    return { success: true };
  } catch (err) {
    console.error('[IPC] app:clear-all-data failed:', err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('cloud-sync:status', async () => {
  try {
    const syncService = require('./local-api/sync-service');
    return await syncService.getStatus();
  } catch {
    return null;
  }
});

ipcMain.handle('cloud-sync:trigger', async () => {
  try {
    const syncService = require('./local-api/sync-service');
    await syncService.triggerSyncNow();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── Task 2-b (sub-task 4): FULL data sync on demand ──────────────────────────
// Backs the post-login consent dialog ("Full data sync recommended — sync
// now?"). Runs the engine's FULL reconciliation path:
//   1. _runInitialSyncFromSession() — the staged workspace import; a no-op
//      (fast return) when the workspace is already READY, otherwise it owns
//      first-import recovery,
//   2. syncService.fullSyncNow() — outbox replay (push) + pull from sequence 0
//      (LWW) + record-level reconcile push.
// "Not now" never calls this — the incremental 30s cycle keeps running.
ipcMain.handle('sync:full-now', async () => {
  try {
    const startedAt = Date.now();
    let initResult = null;
    try {
      initResult = await _runInitialSyncFromSession();
    } catch (initErr) {
      console.warn('[IPC] sync:full-now initial-sync stage failed (continuing):', initErr.message);
    }
    let fullResult = null;
    try {
      const syncService = require('./local-api/sync-service');
      if (typeof syncService.fullSyncNow === 'function') {
        fullResult = await syncService.fullSyncNow();
      } else {
        // Older sync-service without fullSyncNow — the incremental trigger is
        // the best available approximation.
        await syncService.triggerSyncNow();
      }
    } catch (fullErr) {
      console.warn('[IPC] sync:full-now full pull failed:', fullErr.message);
      return { success: false, error: fullErr.message, init: initResult || null };
    }
    console.log('[IPC] sync:full-now completed in ' + ((Date.now() - startedAt) / 1000).toFixed(1) + 's');
    return { success: true, init: initResult || null, full: fullResult || null };
  } catch (err) {
    console.error('[IPC] sync:full-now failed:', err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('cloud-sync:initial-sync', async () => {
  try {
    // v2: runs the stage-based initializer (local-api/initial-sync.js) with
    // the current session, sets the engine cursor and starts the engine.
    // Returns { success, totalRecords, duration, error?, alreadyInitialized? }
    // — the shape the loading-screen IPC bridge expects.
    return await _runInitialSyncFromSession();
  } catch (err) {
    console.error('[IPC] cloud-sync:initial-sync failed:', err.message);
    return { success: false, error: err.message };
  }
});

// ─── IPC: Network status from renderer (triggers immediate cloud sync) ──
ipcMain.on('network:online', () => {
  console.log('[Main] Renderer reports network is ONLINE — triggering cloud sync');
  try {
    const syncService = require('./local-api/sync-service');
    syncService.triggerSyncNow && syncService.triggerSyncNow().catch(() => {});
  } catch { /* sync service not loaded yet */ }
});

ipcMain.on('network:offline', () => {
  console.log('[Main] Renderer reports network is OFFLINE — LAN-only mode');
});

// ─── IPC: Local API Session (for embedded Hono server on port 3080) ──
ipcMain.handle('local-api:get-session', async () => {
  try {
    const localApi = require('./local-api/index');
    return localApi.getSession();
  } catch {
    return null;
  }
});

ipcMain.handle('local-api:set-session', async (_event, { token, user }) => {
  try {
    const localApi = require('./local-api/index');
    localApi.setSession(token, user);

    // Also set auth for the background sync service
    try {
      const syncService = require('./local-api/sync-service');
      syncService.setAuth(token, user);
    } catch { /* sync service not loaded yet */ }

    return { success: true };
  } catch (err) {
    console.error('[IPC] local-api:set-session failed:', err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('local-api:clear-session', async () => {
  try {
    const localApi = require('./local-api/index');
    localApi.clearSession();

    // Also clear sync service auth
    try {
      const syncService = require('./local-api/sync-service');
      syncService.clearAuth();
    } catch { /* sync service not loaded yet */ }

    return { success: true };
  } catch (err) {
    console.error('[IPC] local-api:clear-session failed:', err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('local-api:status', async () => {
  try {
    const localApi = require('./local-api/index');
    return localApi.getStatus();
  } catch {
    return { port: null, dbReady: false, sessionActive: false };
  }
});

// ─── IPC: Background Sync Service ──
ipcMain.handle('sync:status', async () => {
  try {
    const syncService = require('./local-api/sync-service');
    return await syncService.getStatus();
  } catch {
    return { isSyncing: false, lastSyncAt: null };
  }
});

// ─── IPC: Renderer Error Reporting ──
// Uncaught renderer errors (window.onerror / unhandledrejection / React
// boundaries) surface HERE with their full stack — in the same terminal that
// runs `bun run electron:dev`. Standing directive: never hide a failure; make
// every crash isolatable from the user's log alone (round 7: the
// "Cannot read properties of null (reading 'split')" report had no stack).
ipcMain.on('renderer:error', (_event, payload) => {
  try {
    const p = payload && typeof payload === 'object' ? payload : { message: String(payload) };
    console.error(`[RendererError] ${p.kind || 'error'}: ${p.message}`);
    if (p.href) console.error(`[RendererError]   at: ${p.href}`);
    if (p.source) console.error(`[RendererError]   source: ${p.source}:${p.line ?? '?'}:${p.column ?? '?'}`);
    if (p.stack) console.error(`[RendererError] stack:\n${p.stack}`);
  } catch (logErr) {
    console.error('[RendererError] (failed to format payload)', logErr && logErr.message);
  }
});

ipcMain.handle('sync:trigger', async () => {
  try {
    const syncService = require('./local-api/sync-service');
    await syncService.triggerSyncNow();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('sync:conflicts', async () => {
  try {
    const syncService = require('./local-api/sync-service');
    return await syncService.getConflicts();
  } catch {
    return [];
  }
});

ipcMain.handle('sync:resolve-conflict', async (_event, { conflictId, resolution }) => {
  try {
    const syncService = require('./local-api/sync-service');
    await syncService.resolveConflict(conflictId, resolution);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC: Local DB query bridge (for desktop renderer to read SQLite cache) ──
// The desktop renderer can query the local API's Prisma database via IPC.

ipcMain.handle('local-db:query', async (_event, { table, options }) => {
  try {
    const localApi = require('./local-api/index');
    const status = localApi.getStatus();
    if (!status.dbReady) return { success: false, error: 'Local database not ready', data: [] };
    const { localDb } = require('./local-api/lib/db');
    const model = localDb[table];
    if (!model) return { success: false, error: `Unknown model: ${table}`, data: [] };
    const data = await model.findMany(options || {});
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message, data: [] };
  }
});

ipcMain.handle('local-db:get-by-id', async (_event, { table, id }) => {
  try {
    const localApi = require('./local-api/index');
    const status = localApi.getStatus();
    if (!status.dbReady) return { success: false, error: 'Local database not ready', data: null };
    const { localDb } = require('./local-api/lib/db');
    const model = localDb[table];
    if (!model) return { success: false, error: `Unknown model: ${table}`, data: null };
    const data = await model.findUnique({ where: { id } });
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message, data: null };
  }
});

ipcMain.handle('local-db:count', async (_event, { table, options }) => {
  try {
    const localApi = require('./local-api/index');
    const status = localApi.getStatus();
    if (!status.dbReady) return { success: false, error: 'Local database not ready', count: 0 };
    const { localDb } = require('./local-api/lib/db');
    const model = localDb[table];
    if (!model) return { success: false, error: `Unknown model: ${table}`, count: 0 };
    const count = await model.count(options || {});
    return { success: true, count };
  } catch (err) {
    return { success: false, error: err.message, count: 0 };
  }
});

ipcMain.handle('local-db:status', async () => {
  try {
    const localApi = require('./local-api/index');
    const status = localApi.getStatus();
    return {
      ready: status.dbReady,
      port: status.port,
      sessionActive: status.sessionActive,
    };
  } catch {
    return { ready: false };
  }
});

app.whenReady().then(async () => {
  console.log(`[BLASTI Desktop] App ready — isDev: ${isDev}, platform: ${process.platform}`);
  console.log(`[BLASTI Desktop] Dev URL: ${DEV_URL}, Prod URL: ${PROD_URL}`);
  console.log(`[BLASTI Desktop] Electron version: ${process.versions.electron}, Node: ${process.versions.node}`);

  // ── Update self-heal (auto-update: download → install → restart) ──────
  // Must run BEFORE anything else: if a newer downloaded installer is still
  // pending, the previous silent install failed — finish it now and let the
  // PowerShell wrapper relaunch the freshly installed build.
  try { selfHealPendingInstaller(); } catch (healErr) {
    console.warn('[BLASTI Desktop] update self-heal failed (non-fatal):', healErr && healErr.message);
  }

  // DELTA UPDATES (0.6.30): finish an asar swap the previous session could
  // not perform (Windows file lock) — BEFORE anything else reads the asar.
  try { selfHealPendingAsarSwap(); } catch (healErr) {
    console.warn('[BLASTI Desktop] asar self-heal failed (non-fatal):', healErr && healErr.message);
  }

  // Task 40: stale-bundle guard — the build stamp is written by prebuild.js on
  // every package. An installed app whose stamp predates the latest fixes is
  // STALE: rebuild (bun run build:desktop) instead of debugging old code.
  let buildStamp = null;
  try { buildStamp = require('./build-stamp.json'); } catch { buildStamp = null; }
  console.log(`[BLASTI Desktop] Build: ${buildStamp && buildStamp.builtAt ? buildStamp.builtAt + (buildStamp.git ? ' (git ' + buildStamp.git + ')' : '') : 'SOURCE (no stamp — dev run)'}${buildStamp && buildStamp.builtAt && new Date(buildStamp.builtAt) < new Date(Date.now() - 30 * 24 * 3600 * 1000) ? ' — WARNING: build is over 30 days old' : ''}`);

  // ── DETERMINISTIC STARTUP ORDER (spec §28) ────────────────────────────
  // 1. resolve authoritative DB path (idempotent)
  // 2. open/init + migrate local DB (inside local API startup)
  // 3. start local API (diagnostics, loading-screen)
  // 4. determine initialization state → launch OR initialization screen
  try { setAuthoritativeDbPath(); } catch (err) {
    console.error('[BLASTI Desktop] FATAL — cannot resolve authoritative DB path:', err.message);
  }
  try { setAuthoritativeFilesDir(); } catch (err) {
    console.warn('[BLASTI Desktop] Could not resolve the local file store dir:', err.message);
  }

  // Set Content Security Policy
  setCSP();

  // ── Wire local→cloud immediacy (v2) ─────────────────────────────────
  // Every pending mutation logged by the local API triggers a debounced
  // (400ms) outbox replay in the sync service. No-op when offline or
  // unauthenticated — the 30s cycle / socket / 'online' paths cover those.
  try {
    const localApi = require('./local-api/index');
    const syncService = require('./local-api/sync-service');
    localApi.setMutationListener(() => {
      try { syncService.onLocalMutation(); } catch { /* engine not ready */ }
    });
    console.log('[BLASTI Desktop] Local mutation → outbox replay listener wired');
  } catch (wireErr) {
    console.warn('[BLASTI Desktop] Failed to wire mutation listener:', wireErr.message);
  }

  // ── LAN discovery beacon (Task 2-b) ────────────────────────────────────
  // Only broadcasts when the local API is LAN-bound (BLASTI_ENABLE_LAN /
  // BLASTI_LAN_BIND — see lib/lan-origin.js). Lets kiosks / other desktops
  // discover this machine on the LAN via UDP :3081 without any port scan.
  try { startLanBeacon(); } catch (beaconErr) {
    console.warn('[BLASTI Desktop] Discovery beacon failed to start (non-fatal):', beaconErr && beaconErr.message);
  }

  // Device install telemetry (Public App Settings rebuild): registers this
  // MACHINE with the cloud (stable fingerprint survives updates/reinstalls →
  // accurate device counts) and heartbeats every 6h. Pushed updates are
  // forwarded to the renderer as 'update:available'.
  try {
    const telemetry = require('./device-telemetry');
    telemetry.startDeviceTelemetry();
  } catch (telErr) {
    console.warn('[BLASTI Desktop] Device telemetry failed to start (non-fatal):', telErr && telErr.message);
  }

  // Task 49: the WINDOW is created FIRST — it is the primary user surface and
  // must appear even if tray creation misbehaves. Historically the tray was
  // created first; any failure above window creation left the app running
  // invisibly ("in Task Manager but never opens"). The tray is secondary and
  // must never block the window.
  createWindow();
  console.log('[BLASTI Desktop] Window created — loading screen active');

  try {
    createTray();
  } catch (err) {
    console.warn('[BLASTI Desktop] Tray creation failed (window unaffected):', err && err.message);
  }

  // Task 49 watchdog: if no window is visible 30s after ready, surface an
  // error box (with the log path) instead of sitting in the background
  // invisibly forever.
  setTimeout(() => {
    const visible = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible();
    if (!visible) {
      console.error('[BLASTI Desktop] Watchdog: no visible window 30s after ready — surfacing error box');
      const file = logFilePath || initFileLogger();
      try {
        dialog.showErrorBox(
          'BLASTI did not open a window',
          'BLASTI is running but no window appeared within 30 seconds.\n\n' +
            'Technical details were written to:\n' + (file || '%APPDATA%\\BLASTI\\logs\\main.log') + '\n\n' +
            'To recover: fully exit BLASTI (system tray → Exit, or Task Manager → end all BLASTI processes), then start it again.'
        );
      } catch { /* */ }
    }
  }, 30000);

  // ── Run Startup Diagnostics ──────────────────────────────────────────
  // The launch gate is already showing. runStartupDiagnostics waits for the
  // gate renderer's ready signal, runs the suite, then reports the verdict
  // to the gate (dev gate: per-step updates; consumer gate: error/success).
  try {
    await runStartupDiagnostics();
  } catch (err) {
    // runStartupDiagnostics handles its own errors — this guard only keeps
    // the whenReady chain alive for the macOS activate handler below.
    console.error('[BLASTI Desktop] Startup diagnostics runner crashed:', err.message);
  }

  // macOS: re-create window when dock icon is clicked
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
});

app.on('window-all-closed', () => {
  // Task 2-b (sub-task 5): the embedded local API must die WITH the app.
  // On Windows/Linux a closed last window now always quits the process —
  // the tray/LAN keep-alive that used to leave :3080 serving with no window
  // is gone (the user-facing "local api still running after close" bug).
  // On macOS the standard keep-active convention is preserved; the embedded
  // services keep serving because the app is still genuinely open there.
  shutdownEmbeddedServices('window-all-closed');
  killBlastiChildProcessTree();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Task 2-b-1: HARD-QUIT BACKSTOP — the quit sequence must never stall with
// the embedded local API (:3080) still serving. Electron CAN stall a quit:
// a renderer's beforeunload handler blocking the window close, a wedged
// keep-alive socket, or a lifecycle hook that never returns all leave the
// process (and :3080) alive after the user closed the app — the exact
// "local api still running after close" report. Arm a 5s timer on the FIRST
// before-quit; if the process is somehow still alive when it fires,
// app.exit(0) bypasses every remaining lifecycle event and tears the process
// down immediately. Cleared on the 'quit' event (normal completion).
let _hardQuitBackstop = null;

app.on('before-quit', () => {
  isQuitting = true;
  // Task 2-b (sub-task 5): idempotent teardown before Electron tears down
  // windows — stops the sync engine, the local API (:3080), the realtime
  // socket, the file-sync worker and the beacon, and purges non-persisted
  // (non remember-me) session state. Safe on double-quit paths.
  shutdownEmbeddedServices('before-quit');
  killBlastiChildProcessTree();
  if (!_hardQuitBackstop) {
    _hardQuitBackstop = setTimeout(() => {
      console.error('[BLASTI Desktop] Quit stalled for 5s — forcing exit so the local API cannot outlive the app');
      try { app.exit(0); } catch { process.exit(0); }
    }, 5000);
  }
});

// ─── Cleanup ──────────────────────────────────────────────────────────────────

app.on('will-quit', () => {
  // Task 2-b (sub-task 5): last-chance teardown (covers quit paths that
  // bypass before-quit, e.g. some auto-updater flows).
  shutdownEmbeddedServices('will-quit');
  killBlastiChildProcessTree();

  // Clean up any resources
  if (tray) {
    tray.destroy();
    tray = null;
  }
});

// Task 2-b (sub-task 5): the process is going away NOW — the embedded HTTP
// server must not hold the event loop open a millisecond longer than needed.
app.on('quit', (_event, exitCode) => {
  console.log('[BLASTI Desktop] Quitting (exit code ' + exitCode + ') — embedded services already stopped');
  shutdownEmbeddedServices('quit');
  killBlastiChildProcessTree();
  // Task 2-b-1: quit completed normally — disarm the hard-quit backstop.
  if (_hardQuitBackstop) { clearTimeout(_hardQuitBackstop); _hardQuitBackstop = null; }
});

} // ── end else (NOT the update waiter) — closes the bail-out opened before
  //   requestSingleInstanceLock: the waiter branch above exits on its own
  //   and must never execute any of the module-level app wiring.
