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
 * time inside prebuild (the build-stamp is written in Step 3, this guard runs
 * as Step 4). Still subject to the allowlist check below. */
const KNOWN_GENERATED = new Set(['build-stamp.json']);

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
      // Generated-at-build-time files (build-stamp.json) exist by packaging time.
      const isGenerated = m[1].split('/').pop() === 'build-stamp.json' || KNOWN_GENERATED.has(m[1]);
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
