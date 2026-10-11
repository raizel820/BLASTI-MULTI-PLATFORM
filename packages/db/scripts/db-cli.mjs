/**
 * db-cli.mjs — Prisma CLI launcher with stale-URL protection + local pinning.
 *
 * WHY THIS EXISTS (3 reasons):
 *
 * 1) STALE-URL PROTECTION: the Prisma CLI needs DATABASE_URL. Precedence is:
 *    real process env > .env files. If a parent process (IDE terminal,
 *    sandbox daemon, CI) exports a STALE non-PostgreSQL DATABASE_URL (e.g.
 *    the legacy SQLite `file:` URL), it silently wins over every .env and
 *    `prisma db push` fails with P1012 "the URL must start with
 *    postgresql://". This launcher drops a non-postgres DATABASE_URL so the
 *    committed packages/db/.env (local dev default) applies instead. Real
 *    postgres URLs pass through untouched.
 *
 * 2) POSIX: spawn the WORKSPACE-RESOLVED prisma CLI (pinned by
 *    bun.lock/require.resolve — never `bun x` bare names, see 3) directly
 *    under the current runtime. No shell involved.
 *
 * 3) WINDOWS + NON-ASCII USERNAMES — three generations of field bugs:
 *      a) Bun's spawner (uv_spawn) cannot launch an executable whose path
 *         contains non-ASCII characters → `ENOENT uv_spawn
 *         'C:\Users\عماد الدين\.bun\bin\bun.exe'` even though the file
 *         exists (round 1) — so spawning `process.execPath` is impossible;
 *      b) detouring through cmd.exe works ONLY with zero quoting: Bun
 *         escapes embedded double quotes as \" when building the raw
 *         Windows command line and cmd.exe cannot parse \" →
 *         '"bun x prisma db push" is not recognized' (round 2). Every
 *         token must go in as its own space-free array entry;
 *      c) `bun x prisma` (bare name) finds no local .bin (bun's isolated
 *         layout creates none for hoisted dev deps) and FETCHES
 *         prisma@latest from npm — a different major with a different CLI
 *         → `CLI.UNKNOWN_COMMAND` (round 3).
 *    FINAL FIX (round 4): cmd.exe detour with `bun x prisma@<exact
 *    workspace version>` — the version read from the workspace install.
 *    bunx runs bins IN-PROCESS (it never spawns bun.exe, which is exactly
 *    why `bun x electron` works on such machines) so 2a never triggers,
 *    every token is space-free ASCII so no quoting is ever generated (2b),
 *    and the exact workspace version pins away the 2c version roulette.
 *    ⚠ LIMITATION: on Windows, args passed here must be space-free ASCII —
 *    use paths relative to packages/db (e.g. --schema=../../apps/...),
 *    never absolute Windows paths (they contain spaces).
 *
 *    (Also: `new URL(...).pathname` is NOT a valid Windows path — it yields
 *    "/D:/Projects/My%20Project/…" with a leading slash and percent-encoded
 *    spaces. fileURLToPath() is the only correct conversion.)
 *
 * 4) ROUND 5 — self-healing client resolution preflight: `prisma generate`
 *    (prisma-client-js) first resolves @prisma/client from the SCHEMA
 *    directory tree. Under bun's ISOLATED layout that package exists only
 *    in packages/db/node_modules (the root node_modules is nearly empty),
 *    so from apps/desktop/prisma/ it resolves ONLY when apps/desktop has
 *    been installed. If the local node_modules is stale (classic after a
 *    code sync without `bun install`), the CLI silently falls back to
 *    `npm i @prisma/client@<version> --silent` — bypassing bun, failing on
 *    offline/proxied machines, and aborting `electron:dev` with
 *    "Error: Command failed with exit code 1: npm i @prisma/client@…".
 *    The preflight below detects the unresolvable package, repairs the
 *    workspace links with `bun install` at the repo root, and re-checks —
 *    prisma never reaches its npm fallback.
 *
 * Usage (from packages/db/package.json):
 *   "db:push": "bun scripts/db-cli.mjs prisma db push"
 *   and from the root: bun scripts/db-cli.mjs prisma generate --schema=../../apps/desktop/prisma/schema.prisma
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const IS_WIN = process.platform === 'win32';

// ── 1. Stale-URL protection ────────────────────────────────────────────────
const env = { ...process.env };
const incomingUrl = process.env.DATABASE_URL?.trim();
if (incomingUrl && !/^postgres(ql)?:\/\//i.test(incomingUrl)) {
  delete env.DATABASE_URL;
  console.warn(
    '[db-cli] Removed stale non-PostgreSQL DATABASE_URL from the environment — using packages/db/.env default.',
  );
}

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  console.error('[db-cli] Usage: bun scripts/db-cli.mjs <command> [args…]');
  process.exit(1);
}

// ── 2. Windows-safe path resolution ────────────────────────────────────────
// fileURLToPath decodes %20 and drops the leading "/D:" — .pathname is a URL
// artifact that breaks every Windows file API.
const pkgDir = fileURLToPath(new URL('..', import.meta.url));

// ── 2.5 Client-resolution preflight (see header note 4) ───────────────────
const PREFLIGHT_PACKAGES = ['@prisma/client', 'prisma'];

/**
 * Mirrored up-tree node resolution using pure fs checks.
 * NOT require.resolve on purpose: Bun caches resolution results in-process,
 * so a link restored moments ago (by step 1/2 below) could still report as
 * missing. existsSync() always reflects the real filesystem.
 */
function pkgResolvableFromSchemaDir(schemaPath, pkgName) {
  let dir = path.dirname(schemaPath);
  for (let i = 0; i < 12; i++) {
    if (existsSync(path.join(dir, 'node_modules', ...pkgName.split('/'), 'package.json'))) {
      return true;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
  return false;
}

function missingPackagesForSchema(schemaPath) {
  return PREFLIGHT_PACKAGES.filter((p) => !pkgResolvableFromSchemaDir(schemaPath, p));
}

/** Refresh workspace links with a root `bun install`. */
function runBunInstall() {
  const repoRoot = path.resolve(pkgDir, '..', '..');
  console.warn(
    '[db-cli] @prisma/client is not resolvable from the schema directory — refreshing workspace links with `bun install` …',
  );
  let inst;
  if (IS_WIN) {
    // Same cmd.exe detour as the launch below: space-free ASCII tokens only;
    // the repo-root cwd (which may contain spaces) is passed via the spawn
    // API, never through the shell line, so quoting is never generated.
    const comspec = process.env.ComSpec || 'cmd.exe';
    inst = spawnSync(comspec, ['/d', '/s', '/c', 'bun', 'install'], {
      cwd: repoRoot,
      env,
      stdio: 'inherit',
      windowsHide: true,
    });
  } else {
    inst = spawnSync('bun', ['install'], { cwd: repoRoot, env, stdio: 'inherit' });
    if (inst.error && inst.error.code === 'ENOENT') {
      // bun not on PATH — under a bun-run script process.execPath IS bun.
      inst = spawnSync(process.execPath, ['install'], { cwd: repoRoot, env, stdio: 'inherit' });
    }
  }
  return inst;
}

/**
 * Surgically restore a missing workspace link.
 *
 * WHY (observed with bun 1.3.14): when the local tree is stale, a plain
 * `bun install` is a NO-OP — "Checked N installs … (no changes)" — and the
 * missing link is NOT re-created, because bun trusts its own bookkeeping
 * instead of re-verifying every symlink. This helper re-creates the link
 * by hand: source of truth is the store copy that packages/db resolves,
 * destination is node_modules/<pkg> under the nearest package root above
 * the schema. Windows uses a junction (no admin rights, unlike symlinks).
 */
function linkWorkspacePackage(schemaPath, pkgName) {
  let src;
  try {
    src = createRequire(path.join(pkgDir, 'package.json')).resolve(`${pkgName}/package.json`);
  } catch {
    return false; // store copy missing entirely → caller reports guidance
  }
  const srcDir = path.dirname(src);

  // Nearest package root (directory with a package.json) above the schema.
  let pkgRoot = null;
  let dir = path.dirname(schemaPath);
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, 'package.json'))) {
      pkgRoot = dir;
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (!pkgRoot) return false;

  const dest = path.join(pkgRoot, 'node_modules', ...pkgName.split('/'));
  try {
    mkdirSync(path.dirname(dest), { recursive: true });
    rmSync(dest, { force: true, recursive: true }); // clear a dangling link
    symlinkSync(srcDir, dest, IS_WIN ? 'junction' : 'dir');
    console.warn(`[db-cli] Restored workspace link: ${dest} → ${srcDir}`);
    return true;
  } catch (e) {
    console.warn(`[db-cli] Could not restore the workspace link for ${pkgName}: ${e.message}`);
    return false;
  }
}

/**
 * Ensure @prisma/client (and prisma) resolve from the schema dir BEFORE
 * prisma runs — otherwise the CLI silently falls back to
 * `npm i @prisma/client@<version> --silent`, which fails on offline or
 * proxy-only machines and aborts `electron:dev`.
 * Scoped to `generate` with an explicit --schema (the desktop flow).
 * A healthy machine pays only two fs-resolves (~microseconds).
 */
function ensurePrismaClientForSchema(prismaArgs) {
  if (prismaArgs[0] !== 'generate') return;
  const schemaArg = prismaArgs.find((a) => a.startsWith('--schema='));
  if (!schemaArg) return;
  const raw = schemaArg.slice('--schema='.length);
  const schemaPath = path.isAbsolute(raw) ? raw : path.resolve(pkgDir, raw);

  let missing = missingPackagesForSchema(schemaPath);
  if (missing.length === 0) return;

  // Step 1 — authoritative repair: a full `bun install` (a real install
  // when a sync added packages; a fast no-op when bun thinks it's current).
  const inst = runBunInstall();
  if (inst.error || (inst.status ?? 1) !== 0) {
    console.error('[db-cli] `bun install` failed — run it manually at the repo root, then retry.');
    process.exit(1);
  }
  missing = missingPackagesForSchema(schemaPath);
  if (missing.length === 0) return;

  // Step 2 — surgical repair for bun's no-op blind spot (see
  // linkWorkspacePackage): restore the missing links from the store copy.
  for (const pkgName of missing) linkWorkspacePackage(schemaPath, pkgName);
  if (missingPackagesForSchema(schemaPath).length === 0) {
    console.warn('[db-cli] Workspace links restored — continuing with prisma generate.');
    return;
  }

  console.error(
    '[db-cli] Prisma packages are still not resolvable from the schema directory —\n' +
      '        prisma would fall back to a broken `npm i`. Fix manually:\n' +
      '          bun install\n' +
      '          bun run db:generate:desktop',
  );
  process.exit(1);
}

// ── 3. Launch ──────────────────────────────────────────────────────────────
let result;
if (cmd === 'prisma') {
  ensurePrismaClientForSchema(args);

  const requireFromDb = createRequire(path.join(pkgDir, 'package.json'));
  let prismaCliJs;
  try {
    prismaCliJs = path.join(
      path.dirname(requireFromDb.resolve('prisma/package.json')),
      'build',
      'index.js',
    );
  } catch {
    console.error('[db-cli] The `prisma` package was not found — run `bun install` in the repo root first.');
    process.exit(1);
  }

  if (IS_WIN) {
    // bunx in-process detour — see 3c note in the header. The version is
    // pinned to the workspace install so `bun x` can never drift to a
    // different major. All tokens below are space-free ASCII: cmd.exe joins
    // them verbatim, no quoting is generated, and the in-process CLI sees
    // the same cwd/env (packages/db) as the POSIX branch. Note the CLI then
    // spawns its engine binaries from the project's node_modules — ASCII
    // paths with spaces only, which Bun's spawner handles fine.
    const prismaVersion = JSON.parse(
      readFileSync(path.join(path.dirname(prismaCliJs), '..', 'package.json'), 'utf8'),
    ).version;
    const comspec = process.env.ComSpec || 'cmd.exe';
    result = spawnSync(comspec, ['/d', '/s', '/c', 'bun', 'x', `prisma@${prismaVersion}`, ...args], {
      cwd: pkgDir,
      env,
      stdio: ['inherit', 'inherit', 'inherit'],
      windowsHide: true,
    });
  } else {
    // POSIX: spawn the workspace-local Prisma CLI directly under the current
    // runtime (bun). No shell involved, deterministic resolution.
    result = spawnSync(process.execPath, [prismaCliJs, ...args], {
      cwd: pkgDir,
      env,
      stdio: ['inherit', 'inherit', 'inherit'],
    });
  }
} else {
  // Generic passthrough for non-prisma commands (no current caller). POSIX
  // only — routing arbitrary commands through Windows shells re-enters the
  // quoting minefield documented above.
  if (IS_WIN) {
    console.error(`[db-cli] Non-prisma command "${cmd}" is not supported on Windows.`);
    process.exit(1);
  }
  result = spawnSync(cmd, args, {
    cwd: pkgDir,
    env,
    stdio: ['inherit', 'inherit', 'inherit'],
  });
}

if (result.error) {
  console.error('[db-cli] Failed to launch the command:', result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
