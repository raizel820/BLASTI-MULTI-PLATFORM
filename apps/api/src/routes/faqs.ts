import { Hono } from 'hono'
import { db } from '@blasti/db'
import { enforceRateLimit, PUBLIC_RATE_LIMIT, isRateLimitError, rateLimitErrorResponse, recordSuccessfulRequest, recordFailedRequest } from '../lib/rate-limit'

const app = new Hono()

// GET / — Public FAQ (no localization) → /api/faq
app.get('/', async (c) => {
  let clientIp: string | undefined
  try {
    clientIp = enforceRateLimit(c, PUBLIC_RATE_LIMIT)

    const faqs = await db.fAQ.findMany({
      where: { isActive: true },
      orderBy: [{ order: 'asc' }, { createdAt: 'desc' }],
    })

    if (clientIp) recordSuccessfulRequest(clientIp)
    return c.json({ faqs })
  } catch (error: unknown) {
    if (isRateLimitError(error)) {
      if (clientIp) recordFailedRequest(clientIp)
      const res = rateLimitErrorResponse(error)
      return c.json(res.data, res.status as any)
    }
    const message = error instanceof Error ? error.message : 'Internal server error'
    console.error('[faq GET] Error:', message)
    return c.json({ error: 'Operation failed', details: message }, 500)
  }
})

// GET /faqs — Public FAQ with localization → also mounted at /api/faqs
app.get('/faqs', async (c) => {
  let clientIp: string | undefined
  try {
    clientIp = enforceRateLimit(c, PUBLIC_RATE_LIMIT)

    const category = c.req.query('category')
    const lang = c.req.query('lang') || 'en'

    const where: Record<string, unknown> = { isActive: true }
    if (category) where.category = category

    const faqs = await db.fAQ.findMany({
      where,
      orderBy: { order: 'asc' },
    })

    const localized = faqs.map((faq) => ({
      id: faq.id,
      question: lang === 'ar' && faq.questionAr ? faq.questionAr : lang === 'fr' && faq.questionFr ? faq.questionFr : faq.question,
      answer: lang === 'ar' && faq.answerAr ? faq.answerAr : lang === 'fr' && faq.answerFr ? faq.answerFr : faq.answer,
      category: faq.category,
      order: faq.order,
    }))

    if (clientIp) recordSuccessfulRequest(clientIp)
    return c.json({ faqs: localized })
  } catch (error: unknown) {
    if (isRateLimitError(error)) {
      if (clientIp) recordFailedRequest(clientIp)
      const res = rateLimitErrorResponse(error)
      return c.json(res.data, res.status as any)
    }
    const message = error instanceof Error ? error.message : 'Internal server error'
    console.error('[faqs GET] Error:', message)
    return c.json({ error: 'Operation failed', details: message }, 500)
  }
})

export const faqRoutes = app
