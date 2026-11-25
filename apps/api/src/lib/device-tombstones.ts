/**
 * device-tombstones.ts — deleted-device fingerprint blocklist (0.6.119).
 * ─────────────────────────────────────────────────────────────────────────────
 * Cloud twin of apps/desktop/local-api/lib/device-tombstones.js.
 *
 * When a manager deletes a device, the physical device keeps its stable
 * fingerprint and keeps re-announcing (beacon + 10s discover-register retry).
 * Every register route used to CREATE a fresh row on fingerprint miss, so a
 * deleted device resurrected itself within seconds — the "ghost kiosk"
 * pattern in the field logs (cmwu9l… / cmwubl… / cmwubmn… batches).
 *
 * Tombstones persist in SystemSetting key 'deleted_device_fingerprints'
 * (JSON map fingerprint → meta), guarded by a 5s in-process cache. Every
 * CREATE path (discover-register, /public/register) answers
 * 409 DEVICE_REMOVED_BY_MANAGER for tombstoned fingerprints; pairing accept,
 * manager-initiated pairing and POST /tombstones/clear lift the block.
 */

import { db } from '@blasti/db'

const TOMBSTONE_KEY = 'deleted_device_fingerprints'
const CACHE_MS = 5_000
const MAX_TOMBSTONES = 1000

export interface DeviceTombstone {
  fingerprint: string
  deletedAt: string
  name?: string
  type?: string
  ipAddress?: string
  agencyId?: string
}

type TombstoneMap = Map<string, DeviceTombstone>

let cache: { map: TombstoneMap; at: number } | null = null

function normalizeFp(fp: string): string {
  return typeof fp === 'string' ? fp.trim() : ''
}

function parseMap(raw: string | null | undefined): TombstoneMap {
  const map: TombstoneMap = new Map()
  if (!raw) return map
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      for (const [fp, meta] of Object.entries(parsed)) {
        if (fp && meta && typeof meta === 'object') map.set(fp, meta as DeviceTombstone)
      }
    }
  } catch { /* corrupted value — start empty */ }
  return map
}

async function loadTombstones(): Promise<TombstoneMap> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.map
  try {
    const row = await db.systemSetting.findUnique({ where: { key: TOMBSTONE_KEY } })
    const map = parseMap(row?.value)
    cache = { map, at: Date.now() }
    return map
  } catch {
    return cache?.map || new Map()
  }
}

async function persistTombstones(map: TombstoneMap): Promise<void> {
  // Cap: drop the oldest entries when the blocklist grows unbounded.
  while (map.size > MAX_TOMBSTONES) {
    let oldest: DeviceTombstone | null = null
    for (const t of map.values()) {
      if (!oldest || String(t.deletedAt) < String(oldest.deletedAt)) oldest = t
    }
    if (!oldest) break
    map.delete(oldest.fingerprint)
  }
  const value = JSON.stringify(Object.fromEntries(map))
  try {
    const existing = await db.systemSetting.findUnique({ where: { key: TOMBSTONE_KEY }, select: { id: true } })
    if (existing) {
      await db.systemSetting.update({ where: { key: TOMBSTONE_KEY }, data: { value, valueType: 'json' } })
    } else {
      await db.systemSetting.create({
        data: {
          key: TOMBSTONE_KEY,
          value,
          valueType: 'json',
          category: 'devices',
          description: 'Deleted-device fingerprint blocklist (0.6.119 ghost-device fix)',
        },
      })
    }
    cache = { map, at: Date.now() }
  } catch {
    cache = null // force a fresh read next time
  }
}

/** True when the manager deleted this fingerprint and it must not re-register. */
export async function isDeviceTombstoned(fingerprint: string): Promise<boolean> {
  const fp = normalizeFp(fingerprint)
  if (!fp) return false
  return (await loadTombstones()).has(fp)
}

/** Record a deliberate manager deletion. */
export async function addDeviceTombstone(fingerprint: string, meta: Partial<DeviceTombstone> = {}): Promise<void> {
  const fp = normalizeFp(fingerprint)
  if (!fp) return
  const map = await loadTombstones()
  const live = new Map(map)
  live.set(fp, {
    fingerprint: fp,
    deletedAt: new Date().toISOString(),
    name: meta.name ? String(meta.name).slice(0, 100) : undefined,
    type: meta.type ? String(meta.type).slice(0, 20) : undefined,
    ipAddress: meta.ipAddress ? String(meta.ipAddress).slice(0, 64) : undefined,
    agencyId: meta.agencyId ? String(meta.agencyId) : undefined,
  })
  await persistTombstones(live)
}

/** Manager re-paired the device (accept/create) or explicitly unblocked it. */
export async function clearDeviceTombstone(fingerprint: string): Promise<boolean> {
  const fp = normalizeFp(fingerprint)
  if (!fp) return false
  const map = await loadTombstones()
  if (!map.has(fp)) return false
  const live = new Map(map)
  live.delete(fp)
  await persistTombstones(live)
  return true
}

/** All tombstones, newest first (the /unpaired strip renders these). */
export async function listDeviceTombstones(): Promise<DeviceTombstone[]> {
  const map = await loadTombstones()
  return [...map.values()].sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)))
}
