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

// ─── Database Configuration ───────────────────────────────────────────────

const DB_DIR = process.env.BLASTI_LOCAL_DB_DIR || path.join(
  process.env.HOME || process.env.USERPROFILE || '/tmp',
  '.blasti',
  'local'
)

if (!fs.existsSync(DB_DIR)) {
  try { fs.mkdirSync(DB_DIR, { recursive: true }) } catch { /* ignore */ }
}

const DB_PATH = path.join(DB_DIR, 'local.db')
const DATABASE_URL = `file:${DB_PATH}`

console.log(`[local-api:db] Database: ${DATABASE_URL}`)

// ─── Schema Push ─────────────────────────────────────────────────────────
// NOTE: Schema push runs synchronously at module load time on first run.
// It uses runPrismaCommand() which finds the proper Node.js/bun runtime
// instead of process.execPath (which would be the Electron binary).

function pushSchema() {
  if (!PrismaClient) {
    console.warn('[local-api:db] Cannot push schema: @prisma/client not available')
    return
  }

  if (!fs.existsSync(SCHEMA_PATH)) {
    console.warn('[local-api:db] Prisma schema not found at:', SCHEMA_PATH)
    return
  }

  console.log(`[local-api:db] Pushing schema with DATABASE_URL=${DATABASE_URL}`)

  const result = runPrismaCommand([
    'db', 'push',
    `--schema=${SCHEMA_PATH}`,
    '--accept-data-loss',
    '--skip-generate',
  ], {
    cwd: path.join(MONOREPO_ROOT, 'packages', 'db'),
    timeout: 30000,
    env: { DATABASE_URL },
  })

  if (result.success) {
    if (result.stdout) {
      const lines = result.stdout.trim().split('\n').filter(l => l && !l.includes('warn'))
      if (lines.length > 0) {
        console.log('[local-api:db] Schema push:', lines.join(' | '))
      }
    }
    return
  }

  // Handle known non-fatal errors
  const stderr = result.stderr
  if (stderr.includes('already in sync') || stderr.includes('Your database is already')) {
    console.log('[local-api:db] Schema already up to date')
    return
  }

  console.warn('[local-api:db] Schema push warning (exit', result.code + '):', stderr.substring(0, 300))
}

// Push schema on first run — wrapped in try-catch to never crash the module load
// IMPORTANT: Always push schema, not just on first run. If the Prisma schema
// was updated (new fields/tables), the local DB may be outdated and queries
// will fail with 500. `prisma db push` is a no-op when already in sync.
try {
  pushSchema()
} catch (err) {
  console.error('[local-api:db] Schema push threw unexpectedly:', err.message)
}

// ─── PrismaClient Instance ────────────────────────────────────────────────

let localDb = null

if (PrismaClient) {
  try {
    localDb = new PrismaClient({
      datasources: {
        db: {
          url: DATABASE_URL
        }
      },
      log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
    })
    console.log('[local-api:db] PrismaClient initialized successfully')
  } catch (err) {
    console.error('[local-api:db] Failed to create PrismaClient:', err.message)
    prismaRequireError = err
  }
} else {
  console.error('[local-api:db] PrismaClient not created — module not found')
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
    path: DB_PATH,
    dir: DB_DIR,
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

  try {
    localDb = new PrismaClient({
      datasources: { db: { url: DATABASE_URL } },
      log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
    })
    console.log('[local-api:db] PrismaClient re-initialized')
    return true
  } catch (err) {
    console.error('[local-api:db] Re-init failed:', err.message)
    return false
  }
}

module.exports = {
  localDb,
  setupPragmas,
  pushSchema,
  getDbStatus,
  reinitClient,
  generatePrismaClient,
  DATABASE_URL,
  DB_PATH,
  DB_DIR,
  GENERATED_CLIENT_DIR,
  SCHEMA_PATH,
}
