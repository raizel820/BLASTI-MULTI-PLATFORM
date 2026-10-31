/**
 * Type declarations for @blasti/binary-delta — BLASTI differential update
 * patches (create + apply, content-defined chunk diff).
 */

export interface DeltaHeader {
  v: number;
  chunk: number;
  fromSize: number;
  toSize: number;
  fromSha256: string;
  toSha256: string;
  ops: number;
}

export interface OutrefFileEntry {
  p: string;
  s: number;
  h: string;
}

export interface TreePatchResult {
  written: string[];
  removed: string[];
  failed: Array<{ p: string; error: string }>;
  add: number;
  remove: number;
}

export interface ReleasePatchHeader {
  v: number;
  fromVersion: string;
  toVersion: string;
  runtimeKey: string;
  nativeFingerprint: string;
  asar: { fromSha256: string; toSha256: string; size: number } | null;
  tree: { size: number; sha256: string; add: number; remove: number } | null;
}

export function crc32(buf: Buffer): number;
export function createDeltaFromFiles(
  oldPath: string,
  newPath: string,
  opts?: { chunk?: number },
): Promise<{ delta: Buffer; header: DeltaHeader }>;
export function applyDeltaBuffer(oldBuf: Buffer, deltaBuf: Buffer): Buffer;
export function applyDeltaToFile(
  oldPath: string,
  deltaBuf: Buffer,
  outPath: string,
  opts?: { verify?: boolean },
): Promise<{ size: number; sha256: string }>;
export function parseDelta(deltaBuf: Buffer): { header: DeltaHeader; ops: Buffer };
export function sha256Buf(buf: Buffer): string;
export function sha256OfFile(filePath: string): Promise<string>;
export function createOutref(rootDir: string): { buf: Buffer; files: OutrefFileEntry[] };
export function readOutrefHeader(buf: Buffer): { files: OutrefFileEntry[] };
export function createTreePatch(
  prevOutrefBuf: Buffer,
  newOutrefBuf: Buffer,
): { buf: Buffer; add: number; remove: number };
export function applyTreePatch(rootDir: string, treePatchBuf: Buffer): TreePatchResult;
export function createReleasePatch(args: {
  fromVersion: string;
  toVersion: string;
  runtimeKey?: string;
  nativeFingerprint?: string;
  asarDelta?: { delta: Buffer; header: DeltaHeader } | null;
  treePatch?: { buf: Buffer; add: number; remove: number } | null;
}): Buffer;
export function parseReleasePatch(buf: Buffer): { header: ReleasePatchHeader; payload: Buffer };
