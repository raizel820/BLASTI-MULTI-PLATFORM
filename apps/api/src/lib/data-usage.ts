// ─── data-usage.ts (Task 55-b — DataUsageEvent recorder) ─────────────────────
//
// Fire-and-forget usage ledger behind the Task 55 data-consumption analytics:
//   - the /api/* middleware in index.ts measures request/response bytes and
//     calls recordDataUsage() AFTER the response is already on the wire,
//   - lib/realtime-emit.ts records one REALTIME event per successful emit.
//
// HARD RULES (contract agent-ctx/55-data-consumption-contract.md §2.1):
//   - NEVER throws into the request path — every entry point is wrapped,
//   - buffered in memory, flushed every 5s OR at ≥200 events with a single
//     createMany; a failed flush DROPS the batch (log only) — analytics must
//     never break traffic,
//   - bytes are clamped to Math.max(0, Math.round(n)) and capped at 2e9.

import { db } from '@blasti/db'

// ─── Public types & constants ────────────────────────────────────────────────

export interface DataUsageInput {
  uploadBytes?: number
  downloadBytes?: number
  /** Normalized to WIFI | MOBILE | UNKNOWN via normalizeNetworkType. */
  networkType?: string
  /** Validated against the 6-type set; anything else falls back to 'API'. */
  trafficType?: string
  method?: string
  path?: string
  status?: number
  userId?: string | null
  agencyId?: string | null
  deviceId?: string | null
}

export const NETWORK_TYPES = ['WIFI', 'MOBILE', 'UNKNOWN'] as const
export const TRAFFIC_TYPES = ['API', 'SYNC', 'REALTIME', 'NOTIFICATIONS', 'FILES', 'UPDATES'] as const

// ─── Buffer & flush ──────────────────────────────────────────────────────────

const FLUSH_INTERVAL_MS = 5_000
const FLUSH_THRESHOLD = 200
const MAX_SINGLE_EVENT_BYTES = 2_000_000_000

const TRAFFIC_TYPE_SET = new Set<string>(TRAFFIC_TYPES)

interface QueuedEvent {
  uploadBytes: number
  downloadBytes: number
  networkType: string
  trafficType: string
  method: string | null
  path: string | null
  status: number | null
  userId: string | null
  agencyId: string | null
  deviceId: string | null
}

/** Module-level in-memory buffer, flushed on the 5s timer or at 200 events. */
const buffer: QueuedEvent[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null

function scheduleFlush(): void {
  if (flushTimer !== null) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flushNow().catch((error) => {
      console.error('[DATA-USAGE] flush timer error (batch dropped):', error)
    })
  }, FLUSH_INTERVAL_MS)
}

async function flushNow(): Promise<void> {
  if (buffer.length === 0) return
  // splice first so events arriving mid-flush go into the NEXT batch
  const batch = buffer.splice(0, buffer.length)
  try {
    await db.dataUsageEvent.createMany({ data: batch })
  } catch (error) {
    // On flush failure: DROP the batch (log only) — analytics must never
    // break traffic, and a torn write is preferable to unbounded memory.
    console.error(`[DATA-USAGE] flush failed — dropped ${batch.length} usage event(s):`, error instanceof Error ? error.message : error)
  }
}

// ─── Normalizers ─────────────────────────────────────────────────────────────

/**
 * 'wifi' | 'lan' | 'ethernet' → WIFI; 'mobile' | 'cellular' | 'cell' | 'data'
 * → MOBILE; anything else (incl. undefined/''/'unknown') → UNKNOWN.
 */
export function normalizeNetworkType(raw: string | undefined | null): 'WIFI' | 'MOBILE' | 'UNKNOWN' {
  if (!raw) return 'UNKNOWN'
  const v = String(raw).trim().toLowerCase()
  if (v === 'wifi' || v === 'lan' || v === 'ethernet') return 'WIFI'
  if (v === 'mobile' || v === 'cellular' || v === 'cell' || v === 'data') return 'MOBILE'
  return 'UNKNOWN'
}

/**
 * Path → traffic type:
 *   /api/sync/* | /api/offline-sync/* | /api/files/sync/* → SYNC
 *   /api/upload/* | /api/files/*                          → FILES
 *   /api/notifications*                                   → NOTIFICATIONS
 *   /api/app-versions*                                    → UPDATES
 *   everything else                                       → API
 * (SYNC is tested FIRST so /api/files/sync/* wins over the FILES prefix.)
 */
export function classifyTrafficType(path: string): string {
  const p = String(path ?? '')
  if (p.startsWith('/api/sync/') || p.startsWith('/api/offline-sync/') || p.startsWith('/api/files/sync/')) return 'SYNC'
  if (p.startsWith('/api/upload/') || p.startsWith('/api/files/')) return 'FILES'
  if (p.startsWith('/api/notifications')) return 'NOTIFICATIONS'
  if (p.startsWith('/api/app-versions')) return 'UPDATES'
  return 'API'
}

/** Clamp to a safe non-negative integer, capped at 2e9 per event. */
function clampBytes(n: unknown): number {
  const num = typeof n === 'number' && Number.isFinite(n) ? n : 0
  return Math.min(Math.max(0, Math.round(num)), MAX_SINGLE_EVENT_BYTES)
}

// ─── Recorder ────────────────────────────────────────────────────────────────

/** Record one usage event. FIRE-AND-FORGET: never await, never throws. */
export function recordDataUsage(input: DataUsageInput): void {
  try {
    const network = normalizeNetworkType(input.networkType)
    const requestedTraffic = typeof input.trafficType === 'string' ? input.trafficType : ''
    const traffic = TRAFFIC_TYPE_SET.has(requestedTraffic) ? requestedTraffic : 'API'
    buffer.push({
      uploadBytes: clampBytes(input.uploadBytes),
      downloadBytes: clampBytes(input.downloadBytes),
      networkType: network,
      trafficType: traffic,
      method: typeof input.method === 'string' && input.method ? input.method : null,
      path: typeof input.path === 'string' && input.path ? input.path : null,
      status: typeof input.status === 'number' && Number.isFinite(input.status) ? Math.round(input.status) : null,
      userId: typeof input.userId === 'string' && input.userId ? input.userId : null,
      agencyId: typeof input.agencyId === 'string' && input.agencyId ? input.agencyId : null,
      deviceId: typeof input.deviceId === 'string' && input.deviceId ? input.deviceId : null,
    })
    if (buffer.length >= FLUSH_THRESHOLD) {
      // Threshold flush — the timer stays armed for the next batch.
      void flushNow().catch((error) => {
        console.error('[DATA-USAGE] threshold flush error (batch dropped):', error)
      })
    } else {
      scheduleFlush()
    }
  } catch (error) {
    // A recorder bug must NEVER affect the request path — drop the event.
    console.error('[DATA-USAGE] recordDataUsage failed (event dropped):', error)
  }
}

// ─── Attribution fallback (empty agencyId claim on owner/staff tokens) ───────

interface FallbackEntry {
  agencyId: string | null
  expiresAt: number
}

const FALLBACK_TTL_MS = 60_000
const FALLBACK_CACHE_MAX = 500
const agencyFallbackCache = new Map<string, FallbackEntry>()

function cachePut(key: string, agencyId: string | null, now: number): void {
  if (agencyFallbackCache.size >= FALLBACK_CACHE_MAX) {
    // Prune expired entries first; if still full, evict oldest-inserted.
    for (const [k, v] of agencyFallbackCache) {
      if (v.expiresAt <= now) agencyFallbackCache.delete(k)
    }
    while (agencyFallbackCache.size >= FALLBACK_CACHE_MAX) {
      const oldest = agencyFallbackCache.keys().next().value
      if (oldest === undefined) break
      agencyFallbackCache.delete(oldest)
    }
  }
  agencyFallbackCache.set(key, { agencyId, expiresAt: now + FALLBACK_TTL_MS })
}

/**
 * Resolve a missing agencyId for owner/staff tokens whose JWT agencyId claim
 * is empty (60s-TTL in-memory Map cache, max 500 entries):
 *   - AGENCY_OWNER → agency by ownerId (oldest owned agency — the SAME
 *     deterministic pick the login resolver uses; ownerId is NOT @unique on
 *     Agency, so findFirst replaces the contract's findUnique sketch),
 *   - AGENCY_STAFF → agencyStaff by userId.
 * Callers MUST fire-and-forget this (part of the async record chain — never
 * awaited on the response path).
 */
export async function resolveAgencyIdFallback(role: string | null, userId: string | null): Promise<string | null> {
  if (!userId || (role !== 'AGENCY_OWNER' && role !== 'AGENCY_STAFF')) return null
  const key = `${role}:${userId}`
  const now = Date.now()
  const hit = agencyFallbackCache.get(key)
  if (hit && hit.expiresAt > now) return hit.agencyId

  let agencyId: string | null = null
  try {
    if (role === 'AGENCY_OWNER') {
      const agency = await db.agency.findFirst({
        where: { ownerId: userId },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      })
      agencyId = agency?.id ?? null
    } else {
      const staff = await db.agencyStaff.findFirst({
        where: { userId },
        select: { agencyId: true },
      })
      agencyId = staff?.agencyId ?? null
    }
  } catch (error) {
    console.error('[DATA-USAGE] agency fallback lookup failed (attributing as null):', error instanceof Error ? error.message : error)
    agencyId = null
  }
  cachePut(key, agencyId, now)
  return agencyId
}
