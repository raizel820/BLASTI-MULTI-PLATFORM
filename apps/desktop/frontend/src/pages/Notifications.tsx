import { useState, useEffect, useCallback, useMemo } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { useAppStore } from '@/store/use-app-store';
import { apiFetch } from '@/lib/api-fetch';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'framer-motion';
import { formatRelativeTime } from '@/lib/utils';

// shadcn/ui components
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

// Icons
import {
  Bell,
  BellRing,
  Check,
  CheckCheck,
  Trash2,
  RefreshCw,
  Loader2,
  ChevronDown,
  AlertCircle,
  CheckCircle2,
  AlertTriangle,
  Info,
  Megaphone,
  Ticket,
  Users,
  Sparkles,
  Search,
  Filter,
  Plus,
} from 'lucide-react';

// --- Types ---

interface Notification {
  id: string;
  title?: string;
  message?: string;
  type?: string;
  isRead?: boolean;
  createdAt?: string;
  entityId?: string | null;
  userId?: string;
}

interface Announcement {
  id: string;
  title?: string;
  message?: string;
  type?: string;
  isActive?: boolean;
  createdAt?: string;
}

type TypeFilter = 'all' | 'info' | 'success' | 'warning' | 'error' | 'turn' | 'queue' | 'system';
type StatusFilter = 'all' | 'unread' | 'read';
type DateGroup = 'today' | 'yesterday' | 'earlier';

// --- Constants ---

const PAGE_SIZE = 20;

const TYPE_FILTERS: { value: TypeFilter; labelKey: string; color: string }[] = [
  { value: 'all', labelKey: 'filterAll', color: '' },
  { value: 'info', labelKey: 'notificationTypeInfo', color: 'bg-cyan-500' },
  { value: 'success', labelKey: 'notificationTypeSuccess', color: 'bg-emerald-500' },
  { value: 'warning', labelKey: 'notificationTypeWarning', color: 'bg-amber-500' },
  { value: 'error', labelKey: 'notificationTypeError', color: 'bg-rose-500' },
  { value: 'turn', labelKey: 'notificationTypeTurn', color: 'bg-emerald-500' },
  { value: 'queue', labelKey: 'notificationTypeQueue', color: 'bg-teal-500' },
  { value: 'system', labelKey: 'notificationTypeSystem', color: 'bg-cyan-500' },
];

const STATUS_FILTERS: { value: StatusFilter; labelKey: string }[] = [
  { value: 'all', labelKey: 'filterAll' },
  { value: 'unread', labelKey: 'unread' },
  { value: 'read', labelKey: 'read' },
];

// --- Helpers ---

function mapApiType(apiType: string): TypeFilter {
  const t = (apiType || '').toUpperCase();
  if (t.startsWith('TURN')) return 'turn';
  if (t.startsWith('QUEUE')) return 'queue';
  if (t.startsWith('SUCCESS')) return 'success';
  if (t.startsWith('WARNING')) return 'warning';
  if (t.startsWith('ERROR')) return 'error';
  if (t.startsWith('INFO')) return 'info';
  return 'system';
}

function getDateGroup(dateStr: string): DateGroup {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const d = new Date(dateStr);
  const notifDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (notifDate.getTime() >= today.getTime()) return 'today';
  if (notifDate.getTime() >= yesterday.getTime()) return 'yesterday';
  return 'earlier';
}

function groupNotificationsByDate(
  notifs: Notification[],
  t: (key: string) => string
): { group: DateGroup; label: string; items: Notification[] }[] {
  const groups = new Map<DateGroup, Notification[]>();
  for (const n of notifs) {
    if (!n.createdAt) continue;
    const g = getDateGroup(n.createdAt);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(n);
  }
  const labelMap: Record<DateGroup, string> = {
    today: t('today') || 'Today',
    yesterday: t('yesterday') || 'Yesterday',
    earlier: t('earlier') || 'Earlier',
  };
  const order: DateGroup[] = ['today', 'yesterday', 'earlier'];
  return order
    .filter((g) => groups.has(g))
    .map((g) => ({ group: g, label: labelMap[g], items: groups.get(g)! }));
}

// --- Notification Icon ---

function NotificationIcon({ type }: { type: string }) {
  switch (type) {
    case 'turn':
      return (
        <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-emerald-400 to-teal-500 flex items-center justify-center shadow-md shadow-emerald-500/20 flex-shrink-0">
          <BellRing className="h-4 w-4 text-white" />
        </div>
      );
    case 'queue':
      return (
        <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-teal-400 to-cyan-500 flex items-center justify-center shadow-md shadow-teal-500/20 flex-shrink-0">
          <Ticket className="h-4 w-4 text-white" />
        </div>
      );
    case 'success':
      return (
        <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-emerald-400 to-emerald-600 flex items-center justify-center shadow-md shadow-emerald-500/20 flex-shrink-0">
          <CheckCircle2 className="h-4 w-4 text-white" />
        </div>
      );
    case 'warning':
      return (
        <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-amber-400 to-amber-600 flex items-center justify-center shadow-md shadow-amber-500/20 flex-shrink-0">
          <AlertTriangle className="h-4 w-4 text-white" />
        </div>
      );
    case 'error':
      return (
        <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-rose-400 to-rose-600 flex items-center justify-center shadow-md shadow-rose-500/20 flex-shrink-0">
          <AlertCircle className="h-4 w-4 text-white" />
        </div>
      );
    case 'info':
      return (
        <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-cyan-400 to-cyan-600 flex items-center justify-center shadow-md shadow-cyan-500/20 flex-shrink-0">
          <Info className="h-4 w-4 text-white" />
        </div>
      );
    case 'system':
      return (
        <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-cyan-400 to-emerald-500 flex items-center justify-center shadow-md shadow-cyan-500/20 flex-shrink-0">
          <Megaphone className="h-4 w-4 text-white" />
        </div>
      );
    default:
      return (
        <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-gray-300 to-gray-400 flex items-center justify-center shadow-md flex-shrink-0">
          <Users className="h-4 w-4 text-white" />
        </div>
      );
  }
}

// --- Status Dot ---

function StatusDot({ type, read }: { type: string; read?: boolean }) {
  if (read) return null;
  const colors: Record<string, string> = {
    turn: 'bg-emerald-500 shadow-emerald-400/50',
    queue: 'bg-teal-500 shadow-teal-400/50',
    system: 'bg-cyan-500 shadow-cyan-400/50',
    success: 'bg-emerald-500 shadow-emerald-400/50',
    warning: 'bg-amber-500 shadow-amber-400/50',
    error: 'bg-rose-500 shadow-rose-400/50',
    info: 'bg-cyan-500 shadow-cyan-400/50',
  };
  const color = colors[type] || colors.system;
  return (
    <div className="relative flex-shrink-0">
      <div className={`h-2 w-2 rounded-full ${color} shadow-sm`} />
    </div>
  );
}

// --- Date Group Header ---

function DateGroupHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="sticky top-0 z-10 px-4 py-2 bg-background/95 backdrop-blur-sm border-b border-border/30">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-bold text-emerald-600 dark:text-emerald-400 uppercase tracking-wide">
          {label}
        </span>
        <span className="text-[9px] text-muted-foreground bg-emerald-50 dark:bg-emerald-900/20 px-1.5 py-0.5 rounded-full font-medium">
          {count}
        </span>
        <div className="flex-1 h-px bg-gradient-to-r from-transparent via-border/40 to-transparent" />
      </div>
    </div>
  );
}

// --- Announcement Icon ---

function AnnouncementIcon({ type }: { type?: string }) {
  switch (type?.toUpperCase()) {
    case 'WARNING':
      return <AlertTriangle className="h-4 w-4 text-amber-500" />;
    case 'URGENT':
      return <AlertCircle className="h-4 w-4 text-rose-500" />;
    default:
      return <Megaphone className="h-4 w-4 text-cyan-500" />;
  }
}

// --- Main Component ---

export default function NotificationsPage() {
  const { t } = useLanguage();
  const { agencyId } = useAppStore();

  // State
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [unreadCount, setUnreadCount] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [markingAllRead, setMarkingAllRead] = useState(false);

  // Filters
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<Notification | null>(null);

  // Announcements
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [announcementsLoading, setAnnouncementsLoading] = useState(true);
  const [showAnnouncementDialog, setShowAnnouncementDialog] = useState(false);
  const [newAnnouncement, setNewAnnouncement] = useState({ title: '', message: '', type: 'INFO' });
  const [creatingAnnouncement, setCreatingAnnouncement] = useState(false);
  const [deleteAnnouncementTarget, setDeleteAnnouncementTarget] = useState<Announcement | null>(null);

  // Active tab
  const [activeTab, setActiveTab] = useState<'notifications' | 'announcements'>('notifications');

  // Fetch Notifications
  const fetchNotifications = useCallback(
    async (append = false) => {
      if (!append) setRefreshing(true);
      setError(null);

      try {
        const skip = append ? notifications.length : 0;
        const params = new URLSearchParams({
          take: String(PAGE_SIZE),
          skip: String(skip),
        });
        if (statusFilter === 'unread') params.set('unreadOnly', 'true');
        if (typeFilter !== 'all') params.set('type', typeFilter.toUpperCase());

        const res = await apiFetch(`/api/notifications?${params}`);
        if (!res.ok) throw new Error('Failed to fetch notifications');
        const data = await res.json();

        const apiNotifs: Notification[] = data.notifications || data.data || [];

        if (append) {
          setNotifications((prev) => [...prev, ...apiNotifs]);
        } else {
          setNotifications(apiNotifs);
        }

        setTotal(data.total ?? apiNotifs.length);
        setUnreadCount(data.unreadCount ?? 0);
        setHasMore(apiNotifs.length >= PAGE_SIZE);
      } catch {
        if (!append) setError(t('noNotifications'));
      } finally {
        setLoading(false);
        setRefreshing(false);
        setLoadingMore(false);
      }
    },
    [notifications.length, statusFilter, typeFilter, t]
  );

  // Fetch Announcements
  const fetchAnnouncements = useCallback(async () => {
    if (!agencyId) return;
    setAnnouncementsLoading(true);
    try {
      const res = await apiFetch(`/api/agency/announcements?agencyId=${agencyId}`);
      if (!res.ok) throw new Error('Failed');
      const data = await res.json();
      setAnnouncements(data.announcements || data.data || []);
    } catch {
      /* silent */
    } finally {
      setAnnouncementsLoading(false);
    }
  }, [agencyId]);

  // Initial Load
  useEffect(() => {
    setLoading(true);
    fetchNotifications(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeFilter, statusFilter]);

  useEffect(() => {
    fetchAnnouncements();
  }, [fetchAnnouncements]);

  // Mark as Read
  const markAsRead = useCallback(
    async (id: string) => {
      setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, isRead: true } : n)));
      setUnreadCount((prev) => Math.max(0, prev - 1));

      try {
        const res = await apiFetch(`/api/notifications/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ isRead: true }),
        });
        if (!res.ok) throw new Error();
        toast.success(t('markReadSuccess'));
      } catch {
        setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, isRead: false } : n)));
        setUnreadCount((prev) => prev + 1);
      }
    },
    [t]
  );

  // Mark All as Read
  const markAllAsRead = useCallback(async () => {
    if (unreadCount === 0) return;
    setMarkingAllRead(true);

    const unreadIds = notifications.filter((n) => !n.isRead).map((n) => n.id);
    for (let i = 0; i < unreadIds.length; i++) {
      setTimeout(() => {
        setNotifications((prev) =>
          prev.map((n) => (n.id === unreadIds[i] ? { ...n, isRead: true } : n))
        );
      }, i * 60);
    }

    try {
      const res = await apiFetch('/api/notifications/read-all', { method: 'PUT' });
      if (!res.ok) throw new Error();
      setUnreadCount(0);
      toast.success(t('markAllReadSuccess'));
    } catch {
      fetchNotifications(false);
    }

    setTimeout(() => setMarkingAllRead(false), unreadIds.length * 60 + 200);
  }, [notifications, unreadCount, t, fetchNotifications]);

  // Delete Notification
  const deleteNotification = useCallback(
    async (id: string) => {
      const target = notifications.find((n) => n.id === id);
      setNotifications((prev) => prev.filter((n) => n.id !== id));
      if (target && !target.isRead) setUnreadCount((prev) => Math.max(0, prev - 1));

      try {
        const res = await apiFetch(`/api/notifications/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error();
        toast.success(t('notificationDeleted'));
      } catch {
        fetchNotifications(false);
      }
      setDeleteTarget(null);
    },
    [notifications, t, fetchNotifications]
  );

  // Create Announcement
  const createAnnouncement = useCallback(async () => {
    if (!agencyId || !newAnnouncement.title.trim() || !newAnnouncement.message.trim()) return;
    setCreatingAnnouncement(true);
    try {
      const res = await apiFetch(`/api/agency/announcements?agencyId=${agencyId}`, {
        method: 'POST',
        body: JSON.stringify(newAnnouncement),
      });
      if (!res.ok) throw new Error();
      toast.success(t('announcementCreatedSuccess'));
      setNewAnnouncement({ title: '', message: '', type: 'INFO' });
      setShowAnnouncementDialog(false);
      fetchAnnouncements();
    } catch {
      toast.error(t('error'));
    } finally {
      setCreatingAnnouncement(false);
    }
  }, [agencyId, newAnnouncement, t, fetchAnnouncements]);

  // Delete Announcement
  const deleteAnnouncement = useCallback(
    async (id: string) => {
      try {
        const res = await apiFetch(`/api/agency/announcements/${id}?agencyId=${agencyId}`, {
          method: 'DELETE',
        });
        if (!res.ok) throw new Error();
        toast.success(t('announcementDeletedSuccess'));
        fetchAnnouncements();
      } catch {
        toast.error(t('error'));
      }
      setDeleteAnnouncementTarget(null);
    },
    [agencyId, t, fetchAnnouncements]
  );

  // Refetch
  const refetch = useCallback(() => {
    setRefreshing(true);
    fetchNotifications(false);
  }, [fetchNotifications]);

  // Load More
  const loadMore = useCallback(() => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    fetchNotifications(true);
  }, [loadingMore, hasMore, fetchNotifications]);

  // Filtered notifications (client-side search)
  const filteredNotifications = useMemo(() => {
    if (!searchQuery.trim()) return notifications;
    const q = searchQuery.toLowerCase();
    return notifications.filter(
      (n) =>
        (n.title || '').toLowerCase().includes(q) ||
        (n.message || '').toLowerCase().includes(q)
    );
  }, [notifications, searchQuery]);

  // Grouped by date
  const groupedNotifications = useMemo(
    () => groupNotificationsByDate(filteredNotifications, t),
    [filteredNotifications, t]
  );

  // Render
  return (
    <div className="space-y-6">
      {/* Page Header */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="flex items-center justify-between"
      >
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('notifications')}</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {unreadCount > 0
              ? `${unreadCount} ${t('unreadNotifications')}`
              : t('allNotificationsRead')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {unreadCount > 0 && (
            <Badge className="bg-gradient-to-r from-emerald-500 to-teal-500 text-white text-[10px] px-2 py-0.5 border-0 shadow-sm">
              {unreadCount}
            </Badge>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9 rounded-full hover:bg-emerald-50 dark:hover:bg-emerald-900/20"
            onClick={refetch}
            disabled={refreshing}
            aria-label={t('refresh')}
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </motion.div>

      {/* Tab Switcher */}
      <div className="flex items-center gap-1 p-1 bg-muted/50 rounded-lg w-fit">
        {[
          { key: 'notifications' as const, label: t('notifications'), icon: Bell },
          { key: 'announcements' as const, label: t('announcements'), icon: Megaphone },
        ].map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-medium transition-all ${
              activeTab === tab.key
                ? 'bg-background shadow-sm text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <tab.icon className="h-4 w-4" />
            {tab.label}
          </button>
        ))}
      </div>

      <AnimatePresence mode="wait">
        {activeTab === 'notifications' ? (
          <motion.div
            key="notifications"
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 10 }}
            transition={{ duration: 0.2 }}
          >
            {/* Filters */}
            <Card className="mb-4">
              <CardContent className="p-4">
                <div className="flex flex-col sm:flex-row gap-3">
                  {/* Search */}
                  <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      placeholder={t('search')}
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="pl-9 h-9"
                    />
                  </div>

                  {/* Type Filter */}
                  <div className="flex items-center gap-1.5 overflow-x-auto">
                    <Filter className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                    {TYPE_FILTERS.map((tf) => (
                      <button
                        key={tf.value}
                        onClick={() => setTypeFilter(tf.value)}
                        className={`flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-all ${
                          typeFilter === tf.value
                            ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300'
                            : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                        }`}
                      >
                        {tf.value !== 'all' && tf.color && (
                          <span className={`h-1.5 w-1.5 rounded-full ${tf.color}`} />
                        )}
                        {t(tf.labelKey)}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Status Filter + Actions */}
                <div className="flex items-center justify-between mt-3">
                  <div className="flex items-center gap-1">
                    {STATUS_FILTERS.map((sf) => (
                      <button
                        key={sf.value}
                        onClick={() => setStatusFilter(sf.value)}
                        className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${
                          statusFilter === sf.value
                            ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300'
                            : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                        }`}
                      >
                        {t(sf.labelKey)}
                        {sf.value === 'unread' && unreadCount > 0 && (
                          <span className="ml-1 text-[10px] bg-emerald-500 text-white px-1 rounded-full">
                            {unreadCount}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>

                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-3 text-[11px] gap-1.5 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 rounded-lg disabled:opacity-50"
                      onClick={markAllAsRead}
                      disabled={unreadCount === 0 || markingAllRead}
                    >
                      {markingAllRead ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <CheckCheck className="h-3.5 w-3.5" />
                      )}
                      {t('markAllRead')}
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Error State */}
            {error && (
              <motion.div
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                className="mb-4 flex items-center gap-2 px-4 py-3 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/30"
              >
                <AlertCircle className="h-4 w-4 text-red-500 flex-shrink-0" />
                <p className="text-xs text-red-700 dark:text-red-400 flex-1">{error}</p>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-[10px] text-red-600 hover:bg-red-100 dark:hover:bg-red-900/30 rounded-md"
                  onClick={refetch}
                >
                  {t('refresh')}
                </Button>
              </motion.div>
            )}

            {/* Notifications List */}
            {loading ? (
              <Card>
                <CardContent className="p-0">
                  <div className="divide-y divide-border/30">
                    {Array.from({ length: 5 }).map((_, i) => (
                      <div key={i} className="px-4 py-4">
                        <div className="flex items-start gap-3">
                          <Skeleton className="h-9 w-9 rounded-xl flex-shrink-0" />
                          <div className="flex-1 space-y-2">
                            <Skeleton className="h-4 w-3/4" />
                            <Skeleton className="h-3 w-full" />
                            <Skeleton className="h-2 w-16" />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            ) : filteredNotifications.length === 0 ? (
              /* Empty State */
              <Card>
                <CardContent className="py-16">
                  <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.4 }}
                    className="flex flex-col items-center justify-center text-center"
                  >
                    <div className="relative mb-6">
                      <motion.div
                        animate={{ y: [-4, 4, -4] }}
                        transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
                      >
                        <div className="h-20 w-20 rounded-2xl bg-gradient-to-br from-emerald-100 to-teal-100 dark:from-emerald-900/30 dark:to-teal-900/30 flex items-center justify-center shadow-xl shadow-emerald-500/10">
                          <Bell className="h-8 w-8 text-emerald-500 dark:text-emerald-400" />
                        </div>
                      </motion.div>
                      <motion.div
                        className="absolute -top-1 -right-1 h-5 w-5 rounded-full bg-teal-400/20 dark:bg-teal-400/10 flex items-center justify-center"
                        animate={{ scale: [1, 1.3, 1], opacity: [0.4, 0.8, 0.4] }}
                        transition={{ duration: 2.5, repeat: Infinity, ease: 'easeInOut' }}
                      >
                        <Sparkles className="h-2.5 w-2.5 text-teal-500 dark:text-teal-400" />
                      </motion.div>
                    </div>
                    <p className="text-base font-bold text-foreground mb-1">
                      {t('noNotifications')}
                    </p>
                    <p className="text-sm text-muted-foreground max-w-[240px] leading-relaxed">
                      {t('noNotificationsDesc')}
                    </p>
                  </motion.div>
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardContent className="p-0">
                  <ScrollArea className="max-h-[70vh]">
                    {groupedNotifications.map((group, gIdx) => (
                      <div key={group.group}>
                        <DateGroupHeader label={group.label} count={group.items.length} />
                        <div className="divide-y divide-border/30">
                          {group.items.map((notif, idx) => {
                            const globalIdx = gIdx * 10 + idx;
                            const notifType = mapApiType(notif.type || '');
                            return (
                              <motion.div
                                key={notif.id}
                                initial={{ opacity: 0, x: 20, scale: 0.98 }}
                                animate={{ opacity: 1, x: 0, scale: 1 }}
                                transition={{
                                  delay: Math.min(globalIdx * 0.03, 0.4),
                                  type: 'spring',
                                  stiffness: 220,
                                  damping: 22,
                                }}
                                whileHover={{
                                  backgroundColor: notif.isRead
                                    ? 'rgba(16, 185, 129, 0.03)'
                                    : 'rgba(16, 185, 129, 0.06)',
                                }}
                                className={`relative px-4 py-3.5 transition-colors duration-200 cursor-pointer group ${
                                  !notif.isRead
                                    ? 'bg-gradient-to-r from-emerald-50/40 via-teal-50/20 to-transparent dark:from-emerald-950/10 dark:via-teal-950/5'
                                    : ''
                                }`}
                                onClick={() => !notif.isRead && markAsRead(notif.id)}
                              >
                                {/* Unread indicator bar */}
                                <AnimatePresence>
                                  {!notif.isRead && (
                                    <motion.div
                                      initial={{ scaleY: 0 }}
                                      animate={{ scaleY: 1 }}
                                      exit={{ scaleY: 0, opacity: 0 }}
                                      transition={{ duration: 0.3 }}
                                      className="absolute top-1 bottom-1 left-0 w-1 bg-gradient-to-b from-emerald-400 to-teal-500 rounded-r-full origin-center"
                                    />
                                  )}
                                </AnimatePresence>

                                <div className="flex items-start gap-3">
                                  <NotificationIcon type={notifType} />
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 mb-0.5">
                                      <p
                                        className={`text-sm truncate ${
                                          !notif.isRead
                                            ? 'font-semibold text-foreground'
                                            : 'font-medium text-foreground/80'
                                        }`}
                                      >
                                        {notif.title || t('notifSystem')}
                                      </p>
                                      <StatusDot type={notifType} read={notif.isRead} />
                                    </div>
                                    {notif.message && (
                                      <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
                                        {notif.message}
                                      </p>
                                    )}
                                    <p className="text-[10px] text-muted-foreground/60 mt-1">
                                      {formatRelativeTime(notif.createdAt)}
                                    </p>
                                  </div>

                                  {/* Action buttons */}
                                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                                    {!notif.isRead && (
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-7 w-7 rounded-full hover:bg-emerald-50 dark:hover:bg-emerald-900/20"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          markAsRead(notif.id);
                                        }}
                                        aria-label={t('markReadSuccess')}
                                      >
                                        <Check className="h-3.5 w-3.5 text-emerald-500" />
                                      </Button>
                                    )}
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-7 w-7 rounded-full hover:bg-rose-50 dark:hover:bg-rose-900/20"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setDeleteTarget(notif);
                                      }}
                                      aria-label={t('deleteNotification')}
                                    >
                                      <Trash2 className="h-3.5 w-3.5 text-rose-500" />
                                    </Button>
                                  </div>
                                </div>
                              </motion.div>
                            );
                          })}
                        </div>
                      </div>
                    ))}

                    {/* Load More */}
                    {hasMore && (
                      <div className="px-4 py-3 flex justify-center">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 px-4 text-[11px] gap-1.5 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 rounded-lg"
                          onClick={loadMore}
                          disabled={loadingMore}
                        >
                          {loadingMore ? (
                            <>
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              {t('loading')}
                            </>
                          ) : (
                            <>
                              <ChevronDown className="h-3.5 w-3.5" />
                              {t('loadMore')}
                            </>
                          )}
                        </Button>
                      </div>
                    )}

                    <div className="h-2" />
                  </ScrollArea>

                  {/* Footer */}
                  <div className="border-t border-border/50 px-4 py-2.5 bg-muted/30">
                    <div className="flex items-center justify-between">
                      <p className="text-[10px] text-muted-foreground">
                        {filteredNotifications.length} / {total}{' '}
                        {t('notifications').toLowerCase()}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}
          </motion.div>
        ) : (
          /* Announcements Tab */
          <motion.div
            key="announcements"
            initial={{ opacity: 0, x: 10 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -10 }}
            transition={{ duration: 0.2 }}
          >
            <div className="flex items-center justify-between mb-4">
              <p className="text-sm text-muted-foreground">{t('announcementPlaceholder')}</p>
              <Button
                size="sm"
                className="gap-1.5 bg-gradient-to-r from-emerald-500 to-teal-500 text-white hover:from-emerald-600 hover:to-teal-600"
                onClick={() => setShowAnnouncementDialog(true)}
              >
                <Plus className="h-4 w-4" />
                {t('announcement')}
              </Button>
            </div>

            {announcementsLoading ? (
              <Card>
                <CardContent className="p-0">
                  <div className="divide-y divide-border/30">
                    {Array.from({ length: 3 }).map((_, i) => (
                      <div key={i} className="px-4 py-4">
                        <div className="flex items-start gap-3">
                          <Skeleton className="h-9 w-9 rounded-xl flex-shrink-0" />
                          <div className="flex-1 space-y-2">
                            <Skeleton className="h-4 w-1/2" />
                            <Skeleton className="h-3 w-3/4" />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            ) : announcements.length === 0 ? (
              <Card>
                <CardContent className="py-16">
                  <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.4 }}
                    className="flex flex-col items-center justify-center text-center"
                  >
                    <div className="h-16 w-16 rounded-2xl bg-gradient-to-br from-cyan-100 to-emerald-100 dark:from-cyan-900/30 dark:to-emerald-900/30 flex items-center justify-center mb-4">
                      <Megaphone className="h-7 w-7 text-cyan-500 dark:text-cyan-400" />
                    </div>
                    <p className="text-base font-bold text-foreground mb-1">
                      {t('noAnnouncements')}
                    </p>
                  </motion.div>
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardContent className="p-0">
                  <div className="divide-y divide-border/30">
                    {announcements.map((ann, idx) => (
                      <motion.div
                        key={ann.id}
                        initial={{ opacity: 0, x: 20 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: idx * 0.05, duration: 0.3 }}
                        className="px-4 py-3.5 group hover:bg-muted/30 transition-colors"
                      >
                        <div className="flex items-start gap-3">
                          <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-cyan-100 to-emerald-100 dark:from-cyan-900/30 dark:to-emerald-900/30 flex items-center justify-center flex-shrink-0">
                            <AnnouncementIcon type={ann.type} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-0.5">
                              <p className="text-sm font-medium text-foreground truncate">
                                {ann.title}
                              </p>
                              {ann.type && (
                                <Badge
                                  variant="outline"
                                  className={`text-[9px] px-1.5 py-0 ${
                                    ann.type.toUpperCase() === 'WARNING'
                                      ? 'border-amber-300 text-amber-600 dark:border-amber-700 dark:text-amber-400'
                                      : ann.type.toUpperCase() === 'URGENT'
                                        ? 'border-rose-300 text-rose-600 dark:border-rose-700 dark:text-rose-400'
                                        : 'border-cyan-300 text-cyan-600 dark:border-cyan-700 dark:text-cyan-400'
                                  }`}
                                >
                                  {ann.type.toUpperCase() === 'WARNING'
                                    ? t('announcementTypeWarning')
                                    : ann.type.toUpperCase() === 'URGENT'
                                      ? t('announcementTypeUrgent')
                                      : t('announcementTypeInfo')}
                                </Badge>
                              )}
                            </div>
                            {ann.message && (
                              <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
                                {ann.message}
                              </p>
                            )}
                            <p className="text-[10px] text-muted-foreground/60 mt-1">
                              {formatRelativeTime(ann.createdAt)}
                            </p>
                          </div>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 rounded-full opacity-0 group-hover:opacity-100 hover:bg-rose-50 dark:hover:bg-rose-900/20 transition-opacity"
                            onClick={() => setDeleteAnnouncementTarget(ann)}
                            aria-label={t('delete')}
                          >
                            <Trash2 className="h-3.5 w-3.5 text-rose-500" />
                          </Button>
                        </div>
                      </motion.div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Delete Notification Confirmation */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('deleteNotification')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('confirmDeleteNotificationDesc')
                ? `${t('confirmDeleteNotificationDesc')} "${deleteTarget?.title || t('notifSystem')}"?`
                : `Are you sure you want to delete "${deleteTarget?.title || t('notifSystem')}"?`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-rose-500 text-white hover:bg-rose-600"
              onClick={() => deleteTarget && deleteNotification(deleteTarget.id)}
            >
              {t('delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Announcement Confirmation */}
      <AlertDialog
        open={!!deleteAnnouncementTarget}
        onOpenChange={(open) => !open && setDeleteAnnouncementTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('announcementDeleted')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('confirmDeleteAnnouncementDesc') || 'Are you sure you want to delete this announcement?'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-rose-500 text-white hover:bg-rose-600"
              onClick={() =>
                deleteAnnouncementTarget && deleteAnnouncement(deleteAnnouncementTarget.id)
              }
            >
              {t('delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Create Announcement Dialog */}
      <Dialog open={showAnnouncementDialog} onOpenChange={setShowAnnouncementDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('announcementCreated')}</DialogTitle>
            <DialogDescription>{t('announcementPlaceholder')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">{t('name')}</label>
              <Input
                placeholder={t('name')}
                value={newAnnouncement.title}
                onChange={(e) => setNewAnnouncement((p) => ({ ...p, title: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">
                {t('announcementMessage')}
              </label>
              <Textarea
                placeholder={t('announcementMessagePlaceholder')}
                value={newAnnouncement.message}
                onChange={(e) => setNewAnnouncement((p) => ({ ...p, message: e.target.value }))}
                rows={3}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">
                {t('announcementType')}
              </label>
              <div className="flex items-center gap-2">
                {(['INFO', 'WARNING', 'URGENT'] as const).map((atype) => (
                  <button
                    key={atype}
                    onClick={() => setNewAnnouncement((p) => ({ ...p, type: atype }))}
                    className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                      newAnnouncement.type === atype
                        ? atype === 'INFO'
                          ? 'bg-cyan-100 dark:bg-cyan-900/30 text-cyan-700 dark:text-cyan-300'
                          : atype === 'WARNING'
                            ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300'
                            : 'bg-rose-100 dark:bg-rose-900/30 text-rose-700 dark:text-rose-300'
                        : 'bg-muted text-muted-foreground'
                    }`}
                  >
                    {atype === 'INFO'
                      ? t('announcementTypeInfo')
                      : atype === 'WARNING'
                        ? t('announcementTypeWarning')
                        : t('announcementTypeUrgent')}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowAnnouncementDialog(false)}>
              {t('cancel')}
            </Button>
            <Button
              className="bg-gradient-to-r from-emerald-500 to-teal-500 text-white hover:from-emerald-600 hover:to-teal-600"
              onClick={createAnnouncement}
              disabled={
                creatingAnnouncement ||
                !newAnnouncement.title.trim() ||
                !newAnnouncement.message.trim()
              }
            >
              {creatingAnnouncement && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
              {t('submit')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
