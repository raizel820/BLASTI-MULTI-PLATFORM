/**
 * lan-protocol.ts — THE CANONICAL BLASTI LAN PROTOCOL REGISTRY (cross-app,
 * TypeScript side). 0.6.122 audit.
 *
 * User mandate: "audit the port and services that transfer the reservation
 * receipt to the blast desktop app then print it. pre-set this services
 * ports and channels and communication protocols".
 *
 * The desktop app owns its runtime copy at
 * apps/desktop/local-api/lib/lan-ports.js (plain JS — the Electron runtime
 * cannot import TS and this package must not leak into the packaged shell).
 * The TWO FILES ARE THE VALUE-IDENTICAL PAIR — keep them in lockstep; the
 * audit table below is the wire truth both sides implement.
 *
 * ─── RESERVATION-RECEIPT PIPELINE (audited end-to-end) ──────────────────────
 *
 * Stage A — reservation/ticket CREATED on:
 *   A1 kiosk LAN-pinned   → REST POST http://<master-ip>:3080
 *                           /api/agency/queue/walk-in (JSON, X-Device-Token)
 *   A2 kiosk cloud-mode   → REST POST https://<cloud>:443 same route
 *   A3 customer app       → REST POST https://<cloud>:443 /api/queue/join
 *   A4 staff desktop      → REST POST http://127.0.0.1:3080 (own API)
 *
 * Stage B — reservation ROW reaches the desktop:
 *   B1 LAN direct         → :3080 REST, event fans out in-process (instant)
 *   B2 cloud realtime     → WSS :443 Socket.IO agency room, events
 *                           `reservation:created` / `queue:walk-in` → relayed
 *                           locally by sync-service → local-realtime (~1-2s)
 *   B3 cloud pull         → HTTPS :443 cursor-paged delta pull every 8s
 *                           (±2s jitter) — rows re-emitted as local events
 *   B4 walk-in mirror     → `queue:walk-in` upserts the row BEFORE the relay
 *                           fans out (0.6.104) so the UI refetch finds data
 *
 * Stage C — the RECEIPT prints:
 *   C1 desktop UI         → Electron IPC printer:print-silent / window.print
 *                           → OS spooler (no LAN port)
 *   C2 kiosk → master     → REST POST http://<master>:3080
 *                           /api/agency-devices/discovery/print (JSON ticket)
 *   C3 USB here           → OS print service (CUPS lp -o raw / Electron)
 *   C4 network printer    → raw TCP :9100 ESC/POS (native GS ( k QR), 6s
 *   C5 → another host PC  → POST http://<host>:3083/print-job (dedicated)
 *                           then http://<host>:3080
 *                           /api/agency-devices/host/print-job (compat)
 *   C6 kiosk cloud-mode   → POST https://<cloud>:443 /discovery/print →
 *                           socket event `agency-device:print-job` → host
 *                           desktop prints in the background (0.6.105)
 *   C7 cloud → host direct→ same C5 ladder — PRE-0.6.122 THE CLOUD DIALED
 *                           COMPAT :3080 ONLY; the audit preset makes the
 *                           cloud dial the dedicated :3083 listener first
 *                           (matches the desktop sender's ladder).
 *   C8 master → secondary → same C5 ladder (host-forward, one hop)
 *
 * Wire protocol: HTTP/1.1 JSON; auth X-Device-Token | Bearer (device →
 * `blan-…` LAN token → session); Socket.IO payloads { agencyId, data,
 * timestamp }; raw printer bytes over TCP with RAW_PRINT_TIMEOUT_MS budget.
 */

/** TCP — every PC's desktop local API (discovery, pairing LAN leg, commands,
 *  print-relay compat path, walk-in/join writes). */
export const LAN_HTTP_API_PORT = 3080

/** UDP — discovery beacon: identity broadcast every BEACON_INTERVAL_MS. */
export const LAN_UDP_BEACON_PORT = 3081

/** UDP — pairing offers + ACKs (manager unicasts; standby nodes listen). */
export const LAN_UDP_PAIRING_PORT = 3082

/** TCP — DEDICATED print-relay listener on master/host PCs. */
export const LAN_PRINT_RELAY_PORT = 3083

/** TCP — DEDICATED offline voice-calling (TTS) service on master/host PCs. */
export const LAN_VOICE_TTS_PORT = 3084

/** TCP — raw ESC/POS JetDirect port of network printers. */
export const PRINTER_JETDIRECT_PORT = 9100

/** TCP — CUPS/IPP (discovery probe only; printing goes through `lp`). */
export const CUPS_IPP_PORT = 631

/** Dedicated print-relay endpoint path (port :3083). */
export const PRINT_RELAY_PATH = '/print-job'

/** Compat print-relay endpoint path (port :3080, main local API). */
export const PRINT_RELAY_COMPAT_PATH = '/api/agency-devices/host/print-job'

/** Port ladder a print-job sender dialled against a host PC, in order. */
export const PRINT_RELAY_TARGET_PORTS: readonly number[] = [
  LAN_PRINT_RELAY_PORT,
  LAN_HTTP_API_PORT,
]

/** Request path for a print job on a given ladder port. */
export function printRelayRequestPath(port: number): string {
  return Number(port) === LAN_PRINT_RELAY_PORT
    ? PRINT_RELAY_PATH
    : PRINT_RELAY_COMPAT_PATH
}

/** Per-attempt POST budget of a print-relay sender (ms). */
export const PRINT_RELAY_ATTEMPT_TIMEOUT_MS = 6000

/** Raw ESC/POS socket send budget (ms). */
export const RAW_PRINT_TIMEOUT_MS = 6000

/** Beacon cadence / freshness (ms). */
export const BEACON_INTERVAL_MS = 3000
export const BEACON_TTL_MS = 15000

/** Incremental cloud pull cycle (ms) — reservation-row channel B3. */
export const SYNC_PULL_INTERVAL_MS = 8000

/** Realtime event names of the reservation-receipt pipeline (wire contract
 *  shared by the cloud emitter and the desktop relay — do not rename). */
export const RESERVATION_REALTIME_EVENTS = {
  created: 'reservation:created',
  updated: 'reservation:updated',
  cancelled: 'reservation:cancelled',
  walkIn: 'queue:walk-in',
  printJob: 'agency-device:print-job',
} as const
