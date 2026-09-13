#!/usr/bin/env node
/**
 * BLASTI Web dev launcher — heap-capped Node runtime for Next.js dev.
 *
 * Why this exists (resource-exhaustion fix, see WEB_DEV_CRASH_AUDIT.md):
 *
 * The Next.js 16 dev server for this monorepo idles at ~1.5GB RSS and grows
 * freely on top of that when compiling. With no V8 heap ceiling, the dev
 * server (plus the browser, plus the API) can consume every byte of RAM on
 * the developer machine — Windows starts paging and the whole PC freezes at
 * 100% RAM/CPU. Capping the heap forces aggressive GC *inside the dev server*
 * instead of letting the OS pay for it system-wide.
 *
 *   - Default cap: 3072 MB (idle RSS measured ~1.5GB → safe headroom).
 *   - Override:    BLASTI_WEB_MAX_HEAP_MB=2048 node scripts/dev-web.cjs …
 *   - Any pre-existing NODE_OPTIONS is preserved; a previous
 *     --max-old-space-size is replaced (last one wins in V8 anyway).
 *
 * All CLI args are passed through unchanged:
 *   node scripts/dev-web.cjs -p 3000 -H 127.0.0.1
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const WEB_DIR = path.resolve(__dirname, '..', 'apps', 'web');

const args = process.argv.slice(2);
const heapMb = Number(process.env.BLASTI_WEB_MAX_HEAP_MB || 3072);

// Build NODE_OPTIONS: strip any previous max-old-space-size, then append ours.
const userOpts = (process.env.NODE_OPTIONS || '')
  .split(/\s+/)
  .filter(Boolean)
  .filter((o) => !o.startsWith('--max-old-space-size'));
userOpts.push(`--max-old-space-size=${heapMb}`);
process.env.NODE_OPTIONS = userOpts.join(' ');

const log = (m) => console.log(`[dev-web] ${m}`);
log(`Next.js dev on Node with heap capped at ${heapMb} MB (override: BLASTI_WEB_MAX_HEAP_MB).`);
if (heapMb < 2048) {
  log(`⚠ Low heap cap (${heapMb}MB): if compilation aborts with "JavaScript heap out of memory", raise BLASTI_WEB_MAX_HEAP_MB or run \`bun run clean:web\` first.`);
}

const child = spawn('node', [path.join(WEB_DIR, 'node_modules', 'next', 'dist', 'bin', 'next'), 'dev', ...args], {
  cwd: WEB_DIR,
  env: process.env,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

const forward = (signal) => {
  try { child.kill(signal); } catch { /* already gone */ }
  setTimeout(() => process.exit(0), 300);
};
process.on('SIGINT', () => forward('SIGINT'));
process.on('SIGTERM', () => forward('SIGTERM'));

child.on('exit', (code) => process.exit(code ?? 0));
child.on('error', (err) => {
  console.error(`[dev-web] failed to spawn node: ${err.message}`);
  process.exit(1);
});
