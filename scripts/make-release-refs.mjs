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
// nativeFingerprint — sha256 over the sorted [relPath, fileSha256] list of
// EVERY packaged file EXCEPT resources/app.asar and the out/** web bundle.
// Any change (electron dlls, node_modules, prisma engine, data) ⇒ the cloud
// refuses to hand out deltas and devices fall back to the full installer.
const skipForFingerprint = (rel) => rel === 'resources/app.asar' || rel.startsWith('resources/app.asar.unpacked/out/');
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
const hash = createHash('sha256');
for (const rel of fingerprintFiles) {
  hash.update(rel);
  hash.update('\u0000');
  hash.update(createHash('sha256').update(fs.readFileSync(path.join(unpacked, rel))).digest('hex'));
  hash.update('\u0000');
}
const nativeFingerprint = hash.digest('hex');

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
  asarSha256: await sha256OfFile(asarDest),
  asarSize: fs.statSync(asarDest).size,
  outrefSha256: createHash('sha256').update(outref.buf).digest('hex'),
  outrefSize: outref.buf.length,
  fileCount: outref.files.length,
};
fs.writeFileSync(path.join(outDir, 'refs.json'), JSON.stringify(refs, null, 2) + '\n');
console.log('[refs] OK →', outDir);
console.log(JSON.stringify(refs, null, 2));
