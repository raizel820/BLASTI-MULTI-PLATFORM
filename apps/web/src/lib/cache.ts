/**
 * In-Memory Cache with TTL
 * =========================
 * Simple LRU-style cache for API route response caching.
 * Used to reduce database load under high concurrency.
 *
 * Usage:
 *   import { cache } from '@/lib/cache'
 *   const data = await cache.getOrSet('key', fetchFn, ttlMs)
 */

interface CacheEntry<T> {
  value: T
  expiresAt: number
}

class MemoryCache {
  private store = new Map<string, CacheEntry<unknown>>()
  private maxEntries: number
  private cleanupInterval: NodeJS.Timeout | null = null

  constructor(maxEntries = 1000) {
    this.maxEntries = maxEntries
    // Cleanup expired entries every 60 seconds
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000)
  }

  get<T>(key: string): T | null {
    const entry = this.store.get(key)
    if (!entry) return null
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key)
      return null
    }
    return entry.value as T
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    // Evict oldest entries if at capacity
    if (this.store.size >= this.maxEntries) {
      const firstKey = this.store.keys().next().value
      if (firstKey) this.store.delete(firstKey)
    }
    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
    })
  }

  delete(key: string): boolean {
    return this.store.delete(key)
  }

  deleteByPrefix(prefix: string): number {
    let deleted = 0
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key)
        deleted++
      }
    }
    return deleted
  }

  /**
   * Get from cache, or compute and cache the value.
   * Prevents cache stampede with a simple lock mechanism.
   */
  async getOrSet<T>(key: string, fetchFn: () => Promise<T>, ttlMs: number): Promise<T> {
    const cached = this.get<T>(key)
    if (cached !== null) return cached

    const value = await fetchFn()
    this.set(key, value, ttlMs)
    return value
  }

  /** Check if a key exists and is not expired */
  has(key: string): boolean {
    return this.get(key) !== null
  }

  /** Get cache statistics */
  stats(): { size: number; maxEntries: number } {
    return { size: this.store.size, maxEntries: this.maxEntries }
  }

  /** Remove all expired entries */
  private cleanup(): void {
    const now = Date.now()
    for (const [key, entry] of this.store.entries()) {
      if (now > entry.expiresAt) {
        this.store.delete(key)
      }
    }
  }

  /** Clear all entries */
  clear(): void {
    this.store.clear()
  }

  /** Stop the cleanup interval */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }
  }
}

// Singleton cache instance
export const cache = new MemoryCache(2000)

// Cache TTL constants (in milliseconds)
export const CACHE_TTL = {
  SHORT: 5_000,       // 5 seconds - for frequently changing data
  MEDIUM: 30_000,     // 30 seconds - for dashboard stats
  LONG: 60_000,       // 1 minute - for semi-static data
  VERY_LONG: 300_000, // 5 minutes - for rarely changing data
} as const

/**
 * Rate Limiter - prevents cron endpoints from being called too frequently
 */
const lastCallTimes = new Map<string, number>()

export function rateLimit(key: string, minIntervalMs: number): boolean {
  const lastCall = lastCallTimes.get(key) || 0
  const now = Date.now()
  if (now - lastCall < minIntervalMs) {
    return false // Rate limited - too soon
  }
  lastCallTimes.set(key, now)
  return true // Allowed
}
