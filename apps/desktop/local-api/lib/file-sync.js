/**
 * BLASTI Desktop — FILE SYNC worker (Round 15)
 * ═════════════════════════════════════════════════════════════════════════
 *
 * Mirrors the local file store (lib/file-store.js + the local FileAsset
 * table) with the CLOUD storage as part of the sync engine family. The v2
 * record sync engine (sync-service.js) is untouched — files travel through
 * their own dedicated endpoints so blob transport never blocks record sync:
 *
 *   PUSH  local-only files ─────▶ POST /api/files/sync/push      (multipart)
 *   PULL  cloud-only files ◀──── GET  /api/files/sync/pull       (metadata)
 *                                  GET  /api/files/sync/blob/:id  (bytes)
 *   TOMB  local deletes ────────▶ DELETE /api/files/sync/:deviceFileId
 *
 * State machine per file (local FileAsset.syncState):
 *   LOCAL_ONLY → (push ok) → SYNCED
 *   DIRTY      → (push ok) → SYNCED        (content replaced locally)
 *   DELETED    → (tombstone ack) → row removed
 * Pull side: cloud rows the device has never seen are downloaded, stored in
 * the local file store and inserted as SYNCED. Cloud tombstones delete the
 * local copy + row.
 *
 * Cursors live in _sync_meta: file_sync_cursor (cloud updatedAt watermark).
 *
 * Triggers: auth:login / verify success / import-session / POST /api/upload,
 * a 45s interval, and the manual POST /api/files/sync-now diagnostic route.
 */

const crypto = require('crypto')
const fileStore = require('./file-store')

const PUSH_BATCH = 10
const PULL_PAGE = 100
const INTERVAL_MS = 45 * 1000
const MAX_FILE_BYTES = 20 * 1024 * 1024

function log(...args) {
  console.log('[FileSync]', ...args)
}

function createFileSync(options) {
  const {
    db,                    // Prisma client (local SQLite)
    getCloudBaseUrl,       // () => string
    getSessionToken,       // () => string | null
    getSyncMeta,           // async (key) => string | null
    setSyncMeta,           // async (key, value) => void
  } = options

  let intervalId = null
  let inFlight = false
  let queued = false

  // ─── helpers ─────────────────────────────────────────────────────────────

  async function fetchCloud(pathname, init) {
    const base = getCloudBaseUrl()
    const res = await fetch(base + pathname, {
      ...init,
      headers: {
        ...(init && init.headers ? init.headers : {}),
        ...(getSessionToken() ? { Authorization: `Bearer ${getSessionToken()}` } : {}),
      },
      signal: AbortSignal.timeout(60000),
    })
    return res
  }

  function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex')
  }

  // ─── PUSH ────────────────────────────────────────────────────────────────

  async function pushLocalFiles() {
    const pending = await db.fileAsset.findMany({
      where: { syncState: { in: ['LOCAL_ONLY', 'DIRTY'] }, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      take: PUSH_BATCH,
    })

    let pushed = 0
    for (const asset of pending) {
      if (!getSessionToken()) break // no session — everything waits for login
      try {
        const buffer = await fileStore.readByStoragePath(asset.storagePath)
        if (!buffer) {
          // The blob vanished from disk — drop the stale row.
          await db.fileAsset.delete({ where: { id: asset.id } }).catch(() => {})
          continue
        }
        if (buffer.length > MAX_FILE_BYTES) continue // never pushed — too big

        const form = new FormData()
        const filename = asset.storagePath.split('/').pop()
        form.append('file', new Blob([new Uint8Array(buffer)], { type: asset.mimeType || 'application/octet-stream' }), filename)
        form.append('meta', JSON.stringify({
          deviceFileId: asset.deviceFileId,
          bucket: asset.bucket,
          filename,
          mimeType: asset.mimeType || undefined,
          size: buffer.length,
          checksum: sha256(buffer),
          createdAt: asset.createdAt ? new Date(asset.createdAt).toISOString() : undefined,
          originalName: asset.originalName || undefined,
        }))

        const res = await fetchCloud('/api/files/sync/push', {
          method: 'POST',
          body: form,
        })
        if (res.ok) {
          const data = await res.json().catch(() => null)
          await db.fileAsset.update({
            where: { id: asset.id },
            data: {
              syncState: 'SYNCED',
              remoteFileId: data && data.fileId ? String(data.fileId) : null,
              remoteUrl: data && data.url ? String(data.url) : null,
              syncedAt: new Date(),
              lastError: null,
            },
          })
          pushed++
        } else if (res.status === 401 || res.status === 403) {
          log('push paused — session rejected by cloud (will retry after re-login)')
          break
        } else {
          const errBody = await res.json().catch(() => ({}))
          await db.fileAsset.update({
            where: { id: asset.id },
            data: { lastError: `push ${res.status}: ${errBody.error || 'unknown'}` },
          }).catch(() => {})
          log(`push rejected ${res.status} for ${asset.storagePath}: ${errBody.error || ''}`)
          if (res.status >= 500) break // cloud trouble — stop this round
        }
      } catch (err) {
        // Network error — cloud unreachable; stop the push loop quietly.
        log('push stopped — cloud unreachable:', err && err.message ? err.message : err)
        break
      }
    }
    return pushed
  }

  // ─── TOMBSTONES ──────────────────────────────────────────────────────────

  async function pushDeletions() {
    const pending = await db.fileAsset.findMany({
      where: { syncState: 'DELETED' },
      take: PUSH_BATCH,
    })
    let removed = 0
    for (const asset of pending) {
      if (!getSessionToken()) break
      try {
        const res = await fetchCloud(`/api/files/sync/${encodeURIComponent(asset.deviceFileId)}`, {
          method: 'DELETE',
        })
        if (res.ok || res.status === 404) {
          await db.fileAsset.delete({ where: { id: asset.id } }).catch(() => {})
          removed++
        } else if (res.status === 401 || res.status === 403) {
          break
        } else {
          break
        }
      } catch {
        break // offline
      }
    }
    return removed
  }

  // ─── PULL ────────────────────────────────────────────────────────────────

  async function pullRemoteFiles() {
    if (!getSessionToken()) return 0
    const cursor = await getSyncMeta('file_sync_cursor')
    const q = cursor ? `?cursor=${encodeURIComponent(cursor)}&limit=${PULL_PAGE}` : `?limit=${PULL_PAGE}`

    let res
    try {
      res = await fetchCloud(`/api/files/sync/pull${q}`, { method: 'GET' })
    } catch {
      return 0 // offline
    }
    if (!res.ok) return 0
    const data = await res.json().catch(() => null)
    if (!data || !data.success || !Array.isArray(data.files)) return 0

    let pulled = 0
    let newest = cursor || null

    for (const remote of data.files) {
      const existing = await db.fileAsset.findUnique({ where: { deviceFileId: remote.deviceFileId } })

      if (existing) {
        // Mirror remote state onto the local row (e.g. re-updated elsewhere).
        if (existing.syncState === 'SYNCED') {
          await db.fileAsset.update({
            where: { id: existing.id },
            data: { remoteFileId: remote.id, remoteUrl: remote.url, lastError: null },
          }).catch(() => {})
        }
      } else {
        // New remote file — download the bytes into the local file store.
        try {
          const blobRes = await fetchCloud(`/api/files/sync/blob/${encodeURIComponent(remote.id)}`, { method: 'GET' })
          if (blobRes.ok) {
            const buffer = Buffer.from(await blobRes.arrayBuffer())
            const parts = String(remote.storagePath || '').split('/')
            if (parts.length === 4) {
              const bucket = parts[0]
              const filename = parts[3]
              await fileStore.saveUpload(bucket, buffer, filename)
              await db.fileAsset.create({
                data: {
                  deviceFileId: remote.deviceFileId,
                  bucket: remote.bucket,
                  storagePath: remote.storagePath,
                  originalName: remote.originalName || null,
                  mimeType: remote.mimeType || null,
                  size: remote.size || buffer.length,
                  checksum: remote.checksum || sha256(buffer),
                  url: fileStore.absoluteFileUrl('http://127.0.0.1:3080', remote.storagePath),
                  remoteFileId: remote.id,
                  remoteUrl: remote.url,
                  syncState: 'SYNCED',
                  syncedAt: new Date(),
                  createdAt: remote.createdAt ? new Date(remote.createdAt) : undefined,
                },
              })
              pulled++
            }
          }
          // blob 404 (e.g. missing on cloud) — skip; next pull retries.
        } catch {
          break // offline mid-pull
        }
      }

      newest = remote.updatedAt
    }

    if (newest && (!cursor || newest > cursor)) {
      await setSyncMeta('file_sync_cursor', newest)
    }
    return pulled
  }

  // ─── Orchestration ───────────────────────────────────────────────────────

  async function syncNow(reason) {
    if (inFlight) {
      queued = true
      return { skipped: true, reason: 'already-running' }
    }
    inFlight = true
    try {
      const pushed = await pushLocalFiles()
      const deleted = await pushDeletions()
      const pulled = await pullRemoteFiles()
      if (pushed || deleted || pulled) {
        log(`round (${reason || 'timer'}): pushed=${pushed} deleted=${deleted} pulled=${pulled}`)
      }
      return { pushed, deleted, pulled }
    } finally {
      inFlight = false
      if (queued) {
        queued = false
        setTimeout(() => { syncNow('queued').catch(() => {}) }, 250)
      }
    }
  }

  function schedule(reason) {
    setTimeout(() => { syncNow(reason).catch(() => {}) }, 300)
  }

  function start() {
    if (intervalId) return
    intervalId = setInterval(() => { syncNow('timer').catch(() => {}) }, INTERVAL_MS)
    log(`worker started (interval ${INTERVAL_MS / 1000}s)`)
  }

  function stop() {
    if (intervalId) {
      clearInterval(intervalId)
      intervalId = null
    }
  }

  return { syncNow, schedule, start, stop }
}

module.exports = { createFileSync }
