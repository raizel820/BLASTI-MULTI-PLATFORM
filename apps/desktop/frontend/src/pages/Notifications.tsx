import { useCallback } from 'react';
import { Bell, Check, Loader2 } from 'lucide-react';
import api from '@/api/client';
import { useApi } from '@/hooks/use-api';
import { formatRelativeTime } from '@/lib/utils';

interface Notification {
  id: string;
  title?: string;
  message?: string;
  type?: string;
  isRead?: boolean;
  createdAt?: string;
}

export default function NotificationsPage() {
  const fetchNotifications = useCallback(() => api.getNotifications({ take: 50 }), []);
  const { data, isLoading, refetch } = useApi(fetchNotifications);

  const notifications = ((data?.notifications || data?.data || []) as Notification[]) || [];
  const unread = notifications.filter((n) => !n.isRead);

  const handleMarkRead = async (id: string) => {
    try {
      await api.markNotificationRead(id);
      refetch();
    } catch { /* */ }
  };

  const typeIcon = (type?: string) => {
    switch (type) {
      case 'success': return '🟢';
      case 'warning': return '🟡';
      case 'error': return '🔴';
      default: return '🔵';
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Notifications</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {unread.length > 0 ? `${unread.length} unread` : 'All caught up'}
          </p>
        </div>
      </div>

      <div className="space-y-2">
        {isLoading ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin" />
          </div>
        ) : notifications.length === 0 ? (
          <div className="rounded-xl border border-border bg-card py-12 text-center">
            <Bell className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">No notifications</p>
          </div>
        ) : (
          notifications.map((n) => (
            <div
              key={n.id}
              className={`rounded-xl border border-border bg-card p-4 flex items-start gap-3 transition-colors ${
                !n.isRead ? 'border-primary/30 bg-primary/5' : ''
              }`}
            >
              <span className="text-base mt-0.5">{typeIcon(n.type)}</span>
              <div className="flex-1 min-w-0">
                <p className={`text-sm ${!n.isRead ? 'font-semibold text-foreground' : 'text-foreground'}`}>
                  {n.title || 'Notification'}
                </p>
                {n.message && (
                  <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{n.message}</p>
                )}
                <p className="text-[11px] text-muted-foreground mt-1">{formatRelativeTime(n.createdAt)}</p>
              </div>
              {!n.isRead && (
                <button
                  onClick={() => handleMarkRead(n.id)}
                  className="p-1.5 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                  title="Mark as read"
                >
                  <Check className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
