import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import {
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Wifi,
  WifiOff,
  AlertCircle,
  ArrowRightLeft,
  KeyRound,
  GitBranch,
  ArchiveX,
} from 'lucide-react';
import { useSync } from '@/stores/sync';
import { useLanguage } from '@/hooks/use-language';
import api from '@/api/client';
import { cn } from '@/lib/utils';

interface SyncStatusDetailProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Format a duration in ms as a compact human string, e.g. '2d 4h' / '3h 5m' / '12m'. */
function formatRemainingMs(ms: number | null): string | null {
  if (ms === null || ms <= 0) return null;
  const minutes = Math.floor(ms / 60_000);
  const days = Math.floor(minutes / (60 * 24));
  const hours = Math.floor((minutes % (60 * 24)) / 60);
  const mins = minutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  return `${mins}m`;
}

export default function SyncStatusDetail({ open, onOpenChange }: SyncStatusDetailProps) {
  const [isForcing, setIsForcing] = useState(false);
  const { t } = useLanguage();
  const {
    isOnline,
    isSyncing,
    lastSyncAt,
    lastSuccessfulSync,
    pendingMutationsCount,
    abandonedMutationsCount,
    syncError,
    conflictsCount,
    offlineTokenRemainingMs,
    syncProtocolVersion,
  } = useSync();

  const neverLabel = t('never');

  /** Humanized relative time ("just now", "5m ago", "2d ago") with i18n suffixes. */
  const formatRelativeTime = (dateStr: string | null): string => {
    if (!dateStr) return neverLabel;
    const date = new Date(dateStr);
    if (Number.isNaN(date.getTime())) return neverLabel;
    const diffSec = Math.floor((Date.now() - date.getTime()) / 1000);
    if (diffSec < 5) return t('justNow');
    if (diffSec < 60) return t('secondsAgo', { count: String(diffSec) });
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return t('minutesAgo', { count: String(diffMin) });
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return t('hoursAgo', { count: String(diffHr) });
    const diffDay = Math.floor(diffHr / 24);
    return t('daysAgo', { count: String(diffDay) });
  };

  const formatFullTime = (dateStr: string | null): string => {
    if (!dateStr) return neverLabel;
    return new Date(dateStr).toLocaleString();
  };

  const handleForceSync = async () => {
    setIsForcing(true);
    try {
      await api.triggerSync();
      // Refresh status after triggering sync
      await useSync.getState().fetchSyncStatus();
    } catch {
      // Force sync failed
    } finally {
      setIsForcing(false);
    }
  };

  const statusColor = !isOnline
    ? 'bg-zinc-500/10 text-zinc-400'
    : syncError
      ? 'bg-red-500/10 text-red-400'
      : isSyncing
        ? 'bg-amber-500/10 text-amber-400'
        : pendingMutationsCount > 0
          ? 'bg-orange-500/10 text-orange-400'
          : 'bg-emerald-500/10 text-emerald-400';

  const statusLabel = !isOnline
    ? t('syncOffline')
    : syncError
      ? t('syncErrorLabel')
      : isSyncing
        ? t('syncSyncing')
        : pendingMutationsCount > 0
          ? t('pendingChanges')
          : t('allSynced');

  const offlineTokenRemaining = formatRemainingMs(offlineTokenRemainingMs);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowRightLeft className="w-5 h-5" />
            {t('syncStatus')}
          </DialogTitle>
          <DialogDescription>
            {t('syncStatusDesc')}
          </DialogDescription>
        </DialogHeader>

        {/* Status Badge */}
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-muted-foreground">{t('currentStatus')}</span>
          <Badge className={statusColor}>{statusLabel}</Badge>
        </div>

        <Separator />

        {/* Details Grid */}
        <div className="space-y-3 text-sm">
          {/* Connection */}
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground flex items-center gap-1.5">
              {isOnline ? (
                <Wifi className="w-3.5 h-3.5 text-emerald-400" />
              ) : (
                <WifiOff className="w-3.5 h-3.5 text-zinc-400" />
              )}
              {t('connection')}
            </span>
            <span className={isOnline ? 'text-emerald-400' : 'text-zinc-400'}>
              {isOnline ? t('syncOnline') : t('syncOffline')}
            </span>
          </div>

          {/* Last Successful Sync */}
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5" />
              {t('lastSuccessfulSync')}
            </span>
            <span className="font-mono text-xs" title={formatFullTime(lastSuccessfulSync)}>
              {formatRelativeTime(lastSuccessfulSync)}
            </span>
          </div>

          {/* Last Sync Attempt */}
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5" />
              {t('lastSyncAttempt')}
            </span>
            <span className="font-mono text-xs" title={formatFullTime(lastSyncAt)}>
              {formatRelativeTime(lastSyncAt)}
            </span>
          </div>

          {/* Pending Changes */}
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground flex items-center gap-1.5">
              <AlertCircle className="w-3.5 h-3.5" />
              {t('pendingChanges')}
            </span>
            <span className={pendingMutationsCount > 0 ? 'text-orange-400 font-medium' : ''}>
              {pendingMutationsCount}
            </span>
          </div>

          {/* Abandoned Changes */}
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground flex items-center gap-1.5">
              <ArchiveX className="w-3.5 h-3.5" />
              {t('abandonedChanges')}
            </span>
            <span className={abandonedMutationsCount > 0 ? 'text-red-400 font-medium' : ''}>
              {abandonedMutationsCount}
            </span>
          </div>

          {/* Conflicts */}
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5" />
              {t('conflicts')}
            </span>
            <span className={conflictsCount > 0 ? 'text-red-400 font-medium' : ''}>
              {conflictsCount}
            </span>
          </div>

          {/* Offline session remaining */}
          {offlineTokenRemaining && (
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground flex items-center gap-1.5">
                <KeyRound className="w-3.5 h-3.5" />
                {t('offlineTokenRemaining')}
              </span>
              <span className="font-mono text-xs">{offlineTokenRemaining}</span>
            </div>
          )}

          {/* Sync protocol version */}
          {syncProtocolVersion !== null && (
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground flex items-center gap-1.5">
                <GitBranch className="w-3.5 h-3.5" />
                {t('protocolVersion')}
              </span>
              <span className="font-mono text-xs">{syncProtocolVersion}</span>
            </div>
          )}

          {/* Sync Error */}
          {syncError && (
            <div className="rounded-md bg-red-500/10 border border-red-500/20 p-2.5">
              <p className="text-xs text-red-400 font-medium">{t('syncErrorLabel')}</p>
              <p className="text-xs text-red-300/80 mt-0.5">{syncError}</p>
            </div>
          )}
        </div>

        <Separator />

        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            variant="outline"
            size="sm"
            onClick={handleForceSync}
            disabled={!isOnline || isForcing || isSyncing}
          >
            <RefreshCw className={cn('w-3.5 h-3.5', (isForcing || isSyncing) && 'animate-spin')} />
            {isSyncing ? t('syncSyncing') : t('forceSyncNow')}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {t('close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
