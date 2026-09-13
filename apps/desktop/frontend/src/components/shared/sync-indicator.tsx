import { Wifi, WifiOff, RefreshCw, AlertCircle, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useSync } from '@/stores/sync';
import { useLanguage } from '@/hooks/use-language';
import { cn } from '@/lib/utils';

/** Below this remaining offline-token budget the pill turns amber (12h). */
const OFFLINE_WARNING_THRESHOLD_MS = 12 * 3600 * 1000;

/** Compact remaining-time formatter for the tooltip ("2d 4h" / "5h 30m" / "45m"). */
function formatRemainingMs(ms: number): string {
  const totalMin = Math.max(0, Math.floor(ms / 60000));
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const minutes = totalMin % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export default function SyncIndicator() {
  const { isOnline, isSyncing, pendingMutationsCount, syncError, offlineTokenRemainingMs } = useSync();
  const { t } = useLanguage();

  // Determine display state
  const getState = () => {
    if (!isOnline) return { bg: 'bg-zinc-500/10', text: 'text-zinc-400', label: t('syncOffline'), Icon: WifiOff };
    if (syncError) return { bg: 'bg-red-500/10', text: 'text-red-400', label: t('syncErrorLabel'), Icon: AlertCircle };
    // Offline-token budget running low (0 < remaining < 12h) — amber warning
    // so the user knows how long fully-offline work remains possible.
    if (
      offlineTokenRemainingMs !== null &&
      offlineTokenRemainingMs > 0 &&
      offlineTokenRemainingMs < OFFLINE_WARNING_THRESHOLD_MS
    ) {
      return {
        bg: 'bg-amber-500/10',
        text: 'text-amber-400',
        label: t('syncOnline'),
        Icon: AlertTriangle,
        title: `${t('offlineTokenRemaining')}: ${formatRemainingMs(offlineTokenRemainingMs)}`,
      };
    }
    if (isSyncing) return { bg: 'bg-amber-500/10', text: 'text-amber-400', label: t('syncSyncing'), Icon: RefreshCw };
    if (pendingMutationsCount > 0)
      return {
        bg: 'bg-orange-500/10',
        text: 'text-orange-400',
        label: `${pendingMutationsCount} ${t('pendingChanges')}`,
        Icon: AlertCircle,
      };
    return { bg: 'bg-emerald-500/10', text: 'text-emerald-400', label: t('syncOnline'), Icon: CheckCircle2 };
  };

  const state = getState();
  const { bg, text, label, Icon } = state;
  // Tooltip: for the low-offline-budget state show the remaining time,
  // otherwise the pill label itself.
  const title =
    offlineTokenRemainingMs !== null &&
    offlineTokenRemainingMs > 0 &&
    offlineTokenRemainingMs < OFFLINE_WARNING_THRESHOLD_MS &&
    isOnline &&
    !syncError
      ? `${t('offlineTokenRemaining')}: ${formatRemainingMs(offlineTokenRemainingMs)}`
      : label;

  return (
    <div
      className={cn(
        'inline-flex shrink-0 max-w-[6rem] items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium whitespace-nowrap',
        bg,
        text
      )}
      title={title}
    >
      <Icon className={cn('w-3 h-3 shrink-0', isSyncing && 'animate-spin')} />
      <span className="truncate">{label}</span>
    </div>
  );
}
