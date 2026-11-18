// device-event.js — Desktop DEVICE EVENT STREAM producer (0.6.88)
// ─────────────────────────────────────────────────────────────────────────────
// One entry point for every device/kiosk lifecycle event on the desktop box:
//   • device-manager SCANNING (multi-protocol LAN scan) — started/completed/
//     failed/stopped, devices found
//   • PAIRING + LINKING — pair, connect, disconnect, unpair, pairing-request,
//     kiosk-credentials
//   • KIOSK MODE — TV/kiosk window open/close
//
// Design (mirrors the cloud one-pipeline model):
//   • deviceEvent() ALWAYS mirrors the line into the local diag log
//     (<userData>/logs/local-api-diag.log) so the offline trail is intact.
//   • The line is queued in memory; local-api/index.js DRAINS the queue on
//     every forward tick and POSTs it to the cloud /api/logs ingest as a
//     batch tagged channel:'device' + platform 'desktop' — the cloud mirrors
//     it into the unified _devices stream that the Logs Manager "Devices"
//     tab reads. Entries survive offline periods (bounded queue + retry).
//
// CommonJS, no dependencies. main.js requires the SAME module instance
// (Node module cache) so kiosk-window events ride the same queue.

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
 * Emit ONE device event. Never throws, never blocks.
 * @param {string} event   - event slug (scan_started, pair_success, kiosk_enter, ...)
 * @param {string} message - human-readable support-facing line
 * @param {object} [data]  - { deviceId, deviceName, deviceType, sessionId, status, agencyId, ...extras }
 * @param {string} [level] - info (default) | warn | error | debug
 */
function deviceEvent(event, message, data, level) {
  try {
    const slug = safeStr(event, 40) || 'unknown'
    const entry = {
      ts: new Date().toISOString(),
      level: ['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info',
      tag: 'device',
      message: String(message ?? '').slice(0, 400),
      channel: 'device',
      data: { event: slug },
    }
    // Lift the canonical fields to the entry data — the cloud ingest mirror
    // reads exactly these keys (event/deviceId/deviceName/deviceType/
    // sessionId/status/agencyId) and drops them from the extras blob.
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
    if (diagRef) diagRef('DEVICE-EVENT ' + slug + ': ' + entry.message)
    else console.log('[device-event]', slug, entry.message)
  } catch { /* logging must never break the caller */ }
}

/** Return and clear the queued entries (local-api forward tick). */
function drainDeviceEvents() {
  if (queue.length === 0) return []
  return queue.splice(0, queue.length)
}

/** Diagnostics: how many entries are waiting. */
function pendingDeviceEvents() {
  return queue.length
}

module.exports = { deviceEvent, drainDeviceEvents, pendingDeviceEvents, setDiagLogger }
