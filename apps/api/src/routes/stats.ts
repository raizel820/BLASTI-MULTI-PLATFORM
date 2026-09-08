import { Hono } from 'hono'
import { cloudDb } from '@blasti/cloud-db'
import { enforceRateLimit, PUBLIC_RATE_LIMIT, isRateLimitError, rateLimitErrorResponse, recordSuccessfulRequest, recordFailedRequest } from '../lib/rate-limit'

const app = new Hono()

// GET /stats — Public platform stats
app.get('/', async (c) => {
  let clientIp: string | undefined
  try {
    clientIp = enforceRateLimit(c, PUBLIC_RATE_LIMIT)

    const [totalAgencies, totalCustomers, totalReservations, activeQueues] = await Promise.all([
      cloudDb.agency.count({ where: { isActive: true } }),
      cloudDb.user.count({ where: { role: 'CUSTOMER' } }),
      cloudDb.reservation.count(),
      cloudDb.agency.count({ where: { isQueueOpen: true } }),
    ])

    if (clientIp) recordSuccessfulRequest(clientIp)

    return c.json({ totalAgencies, totalCustomers, totalReservations, activeQueues })
  } catch (error: unknown) {
    if (isRateLimitError(error)) {
      if (clientIp) recordFailedRequest(clientIp)
      const res = rateLimitErrorResponse(error)
      return c.json(res.data, res.status as any)
    }
    console.error('[STATS] Error fetching public stats:', error)
    const message = error instanceof Error ? error.message : 'Internal server error'
    return c.json({ error: 'Failed to fetch stats', details: message }, 500)
  }
})

export const statsRoutes = app
