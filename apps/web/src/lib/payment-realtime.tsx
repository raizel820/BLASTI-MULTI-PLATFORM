'use client';

/**
 * Payment realtime toasts (Task 2-e)
 *
 * Subscribes the app-wide Socket.IO singleton to the Chargily settlement
 * events the API emits on every fulfillment (chargily-fulfill.ts → POST /emit
 * → broadcastEvent):
 *
 *   payment:completed → toast.success(t('paymentToastCompleted'))
 *   payment:failed    → toast.error(t('paymentToastFailed'))
 *
 * The server routes `payment:*` to the `agency:{agencyId}` room (subscription
 * / hardware settlements) and/or the `customer:{userId}` room (SMS pack
 * purchases), so this component joins the room(s) matching the signed-in
 * principal and re-joins on login / account switches. Reuse contract: it goes
 * through hooks/use-realtime's useRealtime() — the SAME singleton socket, no
 * second connection — and mounts ONCE from ClientBootHardening (layout.tsx)
 * so every page (not only the payment result view) surfaces settlement
 * feedback. Renders nothing.
 */

import { useEffect, useMemo, useRef } from 'react';
import { toast } from 'sonner';
import { useRealtime } from '@/hooks/use-realtime';
import { useAppStore } from '@/store/use-app-store';
import { useLanguage } from '@/hooks/use-language';

export function PaymentRealtimeToasts() {
  const user = useAppStore((s) => s.user);
  const userId = user?.id;
  const userRole = user?.role;
  const agencyId = user?.agencyId;

  const { connected, on, joinRoom, leaveRoom } = useRealtime();
  const { t } = useLanguage();

  // Rooms this principal should listen in: the customer room covers SMS-pack
  // settlements (routed by userId), the agency room covers subscription /
  // hardware settlements (routed by agencyId). joins are re-emitted by the
  // hook's onConnect handler on every reconnect (tracked in joinedRoomsRef).
  const rooms = useMemo(() => {
    if (!userId) return [] as string[];
    const list: string[] = [];
    if ((userRole === 'AGENCY_OWNER' || userRole === 'AGENCY_STAFF') && agencyId) {
      list.push(`agency:${agencyId}`);
    }
    list.push(`customer:${userId}`);
    return list;
  }, [userId, userRole, agencyId]);

  const joinedRef = useRef<string[]>([]);

  useEffect(() => {
    const prev = joinedRef.current;
    for (const room of prev) {
      if (!rooms.includes(room)) leaveRoom(room);
    }
    for (const room of rooms) {
      if (!prev.includes(room)) joinRoom(room);
    }
    joinedRef.current = rooms;
  }, [rooms, joinRoom, leaveRoom]);

  // Attach the toast handlers only once the shared socket reports connected —
  // the hook resolves the socket asynchronously on native platforms (cloud
  // URL probe), and `on()` binds to the CURRENT socket. Once bound, handlers
  // survive reconnects (the singleton socket object persists across them).
  useEffect(() => {
    if (!connected) return;
    const offCompleted = on('payment:completed', () => {
      toast.success(t('paymentToastCompleted'));
    });
    const offFailed = on('payment:failed', () => {
      toast.error(t('paymentToastFailed'));
    });
    return () => {
      offCompleted();
      offFailed();
    };
  }, [connected, on, t]);

  return null;
}

export default PaymentRealtimeToasts;
