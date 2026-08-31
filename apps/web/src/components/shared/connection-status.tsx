'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Wifi, WifiOff, RefreshCw, CloudOff, Monitor, X, Stethoscope, Server } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useRealtime } from '@/hooks/use-realtime';
import { useOnlineStatus } from '@/hooks/use-online-status';
import { useOfflineSync } from '@/hooks/use-offline-sync';
import { getApiBaseUrl } from '@/lib/api-client';
import { detectPlatform } from '@/lib/platform';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Combined health status for cloud + LAN APIs. */
export interface ApiHealthStatus {
  cloudReachable: boolean | null;  // null = not yet checked
  lanReachable: boolean | null;    // null = not checked (non-Electron) or unknown
}

// ─── Module-level Health Check State ──────────────────────────────────────

let _healthStatus: ApiHealthStatus = {
  cloudReachable: null,
  lanReachable: null,
};
let _healthListeners: Array<(status: ApiHealthStatus) => void> = [];
let _cloudWentDownAt: number = 0;
let _consecutiveCloudFailures = 0;
let _consecutiveLanFailures = 0;

/**
 * Perform a combined health check: cloud API + LAN (Electron only).
 *
 * On **web**: only checks cloud (no LAN server available).
 *
 * On **Electron**:
 * - Always checks cloud first.
 * - When cloud is down, also checks LAN (localhost:3080/api/health).
 * - This lets the UI distinguish "cloud down, LAN working" (local mode)
 *   from "both down" (truly offline).
 *
 * Uses exponential backoff on cloud checks to avoid spamming ERR_CONNECTION_REFUSED.
 * LAN checks are lightweight (1.5s timeout) and only run when cloud is down.
 */
async function checkApiHealth(): Promise<ApiHealthStatus> {
  const platform = detectPlatform();
  const { isElectron } = platform;

  // ── 1. Check Cloud API ───────────────────────────────────────────────
  try {
    const controller = new AbortController();
    // In Electron, use shorter timeout when cloud is known-down to fail fast
    const timeout = isElectron && _consecutiveCloudFailures > 0 ? 1_500 : 3_000;
    const timer = setTimeout(() => controller.abort(), timeout);
    // Use the resolved API base URL + /health to hit the actual cloud API server.
    // On web, getApiBaseUrl() returns '' (relative), so we add XTransformPort=3003
    // to route through the gateway to the cloud API on port 3003.
    const baseUrl = getApiBaseUrl();
    const healthPath = '/health';
    let healthUrl = `${baseUrl}${healthPath}`;
    // Inject XTransformPort for web platform (relative URL, not Electron/Capacitor)
    if (!baseUrl && typeof window !== 'undefined' && !isElectron && !(window as any).Capacitor) {
      healthUrl += '?XTransformPort=3003';
    }
    const res = await fetch(healthUrl, { signal: controller.signal });
    clearTimeout(timer);
    _healthStatus.cloudReachable = res.ok || (res.status >= 200 && res.status < 500);
    if (_healthStatus.cloudReachable) {
      _consecutiveCloudFailures = 0; // Reset on success
      // Cloud is back — LAN status is no longer relevant
      _healthStatus.lanReachable = null;
      console.log(`[HealthCheck] CLOUD OK (${res.status})`);
    } else {
      console.log(`[HealthCheck] CLOUD respond ${res.status} (not OK)`);
    }
  } catch (err) {
    _healthStatus.cloudReachable = false;
    _consecutiveCloudFailures++;
    console.log(`[HealthCheck] CLOUD FAIL (${_consecutiveCloudFailures} consecutive)`);
  }

  // ── 2. In Electron, check LAN when cloud is down ────────────────────
  // This is the key fix: instead of only knowing "cloud is down", we now
  // know whether the LAN server (port 3080) is also available.
  if (isElectron && !_healthStatus.cloudReachable) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1_500);
      const res = await fetch('http://127.0.0.1:3080/api/health', {
        signal: controller.signal,
      });
      clearTimeout(timer);
      _healthStatus.lanReachable = res.ok;
      if (_healthStatus.lanReachable) {
        _consecutiveLanFailures = 0;
        console.log(`[HealthCheck] LAN OK (3080)`);
      } else {
        console.log(`[HealthCheck] LAN respond ${res.status} (not OK)`);
      }
    } catch {
      _healthStatus.lanReachable = false;
      _consecutiveLanFailures++;
      console.log(`[HealthCheck] LAN FAIL (${_consecutiveLanFailures} consecutive)`);
    }
  }

  // Notify all listeners with updated status
  _healthListeners.forEach((fn) => fn({ ..._healthStatus }));
  console.log(`[HealthCheck] result: cloud=${_healthStatus.cloudReachable}, lan=${_healthStatus.lanReachable}, nextCheckIn=${getCheckInterval()}ms`);
  return { ..._healthStatus };
}

/**
 * Calculate the next health check interval with exponential backoff.
 *
 * - Web or cloud up: fixed 20s
 * - Electron, cloud down + LAN up: 40s → 60s → 90s → 120s (app is functional, no rush)
 * - Electron, cloud down + LAN down: 20s → 40s → 60s → 90s → 120s (more urgent)
 */
function getCheckInterval(): number {
  const { isElectron } = typeof window !== 'undefined' ? detectPlatform() : { isElectron: false };
  if (!isElectron || _consecutiveCloudFailures === 0) {
    return 20_000;
  }
  // When LAN is up, start with a higher base interval (app is functional)
  const baseInterval = _healthStatus.lanReachable ? 40_000 : 20_000;
  // Exponential backoff: base * 2^(failures-1), capped at 120s
  const backoff = Math.min(baseInterval * Math.pow(2, Math.max(0, _consecutiveCloudFailures - 1)), 120_000);
  return backoff;
}

/**
 * Hook to get combined API health status (cloud + LAN in Electron).
 * Starts a periodic check and returns the current status.
 * Uses exponential backoff in Electron when cloud is down.
 */
export function useCloudReachability(): boolean {
  const [reachable, setReachable] = useState<boolean | null>(null);

  useEffect(() => {
    // Initial check
    checkApiHealth().then((s) => setReachable(s.cloudReachable));

    // Listen for updates from other callers
    const listener = (s: ApiHealthStatus) => setReachable(s.cloudReachable);
    _healthListeners.push(listener);

    // Periodic check with dynamic interval (backoff when cloud is down in Electron)
    let timeoutId: ReturnType<typeof setTimeout>;
    const scheduleNext = () => {
      timeoutId = setTimeout(() => {
        checkApiHealth().then((s) => {
          setReachable(s.cloudReachable);
          scheduleNext();
        });
      }, getCheckInterval());
    };
    scheduleNext();

    return () => {
      _healthListeners = _healthListeners.filter((fn) => fn !== listener);
      clearTimeout(timeoutId);
    };
  }, []);

  return reachable ?? true; // Default to true to avoid flash of offline on first load
}

/**
 * Hook to get the full combined health status (cloud + LAN).
 * Use this when you need to differentiate "cloud down, LAN working" from "both down".
 */
export function useApiHealthStatus(): ApiHealthStatus {
  const [status, setStatus] = useState<ApiHealthStatus>({ cloudReachable: null, lanReachable: null });

  useEffect(() => {
    // Initial check
    checkApiHealth().then(setStatus);

    // Listen for updates
    const listener = (s: ApiHealthStatus) => setStatus(s);
    _healthListeners.push(listener);

    // Periodic check
    let timeoutId: ReturnType<typeof setTimeout>;
    const scheduleNext = () => {
      timeoutId = setTimeout(() => {
        checkApiHealth().then((s) => {
          setStatus(s);
          scheduleNext();
        });
      }, getCheckInterval());
    };
    scheduleNext();

    return () => {
      _healthListeners = _healthListeners.filter((fn) => fn !== listener);
      clearTimeout(timeoutId);
    };
  }, []);

  return status;
}

/**
 * Event-based callback for when cloud goes down (used by page.tsx to show diagnosis).
 * Module-level so it can be accessed from any component.
 */
type CloudStatusCallback = (isDown: boolean) => void;
const _cloudDownCallbacks: CloudStatusCallback[] = [];

export function onCloudStatusChange(cb: CloudStatusCallback): () => void {
  _cloudDownCallbacks.push(cb);
  return () => {
    const idx = _cloudDownCallbacks.indexOf(cb);
    if (idx >= 0) _cloudDownCallbacks.splice(idx, 1);
  };
}

// ─── Derived Status Helpers ───────────────────────────────────────────────

/**
 * Determine the effective connection mode from the health status.
 * - 'online': Cloud is reachable — everything works normally
 * - 'local-mode': Cloud down but LAN is up (Electron) — app works locally
 * - 'offline': Both cloud and LAN down — WatermelonDB fallback only
 */
export type ConnectionMode = 'online' | 'local-mode' | 'offline';

function getEffectiveMode(
  browserOnline: boolean,
  cloudReachable: boolean | null,
  lanReachable: boolean | null,
  isConnected: boolean,
): ConnectionMode {
  if (!browserOnline) return 'offline';
  if (cloudReachable === true) return 'online';
  if (cloudReachable === false) {
    // Cloud is down — check if we're in Electron with LAN
    if (lanReachable === true) return 'local-mode';
    if (lanReachable === false) return 'offline';
    // LAN not yet checked — assume local-mode in Electron, offline on web
    if (typeof window !== 'undefined' && navigator.userAgent.includes('Electron')) {
      return 'local-mode';
    }
    return 'offline';
  }
  // cloudReachable === null (not yet checked) — default to online
  return 'online';
}

// ─── Connection Status Banner ─────────────────────────────────────────────

/**
 * Connection status indicator that shows when the realtime connection is lost
 * or when the cloud API is unreachable.
 *
 * Displays a subtle banner at the top when offline.
 * Shows "Reconnecting..." when trying to reconnect.
 * Auto-dismisses when connection is restored.
 * When connection returns, triggers offline queue sync automatically.
 * Includes a "Diagnose" button to open the offline diagnosis panel.
 *
 * In Electron, differentiates between:
 * - **Local mode** (amber): Cloud down, but LAN server is working — app is fully functional
 * - **Offline** (red): Both cloud and LAN down — WatermelonDB fallback only
 */
export function ConnectionStatus() {
  const { isConnected, connectionStatus } = useRealtime();
  const isBrowserOnline = useOnlineStatus();
  const { cloudReachable, lanReachable } = useApiHealthStatus();
  const [showRestored, setShowRestored] = useState(false);
  const [dismissBanner, setDismissBanner] = useState(false);
  const { pendingCount, syncNow } = useOfflineSync();

  // Detect cloud going down for the first time → notify listeners
  const wasCloudUpRef = useRef(true);
  useEffect(() => {
    if (cloudReachable === true) {
      wasCloudUpRef.current = true;
      _cloudWentDownAt = 0;
    } else if (cloudReachable === false && wasCloudUpRef.current) {
      // Cloud just went down
      wasCloudUpRef.current = false;
      _cloudWentDownAt = Date.now();
      _cloudDownCallbacks.forEach((cb) => cb(true));
    }
  }, [cloudReachable]);

  // Track when connection is restored after being offline
  const prevOfflineRef = useRef(false);
  useEffect(() => {
    const mode = getEffectiveMode(isBrowserOnline, cloudReachable, lanReachable, isConnected);
    const wasOffline = prevOfflineRef.current;

    if (mode === 'offline') {
      prevOfflineRef.current = true;
    } else if (wasOffline) {
      // Connection was restored after being offline
      prevOfflineRef.current = false;

      // Reset dismiss state when coming back online
      setDismissBanner(false);

      // Trigger offline queue sync when coming back online
      if (pendingCount > 0) {
        syncNow().catch(() => {});
      }

      // Notify listeners cloud is back
      _cloudDownCallbacks.forEach((cb) => cb(false));

      // Show "Connection restored" banner
      const showTimer = setTimeout(() => {
        setShowRestored(true);
      }, 0);
      const hideTimer = setTimeout(() => {
        setShowRestored(false);
      }, 3000);
      return () => {
        clearTimeout(showTimer);
        clearTimeout(hideTimer);
      };
    }
  }, [isBrowserOnline, cloudReachable, lanReachable, isConnected, pendingCount, syncNow]);

  // Derive UI state from health status
  const mode = getEffectiveMode(isBrowserOnline, cloudReachable, lanReachable, isConnected);
  const isReconnecting = isBrowserOnline && !isConnected && connectionStatus === 'connecting';

  // Show banner when: offline, local-mode, reconnecting, or just restored
  // But allow dismissal for non-critical states (local-mode, reconnecting)
  const showBanner = !dismissBanner && (mode === 'offline' || mode === 'local-mode' || isReconnecting || showRestored);

  return (
    <AnimatePresence>
      {showBanner && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.3, ease: 'easeInOut' }}
          className="overflow-hidden"
        >
          <div
            className={`flex items-center justify-between gap-2 px-4 py-2 text-xs font-medium ${
              showRestored
                ? 'bg-emerald-500 text-white'
                : mode === 'offline'
                ? 'bg-rose-500 text-white'
                : mode === 'local-mode'
                ? 'bg-amber-500 text-white'
                : 'bg-amber-500 text-white'
            }`}
          >
            <div className="flex items-center gap-2">
              {showRestored ? (
                <>
                  <Wifi className="h-3.5 w-3.5" />
                  <span>Connection restored</span>
                  {pendingCount > 0 && (
                    <span className="opacity-80">· Syncing {pendingCount} pending item{pendingCount > 1 ? 's' : ''}...</span>
                  )}
                </>
              ) : mode === 'offline' ? (
                <>
                  <WifiOff className="h-3.5 w-3.5" />
                  <span>You&apos;re offline — some features may be unavailable</span>
                  {pendingCount > 0 && (
                    <span className="opacity-80">· {pendingCount} pending item{pendingCount > 1 ? 's' : ''}</span>
                  )}
                </>
              ) : mode === 'local-mode' ? (
                <>
                  <Monitor className="h-3.5 w-3.5" />
                  <span>Running in local mode — cloud sync paused</span>
                  <Server className="h-3 w-3 opacity-70" />
                </>
              ) : isReconnecting ? (
                <>
                  <motion.div
                    animate={{ rotate: 360 }}
                    transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                  </motion.div>
                  <span>Reconnecting...</span>
                </>
              ) : null}
            </div>
            {/* Diagnose button for local-mode/offline/reconnecting banners */}
            {(mode === 'local-mode' || mode === 'offline' || isReconnecting) && isBrowserOnline && (
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => {
                    // Dispatch custom event to open diagnosis panel
                    window.dispatchEvent(new CustomEvent('blasti:show-diagnosis'));
                  }}
                  className="h-6 px-2 rounded-full flex items-center gap-1 bg-white/20 hover:bg-white/30 transition-colors text-[11px] font-medium"
                >
                  <Stethoscope className="h-3 w-3" />
                  Diagnose
                </button>
                <button
                  onClick={() => setDismissBanner(true)}
                  className="h-5 w-5 rounded-full flex items-center justify-center hover:bg-white/20 transition-colors"
                  aria-label="Dismiss"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * A small dot indicator showing the realtime connection status.
 * Green when connected, gray/amber when not.
 * Designed to be placed subtly in headers.
 */
export function ConnectionDot() {
  const { isConnected, connectionStatus } = useRealtime();
  const { cloudReachable, lanReachable } = useApiHealthStatus();
  const isBrowserOnline = useOnlineStatus();

  const mode = getEffectiveMode(isBrowserOnline, cloudReachable, lanReachable, isConnected);

  return (
    <span
      className={`inline-block h-2 w-2 rounded-full transition-colors duration-300 ${
        mode === 'offline'
          ? 'bg-rose-500'
          : mode === 'local-mode'
          ? 'bg-amber-500'
          : isConnected
          ? 'bg-emerald-500'
          : connectionStatus === 'connecting'
          ? 'bg-amber-500 animate-pulse'
          : 'bg-gray-400'
      }`}
      title={
        mode === 'offline'
          ? 'Offline'
          : mode === 'local-mode'
          ? 'Local mode (cloud unavailable)'
          : isConnected
          ? 'Connected'
          : connectionStatus === 'connecting'
          ? 'Reconnecting...'
          : 'Disconnected'
      }
    />
  );
}
