#!/usr/bin/env node
/**
 * BLASTI — one-command version setter.
 *
 *   node scripts/version-set.js 0.4.0        (or: bun run version:set 0.4.0)
 *
 * WHY THIS EXISTS (the "old version in the installer name" bug)
 *   The repo used to carry SIX different version numbers and the build
 *   pipelines each read a DIFFERENT file, so bumping one package.json left
 *   the artifacts named with the old version:
 *
 *     Windows installer  BLASTI-Setup-X.exe   ← apps/desktop/package.json   (NOT the root!)
 *     Android APK        BLASTI-vX.apk        ← apps/mobile/android/app/build.gradle versionName
 *                                                 (apps/mobile/package.json was ignored!)
 *     API self-report    GET /api/health      ← was hardcoded '0.2.1' in 4 places in apps/api/src/index.ts
 *     root/web versions  package.json         ← purely decorative
 *
 *   WHAT THIS SCRIPT DOES — writes the new version into EVERY source in one
 *   shot, so "how do I change the app or API version?" has one answer:
 *
 *       bun run version:set 1.2.3
 *
 *   Files touched (all in the same commit — commit + push to master and CI
 *   produces BLASTI-Setup-1.2.3.exe / BLASTI-v1.2.3-debug.apk and the VPS
 *   registers AppVersion 1.2.3 in Public Apps Settings):
 *
 *     1. package.json                      (root — kept in step for anything reading it)
 *     2. apps/desktop/package.json         → installer name
 *     3. apps/api/package.json             → API health/self-report (index.ts reads it live)
 *     4. apps/web/package.json             → static export identity
 *     5. apps/mobile/package.json          → the mobile source of truth
 *     6. apps/mobile/android/app/build.gradle → versionName + versionCode (derived, always
 *                                             monotonic: major*1e6 + minor*1e3 + patch)
 *
 *   scripts/gradle.js additionally re-syncs build.gradle from
 *   apps/mobile/package.json before every Android build as a safety net, so
 *   even a manual package.json-only edit is picked up.
 *
 * Usage:
 *   node scripts/version-set.js 1.2.3            set an exact version
 *   node scripts/version-set.js --check          report every version without writing
 *   node scripts/version-set.js                  same as --check
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  'package.json',
  'apps/desktop/package.json',
  'apps/api/package.json',
  'apps/web/package.json',
  'apps/mobile/package.json',
];
const GRADLE = path.join(ROOT, 'apps', 'mobile', 'android', 'app', 'build.gradle');

const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function log(msg) { console.log(`[version] ${msg}`); }
function warn(msg) { console.warn(`[version] ${msg}`); }
function die(msg) { console.error(`[version] ${msg}`); process.exit(1); }

/** Deterministic, always-monotonic Android versionCode from a semver string. */
function versionCodeFrom(version) {
  const [maj = '0', min = '0', pat = '0'] = String(version).split('-')[0].split('.');
  const code = Number(maj) * 1_000_000 + Number(min) * 1_000 + Number(pat);
  if (!Number.isFinite(code) || code < 1 || code > 2_100_000_000) {
    die(`Cannot derive an Android versionCode from "${version}".`);
  }
  return code;
}

function readJson(rel) {
  const full = path.join(ROOT, rel);
  try {
    return { full, data: JSON.parse(fs.readFileSync(full, 'utf8')) };
  } catch (err) {
    die(`Cannot read ${rel}: ${err.message}`);
  }
}

function writeJson(rel, file) {
  fs.writeFileSync(file.full, JSON.stringify(file.data, null, 2) + '\n');
  log(`  ✔ ${rel} → ${file.data.version}`);
}

function gradleVersion(gradleSrc) {
  const name = gradleSrc.match(/versionName\s+"([^"]+)"/);
  const code = gradleSrc.match(/versionCode\s+(\d+)/);
  return { name: name ? name[1] : null, code: code ? Number(code[1]) : null };
}

// ─── Parse args ───────────────────────────────────────────────────────────────
const arg = process.argv[2];
const checkOnly = !arg || arg === '--check' || arg === '-c';
let nextVersion = null;
if (!checkOnly) {
  nextVersion = String(arg).replace(/^v/, '').trim();
  if (!SEMVER.test(nextVersion)) {
    die(`"${arg}" is not a semver version. Use e.g. 1.2.3 or 1.2.3-beta.1`);
  }
}

// ─── Read current state ───────────────────────────────────────────────────────
const files = TARGETS.map((rel) => ({ rel, ...readJson(rel) }));
let gradleSrc = '';
try { gradleSrc = fs.readFileSync(GRADLE, 'utf8'); } catch { /* missing — reported below */ }
const gradle = gradleVersion(gradleSrc);

console.log('');
log(checkOnly ? 'Current version map:' : `Setting version → ${nextVersion}`);
console.log('');
console.log('  Source                                            version');
console.log('  ────────────────────────────────────────────────  ─────────');
for (const f of files) {
  const note = f.rel === 'apps/desktop/package.json' ? '   ← installer name'
    : f.rel === 'apps/mobile/package.json' ? '                        ← mobile source of truth'
    : f.rel === 'apps/api/package.json' ? '                     ← API self-report'
    : '';
  console.log(`  ${f.rel.padEnd(50)}${String(f.data.version).padEnd(9)}${note}`);
}
console.log(`  ${path.relative(ROOT, GRADLE).padEnd(50)}versionName ${gradle.name} / versionCode ${gradle.code}   ← APK name`);
console.log('');

if (checkOnly) {
  const unique = new Set([...files.map((f) => String(f.data.version)), gradle.name]);
  if (unique.size > 1) {
    warn(`Versions DIVERGE across ${unique.size} different values — run:  bun run version:set <x.y.z>`);
    process.exitCode = 1;
  } else {
    log('All versions are in sync.');
  }
  process.exit(0);
}

// ─── Write ────────────────────────────────────────────────────────────────────
for (const f of files) {
  const before = f.data.version;
  f.data.version = nextVersion;
  writeJson(f.rel, f);
  if (before !== nextVersion) log(`    (was ${before})`);
}

if (!gradleSrc) {
  warn('build.gradle not found — Android version NOT updated.');
} else if (gradle.name !== nextVersion) {
  const code = versionCodeFrom(nextVersion);
  const updated = gradleSrc
    .replace(/versionName\s+"[^"]*"/, `versionName "${nextVersion}"`)
    .replace(/versionCode\s+\d+/, `versionCode ${code}`);
  fs.writeFileSync(GRADLE, updated);
  log(`  ✔ ${path.relative(ROOT, GRADLE)} → versionName ${nextVersion} / versionCode ${code} (was ${gradle.name} / ${gradle.code})`);
} else {
  log(`  ✔ build.gradle already at ${nextVersion} — untouched`);
}

console.log('');
log('Next steps:');
log('  1. git commit + push to master → CI builds BLASTI-Setup-' + nextVersion + '.exe and BLASTI-v' + nextVersion + '-debug.apk');
log('  2. The publish job registers AppVersion ' + nextVersion + ' as a DRAFT in Admin → Public Apps Settings — click Activate.');
console.log('');
