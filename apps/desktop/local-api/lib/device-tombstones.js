/**
 * device-tombstones.js — deleted-device fingerprint blocklist (0.6.119).
 * ─────────────────────────────────────────────────────────────────────────────
 * ROOT FIX for "ghost kiosk devices cannot be deleted — they come back":
 *
 * When a manager deletes a device, the physical device on the LAN keeps its
 * stable fingerprint and keeps re-announcing (beacon + 10s discover-register
 * retry). Every register route used to CREATE a fresh row on fingerprint
 * miss, so a deleted device resurrected itself within seconds — the manager
 * deleted, the ghost reappeared, and the DELETE loop in the field logs
 * (cmwu9l… → cmwubl… → cmwubmn… batches) never ended.
 *
 * A tombstone records "the manager deliberately removed this fingerprint".
 * Every CREATE path (discover-register, /public/register) checks it and
 * answers 409 DEVICE_REMOVED_BY_MANAGER instead of minting a row; the
 * desktop↔cloud reconcile also refuses to re-mirror tombstoned fingerprints.
 * Legitimate re-pairing (manager-initiated pairing request, pairing accept,
 * manual create) CLEARS the tombstone — and the manager can explicitly
 * unblock a fingerprint from the unpaired strip ("allow re-discovery").
 *
 * Storage: one small JSON file next to the other ~/.blasti state (no schema
 * change, no migration; the file is written synchronously and rarely).
 */

'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

const MAX_TOMBSTONES = 1000

const tombstones = new Map() // fingerprint → { fingerprint, deletedAt, name, type, ipAddress, agencyId }
let loaded = false
let dirty = false

function storePath() {
  const dir = path.join(os.homedir(), '.blasti')
  return path.join(dir, 'deleted-device-fingerprints.json')
}

function normalizeFp(fp) {
  return typeof fp === 'string' ? fp.trim() : ''
}

function load() {
  if (loaded) return
  loaded = true
  try {
    const raw = fs.readFileSync(storePath(), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      for (const [fp, meta] of Object.entries(parsed)) {
        if (fp && meta && typeof meta === 'object') tombstones.set(fp, meta)
      }
    }
  } catch { /* first run / unreadable — start empty */ }
}

function save() {
  try {
    const dir = path.dirname(storePath())
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(storePath(), JSON.stringify(Object.fromEntries(tombstones)), 'utf8')
    dirty = false
  } catch { /* best-effort persistence */ }
}

/** Record a deliberate manager deletion (meta carries name/type/ip for UI). */
function addDeviceTombstone(fingerprint, meta = {}) {
  const fp = normalizeFp(fingerprint)
  if (!fp) return false
  load()
  tombstones.set(fp, {
    fingerprint: fp,
    deletedAt: new Date().toISOString(),
    name: typeof meta.name === 'string' ? meta.name.slice(0, 100) : undefined,
    type: typeof meta.type === 'string' ? meta.type.slice(0, 20) : undefined,
    ipAddress: typeof meta.ipAddress === 'string' ? meta.ipAddress.slice(0, 64) : undefined,
    agencyId: typeof meta.agencyId === 'string' ? meta.agencyId : undefined,
  })
  // Cap: drop the oldest entries when the blocklist grows unbounded.
  while (tombstones.size > MAX_TOMBSTONES) {
    const oldest = [...tombstones.values()].sort((a, b) => String(a.deletedAt).localeCompare(String(b.deletedAt)))[0]
    if (!oldest) break
    tombstones.delete(oldest.fingerprint)
  }
  dirty = true
  save()
  return true
}

/** True when the manager deleted this fingerprint and it must not re-register. */
function isDeviceTombstoned(fingerprint) {
  const fp = normalizeFp(fingerprint)
  if (!fp) return false
  load()
  return tombstones.has(fp)
}

/** Manager re-paired the device (accept/create) or explicitly unblocked it. */
function clearDeviceTombstone(fingerprint) {
  const fp = normalizeFp(fingerprint)
  if (!fp) return false
  load()
  const had = tombstones.delete(fp)
  if (had) { dirty = true; save() }
  return had
}

/** All tombstones, newest first (the unpaired strip renders these). */
function listDeviceTombstones() {
  load()
  return [...tombstones.values()].sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)))
}

module.exports = {
  addDeviceTombstone,
  isDeviceTombstoned,
  clearDeviceTombstone,
  listDeviceTombstones,
}
