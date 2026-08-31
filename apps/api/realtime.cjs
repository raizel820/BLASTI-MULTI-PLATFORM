/**
 * BLASTI Realtime Service — Socket.IO Server (Node.js CJS)
 * Port: 3003
 *
 * Handles real-time event broadcasting for:
 * - Queue events (called, joined, completed, paused, resumed, etc.)
 * - Reservation events (created, updated, cancelled)
 * - Notification events (new, turn-approaching, your-turn)
 * - Kiosk events (update)
 * - Agency events (updated)
 * - Staff events (updated)
 * - Device events (registered)
 * - Admin events (stats-updated, user-created)
 */

const { Server } = require('socket.io')
const { createServer } = require('http')

const PORT = 3003

const httpServer = createServer()
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingInterval: 25000,
  pingTimeout: 20000,
  allowUpgrades: true,
  maxHttpBufferSize: 1e6,
})

// ─── Stats ──────────────────────────────────────────────────────────────────

let totalConnections = 0
let totalEventsEmitted = 0

// ─── HTTP Request Handler ────────────────────────────────────────────────────

httpServer.on('request', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  const url = req.url || '/'
  const method = req.method || 'GET'

  if (method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  // Health check
  if (method === 'GET' && url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      status: 'ok',
      service: 'blasti-realtime',
      version: '2.0.0',
      connections: io.engine.clientsCount,
      totalConnections,
      totalEventsEmitted,
      uptime: Math.floor(process.uptime()),
      rooms: io.sockets.adapter.rooms.size,
    }))
    return
  }

  // Stats
  if (method === 'GET' && url === '/stats') {
    const roomList = Array.from(io.sockets.adapter.rooms.keys())
    const roomCounts = {}
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

  // Emit endpoint
  if (method === 'POST' && url === '/emit') {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
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
      } catch (e) {
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

  // Batch emit
  if (method === 'POST' && url === '/emit-batch') {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
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
      } catch (e) {
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
})

// ─── Event Broadcasting ──────────────────────────────────────────────────────

function broadcastEvent(event) {
  const type = event.type
  const timestamp = Date.now()
  totalEventsEmitted++

  if (!type) return 0

  // Queue events → agency room
  if (type.startsWith('queue:')) {
    const agencyId = event.agencyId
    if (agencyId) {
      const room = `agency:${agencyId}`
      io.to(room).emit(type, { ...event, timestamp })
      const sockets = io.sockets.adapter.rooms.get(room)
      const count = sockets ? sockets.size : 0
      console.log(`[${type}] → ${room} (${count} recipients)`)
      return count
    }
  }

  // Reservation events → agency room + specific customer
  if (type.startsWith('reservation:')) {
    const agencyId = event.agencyId
    const userId = event.userId
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

  // Notification events → specific user room
  if (type.startsWith('notification:')) {
    const userId = event.userId
    if (userId) {
      const room = `customer:${userId}`
      io.to(room).emit(type, { ...event, timestamp })
      const sockets = io.sockets.adapter.rooms.get(room)
      const count = sockets ? sockets.size : 0
      console.log(`[${type}] → customer:${userId} (${count} recipients)`)
      return count
    }
  }

  // Kiosk events → kiosk room for agency
  if (type === 'kiosk:update') {
    const agencyId = event.agencyId
    if (agencyId) {
      const room = `kiosk:${agencyId}`
      io.to(room).emit(type, { ...event, timestamp })
      const sockets = io.sockets.adapter.rooms.get(room)
      const count = sockets ? sockets.size : 0
      console.log(`[kiosk:update] → kiosk:${agencyId} (${count} recipients)`)
      return count
    }
  }

  // Agency events → agency room
  if (type.startsWith('agency:')) {
    const agencyId = event.agencyId
    if (agencyId) {
      const room = `agency:${agencyId}`
      io.to(room).emit(type, { ...event, timestamp })
      const sockets = io.sockets.adapter.rooms.get(room)
      const count = sockets ? sockets.size : 0
      console.log(`[${type}] → agency:${agencyId} (${count} recipients)`)
      return count
    }
  }

  // Device events → specific customer room
  if (type.startsWith('device:')) {
    const userId = event.userId
    if (userId) {
      const room = `customer:${userId}`
      io.to(room).emit(type, { ...event, timestamp })
      const sockets = io.sockets.adapter.rooms.get(room)
      const count = sockets ? sockets.size : 0
      console.log(`[${type}] → customer:${userId} (${count} recipients)`)
      return count
    }
  }

  // Admin events → admin:global room
  if (type.startsWith('admin:')) {
    const room = 'admin:global'
    io.to(room).emit(type, { ...event, timestamp })
    const sockets = io.sockets.adapter.rooms.get(room)
    const count = sockets ? sockets.size : 0
    console.log(`[${type}] → ${room} (${count} recipients)`)
    return count
  }

  // Staff events → agency room
  if (type.startsWith('staff:')) {
    const agencyId = event.agencyId
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

  socket.on('join:agency', (id) => { if (id) { socket.join(`agency:${id}`); console.log(`⚡ ${socket.id} joined agency:${id}`) } })
  socket.on('leave:agency', (id) => { if (id) { socket.leave(`agency:${id}`); console.log(`⚡ ${socket.id} left agency:${id}`) } })
  socket.on('join:customer', (id) => { if (id) { socket.join(`customer:${id}`); console.log(`⚡ ${socket.id} joined customer:${id}`) } })
  socket.on('leave:customer', (id) => { if (id) { socket.leave(`customer:${id}`); console.log(`⚡ ${socket.id} left customer:${id}`) } })
  socket.on('join:kiosk', (id) => { if (id) { socket.join(`kiosk:${id}`); console.log(`⚡ ${socket.id} joined kiosk:${id}`) } })
  socket.on('leave:kiosk', (id) => { if (id) { socket.leave(`kiosk:${id}`); console.log(`⚡ ${socket.id} left kiosk:${id}`) } })
  socket.on('join:admin', () => { socket.join('admin:global'); console.log(`⚡ ${socket.id} joined admin:global`) })
  socket.on('leave:admin', () => { socket.leave('admin:global'); console.log(`⚡ ${socket.id} left admin:global`) })

  socket.on('disconnect', (reason) => {
    console.log(`⚡ Disconnected: ${socket.id} (${reason}) (remaining: ${io.engine.clientsCount})`)
  })
})

// ─── Start Server ────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`🚀 BLASTI Realtime Service v2.0 running on port ${PORT}`)
  console.log(`   Health: http://localhost:${PORT}/health`)
  console.log(`   Stats:  http://localhost:${PORT}/stats`)
  console.log(`   Emit:   POST http://localhost:${PORT}/emit`)
  console.log(`   Batch:  POST http://localhost:${PORT}/emit-batch`)
})

process.on('SIGTERM', () => { io.close(); httpServer.close(); process.exit(0) })
process.on('SIGINT', () => { io.close(); httpServer.close(); process.exit(0) })
process.on('unhandledRejection', (reason) => { console.error('Unhandled rejection:', reason) })
