/**
 * Counter control sweeper (Feature C / r21-7; lifecycle reworked in r25).
 *
 * r25 (user ruling): an OPEN app must NEVER lose counter control. Control is
 * released only by explicit release (app close / logout via release-mine), an
 * owner/manager force transfer, or an ACCEPTED handover request. There is NO
 * TTL auto-free anymore — the old Pass 1 (frees counters whose heartbeat went
 * quiet) was removed: heartbeat staleness is liveness tracking only and feeds
 * solely the HOLDER_GONE decision below via CONTROL_CRASH_TTL_MS (15-minute
 * crash window, covering Android backgrounded WebViews whose JS timers freeze
 * while the app is still open).
 *
 * This worker therefore only resolves PENDING CounterControlRequests past
 * their 60s expiresAt — AUTO-APPROVE (transfer control to the requester) when
 * the holder is really gone (crash window elapsed) and the requester is still
 * an active agency member, else mark EXPIRED (emitting
 * counter:request-approved / counter:request-expired).
 */
import { CONTROL_CRASH_TTL_MS, sweepExpiredCounterRequests } from '../lib/counter-control'
import { emitCounterEvent } from '../lib/realtime-emit'

const SWEEP_INTERVAL_MS = 60_000

let timer: ReturnType<typeof setInterval> | null = null

async function runSweepPass(): Promise<void> {
  // r25 — Pass 1 (sweepStaleCounterControl TTL auto-free) was REMOVED: an
  // open app must never lose control; heartbeat staleness only feeds the
  // HOLDER_GONE decision inside sweepExpiredCounterRequests().

  // Pass — expire / auto-approve takeover requests past their 60s window.
  const outcomes = await sweepExpiredCounterRequests()
  for (const outcome of outcomes) {
    if (outcome.kind === 'AUTO_APPROVED') {
      // 0.6.77 — the DISPLACED holder learns of the takeover instantly (the
      // console matches by counterId and shows the loss banner) instead of
      // at its next heartbeat, up to a minute later.
      void emitCounterEvent('counter:lost', outcome.agencyId, {
        agencyId: outcome.agencyId,
        counterId: outcome.counterId,
        counterName: outcome.counterName,
        counterNumber: outcome.counterNumber,
        reason: 'AUTO_APPROVED_TAKEOVER',
        previousController: outcome.previousControllerUserId
          ? { userId: outcome.previousControllerUserId }
          : null,
      })
      void emitCounterEvent('counter:request-approved', outcome.agencyId, {
        agencyId: outcome.agencyId,
        requestId: outcome.requestId,
        counterId: outcome.counterId,
        counterName: outcome.counterName,
        counterNumber: outcome.counterNumber,
        autoClaimed: true,
        reason: outcome.reason,
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
        reason: outcome.reason,
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
  console.log(`[counter-control-sweeper] registered (interval=60s, request-window=60s, crash-ttl=${CONTROL_CRASH_TTL_MS / 1000}s, ttl-autofree=REMOVED)`)
  // One pass at boot so a restart resolves any takeover requests left pending
  // while offline (no control is ever freed — r25).
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
