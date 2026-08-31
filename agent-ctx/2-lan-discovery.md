# Task ID: 2 — LAN Auto-Discovery Feature

## Summary

Implemented UDP broadcast-based LAN auto-discovery for the BLASTI Electron desktop app. This enables kiosk tablets, TV screens, and mobile apps on the same LAN to automatically discover the desktop/LAN server without manual IP configuration.

## Changes Made

### 1. `apps/desktop/main.js` — Core Discovery Infrastructure

**Module-scope additions (lines 56-78):**
- `getLocalIP()` — Returns the first non-internal IPv4 address of the machine. Moved to module scope so both `startLocalServer()` and the `lan:server-info` IPC handler can use it.
- `discoverySocket` and `discoveryInterval` — Module-level state for the UDP beacon, accessible by the cleanup handler in `app.on('will-quit')`.

**Inside `startLocalServer()` — Discovery HTTP endpoint (lines 853-887):**
- `LOCAL_PORT` constant (3080) moved before route definitions for proper scoping
- CORS middleware for `/api/discover` routes (allows `*` origin for LAN discovery)
- `GET /api/discover` endpoint — Returns JSON with service info, IP, ports, hostname, platform, uptime
- `OPTIONS /api/discover` — CORS preflight handler

**Inside `startLocalServer()` — UDP Broadcast Beacon (lines 891-937):**
- Creates a `dgram.createSocket('udp4')` bound with `setBroadcast(true)`
- Broadcasts a JSON payload every 3 seconds on port 3081
- Payload includes: magic string `BLASTI`, version, service name, IP, port (3080), apiPort (3003), webPort (3000), hostname, timestamp
- Dual broadcast: `255.255.255.255` (limited broadcast) + subnet-specific `x.x.x.255`
- Graceful error handling — warns on failure but doesn't crash

**IPC Handler (lines 516-526):**
- `ipcMain.handle('lan:server-info', ...)` — Returns LAN server connection details or `null` if server isn't running

**Cleanup (lines 994-997):**
- In `app.on('will-quit')`: clears discovery interval and closes UDP socket before app exits

### 2. `apps/desktop/preload.js` — Preload Bridge APIs (lines 168-182)

- `getLanServerInfo()` — Invokes `lan:server-info` IPC, returns server info or null
- `onLanDiscovery(callback)` — Listens for `lan:discovery` IPC events (future mesh support)

## Protocol Details

| Feature | Details |
|---------|---------|
| Discovery Method | UDP broadcast |
| Broadcast Port | 3081 |
| Broadcast Interval | 3 seconds |
| Magic String | `BLASTI` |
| Broadcast Targets | `255.255.255.255` + subnet `.255` |
| HTTP Endpoint | `GET /api/discover` on port 3080 |
| CORS Policy | `*` (open for LAN discovery) |

## Verification

- Dev server running without errors (Next.js serving on port 3000)
- All changes are in Electron desktop code only — no web app changes needed
- Existing LAN server, Socket.IO, and JWT auth functionality preserved intact
