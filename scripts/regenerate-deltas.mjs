#!/usr/bin/env node
/**
 * regenerate-deltas.mjs — DELTA REPAIR TOOL (0.6.56)
 *
 * FIELD INCIDENT: desktop clients on 0.6.53 received `delta: null (server
 * published no chain for this client)` with `deltaUnavailableReason:
 * "no-deltas-published"` — the AppVersionDelta table had NO rows for the
 * platform, so every update fell back to the 100+ MB full installer while the
 * differential pipeline existed end-to-end (binary-delta format, /check BFS
 * resolver, client hop applier). Root causes in the wild are always one of:
 *   • release refs (asar/outref) never uploaded for a version → deltas can't
 *     be derived (publish used to tolerate a failed refs upload with a WARN),
 *   • runtime key / native fingerprint changed between versions → generation
 *     refused by design (electron upgrade ⇒ full installer is CORRECT),
 *   • ref files deleted from storage → generation can't read the bases.
 *
 * This tool rebuilds the delta patches for the LATEST PUBLISHED version of a
 * platform by calling POST /api/app-versions/:id/regenerate-deltas (0.6.56:
 * accepts the shared DEPLOY_TOKEN via the x-deploy-token header). The latest
 * version id is resolved from the PUBLIC /check endpoint — no admin session
 * needed, which is exactly the situation on a headless VPS.
 *
 * Usage:
 *   node scripts/regenerate-deltas.mjs \
 *     --api-url https://blastidz.online \
 *     --token "$DEPLOY_TOKEN" \
 *     [--platform windows]        # default: windows
 *     [--limit N]                 # cap predecessors (1..10)
 *     [--allow-fingerprint-risk]  # force fingerprint-refused hops (0.6.59)
 *
 * Exit codes: 0 = at least one delta generated (or generation genuinely
 * impossible for a documented reason), 2 = auth/HTTP failure, 3 = versions
 * exist but every predecessor failed for an actionable reason (re-push refs).
 */

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) {
    if (a.includes('=')) {
      const [k, v] = a.slice(2).split('=');
      args[k] = v;
    } else {
      args[a.slice(2)] = process.argv[i + 1];
      i += 1;
    }
  }
}

const apiUrl = String(args['api-url'] || process.env.BLASTI_API_URL || '').replace(/\/+$/, '');
const token = String(args.token || process.env.BLASTI_DEPLOY_TOKEN || process.env.DEPLOY_TOKEN || '');
const platform = String(args.platform || 'windows');
// 0.6.58 — cap how many predecessors get hop patches (1..10). The CI
// self-heal step passes 3 so the server-side synchronous diffing stays short;
// manual repairs omit the flag and cover all 10.
const limitRaw = parseInt(String(args.limit || ''), 10);
const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(10, limitRaw) : null;
// 0.6.59 — consciously override fingerprint refusals (native-bits-changed /
// fingerprint-scope-mismatch). ROOT CAUSE CONTEXT: pre-0.6.59 fingerprints
// hashed Blasti.exe, whose embedded version resource (rcedit) changes on
// EVERY build — so no two versions could ever share a hash and every desktop
// hop was refused. That is fixed for NEW releases (v3 spec, exe excluded),
// but hops FROM older rows can never be hash-verified: their stored hashes
// include the stamped exe irreversibly. When the operator has verified that
// two releases only differ in asar/unpacked/stamp bits (normal app-code
// releases), this flag forces those hops anyway; runtime-key-changed and
// missing refs stay absolute. Every overridden hop is audited server-side.
const allowFingerprintRisk = args['allow-fingerprint-risk'] === true || String(args['allow-fingerprint-risk'] || '') === '1';

const say = (msg) => console.log(`[regenerate-deltas] ${msg}`);
const fail = (code, msg) => { console.error(`[regenerate-deltas] ERROR: ${msg}`); process.exit(code); };

if (!apiUrl) fail(2, '--api-url <URL> (or BLASTI_API_URL) is required');
if (!token) fail(2, '--token <DEPLOY_TOKEN> (or BLASTI_DEPLOY_TOKEN) is required — it is DEPLOY_TOKEN in /etc/blasti/blasti.env on the VPS');
if (!/^https:\/\//i.test(apiUrl)) fail(2, 'STRICT-HTTPS: the deploy token must never travel over plain HTTP');

async function main() {
  // 1) Resolve the latest published version id from the PUBLIC /check feed.
  // version=0.0.0 guarantees updateAvailable=true for any published release.
  say(`resolving latest published ${platform} version from ${apiUrl}/api/app-versions/check …`);
  const checkRes = await fetch(`${apiUrl}/api/app-versions/check?platform=${encodeURIComponent(platform)}&version=0.0.0`, {
    headers: { accept: 'application/json' },
  });
  const checkText = await checkRes.text();
  let check;
  try { check = JSON.parse(checkText); } catch { fail(2, `check returned non-JSON (HTTP ${checkRes.status}): ${checkText.slice(0, 200)}`); }
  if (!checkRes.ok || !check.success) fail(2, `check failed (HTTP ${checkRes.status}): ${check.error || 'unknown'}`);
  if (!check.updateAvailable || !check.downloadUrl) {
    say(`no published version newer than 0.0.0 on platform ${platform} — nothing to repair.`);
    process.exit(0);
  }
  const idMatch = /\/api\/app-versions\/([^/]+)\/download/.exec(String(check.downloadUrl || ''));
  if (!idMatch) fail(2, `could not extract the version id from downloadUrl "${check.downloadUrl}"`);
  const versionId = idMatch[1];
  say(`latest published: v${check.latestVersion} (id ${versionId}, ${((check.fileSize || 0) / 1048576).toFixed(1)} MB installer)`);

  // 2) Rebuild the hop patches.
  say(`calling regenerate-deltas (x-deploy-token${limit ? `, limit=${limit}` : ''}${allowFingerprintRisk ? ', allowFingerprintRisk=1' : ''}) …`);
  const regQuery = new URLSearchParams();
  if (limit) regQuery.set('limit', String(limit));
  if (allowFingerprintRisk) regQuery.set('allowFingerprintRisk', '1');
  const regRes = await fetch(`${apiUrl}/api/app-versions/${versionId}/regenerate-deltas${regQuery.toString() ? `?${regQuery.toString()}` : ''}`, {
    method: 'POST',
    headers: { 'x-deploy-token': token },
  });
  const regText = await regRes.text();
  let reg;
  try { reg = JSON.parse(regText); } catch { fail(2, `regenerate-deltas returned non-JSON (HTTP ${regRes.status}): ${regText.slice(0, 200)}`); }
  if (regRes.status === 401) fail(2, 'auth rejected (401): the token does not match DEPLOY_TOKEN on the server');
  if (!regRes.ok || !reg.success) fail(2, `regenerate-deltas failed (HTTP ${regRes.status}): ${reg.error || 'unknown'}`);

  // 3) Report per-predecessor outcomes with ACTIONABLE guidance.
  const results = Array.isArray(reg.results) ? reg.results : [];
  if (results.length === 0) {
    say('no forward predecessors found — nothing to generate (first release on this platform?).');
    process.exit(0);
  }
  let okCount = 0;
  let overriddenCount = 0;
  const actionable = [];
  for (const r of results) {
    if (r.ok) {
      okCount += 1;
      if (r.overridden) overriddenCount += 1;
      say(`✅ delta v${r.from} → v${r.to} generated (${((r.size || 0) / 1048576).toFixed(2)} MB)${r.overridden ? ' [fingerprint-risk OVERRIDE]' : ''}`);
      continue;
    }
    say(`❌ delta v${r.from} → v${r.to} REFUSED: ${r.reason}`);
    if (r.reason === 'missing-asar-ref' || r.reason === 'missing-outref-ref') {
      actionable.push(`v${r.from} has no release refs on the server — re-run the "push-installers" workflow (or publish-installer.mjs) so refs for that version are uploaded, then run this tool again.`);
    } else if (r.reason === 'ref-file-missing') {
      actionable.push(`the stored refs for v${r.from} were removed from storage (cleanup?) — re-push them via the push-installers workflow, then run this tool again.`);
    } else if (r.reason === 'runtime-key-changed') {
      say(`   ↳ this one is BY DESIGN and NOT overridable: the electron runtime changed between v${r.from} and v${r.to} — a full installer is the correct path for that hop.`);
    } else if (r.reason === 'native-bits-changed' || r.reason === 'fingerprint-scope-mismatch') {
      say(`   ↳ 0.6.59 context: pre-0.6.59 fingerprints hashed Blasti.exe, whose version resource changes on EVERY build — v${r.from}'s stored hash can never match a newer release's hash, so this hop cannot be automatically verified.`);
      if (!allowFingerprintRisk) {
        say(`   ↳ if v${r.from} → v${r.to} only changed app code (asar/unpacked) — the normal case — re-run with --allow-fingerprint-risk to force this hop (audited server-side).`);
      }
    } else if (r.reason === 'older-than-predecessor') {
      say(`   ↳ skipped: not a forward semver hop.`);
    } else if (String(r.reason || '').startsWith('error:')) {
      actionable.push(`generation ERRORED for v${r.from} → v${r.to}: ${r.reason} — check the VPS API logs (memory/disk/DB) and re-run this tool.`);
    }
  }

  if (okCount > 0) {
    say(`done — ${okCount}/${results.length} delta(s) generated${overriddenCount ? ` (${overriddenCount} via fingerprint-risk override)` : ''}. Desktop clients on the covered source versions now receive differential updates from /check.`);
    if (actionable.length) console.warn(`[regenerate-deltas] note: ${actionable.length} predecessor(s) still need refs re-pushed — see the ❌ lines above.`);
    process.exit(0);
  }
  if (actionable.length) {
    fail(3, `no delta could be generated — ${actionable.join(' | ')}`);
  }
  say('no delta generated, but every refusal is by-design (electron runtime changes) — full installers remain correct there.');
  say('hint: fingerprint refusals (native-bits-changed / fingerprint-scope-mismatch) CAN be forced with --allow-fingerprint-risk once you verify the two releases only differ in app-code bits.');
  process.exit(0);
}

main().catch((err) => fail(2, (err && err.message) || String(err)));
