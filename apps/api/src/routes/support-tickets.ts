/**
 * Support Tickets — customers AND agencies send complaints, notes,
 * suggestions and questions to the super admin.
 *
 * House style: Hono + zod (inline schemas) + requireAuth/requireAdmin +
 * authErrorResponse + free-string audit actions + realtime emit to the
 * admin:global room (new/updated tickets) and the ticket owner's
 * customer:<userId> room (replies / status changes).
 *
 * Sync: SupportTicket is agency-scoped in the sync registry — agency tickets
 * flow to the owning agency's desktops via the incremental pull; customer
 * tickets (agencyId null) stay cloud-side for the admin. The outbox replay
 * from the desktop POSTs here with the ORIGINAL body including the
 * locally-generated id (this route is idempotent on id) so cloud and local
 * records share identity; the global idempotencyGuard makes replays
 * exactly-once on top of that.
 */

import { Hono } from 'hono'
import { z } from 'zod'
import { db } from '@blasti/db'
import { requireAuth, requireAdmin, requireResourceOwnership, authErrorResponse, AuthError } from '../lib/auth'
import { validateBody } from '../lib/validations'
import { verifyAgencyOwnership } from '../lib/auth'
import { emitAdminEvent, emitNotificationEvent } from '../lib/realtime-emit'

const app = new Hono()

const TICKET_CATEGORIES = ['COMPLAINT', 'SUGGESTION', 'QUESTION', 'NOTE'] as const
const TICKET_STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] as const
const TICKET_PRIORITIES = ['LOW', 'NORMAL', 'HIGH'] as const

const createTicketSchema = z.object({
  // Optional client-generated id (cuid) — desktop outbox replays carry the
  // local row's id so the cloud record keeps the SAME identity. A duplicate
  // create with an existing id returns the existing ticket (200).
  id: z.string().cuid().optional(),
  subject: z.string().min(3, 'Subject is required (min 3 chars)').max(150),
  category: z.enum(TICKET_CATEGORIES).default('QUESTION'),
  message: z.string().min(1, 'Message is required').max(5000),
  priority: z.enum(TICKET_PRIORITIES).default('NORMAL'),
  agencyId: z.string().optional().nullable(),
})

const adminUpdateSchema = z.object({
  status: z.enum(TICKET_STATUSES).optional(),
  priority: z.enum(TICKET_PRIORITIES).optional(),
  reply: z.string().max(5000).optional(),
})

const ownerCloseSchema = z.object({
  status: z.literal('CLOSED'),
})

/** Serialize a ticket for client consumption (never leaks internal noise). */
function ticketDto(t: {
  id: string; userId: string; agencyId: string | null; subject: string; category: string
  status: string; priority: string; message: string; reply: string | null
  repliedAt: Date | null; repliedBy: string | null; createdAt: Date; updatedAt: Date
  user?: { id: string; username: string; fullName: string; role: string } | null
  agency?: { id: string; name: string; customCode: string } | null
}) {
  return {
    id: t.id,
    userId: t.userId,
    agencyId: t.agencyId,
    subject: t.subject,
    category: t.category,
    status: t.status,
    priority: t.priority,
    message: t.message,
    reply: t.reply,
    repliedAt: t.repliedAt ? t.repliedAt.toISOString() : null,
    repliedBy: t.repliedBy,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    user: t.user ?? undefined,
    agency: t.agency ?? undefined,
  }
}

const ticketInclude = {
  user: { select: { id: true, username: true, fullName: true, role: true } },
  agency: { select: { id: true, name: true, customCode: true } },
}

async function audit(action: string, userId: string, entityId: string, details: string) {
  try {
    await db.auditLog.create({ data: { userId, action, entityType: 'SUPPORT_TICKET', entityId, details } })
  } catch { /* audit is best-effort */ }
}

/** Notify every active super admin that a new ticket arrived. */
async function notifyAdmins(ticketId: string, subject: string, categoryName: string, requesterName: string) {
  try {
    const admins = await db.user.findMany({
      where: { role: 'SUPER_ADMIN', isActive: true },
      select: { id: true },
    })
    if (admins.length === 0) return
    const title = `New ${categoryName.toLowerCase()} ticket`
    const message = `${requesterName}: ${subject}`
    await db.notification.createMany({
      data: admins.map(a => ({
        userId: a.id,
        type: 'TICKET_NEW',
        title,
        message,
        entityId: ticketId,
      })),
    })
  } catch (error) {
    console.warn('[SupportTickets] admin notification failed:', error instanceof Error ? error.message : error)
  }
}

// ─── POST / — create a ticket (any authenticated user) ──────────────────────

app.post('/', async (c) => {
  try {
    const user = await requireAuth(c)
    const body = await c.req.json().catch(() => ({}))
    const validation = validateBody(createTicketSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }
    const { id, subject, category, message, priority } = validation.data

    // Agency attribution:
    //  - CUSTOMER → personal ticket (agencyId null; not synced to desktops)
    //  - agency owner/staff → always tagged with THEIR agency (ignores any
    //    client-supplied agencyId — cross-agency tagging is not allowed)
    //  - SUPER_ADMIN → may file on behalf of an agency explicitly
    let agencyId: string | null = null
    if (user.role === 'SUPER_ADMIN') {
      agencyId = validation.data.agencyId || null
      if (agencyId) {
        const agency = await db.agency.findUnique({ where: { id: agencyId }, select: { id: true } })
        if (!agency) throw new AuthError('Agency not found', 404)
      }
    } else if (user.role !== 'CUSTOMER') {
      const ownership = await verifyAgencyOwnership(user.id, validation.data.agencyId ?? null)
      if (!ownership) throw new AuthError('You do not have access to this agency', 403)
      agencyId = ownership.agencyId
    }

    // Outbox-replay idempotency: same client id → return the existing record.
    if (id) {
      const existing = await db.supportTicket.findUnique({ where: { id }, include: ticketInclude })
      if (existing) return c.json({ success: true, ticket: ticketDto(existing), replayed: true })
    }

    const created = await db.supportTicket.create({
      data: {
        ...(id ? { id } : {}),
        userId: user.id,
        agencyId,
        subject,
        category,
        status: 'OPEN',
        priority,
        message,
      },
      include: ticketInclude,
    })

    emitAdminEvent('admin:ticket-created', {
      ticketId: created.id,
      subject: created.subject,
      category: created.category,
      priority: created.priority,
      agencyId: created.agencyId,
      requester: user.fullName || user.username,
    })
    await notifyAdmins(created.id, created.subject, created.category, user.fullName || user.username)
    await audit('TICKET_CREATED', user.id, created.id, `${created.category}: ${created.subject}`)

    return c.json({ success: true, ticket: ticketDto(created) }, 201)
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── GET /mine — the caller's own tickets ───────────────────────────────────

app.get('/mine', async (c) => {
  try {
    const user = await requireAuth(c)
    const status = c.req.query('status')
    const where: Record<string, unknown> = { userId: user.id }
    if (status) where.status = status

    const tickets = await db.supportTicket.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 100,
    })
    const openCount = await db.supportTicket.count({ where: { userId: user.id, status: { in: ['OPEN', 'IN_PROGRESS'] } } })

    return c.json({ success: true, tickets: tickets.map(ticketDto), openCount })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── GET /agency — the caller's agency tickets (owner/staff) ────────────────

app.get('/agency', async (c) => {
  try {
    const user = await requireAuth(c)
    const ownership = await verifyAgencyOwnership(user.id, c.req.query('agencyId') || null)
    if (!ownership) throw new AuthError('You do not have access to this agency', 403)

    const status = c.req.query('status')
    const where: Record<string, unknown> = { agencyId: ownership.agencyId }
    if (status) where.status = status

    const tickets = await db.supportTicket.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: ticketInclude,
    })
    const openCount = await db.supportTicket.count({ where: { agencyId: ownership.agencyId, status: { in: ['OPEN', 'IN_PROGRESS'] } } })

    return c.json({ success: true, tickets: tickets.map(ticketDto), openCount })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── GET /:id — ticket detail (owner or super admin) ────────────────────────

app.get('/:id', async (c) => {
  try {
    const id = c.req.param('id')
    const ticket = await db.supportTicket.findUnique({ where: { id }, include: ticketInclude })
    if (!ticket) return c.json({ success: false, error: 'Ticket not found' }, 404)
    await requireResourceOwnership(c, ticket.userId)
    return c.json({ success: true, ticket: ticketDto(ticket) })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── PATCH /:id — the OWNER may close (or reopen) their own ticket ─────────

app.patch('/:id', async (c) => {
  try {
    const id = c.req.param('id')
    const ticket = await db.supportTicket.findUnique({ where: { id } })
    if (!ticket) return c.json({ success: false, error: 'Ticket not found' }, 404)
    await requireResourceOwnership(c, ticket.userId)

    const body = await c.req.json().catch(() => ({}))
    const validation = validateBody(ownerCloseSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: 'Only { status: "CLOSED" } is allowed for ticket owners' }, 400)
    }
    if (ticket.status === 'CLOSED') {
      return c.json({ success: true, ticket: ticketDto(ticket), message: 'Already closed' })
    }

    const updated = await db.supportTicket.update({ where: { id }, data: { status: 'CLOSED' }, include: ticketInclude })
    emitAdminEvent('admin:ticket-updated', { ticketId: id, status: 'CLOSED', by: 'owner' })
    await audit('TICKET_STATUS_CHANGED', ticket.userId, id, 'owner closed the ticket')

    return c.json({ success: true, ticket: ticketDto(updated) })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── Admin endpoints (SUPER_ADMIN only) ─────────────────────────────────────

// GET /admin/all — full list with filters + status counts
app.get('/admin/all', async (c) => {
  try {
    await requireAdmin(c)
    const q = c.req.query()
    const where: Record<string, unknown> = {}
    if (q.status) where.status = q.status
    if (q.category) where.category = q.category
    if (q.priority) where.priority = q.priority
    if (q.agencyId) where.agencyId = q.agencyId
    if (q.userId) where.userId = q.userId
    if (q.search) {
      where.OR = [
        { subject: { contains: q.search } },
        { message: { contains: q.search } },
      ]
    }

    const page = Math.max(1, parseInt(q.page || '1', 10) || 1)
    const pageSize = Math.min(100, Math.max(1, parseInt(q.pageSize || '25', 10) || 25))

    const [tickets, total, openCount, inProgressCount, resolvedCount, closedCount] = await Promise.all([
      db.supportTicket.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: ticketInclude,
      }),
      db.supportTicket.count({ where }),
      db.supportTicket.count({ where: { status: 'OPEN' } }),
      db.supportTicket.count({ where: { status: 'IN_PROGRESS' } }),
      db.supportTicket.count({ where: { status: 'RESOLVED' } }),
      db.supportTicket.count({ where: { status: 'CLOSED' } }),
    ])

    return c.json({
      success: true,
      tickets: tickets.map(ticketDto),
      total,
      page,
      pageSize,
      counts: { open: openCount, inProgress: inProgressCount, resolved: resolvedCount, closed: closedCount },
    })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// PATCH /admin/:id — reply and/or change status/priority
app.patch('/admin/:id', async (c) => {
  try {
    const admin = await requireAdmin(c)
    const id = c.req.param('id')
    const ticket = await db.supportTicket.findUnique({ where: { id } })
    if (!ticket) return c.json({ success: false, error: 'Ticket not found' }, 404)

    const body = await c.req.json().catch(() => ({}))
    const validation = validateBody(adminUpdateSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }
    const { status, priority, reply } = validation.data
    if (!status && !priority && reply === undefined) {
      return c.json({ success: false, error: 'Nothing to update' }, 400)
    }

    const data: Record<string, unknown> = {}
    if (status) data.status = status
    if (priority) data.priority = priority
    if (reply !== undefined) {
      data.reply = reply
      data.repliedAt = new Date()
      data.repliedBy = admin.id
      // A reply always moves the ticket forward if it is still untouched.
      if (!status && ticket.status === 'OPEN') data.status = 'IN_PROGRESS'
    }

    const updated = await db.supportTicket.update({ where: { id }, data, include: ticketInclude })

    // Notify the ticket owner (app notification persists; realtime fires live).
    const notifyTitle = reply !== undefined ? 'Support replied to your ticket' : 'Ticket status updated'
    const notifyMessage = reply !== undefined
      ? reply.slice(0, 200)
      : `Your ticket "${ticket.subject}" is now ${updated.status}`
    try {
      await db.notification.create({
        data: {
          userId: ticket.userId,
          type: reply !== undefined ? 'TICKET_REPLY' : 'TICKET_STATUS',
          title: notifyTitle,
          message: notifyMessage,
          entityId: ticket.id,
        },
      })
    } catch { /* notification persistence is best-effort */ }
    emitNotificationEvent(reply !== undefined ? 'notification:ticket-reply' : 'notification:ticket-status', ticket.userId, {
      ticketId: ticket.id,
      subject: ticket.subject,
      status: updated.status,
      hasReply: reply !== undefined,
    })

    emitAdminEvent('admin:ticket-updated', {
      ticketId: id,
      status: updated.status,
      hasReply: reply !== undefined,
    })
    await audit(reply !== undefined ? 'TICKET_REPLIED' : 'TICKET_STATUS_CHANGED', admin.id, id,
      reply !== undefined ? `status=${updated.status}, replied` : `status=${updated.status}`)

    return c.json({ success: true, ticket: ticketDto(updated) })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

export const supportTicketRoutes = app
