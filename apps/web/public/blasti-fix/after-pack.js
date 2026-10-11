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

  // The GENERATED client (schema + query engine) lives at <node_modules>/.prisma/client
  // — i.e. the parent of the @prisma SCOPE dir, not the parent of the client dir:
  //   <nm>/@prisma/client  →  <nm>/.prisma/client
  const generatedDir = path.join(path.dirname(path.dirname(clientPkg)), '.prisma', 'client');
  if (!fs.existsSync(generatedDir)) {
    throw new Error(
      '[afterPack] Generated client (.prisma/client) not found next to @prisma/client.\n' +
      '  Run `bun run db:generate` at the monorepo root, then rebuild the desktop app.'
    );
  }
  log(`Generated client found at: ${generatedDir}`);

  // 1. Runtime package
  copyDereference(clientPkg, path.join(destNodeModules, '@prisma', 'client'));
  log('Copied @prisma/client → resources/node_modules/@prisma/client');

  // 2. Generated client (schema + platform query engine binary)
  copyDereference(generatedDir, path.join(destNodeModules, '.prisma', 'client'));
  log('Copied .prisma/client → resources/node_modules/.prisma/client');

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

  console.log('  ✔ afterPack — Prisma client runtime shipped successfully');
};
