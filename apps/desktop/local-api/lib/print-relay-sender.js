// print-relay-sender.js — KIOSK/SOURCE-PC SIDE of the dedicated print service
// (0.6.118).
//
// User mandate: "the kiosk sends a printer request with the related ticket
// information to the master PC, which triggers the printing using the
// connected and selected printer (a dedicated service that SENDS the ticket
// information and another dedicated service that handles the information and
// prints the ticket)". This module IS the sender service: it packages the
// ticket payload and delivers it to the master/host PC over the LAN —
// device-to-device, no cloud — then reports the real print outcome.
//
// Predetermined transport (see lib/lan-ports.js — the canonical port map):
//   1. the master/host PC's DEDICATED print-relay listener on :3083 (POST
//      /print-job), then
//   2. the compat route on the main API :3080 (POST
//      /api/agency-devices/host/print-job).
// Two bounded rounds over both ports ride out a momentary Wi-Fi hiccup
// without ever blocking the kiosk UI for long.
//
// Also answers "WHERE is the master PC": resolveMasterPcAddress() reads the
// LAN-authority election (live MASTER peer beacon) with a live-beacon
// fallback — the kiosk never guesses addresses.

'use strict'

const { printRelayTargetPorts, printRelayRequestPath, BLASTI_LAN_PORTS } = require('./lan-ports')

// ─── Sent-job ledger (observability for the Logs Manager) ───────────────────

const sentLedger = []
const SENT_LEDGER_MAX = 50

function pushSentLedger(entry) {
  sentLedger.push(entry)
  if (sentLedger.length > SENT_LEDGER_MAX) sentLedger.shift()
}

/** Recent sender outcomes (newest last) for status surfaces. */
function getSentPrintJobs() {
  return sentLedger.slice(-20)
}

function attemptPost(url, body, headers, timeoutMs) {
  return new Promise((resolve) => {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ctl.signal,
    })
      .then(async (res) => {
        clearTimeout(timer)
        const data = await res.json().catch(() => null)
        resolve({ status: res.status, ok: res.ok, data })
      })
      .catch(() => {
        clearTimeout(timer)
        resolve({ status: 0, ok: false, data: null })
      })
  })
}

/**
 * Deliver a print job to a master/host PC. Returns:
 *   { ok: true,  via, host, port, jobId, attempts }
 *   { ok: false, error, host, attempts }
 */
async function submitPrintJob(opts) {
  const hostIp = opts && opts.hostIp
  const token = (opts && opts.token) || ''
  // Per-ATTEMPT budget: a reachable-but-closed port answers instantly
  // (ECONNREFUSED); a dropped/non-routable host is bounded by this abort.
  // One round over both ports keeps the kiosk button responsive (~12s worst
  // case when the master is fully unreachable, sub-second when healthy).
  const timeoutMs = (opts && Number(opts.timeoutMs) > 0) ? Number(opts.timeoutMs) : 6000
  const rounds = (opts && Number(opts.rounds) > 0) ? Number(opts.rounds) : 1
  const log = opts && typeof opts.log === 'function' ? opts.log : null
  const jobId = (opts && opts.jobId) || `pr-${Date.now()}-${Math.floor(Math.random() * 1e6)}`

  if (!hostIp || !/^(\d{1,3}\.){3}\d{1,3}$/.test(String(hostIp))) {
    return { ok: false, error: 'no master/host LAN address', host: hostIp || null, attempts: 0 }
  }

  const body = {
    printerName: (opts && opts.printerName) || undefined,
    cupsName: (opts && opts.cupsName) || undefined,
    ticket: (opts && opts.ticket) || undefined,
    escposBase64: (opts && opts.escposBase64) || undefined,
    jobId,
    source: (opts && opts.source) || 'kiosk',
  }
  const headers = token ? { Authorization: 'Bearer ' + token } : {}

  const ports = printRelayTargetPorts()
  let attempts = 0
  let lastError = 'all print-relay ports unreachable'
  for (let round = 1; round <= rounds; round++) {
    for (const port of ports) {
      attempts += 1
      const url = `http://${hostIp}:${port}${printRelayRequestPath(port)}`
      const res = await attemptPost(url, body, headers, timeoutMs)
      if (res.ok && res.data && res.data.success) {
        pushSentLedger({ jobId, host: `${hostIp}:${port}`, ok: true, via: res.data.via, ticketNumber: (opts && opts.ticket && opts.ticket.ticketNumber) || undefined, finishedAt: new Date().toISOString() })
        try { log && log(`print job ${jobId} delivered to ${hostIp}:${port} via ${res.data.via || 'print-relay'}`) } catch { /* log only */ }
        return { ok: true, via: res.data.via || 'print-relay', host: `${hostIp}:${port}`, port, jobId, attempts }
      }
      // A 4xx the master UNDERSTOOD means the listener is alive: auth/token
      // problems will not improve by hammering other ports — surface it.
      if (res.status === 401 || res.status === 400) {
        const err = (res.data && res.data.error) || `master rejected the job (${res.status})`
        pushSentLedger({ jobId, host: `${hostIp}:${port}`, ok: false, error: err, finishedAt: new Date().toISOString() })
        return { ok: false, error: err, host: `${hostIp}:${port}`, attempts }
      }
      lastError = (res.data && res.data.error) || `${hostIp}:${port} unreachable (status ${res.status || 'net'})`
    }
    if (round < rounds) await new Promise((r) => setTimeout(r, 600))
  }
  pushSentLedger({ jobId, host: `${hostIp}:*`, ok: false, error: lastError, finishedAt: new Date().toISOString() })
  return { ok: false, error: lastError, host: `${hostIp}:*`, attempts }
}

/**
 * Resolve the MASTER PC for this workspace from the LAN-authority election.
 * Priority: the elected live MASTER peer → the freshest live BLASTI beacon
 * that serves an HTTP port. Returns { ip, port, name, via } or null.
 */
function resolveMasterPcAddress() {
  try {
    const authority = require('./lan-authority')
    const master = typeof authority.activeMasterPeer === 'function' ? authority.activeMasterPeer() : null
    if (master && master.ip) {
      return { ip: master.ip, port: Number(master.port) > 0 ? master.port : BLASTI_LAN_PORTS.HTTP_API, name: master.name || null, via: 'elected-master' }
    }
    const beacons = typeof authority.getLiveBlastiBeacons === 'function' ? authority.getLiveBlastiBeacons() : []
    for (const b of beacons) {
      const ip = b.ip || b.lanIp
      const isDesktop = !b.deviceType || String(b.deviceType).toLowerCase() !== 'kiosk'
      if (ip && isDesktop) {
        return { ip, port: Number(b.httpPort) > 0 ? b.httpPort : BLASTI_LAN_PORTS.HTTP_API, name: b.name || null, via: 'live-beacon' }
      }
    }
  } catch { /* authority not booted — caller falls back to its own knowledge */ }
  return null
}

module.exports = {
  submitPrintJob,
  resolveMasterPcAddress,
  getSentPrintJobs,
}
