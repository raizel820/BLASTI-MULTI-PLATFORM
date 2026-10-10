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
        const file = logFilePath || initFileLogger();
        if (file) fs.appendFileSync(file, `[${new Date().toISOString()}] [${level}] ${args.map(fmt).join(' ')}\n`);
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
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) {
    showFatalErrorBox(
      'BLASTI — error',
      'A startup step failed before the window opened:\n\n' +
        ((reason && (reason.message || String(reason))) || 'unknown')
    );
  }
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
  return JSON.stringify({
    service: 'blasti-local',
    name: getMachineDisplayName(),
    hostname: getMachineDisplayName(),
    lanIp: getLocalIP(),
    httpPort: 3080,
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

  // ── Window Close → Minimize to Tray ──────────────────────────────────────

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();

      // If tray exists, hide to tray; otherwise just hide the window
      if (tray) {
        mainWindow.hide();
      } else {
        // No tray — just minimize
        mainWindow.minimize();
      }
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
  if (tray) {
    mainWindow?.hide();
  } else {
    mainWindow?.close();
  }
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

// Auto-update handlers (placeholder — requires electron-updater in production)
ipcMain.on('update:install', () => {
  // In production, this would call autoUpdater.quitAndInstall()
  console.log('[BLASTI Desktop] Update install requested — electron-updater not configured');
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

ipcMain.handle('cloud-sync:set-auth', async (_event, { token, user }) => {
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
    } catch (initErr) {
      console.warn('[IPC] Failed to launch initial sync:', initErr.message);
    }

    // Persist auth to file so the loading screen can import agency data on next launch
    try {
      const authPath = path.join(app.getPath('userData'), 'blasti-auth.json');
      fs.writeFileSync(authPath, JSON.stringify({ token, user }, null, 2));
      console.log('[IPC] Cloud sync auth saved to', authPath);
    } catch (saveErr) {
      console.warn('[IPC] Failed to save auth file:', saveErr.message);
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
      const authPath = path.join(app.getPath('userData'), 'blasti-auth.json');
      if (fs.existsSync(authPath)) {
        fs.unlinkSync(authPath);
        console.log('[IPC] Auth file removed');
      }
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
  // On macOS, apps typically stay active until explicitly quit.
  // On Windows/Linux, also keep alive if we have a tray icon or LAN server
  // so the LAN server and discovery beacon continue running.
  if (process.platform !== 'darwin') {
    if (tray || localServer) {
      console.log('[BLASTI Desktop] Window closed — keeping app alive (tray/LAN server active)');
      return;
    }
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
});

// ─── Cleanup ──────────────────────────────────────────────────────────────────

app.on('will-quit', () => {
  // Clean up LAN discovery beacon (Task 2-b)
  stopLanBeacon();

  // Clean up any resources
  if (tray) {
    tray.destroy();
    tray = null;
  }
});
