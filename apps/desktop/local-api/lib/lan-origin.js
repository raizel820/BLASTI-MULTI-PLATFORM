/**
 * lan-origin.js — LAN bind resolution + private-origin allowlist.
 * ─────────────────────────────────────────────────────────────────────────────
 * Shared by the local API HTTP layer (index.js CORS) and the Socket.IO layer
 * (local-realtime.js) so both accept exactly the same LAN origins.
 *
 * WHY: the local API used to bind 127.0.0.1 only, so NO kiosk / TV board /
 * second desktop on the office network could ever reach it ("desktop app
 * could not discover kiosk devices"). The bind address is now configurable:
 *
 *   BLASTI_LAN_BIND  = 'loopback' (default) | 'lan' (→ 0.0.0.0) | explicit IP
 *   BLASTI_ENABLE_LAN = 1 / true    — shorthand for BLASTI_LAN_BIND=lan
 *
 * The packaged desktop app enables LAN mode by default (main.js sets the env
 * before the local API loads); `--dev` runs stay loopback-only unless the
 * env is set explicitly. All output/comments in English. No new dependencies.
 */

'use strict'

const os = require('os')

/** Best-effort boolean env parsing ('1', 'true', 'yes' — case-insensitive). */
function parseBool(value) {
  if (value === undefined || value === null) return false
  const v = String(value).trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

/**
 * Resolve the bind configuration from the environment.
 * @returns {{ lan: boolean, bind: string, mode: 'loopback'|'lan'|'ip' }}
 *   lan    — true when the server is reachable beyond loopback
 *   bind   — the hostname passed to server.listen()
 */
function resolveLanBind() {
  const explicit = String(process.env.BLASTI_LAN_BIND || '').trim().toLowerCase()
  const enabled = parseBool(process.env.BLASTI_ENABLE_LAN)
  if (explicit === 'lan') return { lan: true, bind: '0.0.0.0', mode: 'lan' }
  if (explicit && explicit !== 'loopback' && explicit !== '0.0.0.0') {
    // Explicit interface IP — bind it directly (LAN-reachable by definition).
    return { lan: true, bind: explicit, mode: 'ip' }
  }
  if (explicit === '0.0.0.0' || enabled) return { lan: true, bind: '0.0.0.0', mode: 'lan' }
  return { lan: false, bind: '127.0.0.1', mode: 'loopback' }
}

/** All non-internal IPv4 addresses of this host, e.g. ['192.168.1.10']. */
function localIpv4s() {
  const out = []
  try {
    const interfaces = os.networkInterfaces()
    for (const addrs of Object.values(interfaces)) {
      if (!addrs) continue
      for (const addr of addrs) {
        if (addr && addr.family === 'IPv4' && !addr.internal) out.push(addr.address)
      }
    }
  } catch { /* non-fatal */ }
  return out
}

/** RFC1918 / loopback IPv4 check (strings like '192.168.1.10'). */
function isPrivateIpv4(host) {
  if (!host || !/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false
  const [a, b] = host.split('.').map((n) => parseInt(n, 10))
  if (a === 127 || a === 10) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  return false
}

/**
 * Best non-internal IPv4 for beacons/discovery payloads (first RFC1918 hit,
 * else the first non-internal IPv4, else null).
 */
function bestLanIp() {
  const ips = localIpv4s()
  if (ips.length === 0) return null
  return ips.find((ip) => isPrivateIpv4(ip)) || ips[0]
}

/** Interface name owning `ip` (e.g. 'Wi-Fi', 'eth0') — best-effort. */
function primaryLanInterface(ip) {
  const target = ip || bestLanIp()
  if (!target) return null
  try {
    const interfaces = os.networkInterfaces()
    for (const [name, addrs] of Object.entries(interfaces)) {
      if (!addrs) continue
      for (const addr of addrs) {
        if (addr && addr.family === 'IPv4' && !addr.internal && addr.address === target) return name
      }
    }
  } catch { /* non-fatal */ }
  return null
}

/**
 * Is this Origin header a LAN/loopback http(s) origin we should accept?
 * Accepts: http(s)://localhost[:port], http(s)://127.0.0.1[:port],
 * http(s)://<RFC1918 IP>[:port], http(s)://<one of this host's own LAN IPs>,
 * capacitor://localhost and file:// (native shells). No Origin at all is
 * handled by the caller (non-browser clients never send one and must pass).
 */
function isLanHttpOrigin(origin) {
  if (!origin) return false
  if (origin === 'capacitor://localhost' || origin === 'file://') return true
  try {
    const u = new URL(origin)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    const host = u.hostname
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return true
    if (isPrivateIpv4(host)) return true
    if (localIpv4s().includes(host)) return true
  } catch { /* malformed origin */ }
  return false
}

module.exports = {
  parseBool,
  resolveLanBind,
  localIpv4s,
  isPrivateIpv4,
  bestLanIp,
  primaryLanInterface,
  isLanHttpOrigin,
}
