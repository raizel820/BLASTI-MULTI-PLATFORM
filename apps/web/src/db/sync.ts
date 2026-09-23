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
import { isRevoked, setRevoked, clearRevoked } from '@/lib/authz-state';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * HTTP error with status — lets the engine distinguish "route not found"
 * (the desktop local API predates the WatermelonDB sync endpoints) from
 * auth/agency errors and fall back to the cloud accordingly.
 */
class SyncHttpError extends Error {
  status: number;
  /** Machine-readable error code from the body (e.g. AUTHORIZATION_REVOKED). */
  code: string | null = null;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'SyncHttpError';
  }
}

/**
 * One model's slice of a pull response. Accepts BOTH wire shapes:
 *   - protocol-v2 (cloud): { changed: [...full rows...], deleted: [...ids] }
 *   - legacy (LAN/desktop): { created: [...], updated: [...], deleted: [...ids] }
 */
interface PullPageBucket {
  changed?: unknown[];
  created?: unknown[];
  updated?: unknown[];
  deleted?: unknown[];
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
// Task 33-E: cloud protocol-v2 pull cursor + pagination. The cloud's
// POST /api/sync/pull expects { sinceSequence } and answers with
// pageLastSequence + hasMore; we persist the safe cursor and page through
// hasMore responses (bounded per cycle). Stored in localStorage — cleared on
// login/logout (store) so a new account/agency always re-pulls from 0.
const SYNC_CURSOR_KEY = 'blasti-sync-cursor';
const MAX_PULL_PAGES_PER_CYCLE = 5;

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

  // Task 33-E — explicit-rejection awareness. When the cloud rejects the
  // session (401/403), sync must NOT retry forever: in Electron we pause and
  // let the desktop revocation flow (Task 33-C) confirm; in the browser we
  // heal-or-revoke and stop until the next successful login. Cleared by
  // resumeAfterAuth() (wired to the store's setSessionToken).
  private revokedSession: boolean = false;
  private lastDatabase: Database | null = null;
  private lastIntervalMs: number = DEFAULT_SYNC_INTERVAL_MS;

  /** Persisted protocol-v2 pull cursor (cloud pageLastSequence). */
  private getSyncCursor(): number | null {
    if (!isBrowser) return null;
    try {
      const raw = localStorage.getItem(SYNC_CURSOR_KEY);
      if (!raw) return null;
      const n = parseInt(raw, 10);
      return Number.isFinite(n) && n >= 0 ? n : null;
    } catch {
      return null;
    }
  }

  private setSyncCursor(seq: number): void {
    if (!isBrowser) return;
    try {
      localStorage.setItem(SYNC_CURSOR_KEY, String(seq));
    } catch {
      // ignore
    }
  }

  /** Drop the pull cursor — call on login/logout so a new account re-pulls fully. */
  clearSyncCursor(): void {
    if (!isBrowser) return;
    try {
      localStorage.removeItem(SYNC_CURSOR_KEY);
    } catch {
      // ignore
    }
  }

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

    // Task 33-E — short-circuit while the session is rejected. The soft flag
    // is set by handleAuthRejected (cloud 401/403) or via authz-state
    // (electronAPI.onAuthRevoked → auth-provider → setRevoked). A successful
    // setSessionToken/login calls resumeAfterAuth() which clears both, so a
    // legitimate re-login re-enables sync.
    if (this.revokedSession || isRevoked()) {
      console.log('[SyncEngine] Session revoked — skipping sync until re-login');
      return;
    }

    this.lastDatabase = database;

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

          // Task 33-E — protocol-v2 adaptation: the cloud pull expects
          // { sinceSequence } (it IGNORES lastPulledAt — that field only made
          // sense to the legacy LAN protocol) and answers with a page of
          // changes + pageLastSequence + hasMore. We page through hasMore
          // responses (bounded) and advance the persisted cursor only AFTER
          // the rows are applied (onDidPullChanges below), so a failed apply
          // never skips a page. MISMATCH NOTE (documented, not redesigned in
          // this pass): the retention/reconcile signal (cursor older than the
          // feed's oldestAvailableSequence) is not implemented — if the server
          // ever truncates the feed, a manual logout/login (which clears the
          // cursor) forces a full re-pull.
          let pageCursor = target === 'cloud' ? this.getSyncCursor() : null;
          let collected: Record<string, PullPageBucket> = {};
          let timestamp: number | null = null;
          let latestPageSequence: number | null = null;

          for (let page = 0; page < MAX_PULL_PAGES_PER_CYCLE; page++) {
            const body: Record<string, unknown> = {
              lastPulledAt: since ?? undefined, // legacy LAN servers; ignored by the cloud
            };
            if (target === 'cloud' && pageCursor != null) {
              body.sinceSequence = pageCursor;
            }

            const response = await fetch(this._buildUrl(baseUrl, '/api/sync/pull', target), {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
              },
              credentials: 'include',
              body: JSON.stringify(body),
            });

            if (!response.ok) {
              const errorData = await response.json().catch(() => ({}));
              throw syncHttpErrorFromResponse(response.status, errorData, `Pull failed with status ${response.status}`);
            }

            const data = await response.json().catch(() => null);
            if (!data || typeof data !== 'object') {
              throw new SyncHttpError(0, 'Pull returned an invalid JSON body');
            }

            collected = mergePullPage(collected, data.changes);
            // WDB requires a non-zero NUMBER timestamp; the cloud returns an
            // ISO string. Convert (also tolerate servers already sending ms).
            const ts = toEpochMs(data.timestamp);
            if (ts != null) timestamp = ts;

            if (target !== 'cloud') break; // legacy LAN protocol — single page

            const seq = typeof data.pageLastSequence === 'number' ? data.pageLastSequence : null;
            if (seq != null) latestPageSequence = seq;
            // Keep pulling only while the server reports more pages AND its
            // safe cursor advances (guards against legacy/non-advancing loops).
            if (data.hasMore !== true || seq == null || seq <= (pageCursor ?? 0)) break;
            pageCursor = seq;
          }

          // Local existence index lets the transformer split v2 `changed` rows
          // into WDB's created/updated buckets cleanly (no update-nonexistent
          // log spam). Any failure → null → safe all-`updated` upsert fallback.
          let localIdIndex: Map<string, Set<string>> | null = null;
          try {
            localIdIndex = await buildLocalIdIndex(database, collected);
          } catch {
            localIdIndex = null;
          }

          const changes = transformPullChanges(collected, { localIdIndex });

          console.log('[SyncEngine] Pull complete, timestamp:', timestamp);
          return {
            changes,
            timestamp: timestamp ?? Date.now(),
            // Extra field rides alongside the WDB result; consumed below.
            pageLastSequence: target === 'cloud' ? latestPageSequence : null,
          };
        },

        onDidPullChanges: async (result) => {
          // Rows are now APPLIED to the local DB — only now advance the pull
          // cursor so a crashed apply re-pulls the same page next cycle.
          const seq = (result as { pageLastSequence?: unknown })?.pageLastSequence;
          if (target === 'cloud' && typeof seq === 'number') {
            this.setSyncCursor(seq);
          }
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
            throw syncHttpErrorFromResponse(response.status, errorData, `Push failed with status ${response.status}`);
          }

          console.log('[SyncEngine] Push complete');
        },

        sendCreatedAsUpdated: false,
      });

      // Store epoch ms (WatermelonDB lastPulledAt semantics) — the previous
      // ISO string was never comparable with the WDB timestamp domain.
      const now = String(Date.now());
      this.setLastSyncTimestamp(now);

      this.emit({ type: 'sync-complete', status: this.getStatus() });
      console.log('[SyncEngine] Sync complete at', now, 'via', target);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Sync failed';
      this.lastError = message;
      console.warn('[SyncEngine] Sync failed:', message);

      // Task 33-E — explicit rejection (cloud 401/403, or the desktop local
      // API answering with its AUTHORIZATION_REVOKED lock). Handled BEFORE the
      // LAN branches so a rejected session never loops every 5 min forever.
      // Network-level failures never land here (they don't throw SyncHttpError)
      // and the LAN-404 cooldown below is untouched.
      // NOTE (deliberate refinement of the blanket 401/403 rule): a plain 401
      // from the LAN target inside Electron is the documented TRANSIENT
      // post-reload race (local API sessionUser null before the IPC import
      // fires) — revocation from the local API is signaled distinctly
      // (423 / AUTHORIZATION_REVOKED), so only those plus cloud-target
      // rejections take the revocation path.
      if (
        error instanceof SyncHttpError &&
        (error.status === 401 || error.status === 403) &&
        (target === 'cloud' || error.code === 'AUTHORIZATION_REVOKED')
      ) {
        await this.handleAuthRejected(target, error);
      }
      // LAN server answered 404 on the sync endpoints — its local API build
      // predates the WatermelonDB sync routes. Cool it down and retry this
      // cycle against the cloud instead of failing every 5 minutes with
      // "Sync failed: Not found".
      else if (
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

  /**
   * Task 33-E — clear the revoked/paused state and restart the periodic sync
   * intervals after a successful (re-)authentication. Called by the app
   * store's setSessionToken (fresh login). The persisted revoked flag is
   * cleared separately via clearRevoked() by the same caller/auth-provider.
   */
  resumeAfterAuth(): void {
    this.revokedSession = false;
    if (!isBrowser || !this.lastDatabase) return;
    // Intervals still running (e.g. pause never happened) — nothing to do
    // (also avoids duplicating the online/offline listeners startPeriodicSync owns).
    if (this.syncIntervalId || this.lanProbeIntervalId) return;
    console.log('[SyncEngine] Session re-authenticated — resuming periodic sync');
    this.syncIntervalId = setInterval(() => {
      if (this.lastDatabase) this.sync(this.lastDatabase);
    }, this.lastIntervalMs);
    this.lanProbeIntervalId = setInterval(() => {
      this.probeLanServer().catch(() => {});
    }, LAN_PROBE_INTERVAL_MS);
  }

  /**
   * Task 33-E — the cloud (or the desktop local API with AUTHORIZATION_REVOKED)
   * explicitly rejected this session. Terminal handling per runtime:
   *   - Electron: NEVER self-logout — the desktop revocation flow (Task 33-C)
   *     owns confirmation (refresh → restore, or lock + onAuthRevoked push).
   *     We only pause client sync (soft flag) until the next successful auth.
   *   - Browser + LAN: transient — keep today's re-probe behavior, no logout.
   *   - Browser + cloud: ONE cookie-heal attempt (fresh token without the
   *     poisoned Bearer); if the cookie is dead too → revoke, clear tokens,
   *     stop sync. The next auth-provider render/login flow takes over.
   */
  private async handleAuthRejected(target: 'lan' | 'cloud', error: SyncHttpError): Promise<void> {
    const isElectron = isBrowser && !!(window as any).electronAPI;

    if (isElectron) {
      this.stopPeriodicSync();
      console.log('[SyncEngine] Cloud rejected the session (401/403) — pausing client sync (desktop will confirm revocation)');
      this.revokedSession = true;
      this.lastError = 'Session rejected — sync paused pending revocation check';
      this.emit({ type: 'sync-error', status: this.getStatus(), error: this.lastError });
      return;
    }

    if (target === 'lan') {
      console.log('[SyncEngine] LAN server rejected the session (401/403) — will re-probe next cycle (no logout)');
      this._clearLanServer();
      this.emit({ type: 'sync-error', status: this.getStatus(), error: error.message });
      return;
    }

    // Browser + cloud — attempt ONE refresh via the cookie-heal mechanism
    // (POST /api/auth/refresh-session with the httpOnly cookie, no Bearer).
    try {
      const { healSessionFromCookie, applyHealedSession } = await import('@/lib/session-heal');
      const healed = await healSessionFromCookie();
      if (healed) {
        console.log('[SyncEngine] Cloud rejected the session but the cookie healed it — fresh token adopted, sync continues');
        await applyHealedSession(healed);
        clearRevoked();
        this.revokedSession = false;
        return; // intervals untouched — the next cycle syncs with fresh credentials
      }
    } catch {
      // heal is best-effort — fall through to rejection
    }

    this.stopPeriodicSync();
    console.warn('[SyncEngine] Cloud rejected the session (401/403) — stopping sync until re-login');
    setRevoked('sync-auth-rejected');
    this.revokedSession = true;
    // Minimal token clear (dynamic import — avoids a static cycle with the
    // store; the store's logout() would also navigate, while this minimal
    // clear lets the revoked-flag guards + auth-provider render the login).
    try {
      const { useAppStore } = await import('@/store/use-app-store');
      useAppStore.setState({ user: null, isAuthenticated: false, sessionToken: '' });
    } catch {
      // store unavailable — the persisted revoked flag still guards every path
    }
    try {
      localStorage.removeItem('blasti-session-token');
    } catch {
      // ignore
    }
    this.lastError = 'Authentication required — session rejected, please log in again';
    this.emit({ type: 'sync-error', status: this.getStatus(), error: this.lastError });
  }

  startPeriodicSync(database: Database, intervalMs: number = DEFAULT_SYNC_INTERVAL_MS): () => void {
    this.stopPeriodicSync();
    this.lastDatabase = database;
    this.lastIntervalMs = intervalMs;

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

/**
 * Build a SyncHttpError from an error body, capturing a machine-readable
 * code (SCREAMING_SNAKE, e.g. AUTHORIZATION_REVOKED) when present.
 */
function syncHttpErrorFromResponse(status: number, errorData: unknown, fallbackMessage: string): SyncHttpError {
  const err = (errorData && typeof errorData === 'object' ? (errorData as Record<string, unknown>) : {});
  const raw = typeof err.error === 'string' ? err.error : '';
  const httpError = new SyncHttpError(status, raw || fallbackMessage);
  httpError.code = /^[A-Z][A-Z0-9_]{5,}$/.test(raw) ? raw : null;
  return httpError;
}

/** Coerce a pull timestamp (epoch ms number, epoch-ms string, or ISO string) to epoch ms. */
export function toEpochMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string') {
    if (/^\d+$/.test(value)) {
      const n = Number(value);
      return n > 0 ? n : null;
    }
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/**
 * Merge one pull page into the accumulator. Accepts v2 {changed, deleted} and
 * legacy {created, updated, deleted} buckets; never throws on malformed pages.
 */
export function mergePullPage(
  acc: Record<string, PullPageBucket>,
  page: unknown,
): Record<string, PullPageBucket> {
  if (!page || typeof page !== 'object') return acc;
  for (const [modelName, modelChanges] of Object.entries(page as Record<string, unknown>)) {
    if (!modelChanges || typeof modelChanges !== 'object') continue;
    const mc = modelChanges as PullPageBucket;
    const bucket = acc[modelName] || (acc[modelName] = {});
    if (Array.isArray(mc.changed)) {
      bucket.changed = [...(bucket.changed || []), ...mc.changed];
    }
    if (Array.isArray(mc.created)) {
      bucket.created = [...(bucket.created || []), ...mc.created];
    }
    if (Array.isArray(mc.updated)) {
      bucket.updated = [...(bucket.updated || []), ...mc.updated];
    }
    if (Array.isArray(mc.deleted)) {
      bucket.deleted = [...(bucket.deleted || []), ...mc.deleted];
    }
  }
  return acc;
}

/**
 * Pre-fetch which of the incoming v2 `changed` row ids already exist locally,
 * per WDB table. Unknown tables (the web schema mirrors only a subset of the
 * cloud's 19 synced models — e.g. User/Transaction) resolve to no collection
 * and are omitted; WDB itself skips those tables with a forward-compat log.
 * On any failure the table is omitted → the transformer falls back to the
 * safe all-`updated` upsert.
 */
async function buildLocalIdIndex(
  database: Database,
  serverChanges: Record<string, PullPageBucket> | null | undefined,
): Promise<Map<string, Set<string>>> {
  const index = new Map<string, Set<string>>();
  if (!serverChanges || typeof serverChanges !== 'object') return index;

  for (const [modelName, modelChanges] of Object.entries(serverChanges)) {
    const rows = Array.isArray(modelChanges?.changed) ? modelChanges!.changed : [];
    if (!rows.length) continue;
    const ids = rows
      .filter(isSyncRow)
      .map((row) => row.id as string);
    if (!ids.length) continue;

    const tableName = modelNameToTableName(modelName);
    try {
      const collection = (database as unknown as { get: (t: string) => unknown }).get(tableName);
      if (!collection) continue;
      const existingIds = await (collection as { query: () => { fetchIds: () => Promise<string[]> } }).query().fetchIds();
      index.set(tableName, new Set(existingIds));
    } catch {
      // Index unavailable for this table — transformer falls back to all-updated
    }
  }

  return index;
}

/**
 * Normalize the server pull payload into the shape WatermelonDB's
 * synchronize() consumes: { [tableName]: { created, updated, deleted } }.
 *
 * Task 33-E — DUAL SHAPE (the v2 mismatch crashed every non-empty pull page
 * with "Cannot read properties of undefined (reading 'map')"):
 *   - v2 { changed: [...full rows...], deleted: [...ids] } (cloud)
 *   - legacy { created, updated, deleted } (LAN/desktop)
 *
 * v2 mapping: WDB treats created vs updated identically EXCEPT for records
 * that are locally soft-deleted (created recreates them; updated defers to
 * the local deletion and pushes it later). When a local existence index is
 * available, rows are split by existence (existing → updated, new → created);
 * without it every row goes into `updated`, which WDB applies as a true
 * upsert (missing rows are created). Zero data loss either way.
 */
export function transformPullChanges(
  serverChanges: Record<string, PullPageBucket> | null | undefined,
  opts: { localIdIndex?: Map<string, Set<string>> | null } = {},
): Record<string, { created: any[]; updated: any[]; deleted: string[] }> {
  const result: Record<string, { created: any[]; updated: any[]; deleted: string[] }> = {};

  // Crash guard: empty/undefined serverChanges → empty change set (no throw).
  if (!serverChanges || typeof serverChanges !== 'object') return result;

  for (const [modelName, modelChanges] of Object.entries(serverChanges)) {
    const mc = (modelChanges && typeof modelChanges === 'object' ? modelChanges : {}) as PullPageBucket;
    const tableName = modelNameToTableName(modelName);
    // Crash guard: every array access defaults to [] (never trust the wire).
    const deleted = (Array.isArray(mc.deleted) ? mc.deleted : []).filter(
      (id): id is string => typeof id === 'string',
    );

    if (Array.isArray(mc.changed)) {
      // protocol-v2: rows carry the FULL record (no op flag).
      const changed = mc.changed.filter(isSyncRow);
      const index = opts.localIdIndex?.get(tableName);
      const created: any[] = [];
      const updated: any[] = [];
      for (const row of changed) {
        if (index ? index.has(row.id as string) : true) {
          updated.push(transformRecord(row));
        } else {
          created.push(transformRecord(row));
        }
      }
      result[tableName] = { created, updated, deleted };
    } else {
      // Legacy LAN shape — created/updated kept as-is (existing behavior).
      result[tableName] = {
        created: (Array.isArray(mc.created) ? mc.created : []).filter(isSyncRow).map(transformRecord),
        updated: (Array.isArray(mc.updated) ? mc.updated : []).filter(isSyncRow).map(transformRecord),
        deleted,
      };
    }
  }

  return result;
}

/** WDB requires raw rows to be objects with an id (validateRemoteRaw). */
function isSyncRow(row: unknown): row is Record<string, unknown> {
  return !!row && typeof row === 'object' && typeof (row as Record<string, unknown>).id === 'string';
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
