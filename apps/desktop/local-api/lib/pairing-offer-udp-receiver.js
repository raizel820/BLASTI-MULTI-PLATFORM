// pairing-offer-udp-receiver.js — PC-side half of DEVICE-TO-DEVICE pairing
// delivery (0.6.117).
//
// WHY THIS EXISTS: sendPairingOfferUdp() unicasts pairing offers to
// <ip>:3082, but until now ONLY the Android plugin bound that port (while its
// pairing beacon ran). A PC running the BLASTI desktop app never listened, so
// the manager's UDP offer leg could never ACK for a PC target — and when the
// LAN HTTP leg raced it (or the card's port was stale) the pairing request
// silently never reached the other PC ("pairing request does not reach other
// pc devices").
//
// This receiver binds UDP :3082 on every desktop, ACKs the manager's offer
// datagram immediately (the same ack contract as the Android plugin:
// { type: 'blasti-pairing-offer-ack' }), and FORWARDS the offer into THIS
// machine's own HTTP route /api/agency-devices/public/pairing-offer — which
// already owns the whole receive side: orphan match/create, PAIRING_REQUEST
// command, socket broadcast and the native Accept/Reject dialog
// (ctx.onPairingOffer). Forwarding instead of re-implementing keeps ONE
// receive pipeline (and the route's per-IP rate limit + dedupe).
//
// Idempotency: the manager bursts up to 3 UDP datagrams per offer AND races
// the LAN HTTP leg — the receiver dedupes by (commandId | fingerprint) +
// agencyId within a short window, and the HTTP route dedupes PENDING
// PAIRING_REQUEST commands server-side, so the operator sees exactly ONE
// Accept/Reject dialog.

const dgram = require('dgram')

// 0.6.118 — the pairing offer port now comes from the canonical LAN port
// registry (lib/lan-ports.js).
const { BLASTI_LAN_PORTS } = require('./lan-ports')

const PAIRING_OFFER_UDP_PORT = BLASTI_LAN_PORTS.UDP_PAIRING // keep in sync with pairing-offer-udp.js
const DEDUPE_WINDOW_MS = 15_000
const DEDUPE_MAX_KEYS = 512

function startPairingOfferUdpReceiver(opts) {
  const httpPort = Number(opts && opts.port) > 0 ? Number(opts.port) : 3080
  // 0.6.117 — the API may be bound to an explicit interface IP (BLASTI_LAN_BIND=<ip>),
  // where loopback is NOT listening. The caller passes the resolved local origin;
  // default to loopback for the 127.0.0.1 / 0.0.0.0 binds.
  const origin = (opts && typeof opts.origin === 'string' && opts.origin.replace(/\/+$/, ''))
    || `http://127.0.0.1:${httpPort}`
  const log = opts && typeof opts.log === 'function' ? opts.log : () => {}
  const seen = new Map()
  let sock = null

  const pruneSeen = (now) => {
    if (seen.size <= DEDUPE_MAX_KEYS) return
    for (const [k, t] of seen) {
      if (now - t > DEDUPE_WINDOW_MS) seen.delete(k)
    }
  }

  try {
    sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })

    sock.on('error', (err) => {
      // EADDRINUSE (an Android emulator / plugin on this same host already
      // owns :3082) or a bind failure — pairing over LAN HTTP still works;
      // log and leave the socket closed.
      log('pairing-offer UDP receiver stopped (non-fatal): ' + (err && err.message))
      try { sock.close() } catch { /* already closed */ }
      sock = null
    })

    sock.on('message', (buf, rinfo) => {
      let offer = null
      try { offer = JSON.parse(buf.toString('utf8')) } catch { return }
      if (!offer || offer.type !== 'blasti-pairing-offer') return // foreign noise

      // ACK FIRST — the manager resolves "delivered" on this datagram; the
      // forwarding is best-effort behind it (the HTTP route + 5s device
      // poll + socket room are the durable surfaces).
      try {
        const ack = Buffer.from(JSON.stringify({
          type: 'blasti-pairing-offer-ack',
          ok: true,
          commandId: offer.commandId || undefined,
        }), 'utf8')
        sock.send(ack, rinfo.port, rinfo.address, () => {})
      } catch { /* ack is best-effort */ }

      // ── Dedupe the manager's 3-attempt burst + the parallel LAN HTTP leg ──
      const key = String(offer.commandId || offer.fingerprint || '') + '|' + String(offer.agencyId || '')
      const now = Date.now()
      const last = seen.get(key) || 0
      if (now - last < DEDUPE_WINDOW_MS) return // already forwarded — ACK only
      seen.set(key, now)
      pruneSeen(now)

      // Forward the offer body (minus the transport `type` envelope) into
      // THIS machine's own public pairing-offer route over loopback. That
      // route performs the orphan match/create, lands the PAIRING_REQUEST in
      // the store this PC polls, broadcasts into the pre-pairing socket room
      // and pops the native Accept/Reject dialog.
      const forwardBody = { ...offer, type: undefined }
      fetch(`${origin}/api/agency-devices/public/pairing-offer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(forwardBody),
      })
        .then((res) => res.json().catch(() => null))
        .then((data) => {
          if (!data || data.success !== true) {
            log('pairing-offer UDP forward rejected: ' + ((data && data.error) || `http ${data && data.status ? data.status : 'error'}`))
          }
        })
        .catch((err) => {
          log('pairing-offer UDP forward failed (non-fatal): ' + (err && err.message))
        })
    })

    sock.bind(PAIRING_OFFER_UDP_PORT, () => {
      log(`pairing-offer UDP receiver listening on :${PAIRING_OFFER_UDP_PORT} (device-to-device pairing for PCs)`)
    })
  } catch (err) {
    log('pairing-offer UDP receiver unavailable (non-fatal): ' + (err && err.message))
    sock = null
  }

  return {
    stop: () => {
      if (!sock) return
      try { sock.close() } catch { /* already closed */ }
      sock = null
    },
  }
}

module.exports = { startPairingOfferUdpReceiver, PAIRING_OFFER_UDP_PORT }
