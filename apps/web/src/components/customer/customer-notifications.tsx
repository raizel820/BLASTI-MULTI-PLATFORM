'use client';

/**
 * Task 79-a — CustomerNotifications v2: THE single full-page notification
 * center for customers (the duplicate bell/dropdown pattern that lived in the
 * chrome strip was removed; this view is the only notification surface).
 *
 * Preserved behavior: fetch + 30s auto-refresh + realtime refetch
 * (notification:new / turn-approaching / your-turn), mark-read / mark-all-read
 * (with `blasti:notifications-read` window event), delete (button +
 * swipe-to-dismiss), All/Unread/Queue/General filters, date grouping
 * (today/yesterday/earlier), error + empty states.
 *
 * Restyled to Design System v2: sticky filter chip rail, compact rows with
 * type icon, unread dot, relative time. The old stats summary bar was dropped
 * (filter chips carry the counts).
 */

import { apiFetch } from "@/lib/api-fetch";
// Task 84 — IndexedDB stale-while-revalidate: notifications render instantly
// from the last-known list on initial load and refresh silently.
import { cacheGet, cacheSet, cacheKeyFor } from '@/lib/local-cache';
import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useAppStore } from '@/store/use-app-store';
import { useLanguage } from '@/hooks/use-language';
import { useRealtime } from '@/hooks/use-realtime';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/shared/error-state';
import {
  Bell,
  BellOff,
  Check,
  CheckCircle,
  CheckCheck,
  XCircle,
  Trash2,
  TicketCheck,
  AlertTriangle,
  Clock,
  Info,
  CalendarDays,
  Sparkles,
  RefreshCw,
  Eye,
} from 'lucide-react';
import { motion, AnimatePresence, useMotionValue, useTransform, PanInfo } from 'framer-motion';
import { toast } from 'sonner';
import type { TranslationKeys } from '@/i18n';

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
      return { icon: Bell, dotColor: 'bg-emerald-500', borderAccent: 'border-s-emerald-500', iconBg: 'bg-emerald-100 dark:bg-emerald-900/30', iconColor: 'text-emerald-600 dark:text-emerald-400' };
    case 'QUEUE_JOINED':
      return { icon: TicketCheck, dotColor: 'bg-teal-500', borderAccent: 'border-s-teal-500', iconBg: 'bg-teal-100 dark:bg-teal-900/30', iconColor: 'text-teal-600 dark:text-teal-400' };
    case 'QUEUE_COMPLETED':
      return { icon: CheckCircle, dotColor: 'bg-emerald-600', borderAccent: 'border-s-emerald-600', iconBg: 'bg-emerald-100 dark:bg-emerald-900/30', iconColor: 'text-emerald-600 dark:text-emerald-400' };
    case 'QUEUE_CANCELLED':
      return { icon: XCircle, dotColor: 'bg-red-500', borderAccent: 'border-s-red-500', iconBg: 'bg-red-100 dark:bg-red-900/30', iconColor: 'text-red-600 dark:text-red-400' };
    case 'TURN_APPROACHING':
      return { icon: Clock, dotColor: 'bg-amber-500', borderAccent: 'border-s-amber-500', iconBg: 'bg-amber-100 dark:bg-amber-900/30', iconColor: 'text-amber-600 dark:text-amber-400' };
    case 'NO_SHOW_WARNING':
      return { icon: AlertTriangle, dotColor: 'bg-orange-500', borderAccent: 'border-s-orange-500', iconBg: 'bg-orange-100 dark:bg-orange-900/30', iconColor: 'text-orange-600 dark:text-orange-400' };
    case 'RECLAIM_SUCCESS':
      return { icon: CheckCheck, dotColor: 'bg-teal-600', borderAccent: 'border-s-teal-600', iconBg: 'bg-teal-100 dark:bg-teal-900/30', iconColor: 'text-teal-600 dark:text-teal-400' };
    default:
      return { icon: Info, dotColor: 'bg-gray-400', borderAccent: 'border-s-gray-400', iconBg: 'bg-gray-100 dark:bg-gray-800', iconColor: 'text-gray-600 dark:text-gray-400' };
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

function getDateGroupLabel(group: string, t: (key: TranslationKeys, params?: Record<string, string>) => string): string {
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

// Swipe-to-dismiss + compact notification row
function NotificationRow({
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
  t: (key: TranslationKeys, params?: Record<string, string>) => string;
  onMarkRead: (id: string) => void;
  onDelete: (id: string) => void;
  actionLoading: string | null;
  isRtl: boolean;
}) {
  const IconComponent = config.icon;
  const [isExiting, setIsExiting] = useState(false);
  const x = useMotionValue(0);
  const opacity = useTransform(x, [-150, 0, 150], [0.3, 1, 0.3]);
  const deleteOpacity = useTransform(x, (v) => Math.min(Math.abs(v) / 80, 1));

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
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: isExiting ? 0 : notif.isRead ? 0.7 : 1, y: 0, x: isExiting ? (isRtl ? 300 : -300) : 0 }}
      exit={{ opacity: 0, x: isRtl ? 300 : -300, transition: { duration: 0.2 } }}
      transition={{ duration: 0.2 }}
      className="relative overflow-hidden"
    >
      {/* Delete background for swipe */}
      <motion.div
        style={{ opacity: deleteOpacity }}
        className={`absolute inset-0 flex items-center ${isRtl ? 'justify-start ps-5' : 'justify-end pe-5'} bg-red-500 rounded-2xl`}
      >
        <Trash2 className="h-[18px] w-[18px] text-white" />
      </motion.div>

      <motion.div
        style={{ x, opacity }}
        onPanEnd={handlePanEnd}
        onPan={(_, info) => { x.set(info.offset.x); }}
        className={`relative rounded-2xl border border-border bg-white dark:bg-gray-900/80 shadow-sm overflow-hidden ${
          !notif.isRead ? 'border-s-[3px] ' + config.borderAccent : ''
        }`}
      >
        <button
          onClick={() => !notif.isRead && onMarkRead(notif.id)}
          className={`w-full flex items-start gap-3 p-3 text-start transition-colors ${
            !notif.isRead ? 'hover:bg-emerald-50/40 dark:hover:bg-emerald-900/10' : 'hover:bg-muted/40'
          }`}
          aria-label={!notif.isRead ? t('markAsRead') : notif.title}
        >
          {/* Type icon + unread dot */}
          <span className={`relative h-9 w-9 rounded-xl ${config.iconBg} flex items-center justify-center flex-shrink-0`}>
            <IconComponent className={`h-4 w-4 ${config.iconColor}`} />
            {!notif.isRead && (
              <motion.span
                animate={{ scale: [1, 1.25, 1] }}
                transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
                className={`absolute -top-0.5 -end-0.5 h-2.5 w-2.5 rounded-full border-2 border-white dark:border-gray-900 ${config.dotColor}`}
              />
            )}
          </span>

          {/* Content */}
          <span className="flex-1 min-w-0">
            <span className="flex items-center gap-1.5">
              <span className={`text-[13px] font-semibold leading-tight truncate ${!notif.isRead ? 'text-foreground' : 'text-muted-foreground'}`}>
                {notif.title}
              </span>
              {!notif.isRead && (
                <span className="text-[9px] font-bold text-emerald-700 dark:text-emerald-400 bg-emerald-100 dark:bg-emerald-900/30 px-1.5 py-0.5 rounded-full flex-shrink-0">
                  {t('new')}
                </span>
              )}
            </span>
            <span className={`block text-xs leading-relaxed line-clamp-2 mt-0.5 ${!notif.isRead ? 'text-muted-foreground' : 'text-muted-foreground/70'}`}>
              {notif.message}
            </span>
            <span className="flex items-center gap-2 mt-1">
              <span className="text-[10px] text-muted-foreground/60 flex items-center gap-1">
                <Clock className="h-2.5 w-2.5" />
                {relativeTime}
              </span>
              {notif.isRead && (
                <span className="text-[9px] text-muted-foreground/40 flex items-center gap-0.5">
                  <Eye className="h-2.5 w-2.5" />
                  {t('read')}
                </span>
              )}
            </span>
          </span>

          {/* Delete */}
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); onDelete(notif.id); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onDelete(notif.id); } }}
            className="flex-shrink-0 h-8 w-8 rounded-lg flex items-center justify-center text-muted-foreground/40 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/10 transition-colors cursor-pointer"
            aria-label={t('delete')}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </span>
        </button>
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
    // Task 84 — instant paint from the last-known list on initial load only
    // (the 30s auto-refresh + realtime events own the list afterwards).
    const notifKey = cacheKeyFor('/api/notifications', { userId: user.id });
    const cachedNotifs = notifications.length === 0 && !showRefresh
      ? await cacheGet<{ notifications?: typeof notifications }>(notifKey)
      : null;
    if (cachedNotifs?.data?.notifications?.length) {
      setNotifications(cachedNotifs.data.notifications);
      setLoading(false);
    }
    try {
      const { fetchWithRetry } = await import('@/lib/fetch-with-retry');
      const res = await fetchWithRetry(`/api/notifications?userId=${user.id}`);
      if (res.ok) {
        const data = await res.json();
        void cacheSet(notifKey, data);
        setNotifications(data.notifications ?? []);
      } else {
        // Only set error on initial load (not background refresh)
        if (!showRefresh && notifications.length === 0 && !cachedNotifs?.data?.notifications?.length) {
          setFetchError(true);
        }
      }
    } catch {
      // Only set error on initial load (not background refresh)
      if (!showRefresh && notifications.length === 0 && !cachedNotifs?.data?.notifications?.length) {
        setFetchError(true);
      }
    } finally {
      if (showRefresh) {
        refreshTimeoutRef.current = setTimeout(() => setRefreshing(false), 500);
      }
      setLoading(false);
    }
  }, [user?.id, notifications.length, notifications]);

  useEffect(() => {
    fetchNotifications();
  }, [fetchNotifications]);

  // Auto-refresh every 30s
  useEffect(() => {
    const interval = setInterval(() => fetchNotifications(), 30000);
    return () => clearInterval(interval);
  }, [fetchNotifications]);

  // Cleanup pending refresh timer
  useEffect(() => {
    return () => {
      if (refreshTimeoutRef.current) clearTimeout(refreshTimeoutRef.current);
    };
  }, []);

  // ─── Realtime: Join customer room for instant updates ────────────────
  useEffect(() => {
    if (!user?.id) return;
    realtime.joinCustomer(user.id);
    return () => {
      realtime.leaveCustomer(user.id);
    };
  }, [user?.id, realtime]);

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
  }, [user?.id, realtime, fetchNotifications]);

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

  const filters: { value: FilterType; label: string; count: number; accent?: boolean }[] = [
    { value: 'all', label: t('all'), count: notifications.length },
    { value: 'unread', label: t('unread'), count: unreadCount, accent: true },
    { value: 'queue', label: t('queueNotifs'), count: queueCount },
    { value: 'general', label: t('generalNotifs'), count: generalCount },
  ];

  if (loading) {
    return (
      <div className="px-4 py-3 pb-24 lg:pb-8 max-w-3xl mx-auto">
        <Skeleton className="h-7 w-40 mb-4" />
        <div className="flex gap-2 mb-4">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-8 w-20 rounded-full" />
          ))}
        </div>
        {[...Array(5)].map((_, i) => (
          <Skeleton key={i} className="h-[76px] rounded-2xl mb-2.5" />
        ))}
      </div>
    );
  }

  // Show error state with retry if initial fetch failed
  if (fetchError && notifications.length === 0) {
    return (
      <div className="px-4 py-3 pb-24 lg:pb-8 max-w-3xl mx-auto">
        <ErrorState onRetry={() => fetchNotifications(false)} />
      </div>
    );
  }

  return (
    <div className="px-4 py-3 pb-24 lg:pb-8 max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-2 mb-1">
        <h1 className="text-lg font-bold text-foreground">{t('notifications')}</h1>
        {/* Live connection indicator */}
        <span className={`flex items-center gap-1 text-[10px] font-medium ${realtime.isConnected ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>
          <span className={`h-1.5 w-1.5 rounded-full inline-block ${realtime.isConnected ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'}`} />
          {realtime.isConnected ? t('live') : t('polling')}
        </span>
        <button
          onClick={handleRefresh}
          className="ms-auto h-9 w-9 rounded-xl hover:bg-muted transition-colors flex items-center justify-center"
          aria-label={t('refresh')}
        >
          <RefreshCw className={`h-4 w-4 text-muted-foreground ${refreshing ? 'animate-spin' : ''}`} />
        </button>
      </div>
      {unreadCount > 0 ? (
        <p className="text-xs text-muted-foreground mb-2">
          {unreadCount} {t('unreadNotifications')}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground mb-2">{t('allCaughtUp')}</p>
      )}

      {/* Sticky filter chips + mark all read */}
      <div className="sticky top-11 lg:top-12 z-20 -mx-4 px-4 py-2 bg-background/95 backdrop-blur-sm flex items-center gap-2 mb-2">
        <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar flex-1 min-w-0">
          {filters.map((f) => {
            const active = activeFilter === f.value;
            return (
              <button
                key={f.value}
                onClick={() => setActiveFilter(f.value)}
                className={`flex items-center gap-1.5 px-3 h-8 rounded-full text-xs font-medium whitespace-nowrap transition-colors flex-shrink-0 ${
                  active
                    ? 'bg-emerald-600 text-white shadow-sm'
                    : 'bg-muted/70 text-muted-foreground hover:bg-muted'
                }`}
              >
                {f.label}
                {f.count > 0 && (
                  <span className={`text-[9px] font-bold min-w-[16px] h-4 px-1 rounded-full flex items-center justify-center ${
                    active
                      ? 'bg-white/25 text-white'
                      : f.accent
                        ? 'bg-red-500 text-white'
                        : 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400'
                  }`}>
                    {f.count > 99 ? '99+' : f.count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        {unreadCount > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs gap-1.5 border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 rounded-full flex-shrink-0"
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
        )}
      </div>

      {/* All caught up banner when no unread + unread filter */}
      {unreadCount === 0 && notifications.length > 0 && activeFilter === 'unread' && (
        <motion.div
          initial={{ opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          className="flex flex-col items-center justify-center py-12 px-4"
        >
          <div className="h-14 w-14 rounded-2xl bg-gradient-to-br from-emerald-100 to-teal-100 dark:from-emerald-900/30 dark:to-teal-900/30 flex items-center justify-center mb-3">
            <CheckCircle className="h-7 w-7 text-emerald-500" />
          </div>
          <h3 className="text-base font-semibold text-foreground mb-1">{t('allCaughtUp')}</h3>
          <p className="text-sm text-muted-foreground text-center">{t('allCaughtUpDesc')}</p>
        </motion.div>
      )}

      {/* Empty State */}
      {filteredNotifications.length === 0 && !(unreadCount === 0 && notifications.length > 0 && activeFilter === 'unread') && (
        <motion.div
          initial={{ opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          className="flex flex-col items-center justify-center py-14 px-4"
        >
          <div className="relative flex h-20 w-20 items-center justify-center rounded-3xl bg-gradient-to-br from-emerald-100 to-teal-50 dark:from-emerald-900/30 dark:to-teal-900/20 ring-1 ring-emerald-200/60 dark:ring-emerald-800/60 mb-4">
            <BellOff className="h-9 w-9 text-emerald-400 dark:text-emerald-600" />
          </div>
          <h3 className="text-base font-bold text-foreground mb-1.5">{t('allNotificationsRead')}</h3>
          <p className="text-sm text-muted-foreground text-center max-w-[280px]">{t('noNotificationsDesc')}</p>
          <Button
            variant="outline"
            className="mt-4 gap-2 min-h-[44px] rounded-xl border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/30"
            onClick={() => setView('customer-home')}
          >
            <TicketCheck className="h-4 w-4" />
            {t('browseAgencies')}
          </Button>
        </motion.div>
      )}

      {/* Notifications List with Date Grouping */}
      {filteredNotifications.length > 0 && (
        <div className="space-y-4">
          <AnimatePresence mode="wait">
            {groupedNotifications.map(([group, groupNotifs]) => {
              const GroupIcon = getDateGroupIcon(group);
              return (
                <motion.section
                  key={group}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.2 }}
                >
                  {/* Date Group Header */}
                  <div className="flex items-center gap-2 mb-2">
                    <span className={`h-5 w-5 rounded-md flex items-center justify-center ${
                      group === 'today'
                        ? 'bg-emerald-100 dark:bg-emerald-900/30'
                        : group === 'yesterday'
                        ? 'bg-teal-100 dark:bg-teal-900/30'
                        : 'bg-gray-100 dark:bg-gray-800'
                    }`}>
                      <GroupIcon className={`h-2.5 w-2.5 ${
                        group === 'today'
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : group === 'yesterday'
                          ? 'text-teal-600 dark:text-teal-400'
                          : 'text-muted-foreground'
                      }`} />
                    </span>
                    <h3 className={`text-xs font-semibold ${
                      group === 'today'
                        ? 'text-emerald-700 dark:text-emerald-400'
                        : group === 'yesterday'
                        ? 'text-teal-700 dark:text-teal-400'
                        : 'text-muted-foreground'
                    }`}>
                      {getDateGroupLabel(group, t)}
                    </h3>
                    <span className="text-[10px] text-muted-foreground">{groupNotifs.length}</span>
                    <div className="flex-1 h-px bg-border/60" />
                  </div>

                  {/* Notifications in this group */}
                  <div className="space-y-2">
                    <AnimatePresence mode="popLayout">
                      {groupNotifs.map((notif) => {
                        const config = getNotificationConfig(notif.type);
                        return (
                          <NotificationRow
                            key={notif.id}
                            notif={notif}
                            config={config}
                            relativeTime={getRelativeTime(notif.createdAt)}
                            t={t}
                            onMarkRead={handleMarkRead}
                            onDelete={handleDelete}
                            actionLoading={actionLoading}
                            isRtl={isRtl}
                          />
                        );
                      })}
                    </AnimatePresence>
                  </div>
                </motion.section>
              );
            })}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}
