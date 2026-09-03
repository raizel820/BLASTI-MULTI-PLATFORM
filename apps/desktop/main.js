/**
 * BLASTI Desktop — Electron Main Process
 *
 * @blasti/desktop Electron shell for the BLASTI (بلاصتي) queue management app.
 *
 * Strategy: Remote web app shell
 *   • Development: loads http://localhost:3000 (Next.js dev server)
 *   • Production:  loads the deployed web URL or bundled static files
 *                  Falls back to an offline page when unreachable.
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
} = require('electron');
const path = require('path');
const fs = require('fs');

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
  (function () {
    try { return require('electron-is-dev'); } catch { return false; }
  })();

// ─── Constants ────────────────────────────────────────────────────────────────

const DEV_URL = 'http://localhost:3000';
const PROD_URL = process.env.BLASTI_API_URL || 'https://blasti.vercel.app';
const PROTOCOL = 'blasti';

// Path to bundled static web files (from Next.js export)
const STATIC_WEB_DIR = path.join(__dirname, 'out');

// Keep global references to prevent garbage collection
let mainWindow = null;
let tray = null;
let isQuitting = false;

// ─── Global Error Handling ────────────────────────────────────────────────────
// Prevent silent crashes — log all unhandled errors and keep the process alive.
process.on('uncaughtException', (err) => {
  console.error('[BLASTI Desktop] UNCAUGHT EXCEPTION:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[BLASTI Desktop] UNHANDLED REJECTION:', reason);
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

// Discovery beacon state (module-scope so cleanup can access them)
let discoverySocket = null;
let discoveryInterval = null;

// ─── Single Instance Lock ─────────────────────────────────────────────────────

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine) => {
    // Someone tried to run a second instance, focus our window instead
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }

    // Parse deep link from second-instance command line
    const url = commandLine.find((arg) => arg.startsWith(`${PROTOCOL}://`));
    if (url && mainWindow) {
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
    const csp = [
      "default-src 'self'",
      // Allow scripts from self and eval (needed for Next.js HMR in dev)
      isDev ? "script-src 'self' 'unsafe-eval' 'unsafe-inline'" : "script-src 'self'",
      // Allow styles from self and inline (needed for styled-components / Tailwind)
      "style-src 'self' 'unsafe-inline'",
      // Allow images from self, data URIs, and blob URIs
      "img-src 'self' data: blob: https:",
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
  // Use a simple tray icon — in production, replace with a proper .ico/.png
  const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');

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
      console.log('[BLASTI Desktop] Loading ' + DEV_URL);
      mainWindow.loadURL(DEV_URL);
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
    // Explicit remote URL mode — probe the server first
    const request = net.request(remoteUrl);
    let settled = false;
    const fallback = () => {
      if (settled) return;
      settled = true;
      try { request.abort(); } catch { /* ignore */ }
      if (hasBundledFiles) {
        mainWindow.loadFile(indexPath);
      } else {
        mainWindow.loadURL(
          `data:text/html;charset=utf-8,${encodeURIComponent(OFFLINE_HTML)}`
        );
      }
    };
    // Electron's net.request does NOT have setTimeout — use a manual timer
    const timeout = setTimeout(fallback, 5000);
    request.on('response', () => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      mainWindow.loadURL(remoteUrl);
    });
    request.on('error', () => {
      clearTimeout(timeout);
      fallback();
    });
    try { request.end(); } catch { fallback(); }
    return;
  }

  // Default production: load bundled static files
  if (hasBundledFiles) {
    mainWindow.loadFile(indexPath);
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

/**
 * Show the branded loading screen while diagnostics run.
 * This is the FIRST thing the user sees on app launch.
 */
function loadLoadingScreen() {
  loadingScreenActive = true;
  try {
    const { getLoadingHTML } = require('./loading-screen');
    const html = getLoadingHTML();
    mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    console.log('[BLASTI Desktop] Loading screen displayed');
  } catch (err) {
    console.error('[BLASTI Desktop] Failed to load loading screen:', err.message);
    // Fallback: just load the app directly
    loadingScreenActive = false;
    loadApp();
  }
}

/**
 * Called when diagnostics are done (or user clicks "Launch" on error).
 * Dismisses the loading screen and loads the main web app.
 */
function finishLoadingAndLoadApp() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  loadingScreenActive = false;
  console.log('[BLASTI Desktop] Loading complete — loading main app');
  loadApp();
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
    finishLoadingAndLoadApp();
  } else if (diagnosticsDone && !diagnosticsAllPassed) {
    console.warn('[BLASTI Desktop] Launch blocked — not all diagnostics passed');
  }
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
      icon: path.join(__dirname, 'assets', 'icon.png'),
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
        const badgePath = path.join(__dirname, 'assets', 'badge.png');
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

// ─── IPC: Auth bridge for cloud sync ────────────────────────────────────────
// The renderer process (which has access to NextAuth cookies) sends the JWT
// token to the main process so the cloud sync loop can authenticate.

ipcMain.handle('cloud-sync:set-auth', async (_event, { token, user }) => {
  try {
    const syncService = require('./local-api/sync-service');
    syncService.setAuth(token, user);

    // Ensure sync service is started (it may not have been started yet)
    try {
      const { localDb } = require('./local-api/lib/db');
      if (localDb && !syncService.getStatus()?.isStarted) {
        const isDevMode = process.env.NODE_ENV === 'development' || process.env.ELECTRON_DEV === '1';
        const syncCloudUrl = isDevMode
          ? (process.env.BLASTI_API_URL || 'http://localhost:3003')
          : (process.env.BLASTI_CLOUD_URL || 'https://blasti.vercel.app');
        syncService.startSync({
          localDb,
          cloudBaseUrl: syncCloudUrl,
          agencyId: user?.agencyId || '',
        });
        console.log('[IPC] Sync service started after auth — cloud:', syncCloudUrl);
      }
    } catch (startErr) {
      console.warn('[IPC] Failed to start sync service:', startErr.message);
    }

    // Trigger immediate initial sync to pull all agency data from cloud
    try {
      syncService.initialSync().then((result) => {
        if (result?.success) {
          console.log('[IPC] Initial sync after login: pulled', result.pulled, 'pushed', result.pushed);
        } else {
          console.warn('[IPC] Initial sync after login failed:', result?.error);
        }
      }).catch((err) => {
        console.warn('[IPC] Initial sync after login error:', err.message);
      });
    } catch { /* non-blocking */ }

    // Persist auth to file so the loading screen can import agency data on next launch
    try {
      const authPath = path.join(app.getPath('userData'), 'blasti-auth.json');
      fs.writeFileSync(authPath, JSON.stringify({ token, user }, null, 2));
      console.log('[IPC] Cloud sync auth saved to', authPath);
    } catch (saveErr) {
      console.warn('[IPC] Failed to save auth file:', saveErr.message);
    }

    // Also import session into local API immediately
    try {
      const localApi = require('./local-api/index');
      localApi.setSession(token, user);
      console.log('[IPC] Session imported to local API');
    } catch (localErr) {
      console.warn('[IPC] Failed to import session to local API:', localErr.message);
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
    const syncService = require('./local-api/sync-service');
    const result = await syncService.initialSync();
    return result;
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

  // Set Content Security Policy
  setCSP();

  // Create the system tray
  createTray();

  // Create the main window (shows loading screen)
  createWindow();
  console.log('[BLASTI Desktop] Window created — loading screen active');

  // ── Run Startup Diagnostics ──────────────────────────────────────────
  // The loading screen is already showing. Wait for the renderer to signal
  // that it has registered its IPC listeners, then run diagnostics.
  try {
    const { runDiagnostics } = require('./loading-screen');
    const userDataPath = app.getPath('userData');
    const isDevMode = process.env.NODE_ENV === 'development' ||
              process.env.ELECTRON_DEV === '1';
    const cloudBaseUrl = isDevMode
      ? (process.env.BLASTI_API_URL || 'http://localhost:3003')
      : (process.env.BLASTI_CLOUD_URL || 'https://blasti.vercel.app');

    // Wait for the loading screen renderer to register its listeners.
    // Without this, early IPC events may fire before the renderer is ready.
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

    const diagResult = await runDiagnostics(mainWindow, {
      cloudBaseUrl,
      isDev: isDevMode,
      userDataPath,
    });

    console.log(`[Diagnostics] All checks done — allPassed: ${diagResult.allPassed}`);

    // Mark diagnostics complete. Allow launch if no errors (warnings are OK — they
    // represent expected skip conditions like no auth before first login).
    diagnosticsDone = true;
    const hasErrors = diagResult.results.some(r => r.status === 'error');
    diagnosticsAllPassed = !hasErrors;
    console.log(`[Diagnostics] allPassed: ${diagnosticsAllPassed} — ${diagResult.results.filter(r => r.status === 'success').length}/${diagResult.results.length} success, ${diagResult.results.filter(r => r.status === 'warning').length} warnings, ${diagResult.results.filter(r => r.status === 'error').length} errors`);
  } catch (err) {
    console.error('[Diagnostics] Failed to run diagnostics:', err.message);
    // Diagnostics themselves crashed — do NOT auto-launch.
    // The loading screen will show whatever steps completed. If the local API
    // step never reported a status, the user will see an incomplete set of
    // steps and can click "Launch" manually if they choose to proceed.
    diagnosticsDone = true;
    diagnosticsAllPassed = false; // crashed = not all passed
    // Send the finalized event so the loading screen knows diagnostics are done
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
  // Clean up LAN discovery beacon
  if (discoveryInterval) clearInterval(discoveryInterval);
  if (discoverySocket) discoverySocket.close();

  // Clean up any resources
  if (tray) {
    tray.destroy();
    tray = null;
  }
});
