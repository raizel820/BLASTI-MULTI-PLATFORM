/**
 * @blasti/api — Subscription Proration (upgrade / early-renewal credit)
 *
 * When an agency with an ACTIVE subscription buys a different plan (upgrade
 * or downgrade) or renews early, the UNUSED value of the current window must
 * be credited against the new purchase — the linear, per-day fair share of
 * what was ACTUALLY paid:
 *
 *     credit = amountPaid × remainingMs / totalMs
 *     charge = max(MIN_ONLINE_CHECKOUT_AMOUNT, newPlanTotal − credit)
 *
 * Inputs (all already in the DB):
 *   - Agency.subscriptionStartsAt / subscriptionExpiresAt — the current window
 *   - the most recent settled (APPROVED|COMPLETED) SUBSCRIPTION Transaction —
 *     its amountPaid snapshot is what the agency really paid for that window
 *   - the target plan's period discounts (quarterly/semi-annual/annual/biennial)
 *
 * Fulfillment counterpart: chargily-fulfill.ts / admin approval STACK the new
 * term on top of the remaining days (base = max(now, currentExpiry)) so the
 * paid-for days are never discarded.
 */

import { db } from '@blasti/db'
import { SETTLED_TRANSACTION_STATUSES } from './enums'

/** Practical gateway minimum for an online EDAHABIA/CIB checkout (DZD). */
export const MIN_ONLINE_CHECKOUT_AMOUNT = 100

// ─── Period discounts (shared by Chargily + manual checkout paths) ──────────

/** Period discount percent for a plan + billing period (1/3/6/12/24 months). */
export function computePeriodDiscount(
  plan: { quarterlyDiscount: number; semiAnnualDiscount: number; annualDiscount: number; biennialDiscount: number },
  period: number,
): number {
  if (period === 3) return plan.quarterlyDiscount || 0
  if (period === 6) return plan.semiAnnualDiscount || 0
  if (period === 12) return plan.annualDiscount || 0
  if (period === 24) return plan.biennialDiscount || 0
  return 0
}

// ─── Upgrade credit ─────────────────────────────────────────────────────────

export interface UpgradeCreditInfo {
  /** true when the agency has an ACTIVE subscription whose expiry is in the future */
  eligible: boolean
  currentTier: string | null
  /** planName snapshot of the settled payment that paid for the current window */
  currentPlanName: string | null
  currentStartsAt: Date | null
  currentExpiresAt: Date | null
  /** Whole days left in the current window (floored, for display) */
  daysRemaining: number
  /** Total days of the current window (for display) */
  totalDays: number
  /** What the agency ACTUALLY paid for the current window (DZD) */
  paidAmount: number
  /** Linear unused value of the current window (DZD, rounded) */
  remainingValue: number
}

const NO_CREDIT: UpgradeCreditInfo = {
  eligible: false,
  currentTier: null,
  currentPlanName: null,
  currentStartsAt: null,
  currentExpiresAt: null,
  daysRemaining: 0,
  totalDays: 0,
  paidAmount: 0,
  remainingValue: 0,
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Compute the unused value of the agency's current subscription window.
 * Never throws — on any inconsistency it returns a zero credit so a broken
 * snapshot can never block a checkout.
 */
export async function computeUpgradeCredit(agencyId: string): Promise<UpgradeCreditInfo> {
  try {
    const agency = await db.agency.findUnique({
      where: { id: agencyId },
      select: {
        subscriptionStatus: true,
        subscriptionTier: true,
        subscriptionStartsAt: true,
        subscriptionExpiresAt: true,
      },
    })
    if (!agency) return NO_CREDIT

    const now = new Date()
    const expiresAt = agency.subscriptionExpiresAt
    if (agency.subscriptionStatus !== 'ACTIVE' || !expiresAt || expiresAt.getTime() <= now.getTime()) {
      return NO_CREDIT
    }

    // The settled payment that paid for the CURRENT window — the most recent
    // settled SUBSCRIPTION transaction of this agency.
    const lastSettled = await db.transaction.findFirst({
      where: {
        agencyId,
        type: 'SUBSCRIPTION',
        status: { in: [...SETTLED_TRANSACTION_STATUSES] },
      },
      orderBy: [{ reviewedAt: 'desc' }, { createdAt: 'desc' }],
      select: { amountPaid: true, priceSnapshot: true, amount: true, planName: true },
    })
    if (!lastSettled) return { ...NO_CREDIT, eligible: true, currentTier: agency.subscriptionTier, currentExpiresAt: expiresAt }

    const paidAmount = lastSettled.amountPaid ?? lastSettled.priceSnapshot ?? lastSettled.amount
    if (!paidAmount || paidAmount <= 0) {
      return { ...NO_CREDIT, eligible: true, currentTier: agency.subscriptionTier, currentExpiresAt: expiresAt }
    }

    // Window length: prefer the agency's actual startsAt→expiresAt window;
    // fall back to the "(Nm)" period snapshot (N × 30 days); else no credit.
    const startsAt = agency.subscriptionStartsAt
    let totalMs = startsAt ? expiresAt.getTime() - startsAt.getTime() : 0
    if (totalMs <= 0) {
      const periodMatch = lastSettled.planName?.match(/\((\d+)m\)$/)
      if (periodMatch) totalMs = parseInt(periodMatch[1], 10) * 30 * DAY_MS
    }
    if (totalMs <= 0) {
      return {
        ...NO_CREDIT,
        eligible: true,
        currentTier: agency.subscriptionTier,
        currentExpiresAt: expiresAt,
        paidAmount,
      }
    }

    const remainingMs = Math.max(0, expiresAt.getTime() - now.getTime())
    const remainingValue = Math.round((paidAmount * remainingMs) / totalMs)

    return {
      eligible: true,
      currentTier: agency.subscriptionTier,
      currentPlanName: lastSettled.planName,
      currentStartsAt: startsAt,
      currentExpiresAt: expiresAt,
      daysRemaining: Math.floor(remainingMs / DAY_MS),
      totalDays: Math.round(totalMs / DAY_MS),
      paidAmount,
      remainingValue,
    }
  } catch (err) {
    console.warn('[proration] credit computation failed — proceeding without credit:', err)
    return NO_CREDIT
  }
}

// ─── Charge computation ─────────────────────────────────────────────────────

export interface ProrationResult {
  /** List total of the NEW purchase after its own period discount (DZD) */
  listTotal: number
  /** Credit actually applied — capped at listTotal (DZD) */
  creditApplied: number
  /** Amount the agency is charged (DZD) */
  chargeAmount: number
  /** true when the gateway minimum lifted the charge above (listTotal − credit) */
  minimumApplied: boolean
}

/**
 * Apply the credit to the new purchase's list total and enforce the gateway
 * minimum. When the credit fully covers the purchase the charge still becomes
 * the minimum (online checkouts cannot be 0 DZD) — the quote endpoint reports
 * this transparently so the agency sees it BEFORE paying.
 */
export function applyProration(listTotal: number, remainingValue: number): ProrationResult {
  const creditApplied = Math.max(0, Math.min(remainingValue, listTotal))
  const rawCharge = listTotal - creditApplied
  const minimumApplied = rawCharge < MIN_ONLINE_CHECKOUT_AMOUNT
  const chargeAmount = minimumApplied ? MIN_ONLINE_CHECKOUT_AMOUNT : rawCharge
  return { listTotal, creditApplied, chargeAmount, minimumApplied }
}
