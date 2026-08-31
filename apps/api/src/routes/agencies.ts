import { Hono } from 'hono'
import { db, Prisma } from '@blasti/db'
import { requireRole, requireAgencyAccess, authErrorResponse } from '../lib/auth'
import { adminCreateAgencySchema, updateAgencyProfileSchema, validateBody } from '../lib/validations'
import { enforceRateLimit, getClientIp, AGENCY_LISTING_RATE_LIMIT, PUBLIC_RATE_LIMIT, isRateLimitError, rateLimitErrorResponse, recordFailedRequest, recordSuccessfulRequest } from '../lib/rate-limit'

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

    const { name, nameAr, nameFr, customCode, category, address, phone, ownerId, description, workingHoursStart, workingHoursEnd } = validation.data

    const resolvedOwnerId = user.role === 'SUPER_ADMIN' ? (ownerId || user.id) : user.id

    if (customCode) {
      const existingCode = await db.agency.findUnique({
        where: { customCode },
      })
      if (existingCode) {
        return c.json({ success: false, error: 'Agency code already taken' }, 409)
      }
    }

    const agency = await db.agency.create({
      data: {
        name,
        nameAr,
        nameFr,
        customCode: customCode || name.slice(0, 3).toUpperCase(),
        category: category || 'OTHER',
        address,
        phone,
        email: body.email,
        description,
        ...(workingHoursStart ? { workingHoursStart } : {}),
        ...(workingHoursEnd ? { workingHoursEnd } : {}),
        ownerId: resolvedOwnerId,
        queueSettings: {
          create: {},
        },
      },
    })

    await db.auditLog.create({
      data: {
        userId: user.id,
        action: 'AGENCY_CREATE',
        entityType: 'AGENCY',
        entityId: agency.id,
        details: JSON.stringify({ name, customCode, category, ownerId: resolvedOwnerId }),
      },
    })

    return c.json({ success: true, agency }, 201)
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
