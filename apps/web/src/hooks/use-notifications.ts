'use client';

import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { apiClient, isApiUnreachable, isBothUnreachable } from '@/lib/api-client';
import { useRealtime } from './use-realtime';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface Notification {
  id: string;
  type: 'turn' | 'queue' | 'system' | 'success' | 'warning' | 'error' | 'info';
  title: string;
  body: string;
  time: Date;
  read: boolean;
  agencyId?: string;
}

/** API response shape from GET /api/notifications */
interface ApiNotification {
  id: string;
  type: string;
  title: string;
  message: string;
  isRead: boolean;
  createdAt: string;
  entityId?: string | null;
  userId: string;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Map API notification type to UI type */
function mapApiType(apiType: string): Notification['type'] {
  const t = (apiType || '').toUpperCase();
  if (t.startsWith('TURN')) return 'turn';
  if (t.startsWith('QUEUE')) return 'queue';
  if (t.startsWith('SUCCESS')) return 'success';
  if (t.startsWith('WARNING')) return 'warning';
  if (t.startsWith('ERROR')) return 'error';
  if (t.startsWith('INFO')) return 'info';
  return 'system';
}

/** Map API notification to UI notification */
function mapApiNotification(n: ApiNotification): Notification {
  return {
    id: n.id,
    type: mapApiType(n.type),
    title: n.title || '',
    body: n.message || '',
    time: new Date(n.createdAt),
    read: n.isRead,
    agencyId: n.entityId || undefined,
  };
}

// ─── Constants ─────────────────────────────────────────────────────────────

const PAGE_SIZE = 50;
const NORMAL_POLL_MS = 30_000;

// ─── Hook ──────────────────────────────────────────────────────────────────

export interface UseNotificationsReturn {
  notifications: Notification[];
  unreadCount: number;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  hasMore: boolean;
  loadingMore: boolean;
  markingAllRead: boolean;
  markAsRead: (id: string) => Promise<void>;
  markAllAsRead: () => Promise<void>;
  refetch: () => void;
  loadMore: () => void;
  deleteNotification: (id: string) => Promise<void>;
}

export function useNotifications(userId?: string): UseNotificationsReturn {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [markingAllRead, setMarkingAllRead] = useState(false);
  const { onNotification, onYourTurn, onTurnApproaching, joinCustomer } = useRealtime();

  // Keep a ref to notifications.length for the fetch callback
  const notificationsLengthRef = useRef(0);

  // Sync ref to current length (must be in effect to avoid render-time ref access)
  useEffect(() => {
    notificationsLengthRef.current = notifications.length;
  }, [notifications.length]);

  // Track if we've done initial fetch
  const hasFetchedRef = useRef(false);
  // FIX #12: Track error with ref to avoid stale closure in fetchNotifications
  const errorShownRef = useRef(false);
  // Track poll failures for backoff
  const pollFailuresRef = useRef(0);

  // ─── Unread count ─────────────────────────────────────────────────────
  const unreadCount = useMemo(
    () => notifications.filter(n => !n.read).length,
    [notifications]
  );

  // ─── Fetch notifications from API ─────────────────────────────────────
  // FIX #13: Removed stale `error` from deps. Error state is tracked via ref.
  const fetchNotifications = useCallback(async (append = false) => {
    if (!append) {
      setRefreshing(true);
    }
    setError(null);

    try {
      const skip = append ? notificationsLengthRef.current : 0;
      const res = await apiClient.get<{
        success: boolean;
        notifications: ApiNotification[];
        unreadCount: number;
      }>('/api/notifications', {
        params: { take: String(PAGE_SIZE), skip: String(skip) },
        retries: 1,
        timeout: 8000,
      });

      const apiNotifs = (res.data?.notifications ?? []).map(mapApiNotification);

      if (append) {
        setNotifications(prev => [...prev, ...apiNotifs]);
      } else {
        setNotifications(apiNotifs);
      }

      setHasMore(apiNotifs.length >= PAGE_SIZE);
      pollFailuresRef.current = 0;
    } catch (err) {
      // Only log on first failure — don't spam console on every poll
      if (!append && !errorShownRef.current) {
        console.warn('[use-notifications] API fetch failed:', err);
        setError('فشل تحميل الإشعارات');
        errorShownRef.current = true;
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
      setLoadingMore(false);
    }
  }, []);

  // ─── Refresh (pull-to-refresh style) ──────────────────────────────────
  const refetch = useCallback(() => {
    setRefreshing(true);
    errorShownRef.current = false;
    fetchNotifications(false);
  }, [fetchNotifications]);

  // ─── Load more ────────────────────────────────────────────────────────
  const loadMore = useCallback(() => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    fetchNotifications(true);
  }, [loadingMore, hasMore, fetchNotifications]);

  // ─── Initial fetch ────────────────────────────────────────────────────
  useEffect(() => {
    if (!hasFetchedRef.current) {
      hasFetchedRef.current = true;
      setLoading(true);
      fetchNotifications(false);
    }
  }, [fetchNotifications]);

  // ─── Polling with offline backoff ─────────────────────────────────────
  // FIX #14: Replaced fixed 30s interval with offline-aware backoff
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const getInterval = () => {
      const f = pollFailuresRef.current;
      if (f >= 5) return 300_000;
      if (f >= 3) return 120_000;
      if (f >= 1) return 60_000;
      return NORMAL_POLL_MS;
    };

    const tick = async () => {
      if (stopped) return;

      // Skip entirely when fully offline
      if (isBothUnreachable()) {
        timer = setTimeout(tick, getInterval());
        return;
      }

      await fetchNotifications(false);

      if (isApiUnreachable()) {
        pollFailuresRef.current = Math.min(pollFailuresRef.current + 1, 10);
      } else {
        pollFailuresRef.current = 0;
      }

      timer = setTimeout(tick, getInterval());
    };

    timer = setTimeout(tick, NORMAL_POLL_MS);
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [fetchNotifications]);

  // ─── Real-time event listeners ───────────────────────────────────────
  useEffect(() => {
    const unsubNotification = onNotification(() => fetchNotifications(false));
    const unsubYourTurn = onYourTurn(() => fetchNotifications(false));
    const unsubTurnApproaching = onTurnApproaching(() => fetchNotifications(false));
    return () => {
      unsubNotification();
      unsubYourTurn();
      unsubTurnApproaching();
    };
  }, [onNotification, onYourTurn, onTurnApproaching, fetchNotifications]);

  // ─── Join customer room for real-time events ──────────────────────────
  useEffect(() => {
    if (userId) {
      joinCustomer(userId);
    }
  }, [userId, joinCustomer]);

  // ─── Mark single notification as read ─────────────────────────────────
  // FIX #15: Use PUT instead of PATCH to match local API route
  const markAsRead = useCallback(async (id: string) => {
    // Optimistic update
    setNotifications(prev =>
      prev.map(n => (n.id === id ? { ...n, read: true } : n))
    );

    try {
      await apiClient.put(`/api/notifications/${id}`, { isRead: true });
    } catch {
      // Revert on failure
      setNotifications(prev =>
        prev.map(n => (n.id === id ? { ...n, read: false } : n))
      );
    }
  }, []);

  // ─── Mark all as read ─────────────────────────────────────────────────
  const markAllAsRead = useCallback(async () => {
    if (unreadCount === 0) return;
    setMarkingAllRead(true);

    // Staggered animation: mark each one with delay
    const unreadIds = notifications.filter(n => !n.read).map(n => n.id);
    for (let i = 0; i < unreadIds.length; i++) {
      setTimeout(() => {
        setNotifications(prev =>
          prev.map(n => (n.id === unreadIds[i] ? { ...n, read: true } : n))
        );
      }, i * 80);
    }

    try {
      await apiClient.put('/api/notifications/read-all', { markAll: true });
    } catch {
      // Silently fail — optimistic update is already applied
    }

    // Reset animation state after all items are marked
    setTimeout(() => setMarkingAllRead(false), unreadIds.length * 80 + 200);
  }, [notifications, unreadCount]);

  // ─── Delete a notification ────────────────────────────────────────────
  const deleteNotification = useCallback(async (id: string) => {
    // Optimistic remove
    setNotifications(prev => prev.filter(n => n.id !== id));

    try {
      await apiClient.delete(`/api/notifications/${id}`);
    } catch {
      // Refetch on failure to restore the deleted item
      fetchNotifications(false);
    }
  }, [fetchNotifications]);

  return {
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
    deleteNotification,
  };
}
