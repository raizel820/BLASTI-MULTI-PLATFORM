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

  // ── Task 75: staleness guard ────────────────────────────────────────────
  // `out/` is gitignored and only rebuilt by explicit export builds. The
  // dev flow never uses it (electron:dev loads the live dev server), but
  // the PACKAGED app ships it — so a stale export silently bundled OLD
  // renderer code into the installer: bugs already fixed for `bun run
  // electron:dev` (e.g. the offline-mode banner) reappeared only in
  // win-unpacked. Fail the build when the export predates the newest web
  // source file so staleness can never ship quietly again.
  // Escape hatch for intentional legacy builds: BLASTI_ALLOW_STALE_OUT=1.
  const newestMtime = (dir, best) => {
    let latest = best;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return latest; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      try {
        if (entry.isDirectory()) latest = newestMtime(full, latest);
        else {
          const m = fs.statSync(full).mtimeMs;
          if (m > latest) latest = m;
        }
      } catch { /* unreadable entry — skip */ }
    }
    return latest;
  };

  if (fs.existsSync(src)) {
    const outMtime = newestMtime(src, 0);
    const srcRoot = path.resolve(__dirname, '../../web');
    let srcMtime = newestMtime(path.join(srcRoot, 'src'), 0);
    for (const cfgFile of ['next.config.ts', 'package.json']) {
      try {
        const m = fs.statSync(path.join(srcRoot, cfgFile)).mtimeMs;
        if (m > srcMtime) srcMtime = m;
      } catch { /* optional file */ }
    }
    const isStale = outMtime > 0 && srcMtime > 0 && srcMtime - outMtime > 5000; // 5s slack
    if (isStale && process.env.BLASTI_ALLOW_STALE_OUT !== '1') {
      console.error('[prebuild] STALE WEB EXPORT — the packaged app would ship OLD renderer code.');
      console.error('[prebuild]   apps/web/out is OLDER than the newest file under apps/web/src.');
      console.error('[prebuild]   This is how "fixed in electron:dev but broken in win-unpacked" happens:');
      console.error('[prebuild]   dev loads the live server, the installer ships the stale export.');
      console.error('[prebuild]   Fix: run the build from the repo root —  bun run build:desktop');
      console.error('[prebuild]        (or refresh the export first:  bun run build:export )');
      console.error('[prebuild]   Override (NOT recommended): set BLASTI_ALLOW_STALE_OUT=1');
      errors.push('Stale web export (older than web source)');
    } else if (isStale) {
      console.warn('[prebuild] BLASTI_ALLOW_STALE_OUT=1 — shipping a stale web export anyway.');
    }
    if (fs.existsSync(dest)) {
      fs.rmSync(dest, { recursive: true });
    }
    fs.cpSync(src, dest, { recursive: true });
    console.log('[prebuild] Copied web build to out/' + (isStale ? ' (STALE — see guard above)' : ''));
  } else {
    console.error('[prebuild] Web build not found at:', src);
    console.error('[prebuild]   Run first: bun run build:export   (from the repo root, or bun run build:desktop)');
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
//
// Task 74: the stamp also BAKES the effective cloud URL (Task 74 resolution
// order: OS env > apps/desktop/.env > project root .env BLASTI_* — the same
// chain load-env.js applies at runtime, minus the packaged-resources path).
// A packaged app resolves this value as fallback #3, so an installer built on
// a configured machine carries its cloud URL; one built on a bare checkout
// (apps/desktop/.env is gitignored) falls back to the production VPS default
// in main.js instead of the dev-only localhost:3003.
{
  let git = null;
  try {
    git = require('child_process').execSync('git rev-parse --short HEAD', {
      cwd: path.resolve(__dirname, '../..'),
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { git = null; } // not a git checkout — timestamp alone still identifies the build

  // Resolve the cloud URL exactly like the runtime would.
  const { readEnvVars } = require('../load-env');
  let cloudBaseUrl = process.env.BLASTI_CLOUD_URL || process.env.BLASTI_API_URL || null;
  let cloudUrlSource = cloudBaseUrl ? 'OS environment variable' : null;
  if (!cloudBaseUrl) {
    const desktopVars = readEnvVars(path.resolve(__dirname, '../.env'));
    const v = desktopVars && (desktopVars.BLASTI_CLOUD_URL || desktopVars.BLASTI_API_URL);
    if (v) { cloudBaseUrl = v; cloudUrlSource = 'apps/desktop/.env'; }
  }
  if (!cloudBaseUrl) {
    // Same namespace rule as load-env.js: BLASTI_* keys only from the root .env
    // (dev convenience shared with the web/api stack — keeps cloud secrets out).
    const rootVars = readEnvVars(path.resolve(__dirname, '../../../.env'));
    const v = rootVars && (rootVars.BLASTI_CLOUD_URL || rootVars.BLASTI_API_URL);
    if (v) { cloudBaseUrl = v; cloudUrlSource = 'project root .env'; }
  }
  // Normalize like load-env.js: bare origin only, never a path.
  if (cloudBaseUrl) {
    cloudBaseUrl = String(cloudBaseUrl).trim().replace(/\/+$/, '').replace(/\/api$/i, '');
    if (!/^https?:\/\//i.test(cloudBaseUrl) || cloudBaseUrl.length <= 'http://x'.length) {
      console.warn('[prebuild] BLASTI_CLOUD_URL is not a valid http(s) origin — ignoring it:', cloudBaseUrl);
      cloudBaseUrl = null;
      cloudUrlSource = null;
    }
  }

  const stamp = {
    builtAt: new Date().toISOString(),
    git,
    cloudBaseUrl: cloudBaseUrl || null,
    cloudUrlSource: cloudUrlSource,
  };
  fs.writeFileSync(path.resolve(__dirname, '../build-stamp.json'), JSON.stringify(stamp, null, 2) + '\n');
  console.log('[prebuild] Wrote build-stamp.json:', stamp.builtAt, git ? '(git ' + git + ')' : '');
  if (cloudBaseUrl) {
    console.log('[prebuild] Cloud URL baked into the installer:', cloudBaseUrl, '(from ' + cloudUrlSource + ')');
  } else {
    console.warn('[prebuild] No cloud URL configured on this machine (BLASTI_CLOUD_URL not set and no .env with it) —');
    console.warn('[prebuild]   the packaged app will use the built-in production VPS default at runtime.');
  }
}

// ─── Step 4: Packaging completeness guard (Task 71) ────────────────────────────
// electron-builder.yml packages from an explicit files: allowlist. A runtime
// require()d file forgotten in that list builds fine and then crashes the
// packaged app on first launch ("Cannot find module './load-env'"). This
// check walks the require() graph of the entry files and fails the build
// BEFORE packaging when something is missing from disk or from the allowlist.
{
  try {
    const { checkPackagingCompleteness } = require('./check-packaging.js');
    const problems = checkPackagingCompleteness();
    if (problems.length > 0) {
      console.error('\n[prebuild] Packaging completeness check FAILED — the packaged app would crash at startup:');
      for (const p of problems) console.error('  - ' + p);
      console.error('\nFix: add the missing file(s) to the `files:` list in electron-builder.yml (or git pull if your checkout is stale)');
      errors.push('Packaging completeness check failed');
    } else {
      console.log('[prebuild] Packaging completeness OK (all require()d files exist and are allow-listed)');
    }
  } catch (err) {
    // The guard itself must never block a build on its own failure.
    console.warn('[prebuild] Packaging completeness check could not run:', err.message || err);
  }
}

// ─── Summary ────────────────────────────────────────────────────────────────────
if (errors.length > 0) {
  console.error('\n[prebuild] FAILED with ' + errors.length + ' error(s)');
  process.exit(1);
} else {
  console.log('\n[prebuild] Prebuild complete');
}
