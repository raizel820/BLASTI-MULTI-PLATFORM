// ─── response-cache.ts (Performance Round — 2-core ARM VPS) ──────────────────
//
// Two complementary layers for cutting request volume, payload size and DB
// load on the production VPS (Oracle Ampere 2 vCPU / 12 GB):
//
//   1. publicCacheMiddleware — TTL response cache for hot PUBLIC GET
//      endpoints (landing stats, agency directory, FAQs, app versions …).
//      Tag-based invalidation + single-flight stampede protection + bounded
//      LRU (500 entries / ~a few MB) so memory stays predictable.
//
//   2. conditionalGetMiddleware — generic ETag layer for EVERY /api/* GET
//      response: computes a weak ETag over the JSON body, stamps a correct
//      Cache-Control (public+max-age for anonymous traffic, private+no-cache
//      for authenticated traffic) and answers If-None-Match with a 304.
//      Browsers, Capacitor WebViews, Electron and the service worker all
//      honor this natively → pollers that re-read unchanged data now cost
//      ~200 bytes instead of the full payload, and anonymous pollers skip
//      the request entirely while max-age is valid.
//
// HARD RULES:
//   - Only 2xx JSON GET responses are cached/etagged — mutations, streams,
//     redirects and errors always pass through untouched.
//   - Responses carrying Set-Cookie are never etagged (unsafe to cache).
//   - The layer is fully self-healing: every entry carries a TTL, so a
//     missed invalidation can only ever serve data for one TTL window.
// ─────────────────────────────────────────────────────────────────────────────

import type { MiddlewareHandler } from 'hono'
import { createHash } from 'crypto'

// ─── Store ───────────────────────────────────────────────────────────────────

interface CacheEntry {
  status: number
  body: string
  contentType: string
  createdAt: number
  expiresAt: number
  etag: string
  tags: string[]
}

const MAX_ENTRIES = 300

/** Insertion-ordered Map → cheapest possible LRU (delete+set on touch). */
const store = new Map<string, CacheEntry>()

/** key → in-flight computation (single-flight / stampede protection). */
const inflight = new Map<string, Promise<CacheEntry>>()

/** tag → Set of cache keys (O(1)-ish tag invalidation). */
const tagIndex = new Map<string, Set<string>>()

function keyFor(c: { req: { method: string; url: string } }): string {
  // Full URL (path + query) — method is always GET for callers.
  return c.req.url
}

function indexTags(key: string, tags: string[]): void {
  for (const tag of tags) {
    let set = tagIndex.get(tag)
    if (!set) {
      set = new Set()
      tagIndex.set(tag, set)
    }
    set.add(key)
  }
}

function unindexTags(key: string, tags: string[]): void {
  for (const tag of tags) {
    const set = tagIndex.get(tag)
    if (set) {
      set.delete(key)
      if (set.size === 0) tagIndex.delete(tag)
    }
  }
}

function evictIfNeeded(): void {
  while (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value
    if (oldest === undefined) break
    const entry = store.get(oldest)
    store.delete(oldest)
    if (entry) unindexTags(oldest, entry.tags)
  }
}

function storeEntry(key: string, entry: CacheEntry): void {
  // Refresh insertion position → LRU behavior on get-or-set.
  const existing = store.get(key)
  if (existing) unindexTags(key, existing.tags)
  store.delete(key)
  evictIfNeeded()
  store.set(key, entry)
  indexTags(key, entry.tags)
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Invalidate every cached response carrying ANY of the given tags. */
export function invalidateResponseCacheTag(...tags: string[]): number {
  let deleted = 0
  for (const tag of tags) {
    const keys = tagIndex.get(tag)
    if (!keys) continue
    for (const key of keys) {
      const entry = store.get(key)
      store.delete(key)
      if (entry) unindexTags(key, entry.tags)
      deleted++
    }
  }
  return deleted
}

/** Drop the whole response cache (deploy hooks, admin actions). */
export function clearResponseCache(): void {
  store.clear()
  tagIndex.clear()
}

/** Introspection for /api/system + the admin dashboard. */
export function responseCacheStats(): { entries: number; inflight: number; tags: number } {
  return { entries: store.size, inflight: inflight.size, tags: tagIndex.size }
}

// ─── ETag helpers ────────────────────────────────────────────────────────────

/** Weak ETag (16 hex chars of sha1 — collision-safe for response bodies). */
function makeEtag(body: string): string {
  return `W/"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"`
}

function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false
  if (ifNoneMatch.trim() === '*') return true
  // Client may echo the weak prefix or not — compare the opaque part too.
  const opaque = etag.replace(/^W\//, '')
  return ifNoneMatch
    .split(',')
    .map((t) => t.trim())
    .some((t) => t === etag || t === opaque)
}

function isJsonResponse(res: Response): boolean {
  return (res.headers.get('content-type') ?? '').includes('application/json')
}

/**
 * Build the Cache-Control value for a GET response:
 *   - anonymous  → `public, max-age=N` (browser may skip the request while
 *                  fresh — the single biggest poller-request reducer),
 *   - authed     → `private, no-cache` (always revalidate via ETag → 304).
 * `no-store` wins if the route already set it.
 */
function cacheControlFor(hasAuth: boolean, maxAgeSeconds: number): string {
  return hasAuth
    ? 'private, no-cache'
    : `public, max-age=${Math.max(0, Math.min(maxAgeSeconds, 60))}`
}

function hasAuthContext(c: { req: { header: (n: string) => string | undefined } }): boolean {
  if (c.req.header('authorization')) return true
  // Session-cookie auth (web browser, credentials:'include') — the exact
  // names lib/auth.ts issues (NextAuth-compatible, plain + __Secure- variants).
  const cookie = c.req.header('cookie') ?? ''
  return /(?:^|;\s*)(?:__Secure-)?next-auth\.session-token=/.test(cookie)
}

// ─── Layer 2: generic conditional-GET middleware ─────────────────────────────

/**
 * Mount ONCE for /api/* (after rate limiting, before routes). Every 2xx JSON
 * GET response gets a weak ETag + Cache-Control and honors If-None-Match
 * with a bodyless 304. Non-JSON, non-GET, error and Set-Cookie responses
 * pass through untouched.
 */
export const conditionalGetMiddleware: MiddlewareHandler = async (c, next) => {
  await next()

  // Only successful JSON GETs are candidates.
  if (c.req.method !== 'GET') return
  const res = c.res
  if (res.status !== 200 || !isJsonResponse(res)) return
  // Respect explicit cache decisions made upstream (routes/SSE/streaming).
  if (res.headers.has('etag') || res.headers.has('cache-control')) return
  if (res.headers.get('set-cookie')) return
  // Never touch bodies we cannot buffer cheaply (None for JSON, but guard
  // against null-body 2xx like 204 which is not JSON anyway).

  let body: string
  try {
    body = await res.text()
  } catch {
    return // streaming/consumed body — leave the response untouched
  }

  const etag = makeEtag(body)
  const headers = new Headers(res.headers)
  headers.set('ETag', etag)
  headers.set('Cache-Control', cacheControlFor(hasAuthContext(c), 10))
  headers.delete('Content-Length') // recomputed per representation

  if (etagMatches(c.req.header('if-none-match'), etag)) {
    const notModified = new Headers()
    notModified.set('ETag', etag)
    notModified.set('Cache-Control', headers.get('Cache-Control') ?? '')
    c.res = new Response(null, { status: 304, headers: notModified })
    return
  }

  c.res = new Response(body, { status: res.status, statusText: res.statusText, headers })
}

// ─── Layer 1: public TTL response cache ──────────────────────────────────────

export interface PublicCacheOptions {
  /** Cache lifetime in ms (browser max-age is capped at 60s regardless). */
  ttlMs: number
  /** Invalidation tags — call invalidateResponseCacheTag(tag) on mutations. */
  tags?: string[]
  /**
   * Skip the cache when the request carries an Authorization header or a
   * session cookie (default true — authed callers always get fresh data).
   */
  bypassForAuthed?: boolean
}

/**
 * TTL cache for hot PUBLIC GET endpoints. Mount on the exact paths you want
 * cached. Cached responses keep their original headers, gain the layer's
 * ETag and honor If-None-Match (304) — a hit costs zero DB queries.
 */
export function publicCacheMiddleware(opts: PublicCacheOptions): MiddlewareHandler {
  const ttl = Math.max(1_000, opts.ttlMs)
  const tags = opts.tags ?? []
  const bypassForAuthed = opts.bypassForAuthed !== false

  return async (c, next) => {
    if (c.req.method !== 'GET') {
      await next()
      return
    }
    if (bypassForAuthed && hasAuthContext(c)) {
      await next()
      return
    }

    const key = keyFor(c)
    const now = Date.now()

    const hit = store.get(key)
    if (hit && hit.expiresAt > now) {
      // LRU touch
      store.delete(key)
      store.set(key, hit)
      const headers = new Headers({
        'Content-Type': hit.contentType,
        ETag: hit.etag,
        'Cache-Control': cacheControlFor(false, Math.floor(ttl / 1000)),
        'X-Cache': 'HIT',
      })
      if (etagMatches(c.req.header('if-none-match'), hit.etag)) {
        c.res = new Response(null, { status: 304, headers: new Headers({ ETag: hit.etag, 'Cache-Control': headers.get('Cache-Control') ?? '' }) })
        return
      }
      c.res = new Response(hit.body, { status: hit.status, headers })
      return
    }

    // Single-flight: identical concurrent GETs share one computation. If the
    // shared computation turned out uncacheable (error/4xx path), fall
    // through and execute normally — dedup only pays off for 200 JSON.
    const pending = inflight.get(key)
    if (pending) {
      let shared: CacheEntry | null = null
      try {
        shared = await pending
      } catch {
        shared = null
      }
      if (shared && shared.expiresAt > 0) {
        const hitHeaders = new Headers({
          'Content-Type': shared.contentType,
          ETag: shared.etag,
          'Cache-Control': cacheControlFor(false, Math.floor(ttl / 1000)),
          'X-Cache': 'HIT',
        })
        if (etagMatches(c.req.header('if-none-match'), shared.etag)) {
          c.res = new Response(null, { status: 304, headers: new Headers({ ETag: shared.etag, 'Cache-Control': hitHeaders.get('Cache-Control') ?? '' }) })
          return
        }
        c.res = new Response(shared.body, { status: shared.status, headers: hitHeaders })
        return
      }
      // Shared computation was not cacheable — run this request normally.
      await next()
      return
    }

    const computation = (async (): Promise<CacheEntry> => {
      await next()
      const res = c.res
      if (res.status !== 200 || !isJsonResponse(res) || res.headers.get('set-cookie')) {
        // Do not cache — pass through with the conditional-GET layer's headers.
        return {
          status: res.status,
          body: '',
          contentType: 'application/json',
          createdAt: now,
          expiresAt: 0, // 0 → never stored
          etag: '',
          tags: [],
        }
      }
      const body = await res.text()
      const entry: CacheEntry = {
        status: res.status,
        body,
        contentType: res.headers.get('content-type') ?? 'application/json',
        createdAt: now,
        expiresAt: Date.now() + ttl,
        etag: makeEtag(body),
        tags,
      }
      // Stamp ETag + Cache-Control onto the live response too.
      const headers = new Headers(res.headers)
      headers.set('ETag', entry.etag)
      headers.set('Cache-Control', cacheControlFor(false, Math.floor(ttl / 1000)))
      headers.set('X-Cache', 'MISS')
      headers.delete('Content-Length')
      if (etagMatches(c.req.header('if-none-match'), entry.etag)) {
        c.res = new Response(null, { status: 304, headers: new Headers({ ETag: entry.etag, 'Cache-Control': headers.get('Cache-Control') ?? '' }) })
      } else {
        c.res = new Response(body, { status: res.status, statusText: res.statusText, headers })
      }
      return entry
    })()

    inflight.set(key, computation)
    try {
      const entry = await computation
      if (entry.expiresAt > 0) storeEntry(key, entry)
    } finally {
      inflight.delete(key)
    }
  }
}
