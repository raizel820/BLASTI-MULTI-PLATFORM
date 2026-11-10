/**
 * Delta Updates (0.6.30) — release patch generation + chain resolution.
 * ─────────────────────────────────────────────────────────────────────────────
 * Given a NEWLY PUBLISHED AppVersion with its reference artifacts on disk
 * (desktop: app.asar + outref tree archive · android: the previous APK), this
 * module builds the SMALL differential patch the previous release's devices
 * can apply instead of the full installer/APK:
 *
 *   desktop (windows/mac/linux/electron)
 *     → BLSTRLS1 release-patch: [app.asar binary-delta][out tree patch]
 *     guards: identical runtimeKey (electron+arch) AND identical
 *             nativeFingerprint (everything outside asar/out unchanged)
 *   android / android-debug
 *     → BLSTDLT1 binary-delta between the two APK files
 *
 * MULTI-VERSION: /check resolves the shortest chain of hops through the
 * AppVersionDelta graph (client version → latest), capped at MAX_CHAIN_HOPS;
 * the client applies hops in order and falls back to the full installer on
 * the first problem (every hop is sha-verified twice: patch bytes after
 * download + rebuilt artifact after apply).
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  createDeltaFromFiles,
  applyDeltaToFile,
  createOutref,
  readOutrefHeader,
  createTreePatch,
  createReleasePatch,
  sha256OfFile,
} from '@blasti/binary-delta'
import { db } from '@blasti/db'
import { STORAGE_ROOT } from './storage'

const DELTA_DIR = path.join(STORAGE_ROOT, 'app-versions')

/** Longest hop chain a client may be asked to apply before a full installer wins. */
export const MAX_CHAIN_HOPS = 5

const DESKTOP_PLATFORMS = new Set(['windows', 'mac', 'linux', 'electron'])
const APK_PLATFORMS = new Set(['android', 'android-debug'])

function deltaStorageKey(platform: string, from: string, to: string): string {
  const group = DESKTOP_PLATFORMS.has(platform) ? 'desktop' : 'mobile'
  return `${group}/delta-${platform}-${from}-to-${to}-${Date.now()}.patch`
}

interface VersionRowLike {
  id: string
  platform: string
  version: string
  fileStorageKey: string | null
  fileHash: string | null
  asarStorageKey: string | null
  asarSha256: string | null
  outrefStorageKey: string | null
  runtimeKey: string | null
  nativeFingerprint: string | null
  /** 0.6.58 — legacy-scope fingerprint (pre-0.6.58 hash) for old rows. */
  legacyNativeFingerprint?: string | null
  /**
   * 0.6.59 — WHICH fingerprint definition `nativeFingerprint` holds:
   *   'v3'  → exe-excluded scope (make-release-refs 0.6.59+)
   *   'v2'  → 0.6.58 scope, exe INCLUDED
   *   null  → pre-0.6.58 row (nativeFingerprint holds the old broad hash)
   * See fingerprintSpecOf() — this is the discriminator that fixed the
   * "native-bits-changed on every hop" field incident.
   */
  fingerprintSpec?: string | null
}

/** Fingerprint spec values emitted since 0.6.58. */
export type FingerprintSpec = 'v1' | 'v2' | 'v3'

/**
 * 0.6.59 — WHICH fingerprint definition does this row's `nativeFingerprint`
 * column hold? Discriminated by `fingerprintSpec` (v3, uploaded by CI from
 * 0.6.59 on) falling back to `legacyNativeFingerprint` presence (v2 = the
 * 0.6.58 dual-scope rows) and finally null (pre-0.6.58 rows, whose only hash
 * is the old broad legacy-scope one).
 */
export function fingerprintSpecOf(row: Pick<VersionRowLike, 'fingerprintSpec' | 'legacyNativeFingerprint'>): FingerprintSpec {
  const spec = String(row.fingerprintSpec || '').trim().toLowerCase()
  if (spec === 'v3' || spec === 'v2') return spec
  if ((row.legacyNativeFingerprint || '').trim()) return 'v2'
  return 'v1'
}

/**
 * Fingerprint refusals the OPERATOR may consciously override via
 * allowFingerprintRisk=1 (regenerate-deltas) — everything else
 * (runtime-key-changed, missing refs, platform mismatch…) is absolute.
 *
 * 0.6.59 FIELD ROOT CAUSE ("native-bits-changed on EVERY hop, even
 * 0.6.57→0.6.58"): electron-builder stamps the app version into the exe's
 * Windows version resource on every build, so Blasti.exe's bytes differ
 * between ANY two versions. The fingerprint scope hashed that exe → the
 * hash differed between every pair of releases → every hop was refused and
 * desktop delta updates were effectively dead despite the whole pipeline
 * being in place. The 0.6.59 fix removes top-level *.exe from the scope
 * (the exe's runtime identity is already pinned by runtimeKey = electron
 * version + arch; the only same-runtime exe delta is the version stamp,
 * which the patch system never delivers and app.getVersion() does not
 * depend on — it reads the version from package.json inside the patched
 * asar). Refusals on v3-vs-v3 native-bits-changed are now REAL native
 * changes (dlls/locales/assets/data) — full installer remains the correct
 * path there, but the operator retains a conscious override for hops where
 * they can verify only stamp-level bits changed.
 */
const OVERRIDABLE_FINGERPRINT_REASONS = new Set(['native-bits-changed', 'fingerprint-scope-mismatch'])

export function isOverridableFingerprintReason(reason: string | null | undefined): boolean {
  return OVERRIDABLE_FINGERPRINT_REASONS.has(String(reason || ''))
}

/**
 * 0.6.58 → 0.6.59 — SPEC-AWARE fingerprint comparison.
 *
 * The fingerprint guard answers ONE question: "are the files this patch does
 * NOT deliver byte-identical between the two releases?" The patch delivers
 * app.asar + the WHOLE app.asar.unpacked tree, so the honest scope is
 * "everything else" minus the version-stamped launchers.
 *
 * Stored scopes by era (see fingerprintSpecOf):
 *   v1 (pre-0.6.58)  nativeFingerprint          = broad legacy hash (exe + unpacked + node_modules INCLUDED)
 *   v2 (0.6.58)      nativeFingerprint          = exe-INCLUSIVE new-scope hash; legacyNativeFingerprint = broad legacy hash
 *   v3 (0.6.59+)     nativeFingerprint          = exe-EXCLUDED new-scope hash; legacyNativeFingerprint = broad legacy hash
 *
 * Comparison matrix:
 *   same spec on both sides → compare nativeFingerprint-vs-nativeFingerprint
 *                             (only v3-vs-v3 can EVER match in practice: v1
 *                             and v2 hashes both include the version-stamped
 *                             exe, which differs between any two versions)
 *   mixed specs             → refuse 'fingerprint-scope-mismatch' (no honest
 *                             common basis exists on stored data) — the
 *                             operator may override with
 *                             allowFingerprintRisk=1 after verifying the two
 *                             releases only differ in asar/unpacked/stamp
 *                             bits.
 * Returns { ok: true } or { ok: false, reason, overridable }.
 */
function compareNativeFingerprints(
  prev: VersionRowLike,
  cur: VersionRowLike,
): { ok: true } | { ok: false; reason: string; overridable: boolean } {
  const prevSpec = fingerprintSpecOf(prev)
  const curSpec = fingerprintSpecOf(cur)
  const prevHash = (prev.nativeFingerprint || '').trim()
  const curHash = (cur.nativeFingerprint || '').trim()
  if (prevSpec === curSpec && prevHash && curHash) {
    return prevHash === curHash
      ? { ok: true }
      : { ok: false, reason: 'native-bits-changed', overridable: true }
  }
  return { ok: false, reason: 'fingerprint-scope-mismatch', overridable: true }
}

function resolveStored(key: string | null | undefined): string | null {
  if (!key) return null
  const root = path.resolve(DELTA_DIR)
  const full = path.resolve(root, key)
  if (!full.startsWith(root + path.sep)) return null
  try { return fs.statSync(full).isFile() ? full : null } catch { return null }
}

/**
 * 0.6.59 — CHEAP hop diagnosis for the admin "Delta Health" view.
 *
 * Runs the EXACT guard sequence of generateDeltaBetween (same order, same
 * reason codes) WITHOUT touching the big artifacts — no asar diffing, no
 * self-verify, no patch build. Disk existence of the stored refs IS checked
 * (stat only), so "why is this hop not served?" is answerable in one request
 * instead of requiring the operator to run a generation that may take
 * minutes on an 80 MB asar.
 */
export function diagnoseDeltaHop(
  prev: VersionRowLike,
  cur: VersionRowLike,
): { ok: boolean; reason?: string; overridable?: boolean } {
  const platform = cur.platform
  if (platform !== prev.platform) return { ok: false, reason: 'platform-mismatch' }
  if (DESKTOP_PLATFORMS.has(platform)) {
    if (!prev.asarStorageKey || !cur.asarStorageKey) return { ok: false, reason: 'missing-asar-ref' }
    if (!prev.outrefStorageKey || !cur.outrefStorageKey) return { ok: false, reason: 'missing-outref-ref' }
    if ((cur.runtimeKey || '') !== (prev.runtimeKey || '')) return { ok: false, reason: 'runtime-key-changed' }
    const fpCheck = compareNativeFingerprints(prev, cur)
    if (!fpCheck.ok) return { ok: false, reason: fpCheck.reason, overridable: fpCheck.overridable }
    if (!resolveStored(prev.asarStorageKey) || !resolveStored(cur.asarStorageKey)) return { ok: false, reason: 'ref-file-missing' }
    if (!resolveStored(prev.outrefStorageKey) || !resolveStored(cur.outrefStorageKey)) return { ok: false, reason: 'ref-file-missing' }
    return { ok: true }
  }
  if (APK_PLATFORMS.has(platform)) {
    if (!prev.fileStorageKey || !cur.fileStorageKey) return { ok: false, reason: 'missing-apk' }
    if (!prev.fileHash || !cur.fileHash) return { ok: false, reason: 'missing-apk-hash' }
    if (!resolveStored(prev.fileStorageKey) || !resolveStored(cur.fileStorageKey)) return { ok: false, reason: 'apk-file-missing' }
    return { ok: true }
  }
  return { ok: false, reason: 'platform-unsupported' }
}

/**
 * Build + persist the delta row for (prev → cur). Returns null when impossible.
 *
 * 0.6.59 — `opts.allowFingerprintRisk`: when the ONLY refusal is a
 * fingerprint one (native-bits-changed / fingerprint-scope-mismatch — both
 * tagged overridable), the operator may consciously accept the residual risk
 * (files outside asar/unpacked may have changed between the releases in ways
 * stored hashes cannot verify) and force the hop anyway. runtime-key-changed
 * and missing refs are NEVER overridable: an electron-version change or a
 * missing base artifact makes the patch objectively inapplicable/unsafe.
 * Every override is recorded in the result (`overridden: true`) and lands in
 * the APP_VERSION_DELTA_GENERATION audit entry.
 */
export async function generateDeltaBetween(
  prev: VersionRowLike,
  cur: VersionRowLike,
  opts?: { allowFingerprintRisk?: boolean },
): Promise<{ ok: true; deltaId: string; size: number; overridden?: boolean } | { ok: false; reason: string }> {
  const platform = cur.platform
  if (platform !== prev.platform) return { ok: false, reason: 'platform-mismatch' }

  try {
    if (DESKTOP_PLATFORMS.has(platform)) {
      // ── Desktop: asar delta + out tree patch, wrapped in a release patch ──
      if (!prev.asarStorageKey || !cur.asarStorageKey) return { ok: false, reason: 'missing-asar-ref' }
      if (!prev.outrefStorageKey || !cur.outrefStorageKey) return { ok: false, reason: 'missing-outref-ref' }
      if ((cur.runtimeKey || '') !== (prev.runtimeKey || '')) return { ok: false, reason: 'runtime-key-changed' }
      // 0.6.58→0.6.59 — spec-aware guard: only same-spec hashes are
      // comparable; fingerprint refusals may be consciously overridden by
      // the operator (allowFingerprintRisk) after verifying the hop.
      const fpCheck = compareNativeFingerprints(prev, cur)
      let overridden = false
      if (!fpCheck.ok) {
        if (opts?.allowFingerprintRisk && fpCheck.overridable) {
          overridden = true
          console.warn(`[app-version-deltas] OVERRIDE (allowFingerprintRisk): v${prev.version} → v${cur.version} generated despite ${fpCheck.reason} — operator-accepted risk`)
        } else {
          return { ok: false, reason: fpCheck.reason }
        }
      }

      const prevAsar = resolveStored(prev.asarStorageKey)
      const curAsar = resolveStored(cur.asarStorageKey)
      const prevOutref = resolveStored(prev.outrefStorageKey)
      const curOutref = resolveStored(cur.outrefStorageKey)
      if (!prevAsar || !curAsar || !prevOutref || !curOutref) return { ok: false, reason: 'ref-file-missing' }

      const asarDelta = await createDeltaFromFiles(prevAsar, curAsar)
      // SELF-VERIFY: rebuild the new asar from the old one — a patch that
      // fails here must never reach a device (client would just fall back,
      // but catching it server-side keeps dashboards honest).
      const tmpOut = path.join(path.dirname(curAsar), `.verify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`)
      try {
        await applyDeltaToFile(prevAsar, asarDelta.delta, tmpOut)
      } finally {
        try { fs.unlinkSync(tmpOut) } catch { /* already removed */ }
      }

      const treePatch = createTreePatch(fs.readFileSync(prevOutref), fs.readFileSync(curOutref))
      const patch = createReleasePatch({
        fromVersion: prev.version,
        toVersion: cur.version,
        runtimeKey: cur.runtimeKey || '',
        nativeFingerprint: cur.nativeFingerprint || '',
        asarDelta,
        treePatch,
      })

      const key = deltaStorageKey(platform, prev.version, cur.version)
      const filePath = path.join(DELTA_DIR, key)
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, patch)

      const row = await db.appVersionDelta.upsert({
        where: { platform_fromVersion_toVersion: { platform, fromVersion: prev.version, toVersion: cur.version } },
        create: {
          appVersionId: cur.id,
          platform,
          fromVersion: prev.version,
          toVersion: cur.version,
          fileName: path.basename(key),
          fileSize: patch.length,
          fileHash: (await import('node:crypto')).createHash('sha256').update(patch).digest('hex'),
          fileStorageKey: key,
          fromArtifactHash: asarDelta.header.fromSha256,
          toArtifactHash: asarDelta.header.toSha256,
          kind: 'release-patch',
          runtimeKey: cur.runtimeKey || '',
          nativeFingerprint: cur.nativeFingerprint || '',
        },
        update: {
          appVersionId: cur.id,
          fileSize: patch.length,
          fileStorageKey: key,
          fromArtifactHash: asarDelta.header.fromSha256,
          toArtifactHash: asarDelta.header.toSha256,
        },
      })
      return { ok: true, deltaId: row.id, size: patch.length, ...(overridden ? { overridden: true } : {}) }
    }

    if (APK_PLATFORMS.has(platform)) {
      // ── Android: raw binary-delta between the two APKs ────────────────────
      if (!prev.fileStorageKey || !cur.fileStorageKey) return { ok: false, reason: 'missing-apk' }
      if (!prev.fileHash || !cur.fileHash) return { ok: false, reason: 'missing-apk-hash' }
      const prevApk = resolveStored(prev.fileStorageKey)
      const curApk = resolveStored(cur.fileStorageKey)
      if (!prevApk || !curApk) return { ok: false, reason: 'apk-file-missing' }

      const delta = await createDeltaFromFiles(prevApk, curApk)
      const tmpOut = path.join(path.dirname(curApk), `.verify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`)
      try {
        await applyDeltaToFile(prevApk, delta.delta, tmpOut)
      } finally {
        try { fs.unlinkSync(tmpOut) } catch { /* already removed */ }
      }

      const key = deltaStorageKey(platform, prev.version, cur.version)
      const filePath = path.join(DELTA_DIR, key)
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, delta.delta)

      const row = await db.appVersionDelta.upsert({
        where: { platform_fromVersion_toVersion: { platform, fromVersion: prev.version, toVersion: cur.version } },
        create: {
          appVersionId: cur.id,
          platform,
          fromVersion: prev.version,
          toVersion: cur.version,
          fileName: path.basename(key),
          fileSize: delta.delta.length,
          fileHash: (await import('node:crypto')).createHash('sha256').update(delta.delta).digest('hex'),
          fileStorageKey: key,
          fromArtifactHash: delta.header.fromSha256,
          toArtifactHash: delta.header.toSha256,
          kind: 'apk',
          runtimeKey: '',
          nativeFingerprint: '',
        },
        update: {
          appVersionId: cur.id,
          fileSize: delta.delta.length,
          fileStorageKey: key,
          fromArtifactHash: delta.header.fromSha256,
          toArtifactHash: delta.header.toSha256,
        },
      })
      return { ok: true, deltaId: row.id, size: delta.delta.length }
    }

    return { ok: false, reason: 'platform-unsupported' }
  } catch (err) {
    console.warn('[app-version-deltas] generation failed:', (err as Error).message)
    return { ok: false, reason: `error:${(err as Error).message.slice(0, 80)}` }
  }
}

/**
 * Build the delta for the NEWLY published `cur` against EVERY plausible
 * published predecessor (usually just the immediately-previous release).
 * Called from activate + release-refs upload.
 *
 * 0.6.58 — OBSERVABILITY: every attempt (successes AND refusals) is persisted
 * to the audit log (`APP_VERSION_DELTA_GENERATION`, userId 'system') so a
 * release that ships without deltas is diagnosable from the admin audit UI
 * FOREVER — the 0.6.53→0.6.55 and 0.6.56→0.6.57 field incidents stayed
 * invisible for weeks because the per-hop outcome existed only in the CI log
 * of a single run and in one transient HTTP response.
 *
 * `limit` caps how many predecessors get hops (CI self-heal passes 3 to keep
 * the synchronous HTTP request short on the 2-core VPS; the admin repair UI
 * and the default use all 10).
 */
export async function generateDeltasForVersion(
  curId: string,
  opts?: { limit?: number; allowFingerprintRisk?: boolean },
): Promise<Array<{ from: string; to: string; size: number; ok: boolean; overridden?: boolean; reason?: string }>> {
  const cur = await db.appVersion.findUnique({ where: { id: curId } })
  if (!cur) return []
  // Predecessor lookup IGNORES isPublished on purpose: the activate
  // transaction unpublishes every sibling BEFORE delta generation runs, so a
  // "published only" filter would never find the immediately-previous
  // release — the most valuable hop. What matters for a delta base is the
  // REFERENCE ARTIFACTS (asar/outref/apk), not the publication flag.
  const takeLimit = Math.max(1, Math.min(10, opts?.limit ?? 10))
  const predecessors = await db.appVersion.findMany({
    where: { platform: cur.platform, id: { not: cur.id } },
    orderBy: { createdAt: 'desc' },
    take: takeLimit,
  })
  const results: Array<{ from: string; to: string; size: number; ok: boolean; overridden?: boolean; reason?: string }> = []
  for (const prev of predecessors) {
    // Only build hops that move FORWARD in semver terms.
    if (compareVersionStrings(prev.version, cur.version) >= 0) continue
    const r = await generateDeltaBetween(prev as VersionRowLike, cur as VersionRowLike, {
      allowFingerprintRisk: opts?.allowFingerprintRisk,
    })
    if (r.ok) {
      results.push({ from: prev.version, to: cur.version, size: r.size, ok: true, ...(r.overridden ? { overridden: true } : {}) })
    } else {
      results.push({ from: prev.version, to: cur.version, size: 0, ok: false, reason: r.reason })
    }
  }

  // 0.6.58 — persist the outcome for the admin audit trail (best-effort:
  // audit failures must never break generation or the calling request).
  // userId stays NULL: AuditLog.userId is a nullable FK to User and no
  // 'system' user row exists — a fabricated id would violate the FK and the
  // entry would silently never persist.
  try {
    await db.auditLog.create({
      data: {
        userId: null,
        action: 'APP_VERSION_DELTA_GENERATION',
        entityType: 'APP_VERSION',
        entityId: curId,
        details: JSON.stringify({
          platform: cur.platform,
          version: cur.version,
          generated: results.filter((r) => r.ok).length,
          refusals: results.filter((r) => !r.ok).length,
          overridden: results.filter((r) => r.ok && r.overridden).length,
          allowFingerprintRisk: opts?.allowFingerprintRisk === true,
          results,
        }),
      },
    })
  } catch { /* audit is best-effort */ }

  return results
}

export function compareVersionStrings(a: string, b: string): number {
  const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0)
  const pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1
    if ((pa[i] || 0) < (pb[i] || 0)) return -1
  }
  return 0
}

/**
 * Shortest hop chain from `fromVersion` to `toVersion` over the delta graph
 * (BFS). Every returned hop is verified to CHAIN: hop[k].toArtifactHash must
 * equal hop[k+1].fromArtifactHash — guarantees sequential application works.
 *
 * 0.6.52 — the return shape is `{ chain, reason }`: when `chain` is null,
 * `reason` names exactly WHY (no-deltas-published / no-verifiable-chain /
 * runtime-target-missing / not-newer) so /check can expose the refusal and
 * clients can LOG it — "only full installers" becomes diagnosable instead
 * of looking like a broken client.
 */
export async function computeDeltaChain(platform: string, fromVersion: string, toVersionId: string): Promise<{
  chain: {
    runtimeKey: string
    nativeFingerprint: string
    targetAsarSha256: string
    targetApkSha256: string
    hops: Array<{
      id: string
      kind: string
      fromVersion: string
      toVersion: string
      url: string
      size: number | null
      sha256: string | null
      fromArtifactHash: string
      toArtifactHash: string
    }>
  } | null
  reason: string
}> {
  const target = await db.appVersion.findUnique({ where: { id: toVersionId } })
  if (!target || target.platform !== platform) return { chain: null, reason: 'target-version-not-found' }
  if (compareVersionStrings(fromVersion, target.version) >= 0) return { chain: null, reason: 'client-not-older-than-target' }

  const edges = await db.appVersionDelta.findMany({ where: { platform } })
  if (edges.length === 0) return { chain: null, reason: 'no-deltas-published' }

  // BFS from fromVersion → target.version
  const adjacency = new Map<string, typeof edges>()
  for (const e of edges) {
    const list = adjacency.get(e.fromVersion) || []
    list.push(e)
    adjacency.set(e.fromVersion, list)
  }
  const visited = new Set<string>([fromVersion])
  let frontier: Array<{ version: string; path: typeof edges }> = [{ version: fromVersion, path: [] }]
  while (frontier.length > 0) {
    const nextFrontier: Array<{ version: string; path: typeof edges }> = []
    for (const node of frontier) {
      const outs = adjacency.get(node.version) || []
      // Prefer the newest patch when several exist for the same pair.
      outs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      for (const edge of outs) {
        if (visited.has(edge.toVersion)) continue
        if (edge.toVersion === fromVersion) continue
        const chainOk = node.path.length === 0 || node.path[node.path.length - 1].toArtifactHash === edge.fromArtifactHash
        if (!chainOk) continue
        const newPath = [...node.path, edge]
        if (edge.toVersion === target.version) {
          return {
            reason: 'ok',
            chain: {
              runtimeKey: target.runtimeKey || '',
              nativeFingerprint: target.nativeFingerprint || '',
              targetAsarSha256: target.asarSha256 || '',
              targetApkSha256: target.fileHash || '',
              hops: newPath.map((h) => ({
                id: h.id,
                kind: h.kind,
                fromVersion: h.fromVersion,
                toVersion: h.toVersion,
                url: `/api/app-versions/delta/${h.id}/download`,
                size: h.fileSize,
                sha256: h.fileHash,
                fromArtifactHash: h.fromArtifactHash,
                toArtifactHash: h.toArtifactHash,
              })),
            },
          }
        }
        if (newPath.length < MAX_CHAIN_HOPS) {
          visited.add(edge.toVersion)
          nextFrontier.push({ version: edge.toVersion, path: newPath })
        }
      }
    }
    frontier = nextFrontier
  }
  return { chain: null, reason: 'no-verifiable-chain' }
}

export { readOutrefHeader, createOutref }

/**
 * 0.6.59 — BOOT-TIME DELTA SELF-HEAL.
 *
 * The field pattern behind "the VPS still serves full installers" was almost
 * always: refs arrived (or were repaired) at a moment when no delta
 * generation ran afterwards, and the AppVersionDelta table stayed empty until
 * the next CI push — which may be days later. This runs ONCE per process,
 * 45 s after boot (so restarts triggered by server-update finish first), and
 * for every delta-capable platform:
 *
 *   1. finds the latest PUBLISHED version (the chain target devices see),
 *   2. SKIPS the platform entirely when delta rows already exist for it
 *      (generation is expensive on desktop — 80 MB asar diffs; never burn
 *      boot time on a healthy chain),
 *   3. rebuilds the hop patches for the 3 nearest predecessors (same cap the
 *      CI self-heal uses to keep the synchronous work short on the 2-core
 *      VPS).
 *
 * Everything is best-effort: any error is logged and swallowed — a failing
 * self-heal must never delay or break the API boot.
 */
let bootSelfHealStarted = false
export function scheduleBootDeltaSelfHeal(): void {
  if (bootSelfHealStarted) return
  bootSelfHealStarted = true
  const run = async () => {
    const platforms = ['windows', 'mac', 'linux', 'electron', 'android', 'android-debug']
    for (const platform of platforms) {
      try {
        const candidates = await db.appVersion.findMany({
          where: { platform, isPublished: true },
          orderBy: { createdAt: 'desc' },
          take: 5,
        })
        const target = candidates[0]
        if (!target) continue
        const existingRows = await db.appVersionDelta.count({ where: { platform } })
        if (existingRows > 0) continue // chain already alive — nothing to heal
        const preds = await db.appVersion.findMany({
          where: { platform, id: { not: target.id } },
          orderBy: { createdAt: 'desc' },
          take: 1,
        })
        if (preds.length === 0) continue // first release — nothing to diff against
        console.log(`[app-version-deltas] boot self-heal: platform ${platform} has no delta rows — rebuilding hops for v${target.version}`)
        const results = await generateDeltasForVersion(target.id, { limit: 3 })
        const ok = results.filter((r) => r.ok).length
        const refused = results.filter((r) => !r.ok)
        console.log(`[app-version-deltas] boot self-heal: ${platform} v${target.version} → ${ok} hop(s) generated, ${refused.length} refused${refused.length ? ` (${refused.map((r) => `${r.from}:${r.reason}`).join(', ')})` : ''}`)
      } catch (err) {
        console.warn(`[app-version-deltas] boot self-heal: ${platform} failed:`, (err as Error).message)
      }
    }
  }
  setTimeout(() => { run().catch(() => { /* guarded per platform */ }) }, 45_000).unref?.()
}
