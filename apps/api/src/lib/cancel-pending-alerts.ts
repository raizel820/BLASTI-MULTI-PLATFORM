/**
 * @blasti/api — Cancel Pending Alerts Utility
 *
 * Cancel any PENDING delayed jobs for a specific user + reservation.
 * Called when the customer opens the app (socket handshake) or views
 * their queue tracking dashboard — the carrier alert is no longer needed
 * because the customer is already engaged via the app.
 */

import { db } from '@blasti/db'

/**
 * Cancel all PENDING delayed jobs for a specific user + reservation.
 *
 * @param userId        The user whose pending alerts to cancel
 * @param reservationId The reservation whose pending alerts to cancel
 * @returns Number of jobs that were cancelled
 */
export async function cancelPendingCustomerAlerts(
  userId: string,
  reservationId: string,
): Promise<number> {
  const result = await db.delayedJob.updateMany({
    where: {
      userId,
      reservationId,
      status: 'PENDING',
    },
    data: {
      status: 'CANCELLED',
    },
  })

  if (result.count > 0) {
    console.log(
      `[cancel-pending-alerts] Cancelled ${result.count} pending alerts ` +
      `for user=${userId} reservation=${reservationId}`,
    )
  }

  return result.count
}

/**
 * Cancel all PENDING delayed jobs for a user across all of their
 * active (WAITING / CALLED) reservations.
 *
 * @param userId The user whose pending alerts to cancel
 * @returns Total number of jobs that were cancelled
 */
export async function cancelAllPendingAlertsForUser(
  userId: string,
): Promise<number> {
  // First, find all active reservations for the user
  const activeReservations = await db.reservation.findMany({
    where: {
      userId,
      status: { in: ['WAITING', 'CALLED'] },
    },
    select: { id: true },
  })

  if (activeReservations.length === 0) return 0

  let totalCancelled = 0
  for (const res of activeReservations) {
    totalCancelled += await cancelPendingCustomerAlerts(userId, res.id)
  }

  return totalCancelled
}
