/**
 * BLASTI WatermelonDB Sync Engine — LAN-First with Cloud Fallback
 *
 * This sync engine automatically detects BLASTI desktop servers on the LAN
 * and routes sync traffic to them when available. This enables true
 * offline-first operation: kiosks and tablets sync with the desktop's
 * local SQLite cache via the LAN, and the desktop's own cloud-sync loop
 * handles pushing changes to the remote server.
 *
 * Sync routing priority:
 *   1. If a BLASTI desktop is discovered on LAN → sync to desktop (port 3080)
 *   2. Otherwise → sync to cloud /api/sync/*
 *
 * The desktop speaks the exact same WatermelonDB sync protocol as the cloud,
 * so the client code is identical — only the base URL changes.
 *
 * Uses dynamic imports for all WatermelonDB code to avoid bundling
 * browser-only modules during SSR compilation.
 */

'use client';

import type { Database } from '@nozbe/watermelondb';
import { buildCloudUrl } from '@/lib/api-client';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * HTTP error with status — lets the engine distinguish "route not found"
 * (the desktop local API predates the WatermelonDB sync endpoints) from
 * auth/agency errors and fall back to the cloud accordingly.
 */
class SyncHttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'SyncHttpError';
  }
}

export interface SyncStatus {
  lastSync: string | null;
  isSyncing: boolean;
  pendingChanges: number;
  lastError: string | null;
  syncTarget: 'lan' | 'cloud' | 'unknown';
  lanServerIp: string | null;
  lanServerPort: number | null;
}

export interface SyncEvent {
  type: 'sync-start' | 'sync-progress' | 'sync-complete' | 'sync-error' | 'target-changed';
  status?: SyncStatus;
  error?: string;
  syncTarget?: 'lan' | 'cloud';
}

type SyncEventListener = (event: SyncEvent) => void;

// ─── Constants ──────────────────────────────────────────────────────────────

const LAST_SYNC_KEY = 'blasti-wdb-last-sync';
const DEFAULT_SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const LAN_PROBE_INTERVAL_MS = 30 * 1000; // Re-probe LAN every 30s
const LAN_PROBE_TIMEOUT_MS = 2000; // 2s timeout for LAN server probe
const LAN_SYNC_BASE_PATH = '/api/sync'; // Same path on desktop LAN server
const LAN_UNSUPPORTED_COOLDOWN_MS = 5 * 60 * 1000; // Retry LAN sync 5 min after a 404

const isBrowser = typeof window !== 'undefined';

// ─── Sync Engine Class ──────────────────────────────────────────────────────

class SyncEngine {
  private listeners: Set<SyncEventListener> = new Set();
  private isSyncing: boolean = false;
  private syncIntervalId: ReturnType<typeof setInterval> | null = null;
  private lanProbeIntervalId: ReturnType<typeof setInterval> | null = null;
  private lastError: string | null = null;

  // LAN server state
  private lanServerUrl: string | null = null;  // e.g. 'http://192.168.1.50:3080'
  private lanServerIp: string | null = null;
  private lanServerPort: number | null = null;
  private lastLanProbeAt: number = 0;

  // When the discovered LAN server answers 404 on /api/sync/pull (an older
  // desktop build whose local API has no WatermelonDB sync routes), stop
  // targeting it for sync for a while instead of failing every cycle with
  // "Sync failed: Not found". Status probing continues so we recover
  // automatically when the desktop app is updated/restarted.
  private lanSyncUnsupportedUntil: number = 0;

  private emit(event: SyncEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (e) {
        console.error('[SyncEngine] Listener error:', e);
      }
    }
  }

  onEvent(listener: SyncEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getLastSyncTimestamp(): string | null {
    if (!isBrowser) return null;
    try {
      return localStorage.getItem(LAST_SYNC_KEY);
    } catch {
      return null;
    }
  }

  private setLastSyncTimestamp(ts: string): void {
    if (!isBrowser) return;
    try {
      localStorage.setItem(LAST_SYNC_KEY, ts);
    } catch {
      // ignore
    }
  }

  getStatus(): SyncStatus {
    return {
      lastSync: this.getLastSyncTimestamp(),
      isSyncing: this.isSyncing,
      pendingChanges: 0,
      lastError: this.lastError,
      syncTarget: this.lanServerUrl ? 'lan' : 'cloud',
      lanServerIp: this.lanServerIp,
      lanServerPort: this.lanServerPort,
    };
  }

  private getAuthToken(): string | null {
    if (!isBrowser) return null;
    try {
      const native = localStorage.getItem('blasti-session-token');
      if (native) return native;
      const nextAuth = localStorage.getItem('next-auth.session-token');
      if (nextAuth) return nextAuth;
      // Web: the cloud JWT lives in the persisted zustand store
      // ('blasti-app' → state.sessionToken). Without this fallback the web
      // sync engine never found a token and silently skipped every cycle.
      const storeData = localStorage.getItem('blasti-app');
      if (storeData) {
        try {
          const parsed = JSON.parse(storeData);
          return parsed?.state?.sessionToken || null;
        } catch {
          return null;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  // ─── LAN Server Discovery ──────────────────────────────────────────────────

  /**
   * Try to discover a BLASTI desktop server on the LAN.
   * Uses the lan-discovery module which listens for UDP beacons.
   * Falls back to probing common LAN IPs on port 3080.
   */
  private async probeLanServer(): Promise<string | null> {
    if (!isBrowser) return null;
    if (!navigator.onLine) {
      // When offline, we MUST use LAN sync if available
      // Don't skip the probe just because the internet is down
    }

    const now = Date.now();
    if (now - this.lastLanProbeAt < 5000) {
      // Throttle: don't probe more than once per 5 seconds
      return this.lanServerUrl;
    }
    this.lastLanProbeAt = now;

    // Strategy 0: In Electron, always try the local API on 127.0.0.1:3080 first.
    // This is the desktop app's own embedded API — no discovery needed.
    const isElectron = !!(window as any).electronAPI;
    if (isElectron) {
      const localApiUrl = 'http://127.0.0.1:3080';
      const isAlive = await this._probeSyncEndpoint(localApiUrl);
      if (isAlive) {
        this._setLanServer(localApiUrl, '127.0.0.1', 3080);
        return localApiUrl;
      }
    }

    // Strategy 1: Check cached LAN server from discovery module
    try {
      const { getCachedServer, quickDiscover } = await import('@/lib/lan-discovery');
      let server = getCachedServer();
      if (!server) {
        server = await quickDiscover().catch(() => null);
      }
      if (server && server.ip && (server.apiPort || server.port)) {
        const port = server.apiPort || server.port;
        // Skip servers on cloud/web ports (3000, 3003) — those are not LAN sync servers
        if (port === 3000 || port === 3003) {
          console.log('[SyncEngine] Skipping discovered server on cloud port:', port);
        } else {
          const url = `http://${server.ip}:${port}`;
          const isAlive = await this._probeSyncEndpoint(url);
          if (isAlive) {
            this._setLanServer(url, server.ip, port);
            return url;
          }
        }
      }
    } catch {
      // lan-discovery not available, fall through to manual probe
    }

    // Strategy 2: Probe known LAN IPs (from localStorage cache or current origin)
    const candidates = this._getLanCandidateUrls();
    for (const url of candidates) {
      const isAlive = await this._probeSyncEndpoint(url);
      if (isAlive) {
        try {
          const u = new URL(url);
          this._setLanServer(url, u.hostname, parseInt(u.port, 10));
          return url;
        } catch {
          // invalid URL
        }
      }
    }

    // No LAN server found
    if (this.lanServerUrl) {
      console.log('[SyncEngine] LAN server no longer available — switching to cloud');
      this._clearLanServer();
    }
    return null;
  }

  /**
   * Probe a LAN server's /api/sync/status endpoint to verify it's alive
   * and is a BLASTI sync server.
   */
  private async _probeSyncEndpoint(baseUrl: string): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), LAN_PROBE_TIMEOUT_MS);

      const response = await fetch(`${baseUrl}/api/sync/status`, {
        method: 'GET',
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) return false;
      const data = await response.json();
      return data.service === 'blasti-lan-sync' || data.local?.ready === true;
    } catch {
      return false;
    }
  }

  /**
   * Get candidate LAN server URLs to probe.
   * Includes cached server from localStorage + the LAN API port derived
   * from the current page origin (if served from the desktop app).
   *
   * IMPORTANT: We do NOT add the page origin itself as a candidate because:
   * - In Electron dev, the origin is localhost:3000 (Next.js dev server)
   *   which does NOT serve /api/sync/status — the local API is on port 3080.
   * - Adding the origin causes 404 spam in the Next.js dev server logs.
   */
  private _getLanCandidateUrls(): string[] {
    const candidates: string[] = [];

    // For Electron: always try 127.0.0.1:3080 (the embedded local API)
    const isElectron = !!(window as any).electronAPI;
    if (isElectron) {
      candidates.push('http://127.0.0.1:3080');
    }

    // Cached server from previous discovery
    try {
      const cached = localStorage.getItem('blasti-lan-server-cache');
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed.url) {
          // Skip cached URLs pointing to the Next.js dev server (port 3000/3003)
          // — those never serve /api/sync/status
          try {
            const u = new URL(parsed.url);
            const port = parseInt(u.port, 10);
            if (port === 3000 || port === 3003) {
              console.log('[SyncEngine] Skipping cached URL pointing to dev server:', parsed.url);
              localStorage.removeItem('blasti-lan-server-cache');
            } else if (!candidates.includes(parsed.url)) {
              candidates.push(parsed.url);
            }
          } catch {
            candidates.push(parsed.url);
          }
        }
      }
    } catch {}

    // Current page origin (if we're being served from the desktop app)
    if (typeof window !== 'undefined' && window.location) {
      const origin = window.location.origin;
      const isElectron = !!(window as any).electronAPI;
      const isLanIp = origin.includes('192.168.') || origin.includes('10.') ||
                      (origin.includes('172.') && parseInt(origin.split('.')[1] || '0') >= 16);
      if (isElectron || isLanIp) {
        // Derive the LAN API URL by replacing the web port with 3080.
        // Only add this derived URL, NOT the origin itself — the origin
        // is the Next.js web server which does not have sync endpoints.
        const lanUrl = origin.replace(':3000', ':3080').replace(':3003', ':3080');
        if (lanUrl !== origin && !candidates.includes(lanUrl)) {
          candidates.push(lanUrl);
        }
      }
    }

    return candidates;
  }

  private _setLanServer(url: string, ip: string, port: number): void {
    const wasLan = this.lanServerUrl !== null;
    this.lanServerUrl = url;
    this.lanServerIp = ip;
    this.lanServerPort = port;

    // Cache for future probes
    try {
      localStorage.setItem('blasti-lan-server-cache', JSON.stringify({ url, ip, port }));
    } catch {}

    if (!wasLan) {
      console.log(`[SyncEngine] LAN server found — syncing to ${url}`);
      this.emit({ type: 'target-changed', syncTarget: 'lan', status: this.getStatus() });
    }
  }

  private _clearLanServer(): void {
    this.lanServerUrl = null;
    this.lanServerIp = null;
    this.lanServerPort = null;
    try {
      localStorage.removeItem('blasti-lan-server-cache');
    } catch {}
    this.emit({ type: 'target-changed', syncTarget: 'cloud', status: this.getStatus() });
  }

  /**
   * Get the sync base URL for this sync cycle.
   * Returns the LAN server URL if available, otherwise the cloud URL (relative path).
   */
  private async getSyncBaseUrl(): Promise<{ baseUrl: string; target: 'lan' | 'cloud' }> {
    const lanUrl = await this.probeLanServer();
    if (lanUrl && Date.now() >= this.lanSyncUnsupportedUntil) {
      return { baseUrl: lanUrl, target: 'lan' };
    }
    // Cloud target: resolved by the shared cloud-URL helper — absolute
    // http://localhost:3003 on a loopback host, relative + XTransformPort
    // behind a single-port gateway.
    return { baseUrl: '', target: 'cloud' };
  }

  /**
   * Build a full URL for a sync endpoint.
   * LAN target → absolute URL on the desktop server.
   * Cloud target → routed through the shared cloud-URL builder (direct
   * :3003 on loopback, gateway-hinted relative path otherwise).
   */
  private _buildUrl(baseUrl: string, path: string, target: 'lan' | 'cloud'): string {
    if (target === 'lan' && baseUrl) return `${baseUrl}${path}`;
    return buildCloudUrl(path);
  }

  // ─── Main Sync Cycle ────────────────────────────────────────────────────────

  /**
   * Perform a full sync cycle using WatermelonDB's synchronize().
   * Dynamically imports the synchronize function to avoid SSR bundling issues.
   */
  async sync(database: Database, isRetry: boolean = false): Promise<void> {
    if (this.isSyncing) return;
    if (!isBrowser) return;

    // Check connectivity — but only skip if BOTH internet AND LAN are down
    const { baseUrl, target } = await this.getSyncBaseUrl();

    if (target === 'cloud' && !navigator.onLine) {
      console.log('[SyncEngine] Offline and no LAN server — skipping sync');
      return;
    }

    this.isSyncing = true;
    this.lastError = null;
    this.emit({ type: 'sync-start', status: this.getStatus() });

    try {
      const token = this.getAuthToken();
      if (!token) {
        console.log('[SyncEngine] No auth token — skipping sync');
        this.emit({ type: 'sync-complete', status: this.getStatus() });
        return;
      }

      const lastPulledAt = this.getLastSyncTimestamp();

      // Dynamic import of synchronize — avoids bundling WDB for SSR.
      // CRITICAL: WatermelonDB exports `synchronize` from the `/sync` subpath
      // ONLY — the main entry does NOT re-export it (verified on 0.28.0).
      // The old `import('@nozbe/watermelondb')` destructured `undefined` and
      // every sync cycle failed with "SyncEngine] Sync failed: synchronize
      // is not a function".
      const { synchronize } = await import('@nozbe/watermelondb/sync');

      console.log(`[SyncEngine] Syncing via ${target.toUpperCase()}${baseUrl ? ` (${baseUrl})` : ''}`);

      // WatermelonDB 0.28 synchronize takes a SINGLE SyncArgs object
      // ({ database, pullChanges, pushChanges, ... }) — the legacy
      // two-argument call shape would destructure `database` from the
      // Database instance and crash inside the sync impl.
      await synchronize({
        database,

        pullChanges: async ({ lastPulledAt: wdbLastPulledAt }) => {
          const since = wdbLastPulledAt || lastPulledAt;
          console.log('[SyncEngine] Pulling changes since:', since);

          const response = await fetch(this._buildUrl(baseUrl, '/api/sync/pull', target), {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            credentials: 'include',
            body: JSON.stringify({
              lastPulledAt: since || undefined,
            }),
          });

          if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new SyncHttpError(
              response.status,
              errorData.error || `Pull failed with status ${response.status}`,
            );
          }

          const data = await response.json();
          const timestamp = data.timestamp;
          const changes = transformPullChanges(data.changes);

          console.log('[SyncEngine] Pull complete, timestamp:', timestamp);
          return { changes, timestamp };
        },

        pushChanges: async ({ changes, lastPulledAt }) => {
          console.log('[SyncEngine] Pushing changes to', target);

          const response = await fetch(this._buildUrl(baseUrl, '/api/sync/push', target), {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            credentials: 'include',
            body: JSON.stringify({
              changes,
              lastPulledAt,
            }),
          });

          if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new SyncHttpError(
              response.status,
              errorData.error || `Push failed with status ${response.status}`,
            );
          }

          console.log('[SyncEngine] Push complete');
        },

        sendCreatedAsUpdated: false,
      });

      const now = new Date().toISOString();
      this.setLastSyncTimestamp(now);

      this.emit({ type: 'sync-complete', status: this.getStatus() });
      console.log('[SyncEngine] Sync complete at', now, 'via', target);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Sync failed';
      this.lastError = message;
      console.warn('[SyncEngine] Sync failed:', message);

      // LAN server answered 404 on the sync endpoints — its local API build
      // predates the WatermelonDB sync routes. Cool it down and retry this
      // cycle against the cloud instead of failing every 5 minutes with
      // "Sync failed: Not found".
      if (
        target === 'lan' &&
        error instanceof SyncHttpError &&
        error.status === 404
      ) {
        this.lanSyncUnsupportedUntil = Date.now() + LAN_UNSUPPORTED_COOLDOWN_MS;
        this._clearLanServer();
        console.warn('[SyncEngine] LAN server has no /api/sync/pull route — falling back to cloud for', LAN_UNSUPPORTED_COOLDOWN_MS / 1000, 's');
        if (!isRetry) {
          this.isSyncing = false;
          return this.sync(database, true);
        }
      } else if (target === 'lan') {
        // Any other LAN failure — clear the cache so the next cycle re-probes
        console.log('[SyncEngine] LAN sync failed — will re-probe next cycle');
        this._clearLanServer();
      }

      this.emit({ type: 'sync-error', status: this.getStatus(), error: message });
    } finally {
      this.isSyncing = false;
    }
  }

  startPeriodicSync(database: Database, intervalMs: number = DEFAULT_SYNC_INTERVAL_MS): () => void {
    this.stopPeriodicSync();

    if (!isBrowser) return () => {};

    // Initial sync after 3s (let the app settle + run LAN probe)
    setTimeout(() => this.sync(database), 3000);

    // Periodic sync
    this.syncIntervalId = setInterval(() => {
      this.sync(database);
    }, intervalMs);

    // LAN probe loop — re-probe every 30s even if not syncing
    // This ensures we switch to LAN quickly when a desktop comes online
    this.lanProbeIntervalId = setInterval(() => {
      this.probeLanServer().catch(() => {});
    }, LAN_PROBE_INTERVAL_MS);

    const goOnline = () => {
      console.log('[SyncEngine] Back online — triggering sync');
      setTimeout(() => this.sync(database), 2000);
    };

    const goOffline = () => {
      console.log('[SyncEngine] Went offline — probing LAN server');
      // When internet drops, urgently probe for LAN server
      this.probeLanServer().then(() => {
        if (this.lanServerUrl) {
          setTimeout(() => this.sync(database), 1000);
        }
      }).catch(() => {});
    };

    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);

    return () => {
      this.stopPeriodicSync();
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }

  stopPeriodicSync(): void {
    if (this.syncIntervalId) {
      clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }
    if (this.lanProbeIntervalId) {
      clearInterval(this.lanProbeIntervalId);
      this.lanProbeIntervalId = null;
    }
  }
}

// ─── Pull Changes Transformer ───────────────────────────────────────────────

function transformPullChanges(
  serverChanges: Record<string, { created: any[]; updated: any[]; deleted: string[] }>,
): Record<string, { created: any[]; updated: any[]; deleted: string[] }> {
  const result: Record<string, { created: any[]; updated: any[]; deleted: string[] }> = {};

  for (const [modelName, modelChanges] of Object.entries(serverChanges)) {
    const tableName = modelNameToTableName(modelName);

    result[tableName] = {
      created: modelChanges.created.map(transformRecord),
      updated: modelChanges.updated.map(transformRecord),
      deleted: modelChanges.deleted,
    };
  }

  return result;
}

function modelNameToTableName(modelName: string): string {
  const map: Record<string, string> = {
    Agency: 'agencies',
    Service: 'services',
    Branch: 'branches',
    Counter: 'counters',
    Reservation: 'reservations',
    Notification: 'notifications',
    QueueSettings: 'queue_settings',
    // Also handle snake_case (LAN server already returns snake_case)
    agencies: 'agencies',
    services: 'services',
    branches: 'branches',
    counters: 'counters',
    reservations: 'reservations',
    notifications: 'notifications',
    queue_settings: 'queue_settings',
  };
  return map[modelName] || modelName.toLowerCase() + 's';
}

function transformRecord(record: any): any {
  const transformed: any = {};

  for (const [key, value] of Object.entries(record)) {
    // Keep snake_case keys as-is (LAN server returns snake_case, cloud returns camelCase→converted)
    let outKey = key;

    // If the key is camelCase, convert to snake_case
    if (/[a-z][A-Z]/.test(key)) {
      outKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
    }

    if (typeof value === 'string' && isISODate(value)) {
      transformed[outKey] = new Date(value).getTime();
    } else if (typeof value === 'boolean') {
      transformed[outKey] = value ? 1 : 0;
    } else {
      transformed[outKey] = value;
    }
  }

  return transformed;
}

function isISODate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value);
}

// ─── Singleton ──────────────────────────────────────────────────────────────

export const syncEngine = new SyncEngine();
