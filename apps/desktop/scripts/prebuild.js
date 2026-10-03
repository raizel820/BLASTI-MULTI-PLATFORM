/**
 * BLASTI Desktop — Prebuild Script
 *
 * Prepares the desktop app for packaging:
 *   1. Copies the Next.js static export (apps/web/out/) → apps/desktop/out/
 *
 * NOTE: The SQLite database copy step has been removed — offline data is now
 * handled by WatermelonDB in the renderer process, which uses LokiJS
 * (IndexedDB-backed) and syncs to /api/sync/* on the remote server.
 *
 * Usage: node scripts/prebuild.js
 * Run from: apps/desktop/ directory
 */

const fs = require('fs');
const path = require('path');

const errors = [];

// ─── Step 1: Copy web build ────────────────────────────────────────────────────
{
  const src = path.resolve(__dirname, '../../web/out');
  const dest = path.resolve(__dirname, '../out');

  if (fs.existsSync(src)) {
    if (fs.existsSync(dest)) {
      fs.rmSync(dest, { recursive: true });
    }
    fs.cpSync(src, dest, { recursive: true });
    console.log('[prebuild] Copied web build to out/');
  } else {
    console.error('[prebuild] Web build not found at:', src);
    console.error('[prebuild]   Run first: cd apps/web && NEXT_BUILD_MODE=export next build');
    errors.push('Web build not found');
  }
}

// ─── Step 2: Regenerate the DESKTOP SQLite Prisma client ───────────────────────
// The local offline DB is SQLite (apps/desktop/prisma/schema.prisma →
// provider "sqlite"), while the workspace client in node_modules/.prisma/client
// is the PostgreSQL client since the cloud migration. Packaging MUST ship the
// desktop-generated SQLite client (scripts/after-pack.js copies it into
// resources/node_modules). Regenerate on EVERY build so the engine binary
// always matches the machine that builds (and the schema is never stale).
{
  const schemaPath = path.resolve(__dirname, '../prisma/schema.prisma');
  const clientDir = path.resolve(__dirname, '../prisma/generated/client');
  let prismaBin = null;
  // Resolve the workspace prisma CLI entry (bun hoists into node_modules/.bun).
  const bunStore = path.resolve(__dirname, '../../../node_modules/.bun');
  try {
    const hit = fs.readdirSync(bunStore).find((d) => d.startsWith('prisma@'));
    if (hit) {
      const candidate = path.join(bunStore, hit, 'node_modules', 'prisma', 'build', 'index.js');
      if (fs.existsSync(candidate)) prismaBin = candidate;
    }
  } catch { /* no bun store */ }
  if (!prismaBin) {
    const fallback = path.resolve(__dirname, '../../../node_modules/prisma/build/index.js');
    if (fs.existsSync(fallback)) prismaBin = fallback;
  }

  if (!fs.existsSync(schemaPath) || !prismaBin) {
    console.error('[prebuild] Desktop prisma schema or prisma CLI not found — cannot generate the SQLite client');
    errors.push('Desktop prisma generate skipped (schema/CLI missing)');
  } else {
    console.log('[prebuild] Generating the desktop SQLite Prisma client …');
    try {
      // process.execPath here is the real node (scripts run via `node scripts/prebuild.js`).
      // Node's execFileSync handles non-ASCII usernames/paths correctly (the
      // spawn-ENOENT bug is Bun-specific).
      require('child_process').execFileSync(
        process.execPath,
        [prismaBin, 'generate', `--schema=${schemaPath}`],
        { cwd: path.resolve(__dirname, '..'), stdio: ['ignore', 'pipe', 'inherit'], timeout: 180000 },
      );
      if (!fs.existsSync(path.join(clientDir, 'index.js'))) throw new Error('client output missing after generate');
      console.log('[prebuild] Desktop SQLite client generated → prisma/generated/client');
    } catch (err) {
      console.error('[prebuild] Desktop prisma generate FAILED:', err.message || err);
      errors.push('Desktop prisma generate failed');
    }
  }
}

// ─── Step 3: Build stamp (Task 40 — stale-bundle guard) ───────────────────────
// Every packaged build writes a timestamp (+ git sha) that the loading screen
// and the main-process boot log surface. If a desktop install shows an old
// build date, its bundle predates the latest fixes — rebuild, don't debug.
{
  let git = null;
  try {
    git = require('child_process').execSync('git rev-parse --short HEAD', {
      cwd: path.resolve(__dirname, '../..'),
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { git = null; } // not a git checkout — timestamp alone still identifies the build
  const stamp = { builtAt: new Date().toISOString(), git };
  fs.writeFileSync(path.resolve(__dirname, '../build-stamp.json'), JSON.stringify(stamp, null, 2) + '\n');
  console.log('[prebuild] Wrote build-stamp.json:', stamp.builtAt, git ? '(git ' + git + ')' : '');
}

// ─── Summary ────────────────────────────────────────────────────────────────────
if (errors.length > 0) {
  console.error('\n[prebuild] FAILED with ' + errors.length + ' error(s)');
  process.exit(1);
} else {
  console.log('\n[prebuild] Prebuild complete');
}
