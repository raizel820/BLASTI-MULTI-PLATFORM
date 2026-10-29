/**
 * @blasti/api — Backup Manager Routes (SUPER_ADMIN only)
 *
 * Backs the admin sidebar "Database and Storage Management → Backup Manager"
 * page (view admin-backups). Endpoints:
 *
 *   GET    /                             → overview: settings (+nextRunAt),
 *                                            targets (masked), backups,
 *                                            busy/runningJob, storage usage
 *   POST   /                             → create backup now (async job)
 *   GET    /:id                          → backup detail (manifest + disk state)
 *   GET    /:id/download?part=data|files → download snapshot / files archive
 *   POST   /:id/restore                  → restore (async; auto safety snapshot)
 *   DELETE /:id                          → delete backup files + registry entry
 *   PUT    /settings                     → auto-backup settings (+nextRunAt)
 *   POST   /targets                      → add external target (probe first)
 *   PATCH  /targets/:id                  → rename / toggle autoPush
 *   DELETE /targets/:id                  → remove target
 *   POST   /targets/:id/test             → connectivity probe
 *   POST   /targets/:id/push             → push backup to target (async job);
 *                                           type 'postgres' = FULL live migration
 *
 * SAFETY MODEL
 *   - Every route requires SUPER_ADMIN.
 *   - Long jobs run detached behind a global mutex (one job at a time) with a
 *     visible runningJob status the UI polls.
 *   - Restores always create a "pre-restore" safety backup first and run
 *     TRUNCATE+INSERT inside ONE transaction (rollback-safe).
 *   - Secret fields (keys, tokens, URLs) are masked in every response.
 */

import { Hono } from 'hono'
import fs from 'node:fs'
import path from 'node:path'
import { requireAdmin } from '../lib/auth'
import { auditLog } from '../lib/audit'
import {
  BACKUP_DIR,
  addTarget,
  deleteBackup,
  getState,
  isBusy,
  removeTarget,
  runBackupJob,
  runPushJob,
  runRestoreJob,
  saveState,
  updateSettings,
  updateTarget,
} from '../lib/backup-engine'
import {
  maskSecrets,
  resolveEntry,
  pushBackupToTarget,
  testAzureTarget,
  testExternalPostgres,
  testS3Target,
  validateTargetInput,
  type TargetConfig,
} from '../lib/backup-targets'

const app = new Hono()

// ─── helpers ────────────────────────────────────────────────────────────────

function dirSize(dir: string): number {
  let total = 0
  const walk = (d: string) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else {
        try {
          total += fs.statSync(p).size
        } catch {
          // ignore
        }
      }
    }
  }
  walk(dir)
  return total
}

function maskedTargets(): Array<Record<string, unknown>> {
  return getState().targets.map((t) => maskSecrets(t as unknown as Record<string, unknown>))
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

async function probeTarget(target: TargetConfig): Promise<void> {
  switch (target.type) {
    case 'postgres':
      await testExternalPostgres(target.url!)
      return
    case 's3':
      await testS3Target(target)
      return
    case 'azure-blob':
      await testAzureTarget(target)
      return
    case 'd1':
      // no cheap probe without side effects — credentials validated at push
      return
  }
}

// ─── overview ───────────────────────────────────────────────────────────────

app.get('/', async (c) => {
  await requireAdmin(c)
  const s = getState()
  return c.json({
    success: true,
    data: {
      settings: { ...s.settings, nextRunAt: s.nextRunAt },
      targets: maskedTargets(),
      backups: s.backups,
      busy: isBusy(),
      runningJob: s.runningJob,
      storage: {
        dir: BACKUP_DIR.replace(/\\/g, '/'),
        usedBytes: dirSize(BACKUP_DIR),
      },
    },
  })
})

// ─── create backup (async) ──────────────────────────────────────────────────

app.post('/', async (c) => {
  const user = await requireAdmin(c)
  if (isBusy()) {
    return c.json({ success: false, error: 'A backup/restore job is already running' }, 409)
  }
  const body = await c.req.json().catch(() => ({}))
  const label =
    typeof body.label === 'string' && body.label.trim()
      ? body.label.trim().slice(0, 120)
      : undefined
  const includeFiles = body.includeFiles === true

  // detached — the UI polls the overview while runningJob is set
  void runBackupJob({ label, includeFiles, type: 'manual' })
    .then((entry) => {
      void auditLog.userAction({
        userId: user.id,
        action: 'BACKUP_CREATE',
        entityType: 'BACKUP',
        entityId: entry.id,
        details: { label: entry.label, rowCount: entry.rowCount, includeFiles: entry.includeFiles },
      })
    })
    .catch((err) => {
      console.error('[backups] manual backup failed:', err)
    })

  return c.json({ success: true, data: { accepted: true } }, 202)
})

// ─── detail + download ──────────────────────────────────────────────────────

app.get('/:id', async (c) => {
  await requireAdmin(c)
  const s = getState()
  const entry = s.backups.find((b) => b.id === c.req.param('id'))
  if (!entry) return c.json({ success: false, error: 'Backup not found' }, 404)
  const filesOnDisk = {
    data: fs.existsSync(entry.dataFile),
    files: entry.filesFile ? fs.existsSync(entry.filesFile) : false,
  }
  return c.json({ success: true, data: { ...entry, filesOnDisk } })
})

app.get('/:id/download', async (c) => {
  await requireAdmin(c)
  const s = getState()
  const entry = s.backups.find((b) => b.id === c.req.param('id'))
  if (!entry) return c.json({ success: false, error: 'Backup not found' }, 404)
  const part = c.req.query('part') === 'files' ? 'files' : 'data'
  const file = part === 'files' ? entry.filesFile : entry.dataFile
  if (!file || !fs.existsSync(file)) {
    return c.json({ success: false, error: `No ${part} archive for this backup` }, 404)
  }
  const name = path.basename(file)
  const body = new Uint8Array(fs.readFileSync(file))
  return new Response(body, {
    headers: {
      'Content-Type': 'application/gzip',
      'Content-Length': String(body.length),
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'no-store',
    },
  })
})

// ─── restore (async) ────────────────────────────────────────────────────────

app.post('/:id/restore', async (c) => {
  const user = await requireAdmin(c)
  if (isBusy()) {
    return c.json({ success: false, error: 'A backup/restore job is already running' }, 409)
  }
  const id = c.req.param('id')
  const s = getState()
  const entry = s.backups.find((b) => b.id === id)
  if (!entry) return c.json({ success: false, error: 'Backup not found' }, 404)
  if (!fs.existsSync(entry.dataFile)) {
    return c.json({ success: false, error: 'Backup data file missing on disk' }, 409)
  }
  const body = await c.req.json().catch(() => ({}))
  const restoreFiles = body.restoreFiles === true && !!entry.filesFile

  void runRestoreJob(id, { restoreFiles })
    .then((result) => {
      const mismatches = result.verification.filter((v) => !v.ok).length
      void auditLog.userAction({
        userId: user.id,
        action: 'BACKUP_RESTORE',
        entityType: 'BACKUP',
        entityId: id,
        details: {
          restoredTables: result.restoredTables,
          restoredRows: result.restoredRows,
          mismatches,
          filesRestored: result.filesRestored,
          safetyBackupId: result.safetyBackupId,
          durationMs: result.durationMs,
        },
      })
    })
    .catch((err) => {
      console.error('[backups] restore failed:', err)
    })

  return c.json({ success: true, data: { accepted: true } }, 202)
})

// ─── delete ─────────────────────────────────────────────────────────────────

app.delete('/:id', async (c) => {
  const user = await requireAdmin(c)
  const id = c.req.param('id')
  const res = deleteBackup(id)
  if (!res.deleted) return c.json({ success: false, error: 'Backup not found' }, 404)
  await auditLog.userAction({
    userId: user.id,
    action: 'BACKUP_DELETE',
    entityType: 'BACKUP',
    entityId: id,
  })
  return c.json({ success: true, data: res })
})

// ─── settings ───────────────────────────────────────────────────────────────

app.put('/settings', async (c) => {
  const user = await requireAdmin(c)
  const body = await c.req.json().catch(() => ({}))
  const patch: Record<string, unknown> = {}
  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
  if (body.intervalHours === null || typeof body.intervalHours === 'number') {
    patch.intervalHours = body.intervalHours
  }
  if (
    body.dailyAt === null ||
    (typeof body.dailyAt === 'string' && /^\d{2}:\d{2}$/.test(body.dailyAt))
  ) {
    patch.dailyAt = body.dailyAt
  }
  if (typeof body.keepLastN === 'number' && body.keepLastN >= 1) {
    patch.keepLastN = Math.min(Math.floor(body.keepLastN), 500)
  }
  if (typeof body.includeFiles === 'boolean') patch.includeFiles = body.includeFiles
  if (typeof body.autoPush === 'boolean') patch.autoPush = body.autoPush

  const settings = updateSettings(patch as never)
  await auditLog.userAction({
    userId: user.id,
    action: 'SETTINGS_UPDATE',
    entityType: 'BACKUP_SETTINGS',
    entityId: 'backup-settings',
    details: patch,
  })
  const st = getState()
  return c.json({
    success: true,
    data: { ...st.settings, nextRunAt: st.nextRunAt },
  })
})

// ─── targets ────────────────────────────────────────────────────────────────

app.post('/targets', async (c) => {
  const user = await requireAdmin(c)
  const body = await c.req.json().catch(() => ({}))
  const input: Partial<TargetConfig> = {
    type: body.type,
    name:
      typeof body.name === 'string' && body.name.trim()
        ? body.name.trim().slice(0, 80)
        : body.type,
    autoPush: body.autoPush !== false,
    endpoint: body.endpoint,
    region: body.region,
    bucket: body.bucket,
    accessKeyId: body.accessKeyId,
    secretAccessKey: body.secretAccessKey,
    prefix: body.prefix,
    account: body.account,
    container: body.container,
    accountKey: body.accountKey,
    sasToken: body.sasToken,
    accountId: body.accountId,
    databaseId: body.databaseId,
    apiToken: body.apiToken,
    url: body.url,
  }
  const check = validateTargetInput(input)
  if (!check.ok) return c.json({ success: false, error: check.error }, 400)

  const target: TargetConfig = {
    ...(input as TargetConfig),
    id: newId('tgt'),
    createdAt: new Date().toISOString(),
    lastPushAt: null,
    lastPushResult: null,
    lastPushError: null,
  }

  // connectivity probe BEFORE saving (fail fast on bad credentials)
  try {
    await probeTarget(target)
  } catch (err) {
    return c.json(
      { success: false, error: `Target test failed: ${(err as Error).message}` },
      400,
    )
  }

  addTarget(target)
  await auditLog.userAction({
    userId: user.id,
    action: 'SETTINGS_UPDATE',
    entityType: 'BACKUP_TARGET',
    entityId: target.id,
    details: { type: target.type, name: target.name },
  })
  return c.json({ success: true, data: maskSecrets(target as unknown as Record<string, unknown>) })
})

app.patch('/targets/:id', async (c) => {
  const user = await requireAdmin(c)
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const patch: Partial<TargetConfig> = {}
  if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim().slice(0, 80)
  if (typeof body.autoPush === 'boolean') patch.autoPush = body.autoPush
  if (typeof body.prefix === 'string') patch.prefix = body.prefix
  const updated = updateTarget(id, patch)
  if (!updated) return c.json({ success: false, error: 'Target not found' }, 404)
  await auditLog.userAction({
    userId: user.id,
    action: 'SETTINGS_UPDATE',
    entityType: 'BACKUP_TARGET',
    entityId: id,
    details: patch,
  })
  return c.json({ success: true, data: maskSecrets(updated as unknown as Record<string, unknown>) })
})

app.delete('/targets/:id', async (c) => {
  const user = await requireAdmin(c)
  const id = c.req.param('id')
  const removed = removeTarget(id)
  if (!removed) return c.json({ success: false, error: 'Target not found' }, 404)
  await auditLog.userAction({
    userId: user.id,
    action: 'SETTINGS_UPDATE',
    entityType: 'BACKUP_TARGET',
    entityId: id,
    details: { removed: true },
  })
  return c.json({ success: true, data: { removed: true } })
})

app.post('/targets/:id/test', async (c) => {
  await requireAdmin(c)
  const s = getState()
  const target = s.targets.find((t) => t.id === c.req.param('id'))
  if (!target) return c.json({ success: false, error: 'Target not found' }, 404)
  try {
    await probeTarget(target)
    return c.json({ success: true, data: { ok: true } })
  } catch (err) {
    return c.json({ success: false, error: (err as Error).message }, 400)
  }
})

app.post('/targets/:id/push', async (c) => {
  const user = await requireAdmin(c)
  if (isBusy()) {
    return c.json({ success: false, error: 'A backup/restore job is already running' }, 409)
  }
  const s = getState()
  const target = s.targets.find((t) => t.id === c.req.param('id'))
  if (!target) return c.json({ success: false, error: 'Target not found' }, 404)
  const body = await c.req.json().catch(() => ({}))
  const backupId = typeof body.backupId === 'string' ? body.backupId : undefined

  // resolve entry up front so a bad id fails fast (synchronously)
  let entry
  try {
    entry = resolveEntry(backupId)
  } catch (err) {
    return c.json({ success: false, error: (err as Error).message }, 404)
  }

  void runPushJob({
    label: `Push ${entry.id} → ${target.name}`,
    backupId: entry.id,
    targetName: target.name,
    fn: () => pushBackupToTarget(target, entry),
  })
    .then((result) => {
      updateTarget(target.id, {
        lastPushAt: new Date().toISOString(),
        lastPushResult: 'success',
        lastPushError: null,
      })
      saveState()
      void auditLog.userAction({
        userId: user.id,
        action: 'BACKUP_PUSH',
        entityType: 'BACKUP_TARGET',
        entityId: target.id,
        details: { backupId: entry.id, type: target.type },
      })
      return result
    })
    .catch((err) => {
      updateTarget(target.id, {
        lastPushAt: new Date().toISOString(),
        lastPushResult: 'error',
        lastPushError: String((err as Error).message || err).slice(0, 500),
      })
      saveState()
      console.error('[backups] push failed:', err)
    })

  return c.json({ success: true, data: { accepted: true, backupId: entry.id } }, 202)
})

export const adminBackupRoutes = app
