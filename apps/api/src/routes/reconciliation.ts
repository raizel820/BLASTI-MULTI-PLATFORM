/**
 * @blasti/api — Reconciliation Admin Routes
 *
 * Admin-only endpoints for ECCP (End-of-Cycle Cash Protocol) reconciliation.
 * All routes require SUPER_ADMIN authentication.
 *
 * Routes:
 *   POST /api/reconciliation/run          — Run reconciliation for a date
 *   GET  /api/reconciliation/report/:date  — Get reconciliation report for a date
 *   GET  /api/reconciliation/unreconciled  — List unreconciled transactions
 */

import { Hono } from 'hono'
import { requireAdmin, authErrorResponse } from '../lib/auth'
import { reconcileDate, getReconciliationReport, getUnreconciledTransactions } from '../lib/eccp-reconciler'

const app = new Hono()

// ─── POST /run — Run reconciliation for a date ────────────────────────

app.post('/run', async (c) => {
  try {
    const admin = await requireAdmin(c)
    const body = await c.req.json()

    if (!body.date) {
      return c.json({ success: false, error: 'Date is required (YYYY-MM-DD format)' }, 400)
    }

    // Validate date format
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/
    if (!dateRegex.test(body.date)) {
      return c.json({ success: false, error: 'Invalid date format. Use YYYY-MM-DD' }, 400)
    }

    const report = await reconcileDate(body.date, admin.id)

    return c.json({ success: true, data: report })

  } catch (error) {
    const err = authErrorResponse(error)
    if (err.status === 401 || err.status === 403) {
      return c.json({ success: false, error: err.error }, err.status as 400)
    }
    console.error('[reconciliation] Error running reconciliation:', error)
    return c.json({ success: false, error: 'Reconciliation failed' }, 500)
  }
})

// ─── GET /report/:date — Get reconciliation report ────────────────────

app.get('/report/:date', async (c) => {
  try {
    const admin = await requireAdmin(c)
    const date = c.req.param('date')

    // Validate date format
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/
    if (!dateRegex.test(date)) {
      return c.json({ success: false, error: 'Invalid date format. Use YYYY-MM-DD' }, 400)
    }

    const report = await getReconciliationReport(date)

    return c.json({ success: true, data: report })

  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: false, error: err.error }, err.status as 400)
  }
})

// ─── GET /unreconciled — List unreconciled transactions ───────────────

app.get('/unreconciled', async (c) => {
  try {
    const admin = await requireAdmin(c)
    const limit = parseInt(c.req.query('limit') || '50', 10)
    const offset = parseInt(c.req.query('offset') || '0', 10)

    const result = await getUnreconciledTransactions(limit, offset)

    return c.json({ success: true, data: result })

  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: false, error: err.error }, err.status as 400)
  }
})

export const reconciliationRoutes = app
