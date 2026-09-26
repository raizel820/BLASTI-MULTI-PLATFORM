import { Hono } from 'hono'
import { db, Prisma } from '@blasti/db'
import { requireRole, requireAgencyAccess, authErrorResponse, createSessionToken } from '../lib/auth'
import { adminCreateAgencySchema, updateAgencyProfileSchema, validateBody, wilayaCodeRegex } from '../lib/validations'
import { enforceRateLimit, getClientIp, AGENCY_LISTING_RATE_LIMIT, PUBLIC_RATE_LIMIT, isRateLimitError, rateLimitErrorResponse, recordFailedRequest, recordSuccessfulRequest } from '../lib/rate-limit'
import { recordSyncChangeNow } from '../lib/sync-helpers'

const app = new Hono()

// GET /agencies — Public agency listing
app.get('/', async (c) => {
  let clientIp: string | undefined
  try {
    clientIp = enforceRateLimit(c, AGENCY_LISTING_RATE_LIMIT)

    const search = c.req.query('search') || ''
    const category = c.req.query('category') || ''
    const rawLimit = parseInt(c.req.query('limit') || '20', 10)
    const rawOffset = parseInt(c.req.query('offset') || '0', 10)
    const limit = Math.min(Math.max(rawLimit, 1), 50)
    const offset = Math.max(rawOffset, 0)

    const where: Record<string, unknown> = {
      isActive: true,
    }

    if (search) {
      where.OR = [
        { name: { contains: search } },
        { nameFr: { contains: search } },
        { nameAr: { contains: search } },
        { customCode: { contains: search } },
      ]
    }

    if (category) {
      where.category = category
    }

    const [agencies, total] = await Promise.all([
      db.agency.findMany({
        where,
        include: {
          _count: {
            select: { services: { where: { isActive: true } } },
          },
          queueSettings: {
            select: { isPaused: true },
            take: 1,
            orderBy: { updatedAt: 'desc' },
          },
          reservations: {
            select: { id: true },
            where: { status: { in: ['WAITING', 'CALLED'] } },
          },
        },
        orderBy: [
          { isSponsored: 'desc' },
          { createdAt: 'desc' },
        ],
        take: limit,
        skip: offset,
      }),
      db.agency.count({ where }),
    ])

    const agencyIds = agencies.map(a => a.id)
    const ratingResults = agencyIds.length > 0
      ? await db.$queryRaw<Array<{ agencyId: string; avgRating: number | null; reviewCount: number }>>`
          SELECT agencyId,
                 ROUND(AVG(CAST(rating AS REAL)) * 10) / 10 as avgRating,
                 COUNT(*) as reviewCount
          FROM Review
          WHERE agencyId IN (${Prisma.join(agencyIds)})
          GROUP BY agencyId
        `
      : []

    const ratingMap = new Map(ratingResults.map(r => [r.agencyId, { avgRating: r.avgRating ?? 0, reviewCount: Number(r.reviewCount) }]))

    const formattedAgencies = agencies.map((agency) => {
      const ratingInfo = ratingMap.get(agency.id) || { avgRating: 0, reviewCount: 0 }
      return {
        id: agency.id,
        name: agency.name,
        nameFr: agency.nameFr,
        nameAr: agency.nameAr,
        customCode: agency.customCode,
        category: agency.category,
        address: agency.address,
        city: agency.city,
        phone: agency.phone,
        email: agency.email,
        logoUrl: agency.logoUrl,
        isSponsored: agency.isSponsored,
        isQueueOpen: agency.isQueueOpen,
        serviceCount: agency._count.services,
        waitingCount: agency.reservations.length,
        workingHoursStart: agency.workingHoursStart,
        workingHoursEnd: agency.workingHoursEnd,
        isPaused: agency.queueSettings.length > 0 ? agency.queueSettings[0].isPaused : false,
        avgServiceTime: agency.averageServiceTime,
        averageRating: ratingInfo.avgRating,
        reviewCount: ratingInfo.reviewCount,
        subscriptionStatus: agency.subscriptionStatus,
        createdAt: agency.createdAt,
      }
    })

    if (clientIp) recordSuccessfulRequest(clientIp)

    return c.json({
      success: true,
      agencies: formattedAgencies,
      total,
      limit,
      offset,
    })
  } catch (error: unknown) {
    if (isRateLimitError(error)) {
      if (clientIp) recordFailedRequest(getClientIp(c))
      const res = rateLimitErrorResponse(error)
      return c.json(res.data, res.status as any)
    }
    console.error('[AGENCIES] Error fetching agencies:', error)
    return c.json(
      { success: false, error: 'Internal server error' },
      500
    )
  }
})

// GET /agencies/check-code?code=XXX — Live agency-code availability for the
// create-agency wizard (same UX as /auth/check-username). Public + rate
// limited; only answers { available } — never echoes agency data.
const CODE_CHECK_RATE_LIMIT = {
  windowMs: 60 * 1000,
  maxRequests: 30,
  prefix: 'agency-code-check',
}

app.get('/check-code', async (c) => {
  let clientIp: string | undefined
  try {
    clientIp = enforceRateLimit(c, CODE_CHECK_RATE_LIMIT)

    const raw = (c.req.query('code') || '').trim().toUpperCase()

    // Short/missing codes: report available so early typing isn't blocked
    // (mirrors check-username's minimum-length behavior).
    if (!raw || raw.length < 2) {
      if (clientIp) recordSuccessfulRequest(clientIp)
      return c.json({ available: true })
    }

    // Impossible codes (too long / invalid characters) are never available —
    // the wizard's own validation would reject them at submit anyway.
    if (raw.length > 10 || !/^[A-Z0-9_-]+$/.test(raw)) {
      if (clientIp) recordSuccessfulRequest(clientIp)
      return c.json({ available: false })
    }

    // Exact match first (hits the unique index), then a case-insensitive
    // safety net: SQLite has no case-insensitive unique constraint and older
    // rows may hold mixed-case codes. Prisma's `contains` maps to LIKE on
    // SQLite, which is ASCII case-insensitive.
    const exact = await db.agency.findUnique({
      where: { customCode: raw },
      select: { id: true },
    })
    if (!exact) {
      const ciMatches = await db.agency.findMany({
        where: { customCode: { contains: raw } },
        select: { customCode: true },
        take: 50,
      })
      if (ciMatches.some((row) => (row.customCode || '').toUpperCase() === raw)) {
        if (clientIp) recordSuccessfulRequest(clientIp)
        return c.json({ available: false })
      }
    }

    if (clientIp) recordSuccessfulRequest(clientIp)
    return c.json({ available: !exact })
  } catch (error: unknown) {
    if (isRateLimitError(error)) {
      if (clientIp) recordFailedRequest(getClientIp(c))
      const res = rateLimitErrorResponse(error)
      return c.json(res.data, res.status as any)
    }
    // On error, report available to not block the wizard — better UX than a
    // false "taken" (the create endpoint still enforces uniqueness).
    console.error('[AGENCIES] check-code error:', error)
    return c.json({ available: true })
  }
})

// GET /agencies/code/:code — Lookup agency by code
app.get('/code/:code', async (c) => {
  let clientIp: string | undefined
  try {
    clientIp = enforceRateLimit(c, PUBLIC_RATE_LIMIT)

    const code = c.req.param('code')

    const agency = await db.agency.findUnique({
      where: { customCode: code },
      include: {
        services: {
          where: { isActive: true },
          select: {
            id: true,
            name: true,
            nameFr: true,
            nameAr: true,
            prefix: true,
            _count: {
              select: {
                reservations: {
                  where: { status: { in: ['WAITING', 'CALLED'] } },
                },
              },
            },
          },
        },
        queueSettings: {
          select: {
            id: true,
            currentServingNumber: true,
            lastIssuedNumber: true,
            isPaused: true,
            openedAt: true,
          },
          take: 1,
          orderBy: { updatedAt: 'desc' },
        },
      },
    })

    if (!agency) {
      return c.json({ success: false, error: 'Agency not found' }, 404)
    }

    if (!agency.isActive) {
      return c.json({ success: false, error: 'Agency is not active' }, 404)
    }

    const servicesWithCount = agency.services.map((service) => ({
      ...service,
      waitingCount: service._count.reservations,
    }))

    if (clientIp) recordSuccessfulRequest(clientIp)

    return c.json({
      success: true,
      agency: {
        id: agency.id,
        name: agency.name,
        nameFr: agency.nameFr,
        nameAr: agency.nameAr,
        customCode: agency.customCode,
        category: agency.category,
        address: agency.address,
        city: agency.city,
        phone: agency.phone,
        email: agency.email,
        logoUrl: agency.logoUrl,
        coverUrl: agency.coverUrl,
        description: agency.description,
        isQueueOpen: agency.isQueueOpen,
        isPaused: agency.queueSettings.length > 0 ? agency.queueSettings[0].isPaused : false,
        isSponsored: agency.isSponsored ?? false,
        currentServingNumber: agency.queueSettings.length > 0 ? agency.queueSettings[0].currentServingNumber : 0,
        lastIssuedNumber: agency.queueSettings.length > 0 ? agency.queueSettings[0].lastIssuedNumber : 0,
        workingHoursStart: agency.workingHoursStart,
        workingHoursEnd: agency.workingHoursEnd,
        avgServiceTime: agency.averageServiceTime,
        subscriptionStatus: agency.subscriptionStatus,
        services: servicesWithCount,
      },
    })
  } catch (error: unknown) {
    if (isRateLimitError(error)) {
      if (clientIp) recordFailedRequest(clientIp)
      const res = rateLimitErrorResponse(error)
      return c.json(res.data, res.status as any)
    }
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// GET /agencies/:id — Get agency by ID
app.get('/:id', async (c) => {
  try {
    const id = c.req.param('id')

    const agency = await db.agency.findUnique({
      where: { id },
      include: {
        services: {
          where: { isActive: true },
          select: {
            id: true,
            name: true,
            nameFr: true,
            nameAr: true,
            prefix: true,
          },
        },
        queueSettings: {
          select: {
            id: true,
            currentServingNumber: true,
            lastIssuedNumber: true,
            isPaused: true,
            openedAt: true,
          },
          take: 1,
          orderBy: { updatedAt: 'desc' },
        },
        owner: {
          select: {
            id: true,
            fullName: true,
            username: true,
          },
        },
        _count: {
          select: {
            reservations: {
              where: { status: { in: ['WAITING', 'CALLED'] } },
            },
          },
        },
      },
    })

    if (!agency) {
      return c.json({ success: false, error: 'Agency not found' }, 404)
    }

    return c.json({
      success: true,
      agency: {
        ...agency,
        activeQueueCount: agency._count.reservations,
      },
    })
  } catch (_error: unknown) {
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// POST /agencies — Create agency (SUPER_ADMIN or AGENCY_OWNER only)
app.post('/', async (c) => {
  try {
    const user = await requireRole(c, 'SUPER_ADMIN', 'AGENCY_OWNER')

    const body = await c.req.json()
    const validation = validateBody(adminCreateAgencySchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { name, nameAr, nameFr, customCode, category, address, phone, ownerId, description, workingHoursStart, workingHoursEnd, workingDays, services } = validation.data

    // Task 5 — Algeria address selectors (create-agency wizard address step).
    // wilaya is normalized to the canonical two-digit code and only stored
    // when it matches ^(0[1-9]|[1-5][0-8])$; city (commune Latin name) is
    // trimmed. When either is absent the Agency row keeps its DB defaults
    // (wilaya='28', city="M'Sila"). Sent as a pair by the UI so a wilaya
    // without a matching commune never lands on the row half-set.
    const bodyWilaya = typeof body.wilaya === 'string' && body.wilaya.trim()
      ? body.wilaya.trim().padStart(2, '0')
      : ''
    const agencyWilaya = wilayaCodeRegex.test(bodyWilaya) ? bodyWilaya : undefined
    const agencyCity = typeof body.city === 'string' && body.city.trim() ? body.city.trim() : undefined

    const resolvedOwnerId = user.role === 'SUPER_ADMIN' ? (ownerId || user.id) : user.id

    if (customCode) {
      const existingCode = await db.agency.findUnique({
        where: { customCode },
      })
      if (existingCode) {
        return c.json({ success: false, error: 'Agency code already taken' }, 409)
      }
    }

    // Round 16: the AUTO-DERIVED code (first 3 letters of the name) has no
    // client-side uniqueness — two agencies named "Probe…"/"Al Noor…" both
    // derived the same code and the create 500'd on the unique constraint.
    // Probe for a free code when the client did not choose one explicitly.
    let finalCustomCode = customCode || name.slice(0, 3).toUpperCase()
    if (!customCode) {
      const base = finalCustomCode
      for (let attempt = 2; attempt <= 60; attempt++) {
        const taken = await db.agency.findUnique({ where: { customCode: finalCustomCode }, select: { id: true } })
        if (!taken) break
        finalCustomCode = attempt <= 50
          ? `${base}${attempt}`
          : `${base}${Date.now().toString(36).toUpperCase().slice(-4)}`
      }
    }

    // Ghost-session guard (defense in depth): the auth layer now rejects
    // tokens whose user row no longer exists, but if a ghost token ever
    // reaches this route (or a SUPER_ADMIN passes a non-existent ownerId),
    // surface a clear actionable 401 instead of a raw Prisma P2003 500 —
    // ownerId → User is the ONLY parent FK on Agency.create, so a missing
    // owner IS the only possible FK failure here.
    const ownerExists = await db.user.findUnique({
      where: { id: resolvedOwnerId },
      select: { id: true },
    })
    if (!ownerExists) {
      console.warn(`[agencies] create rejected — owner user=${resolvedOwnerId} does not exist (ghost session)`)
      return c.json({
        success: false,
        error: 'Your session refers to an account that no longer exists. Please log in again.',
        code: 'SESSION_USER_MISSING',
      }, 401)
    }

    let agency
    try {
      agency = await db.agency.create({
        data: {
          name,
          nameAr,
          nameFr,
          customCode: finalCustomCode,
          category: category || 'OTHER',
          address,
          phone,
          email: body.email,
          description,
          ...(workingHoursStart ? { workingHoursStart } : {}),
          ...(workingHoursEnd ? { workingHoursEnd } : {}),
          // Round 15 — working days ride along with the working hours.
          ...(workingDays ? { workingDays } : {}),
          // Task 5 — Algeria address selectors (absent → DB defaults).
          ...(agencyWilaya ? { wilaya: agencyWilaya } : {}),
          ...(agencyCity ? { city: agencyCity } : {}),
          ownerId: resolvedOwnerId,
          queueSettings: {
            create: {},
          },
          // Round 15 — services submitted with the agency are created ATOMICALLY
          // in the same create (no ordering races with the desktop proxy, no
          // extra client round-trips). Prefixes auto-assign A, B, C… skipping
          // letters the client already used.
          ...(services && services.length ? {
            services: {
              create: services.map((svc, index) => ({
                name: svc.name,
                ...(svc.nameAr ? { nameAr: svc.nameAr } : {}),
                ...(svc.nameFr ? { nameFr: svc.nameFr } : {}),
                ...(svc.description ? { description: svc.description } : {}),
                prefix: svc.prefix || String.fromCharCode(65 + (index % 26)),
              })),
            },
          } : {}),
        },
        include: { services: true },
      })
    } catch (createErr) {
      // Round 16 safety net: an explicit-code race between two concurrent
      // creates must surface as the client-handled 409 ("Agency code already
      // taken" — the form navigates back to step 1), never a raw 500.
      if (createErr instanceof Prisma.PrismaClientKnownRequestError && createErr.code === 'P2002') {
        return c.json({ success: false, error: 'Agency code already taken' }, 409)
      }
      // P2003 (FK violation): ownerId → User is the only parent FK on this
      // create — a ghost session (account deleted / DB reset while the token
      // survived) must surface as an actionable 401, never "Internal server
      // error". The client (create-agency-form) reacts to 401 by clearing the
      // stale session and routing to login.
      if (createErr instanceof Prisma.PrismaClientKnownRequestError && createErr.code === 'P2003') {
        console.warn(`[agencies] create P2003 — owner user=${resolvedOwnerId} missing (ghost session)`)
        return c.json({
          success: false,
          error: 'Your session refers to an account that no longer exists. Please log in again.',
          code: 'SESSION_USER_MISSING',
        }, 401)
      }
      throw createErr
    }

    // Spec Part O: the nested queueSettings.create and the nested services
    // create are INVISIBLE to the auto-tracking extension (it fires once for
    // the top-level Agency op) — a desktop initialized from the feed would
    // miss those rows entirely. Compensate with explicit captures.
    try {
      const createdQs = await db.queueSettings.findFirst({ where: { agencyId: agency.id }, select: { id: true } })
      if (createdQs) {
        await recordSyncChangeNow({ agencyId: agency.id, model: 'QueueSettings', recordId: createdQs.id, operation: 'create' })
      }
      for (const svc of (agency as { services?: Array<{ id: string }> }).services || []) {
        await recordSyncChangeNow({ agencyId: agency.id, model: 'Service', recordId: svc.id, operation: 'create' })
      }
    } catch (qsErr) {
      console.warn('[agencies] nested create capture failed:', (qsErr as Error)?.message)
    }

    await db.auditLog.create({
      data: {
        userId: user.id,
        action: 'AGENCY_CREATE',
        entityType: 'AGENCY',
        entityId: agency.id,
        details: JSON.stringify({ name, customCode: finalCustomCode, category, ownerId: resolvedOwnerId }),
      },
    })

    // Round 16 — the freshly-created agency must be usable IMMEDIATELY. The
    // caller's session token is a snapshot issued BEFORE this agency existed
    // (agencyId: '') — without a re-issue the desktop sync engine keeps
    // seeing "no agency", the workspace never initializes, and the local API
    // session stays agency-less. Return an upgraded token alongside the
    // agency so the client can adopt it in one round-trip.
    let sessionToken: string | undefined
    try {
      sessionToken = await createSessionToken({ ...user, agencyId: agency.id })
    } catch (tokErr) {
      console.warn('[agencies] session token re-issue failed (non-fatal):', (tokErr as Error)?.message)
    }

    return c.json({ success: true, agency, ...(sessionToken ? { token: sessionToken } : {}) }, 201)
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// PUT /agencies/:id — Update agency
app.put('/:id', async (c) => {
  try {
    const id = c.req.param('id')

    await requireAgencyAccess(c, id)

    const body = await c.req.json()

    const existingAgency = await db.agency.findUnique({ where: { id } })
    if (!existingAgency) {
      return c.json({ success: false, error: 'Agency not found' }, 404)
    }

    if (body.customCode && body.customCode !== existingAgency.customCode) {
      const duplicateCode = await db.agency.findUnique({
        where: { customCode: body.customCode },
      })
      if (duplicateCode) {
        return c.json({ success: false, error: 'Agency code already taken' }, 409)
      }
    }

    const validation = validateBody(updateAgencyProfileSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const updateData: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(validation.data)) {
      if (value !== undefined) {
        updateData[key] = value
      }
    }
    // Drop relations that may ride along from client payloads.
    delete (updateData as Record<string, unknown>).services

    const agency = await db.agency.update({
      where: { id },
      data: updateData,
    })

    return c.json({ success: true, agency })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

export const agenciesRoutes = app
