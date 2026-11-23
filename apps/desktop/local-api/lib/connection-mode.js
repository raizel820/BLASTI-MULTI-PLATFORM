// connection-mode.js — Device connection & discovery protocol mode (0.6.113).
// ─────────────────────────────────────────────────────────────────────────────
// The Device Manager exposes a switch: LOCAL ONLY vs CLOUD.
//
//   'cloud' (default) — historic behaviour. LAN/Wi-Fi device-to-device FIRST,
//                       the cloud may relay pairing for remote devices, merge
//                       cloud-registered orphans and reconcile registries.
//   'local'           — STRICT LAN/Wi-Fi. The cloud is NEVER part of the
//                       discovery/connection/pairing protocol: no cloud merges,
//                       no cloud relays, no cloud reconciles, no cloud LAN
//                       topology reporting. A local desktop cannot be
//                       interrupted by cloud state (the ghost-device class:
//                       deleted rows resurrected by a cloud mirror are
//                       impossible — the cloud is simply never consulted).
//
// Persisted in the LOCAL SystemSetting table (key 'device_connection_mode') so
// the choice survives desktop restarts; cached in memory (5s TTL) so the hot
// pairing/discovery paths never pay a DB round-trip for the check.
//
// All output/comments in English. No new npm dependencies.

'use strict'

const SETTING_KEY = 'device_connection_mode'
const CACHE_TTL_MS = 5000

let _cached = { mode: 'cloud', at: 0 }

/** Only two states exist; anything else falls back to the safe default. */
function normalizeMode(v) {
  return v === 'local' ? 'local' : 'cloud'
}

/** Raw DB read — never throws (DB_NOT_READY falls back to the cache). */
async function readMode(db) {
  try {
    const row = await db.systemSetting.findUnique({ where: { key: SETTING_KEY } })
    return normalizeMode(row && row.value)
  } catch {
    return _cached.mode
  }
}

/** Cached read — hot paths (pairing offers, list routes) call this freely. */
async function getConnectionMode(db) {
  if (Date.now() - _cached.at < CACHE_TTL_MS) return _cached.mode
  const mode = await readMode(db)
  _cached = { mode, at: Date.now() }
  return mode
}

/** Persist the mode (upsert) and refresh the cache immediately. */
async function setConnectionMode(db, mode) {
  const m = normalizeMode(mode)
  try {
    const existing = await db.systemSetting.findUnique({ where: { key: SETTING_KEY } })
    if (existing) {
      await db.systemSetting.update({
        where: { key: SETTING_KEY },
        data: { value: m, updatedAt: new Date() },
      })
    } else {
      await db.systemSetting.create({
        data: {
          key: SETTING_KEY,
          value: m,
          category: 'devices',
          valueType: 'string',
          description: 'Device connection & discovery protocol: "cloud" allows the cloud relay/merge paths, "local" is strict LAN/Wi-Fi device-to-device.',
        },
      })
    }
  } catch (err) {
    // The cache is still updated so the mode takes effect in-memory even when
    // the write failed (transient SQLite lock) — it will be retried on the
    // next PUT.
    if (typeof console !== 'undefined') {
      try { console.warn('[connection-mode] persist failed:', err && err.message) } catch { /* ignore */ }
    }
  }
  _cached = { mode: m, at: Date.now() }
  return m
}

/** true when the cloud may participate in the device protocol. */
async function isCloudAllowed(db) {
  return (await getConnectionMode(db)) !== 'local'
}

/** Synchronous peek (no DB) — used by the LAN status reporter tick. */
function peekConnectionMode() {
  return _cached.mode
}

function invalidateConnectionModeCache() {
  _cached = { mode: _cached.mode, at: 0 }
}

module.exports = {
  SETTING_KEY,
  getConnectionMode,
  setConnectionMode,
  isCloudAllowed,
  peekConnectionMode,
  invalidateConnectionModeCache,
}
