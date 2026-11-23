/**
 * Claim deep-link base resolution (0.6.110) — shared by every surface that
 * renders a QR "claim" code for a walk-in ticket: the agency full-screen
 * walk-in dialog AND the kiosk ticket screen (display + printed receipt).
 *
 * The QR encodes `<base>/?claim=<importToken>`. The base MUST be reachable
 * from the CUSTOMER'S PHONE on the same WiFi — the historic bug encoded
 * `window.location.origin`, which inside the desktop's own kiosk window is
 * `http://127.0.0.1:3080` (a loopback no phone can ever open), silently
 * producing dead QR codes.
 *
 * Resolution ladder (LAN-direct first, offline-safe — never a cloud round
 * trip to decide):
 *   1. The local API's own /api/discover beacon (same-origin call — in the
 *      desktop window the UI is served by the embedded local API) reports
 *      its LAN IP → `http://<lanIp>:<port>` is reachable by any phone on
 *      the same WiFi, offline included.
 *   2. A non-loopback current origin (the UI is already served on the LAN
 *      or on the cloud domain) → use it as-is.
 *   3. Loopback origin (desktop window without LAN beacon) or beacon
 *      failure (cloud-hosted surface → /api/discover 404s) → fall back
 *      to the cloud URL for the online case.
 */

const LOOPBACK_ORIGIN_RE = /\/\/(127\.0\.0\.1|localhost|\[::1\])(:|$)/
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

let cachedBase: string | null = null

export async function resolveClaimBase(): Promise<string> {
  if (cachedBase) return cachedBase
  if (typeof window === 'undefined') {
    return process.env.NEXT_PUBLIC_APP_URL || 'https://blastidz.online'
  }
  try {
    const res = await fetch('/api/discover', { headers: { Accept: 'application/json' } })
    if (res.ok) {
      const d = await res.json().catch(() => null)
      const ip = d?.lanIp || d?.ip
      if (ip && IPV4_RE.test(String(ip))) {
        const port = window.location.port || '3080'
        cachedBase = `http://${ip}:${port}`
        return cachedBase
      }
    }
  } catch { /* cloud-hosted or unreachable — fall through */ }
  const origin = window.location.origin
  if (origin && !LOOPBACK_ORIGIN_RE.test(origin)) {
    cachedBase = origin
    return cachedBase
  }
  return process.env.NEXT_PUBLIC_APP_URL || 'https://blastidz.online'
}

/** Build the full claim deep-link URL for an import token. */
export async function buildClaimUrl(importToken: string): Promise<string> {
  const base = await resolveClaimBase()
  return `${base}/?claim=${importToken}`
}
