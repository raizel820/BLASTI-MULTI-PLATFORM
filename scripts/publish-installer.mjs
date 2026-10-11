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
let apiUrl = args['api-url'] || process.env.BLASTI_API_URL || '';
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

apiUrl = apiUrl.replace(/\/+$/, '');
try {
  if (!statSync(file).isFile()) fail(`--file is not a regular file: ${file}`);
} catch {
  fail(`--file does not exist: ${file}`);
}

// ─── Upload ─────────────────────────────────────────────────────────────────

const uploadUrl = `${apiUrl}/api/app-versions/upload?create=1`;
console.log(`[publish] uploading ${basename(file)} (${platform} v${version}) -> ${uploadUrl}`);

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
  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'x-deploy-token': token },
    body: form,
  });

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
    process.exit(0);
  }

  if (res.status === 401) {
    fail(`auth rejected (401): the token does not match DEPLOY_TOKEN on the server`);
  }
  fail(`upload failed: HTTP ${res.status} ${text.slice(0, 300)}`);
} catch (err) {
  fail(`upload error: ${err?.message ?? err}`);
}
