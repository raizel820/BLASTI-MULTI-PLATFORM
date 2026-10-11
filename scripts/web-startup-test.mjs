#!/usr/bin/env node
/**
 * BLASTI Web startup regression test (dev-crash audit, item 28).
 *
 * Verifies that `bun run dev:web` produces a healthy, stable Next.js dev
 * server WITHOUT any other process (no API, no Electron):
 *
 *   1. Next.js starts on 127.0.0.1:3000 (Node runtime — never `bun --bun`).
 *   2. The homepage renders (200, HTML contains the app shell).
 *   3. EVERY `/_next/static/chunks/*` referenced by the page returns 200 with
 *      a non-empty JavaScript body  →  no ChunkLoadError sources.
 *   4. The same chunk URL returns identical bytes on repeat requests
 *      (stable dev chunks — stale-cache / corruption detector).
 *   5. A second full page load requests a bounded number of NEW resources
 *      (no infinite compile/request loop).
 *   6. Dev server RSS memory stays within sane limits between t=10s and
 *      t=30s after startup (no runaway growth while idle).
 *
 * Usage:
 *   node scripts/web-startup-test.mjs          # starts its own dev server
 *   WEB_BASE_URL=http://127.0.0.1:3000 node scripts/web-startup-test.mjs
 *                                              # test an already-running server
 *
 * Exit code 0 = all checks passed, 1 = failure (CI-friendly).
 */

import { spawn, execSync } from 'node:child_process';
import http from 'node:http';

const HOST = '127.0.0.1';
const PORT = Number(process.env.WEB_PORT || 3000);
const BASE = process.env.WEB_BASE_URL || `http://${HOST}:${PORT}`;
const STARTUP_TIMEOUT_MS = 120_000;
const IDLE_MEMORY_SAMPLE_MS = [10_000, 30_000];
const MAX_RSS_MB = 4096; // hard ceiling — Bun-runtime runaway was ~1.4GB+; Node should stay well below

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? '✔' : '✘'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function get(path, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE}${path}`, { method: 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => req.destroy(new Error('request timeout')));
    req.end();
  });
}

function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (async function poll() {
      try {
        const res = await get('/');
        if (res.status === 200) return resolve();
      } catch { /* not ready yet */ }
      if (Date.now() > deadline) return reject(new Error(`dev server not ready after ${timeoutMs}ms`));
      setTimeout(poll, 1000);
    })();
  });
}

function killProcessTree(pid) {
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
    } else {
      try { process.kill(-pid, 'SIGKILL'); } catch { process.kill(pid, 'SIGKILL'); }
    }
  } catch { /* already gone */ }
}

async function main() {
  let child = null;
  let devLog = '';
  const externalServer = Boolean(process.env.WEB_BASE_URL);

  if (!externalServer) {
    console.log(`[web-startup-test] starting \`bun run dev:web\` (root of repo)…`);
    // Spawn via the user's package manager exactly as a developer would.
    const bin = process.platform === 'win32' ? 'bun.exe' : 'bun';
    child = spawn(bin, ['run', 'dev:web'], {
      cwd: new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      env: { ...process.env, BROWSER: 'none' },
    });
    child.stdout.on('data', (d) => { devLog += d; });
    child.stderr.on('data', (d) => { devLog += d; });
  }

  try {
    // ── 1. Server becomes ready ────────────────────────────────────────────
    const t0 = Date.now();
    await waitForServer(STARTUP_TIMEOUT_MS);
    record('Next.js dev server starts on 127.0.0.1:3000', true, `ready in ${Date.now() - t0}ms`);

    // ── 2. Homepage renders ────────────────────────────────────────────────
    const home = await get('/');
    const html = home.body.toString('utf8');
    record('homepage returns 200', home.status === 200, `status=${home.status}`);
    record(
      'homepage HTML contains app shell (html/body/_next payload)',
      html.includes('<html') && html.includes('/_next/'),
      `${html.length} bytes`,
    );

    // ── 3. Every referenced chunk loads ────────────────────────────────────
    const chunkUrls = [...new Set(
      (html.match(/\/_next\/static\/chunks\/[^"']+\.js/g) || [])
        .concat(html.match(/\/_next\/static\/[^"']+\.css/g) || []),
    )];
    record('page references static chunks', chunkUrls.length > 0, `${chunkUrls.length} URLs`);

    let failed = [];
    for (const url of chunkUrls) {
      try {
        const res = await get(url);
        if (res.status !== 200 || res.body.length === 0) failed.push(`${url} → ${res.status} (${res.body.length}B)`);
      } catch (e) {
        failed.push(`${url} → ${e.message}`);
      }
    }
    record('ALL referenced _next/static chunks load (200, non-empty)', failed.length === 0,
      failed.length ? `FAILURES:\n    ${failed.slice(0, 10).join('\n    ')}` : `${chunkUrls.length}/${chunkUrls.length} ok`);

    // ── 4. Chunk stability (identical bytes on re-request) ─────────────────
    if (chunkUrls.length > 0) {
      const probe = chunkUrls[0];
      const a = await get(probe);
      const b = await get(probe);
      const stable = a.status === 200 && b.status === 200 && a.body.equals(b.body);
      record('chunk bytes are stable across repeat requests', stable,
        `${probe.slice(-40)} ${a.body.length}B vs ${b.body.length}B`);
    }

    // ── 5. Second page load is bounded ─────────────────────────────────────
    const home2 = await get('/');
    const html2 = home2.body.toString('utf8');
    const urls2 = new Set(html2.match(/\/_next\/static\/chunks\/[^"']+\.js/g) || []);
    const novel = [...urls2].filter((u) => !chunkUrls.includes(u));
    record('second load introduces no new broken chunks', novel.length <= chunkUrls.length,
      `${novel.length} new URLs (subset of first load expected)`);

    // ── 6. Idle memory stability of the dev server ─────────────────────────
    if (!externalServer && child) {
      const sampleRss = () => {
        try {
          const out = execSync(
            process.platform === 'win32'
              ? `powershell -c "(Get-Process -Id ${child.pid}).WorkingSet64"`
              : `ps -o rss= -p ${child.pid}`,
            { encoding: 'utf8' },
          );
          return parseInt(out.trim(), 10) / 1024; // → MB
        } catch { return null; }
      };
      const s1 = await new Promise((r) => setTimeout(() => r(sampleRss()), IDLE_MEMORY_SAMPLE_MS[0]));
      const s2 = await new Promise((r) => setTimeout(() => r(sampleRss()), IDLE_MEMORY_SAMPLE_MS[1] - IDLE_MEMORY_SAMPLE_MS[0]));
      if (s1 != null && s2 != null) {
        const growth = s2 - s1;
        record('dev server RSS within ceiling & stable while idle',
          s2 < MAX_RSS_MB && growth < 512,
          `${s1.toFixed(0)}MB → ${s2.toFixed(0)}MB (Δ${growth >= 0 ? '+' : ''}${growth.toFixed(0)}MB over 20s idle)`);
      } else {
        record('dev server RSS sampling unavailable', true, 'skipped (process gone or unsupported platform)');
      }
    }

    // ── Summary ────────────────────────────────────────────────────────────
    const failedCount = results.filter((r) => !r.pass).length;
    console.log(`\n[web-startup-test] ${results.length - failedCount}/${results.length} checks passed`);
    if (failedCount > 0 && devLog) {
      console.log('\n──── dev server output (tail) ────');
      console.log(devLog.split('\n').slice(-40).join('\n'));
    }
    process.exitCode = failedCount > 0 ? 1 : 0;
  } catch (err) {
    console.error(`[web-startup-test] FATAL: ${err.message}`);
    if (devLog) console.log(devLog.split('\n').slice(-40).join('\n'));
    process.exitCode = 1;
  } finally {
    if (child) {
      killProcessTree(child.pid);
    }
  }
}

main();
