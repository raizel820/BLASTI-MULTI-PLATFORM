import { Hono } from 'hono'
import { db } from '@blasti/db'
import { enforceRateLimit, PUBLIC_RATE_LIMIT, isRateLimitError, rateLimitErrorResponse, recordSuccessfulRequest, recordFailedRequest } from '../lib/rate-limit'

const app = new Hono()

// GET /stats — Public platform stats
app.get('/', async (c) => {
  let clientIp: string | undefined
  try {
    clientIp = enforceRateLimit(c, PUBLIC_RATE_LIMIT)

    const [totalAgencies, totalCustomers, totalReservations, activeQueues] = await Promise.all([
      db.agency.count({ where: { isActive: true } }),
      db.user.count({ where: { role: 'CUSTOMER' } }),
      db.reservation.count(),
      db.agency.count({ where: { isQueueOpen: true } }),
    ])

    if (clientIp) recordSuccessfulRequest(clientIp)

    return c.json({ totalAgencies, totalCustomers, totalReservations, activeQueues })
  } catch (error: unknown) {
    if (isRateLimitError(error)) {
      // Rate limiting IS the punishment — a 429 must NOT also feed the
      // abuse blocker (10 failures/5min → 30-min IP lockout), otherwise a
      // single burst locks a legitimate user out of every public route.
      // Genuine business 4xxs (400/404) below still record failures.
      const res = rateLimitErrorResponse(error)
      return c.json(res.data, res.status as any)
    }
    console.error('[STATS] Error fetching public stats:', error)
    const message = error instanceof Error ? error.message : 'Internal server error'
    return c.json({ error: 'Failed to fetch stats', details: message }, 500)
  }
})

export const statsRoutes = app
