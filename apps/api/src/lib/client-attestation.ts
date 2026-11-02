/**
 * @blasti/api — Client Attestation (0.6.48)
 *
 * PROOF that a request claiming to come from the BLASTI desktop (Electron)
 * or mobile (Android) app really originates from the genuine app binary.
 *
 * WHY
 * ───
 * The legacy `x-blasti-client` header is a plain JS-attached string — any
 * browser console can set it. The user requirement (0.6.48):
 *   "شدّد على الإجراءات الأمنية لضمان أن طلبات تسجيل الدخول تأتي فعلاً من
 *    تطبيق سطح المكتب أو تطبيق الهاتف"
 * Native shells therefore attach a SECOND header, `x-blasti-attest`, with an
 * HMAC-SHA256 signature over a fresh timestamp + nonce, computed with a
 * per-platform secret that lives ONLY inside the app binary:
 *   - desktop → Electron MAIN process (apps/desktop/client-attestation.js),
 *     never inside the shared web bundle;
 *   - mobile  → BlastiNativeStatus Capacitor plugin (Java, inside the APK).
 * Plain browsers carry no attestation at all — they resolve as 'web'.
 *
 * FORMAT
 * ──────
 *   v1.<platform>.<tsMs>.<nonce>.<hex-hmac>
 *   signature payload: `${platform}|${tsMs}|${nonce}`
 *
 * VERIFICATION
 * ────────────
 *   - signature must match the platform's secret,
 *   - |now − tsMs| must be within ±ATTEST_MAX_SKEW_MS (clock tolerance),
 *   - the nonce must never repeat inside the replay window.
 *
 * FAILURE POLICY — never a hard block by itself: an unattested or invalid
 * request falls back to the legacy header / 'web' resolution. The teeth of
 * the role×platform policy remain the JWT platform claim; attestation makes
 * that claim trustworthy and lets the server LOG spoofed native claims.
 */

import crypto from 'crypto'

export type AttestedPlatform = 'desktop' | 'mobile'

const ATTEST_VERSION = 'v1'

/** ± clock tolerance for the timestamp inside the header. */
const ATTEST_MAX_SKEW_MS = 5 * 60 * 1000

/** Nonces older than the skew window can never be replayed — prune eagerly. */
const REPLAY_WINDOW_MS = ATTEST_MAX_SKEW_MS * 2

/** Hard cap so a flood can't grow the map unbounded. */
const MAX_NONCE_CACHE = 20_000

// ─── Secrets ────────────────────────────────────────────────────────────────
// Rotate in production via env. The dev fallbacks are PUBLIC BY DESIGN (they
// ship in this open bundle); production deployments MUST set:
//   BLASTI_ATTEST_SECRET_DESKTOP  (also baked into the Electron build env)
//   BLASTI_ATTEST_SECRET_MOBILE   (also compiled into the Android APK)
// An attestation signed with a fallback secret while the env var is set
// (or vice versa) simply fails verification → 'web' fallback, never a crash.

const DEV_FALLBACK_DESKTOP = 'blasti-attest-desktop-dev-key-rotate-in-production'
const DEV_FALLBACK_MOBILE = 'blasti-attest-mobile-dev-key-rotate-in-production'

function secretFor(platform: AttestedPlatform): string {
  if (platform === 'desktop') {
    return process.env.BLASTI_ATTEST_SECRET_DESKTOP || DEV_FALLBACK_DESKTOP
  }
  return process.env.BLASTI_ATTEST_SECRET_MOBILE || DEV_FALLBACK_MOBILE
}

/**
 * Compute the exact HMAC the native shells produce. Exported so tests (and
 * the desktop local API mirror) can assert byte-identical behavior.
 */
export function computeAttestationSignature(platform: AttestedPlatform, tsMs: string, nonce: string): string {
  return crypto
    .createHmac('sha256', secretFor(platform))
    .update(`${platform}|${tsMs}|${nonce}`)
    .digest('hex')
}

/**
 * Build a FRESH attestation header value. Used by trusted server-side
 * callers (the desktop embedded local API proxies its cloud login through
 * this module's sibling implementation) — not by this API itself.
 */
export function buildAttestationHeader(platform: AttestedPlatform): string {
  const tsMs = Date.now().toString()
  const nonce = crypto.randomBytes(12).toString('hex')
  const sig = computeAttestationSignature(platform, tsMs, nonce)
  return `${ATTEST_VERSION}.${platform}.${tsMs}.${nonce}.${sig}`
}

// ─── Replay protection ──────────────────────────────────────────────────────

const seenNonces = new Map<string, number>()

function claimNonce(nonce: string, now: number): boolean {
  // Prune expired entries first — keeps the map at O(active window).
  if (seenNonces.size > 0) {
    for (const [key, firstSeen] of seenNonces) {
      if (now - firstSeen > REPLAY_WINDOW_MS) seenNonces.delete(key)
    }
  }
  if (seenNonces.has(nonce)) return false
  if (seenNonces.size >= MAX_NONCE_CACHE) {
    // Under flood: drop the oldest entry (Map preserves insertion order).
    const oldest = seenNonces.keys().next().value
    if (oldest !== undefined) seenNonces.delete(oldest)
  }
  seenNonces.set(nonce, now)
  return true
}

// ─── Verification ───────────────────────────────────────────────────────────

export interface AttestationResult {
  /** True when the header verified against the declared platform's secret. */
  attested: boolean
  /** The attested platform (only when attested=true). */
  platform?: AttestedPlatform
  /** Machine-readable failure reason for logs (never sent to clients). */
  reason?: 'malformed' | 'bad-signature' | 'stale' | 'replayed'
}

export function verifyClientAttestation(headerValue: string | undefined | null): AttestationResult {
  if (!headerValue) return { attested: false, reason: 'malformed' }

  const parts = headerValue.split('.')
  if (parts.length !== 5 || parts[0] !== ATTEST_VERSION) {
    return { attested: false, reason: 'malformed' }
  }
  const [, platformRaw, tsMs, nonce, sig] = parts
  if (platformRaw !== 'desktop' && platformRaw !== 'mobile') {
    return { attested: false, reason: 'malformed' }
  }
  const platform = platformRaw as AttestedPlatform

  const ts = Number(tsMs)
  if (!Number.isFinite(ts) || ts <= 0) return { attested: false, reason: 'malformed' }

  const now = Date.now()
  if (Math.abs(now - ts) > ATTEST_MAX_SKEW_MS) {
    return { attested: false, reason: 'stale' }
  }

  const expected = computeAttestationSignature(platform, tsMs, nonce)
  const sigBuf = Buffer.from(sig, 'utf8')
  const expBuf = Buffer.from(expected, 'utf8')
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return { attested: false, reason: 'bad-signature' }
  }

  if (!claimNonce(`${platform}:${nonce}`, now)) {
    return { attested: false, reason: 'replayed' }
  }

  return { attested: true, platform }
}
