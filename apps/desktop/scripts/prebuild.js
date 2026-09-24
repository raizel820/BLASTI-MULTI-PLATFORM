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

// ─── Step 2: Build stamp (Task 40 — stale-bundle guard) ───────────────────────
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
