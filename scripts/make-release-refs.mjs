#!/usr/bin/env node
/**
 * make-release-refs.mjs — build the DELTA-UPDATE reference artifacts for a
 * freshly packaged desktop release (run on the CI build machine right after
 * electron-builder, BEFORE the unpacked tree is thrown away).
 *
 *   node scripts/make-release-refs.mjs \
 *     --unpacked dist/win-unpacked \
 *     --out dist/release-refs \
 *     --electron-version 42.3.3
 *
 * Produces in --out:
 *   app.asar        — copy of <unpacked>/resources/app.asar (asar-diff base)
 *   outref.bin      — tree reference archive of <unpacked>/resources/app.asar.unpacked
 *   refs.json       — { runtimeKey, nativeFingerprint, asarSha256, outrefSha256 }
 *
 * The cloud diffs THIS release against the PREVIOUS release's refs to build
 * the differential patch devices actually download. See
 * apps/api/src/lib/app-version-deltas.ts for the server side.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createOutref, sha256OfFile } = require('../packages/binary-delta/index.js');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { args[key] = next; i++; }
    else args[key] = true;
  }
  return args;
}

const fail = (msg) => { console.error(`[refs] FAIL: ${msg}`); process.exit(1); };

const args = parseArgs(process.argv.slice(2));
const unpacked = args.unpacked;
const outDir = args.out || path.join(path.dirname(String(unpacked || '.')), 'release-refs');
const electronVersion = String(args['electron-version'] || '');
const arch = String(args.arch || 'x64');

if (!unpacked) fail('--unpacked <win-unpacked dir> is required');
const resources = path.join(unpacked, 'resources');
const asarPath = path.join(resources, 'app.asar');
const unpackedTree = path.join(resources, 'app.asar.unpacked');
if (!fs.existsSync(asarPath)) fail(`app.asar not found at ${asarPath}`);
if (!fs.existsSync(unpackedTree)) fail(`app.asar.unpacked not found at ${unpackedTree}`);

console.log('[refs] hashing native payload (everything outside app.asar + out/**)...');
// 0.6.58 — DUAL-SCOPE fingerprints, computed in ONE walk (per-file sha256
// hashed once into both scopes):
//
// 0.6.59 — FIELD ROOT CAUSE FIX ("native-bits-changed on every hop, even
// 0.6.57→0.6.58"): electron-builder stamps the app version into Blasti.exe's
// Windows version resource (rcedit: FileVersion/ProductVersion) on EVERY
// build, so the exe bytes differ between ANY two releases. Both pre-0.6.59
// scopes hashed that exe → no two versions could ever share a fingerprint →
// the cloud refused 100% of delta hops and every device fell back to the
// full installer. Top-level *.exe files are now EXCLUDED from the new scope:
// their runtime identity is already pinned by runtimeKey (electron version +
// arch), the only same-runtime exe delta is the version stamp, the patch
// system never delivers the exe (it is locked while the app runs), and the
// client's reported version comes from package.json inside the PATCHED asar
// (app.setVersion on manifest load), so a stale exe stamp is cosmetic only.
//
//   nativeFingerprint (NEW scope v3 — the honest guard)
//     sha256 over the sorted [relPath, fileSha256] list of every packaged
//     file EXCEPT resources/app.asar (asar delta delivers it), the WHOLE
//     resources/app.asar.unpacked/** (tree patch delivers it),
//     resources/node_modules/** (afterPack fallback copy — db.js resolution
//     prefers the asar/unpacked copies) and TOP-LEVEL *.exe (version-stamp
//     launchers — see above).
//     Any change to the genuinely UNPATCHABLE bits (electron dlls, locales,
//     resources/assets, resources/data) ⇒ the cloud refuses deltas and
//     devices fall back to the full installer — correct.
//     Schema/prisma changes live in asar + unpacked ⇒ deltas keep flowing.
//
//   legacyNativeFingerprint (OLD scope — pre-0.6.58 compatibility)
//     the pre-0.6.58 hash: everything EXCEPT resources/app.asar and
//     resources/app.asar.unpacked/out/** (i.e. the whole unpacked tree,
//     resources/node_modules AND the exe INCLUDED). Uploaded alongside the
//     new scope for structural compatibility with the 0.6.58 refs contract;
//     hops against pre-0.6.58 rows can never be fingerprint-verified (their
//     stored hashes include the stamped exe) and require the operator's
//     allowFingerprintRisk override. See fingerprintSpecOf() +
//     compareNativeFingerprints() in apps/api/src/lib/app-version-deltas.ts.
const skipForFingerprint = (rel) =>
  rel === 'resources/app.asar' ||
  rel.startsWith('resources/app.asar.unpacked/') ||
  rel.startsWith('resources/node_modules/') ||
  // 0.6.59 — version-stamped launcher binaries (Blasti.exe and any
  // electron-dist helper exes). Top level only: resources/** exes that ARE
  // patchable stay in the scope via their own tree deliveries.
  (!rel.includes('/') && rel.toLowerCase().endsWith('.exe'));
const skipForLegacyFingerprint = (rel) => rel === 'resources/app.asar' || rel.startsWith('resources/app.asar.unpacked/out/');
function walk(dir, rel, acc) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const relPath = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(full, relPath, acc);
    else if (e.isFile()) acc.push(relPath);
  }
}
const allFiles = [];
walk(unpacked, '', allFiles);
const fingerprintFiles = allFiles.filter((rel) => !skipForFingerprint(rel));
fingerprintFiles.sort();
const legacyFingerprintFiles = allFiles.filter((rel) => !skipForLegacyFingerprint(rel));
legacyFingerprintFiles.sort();
const fileShas = new Map(); // relPath → sha256 (computed once, reused by both scopes)
const hashNew = createHash('sha256');
const hashLegacy = createHash('sha256');
for (const rel of allFiles.slice().sort()) {
  const fileSha = createHash('sha256').update(fs.readFileSync(path.join(unpacked, rel))).digest('hex');
  fileShas.set(rel, fileSha);
}
for (const rel of fingerprintFiles) {
  hashNew.update(rel);
  hashNew.update('\u0000');
  hashNew.update(fileShas.get(rel));
  hashNew.update('\u0000');
}
for (const rel of legacyFingerprintFiles) {
  hashLegacy.update(rel);
  hashLegacy.update('\u0000');
  hashLegacy.update(fileShas.get(rel));
  hashLegacy.update('\u0000');
}
const nativeFingerprint = hashNew.digest('hex');
const legacyNativeFingerprint = hashLegacy.digest('hex');

console.log('[refs] building outref tree archive...');
const outref = createOutref(unpackedTree);

const runtimeKey = `electron-${electronVersion || 'unknown'}-${arch}`;

fs.mkdirSync(outDir, { recursive: true });
const asarDest = path.join(outDir, 'app.asar');
fs.copyFileSync(asarPath, asarDest);
const outrefDest = path.join(outDir, 'outref.bin');
fs.writeFileSync(outrefDest, outref.buf);

const refs = {
  runtimeKey,
  nativeFingerprint,
  legacyNativeFingerprint,
  // 0.6.59 — fingerprint definition marker: the cloud refuses to compare
  // hashes from different definitions (v1 pre-0.6.58 broad hash / v2 0.6.58
  // exe-inclusive / v3 0.6.59 exe-EXCLUDED). Only v3-vs-v3 hops are
  // automatically verifiable; mixed-spec hops need the operator override.
  fingerprintSpec: 'v3',
  asarSha256: await sha256OfFile(asarDest),
  asarSize: fs.statSync(asarDest).size,
  outrefSha256: createHash('sha256').update(outref.buf).digest('hex'),
  outrefSize: outref.buf.length,
  fileCount: outref.files.length,
};
fs.writeFileSync(path.join(outDir, 'refs.json'), JSON.stringify(refs, null, 2) + '\n');
console.log('[refs] OK →', outDir);
console.log(JSON.stringify(refs, null, 2));
