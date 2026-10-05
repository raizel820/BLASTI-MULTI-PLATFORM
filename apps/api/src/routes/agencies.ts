import { Hono } from 'hono'
import { db, Prisma } from '@blasti/db'
import { requireRole, requireAgencyAccess, authErrorResponse, createSessionToken } from '../lib/auth'
import { adminCreateAgencySchema, updateAgencyProfileSchema, validateBody, wilayaCodeRegex } from '../lib/validations'
import { enforceRateLimit, getClientIp, AGENCY_LISTING_RATE_LIMIT, PUBLIC_RATE_LIMIT, isRateLimitError, rateLimitErrorResponse, recordFailedRequest, recordSuccessfulRequest } from '../lib/rate-limit'
import { recordSyncChangeNow } from '../lib/sync-helpers'
// Task 51 — Agency Location & Maps: location pair rule + timestamp stamping
import { buildAgencyLocationPatch } from '../lib/map-settings'

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
          SELECT "agencyId",
                 (ROUND(AVG("rating") * 10) / 10.0)::float8 as "avgRating",
                 CAST(COUNT(*) AS INTEGER) as "reviewCount"
          FROM "Review"
          WHERE "agencyId" IN (${Prisma.join(agencyIds)})
          GROUP BY "agencyId"
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
        // Task 51 — canonical location fields (customer map/list rendering,
        // spec §2/§36). locationVerified lets the UI badge verified agencies.
        latitude: agency.latitude,
        longitude: agency.longitude,
        postalCode: agency.postalCode,
        locationVerified: agency.locationVerified,
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

// ─── Task 83 — BRANCH-CENTRIC PUBLIC ENDPOINTS ───────────────────────────────
// Registered BEFORE GET /:id so "branches" is never swallowed by the id route.

// GET /agencies/branches — branch-level customer search. Every active branch
// is an INDEPENDENT search entity (user requirement: "when customer is
// searching for an agency, each branch is independent and each branch can
// have a special name"). Matching fields: branch name(s), specialName,
// subCode, agency name(s) and the agency customCode.
app.get('/branches', async (c) => {
  let clientIp: string | undefined
  try {
    clientIp = enforceRateLimit(c, AGENCY_LISTING_RATE_LIMIT)

    const search = c.req.query('search') || ''
    const category = c.req.query('category') || ''
    const rawLimit = parseInt(c.req.query('limit') || '20', 10)
    const rawOffset = parseInt(c.req.query('offset') || '0', 10)
    const limit = Math.min(Math.max(rawLimit, 1), 50)
    const offset = Math.max(rawOffset, 0)

    const branchWhere: Record<string, unknown> = {
      isActive: true,
      agency: {
        isActive: true,
        ...(category ? { category } : {}),
      },
    }

    if (search) {
      branchWhere.OR = [
        { name: { contains: search } },
        { nameFr: { contains: search } },
        { nameAr: { contains: search } },
        { specialName: { contains: search } },
        { subCode: { contains: search } },
        { agency: { is: { name: { contains: search } } } },
        { agency: { is: { nameFr: { contains: search } } } },
        { agency: { is: { nameAr: { contains: search } } } },
        { agency: { is: { customCode: { contains: search } } } },
      ]
    }

    const [branches, total] = await Promise.all([
      db.branch.findMany({
        where: branchWhere,
        include: {
          agency: {
            select: {
              id: true,
              name: true,
              nameFr: true,
              nameAr: true,
              customCode: true,
              category: true,
              logoUrl: true,
              coverUrl: true,
              isSponsored: true,
              isQueueOpen: true,
              phone: true,
              workingHoursStart: true,
              workingHoursEnd: true,
              workingDays: true,
              subscriptionStatus: true,
            },
          },
          _count: { select: { counters: { where: { isActive: true } } } },
        },
        orderBy: [
          { agency: { isSponsored: 'desc' } },
          { isMain: 'desc' },
          { createdAt: 'asc' },
        ],
        take: limit,
        skip: offset,
      }),
      db.branch.count({ where: branchWhere }),
    ])

    // Branch-scoped ratings (Review.branchId — Task 83): one grouped raw
    // query for the whole page, same pattern as the agency listing.
    const branchIds = branches.map(b => b.id)
    const ratingResults = branchIds.length > 0
      ? await db.$queryRaw<Array<{ branchId: string; avgRating: number | null; reviewCount: number }>>`
          SELECT "branchId",
                 (ROUND(AVG("rating") * 10) / 10.0)::float8 as "avgRating",
                 CAST(COUNT(*) AS INTEGER) as "reviewCount"
          FROM "Review"
          WHERE "branchId" IN (${Prisma.join(branchIds)})
          GROUP BY "branchId"
        `
      : []
    const ratingMap = new Map(ratingResults.map(r => [r.branchId, { avgRating: r.avgRating ?? 0, reviewCount: Number(r.reviewCount) }]))

    const formattedBranches = branches.map((branch) => {
      const ratingInfo = ratingMap.get(branch.id) || { avgRating: 0, reviewCount: 0 }
      return {
        id: branch.id,
        name: branch.name,
        nameFr: branch.nameFr,
        nameAr: branch.nameAr,
        specialName: branch.specialName,
        subCode: branch.subCode,
        isMain: branch.isMain,
        address: branch.address,
        city: branch.city,
        wilaya: branch.wilaya,
        postalCode: branch.postalCode,
        latitude: branch.latitude,
        longitude: branch.longitude,
        locationVerified: branch.locationVerified,
        phone: branch.phone,
        counterCount: branch._count.counters,
        branchAverageRating: ratingInfo.avgRating,
        branchReviewCount: ratingInfo.reviewCount,
        agency: branch.agency,
      }
    })

    if (clientIp) recordSuccessfulRequest(clientIp)

    return c.json({
      success: true,
      branches: formattedBranches,
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
    console.error('[AGENCIES] Error fetching branches:', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// GET /agencies/branches/by-code/:subCode — public QR deep-link resolver.
// The branch QR encodes <app>/?branch=<subCode>; the web bootstrap calls
// this to resolve the human-readable sub-code ("ABC-B2") into a branch id
// before opening the branch profile. Registered BEFORE /:branchId.
app.get('/branches/by-code/:subCode', async (c) => {
  let clientIp: string | undefined
  try {
    clientIp = enforceRateLimit(c, AGENCY_LISTING_RATE_LIMIT)

    const rawCode = c.req.param('subCode').trim()
    if (!rawCode) {
      return c.json({ success: false, error: 'Branch not found' }, 404)
    }

    // Sub-codes derive from the agency customCode (user-chosen codes may be
    // mixed case) — try the exact code first, then the upper-cased form.
    let branch = await db.branch.findUnique({
      where: { subCode: rawCode },
      select: {
        id: true,
        subCode: true,
        isActive: true,
        agency: { select: { isActive: true } },
      },
    })
    if (!branch && rawCode.toUpperCase() !== rawCode) {
      branch = await db.branch.findUnique({
        where: { subCode: rawCode.toUpperCase() },
        select: {
          id: true,
          subCode: true,
          isActive: true,
          agency: { select: { isActive: true } },
        },
      })
    }

    if (!branch || !branch.isActive || !branch.agency.isActive) {
      return c.json({ success: false, error: 'Branch not found' }, 404)
    }

    if (clientIp) recordSuccessfulRequest(clientIp)
    return c.json({ success: true, branch: { id: branch.id, subCode: branch.subCode } })
  } catch (error: unknown) {
    if (isRateLimitError(error)) {
      if (clientIp) recordFailedRequest(getClientIp(c))
      const res = rateLimitErrorResponse(error)
      return c.json(res.data, res.status as any)
    }
    console.error('[AGENCIES] Error resolving branch sub-code:', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// GET /agencies/branches/:branchId — PUBLIC branch profile (customer side).
// Returns the branch card data + its parent agency's public profile data +
// active services — everything the customer branch-profile page needs in one
// round-trip (reviews come from GET /api/reviews?agencyId&branchId).
app.get('/branches/:branchId', async (c) => {
  let clientIp: string | undefined
  try {
    clientIp = enforceRateLimit(c, AGENCY_LISTING_RATE_LIMIT)

    const branchId = c.req.param('branchId')
    const branch = await db.branch.findUnique({
      where: { id: branchId },
      include: {
        agency: {
          include: {
            services: {
              where: { isActive: true },
              select: { id: true, name: true, nameFr: true, nameAr: true, prefix: true },
            },
            queueSettings: {
              select: { isPaused: true, currentServingNumber: true, lastIssuedNumber: true },
              take: 1,
              orderBy: { updatedAt: 'desc' },
            },
            _count: {
              select: { services: { where: { isActive: true } } },
            },
          },
        },
        _count: { select: { counters: { where: { isActive: true } } } },
      },
    })

    if (!branch || !branch.agency.isActive || !branch.isActive) {
      return c.json({ success: false, error: 'Branch not found' }, 404)
    }

    const ratingStats = await db.review.aggregate({
      where: { branchId },
      _avg: { rating: true },
      _count: { rating: true },
    })

    const a = branch.agency
    if (clientIp) recordSuccessfulRequest(clientIp)

    return c.json({
      success: true,
      branch: {
        id: branch.id,
        name: branch.name,
        nameFr: branch.nameFr,
        nameAr: branch.nameAr,
        specialName: branch.specialName,
        subCode: branch.subCode,
        isMain: branch.isMain,
        address: branch.address,
        city: branch.city,
        wilaya: branch.wilaya,
        postalCode: branch.postalCode,
        latitude: branch.latitude,
        longitude: branch.longitude,
        locationVerified: branch.locationVerified,
        locationSource: branch.locationSource,
        locationUpdatedAt: branch.locationUpdatedAt,
        phone: branch.phone,
        counterCount: branch._count.counters,
      },
      agency: {
        id: a.id,
        name: a.name,
        nameFr: a.nameFr,
        nameAr: a.nameAr,
        customCode: a.customCode,
        category: a.category,
        address: a.address,
        city: a.city,
        wilaya: a.wilaya,
        postalCode: a.postalCode,
        latitude: a.latitude,
        longitude: a.longitude,
        phone: a.phone,
        email: a.email,
        website: a.website,
        logoUrl: a.logoUrl,
        coverUrl: a.coverUrl,
        description: a.description,
        descriptionFr: a.descriptionFr,
        descriptionAr: a.descriptionAr,
        isQueueOpen: a.isQueueOpen,
        isPaused: a.queueSettings.length > 0 ? a.queueSettings[0].isPaused : false,
        isSponsored: a.isSponsored,
        workingHoursStart: a.workingHoursStart,
        workingHoursEnd: a.workingHoursEnd,
        workingDays: a.workingDays,
        serviceCount: a._count.services,
        services: a.services,
      },
      rating: {
        averageRating: ratingStats._avg.rating ? Math.round(ratingStats._avg.rating * 10) / 10 : 0,
        reviewCount: ratingStats._count.rating,
      },
    })
  } catch (error: unknown) {
    if (isRateLimitError(error)) {
      if (clientIp) recordFailedRequest(getClientIp(c))
      const res = rateLimitErrorResponse(error)
      return c.json(res.data, res.status as any)
    }
    console.error('[AGENCIES] Error fetching branch profile:', error)
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

    // Task 51 — Agency Location & Maps: optional canonical location picked on
    // the create-agency map (spec §27/§28). PAIR rule enforced here (lat/lng
    // together, or absent); a valid pair stamps locationUpdatedAt=now. Range
    // checks already ran in adminCreateAgencySchema.
    const locationPatch = buildAgencyLocationPatch(validation.data as Record<string, unknown>)
    if (locationPatch.error) {
      return c.json({ success: false, error: locationPatch.error }, 400)
    }

    // Task 5 — Algeria address selectors (create-agency wizard address step).
    // wilaya is normalized to the canonical two-digit code and only stored
    // when it matches the official 01-58 set; city (commune Latin name) is
    // trimmed. When either is absent the Agency row keeps its DB defaults
    // (wilaya='28', city="M'Sila"). The UI may send wilaya alone (Task 2-c)
    // so a geocode-matched wilaya without a commune is no longer dropped.
    // Task 2-c — the schema itself canonicalizes wilaya (trims, Arabic-Indic
    // digits, padStart), so validation.data.wilaya is already canonical;
    // reading it here (instead of raw body.wilaya) is belt-and-braces and
    // keeps number/string inputs consistent.
    const bodyWilaya = typeof validation.data.wilaya === 'string' ? validation.data.wilaya : ''
    const agencyWilaya = wilayaCodeRegex.test(bodyWilaya) ? bodyWilaya : undefined
    const agencyCity = typeof validation.data.city === 'string' && validation.data.city.trim()
      ? validation.data.city
      : undefined

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

    // Task 83 — typed extraction of the agency location for the auto-created
    // main branch (locationPatch.data is a Record<string, unknown>).
    const mainBranchLat = typeof locationPatch.data.latitude === 'number' ? locationPatch.data.latitude : null
    const mainBranchLng = typeof locationPatch.data.longitude === 'number' ? locationPatch.data.longitude : null
    const mainBranchPostal = typeof locationPatch.data.postalCode === 'string' ? locationPatch.data.postalCode : null
    const mainBranchSource = typeof locationPatch.data.locationSource === 'string' ? locationPatch.data.locationSource : null

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
          // Task 51 — canonical location (lat/lng pair + stamp + metadata;
          // absent → nullable DB columns stay null).
          ...locationPatch.data,
          ownerId: resolvedOwnerId,
          queueSettings: {
            create: {},
          },
          // Task 83 — EVERY fresh agency starts with an auto-created MAIN
          // branch seeded with the agency's own location ("all fresh agencies
          // start as this location as the main branch"). Created inline in the
          // same atomic create — this deliberately bypasses the subscription
          // gates on POST /agency/branches (exemption applies ONLY to this
          // fresh-account main branch) while the row itself still COUNTS
          // toward the plan's maxBranches limit (checkPlanLimit counts Branch
          // rows). The sub-code derives from the agency code: "<CODE>-M1".
          branches: {
            create: {
              name,
              isMain: true,
              subCode: `${finalCustomCode}-M1`,
              ...(address ? { address } : {}),
              ...(phone ? { phone } : {}),
              ...(agencyCity ? { city: agencyCity } : {}),
              ...(agencyWilaya ? { wilaya: agencyWilaya } : {}),
              ...(mainBranchLat != null && mainBranchLng != null
                ? {
                    latitude: mainBranchLat,
                    longitude: mainBranchLng,
                    ...(mainBranchPostal ? { postalCode: mainBranchPostal } : {}),
                    ...(mainBranchSource ? { locationSource: mainBranchSource } : {}),
                    locationUpdatedAt: new Date(),
                  }
                : {}),
            },
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
        include: { services: true, branches: true },
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

    // Spec Part O: the nested queueSettings.create, the nested services
    // create AND the Task 83 auto-created main branch are INVISIBLE to the
    // auto-tracking extension (it fires once for the top-level Agency op) —
    // a desktop initialized from the feed would miss those rows entirely.
    // Compensate with explicit captures.
    try {
      const createdQs = await db.queueSettings.findFirst({ where: { agencyId: agency.id }, select: { id: true } })
      if (createdQs) {
        await recordSyncChangeNow({ agencyId: agency.id, model: 'QueueSettings', recordId: createdQs.id, operation: 'create' })
      }
      for (const svc of (agency as { services?: Array<{ id: string }> }).services || []) {
        await recordSyncChangeNow({ agencyId: agency.id, model: 'Service', recordId: svc.id, operation: 'create' })
      }
      // Task 83 — the auto-created main branch must reach offline desktops too.
      const createdMainBranch = await db.branch.findFirst({
        where: { agencyId: agency.id, isMain: true },
        select: { id: true },
      })
      if (createdMainBranch) {
        await recordSyncChangeNow({ agencyId: agency.id, model: 'Branch', recordId: createdMainBranch.id, operation: 'create' })
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

    // Task 51 — canonical location fields: replace the raw location keys with
    // the pair-checked, timestamp-stamped patch (half-set lat/lng → 400).
    const locationPatch = buildAgencyLocationPatch(updateData)
    if (locationPatch.error) {
      return c.json({ success: false, error: locationPatch.error }, 400)
    }
    for (const k of ['latitude', 'longitude', 'postalCode', 'locationVerified', 'locationSource']) {
      delete (updateData as Record<string, unknown>)[k]
    }
    Object.assign(updateData, locationPatch.data)

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
