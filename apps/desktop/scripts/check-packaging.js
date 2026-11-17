/**
 * BLASTI Desktop — Packaging Completeness Guard (Task 71)
 *
 * WHY THIS EXISTS: electron-builder.yml packages from an explicit `files:`
 * allowlist. A file that main.js (or the local-api) requires but that is
 * FORGOTTEN in that list produces a build that runs perfectly in dev
 * (the real file is on disk) and then dies on first launch of the packaged
 * app with:
 *
 *     Error: Cannot find module './load-env'
 *     Require stack: ...resources\app.asar\main.js
 *
 * This guard walks the relative require() graph starting from the entry
 * files and verifies that EVERY local file it finds (a) exists on disk and
 * (b) is covered by one of the `files:` patterns in electron-builder.yml.
 * Run automatically as part of `prebuild` (so `build:win` / `build:portable`
 * fail BEFORE the long packaging step), or standalone:
 *
 *     node scripts/check-packaging.js
 *
 * Dependency-free on purpose (no yaml package): the `files:` block is
 * extracted with a line parser that understands the exact shapes this
 * project uses (a plain `name.js`, a folder with a double-star glob,
 * or a single-star basename glob like `data/*.db`).
 */

const fs = require('fs');
const path = require('path');

const DESKTOP_ROOT = path.resolve(__dirname, '..');
const BUILDER_YML = path.join(DESKTOP_ROOT, 'electron-builder.yml');

/** Entry files whose relative requires are walked. */
const ENTRY_FILES = [
  'main.js',
  'local-api/index.js',
  'local-api/sync-service.js',
];

/** Directories that are allow-listed wholesale and never walked. */
const SKIP_DIRS = new Set(['node_modules', 'out', 'dist', '.git', 'data', 'assets']);

/** Files that prebuild GENERATES before packaging — never "missing" at check
 * time inside prebuild (the build-stamp is written in Step 3, the delta-lib
 * vendor copy in Step 4, this guard runs as Step 5). Still subject to the
 * allowlist check below when they exist. */
const KNOWN_GENERATED = new Set(['build-stamp.json', 'vendor/binary-delta.js']);

// ─── files: block extraction ────────────────────────────────────────────────

/**
 * Extract the patterns under the top-level `files:` key of electron-builder.yml.
 * Handles the list shape used in this repo (a top-level `files:` key
 * followed by `- item` lines; comment lines are ignored; double-star
 * globs for folders, single-star for basenames):
 */
function extractFilesPatterns(ymlText) {
  const patterns = [];
  const lines = ymlText.split(/\r?\n/);
  let inFiles = false;
  for (const line of lines) {
    if (/^files:\s*(#.*)?$/.test(line)) { inFiles = true; continue; }
    if (inFiles) {
      // A new top-level key (no leading whitespace) ends the block.
      if (/^[A-Za-z_][A-Za-z0-9_]*\s*:/.test(line)) break;
      const item = line.match(/^\s+-\s+(.+?)\s*(?:#.*)?$/);
      if (item) patterns.push(item[1].replace(/^['"]|['"]$/g, ''));
    }
  }
  return patterns;
}

/** Does `target` (a repo-relative POSIX path) match one allowlist pattern? */
function matchesPattern(target, pattern) {
  const norm = pattern.replace(/^\.\//, '').replace(/\/+$/, '');
  if (norm === target) return true;
  if (norm.includes('**')) {
    const prefix = norm.split('**')[0].replace(/\/+$/, '');
    if (!prefix) return true;
    return target === prefix || target.startsWith(prefix + '/');
  }
  if (norm.includes('*')) {
    // Single-star glob (e.g. data/*.db) → basename regex match within the dir.
    const dir = path.posix.dirname(norm);
    const base = path.posix.basename(norm);
    if (path.posix.dirname(target) !== dir) return false;
    const rx = new RegExp('^' + base.split('*').map((s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$');
    return rx.test(path.posix.basename(target));
  }
  return false;
}

// ─── require() graph walk ───────────────────────────────────────────────────

function resolveRequire(fromDir, spec) {
  const base = path.resolve(fromDir, spec);
  const candidates = [base, base + '.js', base + '.json', path.join(base, 'index.js')];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

function walkRequires(relFile, depth, seen, problems) {
  if (depth > 4 || seen.has(relFile)) return;
  seen.add(relFile);
  const abs = path.join(DESKTOP_ROOT, relFile);
  let src;
  try { src = fs.readFileSync(abs, 'utf-8'); } catch { return; }
  // Strip comments BEFORE scanning: doc comments legitimately show example
  // require() calls (e.g. db.js's usage note) that would false-positive.
  src = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const rx = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  let m;
  while ((m = rx.exec(src)) !== null) {
    const resolved = resolveRequire(path.dirname(abs), m[1]);
    if (!resolved) {
      // Generated-at-build-time files (build-stamp.json, vendor/binary-delta.js)
      // exist by packaging time. Specifier → repo-relative forms are both
      // accepted: './vendor/binary-delta' resolves to vendor/binary-delta.js.
      const specNorm = m[1].replace(/^\.\//, '');
      const isGenerated = m[1].split('/').pop() === 'build-stamp.json'
        || KNOWN_GENERATED.has(m[1])
        || KNOWN_GENERATED.has(specNorm)
        || KNOWN_GENERATED.has(specNorm + '.js');
      if (!isGenerated) {
        problems.push(`MISSING FILE: ${relFile} requires '${m[1]}' but no such file exists on disk (fresh-clone build would fail)`);
      }
      continue;
    }
    if (!resolved.startsWith(DESKTOP_ROOT)) {
      // Outside the packaged app dir (monorepo files) — cannot be in files:.
      // Runtime requires of these MUST be try/catch-guarded (index.js does).
      continue;
    }
    const rel = path.relative(DESKTOP_ROOT, resolved).split(path.sep).join('/');
    if (SKIP_DIRS.has(rel.split('/')[0])) continue;
    walkRequires(rel, depth + 1, seen, problems);
  }
}

// ─── Main check ──────────────────────────────────────────────────────────────

function checkPackagingCompleteness() {
  const problems = [];

  if (!fs.existsSync(BUILDER_YML)) {
    problems.push('electron-builder.yml not found — cannot validate the files allowlist');
    return problems;
  }
  const patterns = extractFilesPatterns(fs.readFileSync(BUILDER_YML, 'utf-8'));
  if (patterns.length === 0) {
    problems.push('electron-builder.yml has an empty `files:` block — nothing would be packaged');
  }

  // 0.6.85 — DELTA-LIB PACKAGING CHECK (the hole Task 71 could not see).
  // main.js loads the delta updater with a RELATIVE require
  // ('./vendor/binary-delta') that the graph walk below verifies, but the
  // historical failure was a BARE require ('@blasti/binary-delta') pointing
  // at a bun workspace symlink electron-builder silently dropped — the
  // packaged app had NO delta library and every delta update died with
  // ENOENT inside app.asar. Enforce the three packaging facts explicitly:
  //   1. vendor/binary-delta.js exists (prebuild Step 4 vendors it — at
  //      standalone-check time it may be absent, so materialize it here),
  //   2. it is covered by the files: allowlist (vendor/**/*),
  //   3. its API surface loads (require succeeds — pure JS, always safe).
  // Materialization happens BEFORE the require-graph walk so the walk sees
  // the real file and enforces allowlist coverage itself.
  const deltaLibRel = 'vendor/binary-delta.js';
  const deltaLibAbs = path.join(DESKTOP_ROOT, deltaLibRel);
  if (!fs.existsSync(deltaLibAbs)) {
    const vendorSrc = path.resolve(DESKTOP_ROOT, '..', '..', 'packages', 'binary-delta', 'index.js');
    if (fs.existsSync(vendorSrc)) {
      try {
        fs.mkdirSync(path.dirname(deltaLibAbs), { recursive: true });
        fs.copyFileSync(vendorSrc, deltaLibAbs);
      } catch { /* surfaced by the existence check below */ }
    }
  }
  if (!fs.existsSync(deltaLibAbs)) {
    problems.push(`MISSING FILE: ${deltaLibRel} does not exist and packages/binary-delta/index.js was not found — the delta updater would be dead in the packaged app`);
  } else {
    if (!patterns.some((p) => matchesPattern(deltaLibRel, p))) {
      problems.push(`NOT PACKAGED: '${deltaLibRel}' exists but is NOT covered by electron-builder.yml files: — add vendor/**/* or the packaged delta updater dies with ENOENT`);
    }
    try {
      const lib = require(deltaLibAbs);
      for (const fn of ['parseReleasePatch', 'applyDeltaToFile', 'applyTreePatch', 'sha256OfFile']) {
        if (typeof lib[fn] !== 'function') {
          problems.push(`BROKEN VENDOR COPY: ${deltaLibRel} is missing ${fn}() — re-run prebuild to re-vendor from packages/binary-delta`);
        }
      }
    } catch (err) {
      problems.push(`BROKEN VENDOR COPY: ${deltaLibRel} failed to load: ${(err && err.message) || err}`);
    }
  }

  // Every entry file must itself be allow-listed (main.js was, load-env.js was not).
  for (const entry of ENTRY_FILES) {
    if (!fs.existsSync(path.join(DESKTOP_ROOT, entry)) && !KNOWN_GENERATED.has(entry)) {
      problems.push(`MISSING FILE: entry '${entry}' does not exist in the checkout (run: git pull)`);
      continue;
    }
    if (!patterns.some((p) => matchesPattern(entry, p))) {
      problems.push(`NOT PACKAGED: entry '${entry}' is required at runtime but is NOT listed in electron-builder.yml files: — the packaged app would crash with "Cannot find module './${path.basename(entry, '.js')}'"`);
    }
  }

  // Walk the require graph of every entry and check each local file is packaged.
  const seen = new Set();
  for (const entry of ENTRY_FILES) {
    if (fs.existsSync(path.join(DESKTOP_ROOT, entry))) {
      walkRequires(entry, 0, seen, problems);
    }
  }
  for (const rel of seen) {
    if (!patterns.some((p) => matchesPattern(rel, p))) {
      problems.push(`NOT PACKAGED: '${rel}' is require()d at runtime but NOT covered by electron-builder.yml files:`);
    }
  }

  // 0.6.85 — the delta-lib facts (existence / allowlist / API surface) are
  // enforced at the TOP of this function (before the require-graph walk) —
  // see the DELTA-LIB PACKAGING CHECK block there.

  return problems;
}

module.exports = { checkPackagingCompleteness, extractFilesPatterns, matchesPattern };

// ─── CLI ──────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const problems = checkPackagingCompleteness();
  if (problems.length > 0) {
    console.error('\n[check-packaging] FAILED — the packaged app would crash at startup:');
    for (const p of problems) console.error('  - ' + p);
    console.error('\nFix: add the missing file(s) to the `files:` list in electron-builder.yml');
    process.exit(1);
  }
  console.log('[check-packaging] OK — every require()d local file is covered by electron-builder.yml');
}
