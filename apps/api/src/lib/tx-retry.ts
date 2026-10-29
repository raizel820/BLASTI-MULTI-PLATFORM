/**
 * tx-retry.ts — shared transaction retry wrapper for concurrent queue writes.
 *
 * UNIFIED QUEUE (branch-staff requirement): "implement automatic retries on
 * concurrent-operation conflicts". Under simultaneous staff workstations two
 * transactions can collide on the same rows (Postgres serialization/write
 * conflict = Prisma P2034, SQLSTATE 40001/40P01; SQLite BUSY — the desktop
 * mirrors replay through the same helpers historically). This wrapper retries
 * the WHOLE transaction up to 3 times with exponential backoff (50/150/450ms)
 * so a conflict resolves itself instead of surfacing a 500 to reception.
 *
 * NOTE: candidate-level races (two desks picking the same ticket) are NOT
 * handled here — they are absorbed by the optimistic-concurrency claim loop
 * in lib/queue-claim.ts (conditional updateMany WHERE status='WAITING'), so a
 * loser silently claims the NEXT ticket instead of retrying the transaction.
 */
import { db } from '@blasti/db'

const MAX_TX_RETRIES = 3
const TX_RETRY_DELAYS = [50, 150, 450]

function isRetryableTxError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const msg = error.message || ''
  return (
    /SQLITE_BUSY|busy_timeout|database is locked|deadlock/i.test(msg) ||
    /40001|40P01/.test(msg) || // Postgres serialization_failure / deadlock_detected
    (error as { code?: string }).code === 'P2034' // Prisma: transaction write conflict
  )
}

/**
 * Run `fn` inside `db.$transaction`, retrying retryable conflict errors with
 * exponential backoff. The callback receives the interactive-transaction
 * client and must be IDEMPOTENT-SAFE to re-run (all reads re-execute).
 */
export async function withTxRetry<R>(
  fn: (tx: any) => Promise<R>,
): Promise<R> {
  for (let attempt = 0; attempt < MAX_TX_RETRIES; attempt++) {
    try {
      return await db.$transaction(fn)
    } catch (error: unknown) {
      if (!isRetryableTxError(error) || attempt === MAX_TX_RETRIES - 1) throw error
      const delay = TX_RETRY_DELAYS[attempt]
      console.warn(
        `[tx-retry] concurrent-operation conflict on attempt ${attempt + 1}/${MAX_TX_RETRIES}, retrying in ${delay}ms…`,
      )
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
  throw new Error('Transaction retry exhausted') // unreachable
}
