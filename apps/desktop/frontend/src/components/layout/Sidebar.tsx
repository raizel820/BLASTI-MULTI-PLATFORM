import { useState, useEffect } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  Clock,
  Building2,
  UserCog,
  History,
  Settings,
  Star,
  Bell,
  WifiOff,
  RefreshCw,
  BarChart3,
  QrCode,
  Crown,
  AlertCircle,
  AlertTriangle,
} from 'lucide-react';
import { useSync } from '@/stores/sync';
import { useLanguage } from '@/hooks/use-language';
import { useKeyboard } from '@/hooks/use-keyboard';
import api from '@/api/client';
import { cn } from '@/lib/utils';
import SyncStatusDetail from '@/components/shared/sync-status-detail';
import SyncIndicator from '@/components/shared/sync-indicator';
import { ConflictResolutionDialog } from '@/components/shared/conflict-resolution-dialog';

const navItems = [
  { to: '/', icon: LayoutDashboard, labelKey: 'dashboard' },
  { to: '/queue', icon: Clock, labelKey: 'queue', shortcut: 'Ctrl+Q' },
  { to: '/services', icon: Building2, labelKey: 'services' },
  { to: '/branches', icon: Building2, labelKey: 'branches' },
  { to: '/staff', icon: UserCog, labelKey: 'staff' },
  { to: '/history', icon: History, labelKey: 'history' },
  { to: '/analytics', icon: BarChart3, labelKey: 'analytics' },
  { to: '/qr-code', icon: QrCode, labelKey: 'qrCode' },
  { to: '/subscription', icon: Crown, labelKey: 'subscription' },
  { to: '/reviews', icon: Star, labelKey: 'reviews' },
  { to: '/notifications', icon: Bell, labelKey: 'alerts' },
  { to: '/profile', icon: Building2, labelKey: 'profile' },
  { to: '/settings', icon: Settings, labelKey: 'settings' },
] as const;

export default function Sidebar() {
  const {
    isOnline,
    isSyncing,
    lastSyncAt,
    lastSuccessfulSync,
    pendingMutationsCount,
    syncError,
    conflictsCount,
    conflicts,
  } = useSync();
  const { t } = useLanguage();
  const location = useLocation();
  const navigate = useNavigate();
  const [detailOpen, setDetailOpen] = useState(false);
  const [conflictsOpen, setConflictsOpen] = useState(false);

  // Ctrl+Q → Queue page — makes the "Ctrl+Q" shortcut label rendered on the
  // queue nav item below actually functional. The hook keeps its input-field
  // guard and removes the window listener on unmount.
  useKeyboard([
    { key: 'q', ctrl: true, handler: () => navigate('/queue') },
  ]);

  // Start periodic sync status check on mount
  useEffect(() => {
    const cleanup = useSync.getState().startPeriodicCheck();
    return cleanup;
  }, []);

  // Load conflicts from the Electron IPC bridge (or local API fallback)
  // whenever the conflicts dialog is opened.
  useEffect(() => {
    if (conflictsOpen) {
      void useSync.getState().refreshConflicts();
    }
  }, [conflictsOpen]);

  const handleSync = async () => {
    try {
      await api.triggerSync();
      await useSync.getState().fetchSyncStatus();
    } catch {
      // Sync trigger failed
    }
  };

  // Determine sync state for display
  const getSyncState = () => {
    if (!isOnline) return 'offline';
    if (syncError) return 'error';
    if (isSyncing) return 'syncing';
    if (pendingMutationsCount > 0) return 'pending';
    return 'synced';
  };

  const syncState = getSyncState();

  /** Humanized relative time ("5m ago") with i18n suffixes. */
  const formatRelativeTime = (dateStr: string | null): string => {
    if (!dateStr) return '';
    const date = new Date(dateStr);
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

  return (
    <aside className="flex flex-col w-64 bg-card border-r border-border h-full">
      {/* Logo */}
      <div className="flex items-center gap-3 px-5 py-5 border-b border-border">
        <div className="w-9 h-9 rounded-lg bg-emerald-500 flex items-center justify-center">
          <span className="text-white font-bold text-lg">B</span>
        </div>
        <div className="flex-1 min-w-0">
          <h1 className="text-base font-semibold text-foreground tracking-tight">Blasti</h1>
          <p className="text-[11px] text-muted-foreground">{t('queueManagement')}</p>
        </div>
        {/* Sync badge — self-contained pill fed by the sync store */}
        <SyncIndicator />
      </div>

      {/* Navigation */}
      <nav className="flex-1 py-3 px-3 space-y-1 overflow-y-auto">
        {navItems.map(({ to, icon: Icon, labelKey, ...rest }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-150',
                isActive
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
              )
            }
          >
            <Icon className="w-[18px] h-[18px]" />
            <span className="flex-1">{t(labelKey)}</span>
            {'shortcut' in rest && rest.shortcut && (
              <span className="text-[10px] opacity-50 font-mono">{rest.shortcut.replace('Ctrl+', '^')}</span>
            )}
          </NavLink>
        ))}
      </nav>

      {/* Enhanced Sync Status */}
      <div className="p-3 border-t border-border space-y-2">
        <button
          onClick={() => setDetailOpen(true)}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg transition-colors hover:bg-muted/70"
        >
          {/* Status Dot */}
          <div className="relative flex-shrink-0">
            {syncState === 'synced' && (
              <div className="w-2.5 h-2.5 rounded-full bg-emerald-400" />
            )}
            {syncState === 'syncing' && (
              <div className="w-2.5 h-2.5 rounded-full bg-amber-400 animate-pulse" />
            )}
            {syncState === 'pending' && (
              <div className="w-2.5 h-2.5 rounded-full bg-orange-400" />
            )}
            {syncState === 'error' && (
              <div className="w-2.5 h-2.5 rounded-full bg-red-400" />
            )}
            {syncState === 'offline' && (
              <div className="w-2.5 h-2.5 rounded-full bg-zinc-400" />
            )}
          </div>

          {/* Status Text */}
          <div className="flex-1 min-w-0 text-start">
            <p className={cn(
              'text-xs font-medium',
              syncState === 'synced' && 'text-emerald-400',
              syncState === 'syncing' && 'text-amber-400',
              syncState === 'pending' && 'text-orange-400',
              syncState === 'error' && 'text-red-400',
              syncState === 'offline' && 'text-zinc-400',
            )}>
              {syncState === 'synced' && t('allSynced')}
              {syncState === 'syncing' && t('syncSyncing')}
              {syncState === 'pending' && `${pendingMutationsCount} ${t('pendingChanges')}`}
              {syncState === 'error' && t('syncErrorLabel')}
              {syncState === 'offline' && t('syncOffline')}
            </p>
            <p className="text-[10px] text-muted-foreground truncate">
              {syncState === 'synced' && (lastSuccessfulSync ? `${t('allDataUpToDate')} • ${formatRelativeTime(lastSuccessfulSync)}` : t('allDataUpToDate'))}
              {syncState === 'syncing' && t('changesAwaitingSync')}
              {syncState === 'pending' && t('changesAwaitingSync')}
              {syncState === 'error' && (syncError || t('syncErrorLabel'))}
              {syncState === 'offline' && (lastSyncAt ? `${t('syncLastSync')} ${formatRelativeTime(lastSyncAt)}` : t('noSyncData'))}
            </p>
          </div>

          {/* Action Icon */}
          {syncState === 'syncing' ? (
            <RefreshCw className="w-3.5 h-3.5 text-amber-400 animate-spin flex-shrink-0" />
          ) : syncState === 'error' ? (
            <button
              onClick={(e) => { e.stopPropagation(); handleSync(); }}
              className="p-1 rounded hover:bg-red-500/10 text-red-400 transition-colors flex-shrink-0"
              title={t('retrySync')}
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          ) : isOnline ? (
            <button
              onClick={(e) => { e.stopPropagation(); handleSync(); }}
              className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
              title={t('syncNow')}
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          ) : (
            <WifiOff className="w-3.5 h-3.5 text-zinc-400 flex-shrink-0" />
          )}
        </button>

        {/* Conflicts entry point — only shown when the sync service reports conflicts */}
        {conflictsCount > 0 && (
          <button
            onClick={() => setConflictsOpen(true)}
            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg bg-red-500/10 hover:bg-red-500/15 transition-colors"
          >
            <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0" />
            <span className="flex-1 min-w-0 text-start text-xs font-medium text-red-400 truncate">
              {conflictsCount} {t('conflicts')}
            </span>
            <AlertCircle className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />
          </button>
        )}
      </div>

      {/* Sync Detail Dialog */}
      <SyncStatusDetail open={detailOpen} onOpenChange={setDetailOpen} />

      {/* Conflict Resolution Dialog — closed by default; conflicts come from
          the sync store (Electron IPC bridge → sync:conflicts, with a local
          API fallback). */}
      <ConflictResolutionDialog
        open={conflictsOpen}
        onOpenChange={setConflictsOpen}
        conflicts={conflicts}
        onResolve={(id, resolution) => {
          void useSync.getState().resolveConflict(id, resolution);
        }}
        onResolveAll={(resolution) => {
          void (async () => {
            for (const conflict of conflicts) {
              if (!conflict.resolved) {
                await useSync.getState().resolveConflict(conflict.id, resolution);
              }
            }
          })();
        }}
      />
    </aside>
  );
}
