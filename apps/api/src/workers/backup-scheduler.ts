/**
 * @blasti/api — Auto-Backup Scheduler Worker
 *
 * A 60-second interval loop that:
 * 1. Checks the persisted backup settings (enabled + nextRunAt in state.json)
 * 2. When due, creates an 'auto' backup (with the configured includeFiles)
 * 3. Applies the retention policy (keepLastN auto backups)
 * 4. Optionally auto-pushes the new backup to every target with autoPush
 * 5. Schedules the next run (persisted — restarts never lose the schedule)
 *
 * The worker is intentionally defensive: every failure logs and continues;
 * a failing backup never crashes the API.
 */

import {
  applyRetention,
  getDueForAutoBackup,
  isBusy,
  runBackupJob,
  runPushJob,
  scheduleNextRun,
  getState,
  addTarget,
} from '../lib/backup-engine'
import { pushBackupToTarget } from '../lib/backup-targets'

const POLL_INTERVAL_MS = 60_000 // 1 minute

let workerInterval: ReturnType<typeof setInterval> | null = null

export function startBackupScheduler(): void {
  if (workerInterval) return // Already running

  console.log('[backup-scheduler] Starting auto-backup worker (60s interval)')

  workerInterval = setInterval(async () => {
    try {
      await tick()
    } catch (error) {
      console.error('[backup-scheduler] tick error:', error)
    }
  }, POLL_INTERVAL_MS)

  // Evaluate once at startup (a due run may have been missed while down)
  tick().catch(console.error)
}

export function stopBackupScheduler(): void {
  if (workerInterval) {
    clearInterval(workerInterval)
    workerInterval = null
    console.log('[backup-scheduler] Stopped')
  }
}

async function tick(): Promise<void> {
  if (!getDueForAutoBackup()) return
  if (isBusy()) {
    // postpone by a minute — a manual job is running
    const s = getState()
    s.nextRunAt = new Date(Date.now() + POLL_INTERVAL_MS).toISOString()
    return
  }

  const settings = getState().settings
  console.log('[backup-scheduler] auto backup starting…')

  try {
    const entry = await runBackupJob({
      type: 'auto',
      label: 'Auto backup',
      includeFiles: settings.includeFiles,
    })
    console.log(
      `[backup-scheduler] auto backup ${entry.id} done — ${entry.rowCount} rows, ${(entry.dataBytes / 1024).toFixed(1)} KiB`,
    )

    // retention
    const pruned = applyRetention()
    if (pruned > 0) console.log(`[backup-scheduler] retention pruned ${pruned} old auto backups`)

    // auto push
    if (settings.autoPush) {
      const targets = getState().targets.filter((t) => t.autoPush)
      for (const target of targets) {
        try {
          await runPushJob({
            label: `Auto push ${entry.id} → ${target.name}`,
            backupId: entry.id,
            targetName: target.name,
            fn: () => pushBackupToTarget(target, entry),
          })
          console.log(`[backup-scheduler] pushed ${entry.id} → ${target.name}`)
        } catch (err) {
          console.error(`[backup-scheduler] push to ${target.name} failed:`, err)
        }
      }
    }
  } catch (err) {
    console.error('[backup-scheduler] auto backup failed:', err)
  } finally {
    scheduleNextRun()
  }
}

// re-exported for tests/tools — registering a target from the scheduler path
export { addTarget }
