/**
 * REF BACKFILL (0.6.38) — rebuild desktop delta reference artifacts from the
 * STORED installer.
 * ─────────────────────────────────────────────────────────────────────────────
 * FIELD ROOT CAUSE this closes: desktop delta hops can only be generated when
 * BOTH releases carry their reference artifacts (resources/app.asar + the
 * out/** tree archive + runtimeKey + nativeFingerprint — see
 * app-version-deltas.ts). CI (build-installers.yml → make-release-refs.mjs →
 * publish-installer.mjs → POST /:id/release-refs) attaches them for every NEW
 * build, but rows published before that wiring existed — or whose refs upload
 * failed silently — have NO refs, `generateDeltaBetween` refuses the hop with
 * 'missing-asar-ref', /check answers delta:null and every desktop device
 * falls back to the FULL 155MB installer while phones (which need no refs —
 * the APK itself is the base) keep receiving small deltas.
 *
 * THE FIX: the VPS already stores every installer it ever served. The NSIS
 * setup is self-contained — extracting it yields the exact win-unpacked tree
 * the build machine had, so the refs can be REBUILT from the stored bits:
 *
 *   BLASTI-Setup-<v>.exe  ──7z x──▶  $PLUGINSDIR/app-64.7z  ──7z x──▶  payload/
 *     payload/blasti.exe                 → UA scan 'Electron/<ver>' (runtimeKey)
 *     payload/resources/app.asar         → asar ref + asarSha256
 *     payload/resources/app.asar.unpacked → outref tree archive + fingerprint
 *
 * Extraction runs entirely in-process via the bundled 7z-wasm (no system 7z
 * needed on the VPS). The fingerprint walk replicates make-release-refs.mjs
 * BYTE FOR BYTE (same skip rules, same rel-path format, same sort), so a
 * backfilled row and a CI-attached row built from identical bits always agree
 * — the parity is covered by a dedicated proof script.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import SevenZip from '7z-wasm'
import { createOutref, sha256OfFile } from '@blasti/binary-delta'
import { db } from '@blasti/db'
import { STORAGE_ROOT } from './storage'

/** Same grouping the delta generator uses — only these rows carry refs. */
const DESKTOP_PLATFORMS = new Set(['windows', 'mac', 'linux', 'electron'])

const UPLOAD_DIR = path.join(STORAGE_ROOT, 'app-versions')

/** Overall watchdog for one extraction (NSIS open + payload unpack). */
const EXTRACTION_TIMEOUT_MS = 5 * 60_000

export interface BackfillResult {
  ok: boolean
  versionId: string
  platform: string
  version: string
  /** Set instead of ok:false when there is nothing to do / nothing possible. */
  skipped?: 'refs-present' | 'not-desktop' | 'no-installer' | 'installer-file-missing' | 'already-running'
  reason?: string
  electronVersion?: string
  /** Where the electron version came from — exe UA token / asar manifest. */
  versionSource?: string
  arch?: string
  runtimeKey?: string
  nativeFingerprint?: string
  asarSha256?: string
  asarSize?: number
  outrefSize?: number
}

/** Rows currently being extracted — a row is only ever backfilled once at a time. */
const inFlight = new Set<string>()

/**
 * AUTO-mode failure memory: a backfill that failed (corrupt installer, no 7z…
 * ) is not retried on every publish/check path — the next attempt waits for
 * the explicit admin endpoint or a fresh process. Keeps request latency sane.
 */
const recentFailures = new Map<string, number>()
const FAILURE_RETRY_MS = 10 * 60_000

function isDesktopPlatform(platform: string): boolean {
  return DESKTOP_PLATFORMS.has(platform)
}

export function refBackfillFailureRecent(versionId: string): boolean {
  const at = recentFailures.get(versionId)
  return !!at && Date.now() - at < FAILURE_RETRY_MS
}

/** Auto mode honours BLASTI_REF_BACKFILL=0 (off) — default on. */
export function autoRefBackfillEnabled(): boolean {
  return process.env.BLASTI_REF_BACKFILL !== '0'
}

// ─── 7z-wasm engine ──────────────────────────────────────────────────────────

interface SevenZipLike {
  FS: {
    mkdir(p: string): unknown
    mount(m: unknown, opts: { root: string }, p: string): unknown
    chdir?(p: string): unknown
  }
  NODEFS: unknown
  callMain(args: string[]): void
}

/** Extract `archive` into `destDir` with the bundled wasm 7-Zip. */
async function extractWithWasm(archive: string, destDir: string): Promise<string[]> {
  // Fresh module per call: callMain state is single-shot, init ≈30ms.
  const outputTail: string[] = []
  const sevenZip = (await SevenZip({
    print: (line: string) => {
      outputTail.push(String(line))
      if (outputTail.length > 6) outputTail.shift()
    },
    printErr: (line: string) => {
      outputTail.push(String(line))
      if (outputTail.length > 6) outputTail.shift()
    },
  })) as unknown as SevenZipLike

  // NODEFS mount of the ARCHIVE'S OWN directory — the wasm FS sees nothing
  // else, so `x` must be pointed at /blasti-work/<basename>.
  const archiveDir = path.dirname(archive)
  const mount = (host: string, vfs: string) => {
    try { sevenZip.FS.mkdir(vfs) } catch { /* already mounted */ }
    sevenZip.FS.mount(sevenZip.NODEFS, { root: host }, vfs)
  }
  mount(archiveDir, '/blasti-work')
  mount(destDir, '/blasti-out')
  const vfsArchive = '/blasti-work/' + path.basename(archive)
  try {
    sevenZip.callMain(['x', '-y', vfsArchive, '-o/blasti-out'])
  } catch (err) {
    // EXIT_RUNTIME builds unwind main() via an ExitStatus throw — code 0 is fine.
    const status = (err as { status?: number })?.status
    if (typeof status === 'number' && status !== 0) {
      throw new Error(`7z exit ${status}: ${outputTail.join(' | ')}`)
    }
  }
  return outputTail
}

// ─── Payload discovery ───────────────────────────────────────────────────────

function walkFiles(dir: string, rel = '', acc: string[] = [], depth = 0): string[] {
  if (depth > 6) return acc
  let entries: fs.Dirent[] = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return acc }
  for (const e of entries) {
    const relPath = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) walkFiles(path.join(dir, e.name), relPath, acc, depth + 1)
    else if (e.isFile()) acc.push(relPath)
  }
  return acc
}

interface PayloadInfo {
  root: string
  arch: string
  electronVersion: string
  versionSource: string
}

/**
 * Locate the app payload inside the extracted installer tree and derive the
 * runtime identity (electron version + arch) from the actual bits.
 */
function locatePayload(stage1: string, stage2: string): PayloadInfo {
  // electron-builder NSIS embeds the app as $PLUGINSDIR/app-<arch>.7z.
  const stage1Files = walkFiles(stage1)
  const payloadArchive = stage1Files.find((f) => /(^|\/)app-(64|32|arm64)\.7z$/i.test(f))
  let treeDir: string
  let arch = 'x64'
  if (payloadArchive) {
    arch = /app-64\.7z$/i.test(payloadArchive) ? 'x64' : /app-32\.7z$/i.test(payloadArchive) ? 'ia32' : 'arm64'
    treeDir = stage2
  } else {
    // Defensive: some targets (portable/dir) carry the tree directly.
    treeDir = stage1
  }

  // The tree root holds blasti.exe + resources/. Descend through at most one
  // wrapping directory (defensive against layout drift).
  const hasPayload = (dir: string) =>
    fs.existsSync(path.join(dir, 'resources', 'app.asar'))
  if (!hasPayload(treeDir)) {
    let entries: fs.Dirent[] = []
    try { entries = fs.readdirSync(treeDir, { withFileTypes: true }) } catch { /* handled below */ }
    const onlyDir = entries.length === 1 && entries[0].isDirectory() ? path.join(treeDir, entries[0].name) : null
    if (onlyDir && hasPayload(onlyDir)) treeDir = onlyDir
  }
  if (!hasPayload(treeDir)) {
    throw new Error('payload-not-found (no resources/app.asar in the extracted installer)')
  }
  if (!fs.existsSync(path.join(treeDir, 'resources', 'app.asar.unpacked'))) {
    throw new Error('payload-incomplete (resources/app.asar.unpacked missing)')
  }

  const { electronVersion, versionSource } = detectElectronVersion(treeDir)
  return { root: treeDir, arch, electronVersion, versionSource }
}

/**
 * Electron version from the ACTUAL runtime bits, in order:
 *   1. UA token 'Electron/<semver>' embedded in the payload's main exe
 *      (electron's net layer ships it inside the binary — exact, survives
 *      every electron-builder metadata patch),
 *   2. resources/app.asar → package.json devDependencies.electron (manifest
 *      value may carry a range — stripped; a slightly-off version can only
 *      cause a runtimeKey MISMATCH (no hop → full installer), never a bad hop).
 */
function detectElectronVersion(payloadRoot: string): { electronVersion: string; versionSource: string } {
  // 1) scan the main exe (largest .exe at the payload root — blasti.exe).
  try {
    const exes = fs.readdirSync(payloadRoot, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.exe$/i.test(e.name))
      .map((e) => ({ name: e.name, size: fs.statSync(path.join(payloadRoot, e.name)).size }))
      .sort((a, b) => b.size - a.size)
    const mainExe = exes[0]
    if (mainExe) {
      const scanned = scanExeForElectronVersion(path.join(payloadRoot, mainExe.name))
      if (scanned) return { electronVersion: scanned, versionSource: 'exe-ua-token' }
    }
  } catch { /* fall through to the manifest */ }

  // 2) app.asar header → package.json → devDependencies.electron
  try {
    const fromAsar = electronVersionFromAsar(path.join(payloadRoot, 'resources', 'app.asar'))
    if (fromAsar) return { electronVersion: fromAsar, versionSource: 'asar-manifest' }
  } catch { /* give up cleanly */ }

  return { electronVersion: '', versionSource: 'unknown' }
}

/** Streamed latin1 scan for the Electron UA token (no 232MB string in RAM). */
function scanExeForElectronVersion(exePath: string): string {
  const CHUNK = 8 * 1024 * 1024
  const OVERLAP = 64 // cover a token split across the chunk boundary
  let fd: number | null = null
  try {
    fd = fs.openSync(exePath, 'r')
    const size = fs.fstatSync(fd).size
    let tail = ''
    for (let offset = 0; offset < size; offset += CHUNK) {
      const len = Math.min(CHUNK + OVERLAP, size - offset)
      const buf = Buffer.alloc(len)
      fs.readSync(fd, buf, 0, len, offset)
      const text = tail + buf.toString('latin1')
      const m = /Electron\/(\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?)/.exec(text)
      if (m) return m[1]
      tail = text.slice(Math.max(0, text.length - OVERLAP))
    }
  } catch { /* not found */ } finally {
    try { if (fd !== null) fs.closeSync(fd) } catch { /* already closed */ }
  }
  return ''
}

/** Minimal asar header reader — pulls package.json's electron devDep version. */
function electronVersionFromAsar(asarPath: string): string {
  const fd = fs.openSync(asarPath, 'r')
  try {
    const head = Buffer.alloc(64)
    fs.readSync(fd, head, 0, 64, 0)
    const dictSize = head.readUInt32LE(12)
    if (dictSize <= 0 || dictSize > 32 * 1024 * 1024) return ''
    const headerBuf = Buffer.alloc(dictSize)
    fs.readSync(fd, headerBuf, 0, dictSize, 16)
    const header = JSON.parse(headerBuf.toString('utf8'))
    const pkgFile = header?.files?.['package.json']
    const offset = Number(pkgFile?.files?.['offset'] ?? pkgFile?.offset)
    const size = Number(pkgFile?.files?.['size'] ?? pkgFile?.size)
    if (!Number.isFinite(offset) || !Number.isFinite(size) || size <= 0 || size > 4 * 1024 * 1024) return ''
    const pkgBuf = Buffer.alloc(size)
    fs.readSync(fd, pkgBuf, 0, size, 16 + dictSize + offset)
    const pkg = JSON.parse(pkgBuf.toString('utf8'))
    const raw = String(pkg?.devDependencies?.electron ?? pkg?.dependencies?.electron ?? '')
    const m = /(\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?)/.exec(raw)
    return m ? m[1] : ''
  } finally {
    try { fs.closeSync(fd) } catch { /* already closed */ }
  }
}

// ─── Refs computation (BYTE-PARITY with make-release-refs.mjs) ───────────────

/**
 * Identical skip rules to make-release-refs.mjs: the asar itself (it is the
 * diffed artifact) and the out/** web bundle inside the unpacked tree are
 * excluded from the native fingerprint.
 */
function fingerprintSkip(rel: string): boolean {
  return rel === 'resources/app.asar' || rel.startsWith('resources/app.asar.unpacked/out/')
}

function computeNativeFingerprint(payloadRoot: string): string {
  const allFiles: string[] = []
  walkFiles(payloadRoot, '', allFiles)
  const fingerprintFiles = allFiles.filter((rel) => !fingerprintSkip(rel))
  fingerprintFiles.sort()
  const hash = createHash('sha256')
  for (const rel of fingerprintFiles) {
    hash.update(rel)
    hash.update('\u0000')
    hash.update(createHash('sha256').update(fs.readFileSync(path.join(payloadRoot, rel))).digest('hex'))
    hash.update('\u0000')
  }
  return hash.digest('hex')
}

// ─── Main entry ──────────────────────────────────────────────────────────────

export async function backfillRefsForVersion(versionId: string, opts?: { force?: boolean }): Promise<BackfillResult> {
  const row = await db.appVersion.findUnique({ where: { id: versionId } })
  const base: BackfillResult = {
    ok: false,
    versionId,
    platform: row?.platform ?? '',
    version: row?.version ?? '',
  }
  if (!row) return { ...base, reason: 'version-not-found' }
  if (!isDesktopPlatform(row.platform)) return { ...base, skipped: 'not-desktop' }
  if (row.asarStorageKey && row.outrefStorageKey && !opts?.force) {
    return { ...base, ok: true, skipped: 'refs-present' }
  }
  if (!row.fileStorageKey) return { ...base, skipped: 'no-installer' }
  if (inFlight.has(versionId)) return { ...base, skipped: 'already-running' }

  const installerPath = path.resolve(UPLOAD_DIR, row.fileStorageKey)
  if (!installerPath.startsWith(path.resolve(UPLOAD_DIR) + path.sep) || !fs.existsSync(installerPath)) {
    return { ...base, skipped: 'installer-file-missing' }
  }

  inFlight.add(versionId)
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `blasti-refbackfill-${row.platform}-${row.version.replace(/\W/g, '_')}-`))
  const stage1 = path.join(workDir, 'stage1')
  const stage2 = path.join(workDir, 'stage2')
  try {
    fs.mkdirSync(stage1, { recursive: true })
    fs.mkdirSync(stage2, { recursive: true })

    // Extraction with a hard watchdog — a wedged wasm must not pin the row forever.
    await Promise.race([
      (async () => {
        const stage1Tail = await extractWithWasm(installerPath, stage1)
        // $PLUGINSDIR/app-<arch>.7z found? Then unpack the payload too.
        const payloadRel = walkFiles(stage1).find((f) => /(^|\/)app-(64|32|arm64)\.7z$/i.test(f))
        if (payloadRel) {
          await extractWithWasm(path.join(stage1, payloadRel), stage2)
        } else if (!fs.existsSync(path.join(stage1, 'resources', 'app.asar'))) {
          throw new Error(`nsis-payload-missing (no $PLUGINSDIR/app-*.7z, no direct tree) — 7z said: ${stage1Tail.join(' | ')}`)
        }
      })(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('extraction-timeout')), EXTRACTION_TIMEOUT_MS)),
    ]).catch((err) => { throw new Error(`extract-failed: ${(err as Error).message}`) })

    const payload = locatePayload(stage1, stage2)
    const asarPath = path.join(payload.root, 'resources', 'app.asar')
    const unpackedTree = path.join(payload.root, 'resources', 'app.asar.unpacked')

    const asarSha256 = await sha256OfFile(asarPath)
    const asarSize = fs.statSync(asarPath).size
    const outref = createOutref(unpackedTree)
    const outrefSha = createHash('sha256').update(outref.buf).digest('hex')
    const fingerprint = computeNativeFingerprint(payload.root)
    const runtimeKey = payload.electronVersion ? `electron-${payload.electronVersion}-${payload.arch}` : ''

    // Store under the SAME naming convention POST /:id/release-refs uses so
    // storage inventories and the delta manager treat both sources alike.
    const stamp = Date.now()
    const asarKey = `desktop/asar-${row.platform}-${row.version}-${stamp}-app.asar`
    const outrefKey = `desktop/outref-${row.platform}-${row.version}-${stamp}-outref.bin`
    fs.mkdirSync(path.join(UPLOAD_DIR, 'desktop'), { recursive: true })
    fs.copyFileSync(asarPath, path.join(UPLOAD_DIR, asarKey))
    fs.writeFileSync(path.join(UPLOAD_DIR, outrefKey), outref.buf)

    const data: Record<string, string | number> = {
      asarStorageKey: asarKey,
      asarSha256,
      asarSize,
      outrefStorageKey: outrefKey,
      outrefSha256: outrefSha,
      outrefSize: outref.buf.length,
      nativeFingerprint: fingerprint,
    }
    if (runtimeKey) data.runtimeKey = runtimeKey
    await db.appVersion.update({ where: { id: row.id }, data })

    // Best-effort cleanup of the row's REPLACED ref files (timestamps make
    // every upload unique, so the old keys belong to this row alone).
    for (const oldKey of [row.asarStorageKey, row.outrefStorageKey]) {
      if (!oldKey || oldKey === asarKey || oldKey === outrefKey) continue
      const oldPath = path.resolve(UPLOAD_DIR, oldKey)
      if (oldPath.startsWith(path.resolve(UPLOAD_DIR) + path.sep)) {
        try { fs.unlinkSync(oldPath) } catch { /* best effort */ }
      }
    }

    recentFailures.delete(versionId)
    console.log(`[ref-backfill] ${row.platform} ${row.version}: refs rebuilt from installer — asar ${asarSize}B, outref ${outref.buf.length}B, runtimeKey ${runtimeKey || '(unknown)'} (electron ${payload.electronVersion || '?'} via ${payload.versionSource}, arch ${payload.arch})`)
    return {
      ...base,
      ok: true,
      electronVersion: payload.electronVersion || undefined,
      versionSource: payload.versionSource,
      arch: payload.arch,
      runtimeKey: runtimeKey || undefined,
      nativeFingerprint: fingerprint,
      asarSha256,
      asarSize,
      outrefSize: outref.buf.length,
    }
  } catch (err) {
    recentFailures.set(versionId, Date.now())
    const reason = (err as Error).message || 'backfill-failed'
    console.warn(`[ref-backfill] ${row.platform} ${row.version}: FAILED — ${reason}`)
    return { ...base, reason }
  } finally {
    inFlight.delete(versionId)
    try { fs.rmSync(workDir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

/** UI/delta-manager hint: could this row be healed right now? */
export function rowIsBackfillable(row: { platform: string; asarStorageKey: string | null; outrefStorageKey: string | null; fileStorageKey: string | null }): boolean {
  return isDesktopPlatform(row.platform)
    && !!row.fileStorageKey
    && !(!!row.asarStorageKey && !!row.outrefStorageKey)
}
