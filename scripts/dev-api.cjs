#!/usr/bin/env node
/**
 * BLASTI API dev launcher — single-instance, cheap-boot, cross-platform.
 *
 * Why this exists (resource-exhaustion fix, see WEB_DEV_CRASH_AUDIT.md):
 *
 * 1. SINGLE INSTANCE GUARD — if :3003 already serves a healthy BLASTI API,
 *    starting a second one only produces a zombie (its listen() fails with
 *    EADDRINUSE and the process used to linger swallowing the error).
 *    Duplicate full stacks (API + Prisma engine + Next dev) are exactly how
 *    developer machines end up at 100% CPU/RAM. We refuse to start a second.
 *
 * 2. CONDITIONAL `db push` — the old dev:api ran the Prisma CLI (a 0.5–1GB
 *    RAM / heavy-CPU process) on EVERY boot, including every restart-loop
 *    iteration. We hash prisma/schema.prisma and only push when it actually
 *    changed (or FORCE_DB_PUSH=1).
 *
 * 3. `bun --watch` instead of `bun --hot` — --hot re-evaluates index.ts in
 *    the same process: the second httpServer.listen() hits EADDRINUSE, the
 *    error is swallowed, and edits to server code silently never apply.
 *    --watch restarts the process cleanly (state, workers, Prisma included).
 *
 * 4. CROSS-PLATFORM — no POSIX `export VAR=…` chain (that syntax breaks the
 *    dev:api script on Windows cmd/powershell). Env defaults are set here in
 *    Node, honoring anything the developer already exported (including
 *    CLOUD_DATABASE_URL for real PostgreSQL setups).
 *
 * Usage: node scripts/dev-api.cjs        (usually via `bun run dev:api`)
 */

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const API_DIR = path.join(REPO_ROOT, 'apps', 'api');
const SCHEMA_FILE = path.join(REPO_ROOT, 'packages', 'db', 'prisma', 'schema.prisma');
const STAMP_FILE = path.join(REPO_ROOT, 'packages', 'db', '.schema-stamp');
const PORT = Number(process.env.API_PORT || 3003);
const HOST = '127.0.0.1';

const log = (m) => console.log(`[dev-api] ${m}`);

function probeHealth(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: HOST, port: PORT, path: '/health', method: 'GET', timeout: timeoutMs },
      (res) => {
        // Drain body so the socket is released, then judge by status only.
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

function schemaHash() {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(SCHEMA_FILE)).digest('hex');
  } catch {
    return null; // schema missing — let db:push surface the real error
  }
}

function runChild(cmd, args, { cwd, env }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', (err) => {
      console.error(`[dev-api] failed to spawn ${cmd}: ${err.message}`);
      resolve(1);
    });
  });
}

async function main() {
  // ── 1. Single-instance guard ───────────────────────────────────────────────
  const alreadyHealthy = await probeHealth();
  if (alreadyHealthy) {
    log(`❗ A healthy BLASTI API is ALREADY running on http://${HOST}:${PORT} — not starting a second instance.`);
    log(`    (This guard prevents the duplicate-API zombie that pushed CPU/RAM to 100%.)`);
    log(`    If you meant to restart it: stop the old process first, then re-run dev:api.`);
    process.exit(0);
  }

  // ── 2. Env defaults (never override developer-provided values) ────────────
  const env = { ...process.env };
  if (!env.DATABASE_URL) {
    env.DATABASE_URL = `file:${path.join(REPO_ROOT, 'packages', 'db', 'data', 'custom.db')}`;
  }
  if (!env.NEXTAUTH_SECRET) env.NEXTAUTH_SECRET = 'blast1-dev-s3cr3t-k3y-f0r-d3v3l0pm3nt-0nly';
  if (!env.INTERNAL_SECRET) env.INTERNAL_SECRET = 'blast1-internal-secret-dev';
  if (!env.CORS_ORIGIN) env.CORS_ORIGIN = '*';

  // ── 3. Conditional db push (only when the schema actually changed) ────────
  const hash = schemaHash();
  const stamped = fs.existsSync(STAMP_FILE) ? fs.readFileSync(STAMP_FILE, 'utf8').trim() : null;
  const needsPush = env.FORCE_DB_PUSH === '1' || !hash || hash !== stamped;

  if (needsPush) {
    log('Schema changed (or first boot) — running `db push` once…');
    const code = await runChild('bun', ['run', '--filter', '@blasti/db', 'db:push'], {
      cwd: REPO_ROOT,
      env,
    });
    if (code !== 0) {
      console.error('[dev-api] db push FAILED — see output above. Not starting the API.');
      process.exit(code);
    }
    if (hash) {
      try { fs.writeFileSync(STAMP_FILE, hash + '\n'); } catch { /* non-fatal */ }
    }
  } else {
    log('Schema unchanged since last push — skipping Prisma CLI boot spike (FORCE_DB_PUSH=1 to force).');
  }

  // ── 4. Start the API under bun --watch (clean restarts, state never duplicates) ──
  log(`Starting API (bun --watch src/index.ts) on http://${HOST}:${PORT} …`);
  const child = spawn('bun', ['--watch', 'src/index.ts'], {
    cwd: API_DIR,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  const forward = (signal) => {
    try { child.kill(signal); } catch { /* already gone */ }
    // Give the child a moment, then exit ourselves so `concurrently`/shells unwind.
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));

  child.on('exit', (code) => process.exit(code ?? 0));
  child.on('error', (err) => {
    console.error(`[dev-api] failed to spawn bun: ${err.message}`);
    console.error('[dev-api] Is Bun installed and on PATH? https://bun.sh');
    process.exit(1);
  });
}

main();
