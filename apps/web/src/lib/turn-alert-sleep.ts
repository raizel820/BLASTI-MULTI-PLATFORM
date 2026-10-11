/**
 * Turn Alert Sleep-State Manager
 *
 * Singleton module that manages the "sleep mode" for turn-call alerts.
 * When a customer swipes to confirm their turn, the alert enters sleep mode
 * for 10 minutes. During sleep, realtime events do NOT re-trigger the alert.
 * After 10 minutes, the alert reactivates ONCE (single reminder), then stops
 * permanently until the agency confirms arrival (queue:completed) or the
 * reservation is no-show/cancelled.
 *
 * This module is the single source of truth shared between:
 * - AggressiveTurnAlert overlay (useTurnAlert hook in use-realtime.tsx)
 * - Inline banner (customer-queue.tsx)
 *
 * State is persisted to localStorage so it survives page reloads.
 */

const STORAGE_KEY = 'blasti-turn-alert-sleep';
const SLEEP_DURATION_MS = 10 * 60 * 1000; // 10 minutes
const MAX_REACTIVATIONS = 1;

interface SleepRecord {
  reservationId: string;
  acknowledgedAt: number;      // when user swiped to confirm
  reactivationCount: number;   // how many times the alert re-shown after sleep (0 or 1)
  reactivationDue: boolean;    // true when 10-min timer fired and alert should re-show
}

let record: SleepRecord | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

// ── Persistence ──────────────────────────────────────────────────────────────

function hydrate() {
  if (typeof window === 'undefined') return;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as SleepRecord;
    if (!parsed?.reservationId || typeof parsed.acknowledgedAt !== 'number') {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    record = parsed;

    // Check if the sleep window has expired while we were away
    const elapsed = Date.now() - parsed.acknowledgedAt;
    if (elapsed >= SLEEP_DURATION_MS) {
      // Sleep window expired — trigger reactivation if not already done
      if (parsed.reactivationCount < MAX_REACTIVATIONS && !parsed.reactivationDue) {
        record.reactivationDue = true;
        persist();
      }
    } else {
      // Still within sleep window — re-arm the timer for the remaining time
      const remaining = SLEEP_DURATION_MS - elapsed;
      armTimer(parsed.reservationId, remaining);
    }
  } catch {
    // Corrupted data — clear it
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  }
}

function persist() {
  if (typeof window === 'undefined') return;
  try {
    if (record) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch { /* ignore */ }
  notifyListeners();
}

// ── Timer ────────────────────────────────────────────────────────────────────

function armTimer(reservationId: string, delayMs: number) {
  clearTimer();
  timer = setTimeout(() => {
    reactivate(reservationId);
  }, delayMs);
}

function clearTimer() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

function reactivate(reservationId: string) {
  if (!record || record.reservationId !== reservationId) return;
  // Mark that reactivation is due — UI listeners will see this and re-show the alert
  if (record.reactivationCount < MAX_REACTIVATIONS) {
    record.reactivationDue = true;
    persist();
  }
  timer = null;
}

// ── Listeners ────────────────────────────────────────────────────────────────

function notifyListeners() {
  listeners.forEach((fn) => {
    try { fn(); } catch { /* ignore listener errors */ }
  });
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Enter sleep mode — called when user swipes to confirm (SlideToConfirm)
 * or taps "I'm Here" on the overlay.
 *
 * Idempotent: if already sleeping for the same reservationId, does nothing
 * (prevents a second dismissal after reactivation from restarting the window).
 */
export function enterSleepMode(reservationId: string) {
  if (!reservationId) return;

  // If already sleeping for the same reservation, don't restart the timer
  if (record && record.reservationId === reservationId && !record.reactivationDue) {
    return;
  }

  clearTimer();
  record = {
    reservationId,
    acknowledgedAt: Date.now(),
    reactivationCount: 0,
    reactivationDue: false,
  };
  armTimer(reservationId, SLEEP_DURATION_MS);
  persist();
}

/**
 * Should the alert be shown for this reservation right now?
 *
 * Returns true if:
 * - No record exists (first call), OR
 * - Reactivation is due (10 min passed, count still 0, reactivationDue flag set)
 *
 * Returns false if:
 * - Sleeping (within 10min, count 0, reactivationDue false), OR
 * - Already reactivated (count >= 1 and reactivationDue was consumed)
 */
export function shouldShowAlert(reservationId: string): boolean {
  if (!record || record.reservationId !== reservationId) return true;
  // If reactivation is due, allow showing
  if (record.reactivationDue && record.reactivationCount < MAX_REACTIVATIONS) return true;
  // Otherwise suppress
  return false;
}

/**
 * Is reactivation currently due? (10-min timer fired, alert should re-show once)
 */
export function isReactivationDue(reservationId: string): boolean {
  if (!record || record.reservationId !== reservationId) return false;
  return record.reactivationDue && record.reactivationCount < MAX_REACTIVATIONS;
}

/**
 * Mark that the reactivation alert has been shown to the user.
 * After this, shouldShowAlert returns false permanently for this reservation.
 */
export function markReactivationShown(reservationId: string) {
  if (!record || record.reservationId !== reservationId) return;
  record.reactivationDue = false;
  record.reactivationCount = Math.min(record.reactivationCount + 1, MAX_REACTIVATIONS);
  persist();
}

/**
 * Clear sleep state — called when reservation leaves CALLED state
 * (queue:completed, queue:no-show, queue:cancelled).
 */
export function clearSleep(reservationId?: string) {
  if (reservationId && record && record.reservationId !== reservationId) return;
  clearTimer();
  record = null;
  persist();
}

/**
 * Get the current sleep record (for debugging / UI state checks).
 */
export function getSleepRecord(): SleepRecord | null {
  return record;
}

/**
 * Close any open Web Notifications tagged 'blasti-turn'.
 * Works around the fact that Notification.getNotifications is not in standard lib.dom.d.ts.
 */
export function closeTurnNotifications() {
  if (typeof window === 'undefined' || !('Notification' in window)) return;
  try {
    const N = Notification as any;
    if (typeof N.getNotifications === 'function') {
      Promise.resolve(N.getNotifications({ tag: 'blasti-turn' }))
        .then((notifs: Notification[]) => {
          notifs.forEach((n) => { try { n.close(); } catch { /* ignore */ } });
        })
        .catch(() => { /* ignore */ });
    }
  } catch { /* ignore */ }
}

// ── Initialize on module load ────────────────────────────────────────────────
if (typeof window !== 'undefined') {
  hydrate();
}
