import { Wifi, WifiOff, RefreshCw, AlertCircle, CheckCircle2 } from 'lucide-react';
import { useSync } from '@/stores/sync';
import { cn } from '@/lib/utils';

export default function SyncIndicator() {
  const { isOnline, isSyncing, pendingMutationsCount, syncError } = useSync();

  // Determine display state
  const getState = () => {
    if (!isOnline) return { bg: 'bg-zinc-500/10', text: 'text-zinc-400', label: 'Offline', Icon: WifiOff };
    if (syncError) return { bg: 'bg-red-500/10', text: 'text-red-400', label: 'Sync Error', Icon: AlertCircle };
    if (isSyncing) return { bg: 'bg-amber-500/10', text: 'text-amber-400', label: 'Syncing\u2026', Icon: RefreshCw };
    if (pendingMutationsCount > 0) return { bg: 'bg-orange-500/10', text: 'text-orange-400', label: `${pendingMutationsCount} pending`, Icon: AlertCircle };
    return { bg: 'bg-emerald-500/10', text: 'text-emerald-400', label: 'Online', Icon: CheckCircle2 };
  };

  const { bg, text, label, Icon } = getState();

  return (
    <div className={cn(
      'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium',
      bg,
      text
    )}>
      <Icon className={cn('w-3 h-3', isSyncing && 'animate-spin')} />
      {label}
    </div>
  );
}
