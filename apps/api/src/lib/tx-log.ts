/**
 * tx-log.ts — Unified TRANSACTION EVENT STREAM (0.6.81)
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE canonical store for the full lifecycle of every money movement on the
 * platform — subscriptions, SMS credit packs, hardware orders — from the
 * moment a user OPENS a purchase surface until the payment is settled and the
 * final result/redirection is done:
 *
 *   page_enter → purchase_ui_open → purchase_ui_interact → checkout_creating
 *   → checkout_created | checkout_failed | manual_submit
 *   → redirect_gateway → return_received → verify_poll → webhook_received
 *   → settle_paid | settle_failed | manual_approved | manual_rejected
 *   → redirect_back → result_final
 *
 * DESIGN — no duplicated pipeline (the user's mandate: "one code doing the
 * thing"):
 *   • CLIENT events ride the EXISTING remote-logger batch ingest
 *     (POST /api/logs — same buffer, same flusher, same auth/identity,
 *     same rate limit) tagged `tag:'tx'` + `channel:'transactions'`; the
 *     ingest route MIRRORS them here (see routes/logs.ts).
 *   • SERVER events (checkout created, webhook received, settlement, manual
 *     review) are written DIRECTLY by this helper — one function call at
 *     each authoritative mutation point.
 *   • Both sides land in the SAME stream file with the SAME line schema, so
 *     the Logs Manager "Transactions" tab (GET /api/logs/transactions) and
 *     the unified export see ONE coherent timeline per transaction.
 *
 * Storage: ${BLASTI_LOG_DIR:-<repo>/logs}/_transactions/<YYYY-MM-DD>.ndjson
 * (the `_` prefix keeps the folder out of the per-account vault listings,
 * exactly like the analyzer's `_analysis` folder).
 */

import fs from 'node:fs'
import path from 'node:path'

// ─── Canonical stage taxonomy ────────────────────────────────────────────────

export const TX_STAGES = [
  // client funnel
  'page_enter',          // subscriptions page mounted / purchase surface opened
  'purchase_ui_open',    // payment dialog opened (plans dialog, SMS pack dialog)
  'purchase_ui_interact',// method / pack / period selection
  'checkout_creating',   // POST /payment/create-checkout sent
  'redirect_gateway',    // hosted Chargily page opened
  'return_received',     // payer back on the result view
  'verify_poll',         // settlement status poll fired (first of a session)
  'verify_error',        // poll/verify attempt FAILED (http status captured) — error-path coverage
  'checkout_abandoned',  // result view closed before the checkout reached a final state
  'settle_push',         // realtime settlement push received by the app
  'redirect_back',       // blasti:// deep-link bounce into the app fired
  'result_final',        // final result state shown (paid | failed | still-pending | unverified)
  // server authoritative events
  'checkout_created',    // local ledger row + gateway session exist
  'checkout_failed',     // gateway refused the checkout
  'manual_submit',       // manual receipt / payment request submitted
  'manual_approved',     // admin approved the manual payment
  'manual_rejected',     // admin rejected the manual payment
  'webhook_received',    // Chargily webhook hit the server
  'webhook_rejected',    // signature verification failed
  'settle_paid',         // settlement applied — payment confirmed
  'settle_failed',       // settlement applied — payment failed
  'settle_duplicate',    // replays (idempotency guard hit)
] as const
export type TxStage = (typeof TX_STAGES)[number]

export const TX_TYPES = ['subscription', 'sms', 'hardware'] as const
export type TxType = (typeof TX_TYPES)[number]

// ─── Event shape ─────────────────────────────────────────────────────────────

export interface TxEventIdentity {
  uid?: string | null
  userId?: string | null
  username?: string | null
  role?: string | null
  agencyId?: string | null
}

export interface TxEventInput {
  stage: string
  message: string
  level?: 'debug' | 'info' | 'warn' | 'error'
  /** Structured extras — kept small; the whole line is capped. */
  data?: Record<string, unknown>
  identity?: TxEventIdentity
  /** 'server' for direct writes; the ingest mirror stamps 'client'. */
  origin?: 'client' | 'server'
  platform?: string
  appVersion?: string
  /** Local ledger row id (Transaction / SmsPurchase). */
  ref?: string | null
  /** Chargily checkout id (providerRef). */
  checkoutId?: string | null
  txType?: string
  status?: string
  amount?: number | null
  method?: string | null
}

/** The canonical NDJSON line — identical for client-mirrored + server events. */
export interface TxEventRecord {
  ts: string
  level: string
  tag: 'tx'
  channel: 'transactions'
  origin: 'client' | 'server'
  stage: string
  message: string
  txType?: string
  ref?: string
  checkoutId?: string
  status?: string
  amount?: number
  method?: string
  uid?: string | null
  userId?: string | null
  username?: string | null
  role?: string | null
  agencyId?: string | null
  platform?: string
  appVersion?: string
  data?: Record<string, unknown>
}

// ─── Storage ─────────────────────────────────────────────────────────────────

const MAX_LINE_CHARS = 8_000
const MAX_DATA_KEYS = 24
const DAY_FILE_TRIM_BYTES = 20 * 1024 * 1024 // trim oldest half past 20 MB

export function txLogRoot(): string {
  return path.join(
    process.env.BLASTI_LOG_DIR || path.join(process.cwd(), 'logs'),
    '_transactions',
  )
}

function dayStamp(d = new Date()): string {
  return d.toISOString().slice(0, 10)
}

export function txDayFile(date = dayStamp()): string {
  return path.join(txLogRoot(), `${date}.ndjson`)
}

function sanitizeData(raw: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, unknown> = {}
  let n = 0
  for (const [k, v] of Object.entries(raw)) {
    if (n >= MAX_DATA_KEYS) break
    const key = k.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40)
    if (!key) continue
    if (v === undefined) continue
    if (typeof v === 'string') { out[key] = v.slice(0, 300); n++ }
    else if (typeof v === 'number' && Number.isFinite(v)) { out[key] = Math.round(v * 100) / 100; n++ }
    else if (typeof v === 'boolean') { out[key] = v; n++ }
    else if (v === null) { out[key] = null; n++ }
  }
  return n > 0 ? out : undefined
}

function safeStr(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string' || !v) return undefined
  return v.replace(/[^A-Za-z0-9._:@ -]/g, '').slice(0, max) || undefined
}

/** Build ONE canonical record from either side's input. Never throws. */
export function buildTxRecord(input: TxEventInput): TxEventRecord {
  const id = input.identity ?? {}
  let message = typeof input.message === 'string' ? input.message : String(input.message ?? '')
  if (message.length > 400) message = message.slice(0, 400) + '…'
  const stage = safeStr(input.stage, 32) || 'unknown'
  const ref = safeStr(input.ref, 64)
  const checkoutId = safeStr(input.checkoutId, 64)
  const txType = safeStr(input.txType, 20)
  const status = safeStr(input.status, 24)
  const method = safeStr(input.method, 20)
  const platform = safeStr(input.platform, 20)
  const appVersion = safeStr(input.appVersion, 20)
  const uid = safeStr(id.uid, 64)
  const userId = safeStr(id.userId, 64)
  const username = safeStr(id.username, 64)
  const role = safeStr(id.role, 32)
  const agencyId = safeStr(id.agencyId, 64)
  const amount = typeof input.amount === 'number' && Number.isFinite(input.amount)
    ? Math.round(input.amount * 100) / 100
    : undefined
  const data = sanitizeData(input.data)
  const record: TxEventRecord = {
    ts: new Date().toISOString(),
    level: input.level || 'info',
    tag: 'tx',
    channel: 'transactions',
    origin: input.origin === 'client' ? 'client' : 'server',
    stage,
    message,
    ...(txType ? { txType } : {}),
    ...(ref ? { ref } : {}),
    ...(checkoutId ? { checkoutId } : {}),
    ...(status ? { status } : {}),
    ...(amount !== undefined ? { amount } : {}),
    ...(method ? { method } : {}),
    ...(uid ? { uid } : {}),
    ...(userId ? { userId } : {}),
    ...(username ? { username } : {}),
    ...(role ? { role } : {}),
    ...(agencyId ? { agencyId } : {}),
    ...(platform ? { platform } : {}),
    ...(appVersion ? { appVersion } : {}),
    ...(data ? { data } : {}),
  }
  return record
}

/** Keep a day file under the byte cap: trim the oldest half when oversized. */
function trimDayFile(file: string): void {
  try {
    const st = fs.statSync(file)
    if (st.size <= DAY_FILE_TRIM_BYTES) return
    const raw = fs.readFileSync(file, 'utf8').split('\n')
    fs.writeFileSync(file, raw.slice(Math.floor(raw.length / 2)).join('\n'), 'utf8')
  } catch { /* best-effort housekeeping */ }
}

/**
 * Server-side write. NEVER throws — payment settlement must never break
 * because its log line could not be appended.
 */
export function appendTxEvent(input: TxEventInput): void {
  try {
    const record = buildTxRecord(input)
    let line = JSON.stringify(record)
    if (line.length > MAX_LINE_CHARS) line = line.slice(0, MAX_LINE_CHARS) // hard ceiling
    const file = txDayFile()
    fs.mkdirSync(txLogRoot(), { recursive: true })
    fs.appendFileSync(file, line + '\n', { encoding: 'utf8' })
    trimDayFile(file)
  } catch (err) {
    console.warn('[tx-log] append failed:', err)
  }
}

// ─── Reading (Logs Manager "Transactions" tab + unified export) ─────────────

export interface TxFilters {
  q?: string
  stage?: string
  txType?: string
  status?: string
  uid?: string
  agencyId?: string
  origin?: string
  ref?: string
  checkoutId?: string
  from?: string // YYYY-MM-DD inclusive
  to?: string   // YYYY-MM-DD inclusive
  limit?: number
}

export interface TxReadResult {
  entries: TxEventRecord[]
  scanned: number
  files: number
  truncated: boolean
}

const TX_SCAN_TOTAL_BYTES = 64 * 1024 * 1024
const TX_LIMIT_MAX = 5_000

function matchFilters(r: TxEventRecord, f: TxFilters): boolean {
  if (f.stage && r.stage !== f.stage) return false
  if (f.txType && r.txType !== f.txType) return false
  if (f.status && r.status !== f.status) return false
  if (f.origin && r.origin !== f.origin) return false
  if (f.uid && !(r.uid ?? '').toLowerCase().includes(f.uid.toLowerCase())) return false
  if (f.agencyId && r.agencyId !== f.agencyId) return false
  if (f.ref && r.ref !== f.ref) return false
  if (f.checkoutId && r.checkoutId !== f.checkoutId) return false
  if (f.q) {
    const hay = `${r.message} ${r.stage} ${r.ref ?? ''} ${r.checkoutId ?? ''} ${r.uid ?? ''} ${r.username ?? ''} ${r.agencyId ?? ''} ${r.txType ?? ''} ${r.status ?? ''}`.toLowerCase()
    if (!hay.includes(f.q.toLowerCase())) return false
  }
  return true
}

/**
 * Read the transaction stream, NEWEST first. Day files are walked backwards
 * (today → oldest) and lines within a file backwards, so the admin sees the
 * live funnel tail immediately. Bounded by the byte budget + row limit.
 */
export function readTxEntries(f: TxFilters): TxReadResult {
  const out: TxEventRecord[] = []
  let scanned = 0
  let filesSeen = 0
  let totalBytes = 0
  let truncated = false
  const limit = Math.max(1, Math.min(f.limit ?? 500, TX_LIMIT_MAX))

  let names: string[] = []
  try {
    names = fs.readdirSync(txLogRoot()).filter((n) => /^\d{4}-\d{2}-\d{2}\.ndjson$/.test(n)).sort()
  } catch {
    return { entries: out, scanned, files: 0, truncated }
  }
  if (f.from) names = names.filter((n) => n.slice(0, 10) >= f.from!)
  if (f.to) names = names.filter((n) => n.slice(0, 10) <= f.to!)

  outer:
  for (let i = names.length - 1; i >= 0; i--) {
    const name = names[i]
    const full = path.join(txLogRoot(), name)
    filesSeen++
    let bytes = 0
    try { bytes = fs.statSync(full).size } catch { continue }
    if (totalBytes + bytes > TX_SCAN_TOTAL_BYTES) { truncated = true; break }
    totalBytes += bytes
    let content = ''
    try { content = fs.readFileSync(full, 'utf8') } catch { continue }
    const lines = content.split('\n').filter((l) => l.trim())
    for (let j = lines.length - 1; j >= 0; j--) {
      scanned++
      let obj: TxEventRecord
      try { obj = JSON.parse(lines[j]) as TxEventRecord } catch { continue }
      if (!obj || typeof obj !== 'object' || !obj.ts) continue
      if (!matchFilters(obj, f)) continue
      out.push(obj)
      if (out.length >= limit) { truncated = true; break outer }
    }
  }
  return { entries: out, scanned, files: filesSeen, truncated }
}

// ─── Aggregation (KPI tiles + per-transaction funnels) ──────────────────────

export interface TxSummary {
  total: number
  last24h: number
  byStage: Record<string, number>
  byType: Record<string, number>
  /** Outcome counters — the money view. */
  paid: number
  failed: number
  pendingRefs: number
  funnels: Array<{
    ref: string | null
    checkoutId: string | null
    txType: string | null
    amount: number | null
    uid: string | null
    agencyId: string | null
    firstTs: string
    lastTs: string
    stages: string[]
    finalStatus: string | null
    eventCount: number
  }>
}

const OUTCOME_PAID_STAGES = new Set(['settle_paid', 'manual_approved'])
const OUTCOME_FAILED_STAGES = new Set(['settle_failed', 'manual_rejected', 'checkout_failed', 'webhook_rejected'])

/**
 * Build KPI counts + per-transaction funnels from a NEWEST-first entry list.
 * The funnels cap keeps the payload sane (the newest 300 transactions).
 */
export function summarizeTxEntries(entries: TxEventRecord[], maxFunnels = 300): TxSummary {
  const byStage: Record<string, number> = {}
  const byType: Record<string, number> = {}
  let last24h = 0
  let paid = 0
  let failed = 0
  const dayAgo = Date.now() - 24 * 3_600_000

  const funnelMap = new Map<string, {
    ref: string | null
    checkoutId: string | null
    txType: string | null
    amount: number | null
    uid: string | null
    agencyId: string | null
    firstTs: string
    lastTs: string
    stages: string[]
    finalStatus: string | null
    eventCount: number
  }>()

  for (const e of entries) { // newest-first input
    byStage[e.stage] = (byStage[e.stage] ?? 0) + 1
    const ty = e.txType || 'unknown'
    byType[ty] = (byType[ty] ?? 0) + 1
    const ts = Date.parse(e.ts)
    if (Number.isFinite(ts) && ts >= dayAgo) last24h++
    if (OUTCOME_PAID_STAGES.has(e.stage)) paid++
    if (OUTCOME_FAILED_STAGES.has(e.stage)) failed++

    const key = e.ref || e.checkoutId || `anon:${Math.abs(hashStr(e.ts + e.message))}`
    // Outcome-aware final status — the stage taxonomy decides PAID/FAILED,
    // otherwise the row status rides through (PENDING/APPROVED/REJECTED…).
    const outcome = OUTCOME_PAID_STAGES.has(e.stage)
      ? 'PAID'
      : OUTCOME_FAILED_STAGES.has(e.stage)
        ? 'FAILED'
        : (e.status ?? null)
    let fun = funnelMap.get(key)
    if (!fun) {
      fun = {
        ref: e.ref ?? null,
        checkoutId: e.checkoutId ?? null,
        txType: e.txType ?? null,
        amount: e.amount ?? null,
        uid: e.uid ?? null,
        agencyId: e.agencyId ?? null,
        firstTs: e.ts,
        lastTs: e.ts,
        stages: [e.stage],
        finalStatus: outcome,
        eventCount: 1,
      }
      funnelMap.set(key, fun)
    } else {
      fun.eventCount++
      if (e.ts < fun.firstTs) fun.firstTs = e.ts
      if (e.ts > fun.lastTs) fun.lastTs = e.ts
      if (!fun.txType && e.txType) fun.txType = e.txType
      if (fun.amount === null && e.amount !== undefined) fun.amount = e.amount
      if (!fun.uid && e.uid) fun.uid = e.uid
      if (!fun.agencyId && e.agencyId) fun.agencyId = e.agencyId
      if (!fun.checkoutId && e.checkoutId) fun.checkoutId = e.checkoutId
      if (!fun.stages.includes(e.stage)) fun.stages.unshift(e.stage) // newest-first stages
      if (outcome === 'PAID') fun.finalStatus = 'PAID'
      else if (outcome === 'FAILED') fun.finalStatus = fun.finalStatus === 'PAID' ? fun.finalStatus : 'FAILED'
      else if (!fun.finalStatus && outcome) fun.finalStatus = outcome
    }
  }

  const pendingRefs = [...funnelMap.values()].filter(
    (f) => f.finalStatus !== 'PAID' && f.finalStatus !== 'FAILED' && f.stages.some((s) => s.startsWith('checkout_') || s === 'manual_submit'),
  ).length

  return {
    total: entries.length,
    last24h,
    byStage,
    byType,
    paid,
    failed,
    pendingRefs,
    funnels: [...funnelMap.values()].slice(0, maxFunnels),
  }
}

function hashStr(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return h
}
