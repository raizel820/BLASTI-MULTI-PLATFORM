// pairing-offer-udp.js — DEVICE-TO-DEVICE pairing delivery over the LAN (0.6.106).
// ─────────────────────────────────────────────────────────────────────────────
// USER QUESTION (0.6.106 report): "does pairing go device to device through
// wifi/lan or cloud api server?" — audited answer: for a discovered kiosk
// TABLET the request rode the CLOUD relay exclusively, because the tablet
// ran no receiver a desktop could push to. 0.6.106 gives the phone/tablet a
// receiver: the Android plugin binds UDP :3082 while the pairing beacon runs
// and waits for a UNICAST datagram from the manager's desktop.
//
// This module is the desktop half: send ONE offer as a small burst of
// unicast datagrams to <ip>:3082 and wait for the plugin's ACK
// ({"type":"blasti-pairing-offer-ack","uid":…}). Delivery lands in
// milliseconds on the same Wi-Fi — no cloud round-trip, no 5s poll.
//
// Design constraints:
//   - Pure Node, CommonJS, zero deps (runs inside the Electron main process).
//   - BOUNDED: the whole attempt resolves within ~2.2s worst case (3 tries ×
//     400ms + 800ms ack grace) so it can run IN PARALLEL with the cloud
//     relay instead of serializing before it.
//   - Never throws: AP isolation, port blocks and dead hosts resolve false.

'use strict'

const dgram = require('dgram')

/** UDP port the BLASTI phone/tablet plugin listens on (BlastiNativeStatus). */
const PAIRING_OFFER_UDP_PORT = 3082

/**
 * Send a pairing offer to a device's LAN pairing listener.
 * @param {string} ip      - the discovered device's IPv4 (from its beacon)
 * @param {object} payload - the offer body (same fields as the HTTP
 *   pairing-offer POST body + type/commandId/managerIp/managerPort)
 * @param {object} [opts]  - { attempts=3, gapMs=400, ackGraceMs=800 }
 * @returns {Promise<boolean>} true when the device ACKed the offer
 */
function sendPairingOfferUdp(ip, payload, opts) {
  const attempts = (opts && Number.isFinite(opts.attempts) ? opts.attempts : 3)
  const gapMs = (opts && Number.isFinite(opts.gapMs) ? opts.gapMs : 400)
  const ackGraceMs = (opts && Number.isFinite(opts.ackGraceMs) ? opts.ackGraceMs : 800)
  return new Promise((resolve) => {
    if (!ip || typeof ip !== 'string' || !/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
      resolve(false)
      return
    }
    let settled = false
    let acked = false
    let sent = 0
    let sock = null
    let sendTimer = null
    let graceTimer = null
    const finish = (delivered) => {
      if (settled) return
      settled = true
      if (sendTimer) clearTimeout(sendTimer)
      if (graceTimer) clearTimeout(graceTimer)
      if (sock) { try { sock.close() } catch { /* already closed */ } }
      resolve(delivered === true)
    }
    try {
      const body = { type: 'blasti-pairing-offer', ...(payload && typeof payload === 'object' ? payload : {}) }
      const msg = Buffer.from(JSON.stringify(body), 'utf8')
      sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
      sock.on('message', (buf) => {
        try {
          const j = JSON.parse(buf.toString('utf8'))
          if (j && j.type === 'blasti-pairing-offer-ack') acked = true
        } catch { /* foreign noise on the port — ignore */ }
        if (acked) finish(true)
      })
      sock.on('error', () => { /* binding/sending failures resolve false below */ })
      sock.bind(() => {
        const sendOnce = () => {
          if (settled) return
          sent++
          try {
            sock.send(msg, PAIRING_OFFER_UDP_PORT, ip, () => { /* fire-and-forget */ })
          } catch { /* socket died mid-burst — the timers still bound the wait */ }
          if (sent >= attempts) {
            graceTimer = setTimeout(() => finish(acked), ackGraceMs)
          } else {
            sendTimer = setTimeout(sendOnce, gapMs)
          }
        }
        sendOnce()
      })
      // Hard ceiling: even a wedged socket resolves fast enough to race the
      // cloud relay in parallel (never serializes the manager's click).
      setTimeout(() => finish(acked), attempts * gapMs + ackGraceMs + 400).unref()
    } catch {
      finish(false)
    }
  })
}

module.exports = { sendPairingOfferUdp, PAIRING_OFFER_UDP_PORT }
