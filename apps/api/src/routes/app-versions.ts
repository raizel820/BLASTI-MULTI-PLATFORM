import { timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { db } from '@blasti/db'
import { requireAdmin, authErrorResponse } from '../lib/auth'
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
import { computeDeltaChain, generateDeltasForVersion } from '../lib/app-version-deltas'
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
    let delta: Record<string, unknown> | null = null
    if (updateAvailable && latestVersion) {
      try {
        const chain = await computeDeltaChain(platform, version, latestVersion.id)
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

    const data: Record<string, string | number> = {}
    if (runtimeKey) data.runtimeKey = runtimeKey
    if (nativeFingerprint) data.nativeFingerprint = nativeFingerprint

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
    await requireAdmin(c)
    const appVersion = await db.appVersion.findUnique({ where: { id: c.req.param('id') } })
    if (!appVersion) return c.json({ success: false, error: 'Version not found' }, 404)
    const results = await generateDeltasForVersion(appVersion.id)
    return c.json({ success: true, results })
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
//   • parsed platform + version from the upload naming convention
//     `<platform>-<semver>-<ts>-<original-name>` ('android-debug' checked
//     before 'android'; unknown naming → parsed=null),
//   • version: { id, platform, version, isPublished, fileName } of the
//     AppVersion row whose fileStorageKey points at this exact file.
//
// The UI groups by platform and lists EVERY occurrence sorted by push time
// desc, so two rebuilds of the same filename appear as two distinct entries.

app.get('/storage-files', async (c) => {
  try {
    await requireAdmin(c)
    ensureUploadDir()

    interface DiskFile {
      storageKey: string
      name: string
      group: string
      size: number
      mtimeMs: number
    }
    const diskFiles: DiskFile[] = []

    const root = path.resolve(UPLOAD_DIR)
    const pushFile = async (abs: string, group: string) => {
      try {
        const st = await fs.promises.stat(abs)
        if (!st.isFile()) return
        diskFiles.push({
          storageKey: group ? `${group}/${path.basename(abs)}` : path.basename(abs),
          name: path.basename(abs),
          group,
          size: st.size,
          mtimeMs: st.mtimeMs,
        })
      } catch { /* raced delete — skip */ }
    }

    let dirEntries: fs.Dirent[] = []
    try {
      dirEntries = await fs.promises.readdir(root, { withFileTypes: true })
    } catch { /* bucket missing — empty list */ }

    for (const e of dirEntries) {
      if (e.isFile()) {
        await pushFile(path.join(root, e.name), '') // legacy flat binaries
      } else if (e.isDirectory()) {
        let inner: fs.Dirent[] = []
        try {
          inner = await fs.promises.readdir(path.join(root, e.name), { withFileTypes: true })
        } catch { continue }
        for (const f of inner) {
          if (f.isFile()) await pushFile(path.join(root, e.name, f.name), e.name)
        }
      }
    }

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

    // Parse the CI/upload naming convention → platform + version.
    const PLATFORMS_DESC = ['android-debug', 'android', 'ios', 'electron', 'windows', 'mac', 'linux']
    // Extension/pattern fallback — classifies binaries that do not follow the
    // `<platform>-<semver>-<ts>-<original>` storage-key convention (e.g. files
    // copied onto disk manually). 'android-debug' must be checked before
    // 'android' so a debug APK name containing "debug" wins.
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
    const parseKey = (key: string): { platform: string; version: string } | null => {
      const base = key.includes('/') ? key.slice(key.indexOf('/') + 1) : key
      for (const platform of PLATFORMS_DESC) {
        if (!base.startsWith(`${platform}-`)) continue
        const m = new RegExp(`^${platform}-(\\d+\\.\\d+\\.\\d+)-\\d+-.+$`).exec(base)
        if (m) return { platform, version: m[1] }
      }
      return null
    }

    const files = diskFiles
      .map((f) => {
        const row = byKey.get(f.storageKey) ?? null
        // Platform classification precedence: upload-name convention →
        // linked AppVersion row → file-extension/pattern fallback.
        const parsed = parseKey(f.storageKey)
        const platform =
          parsed?.platform ?? row?.platform ?? classifyByExtension(f.name) ?? null
        return {
          ...f,
          parsed: parsed ?? (platform ? { platform, version: row?.version ?? '' } : null),
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
