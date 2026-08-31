/**
 * Queue Scheduler - Handles preferred time logic for reservations
 *
 * When a customer sets a preferred time, the system ensures their turn
 * won't come before that time. If their turn would come earlier,
 * later customers are served first until the preferred time arrives.
 */

/**
 * Check if a reservation should be skipped because the preferred time hasn't arrived yet
 */
export function shouldSkipForPreferredTime(
  reservation: { preferredTime: string | null; fixedTimeEnabled: boolean },
  currentTime: Date = new Date()
): boolean {
  if (!reservation.preferredTime || !reservation.fixedTimeEnabled) return false;

  const [hours, minutes] = reservation.preferredTime.split(':').map(Number);
  if (isNaN(hours) || isNaN(minutes)) return false;

  const preferredDate = new Date();
  preferredDate.setHours(hours, minutes, 0, 0);

  return currentTime < preferredDate;
}

/**
 * Get the next customer to call from the queue, respecting preferred times.
 * Skips customers whose preferred time hasn't arrived yet.
 */
export function getNextCustomerToCall(
  reservations: Array<{
    id: string;
    queueNumber: number;
    preferredTime: string | null;
    fixedTimeEnabled: boolean;
  }>,
  currentTime: Date = new Date()
): string | null {
  // Find the first customer whose preferred time has passed (or has no preferred time)
  for (const res of reservations) {
    if (!shouldSkipForPreferredTime(res, currentTime)) {
      return res.id;
    }
  }

  // If all have preferred times in the future, return null (no one to call yet)
  return null;
}

/**
 * Calculate the effective position of a reservation considering preferred times.
 * Customers with preferred times in the future are temporarily pushed back.
 */
export function getEffectivePosition(
  reservationId: string,
  allReservations: Array<{
    id: string;
    queueNumber: number;
    preferredTime: string | null;
    fixedTimeEnabled: boolean;
  }>,
  currentTime: Date = new Date()
): number {
  const sorted = [...allReservations].sort((a, b) => a.queueNumber - b.queueNumber);
  let position = 0;

  for (const res of sorted) {
    if (res.id === reservationId) return position + 1;
    // Count this person as "ahead" only if they aren't being skipped
    if (!shouldSkipForPreferredTime(res, currentTime)) {
      position++;
    }
  }

  return position + 1;
}
