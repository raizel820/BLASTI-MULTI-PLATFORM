/**
 * @blasti/api — Headless Backend Server
 *
 * Entry point for the BLASTI backend. Combines:
 * - Health endpoint (GET /health)
 * - API info endpoint (GET /)
 * - Realtime Socket.IO service (websocket + HTTP emit endpoints)
 * - CORS enabled for LAN/local-network clients
 *
 * Port: 3003
 *
 * Routes:
 *   GET  /health        → Service health check
 *   GET  /stats         → Socket.IO connection stats
 *   POST /emit          → Emit a single realtime event
 *   POST /emit-batch    → Emit multiple realtime events
 *   Socket.IO            → Real-time event broadcasting
 */

import { Server as SocketIOServer } from 'socket.io'
import { createServer, IncomingMessage, ServerResponse } from 'http'

// ─── Configuration ────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.API_PORT || '3003', 10)
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*'

// ─── HTTP Server ──────────────────────────────────────────────────────────────

const httpServer = createServer()

// ─── Socket.IO Server ─────────────────────────────────────────────────────────

const io = new SocketIOServer(httpServer, {
  cors: { origin: CORS_ORIGIN, methods: ['GET', 'POST'] },
  pingInterval: 25000,
  pingTimeout: 20000,
  allowUpgrades: true,
  maxHttpBufferSize: 1e6,
})

// ─── Stats ────────────────────────────────────────────────────────────────────

let totalConnections = 0
let totalEventsEmitted = 0

// ─── HTTP Request Handler ─────────────────────────────────────────────────────

function handleRequest(req: IncomingMessage, res: ServerResponse) {
  // CORS headers for all responses
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN)
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  const url = req.url || '/'
  const method = req.method || 'GET'

  if (method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  // API info endpoint
  if (method === 'GET' && url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      name: '@blasti/api',
      version: '0.1.0',
      description: 'BLASTI Headless Backend Server',
      endpoints: {
        health: 'GET /health',
        stats: 'GET /stats',
        emit: 'POST /emit',
        emitBatch: 'POST /emit-batch',
        websocket: 'Socket.IO connection',
      },
    }))
    return
  }

  // Health check endpoint
  if (method === 'GET' && url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      status: 'ok',
      service: '@blasti/api',
      version: '0.1.0',
      connections: io.engine.clientsCount,
      totalConnections,
      totalEventsEmitted,
      uptime: Math.floor(process.uptime()),
      rooms: io.sockets.adapter.rooms.size,
    }))
    return
  }

  // Stats endpoint
  if (method === 'GET' && url === '/stats') {
    const roomList = Array.from(io.sockets.adapter.rooms.keys())
    const roomCounts: Record<string, number> = {}
    for (const room of roomList) {
      const sockets = io.sockets.adapter.rooms.get(room)
      roomCounts[room] = sockets ? sockets.size : 0
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      connections: io.engine.clientsCount,
      totalConnections,
      totalEventsEmitted,
      rooms: roomCounts,
      uptime: Math.floor(process.uptime()),
    }))
    return
  }

  // Emit endpoint (single event)
  if (method === 'POST' && url === '/emit') {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString())
        if (!body.type) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, error: 'Missing event type' }))
          return
        }
        const result = broadcastEvent(body)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true, recipients: result }))
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON' }))
      }
    })
    req.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: false, error: 'Request error' }))
      }
    })
    return
  }

  // Batch emit endpoint
  if (method === 'POST' && url === '/emit-batch') {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString())
        if (!Array.isArray(body.events)) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, error: 'Missing events array' }))
          return
        }
        let totalRecipients = 0
        for (const evt of body.events) {
          totalRecipients += broadcastEvent(evt)
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true, count: body.events.length, recipients: totalRecipients }))
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON' }))
      }
    })
    req.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: false, error: 'Request error' }))
      }
    })
    return
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'Not found' }))
}

httpServer.on('request', handleRequest)

// ─── Event Broadcasting ──────────────────────────────────────────────────────

function broadcastEvent(event: Record<string, unknown>): number {
  const type = event.type as string
  const timestamp = Date.now()
  totalEventsEmitted++

  if (!type) return 0

  // Queue events → broadcast to agency room
  if (type.startsWith('queue:')) {
    const agencyId = event.agencyId as string
    if (agencyId) {
      const room = `agency:${agencyId}`
      io.to(room).emit(type, { ...event, timestamp })
      const sockets = io.sockets.adapter.rooms.get(room)
      const count = sockets ? sockets.size : 0
      console.log(`[${type}] → ${room} (${count} recipients)`)
      return count
    }
  }

  // Reservation events → broadcast to agency room + specific customer
  if (type.startsWith('reservation:')) {
    const agencyId = event.agencyId as string
    const userId = event.userId as string
    let recipients = 0
    if (agencyId) {
      const room = `agency:${agencyId}`
      io.to(room).emit(type, { ...event, timestamp })
      const sockets = io.sockets.adapter.rooms.get(room)
      recipients += sockets ? sockets.size : 0
    }
    if (userId) {
      const room = `customer:${userId}`
      io.to(room).emit(type, { ...event, timestamp })
      const sockets = io.sockets.adapter.rooms.get(room)
      recipients += sockets ? sockets.size : 0
    }
    console.log(`[${type}] → agency:${agencyId || 'none'}, customer:${userId || 'none'} (${recipients} recipients)`)
    return recipients
  }

  // Notification events → send to specific user room
  if (type.startsWith('notification:')) {
    const userId = event.userId as string
    if (userId) {
      const room = `customer:${userId}`
      io.to(room).emit(type, { ...event, timestamp })
      const sockets = io.sockets.adapter.rooms.get(room)
      const count = sockets ? sockets.size : 0
      console.log(`[${type}] → customer:${userId} (${count} recipients)`)
      return count
    }
  }

  // Kiosk events → broadcast to kiosk room for agency
  if (type === 'kiosk:update') {
    const agencyId = event.agencyId as string
    if (agencyId) {
      const room = `kiosk:${agencyId}`
      io.to(room).emit(type, { ...event, timestamp })
      const sockets = io.sockets.adapter.rooms.get(room)
      const count = sockets ? sockets.size : 0
      console.log(`[kiosk:update] → kiosk:${agencyId} (${count} recipients)`)
      return count
    }
  }

  // Agency events → broadcast to agency room
  if (type.startsWith('agency:')) {
    const agencyId = event.agencyId as string
    if (agencyId) {
      const room = `agency:${agencyId}`
      io.to(room).emit(type, { ...event, timestamp })
      const sockets = io.sockets.adapter.rooms.get(room)
      const count = sockets ? sockets.size : 0
      console.log(`[${type}] → agency:${agencyId} (${count} recipients)`)
      return count
    }
  }

  // Device events → send to specific user room
  if (type.startsWith('device:')) {
    const userId = event.userId as string
    if (userId) {
      const room = `customer:${userId}`
      io.to(room).emit(type, { ...event, timestamp })
      const sockets = io.sockets.adapter.rooms.get(room)
      const count = sockets ? sockets.size : 0
      console.log(`[${type}] → customer:${userId} (${count} recipients)`)
      return count
    }
  }

  // Admin events → broadcast to admin:global room
  if (type.startsWith('admin:')) {
    const room = 'admin:global'
    io.to(room).emit(type, { ...event, timestamp })
    const sockets = io.sockets.adapter.rooms.get(room)
    const count = sockets ? sockets.size : 0
    console.log(`[${type}] → ${room} (${count} recipients)`)
    return count
  }

  // Staff events → broadcast to agency room
  if (type.startsWith('staff:')) {
    const agencyId = event.agencyId as string
    if (agencyId) {
      const room = `agency:${agencyId}`
      io.to(room).emit(type, { ...event, timestamp })
      const sockets = io.sockets.adapter.rooms.get(room)
      const count = sockets ? sockets.size : 0
      console.log(`[${type}] → agency:${agencyId} (${count} recipients)`)
      return count
    }
  }

  return 0
}

// ─── Socket.IO Connection Handling ───────────────────────────────────────────

io.on('connection', (socket) => {
  totalConnections++
  console.log(`⚡ Client connected: ${socket.id} (total: ${io.engine.clientsCount})`)

  // Generic room join/leave
  socket.on('join:room', (room: string) => {
    if (room && typeof room === 'string') {
      socket.join(room)
      console.log(`⚡ ${socket.id} joined ${room}`)
    }
  })

  socket.on('leave:room', (room: string) => {
    if (room && typeof room === 'string') {
      socket.leave(room)
      console.log(`⚡ ${socket.id} left ${room}`)
    }
  })

  // Room management
  socket.on('join:agency', (id: string) => {
    if (id) { socket.join(`agency:${id}`); console.log(`⚡ ${socket.id} joined agency:${id}`) }
  })
  socket.on('leave:agency', (id: string) => {
    if (id) { socket.leave(`agency:${id}`); console.log(`⚡ ${socket.id} left agency:${id}`) }
  })
  socket.on('join:customer', (id: string) => {
    if (id) { socket.join(`customer:${id}`); console.log(`⚡ ${socket.id} joined customer:${id}`) }
  })
  socket.on('leave:customer', (id: string) => {
    if (id) { socket.leave(`customer:${id}`); console.log(`⚡ ${socket.id} left customer:${id}`) }
  })
  socket.on('join:kiosk', (id: string) => {
    if (id) { socket.join(`kiosk:${id}`); console.log(`⚡ ${socket.id} joined kiosk:${id}`) }
  })
  socket.on('leave:kiosk', (id: string) => {
    if (id) { socket.leave(`kiosk:${id}`); console.log(`⚡ ${socket.id} left kiosk:${id}`) }
  })
  socket.on('join:admin', () => {
    socket.join('admin:global'); console.log(`⚡ ${socket.id} joined admin:global`)
  })
  socket.on('leave:admin', () => {
    socket.leave('admin:global'); console.log(`⚡ ${socket.id} left admin:global`)
  })

  socket.on('disconnect', (reason) => {
    console.log(`⚡ Disconnected: ${socket.id} (${reason}) (remaining: ${io.engine.clientsCount})`)
  })
})

// ─── Start Server ────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`🚀 @blasti/api server running on port ${PORT}`)
  console.log(`   API:    http://localhost:${PORT}/`)
  console.log(`   Health: http://localhost:${PORT}/health`)
  console.log(`   Stats:  http://localhost:${PORT}/stats`)
  console.log(`   Emit:   POST http://localhost:${PORT}/emit`)
  console.log(`   Batch:  POST http://localhost:${PORT}/emit-batch`)
})

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

process.on('SIGTERM', () => { io.close(); httpServer.close(); process.exit(0) })
process.on('SIGINT', () => { io.close(); httpServer.close(); process.exit(0) })
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason)
})
