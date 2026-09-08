import { Wifi, WifiOff, RefreshCw } from 'lucide-react';
import { useSync } from '@/stores/sync';
import { cn } from '@/lib/utils';

export default function SyncIndicator() {
  const { isOnline, isSyncing } = useSync();

  return (
    <div className={cn(
      'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium',
      isOnline ? 'bg-emerald-500/10 text-emerald-400' : 'bg-amber-500/10 text-amber-400'
    )}>
      {isSyncing ? (
        <RefreshCw className="w-3 h-3 animate-spin" />
      ) : isOnline ? (
        <Wifi className="w-3 h-3" />
      ) : (
        <WifiOff className="w-3 h-3" />
      )}
      {isSyncing ? 'Syncing' : isOnline ? 'Online' : 'Offline'}
    </div>
  );
}
