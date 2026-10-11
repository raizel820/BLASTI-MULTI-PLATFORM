'use client';

import { useState, useCallback, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { motion, AnimatePresence } from 'framer-motion';
import { useNotifications } from '@/hooks/use-notifications';
import type { Notification } from '@/hooks/use-notifications';
import {
  Bell,
  X,
  CheckCheck,
  Trash2,
  Ticket,
  Users,
  Megaphone,
  BellRing,
  RefreshCw,
  Loader2,
  ChevronDown,
  AlertCircle,
  WifiOff,
  CheckCircle2,
  AlertTriangle,
  Info,
  Sparkles,
} from 'lucide-react';

// ─── Time formatting ──────────────────────────────────────────────────────

function formatTimeAgo(date: Date): string {
  const diff = Math.floor((Date.now() - date.getTime()) / 1000);
  if (diff < 60) return 'الآن';
  if (diff < 3600) return `منذ ${Math.floor(diff / 60)} دقيقة`;
  if (diff < 86400) return `منذ ${Math.floor(diff / 3600)} ساعة`;
  return `منذ ${Math.floor(diff / 86400)} يوم`;
}

// ─── Date Grouping ─────────────────────────────────────────────────────────

type DateGroup = 'today' | 'yesterday' | 'earlier';

function getDateGroup(date: Date): DateGroup {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const notifDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  if (notifDate.getTime() >= today.getTime()) return 'today';
  if (notifDate.getTime() >= yesterday.getTime()) return 'yesterday';
  return 'earlier';
}

function groupNotificationsByDate(notifs: Notification[]): { group: DateGroup; label: string; items: Notification[] }[] {
  const groups = new Map<DateGroup, Notification[]>();

  for (const n of notifs) {
    const g = getDateGroup(n.time);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(n);
  }

  const labelMap: Record<DateGroup, string> = {
    today: 'اليوم',
    yesterday: 'أمس',
    earlier: 'أقدم',
  };

  const order: DateGroup[] = ['today', 'yesterday', 'earlier'];
  return order
    .filter(g => groups.has(g))
    .map(g => ({ group: g, label: labelMap[g], items: groups.get(g)! }));
}

// ─── Notification Icon Component ──────────────────────────────────────────

function NotificationIcon({ type }: { type: Notification['type'] }) {
  switch (type) {
    case 'turn':
      return (
        <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-emerald-400 to-teal-500 flex items-center justify-center shadow-md shadow-emerald-500/20 flex-shrink-0">
          <BellRing className="h-5 w-5 text-white" />
        </div>
      );
    case 'queue':
      return (
        <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-teal-400 to-cyan-500 flex items-center justify-center shadow-md shadow-teal-500/20 flex-shrink-0">
          <Ticket className="h-5 w-5 text-white" />
        </div>
      );
    case 'success':
      return (
        <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-emerald-400 to-emerald-600 flex items-center justify-center shadow-md shadow-emerald-500/20 flex-shrink-0">
          <CheckCircle2 className="h-5 w-5 text-white" />
        </div>
      );
    case 'warning':
      return (
        <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-amber-400 to-amber-600 flex items-center justify-center shadow-md shadow-amber-500/20 flex-shrink-0">
          <AlertTriangle className="h-5 w-5 text-white" />
        </div>
      );
    case 'error':
      return (
        <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-rose-400 to-rose-600 flex items-center justify-center shadow-md shadow-rose-500/20 flex-shrink-0">
          <AlertCircle className="h-5 w-5 text-white" />
        </div>
      );
    case 'info':
      return (
        <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-cyan-400 to-cyan-600 flex items-center justify-center shadow-md shadow-cyan-500/20 flex-shrink-0">
          <Info className="h-5 w-5 text-white" />
        </div>
      );
    case 'system':
      return (
        <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-cyan-400 to-emerald-500 flex items-center justify-center shadow-md shadow-cyan-500/20 flex-shrink-0">
          <Megaphone className="h-5 w-5 text-white" />
        </div>
      );
    default:
      return (
        <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-gray-300 to-gray-400 flex items-center justify-center shadow-md flex-shrink-0">
          <Users className="h-5 w-5 text-white" />
        </div>
      );
  }
}

// ─── Status Dot ────────────────────────────────────────────────────────────

function StatusDot({ type, read }: { type: Notification['type']; read: boolean }) {
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
      <div className={`h-2.5 w-2.5 rounded-full ${color} shadow-sm`} />
      <div className={`absolute inset-0 h-2.5 w-2.5 rounded-full ${color} animate-ping opacity-40`} />
    </div>
  );
}

// ─── Empty State ───────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="flex flex-col items-center justify-center py-20 px-6 text-center"
    >
      {/* Illustrated bell with sparkle rings */}
      <div className="relative mb-6">
        <motion.div
          animate={{ y: [-6, 6, -6] }}
          transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
          className="relative"
        >
          <div className="h-24 w-24 rounded-3xl bg-gradient-to-br from-emerald-100 to-teal-100 dark:from-emerald-900/30 dark:to-teal-900/30 flex items-center justify-center shadow-xl shadow-emerald-500/10">
            <Bell className="h-10 w-10 text-emerald-500 dark:text-emerald-400" />
          </div>
        </motion.div>

        {/* Floating sparkle rings */}
        <motion.div
          className="absolute -top-2 -end-2 h-6 w-6 rounded-full bg-teal-400/20 dark:bg-teal-400/10 flex items-center justify-center"
          animate={{ scale: [1, 1.3, 1], opacity: [0.4, 0.8, 0.4] }}
          transition={{ duration: 2.5, repeat: Infinity, ease: 'easeInOut' }}
        >
          <Sparkles className="h-3 w-3 text-teal-500 dark:text-teal-400" />
        </motion.div>
        <motion.div
          className="absolute -bottom-1 -start-3 h-5 w-5 rounded-full bg-emerald-400/20 dark:bg-emerald-400/10 flex items-center justify-center"
          animate={{ scale: [1, 1.4, 1], opacity: [0.3, 0.7, 0.3] }}
          transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut', delay: 0.8 }}
        >
          <CheckCheck className="h-2.5 w-2.5 text-emerald-500 dark:text-emerald-400" />
        </motion.div>
        <motion.div
          className="absolute top-1/2 -start-6 h-4 w-4 rounded-full bg-cyan-400/15 dark:bg-cyan-400/10"
          animate={{ scale: [1, 1.5, 1], opacity: [0.2, 0.5, 0.2] }}
          transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut', delay: 1.5 }}
        />
      </div>

      <p className="text-base font-bold text-foreground mb-1.5">لا توجد إشعارات</p>
      <p className="text-sm text-muted-foreground max-w-[220px] leading-relaxed">ستظهر الإشعارات الجديدة هنا عند وصولها</p>

      {/* Decorative dots */}
      <div className="flex items-center gap-1.5 mt-4">
        {[0, 1, 2].map(i => (
          <motion.div
            key={i}
            className="h-1.5 w-1.5 rounded-full bg-emerald-300 dark:bg-emerald-700"
            animate={{ opacity: [0.3, 1, 0.3] }}
            transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut', delay: i * 0.3 }}
          />
        ))}
      </div>
    </motion.div>
  );
}

// ─── Loading Skeleton ──────────────────────────────────────────────────────

function NotificationSkeleton() {
  return (
    <div className="px-5 py-4">
      <div className="flex items-start gap-3">
        <Skeleton className="h-10 w-10 rounded-xl flex-shrink-0" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-2 w-16" />
        </div>
      </div>
    </div>
  );
}

// ─── Date Group Header ─────────────────────────────────────────────────────

function DateGroupHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="sticky top-0 z-10 px-5 py-2 bg-white/95 dark:bg-gray-950/95 backdrop-blur-sm border-b border-border/30">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-bold text-emerald-600 dark:text-emerald-400 uppercase tracking-wide">{label}</span>
        <span className="text-[9px] text-muted-foreground bg-emerald-50 dark:bg-emerald-900/20 px-1.5 py-0.5 rounded-full font-medium">{count}</span>
        <div className="flex-1 h-px bg-gradient-to-l from-transparent via-border/40 to-transparent" />
      </div>
    </div>
  );
}

// ─── Main Component ────────────────────────────────────────────────────────

interface NotificationCenterProps {
  /** Optional className for the trigger button container */
  className?: string;
  /** Optional user ID for real-time room joining */
  userId?: string;
}

export function NotificationCenter({ className, userId }: NotificationCenterProps) {
  const [isOpen, setIsOpen] = useState(false);

  const {
    notifications,
    unreadCount,
    loading,
    refreshing,
    error,
    hasMore,
    loadingMore,
    markingAllRead,
    markAsRead,
    markAllAsRead,
    refetch,
    loadMore,
  } = useNotifications(userId);

  // ─── Grouped notifications ──────────────────────────────────────────────
  const groupedNotifications = useMemo(() => groupNotificationsByDate(notifications), [notifications]);

  // ─── Handle notification click ──────────────────────────────────────────
  const handleNotificationClick = useCallback(async (id: string, read: boolean) => {
    if (!read) {
      await markAsRead(id);
    }
  }, [markAsRead]);

  return (
    <>
      {/* Bell Icon Button with Badge */}
      <div className={className}>
        <Button
          variant="ghost"
          size="icon"
          className="relative h-10 w-10 rounded-full hover:bg-emerald-50 dark:hover:bg-emerald-900/20 transition-colors"
          onClick={() => setIsOpen(true)}
          aria-label="الإشعارات"
        >
          <div className="relative">
            <Bell className="h-5 w-5 text-muted-foreground" />
            <AnimatePresence>
              {unreadCount > 0 && (
                <motion.span
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  exit={{ scale: 0 }}
                  transition={{ type: 'spring', stiffness: 400, damping: 20 }}
                  className="absolute -top-2 -end-2 h-5 min-w-5 px-1 flex items-center justify-center rounded-full bg-gradient-to-r from-emerald-500 to-teal-500 text-white text-[10px] font-bold shadow-lg shadow-emerald-500/30"
                >
                  {unreadCount > 99 ? '99+' : unreadCount}
                </motion.span>
              )}
            </AnimatePresence>
            {/* Pulse ring for unread */}
            {unreadCount > 0 && (
              <motion.span
                className="absolute -top-2 -end-2 h-5 min-w-5 rounded-full bg-emerald-400"
                animate={{ scale: [1, 1.6, 1], opacity: [0.5, 0, 0.5] }}
                transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
              />
            )}
          </div>
        </Button>
      </div>

      {/* Backdrop */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-[9998] bg-black/30 dark:bg-black/50 backdrop-blur-sm"
            onClick={() => setIsOpen(false)}
          />
        )}
      </AnimatePresence>

      {/* Slide-out Panel - Enhanced with spring physics */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ x: '100%', opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: '100%', opacity: 0 }}
            transition={{ type: 'spring', stiffness: 260, damping: 28, mass: 0.8 }}
            className="fixed top-0 end-0 bottom-0 z-[9999] w-full max-w-md bg-white dark:bg-gray-950 shadow-2xl shadow-emerald-500/5 border-s border-border/50 flex flex-col"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-border/50 bg-gradient-to-l from-emerald-50/50 via-teal-50/30 to-cyan-50/20 dark:from-emerald-950/20 dark:via-teal-950/10 dark:to-cyan-950/5">
              <div className="flex items-center gap-3">
                <motion.div
                  className="h-9 w-9 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-500 flex items-center justify-center shadow-md shadow-emerald-500/20"
                  whileHover={{ rotate: [0, -10, 10, 0] }}
                  transition={{ duration: 0.4 }}
                >
                  <Bell className="h-4 w-4 text-white" />
                </motion.div>
                <div>
                  <h2 className="text-base font-bold text-foreground">الإشعارات</h2>
                  {unreadCount > 0 && (
                    <motion.p
                      key={unreadCount}
                      initial={{ y: -5, opacity: 0 }}
                      animate={{ y: 0, opacity: 1 }}
                      className="text-[10px] text-muted-foreground"
                    >
                      {unreadCount} غير مقروء
                    </motion.p>
                  )}
                </div>
                {unreadCount > 0 && (
                  <Badge className="bg-gradient-to-r from-emerald-500 to-teal-500 text-white text-[9px] px-2 py-0.5 border-0 shadow-sm shadow-emerald-500/20">
                    {unreadCount}
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-1">
                {/* Refresh Button */}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 rounded-full hover:bg-emerald-50 dark:hover:bg-emerald-900/20 transition-colors"
                  onClick={refetch}
                  disabled={refreshing}
                  aria-label="تحديث"
                >
                  <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                  onClick={() => setIsOpen(false)}
                  aria-label="إغلاق"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {/* Error State */}
            {error && (
              <motion.div
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                className="mx-5 mt-3 flex items-center gap-2 px-3 py-2.5 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/30"
              >
                <AlertCircle className="h-4 w-4 text-red-500 flex-shrink-0" />
                <p className="text-xs text-red-700 dark:text-red-400 flex-1">{error}</p>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-[10px] text-red-600 hover:bg-red-100 dark:hover:bg-red-900/30 rounded-md"
                  onClick={refetch}
                >
                  إعادة المحاولة
                </Button>
              </motion.div>
            )}

            {/* Action Buttons */}
            {notifications.length > 0 && !loading && (
              <div className="flex items-center gap-2 px-5 py-2.5 border-b border-border/30">
                <motion.div whileTap={{ scale: 0.95 }}>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-3 text-[11px] gap-1.5 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 rounded-lg disabled:opacity-50"
                    onClick={markAllAsRead}
                    disabled={unreadCount === 0 || markingAllRead}
                  >
                    <motion.div
                      animate={markingAllRead ? { rotate: [0, 360] } : {}}
                      transition={{ duration: 0.6, repeat: markingAllRead ? Infinity : 0, ease: 'linear' }}
                    >
                      <CheckCheck className="h-3.5 w-3.5" />
                    </motion.div>
                    {markingAllRead ? 'جارٍ التحديث...' : 'قراءة الكل'}
                  </Button>
                </motion.div>
                <div className="flex-1" />
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-3 text-[11px] gap-1.5 text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-900/20 rounded-lg"
                  onClick={markAllAsRead}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  مسح الكل
                </Button>
              </div>
            )}

            {/* Notification List */}
            <div className="flex-1 overflow-hidden">
              {loading ? (
                <div className="divide-y divide-border/30">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <NotificationSkeleton key={i} />
                  ))}
                </div>
              ) : notifications.length === 0 ? (
                <EmptyState />
              ) : (
                <ScrollArea className="h-full">
                  {groupedNotifications.map((group, gIdx) => (
                    <div key={group.group}>
                      <DateGroupHeader label={group.label} count={group.items.length} />
                      <div className="divide-y divide-border/30">
                        {group.items.map((notif, idx) => {
                          const globalIdx = gIdx * 10 + idx;
                          return (
                            <motion.div
                              key={notif.id}
                              initial={{ opacity: 0, x: 30, scale: 0.98 }}
                              animate={{ opacity: 1, x: 0, scale: 1 }}
                              transition={{
                                delay: Math.min(globalIdx * 0.04, 0.5),
                                type: 'spring',
                                stiffness: 220,
                                damping: 22,
                              }}
                              whileHover={{
                                backgroundColor: notif.read
                                  ? 'rgba(16, 185, 129, 0.04)'
                                  : 'rgba(16, 185, 129, 0.08)',
                                scale: 1.005,
                              }}
                              className={`relative px-5 py-4 transition-colors duration-200 cursor-pointer ${
                                !notif.read
                                  ? 'bg-gradient-to-l from-emerald-50/40 via-teal-50/20 to-transparent dark:from-emerald-950/10 dark:via-teal-950/5'
                                  : ''
                              }`}
                              onClick={() => handleNotificationClick(notif.id, notif.read)}
                            >
                              {/* Unread indicator bar */}
                              <AnimatePresence>
                                {!notif.read && (
                                  <motion.div
                                    initial={{ scaleY: 0 }}
                                    animate={{ scaleY: 1 }}
                                    exit={{ scaleY: 0, opacity: 0 }}
                                    transition={{ duration: 0.3 }}
                                    className="absolute top-1 bottom-1 start-0 w-1 bg-gradient-to-b from-emerald-400 to-teal-500 rounded-e-full origin-center"
                                  />
                                )}
                              </AnimatePresence>
                              <div className="flex items-start gap-3">
                                <motion.div
                                  whileHover={{ scale: 1.1, rotate: -5 }}
                                  transition={{ type: 'spring', stiffness: 400, damping: 20 }}
                                >
                                  <NotificationIcon type={notif.type} />
                                </motion.div>
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 mb-0.5">
                                    <p className={`text-sm truncate ${!notif.read ? 'font-bold text-foreground' : 'font-medium text-foreground/80'}`}>
                                      {notif.title}
                                    </p>
                                    <StatusDot type={notif.type} read={notif.read} />
                                  </div>
                                  <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">{notif.body}</p>
                                  <p className="text-[10px] text-muted-foreground/60 mt-1.5">{formatTimeAgo(notif.time)}</p>
                                </div>
                              </div>
                            </motion.div>
                          );
                        })}
                      </div>
                    </div>
                  ))}

                  {/* Load More Button */}
                  {hasMore && (
                    <div className="px-5 py-3 flex justify-center">
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
                            جارٍ التحميل...
                          </>
                        ) : (
                          <>
                            <ChevronDown className="h-3.5 w-3.5" />
                            تحميل المزيد
                          </>
                        )}
                      </Button>
                    </div>
                  )}

                  {/* Bottom spacer */}
                  <div className="h-4" />
                </ScrollArea>
              )}
            </div>

            {/* Footer */}
            {notifications.length > 0 && !loading && (
              <div className="border-t border-border/50 px-5 py-3 bg-gray-50/50 dark:bg-gray-900/50">
                <div className="flex items-center justify-between">
                  <p className="text-[10px] text-muted-foreground">
                    انقر على الإشعارات لتحديد كمقروء · بلاصتي
                  </p>
                  {error && (
                    <div className="flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400">
                      <WifiOff className="h-3 w-3" />
                      غير متصل
                    </div>
                  )}
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
