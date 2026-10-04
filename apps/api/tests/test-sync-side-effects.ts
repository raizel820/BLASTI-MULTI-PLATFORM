/**
 * Task 76 — sync push side-effects behavioral tests (hermetic, no DB/sockets).
 *
 * Verifies that DEVICE-originated mutations pushed through /api/sync/push now
 * produce the SAME customer/agency-facing side effects as the direct API
 * routes (the "call-next from the desktop never rang the phone" fix):
 *
 * Run: cd apps/api && bun tests/test-sync-side-effects.ts
 */

import {
  QUEUE_PUSH_STATUSES,
  resolveQueueAction,
  resolveQueueEventType,
  needsPreApplySnapshot,
  isQueueStatusTransition,
  emitPushSideEffects,
  type PreApplySnapshot,
  type PushSideEffectEmit,
} from '../src/lib/sync-side-effects'

// ─── Tiny harness ─────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed++
    console.log(`  ✔ ${name}`)
  } else {
    failed++
    console.error(`  ✘ ${name}`, detail !== undefined ? JSON.stringify(detail) : '')
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  check(name, ok, ok ? undefined : { actual, expected })
}

// ─── Fakes ────────────────────────────────────────────────────────────────────

interface FakeDbShape {
  user?: any
  agency?: any
  notificationCreate?: { ok: boolean; rows: any[] }
}

function makeFakeDb(shape: FakeDbShape = {}) {
  const calls = { userLookups: 0, agencyLookups: 0 }
  return {
    calls,
    user: {
      findUnique: async () => {
        calls.userLookups++
        if (shape.user?.reject) throw new Error('user lookup boom')
        return shape.user?.row ?? null
      },
    },
    agency: {
      findUnique: async () => {
        calls.agencyLookups++
        return shape.agency?.row ?? null
      },
    },
    notification: {
      create: async ({ data }: { data: any }) => {
        if (shape.notificationCreate && !shape.notificationCreate.ok) throw new Error('notification create boom')
        shape.notificationCreate = shape.notificationCreate || { ok: true, rows: [] }
        shape.notificationCreate.rows.push(data)
        return { id: 'notif-1', ...data }
      },
    },
    // Expose the live recorder (create() assigns it lazily into the shape).
    get notificationCreate() {
      return shape.notificationCreate
    },
  }
}

function makeFakeEmit(opts: { throwOn?: string } = {}) {
  const calls: RecordedCall[] = []
  const record = (fn: string) => (...args: any[]) => {
    calls.push({ fn, args })
    if (opts.throwOn === fn) throw new Error(`${fn} boom`)
    return Promise.resolve(true)
  }
  const emit: PushSideEffectEmit & { calls: RecordedCall[] } = Object.assign({
    queue: record('queue'),
    notify: record('notify'),
    kiosk: record('kiosk'),
  }, { calls })
  return emit
}

interface RecordedCall { fn: string; args: any[] }

function eventNames(emit: ReturnType<typeof makeFakeEmit>): string[] {
  return emit.calls.filter(c => c.fn === 'queue').map(c => c.args[0])
}

function waitForMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10))
}

// ─── 1. Pure mappings ─────────────────────────────────────────────────────────

console.log('\n── pure mappings ──')
eq('resolveQueueAction CALLED', resolveQueueAction('CALLED'), 'call')
eq('resolveQueueAction COMPLETED', resolveQueueAction('COMPLETED'), 'complete')
eq('resolveQueueAction NO_SHOW', resolveQueueAction('NO_SHOW'), 'no_show')
eq('resolveQueueAction CANCELLED', resolveQueueAction('CANCELLED'), 'cancel')
eq('resolveQueueAction WAITING → null', resolveQueueAction('WAITING'), null)

eq('resolveQueueEventType CALLED', resolveQueueEventType('CALLED'), 'queue:called')
eq('resolveQueueEventType COMPLETED', resolveQueueEventType('COMPLETED'), 'queue:completed')
eq('resolveQueueEventType NO_SHOW', resolveQueueEventType('NO_SHOW'), 'queue:no-show')
eq('resolveQueueEventType CANCELLED', resolveQueueEventType('CANCELLED'), 'queue:cancelled')
eq('resolveQueueEventType WAITING → null', resolveQueueEventType('WAITING'), null)

// ─── 2. Snapshot gating (per-mutation cost stays narrow) ──────────────────────

console.log('\n── snapshot gating ──')
check('Reservation + CALLED needs snapshot', needsPreApplySnapshot('Reservation', 'update', { status: 'CALLED' }))
check('Notification create needs snapshot', needsPreApplySnapshot('Notification', 'create', { userId: 'u1' }))
check('Reservation + WAITING does NOT need snapshot', !needsPreApplySnapshot('Reservation', 'update', { status: 'WAITING' }))
check('Reservation rating-only update does NOT need snapshot', !needsPreApplySnapshot('Reservation', 'update', { rating: 5 }))
check('Notification update does NOT need snapshot', !needsPreApplySnapshot('Notification', 'update', { title: 'x' }))
check('delete never needs snapshot', !needsPreApplySnapshot('Reservation', 'delete', { status: 'CALLED' }))

// ─── 3. Transition guard ──────────────────────────────────────────────────────

console.log('\n── transition guard ──')
check('WAITING→CALLED is a transition', isQueueStatusTransition({ status: 'WAITING' }, 'CALLED'))
check('null (create)→CALLED is a transition', isQueueStatusTransition({ status: null }, 'CALLED'))
check('CALLED→CALLED (replay) is NOT', isQueueStatusTransition({ status: 'CALLED' }, 'CALLED') === false)
check('→WAITING is never a transition', isQueueStatusTransition({ status: 'CALLED' }, 'WAITING') === false)
check('CALLED→COMPLETED is a transition', isQueueStatusTransition({ status: 'CALLED' }, 'COMPLETED'))

// ─── 4. CALLED transition — exact parity with POST /queue/call-next ──────────

console.log('\n── WAITING→CALLED parity ──')
{
  const emit = makeFakeEmit()
  const fakeDb = makeFakeDb({ user: { row: { fullName: 'Ali Ben' } } })
  await emitPushSideEffects({
    agencyId: 'ag1', model: 'Reservation', recordId: 'res1', operation: 'update',
    data: { status: 'CALLED', displayNumber: 'T-12', userId: 'u1', serviceId: 'svc1', isWalkIn: false },
    prev: { status: 'WAITING' } as PreApplySnapshot,
    db: fakeDb, emit,
  })
  await waitForMicrotasks()

  eq('one queue event', eventNames(emit), ['queue:called'])
  const q = emit.calls.find(c => c.fn === 'queue')!
  eq('queue:called payload parity', q.args[2], {
    reservationId: 'res1', displayNumber: 'T-12', userId: 'u1',
    customerName: 'Ali Ben', isWalkIn: false, serviceId: 'svc1',
  })
  eq('queue:called routed to the agency room', q.args[1], 'ag1')

  const n = emit.calls.find(c => c.fn === 'notify')!
  check('notification:your-turn emitted for registered user', !!n)
  eq('notification:your-turn payload parity', n && n.args, ['notification:your-turn', 'u1', {
    ticketNumber: 'T-12', agencyId: 'ag1', userId: 'u1', reservationId: 'res1',
  }])

  const k = emit.calls.find(c => c.fn === 'kiosk')!
  check('kiosk:update emitted', !!k)
  eq('kiosk payload parity', k && k.args, ['ag1', { nowServing: 'T-12', action: 'called' }])

  const rows = fakeDb.notificationCreate?.rows ?? []
  eq('QUEUE_CALLED row created (parity with processCandidate)', rows, [{
    userId: 'u1', type: 'QUEUE_CALLED', title: 'Queue Called',
    message: 'Your number T-12 has been called. Please proceed.',
  }])
  eq('no agency lookup on the call path (message has none)', fakeDb.calls.agencyLookups, 0)
}

// ─── 5. Walk-in CALLED: no your-turn, no row, customerName from walk-in field ─

console.log('\n── walk-in CALLED ──')
{
  const emit = makeFakeEmit()
  const fakeDb = makeFakeDb()
  await emitPushSideEffects({
    agencyId: 'ag1', model: 'Reservation', recordId: 'res2', operation: 'update',
    data: { status: 'CALLED', displayNumber: 'W-3', isWalkIn: true, walkInCustomerName: 'Walkin Guest' },
    prev: { status: 'WAITING' } as PreApplySnapshot,
    db: fakeDb, emit,
  })
  await waitForMicrotasks()
  eq('only queue + kiosk (no notify)', emit.calls.filter(c => c.fn === 'notify').length, 0)
  const q = emit.calls.find(c => c.fn === 'queue')!
  eq('customerName falls back to walkInCustomerName', q.args[2].customerName, 'Walkin Guest')
  eq('userId null in payload', q.args[2].userId, null)
  eq('no Notification row for walk-ins', (fakeDb.notificationCreate?.rows ?? []).length, 0)
}

// ─── 6. Replays / no-op status re-pushes stay silent ─────────────────────────

console.log('\n── replay silence ──')
{
  const emit = makeFakeEmit()
  const fakeDb = makeFakeDb()
  await emitPushSideEffects({
    agencyId: 'ag1', model: 'Reservation', recordId: 'res1', operation: 'update',
    data: { status: 'CALLED', displayNumber: 'T-12', userId: 'u1' },
    prev: { status: 'CALLED' } as PreApplySnapshot,
    db: fakeDb, emit,
  })
  await waitForMicrotasks()
  eq('no events on same-status re-push', emit.calls.length, 0)
  eq('no Notification row on replay', (fakeDb.notificationCreate?.rows ?? []).length, 0)
}

// ─── 7. complete / no_show / cancel — parity with PATCH /queue/:id ───────────

console.log('\n── complete/no_show/cancel parity ──')
for (const t of [
  { status: 'COMPLETED', event: 'queue:completed', action: 'complete', type: 'COMPLETED', title: 'Service Completed' },
  { status: 'NO_SHOW', event: 'queue:no-show', action: 'no_show', type: 'NO_SHOW', title: 'Marked as No-Show' },
  { status: 'CANCELLED', event: 'queue:cancelled', action: 'cancel', type: 'CANCELLED', title: 'Reservation Cancelled by Agency' },
]) {
  const emit = makeFakeEmit()
  const fakeDb = makeFakeDb({ agency: { row: { name: 'Clinic X' } } })
  await emitPushSideEffects({
    agencyId: 'ag1', model: 'Reservation', recordId: 'res9', operation: 'update',
    data: { status: t.status, displayNumber: 'T-7', userId: 'u1' },
    prev: { status: 'CALLED' } as PreApplySnapshot,
    db: fakeDb, emit,
  })
  await waitForMicrotasks()

  eq(`${t.status}: queue event`, eventNames(emit), [t.event])
  const q = emit.calls.find(c => c.fn === 'queue')!
  eq(`${t.status}: queue payload parity`, q.args[2], {
    reservationId: 'res9', displayNumber: 'T-7', action: t.action, status: t.status,
  })

  const n = emit.calls.find(c => c.fn === 'notify')!
  eq(`${t.status}: notification:new to the customer`, n && n.args[0], 'notification:new')
  eq(`${t.status}: notification:new payload parity`, n && n.args, ['notification:new', 'u1', {
    type: t.event, ticketNumber: 'T-7',
    message: n.args[2].message,
  }])
  check(`${t.status}: message names the agency`, String(n.args[2].message).includes('Clinic X'), n.args[2].message)

  const k = emit.calls.find(c => c.fn === 'kiosk')!
  eq(`${t.status}: kiosk payload parity`, k && k.args, ['ag1', { action: t.action, displayNumber: 'T-7' }])

  const rows = fakeDb.notificationCreate?.rows ?? []
  eq(`${t.status}: Notification row type/title parity`, rows.map((r: any) => ({ type: r.type, title: r.title })), [{ type: t.type, title: t.title }])
  check(`${t.status}: row message names the agency`, rows.length === 1 && String(rows[0].message).includes('Clinic X'), rows[0]?.message)
}

// ─── 8. Non-queue statuses never fire ────────────────────────────────────────

console.log('\n── non-queue statuses ──')
{
  const emit = makeFakeEmit()
  await emitPushSideEffects({
    agencyId: 'ag1', model: 'Reservation', recordId: 'res3', operation: 'create',
    data: { status: 'WAITING', displayNumber: 'T-20', userId: 'u1' },
    prev: { status: null } as PreApplySnapshot,
    db: makeFakeDb(), emit,
  })
  await waitForMicrotasks()
  eq('WAITING create is silent (joins are announced by their own routes)', emit.calls.length, 0)
}

// ─── 9. Notification creates pushed by devices → notification:new ────────────

console.log('\n── device Notification rows ──')
{
  const emitNew = makeFakeEmit()
  await emitPushSideEffects({
    agencyId: 'ag1', model: 'Notification', recordId: 'n1', operation: 'create',
    data: { userId: 'u2', type: 'QUEUE_CALLED', title: 'Queue Called' },
    prev: { existed: false } as PreApplySnapshot,
    db: makeFakeDb(), emit: emitNew,
  })
  await waitForMicrotasks()
  const n = emitNew.calls.find(c => c.fn === 'notify')!
  eq('notification:new fired for the pushed row', n && n.args, ['notification:new', 'u2', {
    notificationId: 'n1', type: 'QUEUE_CALLED', title: 'Queue Called',
  }])

  const emitDup = makeFakeEmit()
  await emitPushSideEffects({
    agencyId: 'ag1', model: 'Notification', recordId: 'n1', operation: 'create',
    data: { userId: 'u2', type: 'QUEUE_CALLED', title: 'Queue Called' },
    prev: { existed: true } as PreApplySnapshot,
    db: makeFakeDb(), emit: emitDup,
  })
  await waitForMicrotasks()
  eq('row that already existed cloud-side is NOT re-announced', emitDup.calls.length, 0)

  const emitNoUser = makeFakeEmit()
  await emitPushSideEffects({
    agencyId: 'ag1', model: 'Notification', recordId: 'n2', operation: 'create',
    data: { type: 'X' }, prev: { existed: false } as PreApplySnapshot,
    db: makeFakeDb(), emit: emitNoUser,
  })
  await waitForMicrotasks()
  eq('Notification row without userId is silent', emitNoUser.calls.length, 0)
}

// ─── 10. Resilience — side effects must NEVER fail the push ──────────────────

console.log('\n── resilience ──')
{
  const boomEmit = makeFakeEmit({ throwOn: 'queue' })
  let threw = false
  try {
    await emitPushSideEffects({
      agencyId: 'ag1', model: 'Reservation', recordId: 'res4', operation: 'update',
      data: { status: 'COMPLETED', displayNumber: 'T-1', userId: 'u1' },
      prev: { status: 'CALLED' } as PreApplySnapshot,
      db: makeFakeDb(), emit: boomEmit,
    })
  } catch {
    threw = true
  }
  await waitForMicrotasks()
  check('throwing emit does not fail the push', !threw)

  const boomDb = makeFakeDb({ notificationCreate: { ok: false, rows: [] } })
  let threwRow = false
  try {
    await emitPushSideEffects({
      agencyId: 'ag1', model: 'Reservation', recordId: 'res5', operation: 'update',
      data: { status: 'CANCELLED', displayNumber: 'T-2', userId: 'u1' },
      prev: { status: 'CALLED' } as PreApplySnapshot,
      db: boomDb, emit: makeFakeEmit(),
    })
  } catch {
    threwRow = true
  }
  await waitForMicrotasks()
  check('failing Notification row create does not fail the push', !threwRow)

  const userBoomDb = makeFakeDb({ user: { reject: true } })
  const okEmit = makeFakeEmit()
  await emitPushSideEffects({
    agencyId: 'ag1', model: 'Reservation', recordId: 'res6', operation: 'update',
    data: { status: 'CALLED', displayNumber: 'T-3', userId: 'u1' },
    prev: { status: 'WAITING' } as PreApplySnapshot,
    db: userBoomDb, emit: okEmit,
  })
  await waitForMicrotasks()
  const q = okEmit.calls.find(c => c.fn === 'queue')!
  eq('failing user lookup degrades customerName to ""', q.args[2].customerName, '')

  // Rejected emit promises must not surface as unhandled rejections.
  const rejectingEmit: PushSideEffectEmit = {
    queue: () => Promise.reject(new Error('socket down')),
    notify: () => Promise.reject(new Error('socket down')),
    kiosk: () => Promise.reject(new Error('socket down')),
  }
  await emitPushSideEffects({
    agencyId: 'ag1', model: 'Reservation', recordId: 'res7', operation: 'update',
    data: { status: 'CALLED', displayNumber: 'T-4', userId: 'u1' },
    prev: { status: 'WAITING' } as PreApplySnapshot,
    db: makeFakeDb({ user: { row: { fullName: 'Sara' } } }), emit: rejectingEmit,
  })
  await waitForMicrotasks()
  check('rejected emit promises are swallowed (no unhandled rejection)', true)
}

// ─── 11. Registry sanity ──────────────────────────────────────────────────────

console.log('\n── registry sanity ──')
eq('QUEUE_PUSH_STATUSES exactly the four queue states', [...QUEUE_PUSH_STATUSES].sort(), ['CALLED', 'CANCELLED', 'COMPLETED', 'NO_SHOW'])

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
