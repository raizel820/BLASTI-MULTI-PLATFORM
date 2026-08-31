/**
 * BLASTI Desktop — Electron Preload Script
 *
 * Exposes a safe `electronAPI` bridge to the renderer process.
 * This is the ONLY way the web app can access Node.js/Electron APIs.
 *
 * The exposed API is designed to match the interface expected by:
 *   - `apps/web/src/lib/native-bridge.ts` (ElectronAPI interface)
 *   - `apps/web/src/lib/platform.ts` (platform detection via window.electronAPI)
 *   - `apps/web/src/lib/adapters/` (notification, deep-link, etc.)
 *
 * Security: contextIsolation is true, nodeIntegration is false.
 * All communication goes through ipcRenderer.send / ipcRenderer.invoke / ipcRenderer.on.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ─── Platform Detection ────────────────────────────────────────────────────

  /**
   * Flag used by the web app's platform.ts to detect Electron.
   * The platform detection code checks: !!window.electronAPI || ua.includes('Electron')
   */
  isElectron: true,

  /**
   * Returns 'electron' — used by native-bridge.ts and adapters
   * to route to the correct platform implementation.
   */
  getPlatform: () => ipcRenderer.invoke('get-platform'),

  // ─── Deep Links ────────────────────────────────────────────────────────────

  /**
   * Listen for incoming blasti:// deep link URLs.
   * The main process sends 'deep-link' events when:
   *   - A second instance is opened with a blasti:// URL
   *   - macOS open-url event fires with a blasti:// URL
   */
  onDeepLink: (callback) => {
    ipcRenderer.on('deep-link', (_event, url) => callback(url));
  },

  // ─── Notifications ─────────────────────────────────────────────────────────

  /**
   * Listen for native notification click events forwarded from the main process.
   */
  onNotification: (callback) => {
    ipcRenderer.on('notification:clicked', (_event, data) => callback(data));
  },

  /**
   * Show an OS-level notification.
   * The main process creates a Notification instance and shows it.
   * Clicking the notification focuses the app window.
   */
  showNotification: (title, body) => {
    ipcRenderer.send('notification:send', { title, body });
  },

  // Legacy alias — used by native-bridge.ts
  sendNotification: (title, body) => {
    ipcRenderer.send('notification:send', { title, body });
  },

  // ─── Badge ─────────────────────────────────────────────────────────────────

  /**
   * Set the dock/taskbar badge count.
   * macOS: Shows a red badge on the dock icon.
   * Windows: Sets the overlay icon (if badge image is available).
   */
  setBadge: (count) => {
    ipcRenderer.send('badge:set', count);
  },

  // ─── Window Controls ──────────────────────────────────────────────────────

  /**
   * Quit the entire application.
   */
  quit: () => {
    ipcRenderer.send('app:quit');
  },

  /**
   * Minimize the main window.
   */
  minimize: () => {
    ipcRenderer.send('window:minimize');
  },

  /**
   * Toggle maximize/restore on the main window.
   */
  maximize: () => {
    ipcRenderer.send('window:maximize');
  },

  /**
   * Close the main window (minimize to tray if tray is available).
   */
  close: () => {
    ipcRenderer.send('window:close');
  },

  /**
   * Check if the main window is currently maximized.
   */
  isMaximized: () => ipcRenderer.invoke('window:is-maximized'),

  /**
   * Listen for maximize state changes.
   */
  onMaximizeChange: (callback) => {
    ipcRenderer.on('window:maximized-changed', (_event, isMaximized) => callback(isMaximized));
  },

  // ─── Auto-Update ───────────────────────────────────────────────────────────

  /**
   * Listen for auto-update available events.
   * In production, this would be triggered by electron-updater.
   */
  onUpdateAvailable: (callback) => {
    ipcRenderer.on('update:available', (_event, info) => callback(info));
  },

  /**
   * Listen for update downloaded events.
   * In production, triggered after electron-updater downloads an update.
   */
  onUpdateDownloaded: (callback) => {
    ipcRenderer.on('update:downloaded', () => callback());
  },

  /**
   * Trigger the installation of a downloaded update.
   * In production, this calls autoUpdater.quitAndInstall().
   */
  installUpdate: () => {
    ipcRenderer.send('update:install');
  },

  // ─── Silent Print ───────────────────────────────────────────────────────────

  /**
   * Trigger a silent print (no dialog) of the current page.
   * Phase 8c: Added for kiosk mode printing support.
   */
  printSilent: () => ipcRenderer.invoke('printer:print-silent'),

  /**
   * Listen for silent print result events.
   * Callback receives { success: boolean, error?: string }.
   */
  onPrintResult: (callback) => ipcRenderer.on('printer:print-result', (_event, result) => callback(result)),

  /**
   * Get the list of available printers on the system.
   * Phase 8c: Added for kiosk mode printer selection.
   * @returns {Promise<Array>} List of printer objects with name, status, etc.
   */
  getPrinters: () => ipcRenderer.invoke('get-printers'),

  // ─── Offline Retry ──────────────────────────────────────────────────────────

  /**
   * Retry loading the web app after an offline error.
   * The main process will attempt to reload the app URL.
   */
  retryOffline: () => {
    ipcRenderer.send('offline:retry');
  },

  // ─── App Info ──────────────────────────────────────────────────────────────

  /**
   * Get the application version string.
   */
  getAppVersion: () => ipcRenderer.invoke('app:version'),

  // ─── LAN Discovery ─────────────────────────────────────────────────────────

  /**
   * Get the local LAN server information.
   * Returns { ip, port, webPort, apiPort, hostname } or null if the LAN server isn't running.
   */
  getLanServerInfo: () => ipcRenderer.invoke('lan:server-info'),

  /**
   * Listen for discovered BLASTI servers on the LAN.
   * Not used by the desktop itself (it IS the server), but available for future mesh scenarios.
   */
  onLanDiscovery: (callback) => {
    ipcRenderer.on('lan:discovery', (_event, data) => callback(data));
  },

  // ─── TV Screen / Second Monitor (HDMI) ────────────────────────────────────

  /**
   * Open a fullscreen TV display window on the second monitor (HDMI).
   * Automatically detects external display. Falls back to primary if none found.
   * @param {Object} options - { url?: string } - TV board URL (defaults to local dev URL)
   * @returns {Promise<{ success: boolean, display?: Object, error?: string }>}
   */
  openTvScreen: (options) => ipcRenderer.invoke('tv-screen:open', options || {}),

  /**
   * Close the TV screen window if it's currently open.
   * @returns {Promise<{ success: boolean }>}
   */
  closeTvScreen: () => ipcRenderer.invoke('tv-screen:close'),

  /**
   * Check if a TV screen window is currently open.
   * @returns {Promise<{ isOpen: boolean }>}
   */
  getTvScreenStatus: () => ipcRenderer.invoke('tv-screen:status'),

  // ─── Local Server Event Relay ────────────────────────────────────────────────

  /**
   * Emit a realtime event to LAN clients via the local Socket.IO server.
   * Used by the Electron renderer to relay events to kiosk tablets on the LAN.
   * @param {Object} data - { type: string, payload: any, room?: string }
   */
  localEmit: (data) => ipcRenderer.send('local:emit', data),

  // ─── Cloud Sync (desktop main process ↔ cloud server) ─────────────────────

  /**
   * Provide the NextAuth JWT token to the main process so the cloud sync
   * loop can authenticate with the remote API.
   * Called by the renderer after login.
   * @param {Object} params - { token: string, user: { id, role, agencyId } }
   */
  setCloudSyncAuth: (params) => ipcRenderer.invoke('cloud-sync:set-auth', params),

  /**
   * Clear the cloud sync auth token (called on logout).
   */
  clearCloudSyncAuth: () => ipcRenderer.invoke('cloud-sync:clear-auth'),

  /**
   * Get the current cloud sync status.
   * @returns {Promise<{ isSyncing, lastSync, lastError, hasAuth, apiBase }>}
   */
  getCloudSyncStatus: () => ipcRenderer.invoke('cloud-sync:status'),

  /**
   * Trigger an immediate cloud sync (manual sync button).
   */
  triggerCloudSync: () => ipcRenderer.invoke('cloud-sync:trigger'),

  /**
   * Trigger an initial full sync after login (pulls all agency data).
   */
  initialCloudSync: () => ipcRenderer.invoke('cloud-sync:initial-sync'),

  // ─── Network Status (renderer → main process) ──────────────────────────────

  /**
   * Notify main process that the renderer detected the network is online.
   * The main process will immediately trigger a cloud sync.
   */
  networkOnline: () => ipcRenderer.send('network:online'),

  /**
   * Notify main process that the renderer detected the network is offline.
   * The main process will log the state and continue in LAN-only mode.
   */
  networkOffline: () => ipcRenderer.send('network:offline'),

  // ─── Local API Session (for embedded Hono server) ────────────────────────

  /**
   * Get the local API session token.
   * The renderer uses this token in every request to the embedded API.
   * @returns {Promise<{ token: string; user: Object } | null>}
   */
  getLocalApiSession: () => ipcRenderer.invoke('local-api:get-session'),

  /**
   * Set the local API session (called after login).
   * @param {Object} params - { token: string, user: Object }
   */
  setLocalApiSession: (params) => ipcRenderer.invoke('local-api:set-session', params),

  /**
   * Clear the local API session (called on logout).
   */
  clearLocalApiSession: () => ipcRenderer.invoke('local-api:clear-session'),

  /**
   * Get the local API server status.
   * @returns {Promise<{ port: number|null, dbReady: boolean, sessionActive: boolean }>}
   */
  getLocalApiStatus: () => ipcRenderer.invoke('local-api:status'),

  // ─── Loading Screen / Diagnostics ───────────────────────────────────────────

  /**
   * Signal the main process that the loading screen is ready to receive
   * diagnostic updates. Must be called BEFORE diagnostics start.
   */
  loadingScreenReady: () => {
    ipcRenderer.send('loading:ready');
  },

  /**
   * Listen for diagnostic progress updates from the main process.
   * Each update is { step: string, status: 'running'|'success'|'warning'|'error', message: string }
   * Used by the loading screen to display real-time diagnostic progress.
   */
  onDiagnosticsUpdate: (callback) => {
    ipcRenderer.on('diagnostics:update', (_event, data) => callback(data));
  },

  /**
   * Signal the main process that the user wants to proceed past the loading screen.
   * Called when the user clicks "Launch App" on the loading screen (e.g. after errors).
   */
  finishLoading: () => {
    ipcRenderer.send('loading:finish');
  },

  /**
   * Listen for the diagnostics finalized event.
   * This fires when the main process has finished ALL diagnostic steps (or crashed).
   * The loading screen uses this to handle partial completions (some steps skipped).
   * Callback receives { completedSteps: string[], totalSteps: number }.
   */
  onDiagnosticsFinalized: (callback) => {
    ipcRenderer.on('diagnostics:finalized', (_event, data) => callback(data));
  },

  /**
   * Quit the application (used by loading screen error banner).
   */
  quitApp: () => {
    ipcRenderer.send('app:quit');
  },

  // ─── Background Sync Service ──────────────────────────────────────────────

  /**
   * Get the background sync service status.
   * @returns {Promise<{ isSyncing: boolean, lastSyncAt: number|null, ... }>}
   */
  getSyncStatus: () => ipcRenderer.invoke('sync:status'),

  /**
   * Trigger an immediate background sync cycle.
   * @returns {Promise<{ success: boolean, error?: string }>}
   */
  triggerSync: () => ipcRenderer.invoke('sync:trigger'),

  /**
   * Get the list of unresolved sync conflicts.
   * @returns {Promise<Array>}
   */
  getSyncConflicts: () => ipcRenderer.invoke('sync:conflicts'),

  /**
   * Resolve a sync conflict by choosing local or cloud version.
   * @param {Object} params - { conflictId: string, resolution: 'local'|'cloud' }
   * @returns {Promise<{ success: boolean, error?: string }>}
   */
  resolveSyncConflict: (params) => ipcRenderer.invoke('sync:resolve-conflict', params),

  // ─── Local DB (main-process SQLite cache) ──────────────────────────────────

  /**
   * Query records from the main-process SQLite cache.
   * @param {Object} params - { table: string, options?: { agencyId?, limit? } }
   * @returns {Promise<{ success, data: Array }>}
   */
  queryLocalDb: (params) => ipcRenderer.invoke('local-db:query', params),

  /**
   * Get a single record by ID from the SQLite cache.
   * @param {Object} params - { table: string, id: string }
   * @returns {Promise<{ success, data: Object|null }>}
   */
  getLocalDbRecord: (params) => ipcRenderer.invoke('local-db:get-by-id', params),

  /**
   * Count records in a table.
   * @param {Object} params - { table: string, options?: { agencyId? } }
   * @returns {Promise<{ success, count: number }>}
   */
  countLocalDb: (params) => ipcRenderer.invoke('local-db:count', params),

  /**
   * Get local DB status (ready, tables, lastCloudSync).
   */
  getLocalDbStatus: () => ipcRenderer.invoke('local-db:status'),

  /**
   * Listen for local DB change events (when kiosks push new data).
   * The callback receives { tables: string[], stats: { applied, rejected }, timestamp }
   */
  onLocalDbChanged: (callback) => {
    ipcRenderer.on('local-db:changed', (_event, data) => callback(data));
  },
});

