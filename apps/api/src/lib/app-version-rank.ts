/**
 * Shared "latest AppVersion" ranking — r20-3 (a).
 *
 * ROOT CAUSE this fixes: "latest published" rows were selected with
 * `orderBy: [{ versionCode: 'desc' }, ...]`, but CI-published rows carry
 * versionCode 0 (CI uploads never pass --version-code) while admin-created
 * rows can have versionCode > 0. An OLD admin row (code 5000) therefore
 * permanently outranked a NEWER CI build (code 0), so devices were told
 * "you are up to date" forever and pushes were suppressed with it.
 *
 * THE FIX: every CONSUMER-facing "latest" selection ranks rows with
 * versionRank():
 *   • versionCode > 0 → use it (Android convention, trustworthy ordering)
 *   • versionCode 0/missing → derive the rank from the semantic version name
 *     "X.Y.Z" (tolerating "X.Y") → X*1_000_000 + Y*1_000 + Z
 * so a CI build of 0.6.25 (code 0) outranks an admin row of 0.6.21
 * (code 6021) by name, while properly coded rows keep numeric ordering.
 */

/** "X.Y.Z" (also tolerates "X.Y" and extra suffixes) → X*1_000_000 + Y*1_000 + Z. */
export function semanticRank(versionName: string): number {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(versionName || '').trim())
  if (!m) return 0
  const x = parseInt(m[1], 10) || 0
  const y = m[2] ? parseInt(m[2], 10) || 0 : 0
  const z = m[3] ? parseInt(m[3], 10) || 0 : 0
  return x * 1_000_000 + y * 1_000 + z
}

/**
 * Rank an AppVersion row: numeric versionCode when meaningful (> 0),
 * otherwise the rank derived from the semantic version name.
 */
export function versionRank(versionCode: number | null | undefined, versionName: string): number {
  const code = typeof versionCode === 'number' && Number.isFinite(versionCode) ? versionCode : 0
  return code > 0 ? code : semanticRank(versionName)
}

/** Minimal shape the picker needs (Prisma AppVersion rows satisfy it). */
export interface RankableVersion {
  version: string
  versionCode?: number | null
}

/**
 * Pick the LATEST row from an already-fetched list. Ties (equal rank) keep
 * the earlier element, so callers should pass rows newest-first
 * (orderBy createdAt desc) and the newest row wins a tie.
 */
export function pickLatestAppVersion<T extends RankableVersion>(rows: T[]): T | null {
  let best: T | null = null
  let bestRank = -1
  for (const row of rows) {
    const rank = versionRank(row.versionCode, row.version)
    if (rank > bestRank) {
      best = row
      bestRank = rank
    }
  }
  return best
}
