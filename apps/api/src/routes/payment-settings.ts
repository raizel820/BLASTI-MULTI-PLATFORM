import { Hono } from 'hono'
import { db } from '@blasti/db'
import { enforceRateLimit, PUBLIC_RATE_LIMIT, isRateLimitError, rateLimitErrorResponse, recordSuccessfulRequest, recordFailedRequest } from '../lib/rate-limit'

const app = new Hono()

// GET /payment-settings — Public payment settings
app.get('/', async (c) => {
  let clientIp: string | undefined
  try {
    clientIp = enforceRateLimit(c, PUBLIC_RATE_LIMIT)

    let settings = await db.paymentSettings.findFirst()
    if (!settings) {
      if (clientIp) recordSuccessfulRequest(clientIp)
      return c.json({
        ccpEnabled: true,
        bankEnabled: true,
        electronicEnabled: true,
        ccpAccount: '0000 0000 0000 0000',
        ccpKey: '00',
        bankAccount: '0000 0000 0000 0000',
        bankRib: '00 000 00000 000 0000 000',
        bankName: 'BNA',
        ewalletNumber: '0XXX XXX XXX',
      })
    }
    if (clientIp) recordSuccessfulRequest(clientIp)
    return c.json({
      ccpEnabled: settings.ccpEnabled,
      bankEnabled: settings.bankEnabled,
      electronicEnabled: settings.electronicEnabled,
      ccpAccount: settings.ccpAccount,
      ccpKey: settings.ccpKey,
      bankAccount: settings.bankAccount,
      bankRib: settings.bankRib,
      bankName: settings.bankName,
      ewalletNumber: settings.ewalletNumber,
    })
  } catch (error: unknown) {
    if (isRateLimitError(error)) {
      if (clientIp) recordFailedRequest(clientIp)
      const res = rateLimitErrorResponse(error)
      return c.json(res.data, res.status as any)
    }
    const message = error instanceof Error ? error.message : 'Internal server error'
    console.error('[payment-settings GET] Error:', message)
    return c.json({ error: 'Operation failed' }, 500)
  }
})

export const paymentSettingsRoutes = app
