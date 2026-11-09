#!/usr/bin/env node
/**
 * publish-installer.mjs — Upload a built installer to the BLASTI cloud API
 * so it appears in the admin "Public Apps Settings" page.
 *
 * Used by CI (.github/workflows/build-releases.yml) after a successful
 * build; can also be run manually from a dev machine:
 *
 *   node scripts/publish-installer.mjs \
 *     --file BLASTI-v1.2.3-release.apk \
 *     --platform android \
 *     --version 1.2.3 \
 *     --api-url https://your-server.com \
 *     --token "$DEPLOY_TOKEN" \
 *     --notes "Automated build abc1234"
 *
 * Auth: the --token value must match DEPLOY_TOKEN from /etc/blasti/blasti.env
 * on the server (header: x-deploy-token).
 *
 * Behaviour:
 *   - Creates the AppVersion record when it does not exist (upload?create=1)
 *     and always attaches/replaces the binary — idempotent, safe to re-run.
 *   - Records land UNPUBLISHED (draft): an admin selects the active version
 *     per platform in Public Apps Settings.
 *
 * Exit codes: 0 uploaded / already current · 1 failure
 */

import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';

// ─── Args ───────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

const file = args.file;
const platform = args.platform;
const version = args.version;
let rawApiUrl = String(args['api-url'] || process.env.BLASTI_API_URL || '');
let apiUrl = rawApiUrl;
const token = args.token || process.env.BLASTI_DEPLOY_TOKEN || process.env.DEPLOY_TOKEN || '';
const notes = String(args.notes ?? '');
const versionCode = Number.parseInt(String(args['version-code'] ?? '0'), 10) || 0;

const fail = (msg) => {
  console.error(`[publish] FAIL: ${msg}`);
  process.exit(1);
};

if (!file) fail('--file <path> is required');
if (!platform) fail('--platform <android|ios|electron|windows|mac|linux> is required');
if (!version) fail('--version <semver> is required (e.g. 1.2.3)');
if (!/^\d+\.\d+\.\d+/.test(version)) fail(`version "${version}" is not semver`);
if (!apiUrl) fail('--api-url <https://host> or BLASTI_API_URL is required');
if (!token) fail('--token <DEPLOY_TOKEN> or BLASTI_DEPLOY_TOKEN is required');

// Self-heal the paste mistakes that GitHub-secrets commonly carry (CI run
// 2026-11-01 died here with a masked "***" value): wrapping quotes,
// surrounding whitespace/newlines, a missing scheme. Healing these keeps the
// upload on HTTPS — none of them can downgrade the channel to cleartext.
if (apiUrl) {
  apiUrl = apiUrl.trim().replace(/^["']+|["']+$/g, '').trim();
  if (apiUrl && !/^[a-z][a-z0-9+.\-]*:\/\//i.test(apiUrl)) {
    apiUrl = `https://${apiUrl}`; // scheme-less host ("blastidz.online") → assume TLS
  }
}
apiUrl = apiUrl.replace(/\/+$/, '');
// STRICT-HTTPS policy: uploads carry the shared DEPLOY_TOKEN — never send it
// over a cleartext channel. Only loopback exceptions (local dev testing).
if (!/^https:\/\//i.test(apiUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(apiUrl)) {
  // Diagnosis WITHOUT leaking the secret's content (GitHub masks the value
  // itself with "***" — these structural hints still show in the log).
  const diag = [
    /^https:\/\//i.test(rawApiUrl) ? 'scheme=https' : /^http:\/\//i.test(rawApiUrl) ? 'scheme=http (explicit cleartext — not allowed)' : 'scheme=missing',
    /^\s|\s$/.test(rawApiUrl) ? 'whitespace-padded' : '',
    /^["']|["']$/.test(rawApiUrl) ? 'wrapped-in-quotes' : '',
    rawApiUrl ? '' : 'value-empty',
  ].filter(Boolean).join(', ');
  fail(
    `api-url must be https:// (got "${apiUrl}"; diagnosis: ${diag || 'no https:// prefix'}) — ` +
      `strict-HTTPS policy refuses to send the deploy token over plain HTTP. ` +
      `Fix the BLASTI_API_URL repo secret to exactly: https://your-domain`,
  );
}
try {
  if (!statSync(file).isFile()) fail(`--file is not a regular file: ${file}`);
} catch {
  fail(`--file does not exist: ${file}`);
}

// ─── Upload ─────────────────────────────────────────────────────────────────

const uploadUrl = `${apiUrl}/api/app-versions/upload?create=1`;
console.log(`[publish] uploading ${basename(file)} (${platform} v${version}) -> ${uploadUrl}`);

// NO RETRIES (deliberate): retry loops with backoff burned GitHub Actions
// free-plan minutes on persistent failures. One attempt, fail fast — if a
// transient network error ("fetch failed") kills the run, just re-run the
// job from the Actions tab; the upload is idempotent (binary replaced).
// 401/404/413 fail fast as well (they will never succeed on a retry anyway).

try {
  const buf = readFileSync(file);
  const form = new FormData();
  form.append('file', new Blob([buf]), basename(file));
  form.append('platform', platform);
  form.append('version', version);
  form.append('create', '1');
  if (versionCode > 0) form.append('versionCode', String(versionCode));
  if (notes) form.append('releaseNotes', notes.slice(0, 2000));

  // Large binaries: give the transfer time (APKs ~50 MB, desktop 80-120 MB).
  const res = await fetch(
    uploadUrl,
    {
      method: 'POST',
      headers: { 'x-deploy-token': token },
      body: form,
    },
  );

  const text = await res.text();
  let body = {};
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON error page */
  }

  if (res.ok && body.success) {
    const v = body.version ?? {};
    console.log(
      `[publish] OK — version record ${v.id ?? '?'} updated (${v.platform} v${v.version})` +
        `, size ${((buf.length / (1024 * 1024)) | 0)} MB, sha256 ${body.fileInfo?.hash?.slice(0, 12) ?? '?'}…`
    );
    console.log('[publish] it is a DRAFT — activate it in Admin -> Public Apps Settings');

    // ── DELTA UPDATES (0.6.30) — attach reference artifacts ──────────────────
    // When the CI job also produced release refs (make-release-refs.mjs), push
    // them so the cloud can build the differential patch vs the previous
    // release: --asar + --outref + --runtime-key + --native-fingerprint.
    // 0.6.56 — FIELD ROOT CAUSE of "every update is a full installer": a
    // failed refs upload used to be a WARN and the run stayed green, so
    // versions shipped WITHOUT delta refs for months (no-deltas-published on
    // 0.6.53→0.6.55). Refs are now MANDATORY when the artifact exists — a
    // failure fails the publish and the operator sees it same-day.
    if (args.asar || args.outref) {
      try {
        const refForm = new FormData();
        if (args.asar) {
          refForm.append('asar', new Blob([readFileSync(String(args.asar))]), 'app.asar');
        }
        if (args.outref) {
          refForm.append('outref', new Blob([readFileSync(String(args.outref))]), 'outref.bin');
        }
        if (args['runtime-key']) refForm.append('runtimeKey', String(args['runtime-key']));
        if (args['native-fingerprint']) refForm.append('nativeFingerprint', String(args['native-fingerprint']));
        const refRes = await fetch(
          `${apiUrl}/api/app-versions/${v.id}/release-refs`,
          {
            method: 'POST',
            headers: { 'x-deploy-token': token },
            body: refForm,
          },
        );
        const refText = await refRes.text();
        let refBody = {};
        try { refBody = JSON.parse(refText); } catch { /* non-JSON */ }
        if (refRes.ok && refBody.success) {
          const gen = Array.isArray(refBody.deltaGeneration) ? refBody.deltaGeneration : [];
          if (gen.length > 0) {
            for (const g of gen) {
              if (g.ok) {
                console.log(`[publish] delta v${g.from} → v${g.to} generated (${((g.size || 0) / 1048576).toFixed(2)} MB)`);
              } else if (g.reason === 'runtime-key-changed' || g.reason === 'native-bits-changed') {
                console.log(`[publish] delta v${g.from} → v${g.to} skipped BY DESIGN (${g.reason}) — full installer is the correct path for that hop`);
              } else {
                console.warn(`[publish] WARN: delta v${g.from} → v${g.to} refused (${g.reason}) — run scripts/regenerate-deltas.mjs after fixing the base version's refs`);
              }
            }
          } else {
            console.log(`[publish] delta refs attached (generation result: ${JSON.stringify(refBody.deltaGeneration ?? {})})`);
          }
        } else {
          // 0.6.56 — FATAL: shipping without refs silently downgrades every
          // client to full installers until someone notices the storage
          // manifest months later. Fail now with the exact remediation.
          fail(`delta refs upload failed (HTTP ${refRes.status}) — refusing to publish without delta refs. ` +
            `Fix and re-run: check the token, the API storage volume and ${args.asar ? 'asar path ' + args.asar : ''}${args.outref ? ' outref path ' + args.outref : ''}. ` +
            `Raw response: ${refText.slice(0, 300)}`);
        }
      } catch (err) {
        if (err && /delta refs upload failed/.test(String(err?.message ?? err))) throw err;
        fail(`delta refs upload error: ${err?.message ?? err}`);
      }
    }

    process.exit(0);
  }

  if (res.status === 401) {
    fail(`auth rejected (401): the token does not match DEPLOY_TOKEN on the server`);
  }
  fail(`upload failed: HTTP ${res.status} ${text.slice(0, 300)}`);
} catch (err) {
  fail(`upload error: ${err?.message ?? err}`);
}
