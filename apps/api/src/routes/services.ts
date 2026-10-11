import { Hono } from 'hono'
import { db } from '@blasti/db'
import { requireAgencyAccess, authErrorResponse } from '../lib/auth'
import { createServiceSchema, validateBody } from '../lib/validations'

const app = new Hono()

// GET /services — List services for an agency
app.get('/', async (c) => {
  try {
    const agencyId = c.req.query('agencyId')
    if (!agencyId) return c.json({ success: false, error: 'agencyId is required' }, 400)

    const services = await db.service.findMany({
      where: { agencyId, isActive: true },
      orderBy: { name: 'asc' },
    })

    return c.json({ success: true, services })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal server error'
    return c.json({ success: false, error: message }, 500)
  }
})

// POST /services — Create a service
app.post('/', async (c) => {
  try {
    const body = await c.req.json()
    const { agencyId, name, nameFr, nameAr, prefix } = body

    if (!agencyId) return c.json({ success: false, error: 'agencyId is required' }, 400)

    await requireAgencyAccess(c, agencyId)

    const validation = validateBody(createServiceSchema, { name, nameFr, nameAr, prefix })
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const agency = await db.agency.findUnique({ where: { id: agencyId } })
    if (!agency) return c.json({ success: false, error: 'Agency not found' }, 404)

    const service = await db.service.create({
      data: {
        agencyId,
        name: validation.data.name,
        nameFr: validation.data.nameFr || null,
        nameAr: validation.data.nameAr || null,
        prefix: prefix || validation.data.name.charAt(0).toUpperCase(),
      },
    })

    return c.json({ success: true, service }, 201)
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// DELETE /services/:id — Soft delete a service
app.delete('/:id', async (c) => {
  try {
    const id = c.req.param('id')

    const service = await db.service.findUnique({ where: { id } })
    if (!service) return c.json({ success: false, error: 'Service not found' }, 404)

    await requireAgencyAccess(c, service.agencyId)

    const updatedService = await db.service.update({ where: { id }, data: { isActive: false } })

    return c.json({ success: true, service: updatedService })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

export const serviceRoutes = app
