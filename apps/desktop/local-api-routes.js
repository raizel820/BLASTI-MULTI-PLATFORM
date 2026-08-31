/**
 * BLASTI Desktop — Local API Routes
 *
 * Provides 24 Express routes for the desktop's local API server (port 3080).
 * When the internet is off, kiosks and phones on the LAN use these routes
 * instead of the cloud API. All routes read/write from better-sqlite3 via
 * the `db` object passed in.
 *
 * Architecture:
 *   Kiosk / Phone  ──LAN──►  POST /api/reservations  (this file, port 3080)
 *                                      │
 *                                      ▼
 *                              better-sqlite3 (db)
 *                                      │
 *                              cloud-sync loop
 *                                      ▼
 *                              Cloud /api/* (when internet returns)
 *
 * Tables used (defined in local-db.js SYNC_TABLES):
 *   agencies, services, branches, counters, reservations,
 *   notifications, queue_settings, reviews (auto-created on mount)
 *
 * Column storage conventions (matching WatermelonDB sync protocol):
 *   - Booleans stored as INTEGER 0/1
 *   - Timestamps stored as INTEGER (epoch ms)
 *   - All tables have: id (TEXT PK), created_at, updated_at, deleted_at (tombstone)
 */

const crypto = require('crypto');

// ─── Constants ──────────────────────────────────────────────────────────────

/**
 * Valid reservation statuses for validation.
 */
const VALID_STATUSES = ['WAITING', 'CALLED', 'SERVING', 'COMPLETED', 'CANCELLED', 'NO_SHOW'];

/**
 * Active queue statuses (used for filtering active reservations).
 */
const ACTIVE_STATUSES = ['WAITING', 'CALLED', 'SERVING'];

/**
 * Completed/cancelled statuses for history queries.
 */
const HISTORY_STATUSES = ['COMPLETED', 'CANCELLED', 'NO_SHOW'];

// ─── Helper: snake_case to camelCase ─────────────────────────────────────────

/**
 * Convert a snake_case object to camelCase for JSON API responses.
 * Skips the `id` field (already camelCase).
 * @param {object} row - Raw DB row
 * @returns {object}
 */
function toCamelCase(row) {
  if (!row) return null;
  const result = {};
  for (const [key, value] of Object.entries(row)) {
    // Convert snake_case keys to camelCase
    const camel = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    result[camel] = value;
  }
  return result;
}

/**
 * Convert an array of snake_case rows to camelCase.
 * @param {Array} rows
 * @returns {Array}
 */
function toCamelCaseAll(rows) {
  if (!rows || !Array.isArray(rows)) return [];
  return rows.map(toCamelCase);
}

// ─── Main Export ──────────────────────────────────────────────────────────────

/**
 * Mount all local API routes on the Express app.
 *
 * @param {import('express').Express} app - Express instance
 * @param {object} deps
 * @param {import('better-sqlite3').Database} deps.db - Raw better-sqlite3 instance
 * @param {object} deps.localDb - local-db.js helper module (getQueueSettings, updateQueueSettings, ensureQueueSettings, etc.)
 * @param {object} deps.cloudSync - cloud-sync.js module (for triggering sync)
 * @param {import('socket.io').Server} deps.io - Socket.IO server instance
 * @param {string} deps.JWT_SECRET - HMAC secret for JWT verification
 * @param {boolean} deps.isDev - Whether running in development mode
 */
function mountLocalApiRoutes(app, { db, localDb, cloudSync, io, JWT_SECRET, isDev }) {
  if (!db) {
    console.warn('[LocalAPI] No database instance provided — routes will not be mounted');
    return;
  }

  console.log('[LocalAPI] Mounting 24 local API routes on port 3080');

  // ── Auto-create reviews table if not exists ──────────────────────────────
  // The reviews table is used by the rating route but isn't in the core
  // SYNC_TABLES defined in local-db.js. We create it here on mount.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS reviews (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        agency_id TEXT NOT NULL,
        reservation_id TEXT,
        rating INTEGER NOT NULL CHECK(rating >= 1 AND rating <= 5),
        comment TEXT DEFAULT '',
        reply_text TEXT DEFAULT NULL,
        replied_at INTEGER DEFAULT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER DEFAULT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_reviews_agency ON reviews(agency_id);
      CREATE INDEX IF NOT EXISTS idx_reviews_user ON reviews(user_id);
      CREATE INDEX IF NOT EXISTS idx_reviews_reservation ON reviews(reservation_id);
    `);
    console.log('[LocalAPI] Reviews table verified/created');
  } catch (err) {
    console.error('[LocalAPI] Failed to create reviews table:', err.message);
  }

  // ── JSON body parser for all /api/ routes ──────────────────────────────
  app.use('/api', require('express').json({ limit: '5mb' }));

  // ── CORS preflight handler (redundant safety — main.js also sets CORS) ──
  app.use('/api', (req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }
    next();
  });

  // ── JWT Auth Middleware ─────────────────────────────────────────────────
  /**
   * Verify a JWT token using HS256 HMAC (same pattern as main.js).
   * Extracts payload with user identity (sub/userId/id, role, agencyId).
   *
   * @param {string} token - Raw JWT string
   * @returns {object|null} Decoded payload or null on failure
   */
  function verifyJwt(token) {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;

      const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());

      // Must be HS256
      if (header.alg !== 'HS256') return null;

      // Verify HMAC signature
      const signingInput = `${parts[0]}.${parts[1]}`;
      const signature = crypto
        .createHmac('sha256', JWT_SECRET)
        .update(signingInput)
        .digest('base64url');

      if (signature !== parts[2]) return null;

      // Check expiry
      if (payload.exp && payload.exp * 1000 < Date.now()) return null;

      return payload;
    } catch {
      return null;
    }
  }

  /**
   * Express middleware that extracts and verifies a JWT from the request.
   * Token can come from:
   *   1. Authorization header: "Bearer <token>"
   *   2. Query parameter: ?token=<token>
   *
   * On success, attaches `req.user` with:
   *   { id, role, agencyId }
   *
   * On failure, returns 401.
   */
  function authMiddleware(req, res, next) {
    // Trust localhost/127.0.0.1 requests without auth — the desktop app itself
    // makes requests to the LAN server from its embedded BrowserWindow.
    const remoteAddr = req.ip || req.connection?.remoteAddress || '';
    const isLocal = remoteAddr === '::1' || remoteAddr === '127.0.0.1' || remoteAddr === '::ffff:127.0.0.1';
    const referer = req.headers.referer || '';
    const isLocalReferer = referer.includes('://localhost:') || referer.includes('://127.0.0.1:');

    if (isLocal || isLocalReferer) {
      // Local request — skip auth, set minimal user context
      // The desktop app IS the LAN server; it has full data access
      req.user = { id: 'local', role: 'AGENCY_ADMIN', agencyId: null };
      return next();
    }

    // Extract token from header or query
    let token = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7);
    } else if (req.query && req.query.token) {
      token = req.query.token;
    }

    if (!token) {
      return res.status(401).json({ error: 'Authentication required — provide a valid JWT token' });
    }

    const payload = verifyJwt(token);
    if (!payload) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // Attach normalized user object
    req.user = {
      id: payload.sub || payload.userId || payload.id,
      role: payload.role || payload['https://blasti.app/role'] || 'CUSTOMER',
      agencyId: payload.agencyId || payload['https://blasti.app/agencyId'] || null,
    };

    next();
  }

  // ── Helper: emit Socket.IO event with error safety ──────────────────────
  function emitEvent(eventName, data) {
    if (io) {
      try {
        io.emit(eventName, data);
      } catch (err) {
        console.error(`[LocalAPI] Failed to emit ${eventName}:`, err.message);
      }
    }
  }

  // ── Helper: get today's date range (epoch ms) ──────────────────────────
  function getTodayRange() {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0).getTime();
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime();
    return { start, end };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  QUEUE ROUTES (5 routes)
  // ═══════════════════════════════════════════════════════════════════════════

  // ─── POST /api/queue/call-next ────────────────────────────────────────────
  // Find the next WAITING reservation, set to CALLED, update queue_settings.
  app.post('/api/queue/call-next', authMiddleware, (req, res) => {
    try {
      const { agencyId, counterId } = req.body;
      if (!agencyId) {
        return res.status(400).json({ error: 'agencyId is required' });
      }

      // Ensure queue settings exist for this agency
      localDb.ensureQueueSettings(agencyId);

      // Find the next WAITING reservation (oldest first by joined_at)
      const next = db.prepare(`
        SELECT * FROM reservations
        WHERE agency_id = ? AND status = 'WAITING' AND deleted_at IS NULL
        ORDER BY joined_at ASC
        LIMIT 1
      `).get(agencyId);

      if (!next) {
        return res.status(404).json({ error: 'No waiting reservations', queueEmpty: true });
      }

      const now = Date.now();

      // Update reservation to CALLED
      db.prepare(`
        UPDATE reservations
        SET status = 'CALLED', called_at = ?, counter_id = ?, updated_at = ?
        WHERE id = ?
      `).run(now, counterId || null, now, next.id);

      // Increment current_serving_number in queue_settings
      const settings = localDb.getQueueSettings(agencyId);
      if (settings) {
        const newServing = (settings.current_serving_number || 0) + 1;
        localDb.updateQueueSettings(agencyId, {
          current_serving_number: newServing,
        });
      }

      // Fetch the updated reservation
      const updated = db.prepare(
        'SELECT * FROM reservations WHERE id = ? AND deleted_at IS NULL'
      ).get(next.id);

      // Emit real-time event
      emitEvent('queue:called', {
        reservation: toCamelCase(updated),
        agencyId,
        counterId,
        timestamp: now,
      });

      res.json({
        success: true,
        reservation: toCamelCase(updated),
        currentServingNumber: settings ? (settings.current_serving_number || 0) + 1 : 1,
      });
    } catch (err) {
      console.error('[LocalAPI] POST /api/queue/call-next error:', err.message);
      res.status(500).json({ error: 'Failed to call next', details: err.message });
    }
  });

  // ─── PUT /api/queue/pause ────────────────────────────────────────────────
  app.put('/api/queue/pause', authMiddleware, (req, res) => {
    try {
      const { agencyId } = req.body;
      if (!agencyId) {
        return res.status(400).json({ error: 'agencyId is required' });
      }

      localDb.ensureQueueSettings(agencyId);
      const now = Date.now();

      localDb.updateQueueSettings(agencyId, {
        is_paused: 1,
        paused_at: now,
      });

      emitEvent('queue:paused', { agencyId, pausedAt: now });

      const settings = localDb.getQueueSettings(agencyId);
      res.json({ success: true, settings: toCamelCase(settings) });
    } catch (err) {
      console.error('[LocalAPI] PUT /api/queue/pause error:', err.message);
      res.status(500).json({ error: 'Failed to pause queue', details: err.message });
    }
  });

  // ─── PUT /api/queue/resume ──────────────────────────────────────────────
  app.put('/api/queue/resume', authMiddleware, (req, res) => {
    try {
      const { agencyId } = req.body;
      if (!agencyId) {
        return res.status(400).json({ error: 'agencyId is required' });
      }

      localDb.ensureQueueSettings(agencyId);

      localDb.updateQueueSettings(agencyId, {
        is_paused: 0,
        paused_at: null,
      });

      emitEvent('queue:resumed', { agencyId });

      const settings = localDb.getQueueSettings(agencyId);
      res.json({ success: true, settings: toCamelCase(settings) });
    } catch (err) {
      console.error('[LocalAPI] PUT /api/queue/resume error:', err.message);
      res.status(500).json({ error: 'Failed to resume queue', details: err.message });
    }
  });

  // ─── GET /api/queue/status ───────────────────────────────────────────────
  // Returns full queue status: settings, counts by status, waiting list, currently serving.
  app.get('/api/queue/status', authMiddleware, (req, res) => {
    try {
      const { agencyId } = req.query;
      if (!agencyId) {
        return res.status(400).json({ error: 'agencyId query param is required' });
      }

      // Ensure queue settings exist
      localDb.ensureQueueSettings(agencyId);
      const settings = localDb.getQueueSettings(agencyId);

      // Count by status
      const statusCounts = {};
      for (const status of VALID_STATUSES) {
        const row = db.prepare(`
          SELECT COUNT(*) as cnt FROM reservations
          WHERE agency_id = ? AND status = ? AND deleted_at IS NULL
        `).get(agencyId, status);
        statusCounts[status] = row ? row.cnt : 0;
      }

      // Total active
      const totalActive = ACTIVE_STATUSES.reduce((sum, s) => sum + (statusCounts[s] || 0), 0);

      // Waiting list (ordered by joined_at)
      const waitingList = db.prepare(`
        SELECT * FROM reservations
        WHERE agency_id = ? AND status = 'WAITING' AND deleted_at IS NULL
        ORDER BY joined_at ASC
      `).all(agencyId);

      // Currently serving (CALLED + SERVING)
      const currentlyServing = db.prepare(`
        SELECT * FROM reservations
        WHERE agency_id = ? AND status IN ('CALLED', 'SERVING') AND deleted_at IS NULL
        ORDER BY called_at ASC
      `).all(agencyId);

      res.json({
        settings: toCamelCase(settings),
        isPaused: settings ? (settings.is_paused === 1) : false,
        counts: statusCounts,
        totalActive,
        waitingList: toCamelCaseAll(waitingList),
        currentlyServing: toCamelCaseAll(currentlyServing),
      });
    } catch (err) {
      console.error('[LocalAPI] GET /api/queue/status error:', err.message);
      res.status(500).json({ error: 'Failed to get queue status', details: err.message });
    }
  });

  // ─── GET /api/queue/track ────────────────────────────────────────────────
  // Track a reservation by ID or ticket_number (display_number).
  app.get('/api/queue/track', authMiddleware, (req, res) => {
    try {
      const { id, ticketNumber } = req.query;

      let reservation = null;

      if (id) {
        reservation = db.prepare(
          'SELECT * FROM reservations WHERE id = ? AND deleted_at IS NULL'
        ).get(id);
      } else if (ticketNumber) {
        reservation = db.prepare(
          'SELECT * FROM reservations WHERE display_number = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1'
        ).get(ticketNumber);
      }

      if (!reservation) {
        return res.status(404).json({ error: 'Reservation not found' });
      }

      // Calculate position in queue (if still WAITING)
      let position = null;
      if (reservation.status === 'WAITING') {
        const posRow = db.prepare(`
          SELECT COUNT(*) as pos FROM reservations
          WHERE agency_id = ? AND status = 'WAITING' AND joined_at <= ? AND deleted_at IS NULL
        `).get(reservation.agency_id, reservation.joined_at);
        position = posRow ? posRow.pos : null;
      }

      res.json({
        reservation: toCamelCase(reservation),
        position,
      });
    } catch (err) {
      console.error('[LocalAPI] GET /api/queue/track error:', err.message);
      res.status(500).json({ error: 'Failed to track reservation', details: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  RESERVATION ROUTES (13 routes)
  // ═══════════════════════════════════════════════════════════════════════════

  // ─── POST /api/reservations ──────────────────────────────────────────────
  // Create a reservation with auto-generated queue_number.
  app.post('/api/reservations', authMiddleware, (req, res) => {
    try {
      const {
        agencyId, serviceId, userId,
        preferredTime, fixedTimeEnabled,
        walkInCustomerName,
      } = req.body;

      if (!agencyId || !serviceId) {
        return res.status(400).json({ error: 'agencyId and serviceId are required' });
      }

      const now = Date.now();

      // Ensure queue settings exist and get next queue number
      localDb.ensureQueueSettings(agencyId);
      const settings = localDb.getQueueSettings(agencyId);
      const nextNumber = (settings ? settings.last_issued_number : 0) + 1;

      // Get service prefix for display_number
      const service = db.prepare(
        'SELECT * FROM services WHERE id = ? AND deleted_at IS NULL'
      ).get(serviceId);
      const prefix = service ? (service.prefix || 'A') : 'A';
      const displayNumber = `${prefix}${String(nextNumber).padStart(3, '0')}`;

      // Estimate wait time (use agency's average_service_time or default 10 min)
      const agency = db.prepare(
        'SELECT * FROM agencies WHERE id = ? AND deleted_at IS NULL'
      ).get(agencyId);
      const avgServiceTime = agency ? (agency.average_service_time || 10) : 10;

      // Count current waiting to estimate
      const waitingCount = db.prepare(`
        SELECT COUNT(*) as cnt FROM reservations
        WHERE agency_id = ? AND status IN ('WAITING', 'CALLED', 'SERVING') AND deleted_at IS NULL
      `).get(agencyId);
      const estimatedWait = (waitingCount ? waitingCount.cnt : 0) * avgServiceTime;

      const id = require('crypto').randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

      // Insert reservation
      db.prepare(`
        INSERT INTO reservations (
          id, user_id, agency_id, service_id, queue_number, display_number,
          status, estimated_wait, joined_at, preferred_time, fixed_time_enabled,
          is_walk_in, walk_in_customer_name, offline_created_at,
          created_at, updated_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'WAITING', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `).run(
        id,
        userId || null,
        agencyId,
        serviceId,
        nextNumber,
        displayNumber,
        estimatedWait,
        now,
        preferredTime || null,
        fixedTimeEnabled ? 1 : 0,
        0, // is_walk_in
        walkInCustomerName || null,
        now,
        now,
        now,
      );

      // Update last_issued_number
      localDb.updateQueueSettings(agencyId, {
        last_issued_number: nextNumber,
      });

      // Fetch the created reservation
      const created = db.prepare(
        'SELECT * FROM reservations WHERE id = ? AND deleted_at IS NULL'
      ).get(id);

      emitEvent('queue:joined', {
        reservation: toCamelCase(created),
        agencyId,
        timestamp: now,
      });

      res.status(201).json({
        success: true,
        reservation: toCamelCase(created),
      });
    } catch (err) {
      console.error('[LocalAPI] POST /api/reservations error:', err.message);
      res.status(500).json({ error: 'Failed to create reservation', details: err.message });
    }
  });

  // ─── GET /api/reservations/active ──────────────────────────────────────
  // Active reservations (WAITING, CALLED, SERVING) for an agency or user.
  app.get('/api/reservations/active', authMiddleware, (req, res) => {
    try {
      const { agencyId, userId } = req.query;

      const whereParts = ['status IN (?, ?, ?)', 'deleted_at IS NULL'];
      const params = ['WAITING', 'CALLED', 'SERVING'];

      if (agencyId) {
        whereParts.push('agency_id = ?');
        params.push(agencyId);
      }
      if (userId) {
        whereParts.push('user_id = ?');
        params.push(userId);
      }

      const rows = db.prepare(
        `SELECT * FROM reservations WHERE ${whereParts.join(' AND ')} ORDER BY joined_at ASC`
      ).all(...params);

      res.json({
        success: true,
        reservations: toCamelCaseAll(rows),
        count: rows.length,
      });
    } catch (err) {
      console.error('[LocalAPI] GET /api/reservations/active error:', err.message);
      res.status(500).json({ error: 'Failed to get active reservations', details: err.message });
    }
  });

  // ─── GET /api/reservations/history ──────────────────────────────────────
  // Completed/cancelled history for an agency or user.
  app.get('/api/reservations/history', authMiddleware, (req, res) => {
    try {
      const { agencyId, userId, limit = 50, offset = 0 } = req.query;

      const whereParts = ['status IN (?, ?, ?)', 'deleted_at IS NULL'];
      const params = ['COMPLETED', 'CANCELLED', 'NO_SHOW'];

      if (agencyId) {
        whereParts.push('agency_id = ?');
        params.push(agencyId);
      }
      if (userId) {
        whereParts.push('user_id = ?');
        params.push(userId);
      }

      // Apply limit and offset (sanitize to integers)
      const limitInt = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
      const offsetInt = Math.max(parseInt(offset, 10) || 0, 0);

      const rows = db.prepare(
        `SELECT * FROM reservations WHERE ${whereParts.join(' AND ')} ORDER BY updated_at DESC LIMIT ? OFFSET ?`
      ).all(...params, limitInt, offsetInt);

      // Total count
      const countRow = db.prepare(
        `SELECT COUNT(*) as cnt FROM reservations WHERE ${whereParts.join(' AND ')}`
      ).get(...params);

      res.json({
        success: true,
        reservations: toCamelCaseAll(rows),
        total: countRow ? countRow.cnt : 0,
        limit: limitInt,
        offset: offsetInt,
      });
    } catch (err) {
      console.error('[LocalAPI] GET /api/reservations/history error:', err.message);
      res.status(500).json({ error: 'Failed to get history', details: err.message });
    }
  });

  // ─── GET /api/reservations/agency ───────────────────────────────────────
  // All reservations for an agency, optionally filtered by date.
  app.get('/api/reservations/agency', authMiddleware, (req, res) => {
    try {
      const { agencyId, date, status, limit = 100 } = req.query;

      if (!agencyId) {
        return res.status(400).json({ error: 'agencyId is required' });
      }

      const whereParts = ['agency_id = ?', 'deleted_at IS NULL'];
      const params = [agencyId];

      if (date) {
        // Parse date as YYYY-MM-DD and get range
        const dateParts = date.split('-');
        if (dateParts.length === 3) {
          const [y, m, d] = dateParts.map(Number);
          const dayStart = new Date(y, m - 1, d, 0, 0, 0).getTime();
          const dayEnd = new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
          whereParts.push('joined_at >= ? AND joined_at <= ?');
          params.push(dayStart, dayEnd);
        }
      }

      if (status && VALID_STATUSES.includes(status)) {
        whereParts.push('status = ?');
        params.push(status);
      }

      const limitInt = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);

      const rows = db.prepare(
        `SELECT * FROM reservations WHERE ${whereParts.join(' AND ')} ORDER BY joined_at DESC LIMIT ?`
      ).all(...params, limitInt);

      res.json({
        success: true,
        reservations: toCamelCaseAll(rows),
        count: rows.length,
      });
    } catch (err) {
      console.error('[LocalAPI] GET /api/reservations/agency error:', err.message);
      res.status(500).json({ error: 'Failed to get agency reservations', details: err.message });
    }
  });

  // ─── POST /api/reservations/import-walk-in ──────────────────────────────
  // Create a walk-in reservation (no user account).
  app.post('/api/reservations/import-walk-in', authMiddleware, (req, res) => {
    try {
      const { agencyId, serviceId, customerName, notes } = req.body;

      if (!agencyId || !serviceId) {
        return res.status(400).json({ error: 'agencyId and serviceId are required' });
      }

      const now = Date.now();

      // Ensure queue settings exist
      localDb.ensureQueueSettings(agencyId);
      const settings = localDb.getQueueSettings(agencyId);
      const nextNumber = (settings ? settings.last_issued_number : 0) + 1;

      // Get service prefix
      const service = db.prepare(
        'SELECT * FROM services WHERE id = ? AND deleted_at IS NULL'
      ).get(serviceId);
      const prefix = service ? (service.prefix || 'A') : 'A';
      const displayNumber = `${prefix}${String(nextNumber).padStart(3, '0')}`;

      // Estimate wait
      const waitingCount = db.prepare(`
        SELECT COUNT(*) as cnt FROM reservations
        WHERE agency_id = ? AND status IN ('WAITING', 'CALLED', 'SERVING') AND deleted_at IS NULL
      `).get(agencyId);
      const estimatedWait = (waitingCount ? waitingCount.cnt : 0) * 10;

      const id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

      db.prepare(`
        INSERT INTO reservations (
          id, agency_id, service_id, queue_number, display_number,
          status, estimated_wait, joined_at, is_walk_in, walk_in_customer_name,
          offline_created_at, created_at, updated_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, 'WAITING', ?, ?, 1, ?, ?, ?, ?, NULL)
      `).run(
        id, agencyId, serviceId, nextNumber, displayNumber,
        estimatedWait, now, customerName || null, now, now, now,
      );

      localDb.updateQueueSettings(agencyId, {
        last_issued_number: nextNumber,
      });

      const created = db.prepare(
        'SELECT * FROM reservations WHERE id = ? AND deleted_at IS NULL'
      ).get(id);

      emitEvent('queue:walk-in', {
        reservation: toCamelCase(created),
        agencyId,
        timestamp: now,
      });

      res.status(201).json({
        success: true,
        reservation: toCamelCase(created),
      });
    } catch (err) {
      console.error('[LocalAPI] POST /api/reservations/import-walk-in error:', err.message);
      res.status(500).json({ error: 'Failed to import walk-in', details: err.message });
    }
  });

  // ─── DELETE /api/reservations/cancel-active ────────────────────────────
  // Cancel all active reservations for a user.
  app.delete('/api/reservations/cancel-active', authMiddleware, (req, res) => {
    try {
      const { userId, agencyId } = req.query;
      if (!userId) {
        return res.status(400).json({ error: 'userId is required' });
      }

      const now = Date.now();
      const whereParts = ['user_id = ?', 'status IN (?, ?, ?)', 'deleted_at IS NULL'];
      const params = [userId, 'WAITING', 'CALLED', 'SERVING'];

      if (agencyId) {
        whereParts.push('agency_id = ?');
        params.push(agencyId);
      }

      // Find matching reservations first
      const toCancel = db.prepare(
        `SELECT * FROM reservations WHERE ${whereParts.join(' AND ')}`
      ).all(...params);

      if (toCancel.length === 0) {
        return res.json({ success: true, cancelled: 0, message: 'No active reservations found' });
      }

      // Update all to CANCELLED
      const result = db.prepare(`
        UPDATE reservations
        SET status = 'CANCELLED', cancelled_at = ?, updated_at = ?
        WHERE user_id = ? AND status IN ('WAITING', 'CALLED', 'SERVING') AND deleted_at IS NULL
        ${agencyId ? 'AND agency_id = ?' : ''}
      `).run(now, now, userId, ...(agencyId ? [agencyId] : []));

      // Emit for each cancelled
      for (const r of toCancel) {
        emitEvent('queue:cancelled', {
          reservation: toCamelCase(r),
          agencyId: r.agency_id,
          timestamp: now,
        });
      }

      res.json({
        success: true,
        cancelled: result.changes || toCancel.length,
        reservations: toCamelCaseAll(toCancel),
      });
    } catch (err) {
      console.error('[LocalAPI] DELETE /api/reservations/cancel-active error:', err.message);
      res.status(500).json({ error: 'Failed to cancel reservations', details: err.message });
    }
  });

  // ─── POST /api/reservations/batch-complete ──────────────────────────────
  // Complete multiple reservations at once.
  app.post('/api/reservations/batch-complete', authMiddleware, (req, res) => {
    try {
      const { ids } = req.body;
      if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ error: 'ids array is required' });
      }

      // Sanitize: limit batch size
      if (ids.length > 100) {
        return res.status(400).json({ error: 'Maximum 100 reservations per batch' });
      }

      const now = Date.now();
      let completed = 0;

      // Use a transaction for atomicity
      const batchComplete = db.transaction((reservationIds) => {
        const stmt = db.prepare(`
          UPDATE reservations
          SET status = 'COMPLETED', completed_at = ?, updated_at = ?
          WHERE id = ? AND status IN ('CALLED', 'SERVING') AND deleted_at IS NULL
        `);

        const completedReservations = [];

        for (const id of reservationIds) {
          const result = stmt.run(now, now, id);
          if (result.changes > 0) {
            completed++;
            // Fetch updated row for the event
            const row = db.prepare(
              'SELECT * FROM reservations WHERE id = ? AND deleted_at IS NULL'
            ).get(id);
            if (row) completedReservations.push(row);
          }
        }

        return completedReservations;
      });

      const completedRows = batchComplete(ids);

      // Emit events
      for (const row of completedRows) {
        emitEvent('queue:completed', {
          reservation: toCamelCase(row),
          agencyId: row.agency_id,
          timestamp: now,
        });
      }

      res.json({
        success: true,
        completed,
        requested: ids.length,
        reservations: toCamelCaseAll(completedRows),
      });
    } catch (err) {
      console.error('[LocalAPI] POST /api/reservations/batch-complete error:', err.message);
      res.status(500).json({ error: 'Failed to batch complete', details: err.message });
    }
  });

  // ─── POST /api/reservations/:id/postpone ─────────────────────────────────
  // Postpone a reservation by +30 minutes.
  app.post('/api/reservations/:id/postpone', authMiddleware, (req, res) => {
    try {
      const { id } = req.params;
      const now = Date.now();

      // Get current reservation
      const reservation = db.prepare(
        'SELECT * FROM reservations WHERE id = ? AND deleted_at IS NULL'
      ).get(id);

      if (!reservation) {
        return res.status(404).json({ error: 'Reservation not found' });
      }

      if (!['WAITING', 'CALLED'].includes(reservation.status)) {
        return res.status(400).json({
          error: 'Cannot postpone — reservation must be WAITING or CALLED',
        });
      }

      const postponeMinutes = req.body.minutes || 30;
      const thirtyMinutesMs = postponeMinutes * 60 * 1000;
      const newPreferredTime = now + thirtyMinutesMs;

      // Update reservation
      db.prepare(`
        UPDATE reservations
        SET preferred_time = ?,
            postpone_count = postpone_count + 1,
            updated_at = ?
        WHERE id = ?
      `).run(newPreferredTime, now, id);

      // If it was CALLED, move back to WAITING so it can be called again later
      if (reservation.status === 'CALLED') {
        db.prepare(`
          UPDATE reservations
          SET status = 'WAITING', called_at = NULL, counter_id = NULL, updated_at = ?
          WHERE id = ?
        `).run(now, id);
      }

      const updated = db.prepare(
        'SELECT * FROM reservations WHERE id = ? AND deleted_at IS NULL'
      ).get(id);

      emitEvent('queue:postponed', {
        reservation: toCamelCase(updated),
        agencyId: reservation.agency_id,
        postponeMinutes,
        timestamp: now,
      });

      res.json({
        success: true,
        reservation: toCamelCase(updated),
      });
    } catch (err) {
      console.error('[LocalAPI] POST /api/reservations/:id/postpone error:', err.message);
      res.status(500).json({ error: 'Failed to postpone reservation', details: err.message });
    }
  });

  // ─── POST /api/reservations/:id/cancel ───────────────────────────────────
  app.post('/api/reservations/:id/cancel', authMiddleware, (req, res) => {
    try {
      const { id } = req.params;
      const now = Date.now();

      const reservation = db.prepare(
        'SELECT * FROM reservations WHERE id = ? AND deleted_at IS NULL'
      ).get(id);

      if (!reservation) {
        return res.status(404).json({ error: 'Reservation not found' });
      }

      if (['COMPLETED', 'CANCELLED'].includes(reservation.status)) {
        return res.status(400).json({
          error: `Cannot cancel — reservation is already ${reservation.status}`,
        });
      }

      db.prepare(`
        UPDATE reservations
        SET status = 'CANCELLED', cancelled_at = ?, updated_at = ?
        WHERE id = ?
      `).run(now, now, id);

      const updated = db.prepare(
        'SELECT * FROM reservations WHERE id = ? AND deleted_at IS NULL'
      ).get(id);

      emitEvent('queue:cancelled', {
        reservation: toCamelCase(updated),
        agencyId: reservation.agency_id,
        timestamp: now,
      });

      res.json({ success: true, reservation: toCamelCase(updated) });
    } catch (err) {
      console.error('[LocalAPI] POST /api/reservations/:id/cancel error:', err.message);
      res.status(500).json({ error: 'Failed to cancel reservation', details: err.message });
    }
  });

  // ─── PUT /api/reservations/:id/status ───────────────────────────────────
  // Generic status update (e.g., mark as SERVING, NO_SHOW).
  app.put('/api/reservations/:id/status', authMiddleware, (req, res) => {
    try {
      const { id } = req.params;
      const { status, counterId } = req.body;

      if (!status || !VALID_STATUSES.includes(status)) {
        return res.status(400).json({
          error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}`,
        });
      }

      const now = Date.now();

      const reservation = db.prepare(
        'SELECT * FROM reservations WHERE id = ? AND deleted_at IS NULL'
      ).get(id);

      if (!reservation) {
        return res.status(404).json({ error: 'Reservation not found' });
      }

      // Build dynamic SET clause based on target status
      const setParts = ['status = ?', 'updated_at = ?'];
      const setParams = [status, now];

      if (status === 'CALLED') {
        setParts.push('called_at = ?');
        setParams.push(now);
        if (counterId) {
          setParts.push('counter_id = ?');
          setParams.push(counterId);
        }
      } else if (status === 'COMPLETED') {
        setParts.push('completed_at = ?');
        setParams.push(now);
      } else if (status === 'CANCELLED') {
        setParts.push('cancelled_at = ?');
        setParams.push(now);
      } else if (status === 'SERVING') {
        if (counterId) {
          setParts.push('counter_id = ?');
          setParams.push(counterId);
        }
      }

      setParams.push(id);

      db.prepare(`
        UPDATE reservations
        SET ${setParts.join(', ')}
        WHERE id = ? AND deleted_at IS NULL
      `).run(...setParams);

      const updated = db.prepare(
        'SELECT * FROM reservations WHERE id = ? AND deleted_at IS NULL'
      ).get(id);

      // Emit appropriate event
      const eventName = {
        CALLED: 'queue:called',
        COMPLETED: 'queue:completed',
        CANCELLED: 'queue:cancelled',
      }[status];

      if (eventName) {
        emitEvent(eventName, {
          reservation: toCamelCase(updated),
          agencyId: reservation.agency_id,
          counterId: counterId || reservation.counter_id,
          timestamp: now,
        });
      }

      res.json({ success: true, reservation: toCamelCase(updated) });
    } catch (err) {
      console.error('[LocalAPI] PUT /api/reservations/:id/status error:', err.message);
      res.status(500).json({ error: 'Failed to update status', details: err.message });
    }
  });

  // ─── POST /api/reservations/:id/rate ─────────────────────────────────────
  // Rate a reservation 1-5 stars. Creates/updates a review record.
  app.post('/api/reservations/:id/rate', authMiddleware, (req, res) => {
    try {
      const { id } = req.params;
      const { rating, comment } = req.body;

      // Validate rating
      const ratingVal = parseInt(rating, 10);
      if (!ratingVal || ratingVal < 1 || ratingVal > 5) {
        return res.status(400).json({ error: 'Rating must be between 1 and 5' });
      }

      const now = Date.now();

      // Get reservation
      const reservation = db.prepare(
        'SELECT * FROM reservations WHERE id = ? AND deleted_at IS NULL'
      ).get(id);

      if (!reservation) {
        return res.status(404).json({ error: 'Reservation not found' });
      }

      // Check if review already exists for this reservation
      const existingReview = db.prepare(
        'SELECT * FROM reviews WHERE reservation_id = ? AND deleted_at IS NULL'
      ).get(id);

      if (existingReview) {
        // Update existing review
        db.prepare(`
          UPDATE reviews
          SET rating = ?, comment = ?, updated_at = ?
          WHERE id = ?
        `).run(ratingVal, comment || '', now, existingReview.id);
      } else {
        // Create new review
        const reviewId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-review-${Math.random().toString(36).slice(2)}`;
        db.prepare(`
          INSERT INTO reviews (id, user_id, agency_id, reservation_id, rating, comment, created_at, updated_at, deleted_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
        `).run(
          reviewId,
          req.user.id,
          reservation.agency_id,
          id,
          ratingVal,
          comment || '',
          now,
          now,
        );
      }

      // Also update rating on the reservation itself
      db.prepare(`
        UPDATE reservations
        SET rating = ?, updated_at = ?
        WHERE id = ?
      `).run(ratingVal, now, id);

      res.json({
        success: true,
        rating: ratingVal,
        comment: comment || '',
        reservationId: id,
      });
    } catch (err) {
      console.error('[LocalAPI] POST /api/reservations/:id/rate error:', err.message);
      res.status(500).json({ error: 'Failed to rate reservation', details: err.message });
    }
  });

  // ─── GET /api/reservations/:id/eta ───────────────────────────────────────
  // Calculate ETA for a reservation (position × average wait time).
  app.get('/api/reservations/:id/eta', authMiddleware, (req, res) => {
    try {
      const { id } = req.params;

      const reservation = db.prepare(
        'SELECT * FROM reservations WHERE id = ? AND deleted_at IS NULL'
      ).get(id);

      if (!reservation) {
        return res.status(404).json({ error: 'Reservation not found' });
      }

      // Only calculate ETA for WAITING reservations
      if (reservation.status !== 'WAITING') {
        return res.json({
          reservationId: id,
          status: reservation.status,
          eta: null,
          message: `Reservation is ${reservation.status} — no ETA available`,
        });
      }

      // Get position in queue (number of people ahead)
      const posRow = db.prepare(`
        SELECT COUNT(*) as pos FROM reservations
        WHERE agency_id = ? AND status IN ('WAITING', 'CALLED', 'SERVING')
          AND joined_at < ? AND deleted_at IS NULL
      `).get(reservation.agency_id, reservation.joined_at);
      const position = posRow ? posRow.pos : 0;

      // Calculate average wait from recently completed reservations
      const avgRow = db.prepare(`
        SELECT AVG(completed_at - called_at) as avg_wait_ms
        FROM reservations
        WHERE agency_id = ? AND status = 'COMPLETED'
          AND called_at IS NOT NULL AND completed_at IS NOT NULL
          AND completed_at > ?
          AND deleted_at IS NULL
      `).get(reservation.agency_id, Date.now() - 7 * 24 * 60 * 60 * 1000); // Last 7 days

      const avgWaitMs = avgRow && avgRow.avg_wait_ms ? avgRow.avg_wait_ms : 10 * 60 * 1000; // Default 10 min
      const etaMs = position * avgWaitMs;

      res.json({
        reservationId: id,
        status: reservation.status,
        position,
        avgWaitMs,
        etaMs,
        etaMinutes: Math.round(etaMs / 60000),
        displayNumber: reservation.display_number,
      });
    } catch (err) {
      console.error('[LocalAPI] GET /api/reservations/:id/eta error:', err.message);
      res.status(500).json({ error: 'Failed to calculate ETA', details: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  LOOKUP ROUTES (7 routes)
  // ═══════════════════════════════════════════════════════════════════════════

  // ─── GET /api/services ──────────────────────────────────────────────────
  // Active services for an agency.
  app.get('/api/services', authMiddleware, (req, res) => {
    try {
      const { agencyId } = req.query;
      if (!agencyId) {
        return res.status(400).json({ error: 'agencyId is required' });
      }

      const rows = db.prepare(`
        SELECT * FROM services
        WHERE agency_id = ? AND is_active = 1 AND deleted_at IS NULL
        ORDER BY name ASC
      `).all(agencyId);

      res.json({
        success: true,
        services: toCamelCaseAll(rows),
        count: rows.length,
      });
    } catch (err) {
      console.error('[LocalAPI] GET /api/services error:', err.message);
      res.status(500).json({ error: 'Failed to get services', details: err.message });
    }
  });

  // ─── GET /api/agencies ──────────────────────────────────────────────────
  // Agency/ies with optional city filter.
  app.get('/api/agencies', authMiddleware, (req, res) => {
    try {
      const { agencyId, city, customCode } = req.query;

      const whereParts = ['is_active = 1', 'deleted_at IS NULL'];
      const params = [];

      if (agencyId) {
        whereParts.push('id = ?');
        params.push(agencyId);
      }
      if (city) {
        whereParts.push('city = ?');
        params.push(city);
      }
      if (customCode) {
        whereParts.push('custom_code = ?');
        params.push(customCode);
      }

      const rows = db.prepare(
        `SELECT * FROM agencies WHERE ${whereParts.join(' AND ')} ORDER BY name ASC`
      ).all(...params);

      res.json({
        success: true,
        agencies: toCamelCaseAll(rows),
        count: rows.length,
      });
    } catch (err) {
      console.error('[LocalAPI] GET /api/agencies error:', err.message);
      res.status(500).json({ error: 'Failed to get agencies', details: err.message });
    }
  });

  // ─── GET /api/branches ─────────────────────────────────────────────────
  // Branches for an agency.
  app.get('/api/branches', authMiddleware, (req, res) => {
    try {
      const { agencyId, branchId } = req.query;
      if (!agencyId) {
        return res.status(400).json({ error: 'agencyId is required' });
      }

      const whereParts = ['agency_id = ?', 'deleted_at IS NULL'];
      const params = [agencyId];

      if (branchId) {
        whereParts.push('id = ?');
        params.push(branchId);
      }

      const rows = db.prepare(
        `SELECT * FROM branches WHERE ${whereParts.join(' AND ')} ORDER BY is_main DESC, name ASC`
      ).all(...params);

      res.json({
        success: true,
        branches: toCamelCaseAll(rows),
        count: rows.length,
      });
    } catch (err) {
      console.error('[LocalAPI] GET /api/branches error:', err.message);
      res.status(500).json({ error: 'Failed to get branches', details: err.message });
    }
  });

  // ─── GET /api/counters ─────────────────────────────────────────────────
  // Counters by agency (via branches) or by specific branch.
  app.get('/api/counters', authMiddleware, (req, res) => {
    try {
      const { agencyId, branchId } = req.query;

      let rows;
      if (branchId) {
        // Get counters for a specific branch
        rows = db.prepare(`
          SELECT * FROM counters
          WHERE branch_id = ? AND is_active = 1 AND deleted_at IS NULL
          ORDER BY number ASC
        `).all(branchId);
      } else if (agencyId) {
        // Get counters for all branches of an agency
        rows = db.prepare(`
          SELECT c.* FROM counters c
          JOIN branches b ON c.branch_id = b.id
          WHERE b.agency_id = ? AND c.is_active = 1 AND c.deleted_at IS NULL AND b.deleted_at IS NULL
          ORDER BY b.is_main DESC, c.number ASC
        `).all(agencyId);
      } else {
        return res.status(400).json({ error: 'agencyId or branchId is required' });
      }

      res.json({
        success: true,
        counters: toCamelCaseAll(rows),
        count: rows.length,
      });
    } catch (err) {
      console.error('[LocalAPI] GET /api/counters error:', err.message);
      res.status(500).json({ error: 'Failed to get counters', details: err.message });
    }
  });

  // ─── GET /api/notifications ───────────────────────────────────────────
  // Notifications for a user, with optional unread filter.
  app.get('/api/notifications', authMiddleware, (req, res) => {
    try {
      const { userId, unreadOnly = false, limit = 50, offset = 0 } = req.query;

      // Use authenticated user's ID if not specified
      const targetUserId = userId || req.user.id;

      const whereParts = ['user_id = ?', 'deleted_at IS NULL'];
      const params = [targetUserId];

      if (unreadOnly === 'true' || unreadOnly === true || unreadOnly === '1') {
        whereParts.push('is_read = 0');
      }

      const limitInt = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
      const offsetInt = Math.max(parseInt(offset, 10) || 0, 0);

      const rows = db.prepare(`
        SELECT * FROM notifications
        WHERE ${whereParts.join(' AND ')}
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `).all(...params, limitInt, offsetInt);

      // Count unread
      const unreadRow = db.prepare(`
        SELECT COUNT(*) as cnt FROM notifications
        WHERE user_id = ? AND is_read = 0 AND deleted_at IS NULL
      `).get(targetUserId);

      res.json({
        success: true,
        notifications: toCamelCaseAll(rows),
        unreadCount: unreadRow ? unreadRow.cnt : 0,
        count: rows.length,
      });
    } catch (err) {
      console.error('[LocalAPI] GET /api/notifications error:', err.message);
      res.status(500).json({ error: 'Failed to get notifications', details: err.message });
    }
  });

  // ─── PUT /api/notifications/:id/read ────────────────────────────────────
  // Mark a notification as read.
  app.put('/api/notifications/:id/read', authMiddleware, (req, res) => {
    try {
      const { id } = req.params;
      const now = Date.now();

      const result = db.prepare(`
        UPDATE notifications
        SET is_read = 1, updated_at = ?
        WHERE id = ? AND deleted_at IS NULL
      `).run(now, id);

      if (result.changes === 0) {
        return res.status(404).json({ error: 'Notification not found' });
      }

      res.json({ success: true, read: true });
    } catch (err) {
      console.error('[LocalAPI] PUT /api/notifications/:id/read error:', err.message);
      res.status(500).json({ error: 'Failed to mark notification as read', details: err.message });
    }
  });

  // ─── GET /api/stats/today ──────────────────────────────────────────────
  // Today's statistics for an agency.
  app.get('/api/stats/today', authMiddleware, (req, res) => {
    try {
      const { agencyId } = req.query;
      if (!agencyId) {
        return res.status(400).json({ error: 'agencyId is required' });
      }

      const { start, end } = getTodayRange();

      // Total reservations created today
      const totalCreatedRow = db.prepare(`
        SELECT COUNT(*) as cnt FROM reservations
        WHERE agency_id = ? AND joined_at >= ? AND joined_at <= ? AND deleted_at IS NULL
      `).get(agencyId, start, end);

      // Completed today
      const completedRow = db.prepare(`
        SELECT COUNT(*) as cnt FROM reservations
        WHERE agency_id = ? AND completed_at >= ? AND completed_at <= ?
          AND status = 'COMPLETED' AND deleted_at IS NULL
      `).get(agencyId, start, end);

      // Cancelled today
      const cancelledRow = db.prepare(`
        SELECT COUNT(*) as cnt FROM reservations
        WHERE agency_id = ? AND cancelled_at >= ? AND cancelled_at <= ?
          AND status = 'CANCELLED' AND deleted_at IS NULL
      `).get(agencyId, start, end);

      // No-shows today
      const noShowRow = db.prepare(`
        SELECT COUNT(*) as cnt FROM reservations
        WHERE agency_id = ? AND status = 'NO_SHOW'
          AND updated_at >= ? AND updated_at <= ? AND deleted_at IS NULL
      `).get(agencyId, start, end);

      // Walk-ins today
      const walkInRow = db.prepare(`
        SELECT COUNT(*) as cnt FROM reservations
        WHERE agency_id = ? AND is_walk_in = 1 AND joined_at >= ? AND joined_at <= ?
          AND deleted_at IS NULL
      `).get(agencyId, start, end);

      // Average service time (completed today)
      const avgServiceRow = db.prepare(`
        SELECT AVG(completed_at - called_at) as avg_ms
        FROM reservations
        WHERE agency_id = ? AND status = 'COMPLETED'
          AND called_at IS NOT NULL AND completed_at IS NOT NULL
          AND completed_at >= ? AND completed_at <= ? AND deleted_at IS NULL
      `).get(agencyId, start, end);

      // Current active
      const activeRow = db.prepare(`
        SELECT COUNT(*) as cnt FROM reservations
        WHERE agency_id = ? AND status IN ('WAITING', 'CALLED', 'SERVING') AND deleted_at IS NULL
      `).get(agencyId);

      // Reviews today (avg rating)
      const ratingRow = db.prepare(`
        SELECT AVG(rating) as avg_rating, COUNT(*) as cnt
        FROM reviews
        WHERE agency_id = ? AND created_at >= ? AND created_at <= ? AND deleted_at IS NULL
      `).get(agencyId, start, end);

      // Peak hour today
      const peakHourRow = db.prepare(`
        SELECT
          CAST(strftime('%H', joined_at / 1000, 'unixepoch') AS INTEGER) as hour,
          COUNT(*) as cnt
        FROM reservations
        WHERE agency_id = ? AND joined_at >= ? AND joined_at <= ? AND deleted_at IS NULL
        GROUP BY hour
        ORDER BY cnt DESC
        LIMIT 1
      `).get(agencyId, start, end);

      // Queue status
      localDb.ensureQueueSettings(agencyId);
      const settings = localDb.getQueueSettings(agencyId);

      res.json({
        success: true,
        date: new Date(start).toISOString().split('T')[0],
        agencyId,
        totalCreated: totalCreatedRow ? totalCreatedRow.cnt : 0,
        completed: completedRow ? completedRow.cnt : 0,
        cancelled: cancelledRow ? cancelledRow.cnt : 0,
        noShows: noShowRow ? noShowRow.cnt : 0,
        walkIns: walkInRow ? walkInRow.cnt : 0,
        currentlyActive: activeRow ? activeRow.cnt : 0,
        averageServiceTimeMs: avgServiceRow && avgServiceRow.avg_ms ? Math.round(avgServiceRow.avg_ms) : null,
        averageServiceTimeMinutes: avgServiceRow && avgServiceRow.avg_ms
          ? Math.round(avgServiceRow.avg_ms / 60000)
          : null,
        averageRating: ratingRow && ratingRow.avg_rating
          ? Math.round(ratingRow.avg_rating * 10) / 10
          : null,
        reviewsCount: ratingRow ? ratingRow.cnt : 0,
        peakHour: peakHourRow ? peakHourRow.hour : null,
        peakHourCount: peakHourRow ? peakHourRow.cnt : 0,
        queuePaused: settings ? (settings.is_paused === 1) : false,
        currentServingNumber: settings ? settings.current_serving_number : 0,
        lastIssuedNumber: settings ? settings.last_issued_number : 0,
      });
    } catch (err) {
      console.error('[LocalAPI] GET /api/stats/today error:', err.message);
      res.status(500).json({ error: 'Failed to get today stats', details: err.message });
    }
  });

  console.log('[LocalAPI] All 24 routes mounted successfully');
}

// ─── Module Exports ───────────────────────────────────────────────────────────

module.exports = { mountLocalApiRoutes };
