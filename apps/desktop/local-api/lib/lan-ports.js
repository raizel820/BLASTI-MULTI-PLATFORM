// lan-ports.js — THE CANONICAL BLASTI LAN PORT REGISTRY (0.6.118).
//
// User mandate: "predetermine the discovery, communication, listen ports for
// pc-pc and pc-kiosk". Every port the device stack listens on / talks to is
// declared HERE — one source of truth for PC↔PC and Kiosk→PC traffic — and
// every sender/listener imports these constants instead of scattering
// literals. A port change is a one-line edit here, and the roles matrix below
// documents exactly which side opens (listens) and which side dials.
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
//  └─────────────────────┴──────┴─────────┴───────────────────────────────────┘
//
// PC ↔ PC : beacons 3081, pairing 3082, commands/status/print 3080 (+3083 print).
// Kiosk → PC: beacons 3081 (announce), pairing 3082 (offers), commands +
//             status 3080, print jobs 3083 (dedicated) with 3080 fallback.
//
// NOTE: changing HTTP_API requires BLASTI_LAN_BIND env coordination in
// lan-origin.js; every consumer here reads the registry so the change is
// intentional and visible in one diff.

'use strict'

const BLASTI_LAN_PORTS = {
  /** TCP — the main local API: discovery probes, pairing offers (LAN HTTP
   *  leg), device commands + status, print relay compat path. LISTEN: all PCs. */
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
}

/**
 * Ports a print-job SENDER tries, in order, against a master/host PC:
 * the dedicated print-relay listener first (:3083), then the main API's
 * compat route (:3080). Callers pass the matching path per port via
 * printRelayRequestPath().
 */
function printRelayTargetPorts() {
  return [BLASTI_LAN_PORTS.PRINT_RELAY, BLASTI_LAN_PORTS.HTTP_API]
}

/** Request path for a print job on the given target port. */
function printRelayRequestPath(port) {
  return Number(port) === BLASTI_LAN_PORTS.PRINT_RELAY
    ? '/print-job'
    : '/api/agency-devices/host/print-job'
}

module.exports = {
  BLASTI_LAN_PORTS,
  printRelayTargetPorts,
  printRelayRequestPath,
}
