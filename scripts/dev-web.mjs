#!/usr/bin/env node
/**
 * dev-web.mjs — resilient wrapper around `next dev` for local development.
 *
 * WHY THIS EXISTS (Windows + bun):
 * `next dev` (Next 15/16) runs the actual server in a CHILD process. When the
 * app is launched through `bun run --filter @blasti/web dev`, Ctrl+C in
 * VS Code / PowerShell kills the bun wrapper (and the cmd shim), but the
 * signal never reaches the whole `next dev` process tree — the orphaned
 * `next-server` child keeps holding port 3000 and the next `bun run dev:web`
 * fails with EADDRINUSE until the user manually kills node.exe.
 *
 * This wrapper fixes both directions:
 *   1. BEFORE start  — if the port is already held by a leftover process,
 *                      kill that process tree automatically (self-healing).
 *   2. ON EXIT       — Ctrl+C / SIGTERM / wrapper exit kills the ENTIRE
 *                      next dev process tree (taskkill /T /F on Windows).
 *
 * It also spawns the Next.js binary directly under Node (skipping the
 * bun→cmd→next shim chain) so the child PID we track IS the real server
 * process, making tree-kill reliable.
 */

import { spawn, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const WEB_DIR = path.join(ROOT, 'apps', 'web');
const IS_WIN = process.platform === 'win32';
const PORT = String(process.env.PORT || '3000');
const HOST = process.env.HOST || '0.0.0.0';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** PIDs of processes LISTENING on the given port (empty array if none/free). */
function pidsListeningOnPort(port) {
  try {
    if (IS_WIN) {
      const out = execSync('netstat -ano -p tcp', {
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString();
      const pids = new Set();
      for (const line of out.split('\n')) {
        const cols = line.trim().split(/\s+/);
        // TCP  0.0.0.0:3000  0.0.0.0:0  LISTENING  12345
        if (
          cols.length >= 5 &&
          cols[0] === 'TCP' &&
          (cols[1] === `:${port}` || cols[1].endsWith(`:${port}`)) &&
          cols[3] === 'LISTENING'
        ) {
          pids.add(cols[4]);
        }
      }
      return [...pids];
    }
    // POSIX: lsof, then fuser fallback
    const out = execSync(
      `lsof -ti tcp:${port} -sTCP:LISTEN 2>/dev/null || fuser ${port}/tcp 2>/dev/null`,
      { shell: true, stdio: ['ignore', 'pipe', 'ignore'] },
    ).toString();
    return [...new Set(out.split(/\s+/).filter(Boolean))];
  } catch {
    return [];
  }
}

/** Best-effort image/process name for a PID (empty string if unknown). */
function pidProcessName(pid) {
  try {
    if (IS_WIN) {
      const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, {
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString();
      const m = out.match(/^"([^"]+)"/);
      return m ? m[1] : '';
    }
    return execSync(`ps -p ${pid} -o comm=`, {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
  } catch {
    return '';
  }
}

/** Kill a process and its whole tree. Best-effort — never throws. */
function killTree(pid) {
  if (!pid) return;
  try {
    if (IS_WIN) {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
    } else {
      try { process.kill(-Number(pid), 'SIGKILL'); } catch { /* not a group */ }
      try { process.kill(Number(pid), 'SIGKILL'); } catch { /* already gone */ }
    }
  } catch { /* already gone */ }
}

/** Resolve the Next.js CLI entry (apps/web/node_modules/next/dist/bin/next). */
function resolveNextBin() {
  const req = createRequire(path.join(WEB_DIR, 'package.json'));
  const pkgPath = req.resolve('next/package.json');
  return path.join(path.dirname(pkgPath), 'dist', 'bin', 'next');
}

/** Pick the runtime that will host next dev. Prefer real Node over Bun. */
function resolveRunner() {
  if (!/bun/i.test(process.execPath)) {
    // Already running under Node.
    return { cmd: process.execPath, args: [] };
  }
  // Running under bun — prefer system node for next dev.
  try {
    execSync('node -v', { stdio: 'ignore' });
    return { cmd: IS_WIN ? 'node.exe' : 'node', args: [] };
  } catch {
    // No system node — fall back to bun executing the Next bin directly.
    return { cmd: process.execPath, args: ['run'] };
  }
}

// ─── 1. Self-healing: free the port from any leftover previous run ──────────

const stalePids = pidsListeningOnPort(PORT);
if (stalePids.length) {
  // SAFETY: only auto-kill processes that look like a JS dev server
  // (node / bun / next). Anything else binding the port is left alone with
  // a warning + manual instructions.
  const jsLike = stalePids.filter((pid) => /node|bun|next/i.test(pidProcessName(pid)));
  const foreign = stalePids.filter((pid) => !jsLike.includes(pid));
  if (jsLike.length) {
    console.log(
      `[dev-web] Port ${PORT} is held by leftover JS dev process (pid${jsLike.length > 1 ? 's' : ''}: ${jsLike.join(', ')}) — killing tree from a previous run…`,
    );
    for (const pid of jsLike) killTree(pid);
  }
  if (foreign.length) {
    console.warn(
      `[dev-web] Port ${PORT} is also held by non-dev process (pid: ${foreign.join(', ')}) — NOT killing it. Free the port manually if next fails with EADDRINUSE.`,
    );
  }
  if (jsLike.length) {
    // Give the OS a moment to release the socket, then verify.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);
    const stillBusy = pidsListeningOnPort(PORT);
    if (stillBusy.length) {
      console.warn(`[dev-web] WARNING: port ${PORT} still busy after cleanup (pid: ${stillBusy.join(', ')}) — next may fail with EADDRINUSE.`);
    } else {
      console.log(`[dev-web] Port ${PORT} freed.`);
    }
  }
}

// ─── 2. Start next dev as a tracked child ───────────────────────────────────

let nextBin;
try {
  nextBin = resolveNextBin();
} catch (err) {
  console.error('[dev-web] Could not resolve the Next.js binary — is apps/web installed?', err?.message);
  process.exit(1);
}

const { cmd: runnerCmd, args: runnerArgs } = resolveRunner();
const extraArgs = process.argv.slice(2); // e.g. `bun run dev:web -- --turbopack`

const child = spawn(
  runnerCmd,
  [...runnerArgs, nextBin, 'dev', '-p', PORT, '-H', HOST, ...extraArgs],
  {
    cwd: WEB_DIR,
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'development' },
    windowsHide: true,
  },
);

console.log(`[dev-web] next dev starting on port ${PORT} (pid: ${child.pid}, runner: ${path.basename(runnerCmd)})`);

// ─── 3. Kill the whole tree on exit signals ─────────────────────────────────

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[dev-web] ${signal} received — stopping the Next.js dev server tree…`);
  killTree(child.pid);
  // taskkill is synchronous; give POSIX a beat to deliver, then exit.
  setTimeout(() => process.exit(0), 300).unref?.();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
if (IS_WIN) {
  // SIGHUP arrives when the console window / VS Code terminal is closed.
  try { process.on('SIGHUP', () => shutdown('SIGHUP')); } catch { /* not supported */ }
}
// Last-resort: if the wrapper itself exits while the child is somehow alive.
process.on('exit', () => {
  if (!shuttingDown && child.pid) killTree(child.pid);
});

child.on('exit', (code, signal) => {
  if (shuttingDown) process.exit(0);
  process.exit(code ?? (signal ? 1 : 0));
});

child.on('error', (err) => {
  console.error('[dev-web] Failed to start next dev:', err?.message);
  process.exit(1);
});
