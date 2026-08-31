/**
 * BLASTI ETA Calculator — Local-first, real-time ETA estimation engine
 *
 * Computes estimated wait times locally at the agency level.
 * Uses a combination of:
 *   - Agency's configured averageServiceTime as the base
 *   - Number of people ahead in the queue
 *   - Number of active counters (parallelism)
 *   - Historical variance factor for producing ranges
 *   - Confidence levels based on data availability
 *
 * The result is always an approximate range (min/max) so the UI
 * can display something like "Approx. 12–15 minutes".
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ETAResult {
  /** Minimum estimated wait in minutes */
  estimatedMinMinutes: number
  /** Maximum estimated wait in minutes */
  estimatedMaxMinutes: number
  /** Confidence level based on data quality */
  confidence: 'high' | 'medium' | 'low'
  /** How many people are ahead in the queue */
  peopleAhead: number
  /** How many counters are currently active */
  activeCounters: number
  /** Average service time in seconds */
  avgServiceTimeSeconds: number
  /** When this estimate was last computed */
  lastUpdated: Date
  /** Whether the queue is paused */
  isPaused: boolean
}

export interface ETAParams {
  /** Number of people ahead in the queue */
  peopleAhead: number
  /** Average service time in minutes (from agency config or historical data) */
  avgServiceTimeMinutes: number
  /** Number of active counters serving customers (default: 1) */
  activeCounters?: number
  /**
   * Variance factor — how much service times deviate from the average.
   *   0.0 = no variance (very consistent)
   *   1.0 = high variance (very inconsistent)
   * Default: 0.3 (30% variance — typical for queue settings)
   */
  historicalVarianceFactor?: number
  /** Whether the queue is currently paused */
  isPaused?: boolean
  /** Number of historical data points used (affects confidence) */
  historicalSampleSize?: number
}

// ─── Internal Constants ──────────────────────────────────────────────────────

/** Minimum variance factor — even with perfect data, we add a small buffer */
const MIN_VARIANCE_FACTOR = 0.1

/** Buffer minutes added to account for transitions between customers */
const TRANSITION_BUFFER_MINUTES = 0.5

/** Minimum ETA range spread in minutes (so we always show a range) */
const MIN_RANGE_SPREAD_MINUTES = 2

/** Sample size thresholds for confidence levels */
const CONFIDENCE_HIGH_THRESHOLD = 50   // ≥50 samples → high
const CONFIDENCE_MEDIUM_THRESHOLD = 10 // ≥10 samples → medium
// <10 samples → low

// ─── Main Calculation Function ───────────────────────────────────────────────

/**
 * Calculate an ETA range for a specific queue position.
 *
 * The algorithm:
 * 1. Base wait = peopleAhead × avgServiceTime / activeCounters
 * 2. Apply variance to produce min/max range
 * 3. Add transition buffer between customers
 * 4. Determine confidence based on sample size and data quality
 */
export function calculateETA(params: ETAParams): ETAResult {
  const {
    peopleAhead,
    avgServiceTimeMinutes,
    activeCounters = 1,
    historicalVarianceFactor = 0.3,
    isPaused = false,
    historicalSampleSize = 0,
  } = params

  // Phase 3d: Prevent division by zero — ensure at least 1 counter
  const safeActiveCounters = Math.max(1, activeCounters)

  const now = new Date()

  // If the queue is paused, ETA is effectively unknown/infinite
  if (isPaused) {
    return {
      estimatedMinMinutes: 0,
      estimatedMaxMinutes: 0,
      confidence: 'low',
      peopleAhead,
      activeCounters: safeActiveCounters,
      avgServiceTimeSeconds: Math.round(avgServiceTimeMinutes * 60),
      lastUpdated: now,
      isPaused: true,
    }
  }

  // If no one is ahead, the wait is essentially 0 (or very short)
  if (peopleAhead <= 0) {
    return {
      estimatedMinMinutes: 0,
      estimatedMaxMinutes: Math.max(1, Math.round(avgServiceTimeMinutes * 0.3)),
      confidence: safeActiveCounters > 0 ? 'high' : 'low',
      peopleAhead: 0,
      activeCounters: safeActiveCounters,
      avgServiceTimeSeconds: Math.round(avgServiceTimeMinutes * 60),
      lastUpdated: now,
      isPaused: false,
    }
  }

  // Clamp variance factor
  const variance = Math.max(MIN_VARIANCE_FACTOR, historicalVarianceFactor)

  // Effective parallelism: can't have more counters than people
  const effectiveCounters = Math.max(1, Math.min(safeActiveCounters, peopleAhead))

  // Base wait time in minutes (assuming parallel serving)
  // Includes time to clear the currently-being-served ticket:
  // without this, the estimate undercounts by ~1 full service slot
  // because the person currently at the counter still needs to finish.
  const baseWaitMinutes =
    ((peopleAhead * avgServiceTimeMinutes) / effectiveCounters) +
    (avgServiceTimeMinutes / effectiveCounters)

  // Add transition buffer (time between finishing one customer and starting the next)
  const transitionBuffer = Math.min(peopleAhead * TRANSITION_BUFFER_MINUTES, 5)

  // Calculate min and max using variance
  // Min uses (1 - variance/2) to be optimistic
  // Max uses (1 + variance) to be conservative
  const optimisticFactor = 1 - variance / 2
  const conservativeFactor = 1 + variance

  let estimatedMin = Math.round((baseWaitMinutes * optimisticFactor) + transitionBuffer * 0.5)
  let estimatedMax = Math.round((baseWaitMinutes * conservativeFactor) + transitionBuffer)

  // Ensure minimum spread
  if (estimatedMax - estimatedMin < MIN_RANGE_SPREAD_MINUTES) {
    const midpoint = (estimatedMin + estimatedMax) / 2
    estimatedMin = Math.max(0, Math.round(midpoint - MIN_RANGE_SPREAD_MINUTES / 2))
    estimatedMax = Math.round(midpoint + MIN_RANGE_SPREAD_MINUTES / 2)
  }

  // Ensure min is never negative and max is always >= min
  estimatedMin = Math.max(0, estimatedMin)
  estimatedMax = Math.max(estimatedMin + 1, estimatedMax)

  // Determine confidence level
  const confidence = determineConfidence(historicalSampleSize, peopleAhead, safeActiveCounters)

  return {
    estimatedMinMinutes: estimatedMin,
    estimatedMaxMinutes: estimatedMax,
    confidence,
    peopleAhead,
    activeCounters: safeActiveCounters,
    avgServiceTimeSeconds: Math.round(avgServiceTimeMinutes * 60),
    lastUpdated: now,
    isPaused: false,
  }
}

// ─── Confidence Determination ────────────────────────────────────────────────

/**
 * Determine the confidence level of an ETA estimate.
 *
 * Factors:
 * - Historical sample size (more data = higher confidence)
 * - Queue depth (very long queues = lower confidence due to compounding errors)
 * - Active counters (more counters = more parallelism = less predictable)
 */
function determineConfidence(
  sampleSize: number,
  peopleAhead: number,
  activeCounters: number,
): 'high' | 'medium' | 'low' {
  // Start with sample-size-based confidence
  let confidence: 'high' | 'medium' | 'low'

  if (sampleSize >= CONFIDENCE_HIGH_THRESHOLD) {
    confidence = 'high'
  } else if (sampleSize >= CONFIDENCE_MEDIUM_THRESHOLD) {
    confidence = 'medium'
  } else {
    confidence = 'low'
  }

  // Degrade confidence for very long queues (compounding errors)
  if (peopleAhead > 20 && confidence === 'high') {
    confidence = 'medium'
  }
  if (peopleAhead > 40) {
    confidence = 'low'
  }

  // Degrade confidence when many counters are active (more variability)
  if (activeCounters > 4 && confidence === 'high') {
    confidence = 'medium'
  }

  return confidence
}

// ─── Helper: Format ETA for display ──────────────────────────────────────────

/**
 * Format an ETAResult into a human-readable string.
 * Example: "Approx. 12–15 minutes"
 */
export function formatETA(eta: ETAResult, language: string = 'en'): string {
  if (eta.isPaused) {
    const pausedMessages: Record<string, string> = {
      en: 'Queue is paused',
      ar: 'الطابور متوقف',
      fr: 'File en pause',
    }
    return pausedMessages[language] || pausedMessages.en
  }

  if (eta.peopleAhead <= 0) {
    const nowMessages: Record<string, string> = {
      en: 'Your turn now',
      ar: 'دورك الآن',
      fr: 'Votre tour',
    }
    return nowMessages[language] || nowMessages.en
  }

  const approxMessages: Record<string, string> = {
    en: 'Approx.',
    ar: 'تقريباً',
    fr: 'Env.',
  }
  const minuteMessages: Record<string, string> = {
    en: 'minutes',
    ar: 'دقائق',
    fr: 'minutes',
  }

  const approx = approxMessages[language] || approxMessages.en
  const minutes = minuteMessages[language] || minuteMessages.en

  if (eta.estimatedMinMinutes === eta.estimatedMaxMinutes) {
    return `${approx} ${eta.estimatedMinMinutes} ${minutes}`
  }

  return `${approx} ${eta.estimatedMinMinutes}–${eta.estimatedMaxMinutes} ${minutes}`
}

/**
 * Filter out "ghost tickets" — WAITING reservations that have been waiting for
 * an abnormally long time (> maxWaitHours). These are likely no-shows or stale
 * entries that should NOT be counted toward the ETA, as they inflate the
 * peopleAhead count and skew estimates.
 *
 * Phase 3c: A reservation is considered a ghost ticket if its createdAt is
 * more than maxWaitHours ago (default: 2 hours).
 */
export function filterGhostTickets<T extends { createdAt?: Date | string | null }>(
  reservations: T[],
  maxWaitHours: number = 2,
): T[] {
  const cutoff = new Date(Date.now() - maxWaitHours * 60 * 60 * 1000)
  return reservations.filter(r => {
    if (!r.createdAt) return true // If no createdAt, keep it (conservative)
    const created = typeof r.createdAt === 'string' ? new Date(r.createdAt) : r.createdAt
    // Keep only reservations created AFTER the cutoff (i.e., not ghost tickets)
    return created >= cutoff
  })
}

/**
 * Filter out future fixed-time appointments that are outside the immediate service window.
 * These "ghost tickets" inflate the peopleAhead count and skew ETA estimates.
 */
export function filterImmediateServiceWindow<T extends { fixedTimeEnabled?: boolean; preferredTime?: string | null }>(
  reservations: T[],
  windowMinutes: number = 30
): T[] {
  const now = new Date()
  const windowEnd = new Date(now.getTime() + windowMinutes * 60 * 1000)
  const windowEndStr = windowEnd.toTimeString().slice(0, 5) // "HH:MM"
  
  return reservations.filter(r => {
    if (!r.fixedTimeEnabled) return true
    if (!r.preferredTime) return true
    // Include if the preferred time is within the immediate window
    return r.preferredTime <= windowEndStr
  })
}

// ─── Helper: Calculate variance from historical data ──────────────────────────

/**
 * Calculate the historical variance factor from a set of service durations.
 * This can be used to feed a more accurate variance factor into calculateETA.
 *
 * @param serviceTimesMs - Array of service time durations in milliseconds
 * @returns variance factor (0.0 to 1.0+)
 */
export function calculateHistoricalVariance(serviceTimesMs: number[]): number {
  if (serviceTimesMs.length < 2) return 0.3 // default

  const mean = serviceTimesMs.reduce((sum, t) => sum + t, 0) / serviceTimesMs.length
  const variance = serviceTimesMs.reduce((sum, t) => sum + Math.pow(t - mean, 2), 0) / serviceTimesMs.length
  const stdDev = Math.sqrt(variance)

  // Coefficient of variation (CV) — normalized measure of dispersion
  const cv = mean > 0 ? stdDev / mean : 0.3

  // Clamp to reasonable bounds
  return Math.max(0.05, Math.min(1.0, cv))
}

// ─── Helper: Get effective average service time from recent history ────────────

/**
 * Compute an effective average service time from historical completed reservations.
 * Falls back to the agency's configured averageServiceTime if no history is available.
 *
 * @param completedReservations - Array of completed reservations with calledAt and completedAt
 * @param fallbackAvgMinutes - Agency's configured averageServiceTime
 * @returns Object with avgMinutes, sampleSize, and varianceFactor
 */
export function getEffectiveServiceTime(
  completedReservations: Array<{ calledAt: Date | null; completedAt: Date | null; joinedAt: Date }>,
  fallbackAvgMinutes: number,
): { avgMinutes: number; sampleSize: number; varianceFactor: number } {
  // Filter to reservations with valid timestamps
  const validTimes = completedReservations.filter(
    (r) => r.calledAt && r.completedAt,
  )

  if (validTimes.length === 0) {
    return { avgMinutes: fallbackAvgMinutes, sampleSize: 0, varianceFactor: 0.3 }
  }

  // Calculate service durations (calledAt → completedAt)
  const serviceDurationsMs = validTimes.map((r) => {
    return r.completedAt!.getTime() - r.calledAt!.getTime()
  })

  // ── Trimmed Mean (5% trim) — removes outlier durations caused by ──
  // staff forgetting to close tickets (e.g., lunch breaks, 3-hour gaps).
  // This prevents a single corrupted sample from destroying accuracy.
  const sortedDurations = [...serviceDurationsMs].sort((a, b) => a - b)

  // Trim 5% from top and bottom to remove extreme outliers
  const trimCount = Math.max(1, Math.floor(sortedDurations.length * 0.05))

  // Only trim if we have enough data (> 10 records)
  let validDurations = sortedDurations
  if (sortedDurations.length > 10) {
    validDurations = sortedDurations.slice(trimCount, sortedDurations.length - trimCount)
  }

  // Calculate trimmed average
  const avgMs = validDurations.reduce((a, b) => a + b, 0) / validDurations.length
  const avgMinutes = avgMs / 60000

  // Calculate variance from trimmed set
  const varianceFactor = calculateHistoricalVariance(validDurations)

  return {
    avgMinutes: Math.max(1, Math.round(avgMinutes * 10) / 10),
    sampleSize: validTimes.length,
    varianceFactor,
  }
}
