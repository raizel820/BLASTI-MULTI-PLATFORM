/**
 * Agencies Management — shared category/specialty helpers.
 *
 * Categories live in the AgencyCategory dictionary (slug = stable identity
 * stored in Agency.category). Specialties are per-category rows referenced
 * from Agency.specialtyIds (JSON array string — syncs as a plain string).
 */
import { db } from '@blasti/db'

export interface ResolvedSpecialty {
  id: string
  nameEn: string
  nameAr: string
  nameFr: string
}

/** Parse the Agency.specialtyIds JSON column safely. */
export function parseSpecialtyIds(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

/** Serialize an id list for the Agency.specialtyIds JSON column. */
export function serializeSpecialtyIds(ids: unknown): string {
  if (!Array.isArray(ids)) return '[]'
  const clean = Array.from(new Set(ids.filter((v): v is string => typeof v === 'string' && v.length > 0)))
  return JSON.stringify(clean)
}

/** One-shot active-specialty map for payload enrichment (table is small). */
export async function getActiveSpecialtyMap(): Promise<Map<string, ResolvedSpecialty>> {
  const rows = await db.specialty.findMany({
    where: { isActive: true },
    select: { id: true, nameEn: true, nameAr: true, nameFr: true },
  })
  return new Map(rows.map((r) => [r.id, r]))
}

/**
 * Validate a category slug for agency create/update writes.
 * Returns an error code string or null when valid.
 */
export async function categorySlugError(slug: string): Promise<string | null> {
  if (!slug || slug.length < 2 || slug.length > 40) return 'INVALID_CATEGORY'
  const cat = await db.agencyCategory.findUnique({ where: { slug }, select: { isActive: true } })
  if (!cat) return 'INVALID_CATEGORY'
  if (!cat.isActive) return 'CATEGORY_INACTIVE'
  return null
}

/**
 * Validate that every specialty id exists, is active, and belongs to the
 * given category. Returns an error code or null.
 */
export async function specialtyIdsError(categoryId: string, ids: string[]): Promise<string | null> {
  if (!ids.length) return null
  const rows = await db.specialty.findMany({
    where: { id: { in: ids } },
    select: { id: true, categoryId: true, isActive: true },
  })
  if (rows.length !== new Set(ids).size) return 'INVALID_SPECIALTY'
  if (rows.some((r) => !r.isActive || r.categoryId !== categoryId)) return 'SPECIALTY_CATEGORY_MISMATCH'
  return null
}

/** Enrich an agency row with parsed ids + resolved specialty names. */
export function attachSpecialties<T extends { specialtyIds?: string | null }>(
  row: T,
  map: Map<string, ResolvedSpecialty>,
): T & { specialtyIds: string[]; specialties: ResolvedSpecialty[] } {
  const ids = parseSpecialtyIds(row.specialtyIds)
  const specialties = ids
    .map((id) => map.get(id))
    .filter((s): s is ResolvedSpecialty => Boolean(s))
  return { ...row, specialtyIds: ids, specialties }
}
