'use strict';
/**
 * @blasti/binary-delta — BLASTI differential update patches (delta-1 format)
 * ─────────────────────────────────────────────────────────────────────────────
 * DELTA UPDATES (0.6.30): instead of shipping a FULL installer/APK for every
 * release, the cloud API generates a small PATCH between the previous release
 * artifact and the new one, and clients download + apply the patch locally:
 *
 *   • Desktop (Electron): patch app.asar  (old asar is on disk in the install)
 *   • Android (Capacitor): patch base.apk (the installed APK is on disk)
 *
 * File-format ("delta-1", stable contract — the Android patcher in
 * BlastiNativeStatus.java implements the SAME wire format byte-for-byte):
 *
 *   offset  size  field
 *   0       8     magic  "BLSTDLT1"
 *   8       4     u32be  headerLen
 *   12      hl    UTF-8 JSON header:
 *                   { v: 1, chunk, fromSize, toSize,
 *                     fromSha256, toSha256, ops }
 *   12+hl   …     zlib-deflate(ops stream)
 *
 *   ops stream (after inflate) — a sequence of instructions that rebuilds the
 *   NEW file when executed left-to-right against the OLD file:
 *     0x01 COPY  varint:len  varint:oldOffset   → copy `len` bytes of OLD
 *                                                starting at oldOffset
 *     0x02 DATA  varint:len  bytes[len]         → literal bytes
 *
 * Matching strategy — CONTENT-defined, not offset-based: the old file is
 * indexed by the crc32 of every fixed-size chunk. When scanning the new file,
 * any chunk whose CONTENT exists anywhere in the old file becomes a COPY.
 * This is what makes the format survive archive formats (asar / APK-zip)
 * where inserting one file shifts every following offset: unchanged file
 * bodies still match byte-for-byte wherever they moved to.
 *
 * Integrity: the caller ALWAYS verifies sha256(output) == header.toSha256
 * (helpers below do it automatically). A mismatch is unrecoverable-by-design
 * — the client falls back to the full installer.
 */

const zlib = require('zlib');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAGIC = Buffer.from('BLSTDLT1', 'ascii');
const OP_COPY = 0x01;
const OP_DATA = 0x02;
const DEFAULT_CHUNK = 16 * 1024;

// ─── crc32 (table-based, ~1 GB/s) ────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ─── varint (LEB128 unsigned) ────────────────────────────────────────────────

function writeVarint(value, out) {
  let v = value;
  while (v >= 0x80) {
    out.push((v & 0x7F) | 0x80);
    v >>>= 7;
  }
  out.push(v);
}

function readVarint(buf, pos) {
  let result = 0;
  let shift = 0;
  let p = pos;
  for (;;) {
    if (p >= buf.length) throw new Error('delta-truncated: varint out of bounds');
    const b = buf[p++];
    result += (b & 0x7F) * Math.pow(2, shift);
    if ((b & 0x80) === 0) return { value: result, pos: p };
    shift += 7;
    if (shift > 42) throw new Error('delta-corrupt: varint too long');
  }
}

// ─── sha256 helpers ──────────────────────────────────────────────────────────

function sha256Buf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256OfFile(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(filePath);
    s.on('data', (c) => h.update(c));
    s.on('error', reject);
    s.on('end', () => resolve(h.digest('hex')));
  });
}

// ─── CREATE (cloud API side) ─────────────────────────────────────────────────

/**
 * Build a delta patch that transforms `oldPath` into `newPath`.
 * Memory-bounded: both files are read via positional/streaming reads; only
 * the compressed ops live in memory.
 *
 * @returns {{ delta: Buffer, header: object }}  header.toSha256 is the sha256
 * of the NEW file — the verification anchor every client checks after apply.
 */
async function createDeltaFromFiles(oldPath, newPath, opts = {}) {
  const chunk = opts.chunk || DEFAULT_CHUNK;

  const oldStat = fs.statSync(oldPath);
  const newStat = fs.statSync(newPath);
  if (!oldStat.isFile() || !newStat.isFile()) throw new Error('delta-create: input is not a file');
  if (newStat.size > 0xFFFFFFFF) throw new Error('delta-create: file too large for delta-1 (4 GiB cap)');

  // ── Index the OLD file: crc32(chunk) → [offsets] ──────────────────────────
  // (tiny map even for a 200 MB artifact: 16 KB chunks → ~12k entries)
  // The fd stays OPEN for the whole creation: the scan loop re-reads OLD
  // chunks to confirm every crc candidate (fd-number reuse after close would
  // silently verify against the WRONG file).
  const oldFd = fs.openSync(oldPath, 'r');
  const newFd = fs.openSync(newPath, 'r');
  const index = new Map();
  try {
    const buf = Buffer.alloc(chunk);
    for (let off = 0; off < oldStat.size; off += chunk) {
      const len = Math.min(chunk, oldStat.size - off);
      const read = fs.readSync(oldFd, buf, 0, len, off);
      // ALWAYS slice to `read` bytes — for the final partial chunk `read ===
      // len < chunk` and `buf` still holds stale bytes of the previous chunk
      // beyond len (a full-buffer copy once corrupted the emitted literal).
      const slice = buf.subarray(0, read);
      const key = crc32(slice);
      const list = index.get(key);
      if (list) list.push(off);
      else index.set(key, [off]);
    }
  } catch (e) {
    try { fs.closeSync(oldFd); } catch { /* already closed */ }
    try { fs.closeSync(newFd); } catch { /* already closed */ }
    throw e;
  }

  // ── Scan the NEW file and emit ops ────────────────────────────────────────
  const ops = []; // { oldOff, len } for COPY · { d: Buffer } for DATA
  const probe = Buffer.alloc(chunk);
  let lastCopy = null; // { outPos, oldOff, len } — growable COPY run
  try {
    for (let off = 0; off < newStat.size; off += chunk) {
      const len = Math.min(chunk, newStat.size - off);
      const read = fs.readSync(newFd, probe, 0, len, off);
      const slice = probe.subarray(0, read); // never expose stale probe tail

      let matched = false;
      const candidates = index.get(crc32(slice));
      if (candidates) {
        const oldChunk = Buffer.alloc(len);
        for (const candOff of candidates) {
          let ok = false;
          try {
            const r = fs.readSync(oldFd, oldChunk, 0, len, candOff);
            ok = r === len && oldChunk.equals(slice);
          } catch { ok = false; }
          if (ok) {
            // Extend the previous COPY run when it is contiguous in BOTH
            // files (the common case: unchanged regions bigger than one
            // chunk) — otherwise start a new one.
            if (lastCopy && lastCopy.outPos + lastCopy.len === off && lastCopy.oldOff + lastCopy.len === candOff) {
              lastCopy.len += len;
            } else {
              lastCopy = { outPos: off, oldOff: candOff, len };
              ops.push(lastCopy);
            }
            matched = true;
            break;
          }
        }
      }
      if (!matched) {
        ops.push({ d: Buffer.from(slice) }); // fresh bytes — copy of the slice
        lastCopy = null;
      }
    }
  } finally {
    fs.closeSync(oldFd);
    fs.closeSync(newFd);
  }

  // ── Serialize ops → varint stream → deflate ───────────────────────────────
  // INTERLEAVED layout: [hdr+payload][hdr+payload]… — the applier is a single
  // left-to-right walk (op header followed inline by its literal payload for
  // DATA), so every op must carry its bytes in sequence.
  const chunks = [];
  let total = 0;
  const scratch = [];
  for (const op of ops) {
    scratch.length = 0;
    if (op.d) {
      scratch.push(OP_DATA);
      writeVarint(op.d.length, scratch);
      chunks.push(Buffer.from(scratch), op.d);
      total += scratch.length + op.d.length;
    } else {
      scratch.push(OP_COPY);
      writeVarint(op.len, scratch);
      writeVarint(op.oldOff, scratch);
      chunks.push(Buffer.from(scratch));
      total += scratch.length;
    }
  }
  const opsStream = Buffer.concat(chunks, total);
  const compressed = zlib.deflateSync(opsStream, { level: 9 });

  const fromSha256 = await sha256OfFile(oldPath);
  const toSha256 = await sha256OfFile(newPath);

  const header = {
    v: 1,
    chunk,
    fromSize: oldStat.size,
    toSize: newStat.size,
    fromSha256,
    toSha256,
    ops: ops.length,
  };
  const headerBuf = Buffer.from(JSON.stringify(header), 'utf8');

  const delta = Buffer.concat([MAGIC, u32be(headerBuf.length), headerBuf, compressed]);
  return { delta, header };
}

function u32be(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

/** Parse + validate the delta envelope. Throws on any structural problem. */
function parseDelta(deltaBuf) {
  if (!Buffer.isBuffer(deltaBuf) || deltaBuf.length < 12) throw new Error('delta-corrupt: too small');
  if (!deltaBuf.subarray(0, 8).equals(MAGIC)) throw new Error('delta-corrupt: bad magic');
  const headerLen = deltaBuf.readUInt32BE(8);
  if (headerLen <= 2 || headerLen > 64 * 1024 || 12 + headerLen > deltaBuf.length) {
    throw new Error('delta-corrupt: bad header length');
  }
  let header;
  try { header = JSON.parse(deltaBuf.subarray(12, 12 + headerLen).toString('utf8')); }
  catch { throw new Error('delta-corrupt: bad header JSON'); }
  if (!header || header.v !== 1 || typeof header.toSize !== 'number') {
    throw new Error('delta-corrupt: unsupported header');
  }
  const ops = zlib.inflateSync(deltaBuf.subarray(12 + headerLen));
  return { header, ops };
}

// ─── APPLY ───────────────────────────────────────────────────────────────────

/** In-memory apply — used by the API to SELF-VERIFY a fresh patch and by tests. */
function applyDeltaBuffer(oldBuf, deltaBuf) {
  const { header, ops } = parseDelta(deltaBuf);
  const out = Buffer.alloc(header.toSize);
  let p = 0;
  let o = 0;
  while (p < ops.length) {
    const op = ops[p++];
    if (op === OP_COPY) {
      const len = readVarint(ops, p); p = len.pos;
      const off = readVarint(ops, p); p = off.pos;
      if (off.value + len.value > oldBuf.length) throw new Error('delta-corrupt: COPY out of old bounds');
      if (o + len.value > out.length) throw new Error('delta-corrupt: COPY overruns output');
      oldBuf.copy(out, o, off.value, off.value + len.value);
      o += len.value;
    } else if (op === OP_DATA) {
      const len = readVarint(ops, p); p = len.pos;
      if (p + len.value > ops.length) throw new Error('delta-corrupt: DATA out of bounds');
      if (o + len.value > out.length) throw new Error('delta-corrupt: DATA overruns output');
      ops.copy(out, o, p, p + len.value);
      p += len.value;
      o += len.value;
    } else {
      throw new Error(`delta-corrupt: unknown op 0x${op.toString(16)}`);
    }
  }
  if (o !== out.length) throw new Error(`delta-corrupt: produced ${o} bytes, expected ${header.toSize}`);
  return out;
}

/**
 * Streaming-ish apply for clients: reads OLD via positional reads (COPY) and
 * streams the output to `outPath` — never holds the whole artifact in RAM.
 * Returns { size, sha256 } of the produced file (VERIFIED against the header
 * when `verify` is not false).
 */
async function applyDeltaToFile(oldPath, deltaBuf, outPath, opts = {}) {
  const { header, ops } = parseDelta(deltaBuf);
  const oldFd = fs.openSync(oldPath, 'r');
  const out = fs.openSync(outPath, 'w');
  const hash = crypto.createHash('sha256');
  try {
    // Output pre-sized so progress can be derived from size alone.
    fs.truncateSync(out, header.toSize);
    const copyBuf = Buffer.alloc(1024 * 1024);
    let p = 0;
    let o = 0;
    while (p < ops.length) {
      const op = ops[p++];
      if (op === OP_COPY) {
        const len = readVarint(ops, p); p = len.pos;
        const off = readVarint(ops, p); p = off.pos;
        if (off.value + len.value > header.fromSize) throw new Error('delta-corrupt: COPY out of old bounds');
        if (o + len.value > header.toSize) throw new Error('delta-corrupt: COPY overruns output');
        let remaining = len.value;
        let src = off.value;
        let dst = o;
        while (remaining > 0) {
          const take = Math.min(remaining, copyBuf.length);
          const r = fs.readSync(oldFd, copyBuf, 0, take, src);
          if (r !== take) throw new Error('delta-corrupt: short read on OLD file');
          fs.writeSync(out, copyBuf, 0, take, dst);
          hash.update(copyBuf.subarray(0, take));
          src += take; dst += take; remaining -= take;
        }
        o += len.value;
      } else if (op === OP_DATA) {
        const len = readVarint(ops, p); p = len.pos;
        if (p + len.value > ops.length) throw new Error('delta-corrupt: DATA out of bounds');
        if (o + len.value > header.toSize) throw new Error('delta-corrupt: DATA overruns output');
        // Stream literal in ≤1 MB slices so hash/write stay memory-flat.
        let written = 0;
        while (written < len.value) {
          const take = Math.min(len.value - written, 1024 * 1024);
          const slice = ops.subarray(p + written, p + written + take);
          fs.writeSync(out, slice, 0, take, o + written);
          hash.update(slice);
          written += take;
        }
        p += len.value;
        o += len.value;
      } else {
        throw new Error(`delta-corrupt: unknown op 0x${op.toString(16)}`);
      }
    }
    if (o !== header.toSize) throw new Error(`delta-corrupt: produced ${o} bytes, expected ${header.toSize}`);
  } finally {
    fs.closeSync(oldFd);
    fs.closeSync(out);
  }
  const sha = await sha256OfFile(outPath);
  if (opts.verify !== false && sha !== header.toSha256) {
    try { fs.unlinkSync(outPath); } catch { /* best effort */ }
    const err = new Error(`delta-verify-failed: output sha256 ${sha.slice(0, 12)}… != expected ${header.toSha256.slice(0, 12)}…`);
    err.code = 'EDELTAVERIFY';
    throw err;
  }
  return { size: header.toSize, sha256: sha };
}

module.exports = {
  MAGIC,
  DEFAULT_CHUNK,
  crc32,
  createDeltaFromFiles,
  applyDeltaBuffer,
  applyDeltaToFile,
  parseDelta,
  sha256Buf,
  sha256OfFile,
};

// ─── Release tree references + tree patches (desktop out/** tree) ────────────
// The desktop app keeps its WEB BUNDLE outside the asar (asarUnpack out/**),
// so a release ships TWO diffable artifacts:
//   • app.asar            → classic binary-delta (BLSTDLT1)
//   • app.asar.unpacked/** → a TREE REFERENCE (outref) the next release
//     diffs against, producing a TREE PATCH (BLSTOUT1) with only the
//     added/changed files' bytes + the removed list.
//
// Containers (stable wire format — BlastiNativeStatus.java does NOT need
// these; only the desktop patcher does):
//   BLSTREF1     u32be jsonLen { v:1, files:[{p,s,h}] } + deflate(concat bytes)
//   BLSTOUT1     u32be jsonLen { v:1, add:[{p,s,h}], remove:[p] } +
//                deflate(added file bytes, in add[] order)
//   BLSTRLS1     u32be jsonLen { v:1, fromVersion, toVersion, runtimeKey,
//                nativeFingerprint, asar:{fromSha256,toSha256,size}|null,
//                tree:{size,sha256,add,remove}|null }
//                + [asar delta bytes][tree container bytes]

const MAGIC_OUTREF = Buffer.from('BLSTREF1', 'ascii');
const MAGIC_TREE = Buffer.from('BLSTOUT1', 'ascii');
const MAGIC_RELEASE = Buffer.from('BLSTRLS1', 'ascii');

function listTree(rootDir) {
  const files = [];
  const walk = (dir, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(full, relPath);
      else if (e.isFile()) {
        let stat = null;
        try { stat = fs.statSync(full); } catch { continue; }
        files.push({ full, relPath, size: stat.size });
      }
    }
  };
  walk(rootDir, '');
  files.sort((a, b) => (a.relPath < b.relPath ? -1 : 1));
  return files;
}

function envelope(magic, headerObj, payloadBuf) {
  const h = Buffer.from(JSON.stringify(headerObj), 'utf8');
  return Buffer.concat([magic, u32be(h.length), h, payloadBuf]);
}

function openEnvelope(buf, expectedMagic) {
  if (!Buffer.isBuffer(buf) || buf.length < 12 || !buf.subarray(0, 8).equals(expectedMagic)) {
    throw new Error(`container-corrupt: expected ${expectedMagic.toString('ascii')}`);
  }
  const headerLen = buf.readUInt32BE(8);
  const header = JSON.parse(buf.subarray(12, 12 + headerLen).toString('utf8'));
  return { header, payload: buf.subarray(12 + headerLen) };
}

/**
 * Build a tree REFERENCE archive for a directory (deterministic order).
 * @returns {{ buf: Buffer, files: Array<{p,s,h}> }}
 */
function createOutref(rootDir) {
  const entries = listTree(rootDir);
  const files = [];
  const contents = [];
  let total = 0;
  for (const e of entries) {
    const data = fs.readFileSync(e.full);
    const h = sha256Buf(data);
    files.push({ p: e.relPath, s: data.length, h });
    contents.push(data);
    total += data.length;
  }
  const payload = zlib.deflateSync(Buffer.concat(contents, total), { level: 6 });
  const buf = envelope(MAGIC_OUTREF, { v: 1, files }, payload);
  return { buf, files };
}

/** Parse an outref header WITHOUT inflating the payload (cheap listing). */
function readOutrefHeader(buf) {
  const { header } = openEnvelope(buf, MAGIC_OUTREF);
  return { files: header.files || [] };
}

/**
 * Diff two outref archives → tree patch (BLSTOUT1). Added/changed files come
 * from the NEW archive's payload; removed = paths present only in the old.
 */
function createTreePatch(prevOutrefBuf, newOutrefBuf) {
  const prev = openEnvelope(prevOutrefBuf, MAGIC_OUTREF);
  const next = openEnvelope(newOutrefBuf, MAGIC_OUTREF);
  const prevMap = new Map(prev.header.files.map((f) => [f.p, f]));
  const add = [];
  const addBytes = [];
  let total = 0;
  for (const f of next.header.files) {
    const old = prevMap.get(f.p);
    if (old && old.h === f.h && old.s === f.s) continue;
    add.push(f);
  }
  // Extract the kept files' bytes in add[] order — inflate once, slice by size.
  const inflated = zlib.inflateSync(next.payload);
  let cursor = 0;
  for (const f of next.header.files) {
    const isNeeded = add.some((a) => a.p === f.p);
    const slice = inflated.subarray(cursor, cursor + f.s);
    cursor += f.s;
    if (isNeeded) { addBytes.push(Buffer.from(slice)); total += f.s; }
  }
  const remove = prev.header.files.map((f) => f.p).filter((p) => !next.header.files.some((f) => f.p === p));
  const payload = zlib.deflateSync(Buffer.concat(addBytes, total), { level: 6 });
  const buf = envelope(MAGIC_TREE, { v: 1, add, remove }, payload);
  return { buf, add: add.length, remove: remove.length };
}

/**
 * Apply a tree patch to a local directory. Per-file best effort — the caller
 * inspects `failed` and falls back to a full installer when it is non-empty
 * (a half-patched tree must never be trusted).
 */
function applyTreePatch(rootDir, treePatchBuf) {
  const { header, payload } = openEnvelope(treePatchBuf, MAGIC_TREE);
  const inflated = zlib.inflateSync(payload);
  const written = [];
  const failed = [];
  let cursor = 0;
  for (const f of header.add || []) {
    const data = inflated.subarray(cursor, cursor + f.s);
    cursor += f.s;
    const dest = path.join(rootDir, f.p);
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, data);
      const check = sha256Buf(fs.readFileSync(dest));
      if (check !== f.h) throw new Error(`sha mismatch after write (${check.slice(0, 8)}… != ${f.h.slice(0, 8)}…)`);
      written.push(f.p);
    } catch (err) {
      failed.push({ p: f.p, error: String(err && err.message || err).slice(0, 200) });
    }
  }
  const removed = [];
  for (const p of header.remove || []) {
    try { fs.unlinkSync(path.join(rootDir, p)); removed.push(p); }
    catch (err) {
      if (err && err.code !== 'ENOENT') failed.push({ p, error: String(err.message || err).slice(0, 200) });
    }
  }
  return { written, removed, failed, add: (header.add || []).length, remove: (header.remove || []).length };
}

/**
 * Desktop RELEASE PATCH container: asar binary-delta + tree patch in one
 * downloadable file (one hop of the desktop delta chain).
 */
function createReleasePatch({ fromVersion, toVersion, runtimeKey, nativeFingerprint, asarDelta, treePatch }) {
  const header = {
    v: 1,
    fromVersion,
    toVersion,
    runtimeKey: runtimeKey || '',
    nativeFingerprint: nativeFingerprint || '',
    asar: asarDelta
      ? { fromSha256: asarDelta.header.fromSha256, toSha256: asarDelta.header.toSha256, size: asarDelta.delta.length }
      : null,
    tree: treePatch
      ? { size: treePatch.buf.length, sha256: sha256Buf(treePatch.buf), add: treePatch.add, remove: treePatch.remove }
      : null,
  };
  const parts = [];
  if (asarDelta) parts.push(asarDelta.delta);
  if (treePatch) parts.push(treePatch.buf);
  const payload = Buffer.concat(parts);
  return envelope(MAGIC_RELEASE, header, payload);
}

function parseReleasePatch(buf) {
  return openEnvelope(buf, MAGIC_RELEASE);
}

module.exports.createOutref = createOutref;
module.exports.readOutrefHeader = readOutrefHeader;
module.exports.createTreePatch = createTreePatch;
module.exports.applyTreePatch = applyTreePatch;
module.exports.createReleasePatch = createReleasePatch;
module.exports.parseReleasePatch = parseReleasePatch;
