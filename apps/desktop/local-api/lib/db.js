/**
 * Local API Database — Prisma-backed SQLite for Electron
 *
 * Creates a separate PrismaClient instance pointing to a LOCAL SQLite file
 * (inside Electron's userData directory). This is completely independent from
 * the cloud API's database.
 *
 * On first startup, automatically pushes the Prisma schema to create tables.
 *
 * Module resolution: In bun workspaces, @prisma/client is hoisted via symlinks
 * that may not work with Electron's Node.js require() on Windows. This module:
 *   1. Tries multiple paths to find the Prisma client runtime
 *   2. Uses fs.realpathSync() to resolve bun symlinks to real paths
 *   3. If not found, auto-generates the client using the locally-installed prisma CLI
 *   4. Copies the generated output to a stable directory (no symlinks)
 *
 * IMPORTANT: Inside Electron, process.execPath points to the Electron binary,
 * NOT Node.js. We must NEVER use process.execPath to run CLI tools like prisma,
 * because Electron will interpret the script as a new Electron app and crash.
 * Instead, we use findNodeRuntime() to locate the actual Node.js or bun binary.
 *
 * Usage: const { localDb } = require('./lib/db')
 */

const path = require('path')
const fs = require('fs')
const { execFileSync } = require('child_process')

// ─── Paths ─────────────────────────────────────────────────────────────────

const MONOREPO_ROOT = path.resolve(__dirname, '../../../../')

/**
 * The prisma schema shared by the whole monorepo.
 */
const SCHEMA_PATH = path.join(MONOREPO_ROOT, 'packages', 'db', 'prisma', 'schema.prisma')

/**
 * Stable output directory for the generated Prisma client.
 * After `prisma generate`, we copy the generated files here so that
 * Electron's require() never needs to follow symlinks.
 */
const GENERATED_CLIENT_DIR = path.join(MONOREPO_ROOT, 'node_modules', '.prisma', 'client')

// ─── Find a Real Node.js / bun Runtime ──────────────────────────────────
// CRITICAL: Inside Electron, process.execPath is the Electron binary (e.g. electron.exe).
// Running prisma CLI through Electron crashes the entire app (exit code 255).
// We need to find the actual Node.js or bun runtime to execute CLI scripts.

let _cachedNodeRuntime = null

/**
 * Find a suitable Node.js or bun binary to run CLI tools.
 * This is essential inside Electron where process.execPath is NOT Node.js.
 *
 * Search order:
 *   1. BUN runtime (detected via env var set by bun's process manager)
 *   2. System 'node' from PATH
 *   3. System 'bun' from PATH
 *   4. npx (which delegates to node)
 *
 * Returns { runtime: string, args: string[] } or null if nothing found.
 */
function findNodeRuntime() {
  if (_cachedNodeRuntime) return _cachedNodeRuntime

  const isWin = process.platform === 'win32'

  // 1. Check if bun set BUN_INSTALL or we can find the bun executable
  //    Bun workspaces often set this when running scripts
  const bunInstall = process.env.BUN_INSTALL
  if (bunInstall) {
    const bunExe = isWin ? 'bun.exe' : 'bun'
    const bunPath = path.join(bunInstall, bunExe)
    if (fs.existsSync(bunPath)) {
      _cachedNodeRuntime = { runtime: bunPath, type: 'bun' }
      console.log(`[local-api:db] Found bun runtime: ${bunPath}`)
      return _cachedNodeRuntime
    }
  }

  // 2. Try 'node' from PATH
  try {
    const nodePath = execFileSync(
      isWin ? 'where.exe' : 'which',
      ['node'],
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim().split('\n')[0]

    if (nodePath && fs.existsSync(nodePath)) {
      _cachedNodeRuntime = { runtime: nodePath, type: 'node' }
      console.log(`[local-api:db] Found node runtime: ${nodePath}`)
      return _cachedNodeRuntime
    }
  } catch { /* node not found in PATH */ }

  // 3. Try 'bun' from PATH
  try {
    const bunPath = execFileSync(
      isWin ? 'where.exe' : 'which',
      ['bun'],
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim().split('\n')[0]

    if (bunPath && fs.existsSync(bunPath)) {
      _cachedNodeRuntime = { runtime: bunPath, type: 'bun' }
      console.log(`[local-api:db] Found bun runtime: ${bunPath}`)
      return _cachedNodeRuntime
    }
  } catch { /* bun not found in PATH */ }

  // 4. Try common Node.js installation paths on Windows
  if (isWin) {
    const programFiles = [
      process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'],
      process.env.LOCALAPPDATA,
    ].filter(Boolean)

    for (const base of programFiles) {
      const candidates = [
        path.join(base, 'nodejs', 'node.exe'),
        path.join(base, 'Node.js', 'node.exe'),
      ]
      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
          _cachedNodeRuntime = { runtime: candidate, type: 'node' }
          console.log(`[local-api:db] Found node at: ${candidate}`)
          return _cachedNodeRuntime
        }
      }
    }
  }

  // 5. Try common Node.js paths on macOS/Linux
  const unixCandidates = [
    '/usr/local/bin/node',
    '/usr/bin/node',
    '/opt/homebrew/bin/node',
    '/opt/homebrew/bin/bun',
    path.join(process.env.HOME || '/tmp', '.bun', 'bin', 'bun'),
  ]
  for (const candidate of unixCandidates) {
    if (fs.existsSync(candidate)) {
      _cachedNodeRuntime = { runtime: candidate, type: 'bun' }
      console.log(`[local-api:db] Found runtime at: ${candidate}`)
      return _cachedNodeRuntime
    }
  }

  console.warn('[local-api:db] No Node.js or bun runtime found — CLI operations will fail')
  return null
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Scan a directory and return entry names (non-recursive).
 */
function scanDir(dir) {
  try {
    return fs.readdirSync(dir) || []
  } catch {
    return []
  }
}

/**
 * Find the locally installed prisma CLI entry point.
 * Returns the JS entry file path or null if not found.
 */
function findPrismaBin() {
  // bun hoisted cache — scan for prisma@ package
  const bunDir = path.join(MONOREPO_ROOT, 'node_modules', '.bun')
  const dirs = scanDir(bunDir).filter(d => d.startsWith('prisma@'))
  for (const d of dirs) {
    const entry = path.join(bunDir, d, 'node_modules', 'prisma', 'build', 'index.js')
    if (fs.existsSync(entry)) return entry
  }

  // Standard node_modules/.bin
  const binPath = path.join(MONOREPO_ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'prisma.cmd' : 'prisma')
  if (fs.existsSync(binPath)) return binPath

  // Also try without .cmd on Windows (sometimes works)
  const binPathNoCmd = path.join(MONOREPO_ROOT, 'node_modules', '.bin', 'prisma')
  if (fs.existsSync(binPathNoCmd)) return binPathNoCmd

  return null
}

/**
 * Execute a prisma CLI command using a proper Node.js/bun runtime.
 * Uses execFileSync to avoid shell encoding issues with non-ASCII paths (e.g. Arabic usernames).
 *
 * @param {string[]} args - CLI arguments (e.g. ['db', 'push', '--schema=...', '--accept-data-loss'])
 * @param {object} opts - Options: { cwd, timeout, env }
 * @returns {{ success: boolean, stdout: string, stderr: string, code: number|null }}
 */
function runPrismaCommand(args, opts = {}) {
  const rt = findNodeRuntime()
  if (!rt) {
    return { success: false, stdout: '', stderr: 'No Node.js/bun runtime found', code: -1 }
  }

  const prismaBin = findPrismaBin()
  if (!prismaBin) {
    return { success: false, stdout: '', stderr: 'Prisma CLI not found', code: -1 }
  }

  const cwd = opts.cwd || path.join(MONOREPO_ROOT, 'packages', 'db')
  const timeout = opts.timeout || 60000
  const env = { ...process.env, ...opts.env }

  try {
    // Use execFileSync with separate args array to avoid shell quoting issues
    // This properly handles non-ASCII characters in paths
    const stdout = execFileSync(rt.runtime, [prismaBin, ...args], {
      cwd,
      env,
      timeout,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024, // 1MB buffer
    })

    return { success: true, stdout: stdout || '', stderr: '', code: 0 }
  } catch (err) {
    return {
      success: false,
      stdout: err.stdout || '',
      stderr: err.stderr || err.message || '',
      code: err.status || -1,
    }
  }
}

// ─── Auto-Generate Prisma Client (if missing) ─────────────────────────────

/**
 * Run `prisma generate` using the locally installed CLI (v6.x).
 * Then copies the generated output to GENERATED_CLIENT_DIR.
 *
 * Returns true on success, false on failure.
 */
function generatePrismaClient() {
  if (!fs.existsSync(SCHEMA_PATH)) {
    console.error('[local-api:db] Schema not found:', SCHEMA_PATH)
    return false
  }

  console.log(`[local-api:db] Auto-generating Prisma client ...`)
  console.log(`[local-api:db] Schema: ${SCHEMA_PATH}`)

  const result = runPrismaCommand([
    'generate',
    `--schema=${SCHEMA_PATH}`,
  ], {
    cwd: path.join(MONOREPO_ROOT, 'packages', 'db'),
    timeout: 60000,
  })

  if (!result.success) {
    console.error('[local-api:db] prisma generate failed:', result.stderr.substring(0, 300))
    return false
  }

  if (result.stdout) {
    const lines = result.stdout.trim().split('\n').filter(l => l && !l.includes('warn'))
    if (lines.length > 0) {
      console.log('[local-api:db] Generate:', lines.join(' | '))
    }
  }

  // Find where the generated files landed (prisma outputs the path in the result)
  // Then copy them to our stable GENERATED_CLIENT_DIR
  const sourceDir = findGeneratedClientDir()
  if (sourceDir) {
    copyDirRecursive(sourceDir, GENERATED_CLIENT_DIR)
    console.log(`[local-api:db] Copied generated client to ${GENERATED_CLIENT_DIR}`)
    return fs.existsSync(path.join(GENERATED_CLIENT_DIR, 'index.js'))
  }

  // Fallback: the output might already be at the default location
  return true
}

/**
 * Find the directory where `prisma generate` just placed the output.
 * Scans bun's hoist cache for @prisma+client dirs that contain generated files.
 */
function findGeneratedClientDir() {
  const bunDir = path.join(MONOREPO_ROOT, 'node_modules', '.bun')
  if (!fs.existsSync(bunDir)) return null

  const dirs = scanDir(bunDir)
  const prismaDir = dirs.find(e => e.startsWith('@prisma+client'))
  if (!prismaDir) return null

  // Resolve symlinks to get the real path
  const clientPath = path.join(bunDir, prismaDir, 'node_modules', '@prisma', 'client')
  try {
    const realPath = fs.realpathSync(clientPath)
    if (fs.existsSync(path.join(realPath, 'index.js'))) {
      return realPath
    }
  } catch { /* ignore */ }

  // Try without symlink resolution
  if (fs.existsSync(path.join(clientPath, 'index.js'))) {
    return clientPath
  }

  return null
}

/**
 * Recursively copy a directory. Overwrites existing files.
 */
function copyDirRecursive(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true })
  }

  const entries = scanDir(src)
  for (const entry of entries) {
    const srcPath = path.join(src, entry)
    const destPath = path.join(dest, entry)
    const stat = fs.statSync(srcPath)

    if (stat.isDirectory()) {
      copyDirRecursive(srcPath, destPath)
    } else {
      fs.copyFileSync(srcPath, destPath)
    }
  }
}

// ─── Robust PrismaClient Resolution ───────────────────────────────────────
// Strategy:
//   1. Stable generated dir (GENERATED_CLIENT_DIR) — no symlinks
//   2. Standard @prisma/client resolution
//   3. Monorepo root node_modules
//   4. Bun's hoisted cache — with realpathSync to resolve symlinks
//   5. Electron production resources
//   6. If nothing works → auto-generate → retry

let PrismaClient = null
let prismaRequireError = null

/**
 * Try to resolve PrismaClient from a list of candidate paths.
 * For each path that exists, tries require() with symlink resolution.
 */
function tryResolvePrismaClient() {
  const candidatePaths = [
    // 1. Stable generated client dir (most reliable — no symlinks)
    GENERATED_CLIENT_DIR,
    // 2. Standard Node.js resolution
    '@prisma/client',
    // 3. Monorepo root node_modules
    path.join(MONOREPO_ROOT, 'node_modules', '@prisma', 'client'),
    // 4. packages/db own node_modules (bun workspace may install here)
    path.join(MONOREPO_ROOT, 'packages', 'db', 'node_modules', '@prisma', 'client'),
    // 5. Electron production resources
    path.join(process.resourcesPath || '', 'node_modules', '@prisma', 'client'),
    // 6. App directory (electron-builder asar unpacked)
    path.join(path.dirname(process.execPath), '..', 'resources', 'app.asar.unpacked', 'node_modules', '@prisma', 'client'),
  ]

  // 5. Bun's hoisted cache — resolve symlinks for Windows compatibility
  const bunDir = path.join(MONOREPO_ROOT, 'node_modules', '.bun')
  if (fs.existsSync(bunDir)) {
    const dirs = scanDir(bunDir)
    const prismaDir = dirs.find(e => e.startsWith('@prisma+client'))
    if (prismaDir) {
      const clientPath = path.join(bunDir, prismaDir, 'node_modules', '@prisma', 'client')
      // Try with symlink resolution first (critical for Windows)
      try {
        const realPath = fs.realpathSync(clientPath)
        candidatePaths.push(realPath)
      } catch { /* ignore */ }
      // Also try the raw path as fallback
      candidatePaths.push(clientPath)
    }
  }

  for (const p of candidatePaths) {
    try {
      const mod = require(p)
      const PC = mod.PrismaClient || mod.default?.PrismaClient || mod
      if (PC && typeof PC === 'function') {
        console.log(`[local-api:db] Resolved PrismaClient from: ${p}`)
        return PC
      }
    } catch (err) {
      // Log only first few failures for diagnostics (avoid spam)
      if (!prismaRequireError) {
        console.log(`[local-api:db] Failed to resolve from: ${p} — ${err.message?.substring(0, 80) || 'unknown'}`)
      }
    }
  }

  return null
}

// ── First attempt ──────────────────────────────────────────────────────────
PrismaClient = tryResolvePrismaClient()

// ── Auto-generate if not found ─────────────────────────────────────────────
if (!PrismaClient) {
  console.warn('[local-api:db] PrismaClient not found — auto-generating...')

  if (generatePrismaClient()) {
    PrismaClient = tryResolvePrismaClient()
  }

  if (!PrismaClient) {
    prismaRequireError = new Error(
      'Cannot find or generate @prisma/client module.\n' +
      'Auto-generation was attempted but failed.\n' +
      'Please run manually:\n' +
      '  cd packages/db && npx prisma generate'
    )
    console.error('[local-api:db]', prismaRequireError.message)
  }
}

// ─── Database Configuration (single authoritative path) ──────────────────
// ═══════════════════════════════════════════════════════════════════════════
// EXACTLY ONE authoritative local database location exists:
//
//     Electron main process sets BLASTI_LOCAL_DB_DIR to
//     <app.getPath('userData')>/blasti-local  (i.e.
//     %APPDATA%/@blasti/desktop/blasti-local on Windows) BEFORE any
//     local-api module is required — see main.js.
//
// Everything (embedded API, sync service, diagnostics, migrations, IPC)
// resolves through this module, so they all see the same file. When no
// Electron context is present (tests, standalone runs), the fallback is
// ~/.blasti/local — and a legacy database found at the old location is
// MIGRATED (copied + verified) to the authoritative one, never abandoned.
// ═══════════════════════════════════════════════════════════════════════════

const { ensureSchema } = require('./schema-migrations')

const HOME_DIR = process.env.HOME || process.env.USERPROFILE || '/tmp'

/** Legacy DB locations (old modules resolved these independently). */
function legacyDbCandidates() {
  return [
    path.join(HOME_DIR, '.blasti', 'local', 'local.db'), // pre-v2 lib/db.js default
  ]
}

let resolvedDbDir = null
let resolvedDbPath = null
let resolvedDatabaseUrl = null
let clientCreationDir = null

function resolveDbDir() {
  return process.env.BLASTI_LOCAL_DB_DIR || path.join(HOME_DIR, '.blasti', 'local')
}

function resolvePaths() {
  resolvedDbDir = resolveDbDir()
  resolvedDbPath = path.join(resolvedDbDir, 'local.db')
  resolvedDatabaseUrl = `file:${resolvedDbPath}`
  return { resolvedDbDir, resolvedDbPath, resolvedDatabaseUrl }
}
resolvePaths()
// The directory must exist before SQLite can open the file (SQLite creates
// the FILE, never parent DIRECTORIES). Creating the directory is a safe,
// non-destructive operation — schema work stays inside ensureDatabaseReady().
try { fs.mkdirSync(resolvedDbDir, { recursive: true }) } catch { /* ignore */ }

// ─── PrismaClient Instance ────────────────────────────────────────────────

let localDb = null

function createClient() {
  if (!PrismaClient) return null
  try {
    const client = new PrismaClient({
      datasources: {
        db: {
          url: resolvedDatabaseUrl
        }
      },
      log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
    })
    clientCreationDir = resolvedDbDir
    console.log(`[LocalDB] Authoritative DB path: ${resolvedDbPath}`)
    console.log('[local-api:db] PrismaClient initialized successfully')
    return client
  } catch (err) {
    console.error('[local-api:db] Failed to create PrismaClient:', err.message)
    prismaRequireError = err
    return null
  }
}

localDb = createClient()

/**
 * If BLASTI_LOCAL_DB_DIR changed after the client was created (late env
 * wiring), recreate the client against the authoritative path. This closes
 * the historic race where one module decided ~/.blasti/local while another
 * decided <userData>/blasti-local.
 */
function reconcileClientWithEnv() {
  const dir = resolveDbDir()
  if (dir === resolvedDbDir && dir === clientCreationDir) return false
  resolvePaths()
  if (localDb && clientCreationDir !== resolvedDbDir) {
    console.warn(`[LocalDB] DB directory changed after client creation (${clientCreationDir} → ${resolvedDbDir}) — rebinding client`)
    try { localDb.$disconnect?.() } catch { /* ignore */ }
    localDb = createClient()
  }
  return true
}

// ─── Legacy Database Migration (one-time, copy-then-verify) ───────────────

function copyFileIfExists(src, dest) {
  if (!fs.existsSync(src)) return false
  fs.copyFileSync(src, dest)
  return true
}

/**
 * If the authoritative database does not exist yet but a legacy database
 * does, migrate (COPY) it to the authoritative path and verify integrity.
 * The legacy file is NEVER deleted — it remains as a backup; migration is
 * recorded in `_sync_meta` for diagnostics.
 */
function migrateLegacyDatabase() {
  const targetDir = resolvedDbDir
  const targetPath = resolvedDbPath

  if (fs.existsSync(targetPath)) {
    return { migrated: false, reason: 'authoritative-exists' }
  }

  // Legacy migration applies ONLY to the Electron-managed directory
  // convention (<userData>/blasti-local). Standalone/test directories
  // (BLASTI_LOCAL_DB_DIR set to e.g. ~/.blasti/test-sync) must stay
  // isolated from any pre-existing development database.
  if (path.basename(targetDir) !== 'blasti-local') {
    return { migrated: false, reason: 'non-app-directory' }
  }

  try { fs.mkdirSync(targetDir, { recursive: true }) } catch { /* ignore */ }

  for (const legacyPath of legacyDbCandidates()) {
    if (path.resolve(legacyPath) === path.resolve(targetPath)) continue
    if (!fs.existsSync(legacyPath)) continue

    console.log(`[LocalDB] Legacy database detected: ${legacyPath}`)
    console.log('[LocalDB] Migrating legacy database...')

    try {
      copyFileIfExists(legacyPath, targetPath)
      copyFileIfExists(legacyPath + '-wal', targetPath + '-wal')
      copyFileIfExists(legacyPath + '-shm', targetPath + '-shm')

      const size = fs.existsSync(targetPath) ? fs.statSync(targetPath).size : 0
      if (size <= 0) {
        console.warn('[LocalDB] Migration produced an empty file — discarding copy, legacy file kept intact')
        try { fs.rmSync(targetPath, { force: true }) } catch { /* ignore */ }
        continue
      }

      console.log(`[LocalDB] Migration verified. (${Math.round(size / 1024)}KB copied — integrity will be verified during schema check)`)
      console.log(`[LocalDB] Using database: ${targetPath}`)
      migrationRecord = { from: legacyPath, to: targetPath, at: new Date().toISOString(), sizeBytes: size }
      return { migrated: true, from: legacyPath }
    } catch (err) {
      console.error('[LocalDB] Legacy migration failed:', err.message, '— legacy file left untouched')
      try { fs.rmSync(targetPath, { force: true }) } catch { /* ignore */ }
    }
  }

  return { migrated: false, reason: 'no-legacy-found' }
}

let migrationRecord = null

/**
 * Record the completed migration inside the (now authoritative) database.
 * Called after ensureSchema has created/stamped the schema.
 */
async function recordMigration(db) {
  if (!migrationRecord || !db) return
  try {
    await db.$executeRawUnsafe(
      'INSERT INTO "_sync_meta" ("key", "value") VALUES (?, ?) ' +
      'ON CONFLICT("key") DO UPDATE SET "value" = excluded."value"',
      'migrated_from', migrationRecord.from
    )
    await db.$executeRawUnsafe(
      'INSERT INTO "_sync_meta" ("key", "value") VALUES (?, ?) ' +
      'ON CONFLICT("key") DO UPDATE SET "value" = excluded."value"',
      'migrated_at', migrationRecord.at
    )
    console.log('[LocalDB] Migration recorded in _sync_meta')
    migrationRecord = null
  } catch (err) {
    console.warn('[LocalDB] Could not record migration:', err.message)
  }
}

// ─── Authoritative Startup Initialization ─────────────────────────────────
// Replaces the destructive `prisma db push --accept-data-loss` startup push.
// NEVER uses destructive Prisma schema synchronization — see schema-migrations.js.

let ensurePromise = null

async function ensureDatabaseReady() {
  if (ensurePromise) return ensurePromise

  ensurePromise = (async () => {
    reconcileClientWithEnv()

    // The authoritative directory must exist before SQLite can open the file
    // (SQLite creates the FILE, never parent DIRECTORIES).
    try { fs.mkdirSync(resolvedDbDir, { recursive: true }) } catch { /* ignore */ }

    if (!localDb) {
      // One retry through auto-generation (packaged/first-run scenario).
      if (generatePrismaClient()) {
        PrismaClient = tryResolvePrismaClient()
        localDb = createClient()
      }
      if (!localDb) {
        return { ok: false, error: prismaRequireError?.message || 'Prisma client unavailable' }
      }
    }

    // One-time legacy migration (copy old DB → authoritative path).
    const migration = migrateLegacyDatabase()
    if (!migration.migrated && migration.reason === 'authoritative-exists') {
      // Ensure the directory exists for any auxiliary writes.
      try { fs.mkdirSync(resolvedDbDir, { recursive: true }) } catch { /* ignore */ }
    }

    // Controlled, non-destructive schema lifecycle (create/adopt/upgrade/verify).
    const schemaResult = await ensureSchema(localDb)

    await recordMigration(localDb)
    await setupPragmas()

    if (!schemaResult.ok) {
      console.error(`[LocalDB] Schema initialization FAILED (action=${schemaResult.action}):`,
        schemaResult.errors[0]?.error || 'unknown')
    } else {
      console.log(`[LocalDB] Schema ready (action=${schemaResult.action}, version=${schemaResult.version})`)
      // Local database verified — read and log the durable initialization state.
      try {
        const rows = await localDb.$queryRawUnsafe(
          'SELECT "initializationStatus", "agencyId", "recordsImported", "lastError" FROM "AgencyLocalState" LIMIT 1'
        )
        if (rows && rows[0]) {
          const s = rows[0]
          const why = s.lastError ? `, lastError=${String(s.lastError).substring(0, 80)}` : ''
          console.log(`[LocalDB] Initialization state: ${s.initializationStatus} (agency=${s.agencyId ? String(s.agencyId).substring(0, 8) + '…' : 'none'}, recordsImported=${s.recordsImported ?? 0}${why})`)
        } else {
          console.log('[LocalDB] Initialization state: NOT_INITIALIZED (no AgencyLocalState row — this database has never completed a v2 initial sync; legacy data may still be present)')
        }
      } catch (stateErr) {
        console.warn('[LocalDB] Initialization state read skipped:', stateErr?.message?.substring(0, 80) || stateErr)
      }
    }

    return {
      ok: schemaResult.ok,
      schema: schemaResult,
      path: resolvedDbPath,
      error: schemaResult.ok ? null : (schemaResult.errors[0]?.error || 'schema initialization failed'),
    }
  })()

  try {
    return await ensurePromise
  } finally {
    // Allow retry after a failure (e.g. transient FS issue), but keep the
    // in-flight promise singleton for concurrent callers.
    const res = await ensurePromise
    if (!res?.ok) ensurePromise = null
  }
}

// ─── Pragmas ──────────────────────────────────────────────────────────────

async function setupPragmas() {
  if (!localDb) {
    console.warn('[local-api:db] Cannot set pragmas: no database connection')
    return
  }
  try {
    await localDb.$queryRaw`PRAGMA journal_mode = WAL`
    await localDb.$queryRaw`PRAGMA busy_timeout = 5000`
    await localDb.$queryRaw`PRAGMA synchronous = NORMAL`
  } catch (err) {
    console.warn('[local-api:db] Failed to set PRAGMAS:', err)
  }
}

// ─── Status ────────────────────────────────────────────────────────────────

function getDbStatus() {
  return {
    ready: !!localDb,
    path: resolvedDbPath,
    dir: resolvedDbDir,
    error: prismaRequireError ? prismaRequireError.message : null,
    hasPrismaClient: !!PrismaClient,
  }
}

/**
 * Attempt to create the PrismaClient after a successful generation.
 * Useful when the module was loaded before auto-generation completed.
 */
function reinitClient() {
  if (localDb) return true

  PrismaClient = tryResolvePrismaClient()
  if (!PrismaClient) return false

  localDb = createClient()
  return !!localDb
}

module.exports = {
  localDb,
  setupPragmas,
  ensureDatabaseReady,
  getDbStatus,
  reinitClient,
  generatePrismaClient,
  get DATABASE_URL() { return resolvedDatabaseUrl },
  get DB_PATH() { return resolvedDbPath },
  get DB_DIR() { return resolvedDbDir },
  GENERATED_CLIENT_DIR,
  SCHEMA_PATH,
}
