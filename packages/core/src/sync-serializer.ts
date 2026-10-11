/**
 * @blasti/core — Sync Serializer
 *
 * Serialization / deserialization for cloud transport, record hashing,
 * and queue state transition validation.
 *
 * Phase 4 — BLASTI Database Architecture Upgrade
 */

import {
  SyncModelConfig,
  QUEUE_STATE_TRANSITIONS,
  DATE_FIELDS,
} from './sync-registry'

// ─── ISO Date Regex ───────────────────────────────────────────────────────────

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/

// ─── Boolean Field Detection ──────────────────────────────────────────────────

/** Fields known to be Boolean in the Prisma schema that don't follow naming patterns. */
const BOOLEAN_FIELDS = new Set([
  'reminderSent', 'smsReminderSent', 'syncConflict', 'skippedForNoShow',
  'fixedTimeEnabled',
])

function isBooleanField(key: string): boolean {
  return key.startsWith('is') || key.endsWith('Enabled') || BOOLEAN_FIELDS.has(key)
}

// ─── Serialize for Cloud ──────────────────────────────────────────────────────

/**
 * Serialize a record for cloud transport.
 *
 * - Removes local-only fields (syncVersion, syncedAt, syncConflict, etc.)
 * - Normalizes dates to ISO strings
 * - Converts SQLite booleans (0/1) to true/false
 */
export function serializeForCloud(
  config: SyncModelConfig,
  record: Record<string, any>,
): Record<string, any> {
  const result: Record<string, any> = {}

  for (const [key, value] of Object.entries(record)) {
    // Skip local-only fields
    if (config.localOnlyFields.includes(key)) continue

    // Date normalization: numeric ms or Date → ISO string
    if (config.dateFields.includes(key) && value != null) {
      if (typeof value === 'number') {
        result[key] = new Date(value).toISOString()
      } else if (value instanceof Date) {
        result[key] = value.toISOString()
      } else {
        result[key] = value // already ISO string or other
      }
      continue
    }

    // Boolean normalization: SQLite 0/1 → true/false
    if (isBooleanField(key) && (value === 0 || value === 1)) {
      result[key] = value === 1
      continue
    }

    result[key] = value
  }

  return result
}

// ─── Deserialize from Cloud ───────────────────────────────────────────────────

/**
 * Deserialize a record received from cloud.
 *
 * - Removes cloud-only fields
 * - Normalizes dates to ISO strings (Prisma SQLite stores DateTime as TEXT)
 * - Converts booleans from true/false to 0/1 for SQLite compatibility
 */
export function deserializeFromCloud(
  config: SyncModelConfig,
  record: Record<string, any>,
): Record<string, any> {
  const result: Record<string, any> = {}

  for (const [key, value] of Object.entries(record)) {
    // Skip cloud-only fields
    if (config.cloudOnlyFields.includes(key)) continue

    // Date normalization: ISO string or Date → ISO string (Prisma stores as TEXT)
    if (config.dateFields.includes(key) && value != null) {
      if (typeof value === 'string' && ISO_DATE_RE.test(value)) {
        result[key] = value
      } else if (value instanceof Date) {
        result[key] = value.toISOString()
      } else {
        result[key] = value
      }
      continue
    }

    // Boolean normalization: true/false → 1/0 for SQLite
    if (isBooleanField(key) && typeof value === 'boolean') {
      result[key] = value ? 1 : 0
      continue
    }

    result[key] = value
  }

  return result
}

// ─── Record Hash ──────────────────────────────────────────────────────────────

/**
 * Compute a deterministic hash of a record for change detection.
 *
 * Uses the SubtleCrypto API (available in Node.js ≥ 15 and all browsers)
 * to produce a SHA-256 hex digest. Falls back to a simple string-hash
 * when SubtleCrypto is not available (e.g., older Node or restricted env).
 *
 * The hash is computed over a JSON-serialization of the record with keys
 * sorted for determinism.
 */
export async function computeRecordHash(
  record: Record<string, any>,
): Promise<string> {
  // Deterministic JSON — sort keys
  const canonical = JSON.stringify(record, Object.keys(record).sort())

  // Try SubtleCrypto
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const data = new TextEncoder().encode(canonical)
    const hashBuf = await crypto.subtle.digest('SHA-256', data)
    const hashArr = new Uint8Array(hashBuf)
    return Array.from(hashArr)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  }

  // Fallback: simple FNV-1a hash → hex string
  let hash = 0x811c9dc5 // FNV offset basis
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) // FNV prime
  }
  // Convert to unsigned 32-bit and hex
  return (hash >>> 0).toString(16).padStart(8, '0')
}

// ─── Sync-date-aware hash (synchronous) ───────────────────────────────────────

/**
 * Synchronous deterministic hash for change detection.
 *
 * Uses FNV-1a on a canonical JSON string (keys sorted).
 * Suitable for environments where async crypto is inconvenient.
 */
export function computeRecordHashSync(record: Record<string, any>): string {
  const canonical = JSON.stringify(record, Object.keys(record).sort())
  let hash = 0x811c9dc5
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

// ─── Queue State Transition Validation ────────────────────────────────────────

/**
 * Check if a state transition is valid for queue operations.
 *
 * @param fromState Current reservation status
 * @param toState   Desired reservation status
 * @returns true if the transition is allowed
 */
export function isValidQueueTransition(fromState: string, toState: string): boolean {
  const allowed = QUEUE_STATE_TRANSITIONS[fromState]
  if (!allowed) return false
  return allowed.includes(toState)
}

// ─── Generic Date Field Detection ─────────────────────────────────────────────

/**
 * Check whether a field name is a known date field across any model.
 * Useful for generic serialization when you don't have a SyncModelConfig handy.
 */
export function isDateField(fieldName: string): boolean {
  return DATE_FIELDS.has(fieldName)
}

/**
 * Normalize a date value to ISO string for SQLite/Prisma compatibility.
 * Returns the input unchanged if it's not a recognized date.
 */
export function normalizeDateValue(value: unknown): unknown {
  if (value == null) return value
  if (typeof value === 'number') return new Date(value).toISOString()
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string' && ISO_DATE_RE.test(value)) return value
  return value
}
