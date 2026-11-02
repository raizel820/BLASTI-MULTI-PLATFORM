/**
 * BLASTI Desktop — Client Attestation builder (0.6.48)
 *
 * Shared by BOTH trusted desktop surfaces:
 *   - apps/desktop/main.js        → ipcMain.handle('blasti:attest') for the
 *                                   renderer's request pipeline (x-blasti-attest
 *                                   header on every API request).
 *   - apps/desktop/local-api/     → the embedded local API signs its cloud
 *     index.js cloudLoginProxy      login proxy itself (pre-0.6.48 builds
 *                                   dropped the platform identity there,
 *                                   which made the cloud mint 'web' JWTs).
 *
 * The HMAC secret lives ONLY inside the desktop app — never in the shared
 * web bundle — so a plain browser cannot forge the desktop identity.
 * Format + verification mirror apps/api/src/lib/client-attestation.ts.
 */

const crypto = require('crypto');

// Rotate in production: set BLASTI_ATTEST_SECRET_DESKTOP at build/packaging
// time (env) AND on the VPS. The dev fallback is public by design.
const DESKTOP_ATTEST_SECRET = process.env.BLASTI_ATTEST_SECRET_DESKTOP ||
  'blasti-attest-desktop-dev-key-rotate-in-production';

function buildDesktopAttestation() {
  const platform = 'desktop';
  const tsMs = Date.now().toString();
  const nonce = crypto.randomBytes(12).toString('hex');
  const sig = crypto
    .createHmac('sha256', DESKTOP_ATTEST_SECRET)
    .update(`${platform}|${tsMs}|${nonce}`)
    .digest('hex');
  return `v1.${platform}.${tsMs}.${nonce}.${sig}`;
}

module.exports = { buildDesktopAttestation, DESKTOP_ATTEST_SECRET };
