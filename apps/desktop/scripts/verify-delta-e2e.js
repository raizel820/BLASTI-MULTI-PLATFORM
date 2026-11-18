/**
 * 0.6.88 — END-TO-END delta verification (the user's explicit demand:
 * "make sure the server produces delta updates that can actually be
 * installed, not just a file that cannot be run on Windows").
 *
 * Simulates EXACTLY what production does:
 *   SERVER (apps/api/src/lib/app-version-deltas.ts generateDeltasForVersion):
 *     createDeltaFromFiles(prevAsar, curAsar)
 *     → self-verify applyDeltaToFile(prevAsar, asarDelta.delta)
 *     → createTreePatch(prevOutref, curOutref)
 *     → createReleasePatch({ asarDelta, treePatch })  ← the stored hop file
 *   CLIENT (apps/desktop/main.js updates:install-delta):
 *     parseReleasePatch(hopBuf) → SLICE payload → applyDeltaToFile(currentAsar, asarPart)
 *     → applyTreePatch(unpackedTree, treePart)
 *     → final asar sha256 must equal the target's recorded hash.
 *
 * Also REPRODUCES the shipped bug (whole envelope → applyDeltaToFile) to
 * prove the failure mode and that the fix eliminates it.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const lib = require('../../../packages/binary-delta/index.js');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
let failures = 0;
const check = (label, ok, extra) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blasti-delta-e2e-'));

// ── Build two "asar" files with a big shared prefix (realistic patch size) ──
const chunk = (n, fill) => Buffer.alloc(n, fill);
const oldAsar = Buffer.concat([
  chunk(2 * 1024 * 1024, 'A'),           // shared body
  chunk(256 * 1024, 'B'),                // tail replaced in the new release
  chunk(64 * 1024, 'C'),                 // shared tail
]);
const newAsar = Buffer.concat([
  chunk(2 * 1024 * 1024, 'A'),
  chunk(512 * 1024, 'D'),                // grown tail
  chunk(64 * 1024, 'C'),
]);
fs.writeFileSync(path.join(tmp, 'app-0.6.87.asar'), oldAsar);
fs.writeFileSync(path.join(tmp, 'app-0.6.88.asar'), newAsar);

// ── SERVER: generate the release patch exactly like the API does ──
const { createDeltaFromFiles, applyDeltaToFile, createOutref, createTreePatch, createReleasePatch, parseReleasePatch, extractReleasePatchParts, applyTreePatch } = lib;

(async () => {
  const asarDelta = await createDeltaFromFiles(path.join(tmp, 'app-0.6.87.asar'), path.join(tmp, 'app-0.6.88.asar'));
  check('server: asar delta created', Buffer.isBuffer(asarDelta.delta), `${asarDelta.delta.length} bytes (${((asarDelta.delta.length / oldAsar.length) * 100).toFixed(1)}% of the artifact)`);

  // Server self-verify (same as app-version-deltas.ts)
  const tmpOut = path.join(tmp, '.verify.tmp');
  await applyDeltaToFile(path.join(tmp, 'app-0.6.87.asar'), asarDelta.delta, tmpOut);
  check('server: self-verify apply reproduces the new asar', sha256(fs.readFileSync(tmpOut)) === sha256(newAsar));
  fs.unlinkSync(tmpOut);

  // Tree artifacts
  const mkTree = (tag) => {
    const dir = path.join(tmp, 'tree-' + tag);
    fs.mkdirSync(path.join(dir, 'app.asar.unpacked/node_modules/dep'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'app.asar.unpacked/native'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'app.asar.unpacked/native/keep.bin'), Buffer.alloc(4096, tag));
    fs.writeFileSync(path.join(dir, 'app.asar.unpacked/node_modules/dep/index.js'), `// ${tag} module\nmodule.exports = '${tag}';`);
    if (tag === 'old') fs.writeFileSync(path.join(dir, 'app.asar.unpacked/native/gone.bin'), 'obsolete');
    if (tag === 'new') fs.writeFileSync(path.join(dir, 'app.asar.unpacked/native/added.bin'), Buffer.alloc(1024, 'X'));
    return createOutref(path.join(dir, 'app.asar.unpacked')).buf;
  };
  const prevOutref = mkTree('old');
  const curOutref = mkTree('new');
  const treePatch = createTreePatch(prevOutref, curOutref);
  check('server: tree patch created', Buffer.isBuffer(treePatch.buf), `add=${treePatch.add} remove=${treePatch.remove}, ${treePatch.buf.length} bytes`);

  const releasePatch = createReleasePatch({
    fromVersion: '0.6.87',
    toVersion: '0.6.88',
    runtimeKey: 'win32-x64',
    nativeFingerprint: 'fp-test',
    asarDelta,
    treePatch,
  });
  const hopPath = path.join(tmp, 'delta-0.6.87-0.6.88.bin');
  fs.writeFileSync(hopPath, releasePatch);
  check('server: release patch stored', fs.statSync(hopPath).size === releasePatch.length, `${releasePatch.length} bytes`);

  // ── CLIENT: apply exactly like the FIXED main.js ──
  const hopBuf = fs.readFileSync(hopPath);
  const parsed = parseReleasePatch(hopBuf);
  check('client: parseReleasePatch succeeds', parsed.header.fromVersion === '0.6.87' && parsed.header.toVersion === '0.6.88');
  check('client: header records both parts', parsed.header.asar && parsed.header.tree);

  // 0.6.87 shipped bug REPRODUCTION: whole envelope into applyDeltaToFile
  let bugRepro = '';
  try {
    await applyDeltaToFile(path.join(tmp, 'app-0.6.87.asar'), hopBuf, path.join(tmp, 'bug.asar'));
  } catch (err) {
    bugRepro = String(err.message);
  }
  check('bug reproduction: whole envelope fails with bad magic', bugRepro.includes('bad magic'), bugRepro);

  // THE FIX: slice the asar part
  const asarPart = parsed.payload.subarray(0, parsed.header.asar.size);
  check('client: sliced asar part carries BLSTDLT1 magic', asarPart.subarray(0, 8).toString('ascii') === 'BLSTDLT1');
  const outAsar = path.join(tmp, 'app.asar.hop0');
  const applied = await applyDeltaToFile(path.join(tmp, 'app-0.6.87.asar'), asarPart, outAsar);
  check('client: applyDeltaToFile verifies the result sha256 internally', !!applied && applied.sha256 === sha256(newAsar), `size=${applied && applied.size}`);
  check('client: rebuilt asar is BYTE-IDENTICAL to the target release', sha256(fs.readFileSync(outAsar)) === sha256(newAsar));

  // Tree part via the canonical extractor + the legacy offset math must agree
  const parts = extractReleasePatchParts(hopBuf);
  const legacyTree = (function extractTreePart(releasePatchBuf, p) {
    let offset = 12 + releasePatchBuf.readUInt32BE(8);
    if (p.header.asar) offset += p.header.asar.size;
    return releasePatchBuf.subarray(offset, offset + p.header.tree.size);
  })(hopBuf, parsed);
  check('library: extractReleasePatchParts.asarDelta matches inline slice', parts.asarDelta.equals(asarPart));
  check('library: extractReleasePatchParts.treePatch matches legacy offset math', parts.treePatch.equals(legacyTree));
  check('tree part carries BLSTOUT1 magic', parts.treePatch.subarray(0, 8).toString('ascii') === 'BLSTOUT1');

  // Apply the tree patch against the "installed" unpacked tree — production
  // passes the app.asar.unpacked DIRECTORY itself as the root.
  const unpacked = path.join(tmp, 'installed-unpacked', 'app.asar.unpacked');
  fs.mkdirSync(path.join(unpacked, 'native'), { recursive: true });
  fs.mkdirSync(path.join(unpacked, 'node_modules/dep'), { recursive: true });
  fs.writeFileSync(path.join(unpacked, 'native/keep.bin'), Buffer.alloc(4096, 'old'));
  fs.writeFileSync(path.join(unpacked, 'node_modules/dep/index.js'), '// old module');
  const treeResult = applyTreePatch(unpacked, parts.treePatch);
  check('client: tree patch applied with zero failures', treeResult.failed.length === 0, `written=${treeResult.written.length} removed=${treeResult.removed.length}`);
  check('client: changed file content correct', fs.readFileSync(path.join(unpacked, 'node_modules/dep/index.js')).toString().includes("'new'"));
  check('client: added file exists', fs.existsSync(path.join(unpacked, 'native/added.bin')));
  check('client: removed file gone', !fs.existsSync(path.join(unpacked, 'native/gone.bin')));

  // Multi-hop chain sanity (0.6.86 → 0.6.87 → 0.6.88 style): hop k+1 applies to hop k's OUTPUT
  const midAsar = Buffer.concat([chunk(2 * 1024 * 1024, 'A'), chunk(384 * 1024, 'E'), chunk(64 * 1024, 'C')]);
  fs.writeFileSync(path.join(tmp, 'app-0.6.87b.asar'), midAsar);
  const hop1 = await createDeltaFromFiles(path.join(tmp, 'app-0.6.87.asar'), path.join(tmp, 'app-0.6.87b.asar'));
  const hop2 = await createDeltaFromFiles(path.join(tmp, 'app-0.6.87b.asar'), path.join(tmp, 'app-0.6.88.asar'));
  const r1 = await applyDeltaToFile(path.join(tmp, 'app-0.6.87.asar'), hop1.delta, path.join(tmp, 'chain1.asar'));
  const r2 = await applyDeltaToFile(path.join(tmp, 'chain1.asar'), hop2.delta, path.join(tmp, 'chain2.asar'));
  check('client: 2-hop chain lands byte-identical', r1.sha256 === sha256(midAsar) && r2.sha256 === sha256(newAsar));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? '\nALL DELTA E2E CHECKS PASS — the server produces REAL installable deltas.' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
