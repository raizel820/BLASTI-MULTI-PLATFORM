/**
 * Counter control sweeper (Feature C / r21-7).
 *
 * Counter control must never outlive the controlling session. Clients claim
 * control via POST /api/agency/counters/:counterId/claim and then heartbeat
 * every CONTROL_HEARTBEAT_INTERVAL_MS. When an account logs out or closes the
 * app the heartbeats stop — an explicit release usually fires first (logout
 * route / release-mine keepalive / desktop close hook), but a crashed client
 * would leave the counter locked forever. This worker:
 *
 *   1. frees any control whose heartbeat is older than CONTROL_TTL_MS
 *      (emitting counter:lost + counter:released to the agency room), and
 *   2. resolves PENDING CounterControlRequests past their 60s expiresAt —
 *      AUTO-APPROVE (transfer control to the requester) when they are still
 *      an active agency member, else mark EXPIRED (emitting
 *      counter:request-approved / counter:request-expired).
 *
 * The legacy agency:updated counter-released action keeps firing so the old
 * dashboard UI (which listens only for that envelope) stays in sync.
 */
import {
  CONTROL_TTL_MS,
  sweepStaleCounterControl,
  sweepExpiredCounterRequests,
} from '../lib/counter-control'
import { emitAgencyEvent, emitCounterEvent } from '../lib/realtime-emit'

const SWEEP_INTERVAL_MS = 60_000

let timer: ReturnType<typeof setInterval> | null = null

/** Legacy agency:updated envelope — the old dashboard UI depends on this action name. */
function emitLegacyCounterUpdate(
  agencyId: string,
  action: 'counter-released' | 'counter-occupied',
  counterId: string,
): void {
  void emitAgencyEvent('agency:updated', agencyId, { action, counterId })
}

async function runSweepPass(): Promise<void> {
  // Pass 1 — release counters whose control heartbeat went stale.
  const swept = await sweepStaleCounterControl()
  for (const counter of swept) {
    // counter:lost tells the (dead) controller's other sessions; counter:released
    // tells everyone the counter is free again.
    void emitCounterEvent('counter:lost', counter.agencyId, {
      agencyId: counter.agencyId,
      counterId: counter.counterId,
      counterName: counter.counterName,
      counterNumber: counter.counterNumber,
      reason: 'HEARTBEAT_EXPIRED',
      previousController: { userId: counter.previousUserId },
    })
    void emitCounterEvent('counter:released', counter.agencyId, {
      agencyId: counter.agencyId,
      counterId: counter.counterId,
      counterName: counter.counterName,
      counterNumber: counter.counterNumber,
      actor: { kind: 'SYSTEM', reason: 'HEARTBEAT_EXPIRED' },
    })
    emitLegacyCounterUpdate(counter.agencyId, 'counter-released', counter.counterId)
  }
  if (swept.length > 0) {
    console.log(`[counter-control-sweeper] freed ${swept.length} stale counter control(s)`)
  }

  // Pass 2 — expire / auto-approve takeover requests past their 60s window.
  const outcomes = await sweepExpiredCounterRequests()
  for (const outcome of outcomes) {
    if (outcome.kind === 'AUTO_APPROVED') {
      void emitCounterEvent('counter:request-approved', outcome.agencyId, {
        agencyId: outcome.agencyId,
        requestId: outcome.requestId,
        counterId: outcome.counterId,
        counterName: outcome.counterName,
        counterNumber: outcome.counterNumber,
        autoClaimed: true,
        requester: { userId: outcome.fromUserId },
        actor: { kind: 'SYSTEM', reason: 'REQUEST_EXPIRED_AUTO_CLAIM' },
      })
      // The transfer also IS a claim — announce it so every workstation re-reads.
      void emitCounterEvent('counter:claimed', outcome.agencyId, {
        agencyId: outcome.agencyId,
        counterId: outcome.counterId,
        counterName: outcome.counterName,
        counterNumber: outcome.counterNumber,
        requestId: outcome.requestId,
        autoClaimed: true,
        actor: { kind: 'SYSTEM', reason: 'REQUEST_EXPIRED_AUTO_CLAIM' },
      })
    } else {
      void emitCounterEvent('counter:request-expired', outcome.agencyId, {
        agencyId: outcome.agencyId,
        requestId: outcome.requestId,
        counterId: outcome.counterId,
        counterName: outcome.counterName,
        counterNumber: outcome.counterNumber,
        requester: { userId: outcome.fromUserId },
        actor: { kind: 'SYSTEM', reason: 'REQUEST_EXPIRED' },
      })
    }
  }
  if (outcomes.length > 0) {
    console.log(`[counter-control-sweeper] resolved ${outcomes.length} expired control request(s)`)
  }
}

export function startCounterControlSweeper(): void {
  if (timer) return
  timer = setInterval(() => {
    runSweepPass().catch((error) => {
      console.error('[counter-control-sweeper] sweep failed:', error)
    })
  }, SWEEP_INTERVAL_MS)
  // Never keep the process alive just for the sweeper.
  if (typeof timer.unref === 'function') timer.unref()
  console.log(`[counter-control-sweeper] registered (interval=60s, ttl=${CONTROL_TTL_MS / 1000}s, request-window=60s)`)
  // One pass at boot so a restart reaps anything left stale while offline.
  runSweepPass().catch((error) => {
    console.error('[counter-control-sweeper] boot sweep failed:', error)
  })
}

export function stopCounterControlSweeper(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
    console.log('[counter-control-sweeper] stopped')
  }
}
