import { timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { db } from '@blasti/db'
import { requireAdmin, authErrorResponse } from '../lib/auth'
import { auditLog } from '../lib/audit'
import { STORAGE_ROOT } from '../lib/storage'
import { z } from 'zod'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { Readable } from 'stream'
// Performance Round — public-download cache invalidation + streaming response.
import { invalidateResponseCacheTag } from '../lib/response-cache'
// r20-3(a): CI-published rows carry versionCode 0 — rank "latest" by semantic
// name when the code is meaningless, else the old admin row (code 5000)
// permanently shadowed newer CI builds and devices were told "up to date".
import { pickLatestAppVersion } from '../lib/app-version-rank'
// Delta Updates (0.6.30) — differential patch graph + generation
import { computeDeltaChain, generateDeltasForVersion, compareVersionStrings, diagnoseDeltaHop, fingerprintSpecOf } from '../lib/app-version-deltas'
// 0.6.59 — the running API's version for the delta-health report
const API_VERSION = (
  JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')) as { version?: string }
).version ?? 'unknown'
// API Compatibility Map (0.6.31) — app↔server capability matrix
import { evaluateCompatibility, seedDefaultGates, CURRENT_SERVER_API_LEVEL, MIN_SUPPORTED_API_LEVEL } from '../lib/api-compat'

const app = new Hono()

// ─── Deploy-token auth (CI / automation) ────────────────────────────────────
//
// Installers can be uploaded not only by an admin in Public Apps Settings,
// but also by CI (GitHub Actions) using the shared DEPLOY_TOKEN from
// /etc/blasti/blasti.env. Requests with a valid `x-deploy-token` header
// bypass the admin session check; everyone else still needs an admin
// session. If no token is configured the header is simply ignored.

const DEPLOY_TOKEN = () => process.env.BLASTI_DEPLOY_TOKEN || process.env.DEPLOY_TOKEN || ''

async function requireAdminOrDeployToken(c: Context): Promise<void> {
  const expected = DEPLOY_TOKEN()
  const provided = c.req.header('x-deploy-token')
  // P0-3: constant-time compare — the deploy token authenticates CI uploads.
  if (expected && provided && safeEqual(provided, expected)) return
  await requireAdmin(c)
}

// P0-3: constant-time string comparison for secrets.
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) {
    const n = Math.min(ab.length, bb.length) || 1
    timingSafeEqual(ab.subarray(0, n), ab.subarray(0, n))
    return false
  }
  return timingSafeEqual(ab, bb)
}

// ─── Validation Schemas ─────────────────────────────────────────────────────

const createAppVersionSchema = z.object({
  // 'android-debug' = debug-keystore APK channel (installable on any device
  // without signing secrets) — admin-internal, never served to update checks.
  platform: z.enum(['android', 'android-debug', 'ios', 'electron', 'windows', 'mac', 'linux']),
  version: z.string().min(1).max(50).regex(/^\d+\.\d+\.\d+/, 'Version must be semver (e.g. 1.2.3)'),
  versionCode: z.number().int().min(0).default(0),
  releaseNotes: z.string().default(''),
  releaseNotesAr: z.string().optional(),
  releaseNotesFr: z.string().optional(),
  isMandatory: z.boolean().default(false),
  isPublished: z.boolean().default(false),
  isPatch: z.boolean().default(false),
  downloadUrl: z.string().default(''),
  minAppVersion: z.string().optional(),
  // API Compatibility Map (0.6.31): the API protocol level this build speaks
  // + whether the release is server-side only (apps skip it entirely).
  apiLevel: z.number().int().min(0).optional(),
  serverOnly: z.boolean().optional(),
})

const updateAppVersionSchema = z.object({
  version: z.string().min(1).max(50).regex(/^\d+\.\d+\.\d+/).optional(),
  versionCode: z.number().int().min(0).optional(),
  releaseNotes: z.string().optional(),
  releaseNotesAr: z.string().nullable().optional(),
  releaseNotesFr: z.string().nullable().optional(),
  isMandatory: z.boolean().optional(),
  isPublished: z.boolean().optional(),
  isPatch: z.boolean().optional(),
  downloadUrl: z.string().optional(),
  minAppVersion: z.string().nullable().optional(),
  apiLevel: z.number().int().min(0).nullable().optional(),
  serverOnly: z.boolean().optional(),
})

// ─── Upload directory ───────────────────────────────────────────────────────
//
// Round 15 storage audit FIX: app binaries used to be written into
// os.tmpdir()/blasti-app-uploads — a directory the OS may WIPE on reboot,
// silently breaking every previously uploaded binary. Binaries now live in
// the central storage root (lib/storage.ts) under the app-versions bucket.
// Reads fall back to the legacy tmpdir location so binaries uploaded before
// this change keep downloading until re-uploaded.

const UPLOAD_DIR = path.join(STORAGE_ROOT, 'app-versions')
const LEGACY_UPLOAD_DIR = path.join(os.tmpdir(), 'blasti-app-uploads')

// Group folders inside the app-versions bucket — mirrors the repo's
// installer/<desktop|mobile> layout, so the admin Storage Manager shows the
// same desktop/ + mobile/ split under the app-versions category.
const PLATFORM_GROUP: Record<string, 'desktop' | 'mobile'> = {
  windows: 'desktop',
  electron: 'desktop',
  mac: 'desktop',
  linux: 'desktop',
  android: 'mobile',
  'android-debug': 'mobile',
  ios: 'mobile',
}

function ensureUploadDir() {
  if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true })
  }
}

/**
 * Resolve a stored binary. `storageKey` may be grouped ("desktop/<name>",
 * current layout) or flat ("<name>", binaries uploaded before grouping).
 * Legacy tmpdir is checked last so pre-Round-15 binaries keep downloading.
 */
function resolveBinaryPath(storageKey: string): string | null {
  const root = path.resolve(UPLOAD_DIR)
  const organized = path.resolve(root, storageKey)
  if (organized.startsWith(root + path.sep) && fs.existsSync(organized)) return organized
  const legacyRoot = path.resolve(LEGACY_UPLOAD_DIR)
  const legacy = path.resolve(legacyRoot, storageKey)
  if (legacy.startsWith(legacyRoot + path.sep) && fs.existsSync(legacy)) return legacy
  return null
}

// ─── Bucket file classification (shared) ───────────────────────────────────
//
// ONE parser for every artifact naming convention this server writes:
//   installer  <platform>-<semver>-<ts>-<original>            (POST /upload)
//   ref        (asar|outref)-<platform>-<semver>-<ts>-<orig>  (release-refs)
//   delta      delta-<platform>-<from>-to-<to>-<ts>.patch     (delta generator)
//
// 'android-debug' is tested before 'android' (longer prefix wins) so a debug
// name can never be swallowed by the plain-android pattern. Files matching NO
// convention fall through to the TOLERANT parser below — the bucket also
// holds RAW artifacts pushed before the naming convention existed (CI copies
// like "BLASTI-Setup-0.6.30.exe", "BLASTI-v0.6.30-debug.apk", "*.blockmap")
// and those MUST stay version-cleanable: the 0.6.40-and-older range delete
// used to skip every one of them (they were invisible to the scope planner)
// while the registry-based UI only offered the newest rows.
// Without the strict parser half, every delta patch and release reference
// landed in the admin storage views as "unknown platform" (120 of 163 files
// once); without the tolerant half, every pre-convention installer did.

const PLATFORMS_DESC = ['android-debug', 'android', 'ios', 'electron', 'windows', 'mac', 'linux']

export interface BucketFileClass {
  kind: 'installer' | 'ref' | 'delta'
  platform: string
  /** installer/ref: the artifact's own version. delta: the version patched FROM. */
  version: string
  /** delta only: the version the patch updates TO. */
  versionTo?: string
}

function classifyBucketFile(baseName: string): BucketFileClass | null {
  for (const platform of PLATFORMS_DESC) {
    const md = new RegExp(`^delta-${platform}-(\\d+\\.\\d+\\.\\d+)-to-(\\d+\\.\\d+\\.\\d+)-\\d+\\.patch$`).exec(baseName)
    if (md) return { kind: 'delta', platform, version: md[1], versionTo: md[2] }
    const mr = new RegExp(`^(?:asar|outref)-${platform}-(\\d+\\.\\d+\\.\\d+)-\\d+-.+`).exec(baseName)
    if (mr) return { kind: 'ref', platform, version: mr[1] }
    const mi = new RegExp(`^${platform}-(\\d+\\.\\d+\\.\\d+)-\\d+-.+$`).exec(baseName)
    if (mi) return { kind: 'installer', platform, version: mi[1] }
  }
  return classifyLooseBucketFile(baseName)
}

// ─── Tolerant fallback (raw / pre-convention artifacts) ─────────────────────

/** First "X.Y.Z" token (1–2 digits per part) NOT embedded in a longer number
 *  — "BLASTI-Setup-0.6.30.exe" → 0.6.30, "BLASTI-v0.6.30-debug.apk" → 0.6.30.
 *  Date-like tokens (2026.01.15) never match (4-digit year is too long). */
const SEMVER_TOKEN_RE = /(?<!\d)(\d{1,2}\.\d{1,2}\.\d{1,2})(?!\d|\.\d)/

/** Legacy delta naming variants (no push timestamp): delta-<p>-<a>-to-<b>(-ts)?.patch */
const LOOSE_DELTA_RE = /^delta-([a-z-]+?)-(\d{1,2}\.\d{1,2}\.\d{1,2})-to-(\d{1,2}\.\d{1,2}\.\d{1,2})(?:-\d+)?\.patch$/i

/** Platform from a name TOKEN (checked before extensions; most specific first). */
const PLATFORM_TOKENS: Array<[RegExp, string]> = [
  [/android-debug/, 'android-debug'],
  [/android|[^a-z]apk|[^a-z]apk$/, 'android'],
  [/(^|[^a-z])ios($|[^a-z])|[^a-z]ipa/, 'ios'],
  [/(^|[^a-z])(win32|win64|win|windows|nsis)($|[^a-z])/, 'windows'],
  [/(^|[^a-z])(mac|macos|osx|darwin)($|[^a-z])/, 'mac'],
  [/(^|[^a-z])(linux|appimage|debian)($|[^a-z])/, 'linux'],
  [/electron/, 'electron'],
]

/** Platform from the file EXTENSION (raw installer artifacts). */
const PLATFORM_EXTS: Array<[RegExp, string]> = [
  [/\.apk$/, 'android'],
  [/\.ipa$/, 'ios'],
  [/\.exe$|\.msi$/, 'windows'],
  [/\.dmg$|\.pkg$|\.app\.zip$|\.mac\.zip$/, 'mac'],
  [/\.appimage$|\.deb$|\.rpm$|\.snap$/, 'linux'],
]

function platformFromName(lower: string): string | null {
  for (const [re, platform] of PLATFORM_TOKENS) if (re.test(lower)) return platform
  return null
}

function platformFromExtension(lower: string): string | null {
  for (const [re, platform] of PLATFORM_EXTS) if (re.test(lower)) return platform
  return null
}

/**
 * Best-effort classification of files the strict conventions above reject:
 *   BLASTI-Setup-0.6.30.exe            → windows installer 0.6.30 (.exe)
 *   BLASTI-v0.6.30-debug.apk           → android-debug installer (.apk+debug)
 *   Blasti-0.6.30-arm64-mac.zip        → mac (token) installer
 *   BLASTI-Setup-0.6.30.exe.blockmap   → windows ref (blockmap artifact)
 *   delta-android-0.6.40-to-0.6.41.patch → legacy delta (no ts suffix)
 * Files with NO version token classify null on purpose — channel metadata
 * (latest.yml and friends) advertises the CURRENT release and must survive
 * every "old versions" sweep.
 */
function classifyLooseBucketFile(baseName: string): BucketFileClass | null {
  const lower = baseName.toLowerCase()

  const legacyDelta = LOOSE_DELTA_RE.exec(lower)
  if (legacyDelta && PLATFORMS_DESC.includes(legacyDelta[1])) {
    return { kind: 'delta', platform: legacyDelta[1], version: legacyDelta[2], versionTo: legacyDelta[3] }
  }

  const vm = SEMVER_TOKEN_RE.exec(lower)
  if (!vm) return null
  const version = vm[1]

  // .blockmap is a differential-download companion of a specific build — a
  // release REFERENCE, not an installer; resolve the platform from the inner
  // extension ("BLASTI-Setup-0.6.30.exe.blockmap" → .exe → windows).
  const isBlockmap = lower.endsWith('.blockmap')
  const probe = isBlockmap ? lower.slice(0, -'.blockmap'.length) : lower
  let platform = platformFromName(probe) ?? platformFromExtension(probe)
  // Debug APK convention ("BLASTI-v0.6.30-debug.apk") — same rule as the
  // storage-files extension fallback, so both views always agree.
  if (platform === 'android' && lower.includes('debug')) platform = 'android-debug'
  if (!platform) return null
  return { kind: isBlockmap ? 'ref' : 'installer', platform, version }
}

interface BucketFile {
  storageKey: string
  name: string
  /** 'desktop' | 'mobile' | '' (legacy flat root). */
  group: string
  size: number
  mtimeMs: number
}

/** LIVE walk of the app-versions bucket (group folders + legacy flat root). */
async function walkBucket(): Promise<BucketFile[]> {
  const root = path.resolve(UPLOAD_DIR)
  const out: BucketFile[] = []
  let entries: fs.Dirent[] = []
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true })
  } catch {
    return out // bucket missing — empty list
  }
  const stat = async (abs: string, group: string, name: string) => {
    try {
      const st = await fs.promises.stat(abs)
      if (!st.isFile()) return
      out.push({ storageKey: group ? `${group}/${name}` : name, name, group, size: st.size, mtimeMs: st.mtimeMs })
    } catch { /* raced delete — skip */ }
  }
  for (const e of entries) {
    if (e.isFile()) {
      await stat(path.join(root, e.name), '', e.name) // legacy flat binaries
    } else if (e.isDirectory()) {
      let inner: fs.Dirent[] = []
      try {
        inner = await fs.promises.readdir(path.join(root, e.name), { withFileTypes: true })
      } catch { continue }
      for (const f of inner) {
        if (f.isFile()) await stat(path.join(root, e.name, f.name), e.name, f.name)
      }
    }
  }
  return out
}

// ─── GET /app-versions — List all app versions ──────────────────────────────

app.get('/', async (c) => {
  try {
    await requireAdmin(c)

    const platform = c.req.query('platform')
    const published = c.req.query('published')

    const where: any = {}
    if (platform) where.platform = platform
    if (published === 'true') where.isPublished = true
    if (published === 'false') where.isPublished = false

    const versions = await db.appVersion.findMany({
      where,
      orderBy: [{ platform: 'asc' }, { createdAt: 'desc' }],
    })

    return c.json({ success: true, versions })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── GET /app-versions/latest — Get latest published version for each platform

app.get('/latest', async (c) => {
  try {
    await requireAdmin(c)

    const platforms = ['android', 'android-debug', 'ios', 'electron', 'windows', 'mac', 'linux'] as const
    const latest: Record<string, any> = {}

    for (const platform of platforms) {
      const version = await db.appVersion.findFirst({
        where: { platform, isPublished: true },
        orderBy: { createdAt: 'desc' },
      })
      latest[platform] = version
    }

    return c.json({ success: true, latest })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── GET /app-versions/check — PUBLIC update check (Task 47-b) ─────────────
//
// Query params: platform (android|ios|electron|windows|mac|linux), version.
// Compares the provided version against the latest PUBLISHED version for the
// platform (ordered by versionCode desc, then createdAt desc).
//
// IMPORTANT: this must stay PUBLIC (no requireAdmin) and be registered
// BEFORE the GET /:id route below — Hono matches routes in registration
// order and /check would otherwise be captured by the /:id handler.

app.get('/check', async (c) => {
  try {
    const platform = c.req.query('platform')
    const version = c.req.query('version')

    if (!platform || !version) {
      return c.json({ success: false, error: 'platform and version query params are required' }, 400)
    }

    const latestCandidates = await db.appVersion.findMany({
      where: { platform, isPublished: true },
      orderBy: { createdAt: 'desc' },
      take: 50,
    })
    const latestVersion = pickLatestAppVersion(latestCandidates)

    const updateAvailable = !!latestVersion && compareVersions(latestVersion.version, version) > 0

    // ── Delta Updates (0.6.30) — resolve the hop chain for THIS client ──────
    // A device several versions behind receives the shortest verified chain
    // (client version → latest); it applies the hops sequentially and falls
    // back to the full installer on the first verification failure. Clients
    // that predate deltas simply ignore the extra field.
    // 0.6.52 — when no chain resolves, `deltaUnavailableReason` names exactly
    // WHY (no-deltas-published / no-verifiable-chain / …) so clients can log
    // the refusal and "only full installers" becomes diagnosable.
    let delta: Record<string, unknown> | null = null
    let deltaUnavailableReason = ''
    if (updateAvailable && latestVersion) {
      try {
        const { chain, reason } = await computeDeltaChain(platform, version, latestVersion.id)
        if (chain && chain.hops.length >= 1) {
          delta = {
            supported: true,
            kind: chain.hops.length > 1 ? 'chain' : chain.hops[0].kind,
            runtimeKey: chain.runtimeKey,
            nativeFingerprint: chain.nativeFingerprint,
            targetAsarSha256: chain.targetAsarSha256,
            targetApkSha256: chain.targetApkSha256,
            totalSize: chain.hops.reduce((sum, h) => sum + (h.size || 0), 0),
            hops: chain.hops,
          }
        } else {
          deltaUnavailableReason = reason || 'unknown'
        }
      } catch { /* delta resolution must never break the basic check */ }
    }

    return c.json({
      success: true,
      platform,
      currentVersion: version,
      latestVersion: latestVersion?.version ?? '',
      versionCode: latestVersion?.versionCode ?? 0,
      updateAvailable,
      isMandatory: updateAvailable ? (latestVersion?.isMandatory ?? false) : false,
      downloadUrl: updateAvailable ? (latestVersion?.downloadUrl ?? '') : '',
      releaseNotes: latestVersion?.releaseNotes ?? '',
      releaseNotesAr: latestVersion?.releaseNotesAr ?? '',
      releaseNotesFr: latestVersion?.releaseNotesFr ?? '',
      // App-update delivery (desktop in-app downloader + Android APK install):
      // file metadata so clients can render progress + verify before install.
      fileSize: updateAvailable ? (latestVersion?.fileSize ?? 0) : 0,
      fileHash: updateAvailable ? (latestVersion?.fileHash ?? '') : '',
      fileName: updateAvailable ? (latestVersion?.fileName ?? '') : '',
      isPatch: updateAvailable ? (latestVersion?.isPatch ?? false) : false,
      minAppVersion: updateAvailable ? (latestVersion?.minAppVersion ?? '') : '',
      // Differential update offer (null/absent on older servers → full install)
      delta,
      // 0.6.52 — WHY the offer above is null (empty string when a chain IS
      // offered or no update is available). Clients log it verbatim.
      deltaUnavailableReason: delta ? '' : deltaUnavailableReason,
      // API COMPATIBILITY MAP (0.6.31) — the same evaluation the dedicated
      // /compat endpoint returns, embedded in the boot-time check so apps get
      // "can I run / what is blocked / is the update required or server-only"
      // in ONE round trip. Absent on older servers → clients ignore it.
      compat: await (async () => {
        try {
          const apiLevelRaw = c.req.query('apiLevel')
          const appApiLevel = apiLevelRaw != null && apiLevelRaw !== '' && !Number.isNaN(Number(apiLevelRaw)) ? Number(apiLevelRaw) : null
          return await evaluateCompatibility(version, appApiLevel, platform)
        } catch { return null }
      })(),
    })
  } catch (error: unknown) {
    return c.json({ success: false, error: 'Update check failed' }, 500)
  }
})

// ─── GET /app-versions/compat — PUBLIC compatibility evaluation ───────────
//
// THE COMPATIBILITY MAP CHECK (0.6.31): "can this app version run with the
// current server API version, which functions cannot run unless the app is
// updated, when is an update ABSOLUTELY required, and when is the update
// just for the server (apps keep running)?" One public call, no session:
//   GET /api/app-versions/compat?platform=windows&version=0.6.29&apiLevel=1
// The same evaluation is embedded in GET /check (the boot-time call), this
// endpoint exposes the FULL map for UIs, admin tooling and diagnostics.

app.get('/compat', async (c) => {
  try {
    const platform = c.req.query('platform') || 'windows'
    const version = c.req.query('version')
    if (!version) return c.json({ success: false, error: 'version query param is required' }, 400)
    const apiLevelRaw = c.req.query('apiLevel')
    const appApiLevel = apiLevelRaw != null && apiLevelRaw !== '' && !Number.isNaN(Number(apiLevelRaw)) ? Number(apiLevelRaw) : null
    const compat = await evaluateCompatibility(version, appApiLevel, platform)
    return c.json({ success: true, platform, compat })
  } catch (error: unknown) {
    return c.json({ success: false, error: 'Compatibility check failed' }, 500)
  }
})

// ─── GET /app-versions/compat/map — the full map (admin) ────────────────────
// Every gate + a per-platform evaluation matrix for the most recent client
// versions — the admin "Compatibility" tab renders this directly.

app.get('/compat/map', async (c) => {
  try {
    await requireAdmin(c)
    const gates = await db.apiFeatureGate.findMany({ orderBy: { feature: 'asc' } })
    const matrix: Record<string, unknown> = {}
    for (const platform of ['windows', 'android']) {
      const candidates = await db.appVersion.findMany({
        where: { platform, isPublished: true },
        orderBy: { createdAt: 'desc' },
        take: 6,
      })
      const rows = []
      for (const v of candidates) {
        const compat = await evaluateCompatibility(v.version, v.apiLevel ?? null, platform)
        rows.push({
          version: v.version,
          apiLevel: v.apiLevel,
          serverOnly: v.serverOnly,
          compatible: compat.compatible,
          updateRequired: compat.updateRequired,
          serverOnlyUpdate: compat.serverOnlyUpdate,
          blocked: compat.blockedFeatures.map((g) => ({ feature: g.feature, severity: g.severity })),
        })
      }
      matrix[platform] = rows
    }
    return c.json({
      success: true,
      serverApiLevel: CURRENT_SERVER_API_LEVEL,
      minSupportedApiLevel: MIN_SUPPORTED_API_LEVEL,
      gates,
      matrix,
    })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

const gateSchema = z.object({
  feature: z.string().min(2).max(80).regex(/^[a-z0-9-]+$/),
  minAppVersion: z.string().regex(/^\d+\.\d+\.\d+/),
  severity: z.enum(['critical', 'soft', 'server']).default('soft'),
  apiLevel: z.number().int().min(0).default(0),
  description: z.string().max(500).default(''),
  descriptionAr: z.string().max(500).nullable().optional(),
  descriptionFr: z.string().max(500).nullable().optional(),
  enabled: z.boolean().default(true),
})

app.post('/compat/gates', async (c) => {
  try {
    await requireAdmin(c)
    const parsed = gateSchema.safeParse(await c.req.json())
    if (!parsed.success) return c.json({ success: false, error: 'Invalid gate', details: parsed.error.issues }, 400)
    const gate = await db.apiFeatureGate.upsert({
      where: { feature: parsed.data.feature },
      create: parsed.data,
      update: parsed.data,
    })
    return c.json({ success: true, gate })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

app.delete('/compat/gates/:id', async (c) => {
  try {
    await requireAdmin(c)
    await db.apiFeatureGate.delete({ where: { id: c.req.param('id') } })
    return c.json({ success: true })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── POST /app-versions — Create a new app version ──────────────────────────

app.post('/', async (c) => {
  try {
    await requireAdminOrDeployToken(c)

    const body = await c.req.json()
    const validation = createAppVersionSchema.safeParse(body)
    if (!validation.success) {
      return c.json({ success: false, error: 'Invalid input', details: validation.error.issues }, 400)
    }

    const data = validation.data

    // Check for duplicate platform+version
    const existing = await db.appVersion.findUnique({
      where: { platform_version: { platform: data.platform, version: data.version } },
    })
    if (existing) {
      return c.json({ success: false, error: 'Version already exists for this platform' }, 409)
    }

    const appVersion = await db.appVersion.create({
      data: {
        platform: data.platform,
        version: data.version,
        versionCode: data.versionCode,
        releaseNotes: data.releaseNotes,
        releaseNotesAr: data.releaseNotesAr,
        releaseNotesFr: data.releaseNotesFr,
        isMandatory: data.isMandatory,
        isPublished: data.isPublished,
        isPatch: data.isPatch,
        downloadUrl: data.downloadUrl,
        minAppVersion: data.minAppVersion,
        apiLevel: data.apiLevel,
        serverOnly: data.serverOnly ?? false,
        publishedAt: data.isPublished ? new Date() : null,
      },
    })

    return c.json({ success: true, version: appVersion })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── POST /app-versions/upload — Upload an app binary ──────────────────────

app.post('/upload', async (c) => {
  try {
    await requireAdminOrDeployToken(c)

    ensureUploadDir()

    const formData = await c.req.formData()
    const file = formData.get('file') as File | null
    const platform = formData.get('platform') as string | null
    const version = formData.get('version') as string | null
    // create=1 (form field or query): CI convenience — auto-create the
    // version record when it does not exist yet, so one multipart call
    // both registers the version and attaches the binary.
    const autoCreate =
      formData.get('create') === '1' || formData.get('create') === 'true' || c.req.query('create') === '1'

    if (!file) {
      return c.json({ success: false, error: 'No file provided' }, 400)
    }

    if (!platform || !version) {
      return c.json({ success: false, error: 'Platform and version are required' }, 400)
    }

    if (!['android', 'android-debug', 'ios', 'electron', 'windows', 'mac', 'linux'].includes(platform)) {
      return c.json({ success: false, error: 'Invalid platform' }, 400)
    }
    if (!/^\d+\.\d+\.\d+/.test(version)) {
      return c.json({ success: false, error: 'Version must be semver (e.g. 1.2.3)' }, 400)
    }

    // Save into the bucket's group folder (app-versions/desktop|mobile/<file>)
    // — the Storage Manager renders these groups like the repo installer/ split.
    const group = PLATFORM_GROUP[platform] ?? 'desktop'
    const safeName = `${group}/${platform}-${version}-${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`
    const filePath = path.join(UPLOAD_DIR, safeName)

    const buffer = Buffer.from(await file.arrayBuffer())
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, buffer)

    // Calculate file hash for integrity
    const hash = crypto.createHash('sha256').update(buffer).digest('hex')

    // Update the app version record with file info (create it first when
    // requested — used by CI uploads of brand-new versions)
    let appVersion = await db.appVersion.findUnique({
      where: { platform_version: { platform, version } },
    })

    if (!appVersion && autoCreate) {
      const versionCodeRaw = formData.get('versionCode')
      const versionCode = versionCodeRaw ? parseInt(String(versionCodeRaw), 10) || 0 : 0
      const notes = String(formData.get('releaseNotes') ?? '')
      const apiLevelRaw = formData.get('apiLevel')
      const serverOnlyRaw = String(formData.get('serverOnly') ?? '')
      appVersion = await db.appVersion.create({
        data: {
          platform,
          version,
          versionCode,
          releaseNotes: notes.slice(0, 2000),
          isPublished: false, // CI uploads land as drafts — an admin activates them
          // API Compatibility Map (0.6.31) — CI stamps the build's API level;
          // serverOnly=1 marks releases installed apps can skip entirely.
          apiLevel: apiLevelRaw ? parseInt(String(apiLevelRaw), 10) || null : null,
          serverOnly: serverOnlyRaw === '1' || serverOnlyRaw === 'true',
        },
      })
    }

    if (!appVersion) {
      return c.json({ success: false, error: 'App version record not found. Create the version first, then upload the file.' }, 404)
    }

    const updated = await db.appVersion.update({
      where: { id: appVersion.id },
      data: {
        fileStorageKey: safeName,
        fileStorageProvider: 'local',
        fileName: file.name,
        fileSize: file.size,
        fileHash: hash,
        downloadUrl: `/api/app-versions/${appVersion.id}/download`,
        // Re-stamping on re-upload keeps the compat map honest (idempotent CI).
        ...(formData.get('apiLevel') ? { apiLevel: parseInt(String(formData.get('apiLevel')), 10) || null } : {}),
        ...(String(formData.get('serverOnly') ?? '') === '1' || String(formData.get('serverOnly') ?? '') === 'true' ? { serverOnly: true } : {}),
      },
    })

    // Performance Round — a CI/admin upload may flip availability once
    // activated; clear the landing-page download cache either way (cheap).
    invalidateResponseCacheTag('app-versions')

    return c.json({
      success: true,
      version: updated,
      fileInfo: {
        name: file.name,
        size: file.size,
        type: file.type,
        hash,
      },
    })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── POST /app-versions/:id/release-refs — upload delta reference artifacts ──
//
// CI (make-release-refs.mjs / publish-installer.mjs) attaches THIS release's
// diffable references right after uploading the installer:
//   desktop: asar (win-unpacked/resources/app.asar) + outref (tree archive
//            of resources/app.asar.unpacked) + runtimeKey + nativeFingerprint
//   android: nothing extra — the APK itself is the base
// On success the API immediately tries to build the delta patch vs the
// previous published release so the update is differential from day one.

app.post('/:id/release-refs', async (c) => {
  try {
    await requireAdminOrDeployToken(c)
    ensureUploadDir()

    const appVersion = await db.appVersion.findUnique({ where: { id: c.req.param('id') } })
    if (!appVersion) return c.json({ success: false, error: 'Version not found' }, 404)

    const formData = await c.req.formData()
    const runtimeKey = String(formData.get('runtimeKey') ?? '').slice(0, 80)
    const nativeFingerprint = String(formData.get('nativeFingerprint') ?? '').slice(0, 80)
    // 0.6.58 — CI uploads BOTH fingerprint scopes (see make-release-refs.mjs):
    // nativeFingerprint = new scope (patchable copies excluded),
    // legacyNativeFingerprint = the pre-0.6.58 broader hash so hops against
    // older rows keep a consistent comparison basis.
    const legacyNativeFingerprint = String(formData.get('legacyNativeFingerprint') ?? '').slice(0, 80)
    // 0.6.59 — WHICH definition nativeFingerprint uses ('v3' = exe-excluded:
    // electron-builder stamps the app version into the exe on every build, so
    // an exe-inclusive hash can never match across two versions). Storing the
    // spec lets compareNativeFingerprints refuse MIXED-spec hops honestly
    // instead of comparing hashes that were never computed over the same
    // file set (the bug behind "native-bits-changed on every hop").
    const fingerprintSpec = String(formData.get('fingerprintSpec') ?? '').slice(0, 20)

    const data: Record<string, string | number> = {}
    if (runtimeKey) data.runtimeKey = runtimeKey
    if (nativeFingerprint) data.nativeFingerprint = nativeFingerprint
    if (legacyNativeFingerprint) data.legacyNativeFingerprint = legacyNativeFingerprint
    if (fingerprintSpec) data.fingerprintSpec = fingerprintSpec

    for (const field of ['asar', 'outref'] as const) {
      const file = formData.get(field) as File | null
      if (!file) continue
      const buffer = Buffer.from(await file.arrayBuffer())
      const safeName = `desktop/${field}-${appVersion.platform}-${appVersion.version}-${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`
      const filePath = path.join(UPLOAD_DIR, safeName)
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, buffer)
      const hash = crypto.createHash('sha256').update(buffer).digest('hex')
      if (field === 'asar') {
        data.asarStorageKey = safeName
        data.asarSha256 = hash
        data.asarSize = buffer.length
      } else {
        data.outrefStorageKey = safeName
        data.outrefSha256 = hash
        data.outrefSize = buffer.length
      }
    }

    if (Object.keys(data).length === 0) {
      return c.json({ success: false, error: 'No reference artifacts provided (asar/outref/runtimeKey/nativeFingerprint)' }, 400)
    }

    const updated = await db.appVersion.update({ where: { id: appVersion.id }, data })

    // Build the patch vs the previous release right away (release-ref uploads
    // only happen once per release — the 7s generation cost is fine here).
    let deltaGeneration: unknown = null
    try {
      const results = await generateDeltasForVersion(appVersion.id)
      deltaGeneration = results
    } catch (err) {
      deltaGeneration = { error: String((err as Error).message || err).slice(0, 200) }
    }

    invalidateResponseCacheTag('app-versions')
    return c.json({ success: true, version: updated, deltaGeneration })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── POST /app-versions/:id/regenerate-deltas — admin rebuild of hop patches ─

app.post('/:id/regenerate-deltas', async (c) => {
  try {
    // 0.6.56 — deploy-token accepted alongside an admin session: rebuilding
    // hop patches is a CI-adjacent repair operation (the token guards the
    // upload of the very artifacts these patches are derived from), and the
    // field incident (no-deltas-published on 0.6.53→0.6.55) needed a
    // token-driven repair script because no admin session exists on the VPS.
    await requireAdminOrDeployToken(c)
    const appVersion = await db.appVersion.findUnique({ where: { id: c.req.param('id') } })
    if (!appVersion) return c.json({ success: false, error: 'Version not found' }, 404)
    // 0.6.58 — ?limit=N caps how many predecessors get hops (1..10). The CI
    // self-heal step passes 3 so the synchronous request stays short on the
    // 2-core VPS; admin repairs and the default use all 10.
    const limitRaw = parseInt(c.req.query('limit') || '', 10)
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined
    // 0.6.59 — ?allowFingerprintRisk=1: consciously override fingerprint
    // refusals (native-bits-changed / fingerprint-scope-mismatch) for hops
    // the operator has verified to be stamp-level-only native diffs. NEVER
    // overrides runtime-key-changed or missing refs. Every overridden hop is
    // marked in the results AND in the APP_VERSION_DELTA_GENERATION audit.
    const riskFlag = String(c.req.query('allowFingerprintRisk') || '').toLowerCase()
    const allowFingerprintRisk = riskFlag === '1' || riskFlag === 'true'
    const results = await generateDeltasForVersion(appVersion.id, { limit, allowFingerprintRisk })
    return c.json({ success: true, results, allowFingerprintRisk })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── GET /app-versions/delta-health — per-hop delta diagnosis (0.6.59) ──────
//
// Answers the operator question "WHY is the VPS still serving full
// installers?" in ONE request, without running any expensive diffing:
//
//   • per delta-capable platform: the latest PUBLISHED target version and
//     whether its own refs are present in the DB AND on disk,
//   • every forward hop to that target: the guard verdicts (refs present,
//     ref FILES on disk, runtimeKey equal, fingerprint comparable) — the
//     exact sequence generateDeltaBetween refuses on,
//   • whether a delta row exists, whether its patch file is on disk, and
//     whether a client on that source version would actually receive a chain
//     (computeDeltaChain — the SAME resolver /check uses),
//   • the last APP_VERSION_DELTA_GENERATION audit outcome per target, so a
//     refusal seen in CI months ago is still visible.
//
// Registered BEFORE GET /:id (Hono matches in registration order).

app.get('/delta-health', async (c) => {
  try {
    await requireAdmin(c)

    const DELTA_PLATFORMS = ['windows', 'mac', 'linux', 'electron', 'android', 'android-debug']
    const requested = c.req.query('platform')
    const platforms = requested && DELTA_PLATFORMS.includes(requested) ? [requested] : DELTA_PLATFORMS

    // Last audit outcome per (entityId = AppVersion id): the 0.6.58
    // observability entry records generated/refused counts + per-hop results.
    const auditRows = await db.auditLog.findMany({
      where: { action: 'APP_VERSION_DELTA_GENERATION' },
      orderBy: { createdAt: 'desc' },
      take: 120,
    })
    const auditByEntity = new Map<string, { at: string; generated: number; refusals: number; results: unknown[] }>()
    for (const row of auditRows) {
      if (!row.entityId || auditByEntity.has(row.entityId)) continue
      try {
        const details = JSON.parse(row.details || '{}') as { generated?: number; refusals?: number; results?: unknown[] }
        auditByEntity.set(row.entityId, {
          at: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
          generated: Number(details.generated ?? 0),
          refusals: Number(details.refusals ?? 0),
          results: Array.isArray(details.results) ? details.results : [],
        })
      } catch { /* malformed details — skip */ }
    }

    const rowLike = (v: Record<string, unknown>) => v as unknown as Parameters<typeof diagnoseDeltaHop>[0]
    const out: unknown[] = []

    for (const platform of platforms) {
      const versions = await db.appVersion.findMany({
        where: { platform },
        orderBy: { createdAt: 'desc' },
        take: 12,
      })
      if (versions.length === 0) continue

      // The chain target = latest PUBLISHED version (exactly what /check serves).
      // `as Record<string, any>`: the generated Prisma types are unavailable in
      // every environment this route compiles in (same class as the /check
      // route above) — the fields below are guarded with ?? null anyway.
      const target = pickLatestAppVersion(
        versions.filter((v: { isPublished?: boolean }) => v.isPublished),
      ) as unknown as Record<string, any>
      if (!target) {
        out.push({ platform, target: null, hops: [], lastAudit: null, note: 'no-published-version' })
        continue
      }

      const deltaRows = (await db.appVersionDelta.findMany({ where: { platform } })) as Array<Record<string, any>>
      const rowsByPair = new Map(deltaRows.map((r) => [`${r.fromVersion}->${r.toVersion}`, r] as const))

      const targetRow = rowLike(target as unknown as Record<string, unknown>)
      const hops: unknown[] = []
      for (const prev of versions as Array<Record<string, any>>) {
        if (prev.id === target.id) continue
        if (compareVersionStrings(prev.version, target.version) >= 0) continue
        const prevRow = rowLike(prev as unknown as Record<string, unknown>)
        const diagnosis = diagnoseDeltaHop(prevRow, targetRow)
        const row = (rowsByPair.get(`${prev.version}->${target.version}`) as Record<string, any> | undefined) || null
        let deltaFileOnDisk: boolean | null = null
        let deltaSizeMatchesDisk: boolean | null = null
        if (row?.fileStorageKey) {
          const p = resolveBinaryPath(row.fileStorageKey)
          deltaFileOnDisk = !!p
          if (p) deltaSizeMatchesDisk = fs.statSync(p).size === row.fileSize
        }
        // The client view: would /check actually hand this source a chain?
        let clientChain: { reachable: boolean; hopCount: number; reason: string } = { reachable: false, hopCount: 0, reason: 'unchecked' }
        try {
          const chain = await computeDeltaChain(platform, prev.version, target.id)
          clientChain = { reachable: !!chain.chain, hopCount: chain.chain?.hops.length ?? 0, reason: chain.reason }
        } catch (e) {
          clientChain = { reachable: false, hopCount: 0, reason: `error:${String((e as Error).message).slice(0, 60)}` }
        }
        hops.push({
          from: prev.version,
          fromVersionId: prev.id,
          fromCreatedAt: prev.createdAt,
          guards: {
            verdict: diagnosis.ok ? 'ready' : 'refused',
            reason: diagnosis.reason ?? null,
            // 0.6.59 — fingerprint refusals are consciously overridable by
            // the operator (allowFingerprintRisk=1) once they verify the hop
            // only differs in version-stamp bits. The UI surfaces this so
            // "native-bits-changed" stops looking like a dead end.
            overridable: diagnosis.ok ? false : !!diagnosis.overridable,
            prevSpec: fingerprintSpecOf(prevRow),
            targetSpec: fingerprintSpecOf(targetRow),
            prevRefs: {
              asarKey: prev.asarStorageKey ?? null,
              outrefKey: prev.outrefStorageKey ?? null,
              apkKey: prev.fileStorageKey ?? null,
              runtimeKey: prev.runtimeKey ?? null,
              nativeFingerprint: prev.nativeFingerprint ?? null,
              legacyNativeFingerprint: (prev as unknown as { legacyNativeFingerprint?: string | null }).legacyNativeFingerprint ?? null,
            },
          },
          deltaRow: row
            ? { id: row.id, fileName: row.fileName, fileSize: row.fileSize, fileHash: row.fileHash, createdAt: row.createdAt }
            : null,
          deltaFileOnDisk,
          deltaSizeMatchesDisk,
          clientChain,
        })
      }

      out.push({
        platform,
        target: {
          id: target.id,
          version: target.version,
          isPublished: target.isPublished,
          publishedAt: target.publishedAt,
          runtimeKey: target.runtimeKey ?? null,
          nativeFingerprint: target.nativeFingerprint ?? null,
          legacyNativeFingerprint: (target as unknown as { legacyNativeFingerprint?: string | null }).legacyNativeFingerprint ?? null,
          fingerprintSpec: (target as unknown as { fingerprintSpec?: string | null }).fingerprintSpec ?? null,
          asarKey: target.asarStorageKey ?? null,
          asarOnDisk: target.asarStorageKey ? !!resolveBinaryPath(target.asarStorageKey) : null,
          outrefKey: target.outrefStorageKey ?? null,
          outrefOnDisk: target.outrefStorageKey ? !!resolveBinaryPath(target.outrefStorageKey) : null,
          apkKey: target.fileStorageKey ?? null,
          apkOnDisk: target.fileStorageKey ? !!resolveBinaryPath(target.fileStorageKey) : null,
        },
        hops,
        totalDeltaRows: deltaRows.length,
        lastAudit: auditByEntity.get(target.id) ?? null,
      })
    }

    return c.json({ success: true, server: { apiVersion: API_VERSION, now: new Date().toISOString() }, platforms: out })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── GET /app-versions/delta/:id/download — PUBLIC delta patch download ────
// Same streaming semantics as /:id/download (Range/resume aware) — the desktop
// parallel downloader depends on it.

app.get('/delta/:id/download', async (c) => {
  try {
    const deltaRow = await db.appVersionDelta.findUnique({ where: { id: c.req.param('id') } })
    if (!deltaRow || !deltaRow.fileStorageKey) {
      return c.json({ success: false, error: 'Delta not found' }, 404)
    }
    const filePath = resolveBinaryPath(deltaRow.fileStorageKey)
    if (!filePath) return c.json({ success: false, error: 'Delta file not found' }, 404)
    let fileStat: fs.Stats
    try {
      fileStat = fs.statSync(filePath)
      if (!fileStat.isFile()) throw new Error('not a file')
    } catch {
      return c.json({ success: false, error: 'Delta file missing on disk' }, 404)
    }

    const fileSize = fileStat.size
    const etag = `W/"${fileSize.toString(16)}-${Math.floor(fileStat.mtimeMs).toString(16)}"`
    const baseHeaders: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${deltaRow.fileName}"`,
      'Accept-Ranges': 'bytes',
      ETag: etag,
      'Cache-Control': 'public, max-age=300',
    }

    const rangeHeader = c.req.header('range')
    let start = 0
    let end = fileSize - 1
    let status = 200
    if (rangeHeader) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim())
      if (m && (m[1] !== '' || m[2] !== '')) {
        if (m[1] === '') {
          const suffix = Math.min(parseInt(m[2], 10), fileSize)
          start = Math.max(0, fileSize - suffix)
          end = fileSize - 1
        } else {
          start = parseInt(m[1], 10)
          end = m[2] === '' ? fileSize - 1 : Math.min(parseInt(m[2], 10), fileSize - 1)
        }
        if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= fileSize) {
          return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${fileSize}` } })
        }
        status = 206
      }
    }

    const headers: Record<string, string> = { ...baseHeaders, 'Content-Length': String(end - start + 1) }
    if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${fileSize}`

    void db.appVersionDelta.update({ where: { id: deltaRow.id }, data: {} }).catch(() => { /* stats optional */ })

    const nodeStream = fs.createReadStream(filePath, { start, end })
    nodeStream.on('error', (err) => {
      console.error('[app-versions] delta stream error:', err.message)
      nodeStream.destroy()
    })
    const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>
    return new Response(webStream, { status, headers })
  } catch (error: unknown) {
    return c.json({ success: false, error: 'Delta download failed' }, 500)
  }
})

// ─── GET /app-versions/public/active — PUBLIC active downloads ────────────
//
// Used by the public landing page download section: returns the ACTIVE
// (published) version per platform so visitors can download the installer
// the admin selected in Public Apps Settings. Metadata only, no secrets.
// 'android-debug' is included so the landing page can offer the debug APK
// as a separate mobile download choice (release = 'android'). Admins choose
// which of the two channels is public via the normal Activate flow.
// NOTE: registered before GET /:id (Hono matches in registration order).

app.get('/public/active', async (c) => {
  try {
    const platforms = ['android', 'android-debug', 'ios', 'electron', 'windows', 'mac', 'linux'] as const
    const versions: Array<Record<string, unknown>> = []

    for (const platform of platforms) {
      const candidates = await db.appVersion.findMany({
        where: { platform, isPublished: true },
        orderBy: { createdAt: 'desc' },
        take: 50,
      })
      const v = pickLatestAppVersion(candidates)
      if (!v) continue
      versions.push({
        platform: v.platform,
        version: v.version,
        versionCode: v.versionCode,
        releaseNotes: v.releaseNotes,
        releaseNotesAr: v.releaseNotesAr,
        releaseNotesFr: v.releaseNotesFr,
        isMandatory: v.isMandatory,
        fileName: v.fileName,
        fileSize: v.fileSize,
        downloadCount: v.downloadCount,
        publishedAt: v.publishedAt,
        downloadUrl: v.downloadUrl || `/api/app-versions/${v.id}/download`,
      })
    }

    return c.json({ success: true, versions })
  } catch (error: unknown) {
    return c.json({ success: false, error: 'Failed to load public downloads' }, 500)
  }
})

// ─── POST /app-versions/:id/activate — Make this THE active version ──────
//
// "Select the active version" from Public Apps Settings: publishes this
// version and unpublishes every other version of the same platform in a
// single transaction, so exactly one installer per platform is public.

app.post('/:id/activate', async (c) => {
  try {
    await requireAdmin(c)

    const existing = await db.appVersion.findUnique({
      where: { id: c.req.param('id') },
    })
    if (!existing) {
      return c.json({ success: false, error: 'Version not found' }, 404)
    }

    const activated = await db.$transaction(async (tx) => {
      await tx.appVersion.updateMany({
        where: { platform: existing.platform, id: { not: existing.id } },
        data: { isPublished: false },
      })
      return tx.appVersion.update({
        where: { id: existing.id },
        data: {
          isPublished: true,
          publishedAt: existing.publishedAt ?? new Date(),
        },
      })
    })

    // Delta Updates (0.6.30): activation is the moment a release becomes the
    // chain target — build/refresh hop patches from every published older
    // release that has reference artifacts (best-effort, never blocks).
    let deltaGeneration: unknown = null
    try {
      deltaGeneration = await generateDeltasForVersion(existing.id)
    } catch (err) {
      deltaGeneration = { error: String((err as Error).message || err).slice(0, 200) }
    }

    // Performance Round — the landing download buttons must switch to the
    // newly activated installer on the very next visit.
    invalidateResponseCacheTag('app-versions')

    return c.json({ success: true, version: activated, deltaGeneration })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── GET /app-versions/:id/download — Download an app binary ────────────
//
// Performance Round — STREAMING rewrite. The old handler read the WHOLE
// installer into memory (fs.readFileSync) before the first byte hit the
// wire: a 155 MB Windows setup spiked RSS by 155 MB per concurrent download
// on the 2-core/12GB ARM VPS (three simultaneous downloads ≈ 0.5 GB). Now:
//   • fs.createReadStream → Web ReadableStream (constant ~64KB chunks),
//   • Content-Length from stat (no buffer), Accept-Ranges: bytes,
//   • single-range 206 support → paused/resumed mobile downloads work,
//   • ETag (size+mtime) + Cache-Control → re-downloads short-circuit 304,
//   • downloadCount increments fire-and-forget (no DB await before byte 1).
app.get('/:id/download', async (c) => {
  try {
    // Public endpoint — no auth required (for app update checks)
    const appVersion = await db.appVersion.findUnique({
      where: { id: c.req.param('id') },
    })

    if (!appVersion || !appVersion.fileStorageKey) {
      return c.json({ success: false, error: 'File not found' }, 404)
    }

    const filePath = resolveBinaryPath(appVersion.fileStorageKey)
    if (!filePath) {
      return c.json({ success: false, error: 'File not found' }, 404)
    }

    let fileStat: fs.Stats
    try {
      fileStat = fs.statSync(filePath)
      if (!fileStat.isFile()) throw new Error('not a file')
    } catch {
      return c.json({ success: false, error: 'File not found on disk' }, 404)
    }

    const fileName = appVersion.fileName || appVersion.fileStorageKey
    const fileSize = fileStat.size
    // Weak ETag from (size, mtimeMs) — re-installs of the same binary reuse
    // the browser/HTTP-cache copy instead of re-pulling 155 MB.
    const etag = `W/"${fileSize.toString(16)}-${Math.floor(fileStat.mtimeMs).toString(16)}"`
    const baseHeaders: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Accept-Ranges': 'bytes',
      ETag: etag,
      'Cache-Control': 'public, max-age=300',
    }

    // Conditional request on the full file → 304 (no body, no disk read).
    const ifNoneMatch = c.req.header('if-none-match')
    if (ifNoneMatch && !c.req.header('range')) {
      const matches = ifNoneMatch.split(',').map((t) => t.trim())
      if (matches.includes(etag) || matches.includes(etag.replace(/^W\//, '')) || ifNoneMatch.trim() === '*') {
        return new Response(null, {
          status: 304,
          headers: { ETag: etag, 'Cache-Control': baseHeaders['Cache-Control']!, 'Accept-Ranges': 'bytes' },
        })
      }
    }

    // Range support (single range only — sufficient for resume/players).
    const rangeHeader = c.req.header('range')
    let start = 0
    let end = fileSize - 1
    let status = 200
    if (rangeHeader) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim())
      if (m && (m[1] !== '' || m[2] !== '')) {
        if (m[1] === '') {
          // suffix range: last N bytes
          const suffix = Math.min(parseInt(m[2], 10), fileSize)
          start = Math.max(0, fileSize - suffix)
          end = fileSize - 1
        } else {
          start = parseInt(m[1], 10)
          end = m[2] === '' ? fileSize - 1 : Math.min(parseInt(m[2], 10), fileSize - 1)
        }
        if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= fileSize) {
          return new Response(null, {
            status: 416,
            headers: { 'Content-Range': `bytes */${fileSize}` },
          })
        }
        status = 206
      }
    }

    const contentLength = end - start + 1
    const headers: Record<string, string> = { ...baseHeaders, 'Content-Length': String(contentLength) }
    if (status === 206) {
      headers['Content-Range'] = `bytes ${start}-${end}/${fileSize}`
    }

    // Fire-and-forget analytics — the download MUST NOT wait on a DB write
    // before its first byte (the old handler awaited this increment).
    void db.appVersion
      .update({ where: { id: appVersion.id }, data: { downloadCount: { increment: 1 } } })
      .catch(() => {
        // counter loss is acceptable; the download is not
      })

    const nodeStream = fs.createReadStream(filePath, { start, end })
    nodeStream.on('error', (err) => {
      console.error('[app-versions] download stream error:', err.message)
      nodeStream.destroy()
    })
    const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>

    return new Response(webStream, { status, headers })
  } catch (error: unknown) {
    return c.json({ success: false, error: 'Download failed' }, 500)
  }
})

// ─── GET /app-versions/storage-files — LIVE installer file inventory (admin) ──
//
// Task: version tracker for rebuilt installers. GitHub Actions re-pushes an
// installer with the SAME original filename after every rebuild — each push
// lands as a NEW file on disk (the upload endpoint embeds Date.now() in the
// storage key), while the AppVersion table keeps only the LATEST file per
// platform+version. Reading the DB alone therefore HIDES every earlier build.
//
// This endpoint reads the ACTUAL files from the app-versions bucket LIVE on
// every call (a readdir+stat of one folder is ms-cheap; intentionally NO
// server cache — the user asked for live disk truth) and enriches each entry
// with the AppVersion record that currently references it (if any):
//
//   • name / storageKey / group (desktop|mobile|flat) / size / mtimeMs —
//     mtime is the PUSH TIME (CI writes the file at push time),
//   • kind ('installer' | 'ref' | 'delta' | 'unknown') + platform + version
//     from the shared naming parser — delta patches and asar/outref release
//     references therefore group under their REAL platform instead of
//     landing in "unknown" (extension fallback covers manually copied
//     binaries; 'android-debug' checked before 'android'),
//   • version: { id, platform, version, isPublished, fileName } of the
//     AppVersion row whose fileStorageKey points at this exact file.
//
// The UI groups by platform and lists EVERY occurrence sorted by push time
// desc, so two rebuilds of the same filename appear as two distinct entries.

app.get('/storage-files', async (c) => {
  try {
    await requireAdmin(c)
    ensureUploadDir()

    const diskFiles = await walkBucket()

    // Enrich in ONE query: which AppVersion rows reference these exact keys?
    // fileSize is included so the UI can verify the ACTIVE identity by EXACT
    // byte size (same-name/same-size rebuilds with a different push time must
    // never display as active — user requirement).
    const keys = diskFiles.map((f) => f.storageKey)
    const rows = keys.length
      ? await db.appVersion.findMany({
          where: { fileStorageKey: { in: keys } },
          select: { id: true, platform: true, version: true, isPublished: true, fileName: true, fileStorageKey: true, fileSize: true },
        })
      : []
    const byKey = new Map(rows.map((r) => [r.fileStorageKey as string, r]))

    // Extension/pattern fallback — classifies binaries that do not follow any
    // naming convention (e.g. files copied onto disk manually).
    const classifyByExtension = (name: string): string | null => {
      const lower = name.toLowerCase()
      if (lower.endsWith('.apk')) {
        return lower.includes('debug') ? 'android-debug' : 'android'
      }
      if (lower.endsWith('.ipa')) return 'ios'
      if (lower.endsWith('.exe') || lower.endsWith('.msi')) return 'windows'
      if (lower.endsWith('.dmg') || lower.endsWith('.pkg')) return 'mac'
      if (lower.endsWith('.appimage') || lower.endsWith('.deb') || lower.endsWith('.rpm') || lower.endsWith('.snap')) return 'linux'
      if (lower.endsWith('.app.zip')) return 'mac'
      return null
    }

    const files = diskFiles
      .map((f) => {
        const row = byKey.get(f.storageKey) ?? null
        const cls = classifyBucketFile(f.name)
        const extPlatform = classifyByExtension(f.name)
        // Platform classification precedence: upload-name convention →
        // linked AppVersion row → file-extension/pattern fallback.
        const platform = cls?.platform ?? row?.platform ?? extPlatform ?? null
        const kind: 'installer' | 'ref' | 'delta' | 'unknown' =
          cls?.kind ?? (row || extPlatform ? 'installer' : 'unknown')
        return {
          ...f,
          kind,
          ...(cls?.kind === 'delta' && cls.versionTo ? { versionTo: cls.versionTo } : {}),
          parsed: cls
            ? { platform: cls.platform, version: cls.version }
            : platform
              ? { platform, version: row?.version ?? '' }
              : null,
          platform,
          version: row
            ? { id: row.id, platform: row.platform, version: row.version, isPublished: row.isPublished, fileName: row.fileName, fileSize: row.fileSize }
            : null,
        }
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)

    return c.json({ success: true, files, uploadDir: UPLOAD_DIR })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── GET /app-versions/storage-versions — disk-truth version inventory ─────
//
// The Versions tab + the Cleanup dialog used to offer ONLY the AppVersion DB
// rows. When rows are deleted (full reset, manual deletes) their INSTALLERS,
// DELTA PATCHES and RELEASE REFS stay on disk with no row pointing at them —
// the admin then sees 163 files but a version picker offering a single row.
//
// This endpoint aggregates the ACTUAL bucket contents per (platform, version)
// using the shared naming parser, then merges the DB rows + delta rows on
// top. Every version string the cleanup can possibly touch appears here —
// including versions that exist ONLY as files ("orphan", hasDbRow=false).

app.get('/storage-versions', async (c) => {
  try {
    await requireAdmin(c)
    ensureUploadDir()

    const bucketFiles = await walkBucket()

    interface Agg {
      platform: string
      version: string
      installers: { count: number; bytes: number }
      deltas: { count: number; bytes: number }
      refs: { count: number; bytes: number }
      /** Delta DB rows touching this version (their patch file may be gone). */
      dbDeltaRows: number
      totalFiles: number
      totalBytes: number
      latestMtimeMs: number
    }
    const agg = new Map<string, Agg>()
    const touch = (platform: string, version: string): Agg => {
      const key = `${platform}|${version}`
      let a = agg.get(key)
      if (!a) {
        a = {
          platform,
          version,
          installers: { count: 0, bytes: 0 },
          deltas: { count: 0, bytes: 0 },
          refs: { count: 0, bytes: 0 },
          dbDeltaRows: 0,
          totalFiles: 0,
          totalBytes: 0,
          latestMtimeMs: 0,
        }
        agg.set(key, a)
      }
      return a
    }

    for (const f of bucketFiles) {
      const cls = classifyBucketFile(f.name)
      if (!cls) continue
      // A delta patch touches TWO versions — list it under BOTH endpoints so
      // either side is selectable in the cleanup picker. (The UI never sums
      // entries, so the double attribution cannot produce a wrong total.)
      const ends = cls.kind === 'delta' && cls.versionTo ? [cls.version, cls.versionTo] : [cls.version]
      for (const v of ends) {
        const a = touch(cls.platform, v)
        const bucketKind = cls.kind === 'delta' ? a.deltas : cls.kind === 'ref' ? a.refs : a.installers
        bucketKind.count += 1
        bucketKind.bytes += f.size
        a.totalFiles += 1
        a.totalBytes += f.size
        a.latestMtimeMs = Math.max(a.latestMtimeMs, f.mtimeMs)
      }
    }

    // DB merge — version rows (hasDbRow/active flag) + delta rows (versions
    // that currently exist only as patch endpoints).
    const [dbRows, dbDeltas] = await Promise.all([
      db.appVersion.findMany({
        select: { id: true, platform: true, version: true, isPublished: true, fileName: true },
      }),
      db.appVersionDelta.findMany({ select: { platform: true, fromVersion: true, toVersion: true } }),
    ])
    const rowByKey = new Map(dbRows.map((r) => [`${r.platform}|${r.version}`, r]))
    for (const d of dbDeltas) {
      touch(d.platform, d.fromVersion).dbDeltaRows += 1
      if (d.toVersion !== d.fromVersion) touch(d.platform, d.toVersion).dbDeltaRows += 1
    }

    const versions = Array.from(agg.values())
      .map((a) => {
        const row = rowByKey.get(`${a.platform}|${a.version}`) ?? null
        return {
          platform: a.platform,
          version: a.version,
          installers: a.installers,
          deltas: a.deltas,
          refs: a.refs,
          dbDeltaRows: a.dbDeltaRows,
          totalFiles: a.totalFiles,
          totalBytes: a.totalBytes,
          latestMtimeMs: a.latestMtimeMs,
          hasDbRow: !!row,
          isPublished: row?.isPublished ?? false,
          dbId: row?.id ?? null,
          dbFileName: row?.fileName ?? null,
        }
      })
      .sort((x, y) => x.platform.localeCompare(y.platform) || compareVersionStrings(y.version, x.version))

    return c.json({
      success: true,
      versions,
      totals: {
        versions: versions.length,
        orphanVersions: versions.filter((v) => !v.hasDbRow).length,
        files: bucketFiles.length,
        bytes: bucketFiles.reduce((n, f) => n + f.size, 0),
      },
      uploadDir: UPLOAD_DIR,
    })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── POST /app-versions/activate-file — activate the EXACT file on disk ─────
//
// Body: { storagePath: "<group>/<file>" | "<flat file>" }
//
// The version tracker lists every rebuild occurrence; this endpoint makes ONE
// specific disk file (referenced by its FULL storage path — name + push
// timestamp, never just the original filename) THE active version of its
// platform: it repoints the platform+version's AppVersion record at that
// exact file and runs the same publish/unpublish-siblings transaction as
// POST /:id/activate. Unknown platform+version combos are created on the
// fly (draft), mirroring the CI auto-create path.

app.post('/activate-file', async (c) => {
  try {
    await requireAdmin(c)

    const body = await c.req.json().catch(() => ({}))
    const storagePath = typeof body?.storagePath === 'string' ? body.storagePath.trim() : ''
    if (!storagePath) return c.json({ success: false, error: 'storagePath is required' }, 400)

    // Traversal-safe resolution INSIDE the app-versions bucket only.
    const root = path.resolve(UPLOAD_DIR)
    const resolved = path.resolve(root, storagePath.replace(/\\/g, '/'))
    if (!resolved.startsWith(root + path.sep)) {
      return c.json({ success: false, error: 'Invalid storage path' }, 400)
    }
    const rel = path.relative(root, resolved).split(path.sep).join('/')
    if (rel.split('/').length > 2 || rel.split('/').some((s) => s === '.' || s === '..')) {
      return c.json({ success: false, error: 'Invalid storage path' }, 400)
    }

    let fileStat: fs.Stats
    try {
      fileStat = await fs.promises.stat(resolved)
      if (!fileStat.isFile()) throw new Error('not a file')
    } catch {
      return c.json({ success: false, error: 'File not found on disk' }, 404)
    }

    // Identify platform + version: parse the upload naming convention first,
    // then fall back to whichever AppVersion row already points at this file.
    const PLATFORMS_DESC = ['android-debug', 'android', 'ios', 'electron', 'windows', 'mac', 'linux']
    const base = rel.includes('/') ? rel.slice(rel.indexOf('/') + 1) : rel
    let platform: string | null = null
    let version: string | null = null
    for (const p of PLATFORMS_DESC) {
      if (!base.startsWith(`${p}-`)) continue
      const m = new RegExp(`^${p}-(\\d+\\.\\d+\\.\\d+)-\\d+-.+$`).exec(base)
      if (m) { platform = p; version = m[1] }
      break
    }
    if (!platform || !version) {
      const linked = await db.appVersion.findFirst({ where: { fileStorageKey: rel } })
      if (linked) { platform = linked.platform; version = linked.version }
    }
    if (!platform || !version) {
      return c.json({ success: false, error: 'Cannot determine platform/version from this file name — create the version record first' }, 400)
    }

    // Find-or-create the version record for this platform+version.
    let record = await db.appVersion.findUnique({
      where: { platform_version: { platform, version } },
    })
    if (!record) {
      record = await db.appVersion.create({
        data: { platform, version, versionCode: 0, releaseNotes: '', isPublished: false },
      })
    }

    // Integrity hash — streamed so a 155 MB installer never buffers in RAM.
    const hash = await new Promise<string>((resolve) => {
      const h = crypto.createHash('sha256')
      const stream = fs.createReadStream(resolved)
      stream.on('data', (chunk) => h.update(chunk))
      stream.on('error', () => resolve(''))
      stream.on('end', () => resolve(h.digest('hex')))
    })

    // Recover the ORIGINAL installer filename from the storage key convention
    // `<platform>-<version>-<ts>-<original>` — the tail after the timestamp.
    const prefix = `${platform}-${version}-`
    const originalName = base.startsWith(prefix)
      ? base.slice(prefix.length).replace(/^\d+-/, '')
      : base
    await db.appVersion.update({
      where: { id: record.id },
      data: {
        fileStorageKey: rel,
        fileStorageProvider: 'local',
        fileName: originalName,
        fileSize: fileStat.size,
        ...(hash ? { fileHash: hash } : {}),
        downloadUrl: `/api/app-versions/${record.id}/download`,
      },
    })

    // Same publish semantics as POST /:id/activate — exactly one public
    // installer per platform.
    const activated = await db.$transaction(async (tx) => {
      await tx.appVersion.updateMany({
        where: { platform, id: { not: record!.id } },
        data: { isPublished: false },
      })
      return tx.appVersion.update({
        where: { id: record.id },
        data: {
          isPublished: true,
          publishedAt: record.publishedAt ?? new Date(),
        },
      })
    })

    invalidateResponseCacheTag('app-versions')

    return c.json({ success: true, activatedFile: rel, version: activated })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── GET /app-versions/:id — Get a single app version ───────────────────────

app.get('/:id', async (c) => {
  try {
    await requireAdmin(c)

    const appVersion = await db.appVersion.findUnique({
      where: { id: c.req.param('id') },
    })

    if (!appVersion) {
      return c.json({ success: false, error: 'Version not found' }, 404)
    }

    return c.json({ success: true, version: appVersion })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── PATCH /app-versions/:id — Update an app version ────────────────────────

app.patch('/:id', async (c) => {
  try {
    await requireAdmin(c)

    const body = await c.req.json()
    const validation = updateAppVersionSchema.safeParse(body)
    if (!validation.success) {
      return c.json({ success: false, error: 'Invalid input', details: validation.error.issues }, 400)
    }

    const data = validation.data

    const existing = await db.appVersion.findUnique({
      where: { id: c.req.param('id') },
    })
    if (!existing) {
      return c.json({ success: false, error: 'Version not found' }, 404)
    }

    // If publishing for the first time, set publishedAt
    const publishData: any = {}
    if (data.isPublished === true && !existing.isPublished && !existing.publishedAt) {
      publishData.publishedAt = new Date()
    }

    const appVersion = await db.appVersion.update({
      where: { id: c.req.param('id') },
      data: { ...data, ...publishData },
    })

    // Performance Round — publish/unpublish edits hit the public downloads.
    invalidateResponseCacheTag('app-versions')

    return c.json({ success: true, version: appVersion })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── DELETE /app-versions/:id — Delete an app version ───────────────────────

app.delete('/:id', async (c) => {
  try {
    await requireAdmin(c)

    const existing = await db.appVersion.findUnique({
      where: { id: c.req.param('id') },
    })
    if (!existing) {
      return c.json({ success: false, error: 'Version not found' }, 404)
    }

    // Clean up file if it exists
    if (existing.fileStorageKey) {
      const filePath = resolveBinaryPath(existing.fileStorageKey)
      if (filePath && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath)
      }
    }

    await db.appVersion.delete({ where: { id: c.req.param('id') } })

    // Performance Round — a deleted version must vanish from the public
    // download list immediately.
    invalidateResponseCacheTag('app-versions')

    return c.json({ success: true })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── Storage cleanup (Public Apps Manager — Versions tab) ───────────────────
//
// Backs the "Cleanup" button: pick one version of one platform, choose how
// much release history to remove, and delete ALL installers + ALL delta
// update patches + ALL related files of everything in scope. Scopes:
//
//   this           → ONLY the selected version
//   with-previous  → the selected version + EVERY older version (semver) of
//                    the same platform — its full release history
//
// For every version in scope this removes EVERYTHING related:
//   • the AppVersion row (UpdatePush rows cascade with it),
//   • ALL its installer files — the current binary (fileStorageKey, legacy
//     tmpdir fallback) AND unreferenced older builds still sitting in the
//     bucket (same-name CI rebuilds — AppVersion keeps only the newest file
//     per platform+version, everything else was invisible to the DB),
//   • the desktop release references (asar / outref),
//   • EVERY AppVersionDelta row + patch file touching an in-scope version
//     string (fromVersion OR toVersion) — with the endpoint rows gone those
//     patches are unreachable dead weight.
//
// Preview and execution share ONE planner, so the summary the UI shows is
// always exactly what the execute call deletes.

const cleanupBodySchema = z.object({
  platform: z.enum(['android', 'android-debug', 'ios', 'electron', 'windows', 'mac', 'linux']),
  version: z.string().regex(/^\d+\.\d+\.\d+/, 'Version must be semver (e.g. 1.2.3)'),
  scope: z.enum(['this', 'with-previous']),
})

interface CleanupPlan {
  targets: Array<{
    id: string
    platform: string
    version: string
    isPublished: boolean
    fileName: string | null
    createdAt: Date
  }>
  /** Every version string in scope (DB rows ∪ disk files ∪ delta endpoints). */
  scopeVersions: string[]
  installers: Array<{ storageKey: string; size: number }>
  refs: Array<{ storageKey: string; size: number }>
  deltas: Array<{ id: string; fromVersion: string; toVersion: string; storageKey: string; size: number }>
  orphans: Array<{ storageKey: string; size: number; version: string }>
  /** Per-version breakdown for the preview table (files ∪ bytes, both delta ends). */
  perVersion: Array<{
    version: string
    files: number
    bytes: number
    installers: number
    refs: number
    deltas: number
    orphans: number
    hasDbRow: boolean
    isPublished: boolean
  }>
}

/** DB size when known, else a stat of the resolved file (0 when missing). */
function cleanupArtifactSize(storageKey: string, dbSize: number | null): number {
  if (typeof dbSize === 'number' && dbSize > 0) return dbSize
  const p = resolveBinaryPath(storageKey)
  if (!p) return 0
  try {
    return fs.statSync(p).size
  } catch {
    return 0
  }
}

async function buildCleanupPlan(
  platform: string,
  version: string,
  scope: 'this' | 'with-previous',
): Promise<CleanupPlan> {
  // Scope 'this' operates on the version STRING — a version whose rows were
  // already deleted (full reset, manual deletes) but whose installers and
  // delta patches still sit on disk MUST stay cleanable, so a missing
  // AppVersion row is no longer an error (it used to 404 here).
  const rows = await db.appVersion.findMany({ where: { platform } })

  // 'with-previous' ranks every KNOWN version of the platform — DB rows AND
  // disk-only files AND delta-row endpoints — so old releases like 0.6.30
  // whose rows are long gone are still swept when cleaning up from 0.6.43.
  const known = new Set<string>([version, ...rows.map((r) => r.version)])
  if (scope === 'with-previous') {
    const bucketFiles = await walkBucket()
    for (const f of bucketFiles) {
      const cls = classifyBucketFile(f.name)
      if (!cls || cls.platform !== platform) continue
      known.add(cls.version)
      if (cls.versionTo) known.add(cls.versionTo)
    }
    const deltaRows = await db.appVersionDelta.findMany({
      where: { platform },
      select: { fromVersion: true, toVersion: true },
    })
    for (const d of deltaRows) {
      known.add(d.fromVersion)
      known.add(d.toVersion)
    }
  }

  const targets = rows.filter((r) => {
    if (scope === 'this') return r.version === version
    return r.version === version || compareVersionStrings(r.version, version) < 0
  })

  const scopeStrings =
    scope === 'this'
      ? [version]
      : [...known].filter((v) => v === version || compareVersionStrings(v, version) < 0)

  const deltas = scopeStrings.length
    ? await db.appVersionDelta.findMany({
        where: {
          platform,
          OR: [{ fromVersion: { in: scopeStrings } }, { toVersion: { in: scopeStrings } }],
        },
      })
    : []

  const installers: CleanupPlan['installers'] = []
  const refs: CleanupPlan['refs'] = []
  for (const r of targets) {
    if (r.fileStorageKey) {
      installers.push({ storageKey: r.fileStorageKey, size: cleanupArtifactSize(r.fileStorageKey, r.fileSize) })
    }
    if (r.asarStorageKey) {
      refs.push({ storageKey: r.asarStorageKey, size: cleanupArtifactSize(r.asarStorageKey, r.asarSize) })
    }
    if (r.outrefStorageKey) {
      refs.push({ storageKey: r.outrefStorageKey, size: cleanupArtifactSize(r.outrefStorageKey, r.outrefSize) })
    }
  }

  // Unreferenced files: scan the WHOLE bucket (group folders + legacy flat
  // root) through the shared naming parser — installer, asar/outref refs and
  // delta patches all classify here, so old releases with no DB row are
  // swept too — INCLUDING raw pre-convention artifacts the tolerant parser
  // recognizes (BLASTI-Setup-0.6.30.exe, BLASTI-v0.6.30-debug.apk, .blockmap).
  // Every match is pinned to the CLEANUP platform — 'windows-9.9.0-…' in
  // desktop/ shares its version string with an android scope but must never
  // be classified as an android orphan; the classifier also flags debug APKs
  // as 'android-debug', so an 'android' cleanup can never swallow them.
  const orphans: CleanupPlan['orphans'] = []
  if (scopeStrings.length > 0) {
    const referenced = new Set([
      ...installers.map((f) => f.storageKey),
      ...refs.map((f) => f.storageKey),
      ...deltas.map((d) => d.fileStorageKey),
    ])
    const scopeSet = new Set(scopeStrings)
    const bucketFiles = await walkBucket()
    for (const f of bucketFiles) {
      if (referenced.has(f.storageKey)) continue
      const cls = classifyBucketFile(f.name)
      if (!cls || cls.platform !== platform) continue
      let matchedVersion: string | null = cls.version
      if (cls.kind === 'delta') {
        matchedVersion = scopeSet.has(cls.version) ? cls.version : (cls.versionTo ?? null)
      }
      if (matchedVersion && scopeSet.has(matchedVersion)) {
        orphans.push({ storageKey: f.storageKey, size: f.size, version: matchedVersion })
      }
    }
  }

  // Per-version breakdown for the preview table — DB-referenced artifacts
  // attribute to their row's version, delta patches to BOTH endpoints (same
  // convention as /storage-versions), orphans to the version string their
  // name matched. Rows never sum in the UI, so double-attribution is safe.
  const perVersionMap = new Map<string, CleanupPlan['perVersion'][number]>()
  const touchV = (v: string) => {
    let row = perVersionMap.get(v)
    if (!row) {
      row = {
        version: v,
        files: 0,
        bytes: 0,
        installers: 0,
        refs: 0,
        deltas: 0,
        orphans: 0,
        hasDbRow: targets.some((t) => t.version === v),
        isPublished: targets.find((t) => t.version === v)?.isPublished ?? false,
      }
      perVersionMap.set(v, row)
    }
    return row
  }
  for (const r of targets) {
    const add = (size: number, kind: 'installers' | 'refs') => {
      const row = touchV(r.version)
      row.files += 1
      row.bytes += size
      row[kind] += 1
    }
    if (r.fileStorageKey) add(cleanupArtifactSize(r.fileStorageKey, r.fileSize), 'installers')
    if (r.asarStorageKey) add(cleanupArtifactSize(r.asarStorageKey, r.asarSize), 'refs')
    if (r.outrefStorageKey) add(cleanupArtifactSize(r.outrefStorageKey, r.outrefSize), 'refs')
  }
  for (const d of deltas) {
    const size = cleanupArtifactSize(d.fileStorageKey, d.fileSize)
    touchV(d.fromVersion).deltas += 1
    const fromRow = touchV(d.fromVersion)
    fromRow.files += 1
    fromRow.bytes += size
    if (d.toVersion !== d.fromVersion) {
      touchV(d.toVersion).deltas += 1
      const toRow = touchV(d.toVersion)
      toRow.files += 1
      toRow.bytes += size
    }
  }
  for (const o of orphans) {
    const row = touchV(o.version)
    row.files += 1
    row.bytes += o.size
    row.orphans += 1
  }

  return {
    targets: targets.map((t) => ({
      id: t.id,
      platform: t.platform,
      version: t.version,
      isPublished: t.isPublished,
      fileName: t.fileName,
      createdAt: t.createdAt,
    })),
    scopeVersions: [...scopeStrings].sort((a, b) => compareVersionStrings(b, a)),
    installers,
    refs,
    deltas: deltas.map((d) => ({
      id: d.id,
      fromVersion: d.fromVersion,
      toVersion: d.toVersion,
      storageKey: d.fileStorageKey,
      size: d.fileSize,
    })),
    orphans,
    perVersion: [...perVersionMap.values()].sort((a, b) => compareVersionStrings(b.version, a.version)),
  }
}

function sumSizes(list: Array<{ size: number }>): number {
  return list.reduce((n, x) => n + x.size, 0)
}

app.post('/cleanup-preview', async (c) => {
  try {
    await requireAdmin(c)
    const body = await c.req.json().catch(() => null)
    const parsed = cleanupBodySchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ success: false, error: 'platform + version (semver) + scope are required' }, 400)
    }
    const plan = await buildCleanupPlan(parsed.data.platform, parsed.data.version, parsed.data.scope)

    const installerBytes = sumSizes(plan.installers)
    const refBytes = sumSizes(plan.refs)
    const deltaBytes = sumSizes(plan.deltas)
    const orphanBytes = sumSizes(plan.orphans)
    return c.json({
      success: true,
      plan: {
        versions: plan.targets.map((t) => ({
          id: t.id,
          platform: t.platform,
          version: t.version,
          isPublished: t.isPublished,
          fileName: t.fileName,
          createdAt: t.createdAt,
        })),
        scopeVersions: plan.scopeVersions,
        installers: { count: plan.installers.length, bytes: installerBytes },
        refArtifacts: { count: plan.refs.length, bytes: refBytes },
        deltas: {
          count: plan.deltas.length,
          bytes: deltaBytes,
          pairs: plan.deltas.map((d) => `${d.fromVersion} → ${d.toVersion}`),
        },
        orphanedBuilds: { count: plan.orphans.length, bytes: orphanBytes },
        perVersion: plan.perVersion,
        totalFiles: plan.installers.length + plan.refs.length + plan.deltas.length + plan.orphans.length,
        totalBytes: installerBytes + refBytes + deltaBytes + orphanBytes,
      },
    })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

app.post('/cleanup', async (c) => {
  try {
    const caller = await requireAdmin(c)
    const body = await c.req.json().catch(() => null)

    // Same typed-confirmation contract as the System Reset card.
    if (body?.confirm !== 'CLEANUP') {
      return c.json(
        { success: false, error: 'Confirmation failed: the confirm field must be exactly "CLEANUP"' },
        400,
      )
    }
    const parsed = cleanupBodySchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ success: false, error: 'platform + version (semver) + scope are required' }, 400)
    }
    const { platform, version, scope } = parsed.data
    const plan = await buildCleanupPlan(platform, version, scope)
    if (plan.targets.length === 0 && plan.deltas.length === 0 && plan.orphans.length === 0) {
      return c.json({ success: false, error: 'Nothing in scope to clean up' }, 400)
    }

    // 1) Files first — an unlink failure leaves the DB rows intact so the
    //    admin can simply retry, instead of rows pointing at missing files.
    let deletedFiles = 0
    for (const f of [...plan.installers, ...plan.refs]) {
      const p = resolveBinaryPath(f.storageKey)
      if (p) {
        try {
          fs.unlinkSync(p)
          deletedFiles++
        } catch {
          /* raced delete — keep going */
        }
      }
    }
    for (const d of plan.deltas) {
      const p = resolveBinaryPath(d.storageKey)
      if (p) {
        try {
          fs.unlinkSync(p)
          deletedFiles++
        } catch {
          /* raced delete — keep going */
        }
      }
    }
    for (const o of plan.orphans) {
      const p = path.resolve(UPLOAD_DIR, o.storageKey)
      if (p.startsWith(path.resolve(UPLOAD_DIR) + path.sep)) {
        try {
          fs.unlinkSync(p)
          deletedFiles++
        } catch {
          /* raced delete — keep going */
        }
      }
    }

    // 2) Rows — delta edges (children) before the version rows themselves.
    let deletedDeltas = 0
    let deletedVersions = 0
    if (plan.deltas.length > 0) {
      deletedDeltas = (
        await db.appVersionDelta.deleteMany({ where: { id: { in: plan.deltas.map((d) => d.id) } } })
      ).count
    }
    if (plan.targets.length > 0) {
      deletedVersions = (
        await db.appVersion.deleteMany({ where: { id: { in: plan.targets.map((t) => t.id) } } })
      ).count
    }

    // 3) A deleted release must vanish from the public download list at once.
    invalidateResponseCacheTag('app-versions')

    await auditLog.userAction({
      userId: caller.id,
      action: 'admin.app-cleanup',
      entityType: 'SYSTEM',
      entityId: `app-versions:${platform}`,
      details: {
        platform,
        version,
        scope,
        deletedVersions,
        deletedDeltas,
        deletedFiles,
        versions: plan.targets.map((t) => t.version),
      },
    })

    return c.json({ success: true, deletedVersions, deletedDeltas, deletedFiles })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── POST /app-versions/check-update — Public endpoint for apps to check for updates

app.post('/check-update', async (c) => {
  try {
    const body = await c.req.json()
    const { platform, currentVersion } = body as { platform?: string; currentVersion?: string }

    if (!platform || !currentVersion) {
      return c.json({ success: false, error: 'platform and currentVersion are required' }, 400)
    }

    const latestVersion = await db.appVersion.findFirst({
      where: { platform, isPublished: true },
      orderBy: { createdAt: 'desc' },
    })

    if (!latestVersion) {
      return c.json({ success: false, updateAvailable: false })
    }

    // Simple semver comparison
    const isNewer = compareVersions(latestVersion.version, currentVersion) > 0

    if (!isNewer) {
      return c.json({ success: true, updateAvailable: false })
    }

    return c.json({
      success: true,
      updateAvailable: true,
      isMandatory: latestVersion.isMandatory,
      version: {
        version: latestVersion.version,
        versionCode: latestVersion.versionCode,
        releaseNotes: latestVersion.releaseNotes,
        releaseNotesAr: latestVersion.releaseNotesAr,
        releaseNotesFr: latestVersion.releaseNotesFr,
        isPatch: latestVersion.isPatch,
        downloadUrl: latestVersion.downloadUrl || `/api/app-versions/${latestVersion.id}/download`,
        minAppVersion: latestVersion.minAppVersion,
        fileSize: latestVersion.fileSize,
        fileHash: latestVersion.fileHash,
        publishedAt: latestVersion.publishedAt,
      },
    })
  } catch (error: unknown) {
    return c.json({ success: false, error: 'Update check failed' }, 500)
  }
})

// ─── Helper: Simple semver comparison ────────────────────────────────────────

function compareVersions(a: string, b: string): number {
  const aParts = a.split('.').map(Number)
  const bParts = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const aVal = aParts[i] || 0
    const bVal = bParts[i] || 0
    if (aVal > bVal) return 1
    if (aVal < bVal) return -1
  }
  return 0
}

// API Compatibility Map (0.6.31) — one-time idempotent seed of the feature
// gates from this codebase's real release history (delta-updates, strict
// logs, master-pin, counter-control, payments). Admins manage them after.
void seedDefaultGates().catch(() => { /* seeding must never break boot */ })

export const appVersionRoutes = app
