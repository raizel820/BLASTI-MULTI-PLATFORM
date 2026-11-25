// lan-ports.js — THE CANONICAL BLASTI LAN PORT + PROTOCOL REGISTRY (0.6.122).
//
// User mandate: "audit the port and services that transfer the reservation
// receipt to the blast desktop app then print it. pre-set this services
// ports and channels and communication protocols". Every port, channel and
// wire protocol of the reservation-receipt pipeline is declared HERE — one
// source of truth — and every sender/listener imports these constants
// instead of scattering literals. A port change is a one-line edit here,
// and the channel maps below document exactly which side opens (listens)
// and which side dials, in what protocol, in what order.
//
// CANONICAL CROSS-APP MIRROR: packages/core/src/lan-protocol.ts (@blasti/
// core/lan-protocol) re-exports the SAME numbers for the TypeScript apps
// (cloud API). Keep both files value-identical — the desktop cannot import
// TS (plain-Node Electron runtime) and the cloud cannot import this file
// (packaging boundary), so the parity contract is by review. The audit
// table in packages/core/src/lan-protocol.ts is the wire truth.
//
// ─── PORT MAP (all ports are FIXED, never ephemeral) ────────────────────────
//
//  ┌─────────────────────┬──────┬─────────┬───────────────────────────────────┐
//  │ Channel             │ Port │ Proto   │ Who listens / who dials            │
//  ├─────────────────────┼──────┼─────────┼───────────────────────────────────┤
//  │ HTTP_API            │ 3080 │ TCP     │ every PC (desktop local API)      │
//  │                     │      │         │ discovery HTTP probes, pairing    │
//  │                     │      │         │ offers (LAN leg), device commands │
//  │                     │      │         │ + status polls, print relay       │
//  │                     │      │         │ (compat path), /api/discover      │
//  ├─────────────────────┼──────┼─────────┼───────────────────────────────────┤
//  │ UDP_BEACON          │ 3081 │ UDP     │ every node LISTENS; every node    │
//  │                     │      │         │ broadcasts its identity every 3s  │
//  │                     │      │         │ (discovery + master election)     │
//  ├─────────────────────┼──────┼─────────┼───────────────────────────────────┤
//  │ UDP_PAIRING         │ 3082 │ UDP     │ PC in pairing standby (desktop    │
//  │                     │      │         │ receiver) + Android plugin while  │
//  │                     │      │         │ its beacon runs; the MANAGER      │
//  │                     │      │         │ dials unicast offers + reads ACKs │
//  ├─────────────────────┼──────┼─────────┼───────────────────────────────────┤
//  │ PRINT_RELAY         │ 3083 │ TCP     │ MASTER/host PCs run the dedicated │
//  │                     │      │         │ print-relay listener (0.6.118);   │
//  │                     │      │         │ kiosks/staff PCs dial print jobs  │
//  │                     │      │         │ with the ticket payload           │
//  ├─────────────────────┼──────┼─────────┼───────────────────────────────────┤
//  │ VOICE_TTS           │ 3084 │ TCP     │ MASTER/host PCs run the dedicated │
//  │                     │      │         │ offline voice-calling service     │
//  │                     │      │         │ (0.6.121, espeak-ng WASM); TV     │
//  │                     │      │         │ boards dial /speak for queue-call │
//  │                     │      │         │ announcements (ar / fr / en WAV)  │
//  ├─────────────────────┼──────┼─────────┼───────────────────────────────────┤
//  │ PRINTER_JETDIRECT   │ 9100 │ TCP     │ network printers LISTEN; the      │
//  │                     │      │         │ desktop print route dials raw     │
//  │                     │      │         │ ESC/POS bytes (HP JetDirect and   │
//  │                     │      │         │ every compatible thermal box)     │
//  ├─────────────────────┼──────┼─────────┼───────────────────────────────────┤
//  │ CUPS_IPP            │  631 │ TCP     │ OS print service (CUPS) queue —   │
//  │                     │      │         │ discovery probe only, printing    │
//  │                     │      │         │ goes through `lp`, never raw      │
//  └─────────────────────┴──────┴─────────┴───────────────────────────────────┘
//
// PC ↔ PC : beacons 3081, pairing 3082, commands/status/print 3080 (+3083 print).
// Kiosk → PC: beacons 3081 (announce), pairing 3082 (offers), commands +
//             status 3080, print jobs 3083 (dedicated) with 3080 fallback.
// TV → PC   : status 3080, voice announcements 3084 (dedicated offline TTS).
// PC → printer: raw ESC/POS 9100 (network), OS spooler (USB, no port).
//
// NOTE: changing HTTP_API requires BLASTI_LAN_BIND env coordination in
// lan-origin.js; every consumer here reads the registry so the change is
// intentional and visible in one diff.
//
// ─── RESERVATION-RECEIPT CHANNEL MAP (audited 0.6.122) ──────────────────────
//
// Stage A — a reservation/ticket is CREATED on:
//   A1. Kiosk, LAN pinned    → REST POST http://<master-ip>:3080
//                              /api/agency/queue/walk-in  (JSON, X-Device-Token)
//   A2. Kiosk, cloud fallback→ REST POST https://<cloud>:443 same route;
//                              arrival at the desktop via B2 below.
//   A3. Customer app (mobile/web shell) → REST POST https://<cloud>:443
//                              /api/queue/join  (JSON, Bearer session)
//   A4. Staff at the desktop → REST POST http://127.0.0.1:3080 (its own API).
//
// Stage B — the reservation ROW reaches the desktop app (display data):
//   B1. LAN direct           → :3080 REST (A1/A4 write locally, event fans out
//                              in-process) — INSTANT (sub-second).
//   B2. Cloud realtime relay → WSS :443 Socket.IO; cloud emits
//                              `reservation:created` / `queue:walk-in` into the
//                              agency room; sync-service's engine socket receives
//                              → relayCloudRealtime → local-realtime room
//                              `agency:<id>` → desktop UI socket. ~1-2s.
//   B3. Cloud pull fallback  → HTTPS :443 cursor-paged delta pull every 8s
//                              (±2s jitter); applied rows re-emit the same
//                              local events (_broadcastPullBusinessEvents).
//                              Worst case ≈ 10s, offline-safe.
//   B4. Cloud walk-in mirror → the `queue:walk-in` event upserts the row into
//                              the local DB BEFORE the relay fans out (0.6.104)
//                              so the UI refetch always finds data.
//
// Stage C — the RECEIPT (ticket payload) is printed:
//   C1. Desktop UI buttons   → Electron IPC printer:print-silent (NO port) or
//                              window.print() → OS spooler → USB printer.
//   C2. Kiosk → master       → REST POST http://<master>:3080
//                              /api/agency-devices/discovery/print
//                              (JSON ticket payload, X-Device-Token) →
//                              printer resolution on the master.
//   C3. USB printer HERE     → OS print service (CUPS `lp -o raw` / Electron
//                              silent print) — no LAN port involved.
//   C4. Network printer      → raw TCP :9100 (PRINTER_JETDIRECT), ESC/POS
//                              bytes incl. native QR (GS ( k), 6s timeout.
//   C5. USB printer on ANOTHER host PC → print-relay SENDER: POST
//                              http://<host>:3083/print-job (dedicated), fall
//                              back http://<host>:3080
//                              /api/agency-devices/host/print-job (compat),
//                              per-attempt 6s, serial queue on the host.
//   C6. Kiosk in CLOUD mode  → REST POST https://<cloud>:443
//                              /api/agency-devices/discovery/print → cloud
//                              relays `agency-device:print-job` over the
//                              agency socket room → the printer-host desktop
//                              prints in the background (0.6.105 handler).
//   C7. Cloud → host direct  → the cloud box ALSO dials the host PC directly
//                              when it believes the host is reachable: same
//                              C5 ladder (:3083 dedicated → :3080 compat).
//                              (Pre-0.6.122 it dialed compat :3080 only —
//                              fixed by the audit; see lan-protocol.ts.)
//   C8. Master → secondary   → same C5 ladder from the master's relay handler
//                              when the caller's selected printer lives on a
//                              different branch PC (host-forward, one hop).
//
// Wire protocol everywhere: HTTP/1.1 JSON bodies; auth via X-Device-Token or
// Authorization: Bearer (device token → LAN token `blan-…` → session token);
// realtime via Socket.IO events shaped { type?, agencyId, data, timestamp };
// raw printer bytes via TCP with a fixed send budget (RAW_PRINT_TIMEOUT_MS).
'use strict'

const BLASTI_LAN_PORTS = {
  /** TCP — the main local API: discovery probes, pairing offers (LAN HTTP
   *  leg), device commands + status, print relay compat path, reservation
   *  walk-in/join writes (channel A1/A4, B1). LISTEN: all PCs. */
  HTTP_API: 3080,
  /** UDP — discovery beacon: identity + role + peripherals, every 3s.
   *  LISTEN: all nodes. SEND: all nodes (broadcast). */
  UDP_BEACON: 3081,
  /** UDP — pairing offers + ACKs. LISTEN: pairing-standby PCs (desktop
   *  receiver) + Android plugin. SEND: the manager (unicast). */
  UDP_PAIRING: 3082,
  /** TCP — DEDICATED print-relay listener on master/host PCs (0.6.118):
   *  kiosk/staff print jobs with the full ticket payload. The sender always
   *  falls back to HTTP_API (compat route) when this port is not answered. */
  PRINT_RELAY: 3083,
  /** TCP — DEDICATED offline voice-calling service on master/host PCs
   *  (0.6.121): TV boards fetch queue-call announcement audio (WAV) from
   *  here — espeak-ng WASM engine bundled in the desktop app, ar/fr/en,
   *  zero internet. When unanswered the TV falls back to speechSynthesis. */
  VOICE_TTS: 3084,
  /** TCP — raw ESC/POS JetDirect port of NETWORK printers (registry preset,
   *  0.6.122 audit): the print route dials it with a fixed byte budget.
   *  USB printers do NOT use this port — they ride the OS spooler. */
  PRINTER_JETDIRECT: 9100,
  /** TCP — CUPS/IPP listener on the local machine; discovery-classification
   *  probe only. Printing NEVER dials it (os-print.js uses `lp`). */
  CUPS_IPP: 631,
}

/** Ports a print-job SENDER tries, in order, against a master/host PC:
 * the dedicated print-relay listener first (:3083), then the main API's
 * compat route (:3080). Callers pass the matching path per port via
 * printRelayRequestPath(). */
function printRelayTargetPorts() {
  return [BLASTI_LAN_PORTS.PRINT_RELAY, BLASTI_LAN_PORTS.HTTP_API]
}

/** Request path for a print job on the given target port. */
function printRelayRequestPath(port) {
  return Number(port) === BLASTI_LAN_PORTS.PRINT_RELAY
    ? '/print-job'
    : '/api/agency-devices/host/print-job'
}

/** Default raw-print (JetDirect) port for a printer row without an explicit
 * one — registry-preset so no caller hardcodes 9100. */
function printerRawPort(row, cfg) {
  const r = row || {}
  const c = cfg || {}
  const n = Number(r.port) > 0 ? Number(r.port) : (Number(c.port) > 0 ? Number(c.port) : 0)
  return n > 0 ? n : BLASTI_LAN_PORTS.PRINTER_JETDIRECT
}

/**
 * TCP probe ports the DISCOVERY scanner sweeps, in priority order — the
 * preset classification ladder (BLASTI nodes first, then printers, then
 * generic infra). Extracted from the scanner's literals so the sweep and
 * the classification agree by construction.
 */
const DISCOVERY_PROBE_PORTS = [
  BLASTI_LAN_PORTS.HTTP_API,       // 3080 — a BLASTI PC/kiosk local API
  3003,                            // self-hosted BLASTI API (non-desktop host)
  3000,                            // dev web shell
  BLASTI_LAN_PORTS.PRINTER_JETDIRECT, // 9100 — raw print / HP JetDirect
  BLASTI_LAN_PORTS.CUPS_IPP,       // 631 — CUPS/IPP queue
  80, 443, 8001, 8060, 445, 3389,  // generic infra / vendor boxes
]

/** Ports that identify a BLASTI API/PC when answered (classifier input). */
const BLASTI_API_PORTS = [BLASTI_LAN_PORTS.HTTP_API, 3003, 3000]

/** Ports that identify a raw printer when open (classifier input). */
const PRINTER_PORTS = [BLASTI_LAN_PORTS.PRINTER_JETDIRECT]

// ─── Preset wire budgets (communication-protocol timeouts) ──────────────────

const PROTOCOL_TIMEOUTS = {
  /** Raw ESC/POS socket send budget (ms) — C4. */
  RAW_PRINT_TIMEOUT_MS: 6000,
  /** Per-attempt budget of a print-relay sender POST (ms) — C5/C7/C8. */
  PRINT_RELAY_ATTEMPT_TIMEOUT_MS: 6000,
  /** Default rounds a print-relay sender tries the port ladder (C5). */
  PRINT_RELAY_ROUNDS: 1,
  /** Pause between print-relay rounds (ms). */
  PRINT_RELAY_ROUND_PAUSE_MS: 600,
  /** Serial-queue retry pause after a transient spooler failure (ms). */
  PRINT_QUEUE_RETRY_PAUSE_MS: 1200,
  /** Hard cap for one print job through the serial queue (ms). */
  PRINT_QUEUE_JOB_CAP_MS: 30000,
  /** Beacon broadcast cadence (ms) — 3081 channel. */
  BEACON_INTERVAL_MS: 3000,
  /** Beacon freshness TTL (ms) — older beacons are dead. */
  BEACON_TTL_MS: 15000,
  /** Incremental cloud pull cycle (ms) — channel B3. */
  SYNC_PULL_INTERVAL_MS: 8000,
}

module.exports = {
  BLASTI_LAN_PORTS,
  DISCOVERY_PROBE_PORTS,
  BLASTI_API_PORTS,
  PRINTER_PORTS,
  PROTOCOL_TIMEOUTS,
  printRelayTargetPorts,
  printRelayRequestPath,
  printerRawPort,
}
