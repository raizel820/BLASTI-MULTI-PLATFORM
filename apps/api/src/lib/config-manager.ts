/**
 * @blasti/api — Configuration Manager
 *
 * Database-backed dynamic configuration with in-memory LRU cache.
 * Auto-encrypts/decrypts sensitive values stored in SystemSetting.
 *
 * Features:
 * - In-memory cache with 5-minute TTL for fast reads
 * - Auto-encrypt on write, auto-decrypt on read for `encrypted` entries
 * - Type-safe getter helpers (number, boolean, JSON)
 * - Category-based grouping
 * - Cache invalidation (single key or full flush)
 */

import { db } from '@blasti/db'
import { encrypt, decrypt } from './encryption'

// ─── Cache ─────────────────────────────────────────────────────────────────

interface CacheEntry {
  value: string
  encrypted: boolean
  expiresAt: number
}

const cache = new Map<string, CacheEntry>()
const CACHE_TTL = 5 * 60 * 1000 // 5 minutes

function isExpired(entry: CacheEntry): boolean {
  return Date.now() > entry.expiresAt
}

// ─── Core Getters ──────────────────────────────────────────────────────────

/**
 * Get a single configuration value by key.
 * Automatically decrypts if the value is stored encrypted.
 * Returns null if the key doesn't exist.
 */
export async function getConfig(key: string): Promise<string | null> {
  const cached = cache.get(key)
  if (cached && !isExpired(cached)) {
    return cached.encrypted ? decrypt(cached.value) : cached.value
  }

  const setting = await db.systemSetting.findUnique({ where: { key } })
  if (!setting) return null

  cache.set(key, {
    value: setting.value,
    encrypted: setting.encrypted,
    expiresAt: Date.now() + CACHE_TTL,
  })

  return setting.encrypted ? decrypt(setting.value) : setting.value
}

/**
 * Get a configuration value as a number.
 * Returns `defaultValue` if the key doesn't exist or the value is not a valid number.
 */
export async function getConfigNumber(key: string, defaultValue: number = 0): Promise<number> {
  const raw = await getConfig(key)
  if (raw === null) return defaultValue
  const parsed = Number(raw)
  return isNaN(parsed) ? defaultValue : parsed
}

/**
 * Get a configuration value as a boolean.
 * Recognizes: "true", "1", "yes" as true; everything else as false.
 * Returns `defaultValue` if the key doesn't exist.
 */
export async function getConfigBoolean(key: string, defaultValue: boolean = false): Promise<boolean> {
  const raw = await getConfig(key)
  if (raw === null) return defaultValue
  return ['true', '1', 'yes'].includes(raw.toLowerCase())
}

/**
 * Get a configuration value as parsed JSON.
 * Returns `defaultValue` if the key doesn't exist or the value is not valid JSON.
 */
export async function getConfigJSON<T = unknown>(key: string, defaultValue: T): Promise<T> {
  const raw = await getConfig(key)
  if (raw === null) return defaultValue
  try {
    return JSON.parse(raw) as T
  } catch {
    return defaultValue
  }
}

/**
 * Get all configuration values in a category as a key-value record.
 * Automatically decrypts encrypted values.
 */
export async function getConfigByCategory(category: string): Promise<Record<string, string>> {
  const settings = await db.systemSetting.findMany({ where: { category } })
  const result: Record<string, string> = {}
  for (const s of settings) {
    // Update cache
    cache.set(s.key, {
      value: s.value,
      encrypted: s.encrypted,
      expiresAt: Date.now() + CACHE_TTL,
    })
    result[s.key] = s.encrypted ? decrypt(s.value) : s.value
  }
  return result
}

/**
 * Get all configuration values as a key-value record.
 * Automatically decrypts encrypted values.
 */
export async function getAllConfig(): Promise<Record<string, string>> {
  const settings = await db.systemSetting.findMany()
  const result: Record<string, string> = {}
  for (const s of settings) {
    // Update cache
    cache.set(s.key, {
      value: s.value,
      encrypted: s.encrypted,
      expiresAt: Date.now() + CACHE_TTL,
    })
    result[s.key] = s.encrypted ? decrypt(s.value) : s.value
  }
  return result
}

// ─── Core Setters ──────────────────────────────────────────────────────────

interface SetConfigOptions {
  encrypted?: boolean
  category?: string
  description?: string
  valueType?: string  // string, number, boolean, json
}

/**
 * Create or update a configuration setting.
 * Automatically encrypts the value if `options.encrypted` is true.
 * Invalidates the cache for the given key.
 */
export async function setConfig(key: string, value: string, options: SetConfigOptions = {}): Promise<void> {
  const { encrypted = false, category = 'general', description = '', valueType = 'string' } = options
  const storedValue = encrypted ? encrypt(value) : value

  await db.systemSetting.upsert({
    where: { key },
    create: {
      key,
      value: storedValue,
      encrypted,
      category,
      description,
      valueType,
    },
    update: {
      value: storedValue,
      encrypted,
      category,
      description,
      valueType,
    },
  })

  // Invalidate cache for this key
  cache.delete(key)
}

/**
 * Delete a configuration setting by key.
 * Invalidates the cache for the given key.
 * Returns true if the setting was found and deleted, false otherwise.
 *
 * Note: Uses raw SQL to bypass the Ghost Delete Trap extension which has a
 * compatibility issue with Prisma Client Extensions' `query` parameter.
 * System settings don't need tombstones for offline sync.
 */
export async function deleteConfig(key: string): Promise<boolean> {
  try {
    // Check if the setting exists first
    const setting = await db.systemSetting.findUnique({ where: { key } })
    if (!setting) return false

    // Use raw SQL to bypass the Ghost Delete Trap (SystemSetting doesn't need tombstones)
    await db.$executeRaw`DELETE FROM system_settings WHERE id = ${setting.id}`
    cache.delete(key)
    return true
  } catch {
    return false
  }
}

// ─── Cache Management ──────────────────────────────────────────────────────

/**
 * Invalidate the cache for a specific key, or flush the entire cache
 * if no key is provided.
 */
export function invalidateCache(key?: string): void {
  if (key) {
    cache.delete(key)
  } else {
    cache.clear()
  }
}

/**
 * Get raw setting records (with metadata) for admin display.
 * Encrypted values are masked, not decrypted.
 */
export async function getAllSettingsRaw(): Promise<Array<{
  id: string
  key: string
  value: string
  encrypted: boolean
  category: string
  description: string
  valueType: string
  updatedAt: Date
  createdAt: Date
}>> {
  return db.systemSetting.findMany({ orderBy: [{ category: 'asc' }, { key: 'asc' }] })
}

/**
 * Get a single raw setting record (with metadata) for admin display.
 * Encrypted values are NOT decrypted.
 */
export async function getSettingRaw(key: string): Promise<{
  id: string
  key: string
  value: string
  encrypted: boolean
  category: string
  description: string
  valueType: string
  updatedAt: Date
  createdAt: Date
} | null> {
  return db.systemSetting.findUnique({ where: { key } })
}

/**
 * Get all distinct categories.
 */
export async function getSettingCategories(): Promise<string[]> {
  const results = await db.systemSetting.findMany({
    select: { category: true },
    distinct: ['category'],
    orderBy: { category: 'asc' },
  })
  return results.map(r => r.category)
}

/**
 * Bulk update multiple settings at once.
 * Each entry can specify encrypted flag; value is auto-encrypted if so.
 */
export async function bulkSetConfig(entries: Array<{
  key: string
  value: string
  encrypted?: boolean
  category?: string
  description?: string
  valueType?: string
}>): Promise<void> {
  for (const entry of entries) {
    await setConfig(entry.key, entry.value, {
      encrypted: entry.encrypted,
      category: entry.category,
      description: entry.description,
      valueType: entry.valueType,
    })
  }
}
