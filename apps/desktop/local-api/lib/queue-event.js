// queue-event.js — Desktop QUEUE EVENT STREAM producer (0.6.89)
// ─────────────────────────────────────────────────────────────────────────────
// One entry point for every LAN queue event on the desktop box:
//   • Ticket lifecycle — created (walk-in / online / kiosk), claimed, called,
//     completed, no-show, cancelled, postponed, recalled
//   • Queue control — paused / resumed
//   • Counter desk actions — occupied/released, claimed, control
//     requested/approved/rejected, assigned
//   • Sync engine — offline mutations queued, replayed, pulled, conflicts
//
// Design (mirrors the cloud one-pipeline model, cloned from device-event.js):
//   • queueEvent() ALWAYS mirrors the line into the local diag log
//     (<userData>/logs/local-api-diag.log) so the offline trail is intact.
//   • The line is queued in memory; local-api/index.js DRAINS the queue on
//     every forward tick and POSTs it to the cloud /api/logs ingest as a
//     batch tagged channel:'queue' + platform 'desktop' — the cloud mirrors
//     it into logs/_queue/<date>.ndjson that the Logs Manager "Queue" tab
//     reads. Entries survive offline periods (bounded queue + retry).
//
// CommonJS, no dependencies. local-api/index.js and sync-service.js require
// the SAME module instance (Node module cache) so all producers ride the
// same queue.

'use strict'

const MAX_QUEUE = 200
const queue = []
let diagRef = null

/** Attach the diag logger (called by local-api bootstrap + main.js). */
function setDiagLogger(fn) {
  diagRef = typeof fn === 'function' ? fn : null
}

function safeStr(v, max) {
  if (typeof v !== 'string' || !v) return undefined
  return v.replace(/[^A-Za-z0-9._:@ -]/g, '').slice(0, max) || undefined
}

/**
 * Emit ONE queue event. Never throws, never blocks.
 * @param {string} event   - event slug (ticket_created_walkin, ticket_claimed, counter_released, sync_pull_applied, ...)
 * @param {string} message - human-readable support-facing line
 * @param {object} [data]  - { agencyId, branchId, serviceId, serviceName, counterId, counterName, ticketId, ticketNumber, source, status, waitMs, serviceMs, sessionId, ...extras }
 * @param {string} [level] - info (default) | warn | error | debug
 */
function queueEvent(event, message, data, level) {
  try {
    const slug = safeStr(event, 40) || 'unknown'
    const entry = {
      ts: new Date().toISOString(),
      level: ['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info',
      tag: 'queue',
      message: String(message ?? '').slice(0, 400),
      channel: 'queue',
      data: { event: slug },
    }
    // Lift the canonical fields to the entry data — the cloud ingest mirror
    // reads exactly these keys (event/agencyId/branchId/serviceId/serviceName/
    // counterId/counterName/ticketId/ticketNumber/source/status/waitMs/
    // serviceMs/sessionId) and drops them from the extras blob.
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      let n = 0
      for (const [k, v] of Object.entries(data)) {
        if (n >= 20) break
        const key = String(k).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40)
        if (!key || v === undefined) continue
        if (typeof v === 'string') { entry.data[key] = v.slice(0, 300); n++ }
        else if (typeof v === 'number' && Number.isFinite(v)) { entry.data[key] = Math.round(v * 100) / 100; n++ }
        else if (typeof v === 'boolean') { entry.data[key] = v; n++ }
        else if (v === null) { entry.data[key] = null; n++ }
      }
    }
    queue.push(entry)
    if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE)
    // Local offline trail — same file support already tails in the vault.
    if (diagRef) diagRef('QUEUE-EVENT ' + slug + ': ' + entry.message)
    else console.log('[queue-event]', slug, entry.message)
  } catch { /* logging must never break the caller */ }
}

/** Return and clear the queued entries (local-api forward tick). */
function drainQueueEvents() {
  if (queue.length === 0) return []
  return queue.splice(0, queue.length)
}

/** Diagnostics: how many entries are waiting. */
function pendingQueueEvents() {
  return queue.length
}

module.exports = { queueEvent, drainQueueEvents, pendingQueueEvents, setDiagLogger }
