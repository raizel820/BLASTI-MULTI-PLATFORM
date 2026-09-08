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
} from 'lucide-react';
import { useSync } from '@/stores/sync';
import api from '@/api/client';
import { cn } from '@/lib/utils';

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
  { to: '/settings', icon: Settings, label: 'Settings' },
];

export default function Sidebar() {
  const { isOnline, isSyncing, lastSyncAt } = useSync();
  const location = useLocation();

  const handleSync = async () => {
    try {
      await api.triggerSync();
    } catch {
      // Sync trigger failed
    }
  };

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

      {/* Sync Status */}
      <div className="p-3 border-t border-border">
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-muted/50">
          {isOnline ? (
            <Wifi className="w-4 h-4 text-emerald-400" />
          ) : (
            <WifiOff className="w-4 h-4 text-amber-400" />
          )}
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-foreground">
              {isOnline ? 'Online' : 'Offline'}
            </p>
            <p className="text-[10px] text-muted-foreground truncate">
              {isSyncing
                ? 'Syncing...'
                : lastSyncAt
                ? `Synced ${new Date(lastSyncAt).toLocaleTimeString()}`
                : 'Not synced'}
            </p>
          </div>
          {isOnline && (
            <button
              onClick={handleSync}
              className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
              title="Sync now"
            >
              <RefreshCw className={cn('w-3.5 h-3.5', isSyncing && 'animate-spin')} />
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}
