'use client';

/**
 * Lock-screen notification event bus (mobile shell).
 *
 * The native Android path posts real lock-screen notifications (full-screen
 * intent over the keyguard, PUBLIC lock-screen visibility). This tiny bus
 * carries the SAME events to the in-app UI so the user also sees them:
 *   • app open          → a lock-screen-style heads-up card slides in;
 *   • app backgrounded  → the pending event is stored, and the Android-12
 *                         style card is rendered the moment the app comes
 *                         back to the foreground (mirroring what the OS
 *                         lock screen just showed).
 * Zero dependencies — notification-channel.ts publishes, the
 * LockscreenNotificationGate component subscribes.
 */

export interface LockscreenNotificationEvent {
  title: string;
  body: string;
  ticketNumber?: string;
  at: number;
}

type Listener = (event: LockscreenNotificationEvent) => void;

const listeners = new Set<Listener>();
/** Latest event fired while the app was backgrounded (shown on resume). */
let pendingWhileHidden: LockscreenNotificationEvent | null = null;

export function emitLockscreenEvent(event: LockscreenNotificationEvent): void {
  const isHidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
  if (isHidden) {
    pendingWhileHidden = event;
    return;
  }
  deliver(event);
}

/** Consumed by the gate on app resume — returns and clears the pending event. */
export function takePendingLockscreenEvent(): LockscreenNotificationEvent | null {
  const pending = pendingWhileHidden;
  pendingWhileHidden = null;
  return pending;
}

export function onLockscreenEvent(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function deliver(event: LockscreenNotificationEvent): void {
  for (const listener of Array.from(listeners)) {
    try { listener(event); } catch { /* one bad listener never blocks others */ }
  }
}
