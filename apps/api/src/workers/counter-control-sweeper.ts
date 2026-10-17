/**
 * Counter control sweeper (Feature C).
 *
 * Counter control must never outlive the controlling session. Clients claim
 * control via POST /counters/:counterId/occupy and then heartbeat every
 * CONTROL_HEARTBEAT_INTERVAL_MS. When an account logs out or closes the app
 * the heartbeats stop — an explicit release usually fires first (logout
 * route / release-mine / desktop close hook), but a crashed client would
 * leave the counter locked forever. This worker frees any control whose
 * heartbeat is older than CONTROL_TTL_MS so the counter becomes claimable
 * again within minutes.
 */
import { sweepStaleCounterControl } from '../lib/counter-control'

const SWEEP_INTERVAL_MS = 60_000

let timer: ReturnType<typeof setInterval> | null = null

export function startCounterControlSweeper(): void {
  if (timer) return
  timer = setInterval(async () => {
    try {
      const freed = await sweepStaleCounterControl()
      if (freed > 0) {
        console.log(`[counter-control-sweeper] freed ${freed} stale counter control(s)`)
      }
    } catch (error) {
      console.error('[counter-control-sweeper] sweep failed:', error)
    }
  }, SWEEP_INTERVAL_MS)
  // Never keep the process alive just for the sweeper.
  if (typeof timer.unref === 'function') timer.unref()
  console.log('[counter-control-sweeper] registered (interval=60s, ttl=3min)')
}

export function stopCounterControlSweeper(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
    console.log('[counter-control-sweeper] stopped')
  }
}
