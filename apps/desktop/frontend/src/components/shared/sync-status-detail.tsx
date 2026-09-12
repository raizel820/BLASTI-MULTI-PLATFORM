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
} from 'lucide-react';
import { useSync } from '@/stores/sync';
import api from '@/api/client';
import { cn } from '@/lib/utils';

interface SyncStatusDetailProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return 'Never';
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 5) return 'Just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

function formatFullTime(dateStr: string | null): string {
  if (!dateStr) return 'Never';
  return new Date(dateStr).toLocaleString();
}

export default function SyncStatusDetail({ open, onOpenChange }: SyncStatusDetailProps) {
  const [isForcing, setIsForcing] = useState(false);
  const {
    isOnline,
    isSyncing,
    lastSyncAt,
    lastSuccessfulSync,
    pendingMutationsCount,
    syncError,
    conflictsCount,
  } = useSync();

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
    ? 'Offline'
    : syncError
      ? 'Sync Error'
      : isSyncing
        ? 'Syncing'
        : pendingMutationsCount > 0
          ? 'Pending Changes'
          : 'All Synced';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowRightLeft className="w-5 h-5" />
            Sync Status
          </DialogTitle>
          <DialogDescription>
            Details about data synchronization between this device and the cloud.
          </DialogDescription>
        </DialogHeader>

        {/* Status Badge */}
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-muted-foreground">Current Status</span>
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
              Connection
            </span>
            <span className={isOnline ? 'text-emerald-400' : 'text-zinc-400'}>
              {isOnline ? 'Online' : 'Offline'}
            </span>
          </div>

          {/* Last Successful Sync */}
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5" />
              Last Successful Sync
            </span>
            <span className="font-mono text-xs" title={formatFullTime(lastSuccessfulSync)}>
              {formatRelativeTime(lastSuccessfulSync)}
            </span>
          </div>

          {/* Last Sync Attempt */}
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5" />
              Last Sync Attempt
            </span>
            <span className="font-mono text-xs" title={formatFullTime(lastSyncAt)}>
              {formatRelativeTime(lastSyncAt)}
            </span>
          </div>

          {/* Pending Changes */}
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground flex items-center gap-1.5">
              <AlertCircle className="w-3.5 h-3.5" />
              Pending Changes
            </span>
            <span className={pendingMutationsCount > 0 ? 'text-orange-400 font-medium' : ''}>
              {pendingMutationsCount}
            </span>
          </div>

          {/* Conflicts */}
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5" />
              Conflicts
            </span>
            <span className={conflictsCount > 0 ? 'text-red-400 font-medium' : ''}>
              {conflictsCount}
            </span>
          </div>

          {/* Sync Error */}
          {syncError && (
            <div className="rounded-md bg-red-500/10 border border-red-500/20 p-2.5">
              <p className="text-xs text-red-400 font-medium">Sync Error</p>
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
            {isSyncing ? 'Syncing...' : 'Force Sync Now'}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}


