
import { useState, useEffect, useRef } from 'react';
import { Wifi, WifiOff, RefreshCw } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useRealtime } from '@/hooks/use-realtime';
import { useOnlineStatus } from '@/hooks/use-online-status';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Cloud API health status. */
export interface ApiHealthStatus {
  cloudReachable: boolean | null;  // null = not yet checked
}

// ─── Module-level Health Check State ──────────────────────────────────────

let _healthStatus: ApiHealthStatus = {
  cloudReachable: null,
};
let _healthListeners: Array<(status: ApiHealthStatus) => void> = [];
let _consecutiveCloudFailures = 0;

/**
 * Perform a cloud API health check.
 * Uses exponential backoff on failures to avoid spamming ERR_CONNECTION_REFUSED.
 */
async function checkApiHealth(): Promise<ApiHealthStatus> {
  // ── Check Cloud API ───────────────────────────────────────────────
  try {
    const controller = new AbortController();
    const timeout = _consecutiveCloudFailures > 0 ? 1_500 : 3_000;
    const timer = setTimeout(() => controller.abort(), timeout);
    // Desktop: health check goes to the local API server
    const healthUrl = '/health';
    const res = await fetch(healthUrl, { signal: controller.signal });
    clearTimeout(timer);
    _healthStatus.cloudReachable = res.ok || (res.status >= 200 && res.status < 500);
    if (_healthStatus.cloudReachable) {
      _consecutiveCloudFailures = 0;
    }
  } catch {
    _healthStatus.cloudReachable = false;
    _consecutiveCloudFailures++;
  }

  // Notify all listeners
  _healthListeners.forEach((fn) => fn({ ..._healthStatus }));
  return { ..._healthStatus };
}

/**
 * Calculate the next health check interval with exponential backoff.
 */
function getCheckInterval(): number {
  if (_consecutiveCloudFailures === 0) {
    return 20_000;
  }
  const backoff = Math.min(20_000 * Math.pow(2, Math.max(0, _consecutiveCloudFailures - 1)), 120_000);
  return backoff;
}

/**
 * Hook to get cloud API health status.
 * Starts a periodic check and returns the current status.
 */
export function useCloudReachability(): boolean {
  const [reachable, setReachable] = useState<boolean | null>(null);

  useEffect(() => {
    checkApiHealth().then((s) => setReachable(s.cloudReachable));

    const listener = (s: ApiHealthStatus) => setReachable(s.cloudReachable);
    _healthListeners.push(listener);

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
 * Hook to get the full health status.
 */
export function useApiHealthStatus(): ApiHealthStatus {
  const [status, setStatus] = useState<ApiHealthStatus>({ cloudReachable: null });

  useEffect(() => {
    checkApiHealth().then(setStatus);

    const listener = (s: ApiHealthStatus) => setStatus(s);
    _healthListeners.push(listener);

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
 * Event-based callback for when cloud goes down.
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

// ─── Connection Status Banner ─────────────────────────────────────────────

/**
 * Connection status indicator that shows when the realtime connection is lost
 * or when the cloud API is unreachable.
 */
export function ConnectionStatus() {
  const { isConnected, connectionStatus } = useRealtime();
  const isBrowserOnline = useOnlineStatus();
  const { cloudReachable } = useApiHealthStatus();
  const [showRestored, setShowRestored] = useState(false);
  const [dismissBanner, setDismissBanner] = useState(false);

  // Track cloud going down
  const wasCloudUpRef = useRef(true);
  useEffect(() => {
    if (cloudReachable === true) {
      wasCloudUpRef.current = true;
    } else if (cloudReachable === false && wasCloudUpRef.current) {
      wasCloudUpRef.current = false;
      _cloudDownCallbacks.forEach((cb) => cb(true));
    }
  }, [cloudReachable]);

  // Track when connection is restored after being offline
  const prevOfflineRef = useRef(false);
  useEffect(() => {
    const isOffline = !isBrowserOnline || cloudReachable === false;
    const wasOffline = prevOfflineRef.current;

    if (isOffline) {
      prevOfflineRef.current = true;
    } else if (wasOffline) {
      prevOfflineRef.current = false;
      setDismissBanner(false);
      _cloudDownCallbacks.forEach((cb) => cb(false));

      const showTimer = setTimeout(() => setShowRestored(true), 0);
      const hideTimer = setTimeout(() => setShowRestored(false), 3000);
      return () => {
        clearTimeout(showTimer);
        clearTimeout(hideTimer);
      };
    }
  }, [isBrowserOnline, cloudReachable, isConnected]);

  const isOffline = !isBrowserOnline || cloudReachable === false;
  const isReconnecting = isBrowserOnline && !isConnected && connectionStatus === 'connecting';
  const showBanner = !dismissBanner && (isOffline || isReconnecting || showRestored);

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
                : isOffline
                ? 'bg-rose-500 text-white'
                : 'bg-amber-500 text-white'
            }`}
          >
            <div className="flex items-center gap-2">
              {showRestored ? (
                <>
                  <Wifi className="h-3.5 w-3.5" />
                  <span>Connection restored</span>
                </>
              ) : isOffline ? (
                <>
                  <WifiOff className="h-3.5 w-3.5" />
                  <span>You&apos;re offline — some features may be unavailable</span>
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
            {(isOffline || isReconnecting) && isBrowserOnline && (
              <button
                onClick={() => setDismissBanner(true)}
                className="h-5 w-5 rounded-full flex items-center justify-center hover:bg-white/20 transition-colors"
                aria-label="Dismiss"
              >
                ×
              </button>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * A small dot indicator showing the realtime connection status.
 */
export function ConnectionDot() {
  const { isConnected, connectionStatus } = useRealtime();
  const { cloudReachable } = useApiHealthStatus();
  const isBrowserOnline = useOnlineStatus();

  const isOffline = !isBrowserOnline || cloudReachable === false;

  return (
    <span
      className={`inline-block h-2 w-2 rounded-full transition-colors duration-300 ${
        isOffline
          ? 'bg-rose-500'
          : isConnected
          ? 'bg-emerald-500'
          : connectionStatus === 'connecting'
          ? 'bg-amber-500 animate-pulse'
          : 'bg-gray-400'
      }`}
      title={
        isOffline
          ? 'Offline'
          : isConnected
          ? 'Connected'
          : connectionStatus === 'connecting'
          ? 'Reconnecting...'
          : 'Disconnected'
      }
    />
  );
}
