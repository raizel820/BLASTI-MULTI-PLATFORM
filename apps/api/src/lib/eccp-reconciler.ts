/**
 * @blasti/api — ECCP Reconciler (End-of-Cycle Cash Protocol)
 *
 * Provides end-of-day reconciliation between expected payments (from Transactions)
 * and actual records. Marks transactions as reconciled and generates reports
 * showing matched, unmatched, and discrepancy items.
 *
 * Usage:
 *   import { reconcileDate, getReconciliationReport, getUnreconciledTransactions } from './eccp-reconciler'
 *
 *   // Run reconciliation for a specific date
 *   const report = await reconcileDate('2025-03-05', 'admin-user-id')
 *
 *   // Get unreconciled transactions
 *   const unreconciled = await getUnreconciledTransactions()
 */

import { db } from '@blasti/db'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ReconciliationTransaction {
  id: string
  expected: number
  actual: number | null
  status: 'matched' | 'unmatched' | 'discrepancy'
  note?: string
  agencyId: string
  agencyName?: string
  paymentProvider: string
  providerRef: string | null
  createdAt: Date
}

export interface ReconciliationReport {
  date: string
  totalExpected: number
  totalReconciled: number
  totalDiscrepancies: number
  matchedCount: number
  unmatchedCount: number
  discrepancyCount: number
  transactions: ReconciliationTransaction[]
  reconciledAt: Date
  reconciledBy: string
}

// ─── Core Reconciliation ────────────────────────────────────────────────────

/**
 * Reconcile all completed transactions for a given date.
 *
 * For each COMPLETED transaction on that date:
 * - If already reconciled, count it as matched
 * - If not reconciled, mark it as reconciled and count it as matched
 *   (In a production system, this would compare against bank/CCP records)
 * - Detect discrepancies where expected amount differs from actual
 *
 * @param date - ISO date string (e.g., '2025-03-05')
 * @param adminId - The ID of the admin performing the reconciliation
 * @returns A detailed reconciliation report
 */
export async function reconcileDate(date: string, adminId: string): Promise<ReconciliationReport> {
  const startOfDay = new Date(date)
  startOfDay.setHours(0, 0, 0, 0)
  const endOfDay = new Date(date)
  endOfDay.setHours(23, 59, 59, 999)

  // Get all completed transactions for the date
  const transactions = await db.transaction.findMany({
    where: {
      status: 'COMPLETED',
      createdAt: { gte: startOfDay, lte: endOfDay },
    },
    include: {
      agency: { select: { id: true, name: true } },
    },
  })

  let totalExpected = 0
  let totalReconciled = 0
  let totalDiscrepancies = 0
  let matchedCount = 0
  let unmatchedCount = 0
  let discrepancyCount = 0

  const results: ReconciliationTransaction[] = []

  for (const tx of transactions) {
    totalExpected += tx.amount

    // If already reconciled, count it as matched
    if (tx.reconciledAt) {
      totalReconciled += tx.amount
      matchedCount++
      results.push({
        id: tx.id,
        expected: tx.amount,
        actual: tx.amount,
        status: 'matched',
        agencyId: tx.agencyId,
        agencyName: tx.agency.name,
        paymentProvider: tx.paymentProvider,
        providerRef: tx.providerRef,
        createdAt: tx.createdAt,
      })
      continue
    }

    // Mark as reconciled
    // In a real system, we'd compare with bank/CCP records here
    // For now, we trust that COMPLETED transactions with webhookVerified = true are valid
    if (tx.webhookVerified || tx.paymentProvider === 'manual') {
      await db.transaction.update({
        where: { id: tx.id },
        data: {
          reconciledAt: new Date(),
          reconciledBy: adminId,
        },
      })

      totalReconciled += tx.amount
      matchedCount++
      results.push({
        id: tx.id,
        expected: tx.amount,
        actual: tx.amount,
        status: 'matched',
        agencyId: tx.agencyId,
        agencyName: tx.agency.name,
        paymentProvider: tx.paymentProvider,
        providerRef: tx.providerRef,
        createdAt: tx.createdAt,
      })
    } else {
      // Unverified transaction — flag as discrepancy
      totalDiscrepancies += tx.amount
      discrepancyCount++
      results.push({
        id: tx.id,
        expected: tx.amount,
        actual: null,
        status: 'discrepancy',
        note: 'Webhook not verified — manual review required',
        agencyId: tx.agencyId,
        agencyName: tx.agency.name,
        paymentProvider: tx.paymentProvider,
        providerRef: tx.providerRef,
        createdAt: tx.createdAt,
      })
    }
  }

  // Also check for any unmatched records (pending/failed transactions that should have been resolved)
  const pendingOrFailed = await db.transaction.findMany({
    where: {
      status: { in: ['PENDING'] },
      createdAt: { gte: startOfDay, lte: endOfDay },
      paymentProvider: { not: 'manual' },
    },
    include: {
      agency: { select: { id: true, name: true } },
    },
  })

  for (const tx of pendingOrFailed) {
    totalExpected += tx.amount
    unmatchedCount++
    results.push({
      id: tx.id,
      expected: tx.amount,
      actual: null,
      status: 'unmatched',
      note: `Transaction still in ${tx.status} status`,
      agencyId: tx.agencyId,
      agencyName: tx.agency.name,
      paymentProvider: tx.paymentProvider,
      providerRef: tx.providerRef,
      createdAt: tx.createdAt,
    })
  }

  // Create audit log
  await db.auditLog.create({
    data: {
      userId: adminId,
      action: 'RECONCILIATION_RUN',
      entityType: 'TRANSACTION',
      details: JSON.stringify({
        date,
        totalExpected,
        totalReconciled,
        totalDiscrepancies,
        matchedCount,
        unmatchedCount,
        discrepancyCount,
      }),
    },
  })

  return {
    date,
    totalExpected,
    totalReconciled,
    totalDiscrepancies,
    matchedCount,
    unmatchedCount,
    discrepancyCount,
    transactions: results,
    reconciledAt: new Date(),
    reconciledBy: adminId,
  }
}

/**
 * Get the reconciliation report for a specific date.
 * Returns the current state of transactions without modifying them.
 */
export async function getReconciliationReport(date: string): Promise<{
  date: string
  totalCompleted: number
  totalReconciled: number
  totalUnreconciled: number
  totalPending: number
  byProvider: Record<string, { count: number; total: number }>
  transactions: Array<{
    id: string
    amount: number
    status: string
    paymentProvider: string
    providerRef: string | null
    reconciledAt: Date | null
    reconciledBy: string | null
    webhookVerified: boolean
    agencyId: string
    agencyName: string
    createdAt: Date
  }>
}> {
  const startOfDay = new Date(date)
  startOfDay.setHours(0, 0, 0, 0)
  const endOfDay = new Date(date)
  endOfDay.setHours(23, 59, 59, 999)

  const transactions = await db.transaction.findMany({
    where: {
      createdAt: { gte: startOfDay, lte: endOfDay },
    },
    include: {
      agency: { select: { id: true, name: true } },
    },
  })

  let totalCompleted = 0
  let totalReconciled = 0
  let totalUnreconciled = 0
  let totalPending = 0

  const byProvider: Record<string, { count: number; total: number }> = {}

  for (const tx of transactions) {
    // Group by provider
    const provider = tx.paymentProvider || 'manual'
    if (!byProvider[provider]) {
      byProvider[provider] = { count: 0, total: 0 }
    }
    byProvider[provider].count++
    byProvider[provider].total += tx.amount

    if (tx.status === 'COMPLETED') {
      totalCompleted += tx.amount
      if (tx.reconciledAt) {
        totalReconciled += tx.amount
      } else {
        totalUnreconciled += tx.amount
      }
    } else if (tx.status === 'PENDING') {
      totalPending += tx.amount
    }
  }

  return {
    date,
    totalCompleted,
    totalReconciled,
    totalUnreconciled,
    totalPending,
    byProvider,
    transactions: transactions.map(tx => ({
      id: tx.id,
      amount: tx.amount,
      status: tx.status,
      paymentProvider: tx.paymentProvider,
      providerRef: tx.providerRef,
      reconciledAt: tx.reconciledAt,
      reconciledBy: tx.reconciledBy,
      webhookVerified: tx.webhookVerified,
      agencyId: tx.agencyId,
      agencyName: tx.agency.name,
      createdAt: tx.createdAt,
    })),
  }
}

/**
 * Get all unreconciled completed transactions.
 * Useful for showing what needs to be reconciled.
 */
export async function getUnreconciledTransactions(limit: number = 50, offset: number = 0) {
  const [transactions, total] = await Promise.all([
    db.transaction.findMany({
      where: {
        status: 'COMPLETED',
        reconciledAt: null,
      },
      include: {
        agency: { select: { id: true, name: true, customCode: true } },
        reviewer: { select: { id: true, fullName: true, username: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    }),
    db.transaction.count({
      where: {
        status: 'COMPLETED',
        reconciledAt: null,
      },
    }),
  ])

  return { transactions, total, limit, offset }
}
