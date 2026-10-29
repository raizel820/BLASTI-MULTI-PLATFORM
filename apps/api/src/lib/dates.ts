// ─── dates.ts (R-6d — Africa/Algiers date primitives) ────────────────────────
//
// WHY THIS EXISTS
// Algeria sits at UTC+01:00 ALL YEAR — it has had no daylight-saving time
// since 1981. The platform's business day ("today", reservedDate buckets,
// analytics day buckets, cron sweeps) is defined by the Algiers wall clock,
// but most of the API previously derived 'YYYY-MM-DD' keys from
// `toISOString()` (UTC) or from the SERVER's local timezone. Both are wrong:
//   - UTC shifts the day boundary by one hour (a ticket booked at 00:30 in
//     Algiers lands on "yesterday" in UTC).
//   - server-local time depends on where the API happens to be deployed.
// Every helper here pins the bucket key to Africa/Algiers via Intl (never
// DST-ambiguous because there is no DST to begin with), while the underlying
// storage stays UTC instants (DateTime columns) and plain 'YYYY-MM-DD'
// strings (reservedDate).
//
// CONVENTIONS
//   - Date keys are 'YYYY-MM-DD' strings (DB column Reservation.reservedDate
//     is a plain string column) — lexicographic comparison == date order.
//   - Hour keys are 'YYYY-MM-DDTHH' (same shape as utcHourKey).
//   - `algiersDayStartUtc(key)` converts an Algiers calendar day to the UTC
//     instant its 00:00 wall clock begins (23:00 UTC the previous day).

/** IANA zone the platform buckets business days by (fixed +01:00, no DST). */
export const ALGIERS_TZ = 'Africa/Algiers'

/** Algeria is UTC+01:00 year-round (no DST) — used for cheap instant math. */
export const ALGIERS_UTC_OFFSET_MINUTES = 60

// en-CA formats as ISO-like YYYY-MM-DD; the formatter is module-level because
// Intl.DateTimeFormat construction is expensive relative to formatting.
const algiersDateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: ALGIERS_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

const algiersMonthFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: ALGIERS_TZ,
  year: 'numeric',
  month: '2-digit',
})

const algiersHourFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: ALGIERS_TZ,
  hour: '2-digit',
  hourCycle: 'h23',
})

/** The current instant (alias for readability at bucket call sites). */
export function algiersNow(): Date {
  return new Date()
}

/** 'YYYY-MM-DD' of `d` as seen on the Algiers wall clock. */
export function algiersDateKey(d: Date = algiersNow()): string {
  return algiersDateFmt.format(d)
}

/** 'YYYY-MM' of `d` as seen on the Algiers wall clock. */
export function algiersMonthKey(d: Date = algiersNow()): string {
  return algiersMonthFmt.format(d)
}

/** 'YYYY-MM-DDTHH' of `d` as seen on the Algiers wall clock (h23). */
export function algiersHourKey(d: Date = algiersNow()): string {
  return `${algiersDateKey(d)}T${algiersHourFmt.format(d)}`
}

/** JS weekday (0 = Sunday … 6 = Saturday) of `d` on the Algiers wall clock. */
export function algiersWeekday(d: Date = algiersNow()): number {
  return new Date(d.getTime() + ALGIERS_UTC_OFFSET_MINUTES * 60 * 1000).getUTCDay()
}

/**
 * UTC instant at which the Algiers calendar day `dateKey` ('YYYY-MM-DD')
 * begins. With no DST, every Algiers day is exactly 24h long, so the day's
 * end is `start + 24h - 1ms`.
 */
export function algiersDayStartUtc(dateKey: string): Date {
  return new Date(`${dateKey}T00:00:00+01:00`)
}

/**
 * "Today" on the Algiers wall clock — the canonical value to compare against
 * the Reservation.reservedDate string column (reminder/no-show sweeps,
 * targetDate validation, callable-date filters).
 */
export function algiersTodayKey(): string {
  return algiersDateKey(algiersNow())
}
