/**
 * electron-builder afterPack hook — ship the Prisma client runtime.
 *
 * WHY: the desktop app's local API needs @prisma/client (runtime) AND the
 * generated .prisma/client (schema + platform query engine binary) at
 * runtime. Under bun workspaces those live in the isolated content-
 * addressable store (node_modules/.bun/@prisma+client@<ver>+<hash>/…),
 * which electron-builder cannot follow, so the packaged app previously
 * started with NO Prisma client (see the user's main.log: six
 * "Failed to resolve from …" lines followed by the auto-generate failure).
 *
 * WHAT: after the app dir is assembled, copy both packages into
 *   <appOutDir>/resources/node_modules/
 * — a location local-api/lib/db.js ALREADY searches (candidate #5:
 * process.resourcesPath/node_modules/@prisma/client). The generated client
 * finds its sibling runtime via standard parent node_modules resolution,
 * so no symlinks and no bun-specific logic are needed at runtime.
 *
 * Platform note: the query engine binary inside the generated client is
 * platform-specific (dll.node on Windows) — it must come from the machine
 * that RUNS the build, which is exactly where this hook runs.
 *
 * Registered in electron-builder.yml as:  afterPack: scripts/after-pack.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const MONOREPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const ROOT_NODE_MODULES = path.join(MONOREPO_ROOT, 'node_modules');
// The DESKTOP-generated SQLite client (apps/desktop/prisma/schema.prisma has
// an explicit generator `output` pointing here). The workspace client in
// node_modules/.prisma/client is the POSTGRESQL client since the cloud
// migration — packaging THAT would break the local `file:` database with
// "the URL must start with the protocol postgresql://".
const DESKTOP_GENERATED_CLIENT_DIR = path.join(
  MONOREPO_ROOT, 'apps', 'desktop', 'prisma', 'generated', 'client'
);

function log(msg) { console.log(`  • ${msg}`); }

/** Locate the real (dereferenced) @prisma/client package directory. */
function findPrismaClientPackage() {
  // 1. Standard resolution — root node_modules (npm/yarn hoisted layouts).
  try {
    const real = fs.realpathSync(path.join(ROOT_NODE_MODULES, '@prisma', 'client'));
    if (fs.existsSync(real)) return real;
  } catch { /* not there */ }

  // 2. Bun's isolated store: node_modules/.bun/@prisma+client@<ver>+<hash>/node_modules/@prisma/client
  try {
    const bunDir = path.join(ROOT_NODE_MODULES, '.bun');
    const hit = fs.readdirSync(bunDir).find((d) => d.startsWith('@prisma+client@'));
    if (hit) {
      const p = path.join(bunDir, hit, 'node_modules', '@prisma', 'client');
      if (fs.existsSync(p)) return fs.realpathSync(p);
    }
  } catch { /* no bun store */ }

  return null;
}

/**
 * Resolve every runtime dependency of a package (one level deep) from the
 * same node_modules tree the package lives in, so the copied package can
 * satisfy its own requires (e.g. @prisma/engines-version).
 */
function collectDependencyDirs(packageDir) {
  const deps = [];
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
    const fromNodeModules = path.dirname(packageDir);
    for (const name of Object.keys(pkg.dependencies || {})) {
      try {
        const resolved = require.resolve(`${name}/package.json`, { paths: [fromNodeModules] });
        const dir = path.dirname(resolved);
        if (!deps.some((d) => d.dir === dir)) deps.push({ name, dir });
      } catch { /* optional/unresolvable — skip */ }
    }
  } catch { /* unreadable package.json — skip */ }
  return deps;
}

function copyDereference(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true, dereference: true, force: true });
}

// ─── SIZE ROUND (0.6.69) — slim the packaged fallback copies ────────────────
//
// The bun-store @prisma/client package is ~74 MB, but the packaged app only
// ever uses it as a RE-EXPORT SHELL: index.js → require('.prisma/client') →
// the generated desktop client, whose runtime/library.js is fully
// self-contained (verified: requires only node: builtins). The other ~73 MB
// (wasm-base64 engines for postgres/mysql/sqlserver/cockroach/mongodb,
// generator-build, scripts, edge/react-native/browser variants, d.ts,
// source maps) can NEVER load at runtime — they were silently doubling the
// installer payload under NSIS compression.
//
// Both fallback copies below now ship whitelists instead of full trees:
//   • @prisma/client shell        → package.json · index.js · default.js · LICENSE
//   • generated desktop client    → package.json · index.js · default.js ·
//                                   client.js · schema.prisma ·
//                                   libquery_engine*.node · runtime/library.js
// The PRIMARY runtime copy (app.asar.unpacked/prisma/generated/client) is
// trimmed by the matching `files:` negations in electron-builder.yml.
function copyWhitelisted(src, dest, keepRel) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, {
    recursive: true,
    dereference: true,
    force: true,
    filter: (srcPath) => {
      const rel = path.relative(src, srcPath);
      if (!rel) return true; // the root itself
      return keepRel(rel.split(path.sep).join('/'));
    },
  });
}

/** @prisma/client re-export shell — everything else is dead weight here. */
const PRISMA_SHELL_KEEP = new Set(['package.json', 'index.js', 'default.js', 'LICENSE']);

/** Generated desktop client runtime whitelist (engine + library.js + schema). */
function generatedClientKeep(rel) {
  if (['package.json', 'index.js', 'default.js', 'client.js', 'schema.prisma'].includes(rel)) return true;
  if (rel === 'runtime') return true; // the DIRECTORY itself — its content is filtered below
  if (rel.startsWith('libquery_engine')) return true; // the platform query engine binary
  if (rel === 'runtime/library.js') return true; // the ONLY runtime file index.js requires
  return false;
}

module.exports = async function afterPack(context) {
  const appOutDir = context.appOutDir;
  const resourcesDir = path.join(appOutDir, 'resources');
  const destNodeModules = path.join(resourcesDir, 'node_modules');

  log(`afterPack — shipping Prisma client into ${resourcesDir}`);

  const clientPkg = findPrismaClientPackage();
  if (!clientPkg) {
    throw new Error(
      '[afterPack] @prisma/client was not found in node_modules.\n' +
      '  Run `bun install` and `bun run db:generate` at the monorepo root, then rebuild the desktop app.'
    );
  }
  log(`@prisma/client found at: ${clientPkg}`);

  // The DESKTOP-generated client (SQLite schema + platform query engine)
  // from apps/desktop/prisma/generated/client. We copy it into
  // resources/node_modules/.prisma/client so the shipped @prisma/client
  // re-exports THE DESKTOP client — exactly the layout a default
  // `prisma generate` produces, so no resolution changes are needed.
  const generatedDir = DESKTOP_GENERATED_CLIENT_DIR;
  if (!fs.existsSync(path.join(generatedDir, 'index.js'))) {
    throw new Error(
      '[afterPack] Desktop SQLite client not found at apps/desktop/prisma/generated/client.\n' +
      '  Run `bun run db:generate:desktop` at the monorepo root (prebuild.js does\n' +
      '  this automatically) — do NOT package the workspace PostgreSQL client;\n' +
      '  the local SQLite database cannot use it.'
    );
  }
  log(`Desktop generated client found at: ${generatedDir}`);

  // 1. Runtime package — WHITELISTED shell (0.6.69): the full bun-store
  // copy carried ~73 MB of never-loaded wasm engines / variants.
  copyWhitelisted(clientPkg, path.join(destNodeModules, '@prisma', 'client'),
    (rel) => PRISMA_SHELL_KEEP.has(rel));
  log('Copied @prisma/client (slim re-export shell) → resources/node_modules/@prisma/client');

  // 2. Desktop generated client (SQLite schema + platform query engine binary)
  // — WHITELISTED (0.6.69): engine + library.js + schema + entries only.
  copyWhitelisted(generatedDir, path.join(destNodeModules, '.prisma', 'client'), generatedClientKeep);
  log('Copied desktop SQLite client (engine + runtime, slimmed) → resources/node_modules/.prisma/client');

  // 3. Runtime dependencies of @prisma/client (tiny JS helpers)
  for (const dep of collectDependencyDirs(clientPkg)) {
    copyDereference(dep.dir, path.join(destNodeModules, dep.name));
    log(`Copied dependency ${dep.name}`);
  }

  // 4. Verify a query engine binary landed in the copied generated client.
  const copiedGenerated = path.join(destNodeModules, '.prisma', 'client');
  const engine = fs.readdirSync(copiedGenerated)
    .find((f) => f.startsWith('libquery_engine') || f.endsWith('.node'));
  if (!engine) {
    throw new Error('[afterPack] No query engine binary found in the copied .prisma/client — the local DB would fail to start.');
  }
  log(`Query engine shipped: ${engine}`);

  // 5. SIZE ROUND (0.6.69) — fail the BUILD (not the runtime) if the slimmed
  // copies lost anything the re-export chain needs. Cheap; catches whitelist
  // drift after a future prisma upgrade.
  const shellDir = path.join(destNodeModules, '@prisma', 'client');
  for (const required of ['package.json', 'index.js', 'default.js']) {
    if (!fs.existsSync(path.join(shellDir, required))) {
      throw new Error(`[afterPack] slimmed @prisma/client shell is missing ${required} — the resources fallback re-export would break.`);
    }
  }
  for (const required of ['package.json', 'index.js', 'schema.prisma', 'runtime/library.js']) {
    if (!fs.existsSync(path.join(copiedGenerated, required))) {
      throw new Error(`[afterPack] slimmed generated client is missing ${required} — the resources fallback would break.`);
    }
  }

  console.log('  ✔ afterPack — Prisma client runtime shipped successfully');
};
