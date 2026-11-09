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
  say('calling regenerate-deltas (x-deploy-token) …');
  const regRes = await fetch(`${apiUrl}/api/app-versions/${versionId}/regenerate-deltas`, {
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
  const actionable = [];
  for (const r of results) {
    if (r.ok) {
      okCount += 1;
      say(`✅ delta v${r.from} → v${r.to} generated (${((r.size || 0) / 1048576).toFixed(2)} MB)`);
      continue;
    }
    say(`❌ delta v${r.from} → v${r.to} REFUSED: ${r.reason}`);
    if (r.reason === 'missing-asar-ref' || r.reason === 'missing-outref-ref') {
      actionable.push(`v${r.from} has no release refs on the server — re-run the "push-installers" workflow (or publish-installer.mjs) so refs for that version are uploaded, then run this tool again.`);
    } else if (r.reason === 'ref-file-missing') {
      actionable.push(`the stored refs for v${r.from} were removed from storage (cleanup?) — re-push them via the push-installers workflow, then run this tool again.`);
    } else if (r.reason === 'runtime-key-changed' || r.reason === 'native-bits-changed') {
      say(`   ↳ this one is BY DESIGN: electron runtime / native bits changed between v${r.from} and v${r.to} — a full installer is the correct path for that hop.`);
    } else if (r.reason === 'older-than-predecessor') {
      say(`   ↳ skipped: not a forward semver hop.`);
    }
  }

  if (okCount > 0) {
    say(`done — ${okCount}/${results.length} delta(s) generated. Desktop clients on the covered source versions now receive differential updates from /check.`);
    if (actionable.length) console.warn(`[regenerate-deltas] note: ${actionable.length} predecessor(s) still need refs re-pushed — see the ❌ lines above.`);
    process.exit(0);
  }
  if (actionable.length) {
    fail(3, `no delta could be generated — ${actionable.join(' | ')}`);
  }
  say('no delta generated, but every refusal is by-design (runtime/native changes) — full installers remain correct there.');
  process.exit(0);
}

main().catch((err) => fail(2, (err && err.message) || String(err)));
