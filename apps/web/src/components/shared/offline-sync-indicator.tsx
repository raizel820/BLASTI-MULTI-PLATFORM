'use client';

import { useState, useEffect, useCallback } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { isRTL } from '@/i18n';
import { motion, AnimatePresence } from 'framer-motion';
import { WifiOff, Wifi, RefreshCw, Check, AlertTriangle, X, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useOfflineSync } from '@/hooks/use-offline-sync';

type SyncState = 'idle' | 'syncing' | 'success' | 'error';

// ─── Exported Helpers (backward compat) ────────────────────────────────────
// These now delegate to the WatermelonDB offline layer.

function getDeviceId(): string {
  if (typeof window === 'undefined') return 'server';
  try {
    let deviceId = localStorage.getItem('blasti-device-id');
    if (!deviceId) {
      deviceId = `device_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      localStorage.setItem('blasti-device-id', deviceId);
    }
    return deviceId;
  } catch {
    return `device_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }
}

export { getDeviceId };

/**
 * Add an offline reservation — delegates to the WatermelonDB offline layer.
 */
export async function addOfflineReservation(reservation: {
  agencyId: string;
  serviceId: string;
  customerName?: string;
  customerPhone?: string;
  notes?: string;
  fixedTimeEnabled?: boolean;
  fixedTime?: string;
  reservedDate?: string;
  preferredTime?: string;
}): Promise<void> {
  try {
    const { createOfflineReservation } = await import('@/lib/offline-layer');
    await createOfflineReservation({
      agencyId: reservation.agencyId,
      serviceId: reservation.serviceId,
      customerName: reservation.customerName,
      customerPhone: reservation.customerPhone,
      notes: reservation.notes,
      fixedTimeEnabled: reservation.fixedTimeEnabled,
      preferredTime: reservation.preferredTime,
    });
  } catch (err) {
    console.warn('[OfflineSyncIndicator] Failed to create offline reservation:', err);
  }
}

/**
 * Get the count of offline (pending sync) reservations from WatermelonDB.
 */
export async function getOfflineReservationsCount(): Promise<number> {
  try {
    const { getOfflineStats } = await import('@/lib/offline-layer');
    const stats = await getOfflineStats();
    return stats.pendingReservations;
  } catch {
    return 0;
  }
}

// ─── Component ──────────────────────────────────────────────────────────────

export function OfflineSyncIndicator() {
  const { lang, t } = useLanguage();
  const rtl = isRTL(lang);
  const [isOnline, setIsOnline] = useState(true);
  const [syncState, setSyncState] = useState<SyncState>('idle');
  const [showBanner, setShowBanner] = useState(false);

  const { pendingCount, isSyncing, syncNow } = useOfflineSync();

  // Monitor online/offline status
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const updateOnlineStatus = () => {
      setIsOnline(navigator.onLine);
    };

    updateOnlineStatus();
    window.addEventListener('online', updateOnlineStatus);
    window.addEventListener('offline', updateOnlineStatus);

    return () => {
      window.removeEventListener('online', updateOnlineStatus);
      window.removeEventListener('offline', updateOnlineStatus);
    };
  }, []);

  // Show banner when offline or when there are pending changes
  useEffect(() => {
    setShowBanner(!isOnline || pendingCount > 0 || syncState !== 'idle');
  }, [isOnline, pendingCount, syncState]);

  // Reflect the hook's isSyncing into local syncState
  useEffect(() => {
    if (isSyncing) {
      setSyncState('syncing');
    } else if (syncState === 'syncing') {
      setSyncState('success');
      const timer = setTimeout(() => setSyncState('idle'), 5000);
      return () => clearTimeout(timer);
    }
  }, [isSyncing, syncState]);

  const syncPendingReservations = useCallback(async () => {
    setSyncState('syncing');
    try {
      await syncNow();
      setSyncState('success');
      toast.success(t('offlineSyncComplete'));
      setTimeout(() => setSyncState('idle'), 5000);
    } catch {
      setSyncState('error');
      toast.error(t('offlineSyncConflict'));
      setTimeout(() => setSyncState('idle'), 5000);
    }
  }, [syncNow, t]);

  // Auto-sync when coming back online — only from 'idle' to prevent
  // infinite retry loops when the cloud is unreachable but navigator.onLine
  // is true (common in Electron on LAN with no internet).
  useEffect(() => {
    if (isOnline && pendingCount > 0 && syncState === 'idle') {
      const timer = setTimeout(() => {
        syncPendingReservations();
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [isOnline, pendingCount, syncState, syncPendingReservations]);

  // Don't render anything if online and no pending
  if (isOnline && pendingCount === 0 && syncState === 'idle') {
    return null;
  }

  return (
    <AnimatePresence>
      {showBanner && (
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -20 }}
          transition={{ duration: 0.3 }}
          className="fixed top-0 left-0 right-0 z-50"
        >
          <div
            className={`
              flex items-center justify-between px-4 py-2.5 text-sm font-medium
              ${!isOnline
                ? 'bg-rose-600 text-white'
                : syncState === 'syncing'
                  ? 'bg-amber-500 text-white'
                  : syncState === 'success'
                    ? 'bg-emerald-600 text-white'
                    : syncState === 'error'
                      ? 'bg-orange-600 text-white'
                      : 'bg-amber-500 text-white'
              }
            `}
            dir={rtl ? 'rtl' : 'ltr'}
          >
            <div className="flex items-center gap-2">
              {!isOnline ? (
                <WifiOff className="h-4 w-4 shrink-0" />
              ) : syncState === 'syncing' ? (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
              ) : syncState === 'success' ? (
                <Check className="h-4 w-4 shrink-0" />
              ) : syncState === 'error' ? (
                <AlertTriangle className="h-4 w-4 shrink-0" />
              ) : (
                <Wifi className="h-4 w-4 shrink-0" />
              )}

              <span>
                {!isOnline
                  ? t('offlineModeActive')
                  : syncState === 'syncing'
                    ? t('offlineSyncProgress')
                    : syncState === 'success'
                      ? t('offlineSyncComplete')
                      : syncState === 'error'
                        ? t('offlineSyncConflict')
                        : t('offlineReservationsPending', { count: String(pendingCount) })
                }
              </span>
            </div>

            <div className="flex items-center gap-2">
              {isOnline && pendingCount > 0 && syncState !== 'syncing' && (
                <button
                  onClick={syncPendingReservations}
                  className="flex items-center gap-1 rounded-md bg-white/20 px-2 py-1 text-xs font-medium hover:bg-white/30 transition-colors"
                >
                  <RefreshCw className="h-3 w-3" />
                  {t('offlineSyncRetry')}
                </button>
              )}

              {!isOnline && pendingCount > 0 && (
                <span className="text-xs opacity-80">
                  {pendingCount} pending
                </span>
              )}

              {isOnline && pendingCount === 0 && syncState !== 'idle' && (
                <button
                  onClick={() => {
                    setShowBanner(false);
                    setSyncState('idle');
                  }}
                  className="rounded-md bg-white/20 p-1 hover:bg-white/30 transition-colors"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
