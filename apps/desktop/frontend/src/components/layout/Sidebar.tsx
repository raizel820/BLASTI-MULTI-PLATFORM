import { useState, useEffect } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  Users,
  Clock,
  Building2,
  UserCog,
  History,
  Settings,
  Star,
  Bell,
  Wifi,
  WifiOff,
  RefreshCw,
  BarChart3,
  QrCode,
  Crown,
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
} from 'lucide-react';
import { useSync } from '@/stores/sync';
import api from '@/api/client';
import { cn } from '@/lib/utils';
import SyncStatusDetail from '@/components/shared/sync-status-detail';

const navItems = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/queue', icon: Clock, label: 'Queue', shortcut: 'Ctrl+Q' },
  { to: '/services', icon: Building2, label: 'Services' },
  { to: '/branches', icon: Building2, label: 'Branches' },
  { to: '/staff', icon: UserCog, label: 'Staff' },
  { to: '/history', icon: History, label: 'History' },
  { to: '/analytics', icon: BarChart3, label: 'Analytics' },
  { to: '/qr-code', icon: QrCode, label: 'QR Code' },
  { to: '/subscription', icon: Crown, label: 'Subscription' },
  { to: '/reviews', icon: Star, label: 'Reviews' },
  { to: '/notifications', icon: Bell, label: 'Alerts' },
  { to: '/profile', icon: Building2, label: 'Profile' },
  { to: '/settings', icon: Settings, label: 'Settings' },
];

function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 5) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

export default function Sidebar() {
  const {
    isOnline,
    isSyncing,
    lastSyncAt,
    lastSuccessfulSync,
    pendingMutationsCount,
    syncError,
  } = useSync();
  const location = useLocation();
  const [detailOpen, setDetailOpen] = useState(false);

  // Start periodic sync status check on mount
  useEffect(() => {
    const cleanup = useSync.getState().startPeriodicCheck();
    return cleanup;
  }, []);

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

  return (
    <aside className="flex flex-col w-64 bg-card border-r border-border h-full">
      {/* Logo */}
      <div className="flex items-center gap-3 px-5 py-5 border-b border-border">
        <div className="w-9 h-9 rounded-lg bg-emerald-500 flex items-center justify-center">
          <span className="text-white font-bold text-lg">B</span>
        </div>
        <div>
          <h1 className="text-base font-semibold text-foreground tracking-tight">Blasti</h1>
          <p className="text-[11px] text-muted-foreground">Queue Management</p>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 py-3 px-3 space-y-1 overflow-y-auto">
        {navItems.map(({ to, icon: Icon, label, shortcut }) => (
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
            <span className="flex-1">{label}</span>
            {shortcut && (
              <span className="text-[10px] opacity-50 font-mono">{shortcut.replace('Ctrl+', '^')}</span>
            )}
          </NavLink>
        ))}
      </nav>

      {/* Enhanced Sync Status */}
      <div className="p-3 border-t border-border">
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
          <div className="flex-1 min-w-0 text-left">
            <p className={cn(
              'text-xs font-medium',
              syncState === 'synced' && 'text-emerald-400',
              syncState === 'syncing' && 'text-amber-400',
              syncState === 'pending' && 'text-orange-400',
              syncState === 'error' && 'text-red-400',
              syncState === 'offline' && 'text-zinc-400',
            )}>
              {syncState === 'synced' && 'Online & Synced'}
              {syncState === 'syncing' && 'Syncing\u2026'}
              {syncState === 'pending' && `${pendingMutationsCount} pending change${pendingMutationsCount !== 1 ? 's' : ''}`}
              {syncState === 'error' && 'Sync error'}
              {syncState === 'offline' && 'Offline'}
            </p>
            <p className="text-[10px] text-muted-foreground truncate">
              {syncState === 'synced' && (lastSuccessfulSync ? `All data up to date \u2022 ${formatRelativeTime(lastSuccessfulSync)}` : 'All data up to date')}
              {syncState === 'syncing' && 'Syncing changes\u2026'}
              {syncState === 'pending' && 'Changes awaiting sync'}
              {syncState === 'error' && (syncError || 'Retry when ready')}
              {syncState === 'offline' && (lastSyncAt ? `Last sync ${formatRelativeTime(lastSyncAt)}` : 'No sync data')}
            </p>
          </div>

          {/* Action Icon */}
          {syncState === 'syncing' ? (
            <RefreshCw className="w-3.5 h-3.5 text-amber-400 animate-spin flex-shrink-0" />
          ) : syncState === 'error' ? (
            <button
              onClick={(e) => { e.stopPropagation(); handleSync(); }}
              className="p-1 rounded hover:bg-red-500/10 text-red-400 transition-colors flex-shrink-0"
              title="Retry sync"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          ) : isOnline ? (
            <button
              onClick={(e) => { e.stopPropagation(); handleSync(); }}
              className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
              title="Sync now"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          ) : null}
        </button>
      </div>

      {/* Sync Detail Dialog */}
      <SyncStatusDetail open={detailOpen} onOpenChange={setDetailOpen} />
    </aside>
  );
}
