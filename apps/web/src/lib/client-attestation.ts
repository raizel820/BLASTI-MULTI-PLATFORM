/**
 * BLASTI — Client Attestation builder (0.6.48)
 *
 * Native shells (Electron desktop / Capacitor Android) attach a SIGNED
 * `x-blasti-attest` header on API requests so the server can prove the
 * request really comes from the genuine app binary — not from a browser
 * console spoofing the legacy `x-blasti-client` header.
 *
 * THE SECRET NEVER ENTERS THIS BUNDLE:
 *   - Electron  → the MAIN process computes the HMAC (ipcMain 'blasti:attest')
 *                 and the preload bridge exposes electronAPI.getClientAttestation().
 *   - Android   → the BlastiNativeStatus Capacitor plugin computes the HMAC
 *                 inside the APK (method: getAttestation).
 *   - Browsers  → no attestation is available (and none is needed: they
 *                 resolve as 'web' server-side).
 *
 * A fresh token is built at most every ATTEST_REFRESH_MS. The server tolerates
 * ±5 min of clock skew, so the cache keeps the IPC/bridge hop off the hot
 * request path while every token stays well inside its validity window.
 */

const ATTEST_REFRESH_MS = 45_000

let cached: { value: string | null; fetchedAt: number } | null = null
let inflight: Promise<string | null> | null = null

/** Minimal shape of the Electron bridge relevant here (preload-exposed). */
interface ElectronAttestBridge {
  getClientAttestation?: () => Promise<string>
}

/** Minimal shape of the Capacitor bridge relevant here. */
interface CapacitorAttestBridge {
  isNativePlatform?: () => boolean
  Plugins?: Record<string, { getAttestation?: () => Promise<{ value?: string }> } | undefined>
}

async function requestFreshAttestation(): Promise<string | null> {
  if (typeof window === 'undefined') return null
  const w = window as unknown as Record<string, unknown>

  // ── Electron: main-process HMAC via the preload bridge ──────────────────
  const electron = w.electronAPI as ElectronAttestBridge | undefined
  if (electron && typeof electron.getClientAttestation === 'function') {
    try {
      const value = await electron.getClientAttestation()
      return typeof value === 'string' && value.startsWith('v1.') ? value : null
    } catch {
      return null
    }
  }

  // ── Android (Capacitor): APK-side HMAC via the native plugin ────────────
  const cap = w.Capacitor as CapacitorAttestBridge | undefined
  if (cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform()) {
    const plugin = cap.Plugins?.BlastiNativeStatus
    if (plugin && typeof plugin.getAttestation === 'function') {
      try {
        const res = await plugin.getAttestation()
        return typeof res?.value === 'string' && res.value.startsWith('v1.') ? res.value : null
      } catch {
        return null
      }
    }
  }

  // Plain browser — nothing to attest.
  return null
}

/**
 * Returns the current attestation header VALUE ('v1.…'), or null when this
 * runtime has no attestation (browser / bridge missing). Never throws.
 */
export async function getBlastiAttestHeader(): Promise<string | null> {
  if (cached && Date.now() - cached.fetchedAt < ATTEST_REFRESH_MS) {
    return cached.value
  }
  // Collapse concurrent callers onto one bridge round-trip.
  if (!inflight) {
    inflight = requestFreshAttestation()
      .then((value) => {
        // Cache even the null result briefly — a browser stays a browser.
        cached = { value, fetchedAt: Date.now() }
        return value
      })
      .catch(() => null)
      .finally(() => {
        inflight = null
      })
  }
  return inflight
}
