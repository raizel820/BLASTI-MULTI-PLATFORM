'use client';
import { apiFetch } from '@/lib/api-fetch';
import { isApiUnreachable, isBothUnreachable } from '@/lib/api-client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Bell } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { useAppStore } from '@/store/use-app-store';
import { useLanguage } from '@/hooks/use-language';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';

interface NotificationItem {
  id: string;
  type: string;
  title: string;
  message: string;
  isRead: boolean;
  createdAt: string;
}

interface NotificationBadgeProps {
  /** 'customer' navigates to notifications view, 'agency' shows a dropdown */
  variant?: 'customer' | 'agency';
}

// ─── Notification icon mapping ────────────────────
function getNotifIcon(type: string) {
  switch (type) {
    case 'QUEUE_CALLED':
      return '🔔';
    case 'QUEUE_JOINED':
      return '🎫';
    case 'QUEUE_COMPLETED':
      return '✅';
    case 'QUEUE_CANCELLED':
      return '❌';
    case 'QUEUE_NO_SHOW':
      return '⚠️';
    case 'REMINDER':
      return '⏰';
    case 'SYSTEM':
      return '📢';
    default:
      return '💬';
  }
}

function formatTimeAgo(dateStr: string, t: (key: string) => string) {
  const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (diff < 60) return t('justNow');
  if (diff < 3600) return `${Math.floor(diff / 60)} ${t('min')}`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} ${t('hours') || 'h'}`;
  return `${Math.floor(diff / 86400)} ${t('date')}`;
}

export function NotificationBadge({ variant = 'customer' }: NotificationBadgeProps) {
  const user = useAppStore((s) => s.user);
  const setView = useAppStore((s) => s.setView);
  const { t, lang } = useLanguage();
  const [unreadCount, setUnreadCount] = useState(0);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const prevCountRef = useRef(0);

  const fetchUnread = useCallback(async () => {
    if (!user?.id) return;
    try {
      const res = await apiFetch(`/api/notifications?unreadOnly=true`);
      if (res.ok) {
        const data = await res.json();
        const count = data.unreadCount ?? data.notifications?.length ?? 0;
        setUnreadCount(count);
      }
    } catch {
      // silent
    }
  }, [user?.id]);

  const fetchNotifications = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);
    try {
      const res = await apiFetch(`/api/notifications`);
      if (res.ok) {
        const data = await res.json();
        setNotifications(data.notifications ?? []);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [user?.id]);

  const markAllRead = useCallback(async () => {
    try {
      // FIX #10: Use PUT (matching local API route) instead of PATCH
      // Local API only has PUT /api/notifications/read-all
      const res = await apiFetch(`/api/notifications/read-all`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ markAll: true }),
      });
      if (res.ok) {
        setUnreadCount(0);
        setNotifications(prev => prev.map(n => ({ ...n, isRead: true })));
        window.dispatchEvent(new CustomEvent('blasti:notifications-read'));
      }
    } catch {
      // silent
    }
  }, []);

  // Auto-refresh unread count with offline backoff
  // FIX #11: Skip polling when fully offline, back off when cloud is down
  useEffect(() => {
    fetchUnread();
    let failures = 0;
    const NORMAL = 30_000;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const getInterval = () => {
      if (failures >= 5) return 300_000; // 5 min
      if (failures >= 3) return 120_000; // 2 min
      if (failures >= 1) return 60_000;  // 1 min
      return NORMAL;
    };

    const tick = async () => {
      if (stopped) return;
      if (isBothUnreachable()) {
        timer = setTimeout(tick, getInterval());
        return;
      }
      await fetchUnread();
      if (isApiUnreachable()) {
        failures = Math.min(failures + 1, 10);
      } else {
        failures = 0;
      }
      timer = setTimeout(tick, getInterval());
    };

    timer = setTimeout(tick, NORMAL);

    // Listen for notification-read events
    const handleNotificationsRead = () => fetchUnread();
    window.addEventListener('blasti:notifications-read', handleNotificationsRead);

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener('blasti:notifications-read', handleNotificationsRead);
    };
  }, [fetchUnread]);

  // Fetch full notification list when dropdown opens (agency variant)
  useEffect(() => {
    if (dropdownOpen && variant === 'agency') {
      fetchNotifications();
    }
  }, [dropdownOpen, variant, fetchNotifications]);

  const handleClick = () => {
    if (variant === 'customer') {
      setView('customer-notifications');
    }
  };

  const hasNewNotifications = unreadCount > prevCountRef.current;
  useEffect(() => {
    prevCountRef.current = unreadCount;
  }, [unreadCount]);

  return (
    <div className="relative">
      {variant === 'agency' ? (
        <Popover open={dropdownOpen} onOpenChange={setDropdownOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="relative h-9 w-9 rounded-full hover:bg-emerald-50 dark:hover:bg-emerald-900/20 transition-colors"
              aria-label={t('notifications')}
            >
              <div className="relative">
                <Bell className="h-4 w-4 text-muted-foreground" />
                <AnimatePresence>
                  {unreadCount > 0 && (
                    <motion.span
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      exit={{ scale: 0 }}
                      className="absolute -top-1.5 -end-1.5 h-4 min-w-4 px-1 flex items-center justify-center rounded-full bg-emerald-500 text-white text-[9px] font-bold shadow-sm"
                    >
                      {unreadCount > 99 ? '99+' : unreadCount}
                    </motion.span>
                  )}
                </AnimatePresence>
                {/* Pulse animation for new notifications */}
                {unreadCount > 0 && (
                  <motion.span
                    className="absolute -top-1.5 -end-1.5 h-4 min-w-4 rounded-full bg-emerald-400"
                    animate={{ scale: [1, 1.5, 1], opacity: [0.6, 0, 0.6] }}
                    transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
                  />
                )}
              </div>
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            sideOffset={8}
            className="w-80 p-0 rounded-2xl border shadow-xl bg-white dark:bg-gray-900"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <div className="flex items-center gap-2">
                <Bell className="h-4 w-4 text-emerald-600" />
                <h3 className="text-sm font-semibold text-foreground">{t('notifications')}</h3>
                {unreadCount > 0 && (
                  <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 text-[9px] px-1.5 py-0 h-4 border-0">
                    {unreadCount}
                  </Badge>
                )}
              </div>
              {unreadCount > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-[10px] text-emerald-600 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20"
                  onClick={markAllRead}
                >
                  {t('markAllRead')}
                </Button>
              )}
            </div>

            {/* Notification List */}
            <ScrollArea className="max-h-80">
              {loading ? (
                <div className="flex items-center justify-center py-8">
                  <motion.div
                    animate={{ rotate: 360 }}
                    transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
                    className="h-5 w-5 border-2 border-emerald-500 border-t-transparent rounded-full"
                  />
                </div>
              ) : notifications.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-center">
                  <div className="h-10 w-10 rounded-full bg-emerald-50 dark:bg-emerald-900/20 flex items-center justify-center mb-2">
                    <Bell className="h-5 w-5 text-emerald-400" />
                  </div>
                  <p className="text-xs font-medium text-foreground">{t('allNotificationsRead')}</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5 max-w-[200px]">{t('noNotificationsDesc')}</p>
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {notifications.slice(0, 10).map((notif) => (
                    <div
                      key={notif.id}
                      className={`px-4 py-3 transition-colors hover:bg-emerald-50/50 dark:hover:bg-emerald-900/10 ${
                        !notif.isRead ? 'bg-emerald-50/30 dark:bg-emerald-900/5' : ''
                      }`}
                    >
                      <div className="flex items-start gap-2.5">
                        <span className="text-sm flex-shrink-0 mt-0.5">{getNotifIcon(notif.type)}</span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <p className="text-xs font-medium text-foreground truncate">{notif.title}</p>
                            {!notif.isRead && (
                              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 flex-shrink-0" />
                            )}
                          </div>
                          {notif.message && (
                            <p className="text-[10px] text-muted-foreground line-clamp-2 mt-0.5">{notif.message}</p>
                          )}
                          <p className="text-[9px] text-muted-foreground mt-1">{formatTimeAgo(notif.createdAt, t)}</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>

            {/* Footer */}
            {notifications.length > 0 && (
              <>
                <Separator />
                <div className="p-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full h-8 text-xs text-emerald-600 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 rounded-lg"
                    onClick={() => {
                      setDropdownOpen(false);
                      // Navigate to a full notifications view if available
                    }}
                  >
                    {t('viewAllHistory') || 'View All'}
                  </Button>
                </div>
              </>
            )}
          </PopoverContent>
        </Popover>
      ) : (
        /* Customer variant - simple button that navigates */
        <Button
          variant="ghost"
          size="icon"
          className="relative h-9 w-9 rounded-full hover:bg-emerald-50 dark:hover:bg-emerald-900/20 transition-colors"
          onClick={handleClick}
          aria-label={t('notifications')}
        >
          <div className="relative">
            <Bell className="h-4 w-4 text-muted-foreground" />
            <AnimatePresence>
              {unreadCount > 0 && (
                <motion.span
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  exit={{ scale: 0 }}
                  className="absolute -top-1.5 -end-1.5 h-4 min-w-4 px-1 flex items-center justify-center rounded-full bg-emerald-500 text-white text-[9px] font-bold shadow-sm"
                >
                  {unreadCount > 99 ? '99+' : unreadCount}
                </motion.span>
              )}
            </AnimatePresence>
            {/* Pulse animation for unread */}
            {unreadCount > 0 && (
              <motion.span
                className="absolute -top-1.5 -end-1.5 h-4 min-w-4 rounded-full bg-emerald-400"
                animate={{ scale: [1, 1.5, 1], opacity: [0.6, 0, 0.6] }}
                transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
              />
            )}
          </div>
        </Button>
      )}
    </div>
  );
}
