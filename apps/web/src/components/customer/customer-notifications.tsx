'use client';
import { apiFetch } from "@/lib/api-fetch";
import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useAppStore } from '@/store/use-app-store';
import { useLanguage } from '@/hooks/use-language';
import { useRealtime } from '@/hooks/use-realtime';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/shared/error-state';
import { EmptyState } from '@/components/shared/empty-state';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Bell,
  BellOff,
  BellRing,
  Check,
  CheckCircle,
  CheckCheck,
  XCircle,
  Trash2,
  Volume2,
  TicketCheck,
  AlertTriangle,
  Clock,
  Info,
  CalendarDays,
  Sparkles,
  RefreshCw,
  ArrowRight,
  ChevronLeft,
  Eye,
} from 'lucide-react';
import { motion, AnimatePresence, useMotionValue, useTransform, PanInfo } from 'framer-motion';
import { toast } from 'sonner';

interface Notification {
  id: string;
  type: string;
  title: string;
  message: string;
  isRead: boolean;
  createdAt: string;
  readAt?: string | null;
  data?: Record<string, unknown>;
}

function getNotificationConfig(type: string) {
  switch (type) {
    case 'QUEUE_CALLED':
      return { icon: Bell, dotColor: 'bg-emerald-500', borderAccent: 'border-s-emerald-500', borderAccentVar: 'emerald', iconBg: 'bg-emerald-100 dark:bg-emerald-900/30', iconColor: 'text-emerald-600 dark:text-emerald-400', glowColor: 'shadow-emerald-500/10' };
    case 'QUEUE_JOINED':
      return { icon: TicketCheck, dotColor: 'bg-teal-500', borderAccent: 'border-s-teal-500', borderAccentVar: 'teal', iconBg: 'bg-teal-100 dark:bg-teal-900/30', iconColor: 'text-teal-600 dark:text-teal-400', glowColor: 'shadow-teal-500/10' };
    case 'QUEUE_COMPLETED':
      return { icon: CheckCircle, dotColor: 'bg-emerald-600', borderAccent: 'border-s-emerald-600', borderAccentVar: 'emerald', iconBg: 'bg-emerald-100 dark:bg-emerald-900/30', iconColor: 'text-emerald-600 dark:text-emerald-400', glowColor: 'shadow-emerald-500/10' };
    case 'QUEUE_CANCELLED':
      return { icon: XCircle, dotColor: 'bg-red-500', borderAccent: 'border-s-red-500', borderAccentVar: 'red', iconBg: 'bg-red-100 dark:bg-red-900/30', iconColor: 'text-red-600 dark:text-red-400', glowColor: 'shadow-red-500/10' };
    case 'TURN_APPROACHING':
      return { icon: Clock, dotColor: 'bg-amber-500', borderAccent: 'border-s-amber-500', borderAccentVar: 'amber', iconBg: 'bg-amber-100 dark:bg-amber-900/30', iconColor: 'text-amber-600 dark:text-amber-400', glowColor: 'shadow-amber-500/10' };
    case 'NO_SHOW_WARNING':
      return { icon: AlertTriangle, dotColor: 'bg-orange-500', borderAccent: 'border-s-orange-500', borderAccentVar: 'orange', iconBg: 'bg-orange-100 dark:bg-orange-900/30', iconColor: 'text-orange-600 dark:text-orange-400', glowColor: 'shadow-orange-500/10' };
    case 'RECLAIM_SUCCESS':
      return { icon: CheckCheck, dotColor: 'bg-sky-500', borderAccent: 'border-s-sky-500', borderAccentVar: 'sky', iconBg: 'bg-sky-100 dark:bg-sky-900/30', iconColor: 'text-sky-600 dark:text-sky-400', glowColor: 'shadow-sky-500/10' };
    default:
      return { icon: Info, dotColor: 'bg-gray-400', borderAccent: 'border-s-gray-400', borderAccentVar: 'gray', iconBg: 'bg-gray-100 dark:bg-gray-800', iconColor: 'text-gray-600 dark:text-gray-400', glowColor: 'shadow-gray-500/10' };
  }
}

function getDateGroup(date: Date): string {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);

  const dateOnly = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  if (dateOnly.getTime() === today.getTime()) return 'today';
  if (dateOnly.getTime() === yesterday.getTime()) return 'yesterday';
  return 'earlier';
}

function getDateGroupLabel(group: string, t: (key: any) => string): string {
  switch (group) {
    case 'today': return t('today');
    case 'yesterday': return t('yesterday');
    case 'earlier': return t('earlier');
    default: return group;
  }
}

function getDateGroupIcon(group: string) {
  switch (group) {
    case 'today': return Sparkles;
    case 'yesterday': return CalendarDays;
    default: return CalendarDays;
  }
}

type FilterType = 'all' | 'unread' | 'queue' | 'general';

// Swipe-to-dismiss notification card component
function NotificationCard({
  notif,
  config,
  relativeTime,
  t,
  onMarkRead,
  onDelete,
  actionLoading,
  isRtl,
}: {
  notif: Notification;
  config: ReturnType<typeof getNotificationConfig>;
  relativeTime: string;
  t: (key: any) => string;
  onMarkRead: (id: string) => void;
  onDelete: (id: string) => void;
  actionLoading: string | null;
  isRtl: boolean;
}) {
  const IconComponent = config.icon;
  const [isExiting, setIsExiting] = useState(false);
  const x = useMotionValue(0);
  const opacity = useTransform(x, [-150, 0, 150], [0.3, 1, 0.3]);
  const deleteOpacity = useTransform(x, (v) => {
    const abs = Math.abs(v);
    return Math.min(abs / 80, 1);
  });

  const handlePanEnd = (_: unknown, info: PanInfo) => {
    const threshold = 100;
    if (Math.abs(info.offset.x) > threshold) {
      setIsExiting(true);
      setTimeout(() => onDelete(notif.id), 200);
    }
  };

  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.95, y: 10 }}
      animate={{ opacity: isExiting ? 0 : notif.isRead ? 0.75 : 1, scale: isExiting ? 0.9 : 1, y: 0, x: isExiting ? (isRtl ? 300 : -300) : 0 }}
      exit={{ opacity: 0, scale: 0.9, x: isRtl ? 300 : -300, transition: { duration: 0.2 } }}
      transition={{ duration: 0.25 }}
      className="relative overflow-hidden"
    >
      {/* Delete background for swipe */}
      <motion.div
        style={{ opacity: deleteOpacity }}
        className={`absolute inset-0 flex items-center ${isRtl ? 'justify-start ps-6' : 'justify-end pe-6'} bg-red-500 rounded-2xl`}
      >
        <Trash2 className="h-5 w-5 text-white" />
      </motion.div>

      <motion.div
        style={{ x, opacity }}
        onPanEnd={handlePanEnd}
        onPan={(_, info) => {
          x.set(info.offset.x);
        }}
        className={`relative rounded-2xl overflow-hidden transition-all duration-300 hover:-translate-y-0.5 hover:shadow-lg ${config.glowColor} border-s-4 ${config.borderAccent} ${
          !notif.isRead
            ? 'bg-white dark:bg-gray-900/90 shadow-sm'
            : 'bg-white/60 dark:bg-gray-900/50'
        }`}
      >
        <CardContent className="p-3.5 flex items-start gap-3">
          {/* Icon with unread pulse */}
          <div className="relative flex-shrink-0">
            <button
              onClick={() => !notif.isRead && onMarkRead(notif.id)}
              className={`h-10 w-10 rounded-xl ${config.iconBg} flex items-center justify-center transition-transform duration-200 hover:scale-110 ${!notif.isRead ? 'cursor-pointer' : 'cursor-default'}`}
              aria-label={!notif.isRead ? t('markAsRead') : undefined}
            >
              <IconComponent className={`h-5 w-5 ${config.iconColor}`} />
            </button>
            {!notif.isRead && (
              <motion.div
                className="absolute -top-0.5 -end-0.5 h-3 w-3 rounded-full bg-red-500 border-2 border-white dark:border-gray-900"
                animate={{ scale: [1, 1.3, 1] }}
                transition={{ duration: 2, repeat: Infinity , ease: 'easeInOut' }}
              />
            )}
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <p className={`text-sm font-semibold leading-tight truncate ${!notif.isRead ? 'text-foreground' : 'text-muted-foreground'}`}>
                {notif.title}
              </p>
            </div>
            <p className={`text-xs leading-relaxed line-clamp-2 ${!notif.isRead ? 'text-muted-foreground' : 'text-muted-foreground/70'}`}>
              {notif.message}
            </p>
            <div className="flex items-center gap-2 mt-1.5">
              <span className="text-[10px] text-muted-foreground/50 flex items-center gap-1">
                <Clock className="h-2.5 w-2.5" />
                {relativeTime}
              </span>
              {!notif.isRead && (
                <span className="text-[9px] font-semibold text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/20 px-1.5 py-0.5 rounded-full">
                  {t('new') || 'New'}
                </span>
              )}
              {notif.isRead && (
                <span className="text-[9px] text-muted-foreground/40 flex items-center gap-0.5">
                  <Eye className="h-2.5 w-2.5" />
                  {t('read') || 'Read'}
                </span>
              )}
            </div>
          </div>

          <button
            onClick={() => onDelete(notif.id)}
            className="flex-shrink-0 min-h-[44px] min-w-[44px] p-1.5 text-muted-foreground/40 hover:text-red-500 transition-colors rounded-lg hover:bg-red-50 dark:hover:bg-red-900/10 mt-0.5 flex items-center justify-center"
            disabled={actionLoading === notif.id}
            aria-label={t('delete') || 'Delete'}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </CardContent>
      </motion.div>
    </motion.div>
  );
}

export function CustomerNotifications() {
  const { user, setView } = useAppStore();
  const { t, lang } = useLanguage();
  const realtime = useRealtime();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [allMarkedRead, setAllMarkedRead] = useState(false);
  const [activeFilter, setActiveFilter] = useState<FilterType>('all');
  const [transitioningIds, setTransitioningIds] = useState<Set<string>>(new Set());
  const refreshTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isRtl = lang === 'ar';

  const fetchNotifications = useCallback(async (showRefresh = false) => {
    if (!user?.id) return;
    if (showRefresh) setRefreshing(true);
    setFetchError(false);
    try {
      const { fetchWithRetry } = await import('@/lib/fetch-with-retry');
      const res = await fetchWithRetry(`/api/notifications?userId=${user.id}`);
      if (res.ok) {
        const data = await res.json();
        setNotifications(data.notifications ?? []);
      } else {
        // Only set error on initial load (not background refresh)
        if (!showRefresh && notifications.length === 0) {
          setFetchError(true);
        }
      }
    } catch {
      // Only set error on initial load (not background refresh)
      if (!showRefresh && notifications.length === 0) {
        setFetchError(true);
      }
    } finally {
      if (showRefresh) {
        setTimeout(() => setRefreshing(false), 500);
      }
      setLoading(false);
    }
  }, [user?.id]);

  useEffect(() => {
    fetchNotifications();
  }, [fetchNotifications]);

  // Auto-refresh every 30s
  useEffect(() => {
    const interval = setInterval(() => fetchNotifications(), 30000);
    return () => clearInterval(interval);
  }, [fetchNotifications]);

  // ─── Realtime: Join customer room for instant updates ────────────────
  useEffect(() => {
    if (!user?.id) return;
    realtime.joinCustomer(user.id);
    return () => {
      realtime.leaveCustomer(user.id);
    };
  }, [user?.id]);

  // ─── Realtime: Instant updates on notification events ────────────────
  useEffect(() => {
    if (!user?.id) return;
    const unsubscribers: (() => void)[] = [];

    const handleNotificationEvent = () => {
      fetchNotifications();
    };

    unsubscribers.push(realtime.onNotification(handleNotificationEvent));
    unsubscribers.push(realtime.onTurnApproaching(handleNotificationEvent));
    unsubscribers.push(realtime.onYourTurn(handleNotificationEvent));

    return () => {
      unsubscribers.forEach(unsub => unsub());
    };
  }, [user?.id, realtime]);

  const handleMarkAllRead = async () => {
    setActionLoading('all');
    try {
      const res = await apiFetch(`/api/notifications`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user?.id, markAll: true }),
      });
      if (res.ok) {
        setAllMarkedRead(true);
        // Mark all local notifications as read with transition
        setTransitioningIds((prev) => {
          const next = new Set(prev);
          notifications.filter((n) => !n.isRead).forEach((n) => next.add(n.id));
          return next;
        });
        setTimeout(() => {
          setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
          setTransitioningIds(new Set());
        }, 400);
        toast.success(t('markAllReadSuccess'));
        window.dispatchEvent(new CustomEvent('blasti:notifications-read'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setActionLoading(null);
    }
  };

  const handleMarkRead = async (id: string) => {
    try {
      const res = await apiFetch(`/api/notifications/${id}`, { method: 'PATCH' });
      if (res.ok) {
        setTransitioningIds((prev) => new Set(prev).add(id));
        setTimeout(() => {
          setNotifications((prev) =>
            prev.map((n) => (n.id === id ? { ...n, isRead: true } : n))
          );
          setTransitioningIds(new Set());
        }, 400);
        toast.success(t('markReadSuccess'));
        window.dispatchEvent(new CustomEvent('blasti:notifications-read'));
      }
    } catch {
      toast.error(t('error'));
    }
  };

  const handleDelete = async (id: string) => {
    setActionLoading(id);
    try {
      const res = await apiFetch(`/api/notifications/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setNotifications((prev) => prev.filter((n) => n.id !== id));
        toast.success(t('notificationDeleted') || t('success'));
        window.dispatchEvent(new CustomEvent('blasti:notifications-read'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setActionLoading(null);
    }
  };

  const handleRefresh = () => {
    if (refreshing) return;
    fetchNotifications(true);
  };

  const unreadCount = notifications.filter((n) => !n.isRead).length;
  const readCount = notifications.filter((n) => n.isRead).length;

  // Queue-type notifications
  const queueTypes = ['QUEUE_CALLED', 'QUEUE_JOINED', 'QUEUE_COMPLETED', 'QUEUE_CANCELLED', 'TURN_APPROACHING', 'NO_SHOW_WARNING', 'RECLAIM_SUCCESS'];
  const queueCount = notifications.filter((n) => queueTypes.includes(n.type)).length;
  const generalCount = notifications.filter((n) => !queueTypes.includes(n.type)).length;

  // Filter notifications
  const filteredNotifications = useMemo(() => {
    switch (activeFilter) {
      case 'unread': return notifications.filter((n) => !n.isRead);
      case 'queue': return notifications.filter((n) => queueTypes.includes(n.type));
      case 'general': return notifications.filter((n) => !queueTypes.includes(n.type));
      default: return notifications;
    }
  }, [notifications, activeFilter]);

  // Group notifications by date
  const groupedNotifications = useMemo(() => {
    const groups: Record<string, Notification[]> = {};
    filteredNotifications.forEach((notif) => {
      const group = getDateGroup(new Date(notif.createdAt));
      if (!groups[group]) groups[group] = [];
      groups[group].push(notif);
    });
    const sortedGroups: [string, Notification[]][] = [];
    const order = ['today', 'yesterday', 'earlier'];
    order.forEach((key) => {
      if (groups[key]) sortedGroups.push([key, groups[key]]);
    });
    return sortedGroups;
  }, [filteredNotifications]);

  const getRelativeTime = (dateStr: string) => {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return t('justNow');
    if (mins < 60) return `${mins} ${t('minutesLabel')} ${t('timeAgo')}`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}${t('hours') ? ' ' + t('hours') : 'h'} ${t('timeAgo')}`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days} ${t('timeAgo')}`;
    return new Date(dateStr).toLocaleDateString(
      lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US',
      { month: 'short', day: 'numeric' }
    );
  };

  if (loading) {
    return (
      <div className="px-4 py-4 pb-24">
        <Skeleton className="h-8 w-40 mb-6 skeleton-shimmer" />
        <div className="grid grid-cols-3 gap-2 mb-4">
          <Skeleton className="h-16 rounded-xl skeleton-shimmer" />
          <Skeleton className="h-16 rounded-xl skeleton-shimmer" />
          <Skeleton className="h-16 rounded-xl skeleton-shimmer" />
        </div>
        <div className="flex gap-2 mb-4">
          <Skeleton className="h-9 w-20 rounded-lg skeleton-shimmer" />
          <Skeleton className="h-9 w-20 rounded-lg skeleton-shimmer" />
          <Skeleton className="h-9 w-20 rounded-lg skeleton-shimmer" />
          <Skeleton className="h-9 w-20 rounded-lg skeleton-shimmer" />
        </div>
        {[...Array(4)].map((_, i) => (
          <Skeleton key={i} className="h-24 rounded-2xl mb-3 skeleton-shimmer" />
        ))}
      </div>
    );
  }

  // Show error state with retry if initial fetch failed
  if (fetchError && notifications.length === 0) {
    return (
      <div className="px-4 py-4 pb-24">
        <ErrorState onRetry={() => fetchNotifications(false)} />
      </div>
    );
  }

  return (
    <div className="px-4 py-4 pb-24">
      {/* Gradient accent bar at top */}
      <div className="absolute top-0 start-0 end-0 h-[3px] gradient-flow-bar rounded-full" />

      {/* Header with pull-to-refresh */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="mb-4"
      >
        {/* Pull-to-refresh indicator */}
        <AnimatePresence>
          {refreshing && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 40 }}
              exit={{ opacity: 0, height: 0 }}
              className="flex items-center justify-center overflow-hidden mb-2"
            >
              <motion.div
                animate={{ rotate: 360 }}
                transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
              >
                <RefreshCw className="h-5 w-5 text-emerald-500" />
              </motion.div>
              <span className="ms-2 text-xs text-muted-foreground">{t('refreshing') || 'Refreshing...'}</span>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="flex items-center gap-3 mb-1">
          <div className="h-1.5 w-8 rounded-full bg-gradient-to-r from-emerald-500 to-teal-500" />
          <h1 className="text-2xl font-bold bg-gradient-to-r from-emerald-600 via-teal-600 to-emerald-700 bg-clip-text text-transparent">{t('notifications')}</h1>
          {/* Live connection indicator */}
          <span className={`flex items-center gap-1.5 text-xs ${realtime.isConnected ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>
            <span className={`h-2 w-2 rounded-full inline-block ${realtime.isConnected ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'}`} />
            {realtime.isConnected ? (t('live') || 'Live') : (t('polling') || 'Polling')}
          </span>
          <button
            onClick={handleRefresh}
            className="ms-auto min-h-[44px] min-w-[44px] p-1.5 rounded-lg hover:bg-muted transition-colors flex items-center justify-center"
            aria-label={t('refresh')}
          >
            <RefreshCw className={`h-4 w-4 text-muted-foreground ${refreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
        {unreadCount > 0 && (
          <p className="text-sm text-muted-foreground ms-[44px]">
            {unreadCount} {t('unreadNotifications') || 'unread notifications'}
          </p>
        )}
      </motion.div>

      {/* Stats Summary Bar */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.05 }}
        className="grid grid-cols-3 gap-2 mb-4"
      >
        <div className="flex items-center gap-2 p-2.5 rounded-xl bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-emerald-900/20 dark:to-teal-900/20 border border-emerald-100 dark:border-emerald-800/30">
          <div className="h-7 w-7 rounded-lg bg-emerald-100 dark:bg-emerald-800/40 flex items-center justify-center flex-shrink-0">
            <Bell className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
          </div>
          <div>
            <p className="text-xs font-bold text-emerald-700 dark:text-emerald-400">{notifications.length}</p>
            <p className="text-[9px] text-muted-foreground">{t('total') || 'Total'}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 p-2.5 rounded-xl bg-gradient-to-br from-amber-50 to-orange-50 dark:from-amber-900/20 dark:to-orange-900/20 border border-amber-100 dark:border-amber-800/30">
          <div className="h-7 w-7 rounded-lg bg-amber-100 dark:bg-amber-800/40 flex items-center justify-center flex-shrink-0">
            <BellRing className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
          </div>
          <div>
            <p className="text-xs font-bold text-amber-700 dark:text-amber-400">{unreadCount}</p>
            <p className="text-[9px] text-muted-foreground">{t('unread') || 'Unread'}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 p-2.5 rounded-xl bg-gradient-to-br from-teal-50 to-cyan-50 dark:from-teal-900/20 dark:to-cyan-900/20 border border-teal-100 dark:border-teal-800/30">
          <div className="h-7 w-7 rounded-lg bg-teal-100 dark:bg-teal-800/40 flex items-center justify-center flex-shrink-0">
            <CheckCheck className="h-3.5 w-3.5 text-teal-600 dark:text-teal-400" />
          </div>
          <div>
            <p className="text-xs font-bold text-teal-700 dark:text-teal-400">{readCount}</p>
            <p className="text-[9px] text-muted-foreground">{t('read') || 'Read'}</p>
          </div>
        </div>
      </motion.div>

      {/* Filter Tabs + Mark All Read */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="flex items-center justify-between mb-4"
      >
        <Tabs value={activeFilter} onValueChange={(v) => setActiveFilter(v as FilterType)}>
          <TabsList className="h-9 bg-gray-100 dark:bg-gray-800 rounded-lg p-0.5">
            <TabsTrigger
              value="all"
              className="text-xs px-2.5 h-8 rounded-md data-[state=active]:bg-white data-[state=active]:dark:bg-gray-700 data-[state=active]:shadow-sm data-[state=active]:text-foreground"
            >
              {t('all') || 'All'}
              <span className="ms-1 text-[9px] text-muted-foreground">{notifications.length}</span>
            </TabsTrigger>
            <TabsTrigger
              value="unread"
              className="text-xs px-2.5 h-8 rounded-md data-[state=active]:bg-white data-[state=active]:dark:bg-gray-700 data-[state=active]:shadow-sm data-[state=active]:text-foreground"
            >
              {t('unread') || 'Unread'}
              {unreadCount > 0 && (
                <span className="ms-1 h-4 min-w-4 px-1 inline-flex items-center justify-center rounded-full bg-red-500 text-white text-[9px] font-bold">
                  {unreadCount}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger
              value="queue"
              className="text-xs px-2.5 h-8 rounded-md data-[state=active]:bg-white data-[state=active]:dark:bg-gray-700 data-[state=active]:shadow-sm data-[state=active]:text-foreground"
            >
              {t('queueNotifs') || 'Queue'}
              {queueCount > 0 && (
                <span className="ms-1 text-[9px] text-muted-foreground">{queueCount}</span>
              )}
            </TabsTrigger>
            <TabsTrigger
              value="general"
              className="text-xs px-2.5 h-8 rounded-md data-[state=active]:bg-white data-[state=active]:dark:bg-gray-700 data-[state=active]:shadow-sm data-[state=active]:text-foreground"
            >
              {t('generalNotifs') || 'General'}
              {generalCount > 0 && (
                <span className="ms-1 text-[9px] text-muted-foreground">{generalCount}</span>
              )}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        {unreadCount > 0 && (
          <motion.div layout>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs gap-1.5 border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 rounded-lg"
              onClick={handleMarkAllRead}
              disabled={!!actionLoading || allMarkedRead}
            >
              {allMarkedRead ? (
                <motion.span
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  className="flex items-center gap-1"
                >
                  <CheckCheck className="h-3.5 w-3.5" />
                  {t('allRead')}
                </motion.span>
              ) : (
                <>
                  <Check className="h-3.5 w-3.5" />
                  {t('markAllRead')}
                </>
              )}
            </Button>
          </motion.div>
        )}
      </motion.div>

      {/* All caught up banner when no unread */}
      {unreadCount === 0 && notifications.length > 0 && activeFilter === 'unread' && (
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="flex flex-col items-center justify-center py-12 px-4"
        >
          <div className="h-16 w-16 rounded-full bg-gradient-to-br from-emerald-100 to-teal-100 dark:from-emerald-900/30 dark:to-teal-900/30 flex items-center justify-center mb-4">
            <CheckCircle className="h-8 w-8 text-emerald-500" />
          </div>
          <h3 className="text-lg font-semibold text-foreground mb-1">{t('allCaughtUp') || 'All caught up!'}</h3>
          <p className="text-sm text-muted-foreground text-center">{t('allCaughtUpDesc') || 'You have no unread notifications'}</p>
        </motion.div>
      )}

      {/* Empty State with illustration */}
      {filteredNotifications.length === 0 && !(unreadCount === 0 && notifications.length > 0 && activeFilter === 'unread') && (
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="flex flex-col items-center justify-center py-16 px-4"
        >
          <div className="relative mb-6">
            {/* Animated background ring */}
            <motion.div
              animate={{ scale: [1, 1.15, 1], opacity: [0.15, 0.05, 0.15] }}
              transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
              className="absolute top-1/2 start-1/2 -translate-x-1/2 -translate-y-1/2 h-32 w-32 rounded-full bg-emerald-200 dark:bg-emerald-800"
            />
            {/* Main icon */}
            <div className="relative flex h-24 w-24 items-center justify-center rounded-3xl bg-gradient-to-br from-emerald-100 to-teal-50 dark:from-emerald-900/30 dark:to-teal-900/20 ring-1 ring-emerald-200/60 dark:ring-emerald-800/60 shadow-inner">
              <BellOff className="h-10 w-10 text-emerald-400 dark:text-emerald-600" />
            </div>
            {/* Floating decorative elements */}
            <motion.div
              animate={{ y: [-3, 3, -3] }}
              transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
              className="absolute -top-2 -end-2 h-8 w-8 rounded-full bg-teal-100 dark:bg-teal-900/30 flex items-center justify-center"
            >
              <Sparkles className="h-4 w-4 text-teal-500" />
            </motion.div>
            <motion.div
              animate={{ y: [2, -2, 2] }}
              transition={{ duration: 2.5, repeat: Infinity, ease: 'easeInOut' }}
              className="absolute -bottom-1 -start-1 h-6 w-6 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center"
            >
              <Clock className="h-3 w-3 text-amber-500" />
            </motion.div>
          </div>
          <h3 className="text-lg font-bold text-foreground mb-2">{t('allNotificationsRead') || 'All caught up!'}</h3>
          <p className="text-sm text-muted-foreground text-center max-w-[280px]">{t('noNotificationsDesc') || 'You have no notifications at the moment. We will notify you when something happens.'}</p>
          <Button
            variant="outline"
            className="mt-4 gap-2 min-h-[44px] rounded-2xl border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/30"
            onClick={() => setView('customer-home')}
          >
            <TicketCheck className="h-4 w-4" />
            {t('browseAgencies') || 'Browse Agencies'}
          </Button>
        </motion.div>
      )}

      {/* Notifications List with Date Grouping */}
      {filteredNotifications.length > 0 && (
        <div className="space-y-5">
          <AnimatePresence mode="wait">
            {groupedNotifications.map(([group, groupNotifs]) => {
              const GroupIcon = getDateGroupIcon(group);
              return (
                <motion.div
                  key={group}
                  initial={{ opacity: 0, y: 15 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -15 }}
                  transition={{ duration: 0.3 }}
                >
                  {/* Date Group Header */}
                  <div className="flex items-center gap-2.5 mb-3">
                    <div className={`h-6 w-6 rounded-lg flex items-center justify-center ${
                      group === 'today'
                        ? 'bg-emerald-100 dark:bg-emerald-900/30'
                        : group === 'yesterday'
                        ? 'bg-teal-100 dark:bg-teal-900/30'
                        : 'bg-gray-100 dark:bg-gray-800'
                    }`}>
                      <GroupIcon className={`h-3 w-3 ${
                        group === 'today'
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : group === 'yesterday'
                          ? 'text-teal-600 dark:text-teal-400'
                          : 'text-muted-foreground'
                      }`} />
                    </div>
                    <h3 className={`text-sm font-semibold ${
                      group === 'today'
                        ? 'text-emerald-700 dark:text-emerald-400'
                        : group === 'yesterday'
                        ? 'text-teal-700 dark:text-teal-400'
                        : 'text-muted-foreground'
                    }`}>
                      {getDateGroupLabel(group, t)}
                    </h3>
                    <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4">
                      {groupNotifs.length}
                    </Badge>
                    <div className="flex-1 h-px bg-gradient-to-r from-border to-transparent" />
                  </div>

                  {/* Notifications in this group */}
                  <div className="space-y-2.5">
                    <AnimatePresence mode="popLayout">
                      {groupNotifs.map((notif) => {
                        const config = getNotificationConfig(notif.type);
                        const isTransitioning = transitioningIds.has(notif.id);

                        return (
                          <motion.div
                            key={notif.id}
                            layout
                            initial={false}
                            animate={{
                              opacity: isTransitioning ? 0.6 : notif.isRead ? 0.75 : 1,
                              scale: 1,
                            }}
                            transition={{ duration: 0.4 }}
                          >
                            <NotificationCard
                              notif={notif}
                              config={config}
                              relativeTime={getRelativeTime(notif.createdAt)}
                              t={t}
                              onMarkRead={handleMarkRead}
                              onDelete={handleDelete}
                              actionLoading={actionLoading}
                              isRtl={isRtl}
                            />
                          </motion.div>
                        );
                      })}
                    </AnimatePresence>
                  </div>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}
