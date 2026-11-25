// print-relay-handler.js — MASTER/HOST-PC SIDE of the dedicated print service
// (0.6.118).
//
// User mandate: "the kiosk sends a printer request with the related ticket
// information to the master PC, which triggers the printing using the
// connected and selected printer (a dedicated service that sends the ticket
// information and another dedicated service that handles the information and
// prints the ticket)". This module IS the second dedicated service: it
// receives ticket payloads (from kiosks or staff PCs) and prints them on the
// printer CONNECTED to this machine and SELECTED for the job.
//
// Two entry points share ONE serial pipeline:
//   • the dedicated print-relay LISTENER on the predetermined port :3083
//     (startPrintRelayListener — its own HTTP server, nothing else lives
//     there), and
//   • the compat route POST /api/agency-devices/host/print-job on :3080
//     (device-board-routes.js now delegates to enqueuePrintJob).
//
// Serial queue rationale: thermal receipt printers are single-job devices —
// two interleaved jobs garble ESC/POS streams and mix receipts. enqueuePrintJob
// therefore processes ONE job at a time (FIFO), retries a failed job once
// (transient spooler hiccups), and reports every outcome through the device
// event stream + a bounded job ledger the UI/logs can inspect.

'use strict'

const osPrint = require('./os-print')
const deviceEvents = require('./device-event')
const { BLASTI_LAN_PORTS } = require('./lan-ports')

// ─── Runtime context (wired once by index.js) ───────────────────────────────

const ctxRefs = {
  getLanIp: () => null,
  log: null,
}

/**
 * Wire runtime references: getLanIp (this machine's LAN IP — decides whether
 * a selected USB printer is attached HERE or on another host PC) and the
 * diag log. Called once at local-API boot.
 */
function initPrintRelayHandler(opts) {
  if (opts && typeof opts.getLanIp === 'function') ctxRefs.getLanIp = opts.getLanIp
  if (opts && typeof opts.log === 'function') ctxRefs.log = opts.log
}

// ─── Serial job queue state ─────────────────────────────────────────────────

const queue = []          // pending jobs (FIFO)
let draining = false
const ledger = []         // last N finished jobs (newest last)
const LEDGER_MAX = 50
let jobIdSeq = 0

function logify(log, msg) {
  try { (typeof log === 'function' ? log : (m) => console.log('[PRINT-RELAY] ' + m))(msg) } catch { /* never fatal */ }
}

function pushLedger(entry) {
  ledger.push(entry)
  if (ledger.length > LEDGER_MAX) ledger.shift()
}

function emitEventSafe(name, detail, fields) {
  try { deviceEvents.deviceEvent(name, detail, fields) } catch { /* log only */ }
}

/** Print one job RIGHT NOW through the OS print stack (raw ESC/POS when the
 *  caller supplied the buffer + CUPS queue, otherwise the 80mm HTML receipt
 *  rendered silently to the SELECTED printer). */
async function executePrintJob(job) {
  const printerName = (job.printerName || job.cupsName || '').trim()
  const result = await osPrint.printLocalTicket({
    printerName: printerName || undefined,
    cupsName: printerName || undefined,
    ticket: job.ticket || {},
    escposBase64: job.escposBase64 || undefined,
  })
  return result
}

/**
 * Enqueue a print job on this machine's connected printer. Resolves with the
 * FINAL print outcome (so both HTTP entry points can answer the sender with
 * the real result):
 *   { ok: true,  via, printerName, jobId }
 *   { ok: false, error, printerName, jobId }
 * The promise is bounded by the queue drain — one receipt typically prints in
 * 1-3s; the callers cap their wait.
 */
function enqueuePrintJob(job, opts) {
  const log = opts && typeof opts.log === 'function' ? opts.log : null
  jobIdSeq += 1
  const id = job.jobId || `prj-${Date.now()}-${jobIdSeq}`
  return new Promise((resolve) => {
    queue.push({ ...job, jobId: id, resolve, enqueuedAt: Date.now() })
    logify(log, `print job queued: ${id} (${queue.length} pending) printer=${(job.printerName || job.cupsName || 'system default')}`)
    drain(opts)
  })
}

async function drain(opts) {
  if (draining) return
  draining = true
  try {
    while (queue.length > 0) {
      const job = queue.shift()
      const startedAt = Date.now()
      let result = null
      // Two attempts: a transient spooler/USB hiccup gets one free retry.
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          result = await executePrintJob(job)
        } catch (err) {
          result = { ok: false, error: (err && err.message) || 'print crashed' }
        }
        if (result && result.ok) break
        if (attempt < 2) await new Promise((r) => setTimeout(r, 1200))
      }
      const waitedMs = startedAt - job.enqueuedAt
      const printerName = (job.printerName || job.cupsName || 'system default').trim()
      if (result && result.ok) {
        emitEventSafe('print_job_done',
          `Relay print job ${job.jobId} done on ${printerName} (source ${job.source || 'lan'})`,
          { deviceType: 'PRINTER', status: 'OK', source: 'print-relay', deviceName: printerName, sessionId: job.jobId })
        logify(opts && opts.log, `print job ${job.jobId} DONE via ${result.via || 'os-print'} in ${Date.now() - startedAt}ms (queued ${waitedMs}ms)`)
      } else {
        emitEventSafe('print_job_failed',
          `Relay print job ${job.jobId} FAILED on ${printerName}: ${(result && result.error) || 'unknown'}`,
          { deviceType: 'PRINTER', status: 'FAILED', source: 'print-relay', deviceName: printerName, sessionId: job.jobId })
        logify(opts && opts.log, `print job ${job.jobId} FAILED: ${(result && result.error) || 'unknown'}`)
      }
      pushLedger({
        jobId: job.jobId,
        ok: !!(result && result.ok),
        via: (result && result.via) || undefined,
        error: (result && result.error) || undefined,
        printerName,
        source: job.source || 'lan',
        ticketNumber: (job.ticket && job.ticket.ticketNumber) || undefined,
        waitedMs,
        finishedAt: new Date().toISOString(),
      })
      try { job.resolve(result || { ok: false, error: 'print produced no result' }) } catch { /* caller gone */ }
    }
  } finally {
    draining = false
  }
}

/** Queue depth + recent outcomes (for status surfaces / logs manager). */
function getPrintRelayStatus() {
  return { pending: queue.length, ledger: ledger.slice(-20) }
}

// ─── CALLER-SELECTED PRINTER resolution (the "selected printer" mandate) ────

/**
 * Resolve the CALLER's selected printer from THIS store — the printer pinned
 * on that device's row (printerConfig.defaultPrinterDeviceId — the "Default
 * printer" select on the device's card in the Device Manager) — and classify
 * it for THIS machine:
 *   { mode: 'os-print', cupsName }                        — attached HERE
 *   { mode: 'host-forward', hostIp, hostPort, cupsName,
 *     token }                                             — on ANOTHER host PC
 *   null — nothing selected / resolvable (caller prints system default)
 * This is what makes the MASTER print the kiosk's job on the CONNECTED and
 * SELECTED printer instead of an arbitrary system default.
 */
async function resolveCallerSelectedPrinter(db, deviceRow) {
  if (!db || !deviceRow) return null
  try {
    const cfg = typeof deviceRow.printerConfig === 'string'
      ? JSON.parse(deviceRow.printerConfig || '{}')
      : (deviceRow.printerConfig || {})
    const wantedId = cfg && typeof cfg.defaultPrinterDeviceId === 'string' ? cfg.defaultPrinterDeviceId : ''
    if (!wantedId) return null
    const printerRow = await db.agencyDevice.findUnique({ where: { id: wantedId } })
    if (!printerRow || printerRow.type !== 'PRINTER') return null
    const pCfg = typeof printerRow.printerConfig === 'string'
      ? JSON.parse(printerRow.printerConfig || '{}')
      : (printerRow.printerConfig || {})
    const cupsName = pCfg.cupsName || pCfg.osPrinterName || printerRow.name || null
    if (pCfg.attachment === 'USB' && pCfg.hostIp) {
      const myIp = ctxRefs.getLanIp && ctxRefs.getLanIp()
      const isHere = pCfg.hostIp === myIp || pCfg.hostIp === '127.0.0.1' || pCfg.hostIp === 'localhost'
      if (isHere) return { mode: 'os-print', cupsName }
      return {
        mode: 'host-forward',
        hostIp: pCfg.hostIp,
        hostPort: Number(pCfg.hostPort) > 0 ? Number(pCfg.hostPort) : BLASTI_LAN_PORTS.HTTP_API,
        cupsName,
        token: printerRow.deviceToken || '',
      }
    }
    return { mode: 'os-print', cupsName }
  } catch { return null }
}

/**
 * THE shared receive pipeline for BOTH entry points (dedicated :3083
 * listener + compat /host/print-job route). Resolves the caller's selected
 * printer when the job names none, prints locally through the serial queue
 * (or forwards once to the printer-host PC when the selected printer lives
 * there), and returns an HTTP-ready outcome:
 *   { ok, status?, payload: { success, via?, printer?, jobId?, error? } }
 */
async function handleRelayedPrintJob(spec) {
  const db = spec.db
  const deviceRow = spec.deviceRow || null
  const body = spec.body || {}
  const log = spec.log || ctxRefs.log
  const printerNameIn = typeof body.printerName === 'string' && body.printerName.trim() ? body.printerName.trim().slice(0, 120) : ''
  const cupsNameIn = typeof body.cupsName === 'string' && body.cupsName.trim() ? body.cupsName.trim().slice(0, 120) : printerNameIn
  const escposBase64 = typeof body.escposBase64 === 'string' ? body.escposBase64 : ''
  const ticket = body.ticket && typeof body.ticket === 'object' ? body.ticket : null
  if (!ticket && !escposBase64) {
    return { ok: false, status: 400, payload: { success: false, error: 'Nothing to print — provide ticket or escposBase64' } }
  }

  let printerName = printerNameIn
  let cupsName = cupsNameIn

  // No explicit printer named → the CALLER's selected printer decides.
  if (!printerName && deviceRow) {
    const sel = await resolveCallerSelectedPrinter(db, deviceRow)
    if (sel && sel.mode === 'os-print') {
      printerName = sel.cupsName || printerName
      cupsName = sel.cupsName || cupsName
    } else if (sel && sel.mode === 'host-forward') {
      // The selected printer is physically attached to ANOTHER branch PC —
      // trigger the print THERE (one hop, then that host's serial queue).
      const fwd = await require('./print-relay-sender').submitPrintJob({
        hostIp: sel.hostIp,
        token: sel.token || deviceRow.deviceToken || '',
        ticket,
        escposBase64,
        printerName: sel.cupsName || undefined,
        cupsName: sel.cupsName || undefined,
        source: 'master-secondary-forward',
        timeoutMs: 6000,
        log,
      })
      if (fwd.ok) return { ok: true, payload: { success: true, via: 'master-secondary-forward', host: fwd.host, jobId: fwd.jobId } }
      return { ok: false, status: 502, payload: { success: false, error: fwd.error || 'Printer host unreachable' } }
    }
  }

  const outcome = await Promise.race([
    enqueuePrintJob({
      printerName: printerName || cupsName,
      cupsName,
      ticket,
      escposBase64,
      source: typeof body.source === 'string' ? body.source.slice(0, 40) : (spec.source || 'lan'),
      jobId: (typeof body.jobId === 'string' && body.jobId && body.jobId.slice(0, 60)) || spec.jobId || undefined,
    }, { log }),
    new Promise((r) => setTimeout(() => r({ ok: false, error: 'print timed out (still queued — check the printer)' }), 30_000)),
  ])
  if (outcome && outcome.ok) {
    return { ok: true, payload: { success: true, via: outcome.via || 'os-print', printer: printerName || undefined, jobId: outcome.jobId } }
  }
  return { ok: false, status: 502, payload: { success: false, error: (outcome && outcome.error) || 'Print failed' } }
}

// ─── Dedicated listener on the predetermined port :3083 ────────────────────

/**
 * Start the dedicated print-relay HTTP listener (its own tiny server on
 * BLASTI_LAN_PORTS.PRINT_RELAY). Auth is delegated to verifyCaller(token)
 * which returns a device row (or truthy) for a valid device/LAN/session
 * token — the same ladder as the compat route. Returns { port, stop } or
 * null when the port cannot be bound (degrade gracefully — the compat route
 * on :3080 keeps print working).
 */
function startPrintRelayListener(opts) {
  const log = opts && typeof opts.log === 'function' ? opts.log : (m) => console.log('[PRINT-RELAY] ' + m)
  const verifyCaller = opts && typeof opts.verifyCaller === 'function' ? opts.verifyCaller : null
  const getDb = opts && typeof opts.getDb === 'function' ? opts.getDb : () => null
  const port = (opts && Number(opts.port) > 0) ? Number(opts.port) : BLASTI_LAN_PORTS.PRINT_RELAY

  const Hono = require('hono').Hono
  const { serve } = require('@hono/node-server')
  const app = new Hono()

  // Simple per-IP limiter (mirrors the pairing-offer convention).
  const hits = new Map()
  const LIMIT = 30
  const WINDOW_MS = 60_000

  app.post('/print-job', async (c) => {
    const clientIp = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || 'lan'
    const now = Date.now()
    const entry = hits.get(clientIp) || { count: 0, windowStart: now }
    if (now - entry.windowStart > WINDOW_MS) { entry.count = 0; entry.windowStart = now }
    entry.count += 1
    hits.set(clientIp, entry)
    if (entry.count > LIMIT) return c.json({ success: false, error: 'Too many print jobs — slow down' }, 429)

    const token = (c.req.header('Authorization') || '').replace(/^Bearer\s+/i, '')
      || c.req.header('X-Device-Token') || ''
    let caller = null
    if (verifyCaller) {
      try { caller = await verifyCaller(token) } catch { caller = null }
      if (!caller) return c.json({ success: false, error: 'Device or session token required' }, 401)
    }

    const body = await c.req.json().catch(() => ({}))
    // THE shared pipeline: selected-printer resolution + serial queue +
    // secondary forward. Same behavior as the compat route on :3080.
    const result = await handleRelayedPrintJob({
      db: getDb(),
      deviceRow: caller && typeof caller === 'object' ? caller.deviceRow : null,
      body,
      source: 'print-relay-listener',
      log,
    })
    return c.json(result.payload, result.status && result.status !== 200 ? result.status : 200)
  })

  app.get('/health', (c) => c.json({ success: true, service: 'print-relay', port, ...getPrintRelayStatus() }))

  let server = null
  try {
    server = serve({ fetch: app.fetch, port }, () => {
      log(`dedicated print-relay listener running on http://0.0.0.0:${port} (kiosk/master print jobs)`)
    })
    server.on('error', (err) => {
      log(`print-relay listener error (compat :3080 route keeps working): ${err && err.message}`)
      try { server.close() } catch { /* already down */ }
      server = null
    })
  } catch (err) {
    log(`print-relay listener unavailable (compat :3080 route keeps working): ${err && err.message}`)
    server = null
  }

  return {
    port,
    stop: () => { try { server && server.close() } catch { /* already down */ } server = null },
  }
}

module.exports = {
  initPrintRelayHandler,
  enqueuePrintJob,
  getPrintRelayStatus,
  resolveCallerSelectedPrinter,
  handleRelayedPrintJob,
  startPrintRelayListener,
}
