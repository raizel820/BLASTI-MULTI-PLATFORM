/**
 * BLASTI Desktop — Device Install Telemetry (Public App Settings rebuild)
 *
 * PURPOSE
 *   Real install/update tracking for the admin "Public App Settings" screen:
 *     • ONE stable fingerprint per physical machine → a machine NEVER counts
 *       twice, no matter how many times it updates or reinstalls.
 *     • A per-install UUID (regenerated on fresh install) lets the cloud
 *       DETECT uninstall→reinstall cycles without inflating device counts.
 *     • Every launch registers + every 6h a heartbeat keeps the device
 *       "active" and delivers pushed updates (mandatory/optional) back to
 *       the shell (via the existing 'update:available' IPC event).
 *
 * FINGERPRINT STABILITY CONTRACT
 *   The fingerprint is sha256(osPlatform + OS machine id):
 *     • Windows : HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid (reg query)
 *     • macOS   : IOPlatformUUID (ioreg)
 *     • Linux   : /etc/machine-id → /var/lib/dbus/machine-id
 *   All three are OS-level identities that survive app updates AND
 *   uninstall→reinstall of BLASTI. Failure to read them falls back to a
 *   hostname+hardware hash (still far more stable than a random UUID).
 *
 * DEVICE UUID
 *   Stored in <userData>/app-device-identity.json. App UPDATES keep userData,
 *   so the UUID persists (→ UPDATE event). A fresh install starts empty and
 *   generates a new UUID (→ REINSTALL event in the cloud, installCount += 1).
 *
 * TRANSPORT
 *   POST <cloud>/api/app-installs/register — PUBLIC endpoint (pre-login ok).
 *   Electron 42 ships Node ≥ 20 → global fetch is available.
 *   Everything here is fire-and-forget: telemetry can NEVER block startup,
 *   login, or the window.
 */

const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const HEARTBEAT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const RETRY_INTERVAL_MS = 30 * 60 * 1000; // retry register when offline
const STARTUP_DELAY_MS = 20 * 1000; // never compete with the launch gate

let registered = false;
let timer = null;
let retryTimer = null;
let lastUpdatePayload = null;

// ─── Machine identity probing ────────────────────────────────────────────────

function execTrim(cmd, args, timeoutMs = 4000) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
        resolve(err ? '' : String(stdout || '').trim());
      });
    } catch {
      resolve('');
    }
  });
}

/** OS-level machine id that survives app updates and reinstalls. */
async function readOsMachineId() {
  try {
    if (process.platform === 'win32') {
      // reg query HKLM\SOFTWARE\Microsoft\Cryptography /v MachineGuid
      const out = await execTrim('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid']);
      const m = /MachineGuid\s+REG_SZ\s+(\S+)/i.exec(out);
      if (m) return m[1];
    } else if (process.platform === 'darwin') {
      const out = await execTrim('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
      const m = /"IOPlatformUUID"\s*=\s*"([^"]+)"/i.exec(out);
      if (m) return m[1];
    } else {
      // Linux: /etc/machine-id → /var/lib/dbus/machine-id
      for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        try {
          const v = fs.readFileSync(p, 'utf8').trim();
          if (v) return v;
        } catch { /* next */ }
      }
    }
  } catch { /* fall through */ }
  return '';
}

/** sha256 hex of the machine identity — the dedupe key sent to the cloud. */
async function computeFingerprint() {
  const machineId = await readOsMachineId();
  const basis = machineId
    ? `machine-id:${process.platform}:${machineId}`
    : `fallback:${process.platform}:${os.hostname()}:${os.arch()}:${os.totalmem()}:${(os.cpus()[0] && os.cpus()[0].model) || 'cpu'}`;
  return crypto.createHash('sha256').update(basis).digest('hex');
}

// ─── Per-install identity (uuid regenerated on fresh install) ───────────────

function identityFilePath() {
  return path.join(app.getPath('userData'), 'app-device-identity.json');
}

function loadIdentity() {
  try {
    const raw = fs.readFileSync(identityFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.deviceId === 'string' && parsed.deviceId.length >= 8) {
      return parsed;
    }
  } catch { /* fresh install (or wiped userData) → new identity below */ }
  const identity = {
    deviceId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
  try {
    fs.mkdirSync(path.dirname(identityFilePath()), { recursive: true });
    fs.writeFileSync(identityFilePath(), JSON.stringify(identity, null, 2), 'utf8');
  } catch { /* read-only FS → in-memory only for this session */ }
  return identity;
}

// ─── Platform mapping (matches AppVersion.platform values) ──────────────────

function devicePlatform() {
  switch (process.platform) {
    case 'win32': return 'windows';
    case 'darwin': return 'mac';
    case 'linux': return 'linux';
    default: return 'linux';
  }
}

// ─── Cloud calls ─────────────────────────────────────────────────────────────

async function postJson(base, urlPath, body, timeoutMs = 15000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(base.replace(/\/+$/, '') + urlPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    return data || null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * One check-in (register or heartbeat). Returns the update payload when the
 * cloud says an update/push applies to this device, else null.
 */
async function checkIn(kind) {
  const base = process.env.BLASTI_CLOUD_URL || '';
  if (!base) return null;
  const identity = loadIdentity();
  const fingerprint = await computeFingerprint();

  const payload = {
    platform: devicePlatform(),
    fingerprint,
    deviceId: identity.deviceId,
    version: app.getVersion(),
    label: os.hostname(),
    osName: os.type(),
    osVersion: os.release(),
  };
  const urlPath = kind === 'register' ? '/api/app-installs/register' : '/api/app-installs/heartbeat';
  const data = await postJson(base, urlPath, payload);
  if (!data || data.success !== true) return null;

  if (kind === 'register') registered = true;
  lastUpdatePayload = data.update || null;
  return lastUpdatePayload;
}

// ─── Update delivery to the renderer ─────────────────────────────────────────

function emitUpdateAvailable(update) {
  try {
    if (!update || update.available !== true) return;
    const { BrowserWindow } = require('electron');
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    if (!win) return;
    win.webContents.send('update:available', {
      version: update.latestVersion,
      currentVersion: update.currentVersion,
      isMandatory: update.isMandatory === true,
      releaseNotes: update.releaseNotes || '',
      releaseNotesAr: update.releaseNotesAr || '',
      releaseNotesFr: update.releaseNotesFr || '',
      downloadUrl: update.downloadUrl || '',
      fileSize: update.fileSize || null,
      push: update.push || null,
    });
    console.log(`[BLASTI Telemetry] update:available delivered — ${update.currentVersion} → ${update.latestVersion}${update.isMandatory ? ' (MANDATORY)' : ''}`);
  } catch (err) {
    console.warn('[BLASTI Telemetry] emit update:available failed:', err && err.message);
  }
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

async function runOnce(kind) {
  try {
    const update = await checkIn(kind);
    if (update) emitUpdateAvailable(update);
    return !!update;
  } catch (err) {
    console.warn('[BLASTI Telemetry] check-in failed:', err && err.message);
    return false;
  }
}

function startDeviceTelemetry() {
  if (timer) return; // idempotent
  console.log('[BLASTI Telemetry] device install tracking started (cloud: ' + (process.env.BLASTI_CLOUD_URL || 'unresolved') + ')');

  // Register shortly after ready — never competes with the launch gate.
  setTimeout(() => {
    runOnce('register').then((ok) => {
      if (ok) return;
      // Offline / cloud unreachable → retry every 30 min until registered.
      retryTimer = setInterval(() => {
        runOnce('register').then((ok2) => {
          if (ok2 && retryTimer) {
            clearInterval(retryTimer);
            retryTimer = null;
          }
        });
      }, RETRY_INTERVAL_MS);
    });
  }, STARTUP_DELAY_MS);

  // Heartbeat keeps the device active + delivers pushes.
  timer = setInterval(() => {
    runOnce(registered ? 'heartbeat' : 'register');
  }, HEARTBEAT_INTERVAL_MS);
  if (timer.unref) timer.unref();
  if (retryTimer && retryTimer.unref) retryTimer.unref();
}

/** Last known update payload (for the update:install IPC handler). */
function getLastUpdatePayload() {
  return lastUpdatePayload;
}

module.exports = { startDeviceTelemetry, runOnce, getLastUpdatePayload, computeFingerprint, devicePlatform };
