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

export interface VersionRowLike {
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
}

function resolveStored(key: string | null | undefined): string | null {
  if (!key) return null
  const root = path.resolve(DELTA_DIR)
  const full = path.resolve(root, key)
  if (!full.startsWith(root + path.sep)) return null
  try { return fs.statSync(full).isFile() ? full : null } catch { return null }
}

/**
 * Regenerating a hop writes a NEW timestamped patch file; without this the
 * replaced one would orphan on disk forever (and resurface as "unknown
 * platform" clutter in the storage inventory).
 */
async function unlinkReplacedPatch(platform: string, fromVersion: string, toVersion: string, newKey: string): Promise<void> {
  try {
    const prev = await db.appVersionDelta.findUnique({
      where: { platform_fromVersion_toVersion: { platform, fromVersion, toVersion } },
      select: { fileStorageKey: true },
    })
    if (prev?.fileStorageKey && prev.fileStorageKey !== newKey) {
      const old = resolveStored(prev.fileStorageKey)
      if (old) { try { fs.unlinkSync(old) } catch { /* best effort */ } }
    }
  } catch { /* cosmetic only — never block generation */ }
}

/** Build + persist the delta row for (prev → cur). Returns null when impossible. */
export async function generateDeltaBetween(
  prev: VersionRowLike,
  cur: VersionRowLike,
): Promise<{ ok: true; deltaId: string; size: number } | { ok: false; reason: string }> {
  const platform = cur.platform
  if (platform !== prev.platform) return { ok: false, reason: 'platform-mismatch' }

  try {
    if (DESKTOP_PLATFORMS.has(platform)) {
      // ── Desktop: asar delta + out tree patch, wrapped in a release patch ──
      if (!prev.asarStorageKey || !cur.asarStorageKey) return { ok: false, reason: 'missing-asar-ref' }
      if (!prev.outrefStorageKey || !cur.outrefStorageKey) return { ok: false, reason: 'missing-outref-ref' }
      if ((cur.runtimeKey || '') !== (prev.runtimeKey || '')) return { ok: false, reason: 'runtime-key-changed' }
      if ((cur.nativeFingerprint || '') !== (prev.nativeFingerprint || '')) return { ok: false, reason: 'native-bits-changed' }

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

      await unlinkReplacedPatch(platform, prev.version, cur.version, key)
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
      return { ok: true, deltaId: row.id, size: patch.length }
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

      await unlinkReplacedPatch(platform, prev.version, cur.version, key)
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
 */
export async function generateDeltasForVersion(curId: string): Promise<Array<{ from: string; to: string; size: number; ok: boolean; reason?: string }>> {
  const cur = await db.appVersion.findUnique({ where: { id: curId } })
  if (!cur) return []
  // Predecessor lookup IGNORES isPublished on purpose: the activate
  // transaction unpublishes every sibling BEFORE delta generation runs, so a
  // "published only" filter would never find the immediately-previous
  // release — the most valuable hop. What matters for a delta base is the
  // REFERENCE ARTIFACTS (asar/outref/apk), not the publication flag.
  const predecessors = await db.appVersion.findMany({
    where: { platform: cur.platform, id: { not: cur.id } },
    orderBy: { createdAt: 'desc' },
    take: 10,
  })
  const results: Array<{ from: string; to: string; size: number; ok: boolean; reason?: string }> = []
  for (const prev of predecessors) {
    // Only build hops that move FORWARD in semver terms.
    if (compareVersionStrings(prev.version, cur.version) >= 0) continue
    const r = await generateDeltaBetween(prev as VersionRowLike, cur as VersionRowLike)
    results.push(r.ok
      ? { from: prev.version, to: cur.version, size: r.size, ok: true }
      : { from: prev.version, to: cur.version, size: 0, ok: false, reason: r.reason })
  }
  return results
}

/**
 * Delta Update Manager (0.6.33) — does a stored artifact key resolve to a
 * REAL file on disk right now? The manager UI shows artifact availability
 * badges from this (a DB key pointing at a deleted file must not count).
 */
export function storedArtifactExists(key: string | null | undefined): boolean {
  return !!resolveStored(key)
}

/**
 * Delta Update Manager (0.6.33) — DRY-RUN eligibility for a (prev → cur) hop.
 * Mirrors the guards inside generateDeltaBetween WITHOUT generating anything:
 *   desktop → both ends need asar + outref refs ON DISK + identical
 *             runtimeKey AND nativeFingerprint
 *   android → both ends need the APK file ON DISK + a recorded hash
 * The manager UI calls this per version to render WHY a hop is possible or
 * blocked BEFORE the admin commits to generation.
 */
export async function evaluateDeltaEligibility(
  prev: VersionRowLike,
  cur: VersionRowLike,
): Promise<{ ok: boolean; reason?: string }> {
  const platform = cur.platform
  if (platform !== prev.platform) return { ok: false, reason: 'platform-mismatch' }
  // A hop only makes sense FORWARD in semver terms (never downgrade).
  if (compareVersionStrings(prev.version, cur.version) >= 0) return { ok: false, reason: 'not-forward' }

  if (DESKTOP_PLATFORMS.has(platform)) {
    if (!prev.asarStorageKey || !cur.asarStorageKey) return { ok: false, reason: 'missing-asar-ref' }
    if (!prev.outrefStorageKey || !cur.outrefStorageKey) return { ok: false, reason: 'missing-outref-ref' }
    if ((cur.runtimeKey || '') !== (prev.runtimeKey || '')) return { ok: false, reason: 'runtime-key-changed' }
    if ((cur.nativeFingerprint || '') !== (prev.nativeFingerprint || '')) return { ok: false, reason: 'native-bits-changed' }
    if (!resolveStored(prev.asarStorageKey) || !resolveStored(cur.asarStorageKey)
      || !resolveStored(prev.outrefStorageKey) || !resolveStored(cur.outrefStorageKey)) {
      return { ok: false, reason: 'ref-file-missing' }
    }
    return { ok: true }
  }

  if (APK_PLATFORMS.has(platform)) {
    if (!prev.fileStorageKey || !cur.fileStorageKey) return { ok: false, reason: 'missing-apk' }
    if (!prev.fileHash || !cur.fileHash) return { ok: false, reason: 'missing-apk-hash' }
    if (!resolveStored(prev.fileStorageKey) || !resolveStored(cur.fileStorageKey)) {
      return { ok: false, reason: 'apk-file-missing' }
    }
    return { ok: true }
  }

  return { ok: false, reason: 'platform-unsupported' }
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
 */
export async function computeDeltaChain(platform: string, fromVersion: string, toVersionId: string) {
  const target = await db.appVersion.findUnique({ where: { id: toVersionId } })
  if (!target || target.platform !== platform) return null
  if (compareVersionStrings(fromVersion, target.version) >= 0) return null

  const edges = await db.appVersionDelta.findMany({ where: { platform } })
  if (edges.length === 0) return null

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
  return null
}

export { readOutrefHeader, createOutref }
