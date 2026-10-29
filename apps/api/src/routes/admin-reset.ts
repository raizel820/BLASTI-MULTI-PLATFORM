/**
 * @blasti/api — System Reset Routes (SUPER_ADMIN only)
 *
 * Backs the "System Reset" card inside the admin Backup Manager
 * (apps/web/src/components/admin/admin-backup-manager.tsx). Endpoint:
 *
 *   POST /api/admin/reset
 *     { mode: "full", confirm: "RESET", preserveVersions?: boolean }
 *     — reset EVERYTHING back to the initial state (mirrors
 *       packages/db/prisma/seed-if-empty.ts → seed.ts fresh state:
 *       no customers, no agencies, no analytics, nothing), OR
 *     { sections: string[], confirm: "RESET" }
 *     — selectively reset one or more of:
 *       customers | agencies | analytics | transactions | logs | support |
 *       notifications | reviews | favorites | reservations | queue |
 *       devices | sessions
 *
 * Response: { success: true, mode, sections, summary: {model: deletedCount},
 *             wipedLogFiles: n, at: iso }
 *
 * SAFETY MODEL (hard guarantees, both modes):
 *   - SUPER_ADMIN only (requireAdmin — same gate as the other admin routes).
 *   - `confirm` MUST be exactly "RESET" (uppercase) or the call is rejected.
 *   - NEVER deleted, even in full mode: SUPER_ADMIN/ADMIN user accounts,
 *     SubscriptionPlan + PlanFeature catalog (FREE/BASIC/PREMIUM), the
 *     built-in AgencyCategory dictionary (isCustom=false) with its
 *     specialties/terms, and system config rows (SystemSetting,
 *     ServicePolicy, PaymentSettings, SmsSettings, ProviderConfig,
 *     NotificationTemplate, HardwareSettings).
 *   - All DB deletions run inside ONE interactive transaction
 *     (child-before-parent order; any failure rolls the whole reset back).
 *   - Log-VAULT files (routes/logs.ts storage) are wiped only AFTER the
 *     transaction commits — a DB rollback never destroys files.
 *   - Every call writes an audit entry (action "admin.reset") AFTER success.
 *   - "sessions" never kills the calling admin's own session: only OTHER
 *     users' lastRoleChangeAt is bumped (stale-JWT check → forced re-login).
 *
 * NOTE: versions are NOT bumped by this feature (coordinator owns
 * apps/api/package.json versioning).
 */

import { Hono } from 'hono'
import fs from 'node:fs'
import path from 'node:path'
import { requireAdmin } from '../lib/auth'
import { auditLog } from '../lib/audit'
import { db } from '@blasti/db'

const app = new Hono()

// ─── section registry ───────────────────────────────────────────────────────

const RESET_SECTIONS = [
  'customers',
  'agencies',
  'analytics',
  'transactions',
  'logs',
  'support',
  'notifications',
  'reviews',
  'favorites',
  'reservations',
  'queue',
  'devices',
  'sessions',
] as const

type ResetSection = (typeof RESET_SECTIONS)[number]

const SECTION_SET = new Set<string>(RESET_SECTIONS)

/**
 * Canonical execution order for selective resets — FK-safe regardless of the
 * order the client sent (reviews/reservations die before the customer users
 * that own them; agencies go last so their children are already scoped).
 */
const SECTION_ORDER: ResetSection[] = [
  'analytics',
  'transactions',
  'support',
  'notifications',
  'favorites',
  'reviews',
  'reservations',
  'queue',
  'devices',
  'sessions',
  'customers',
  'agencies',
  'logs', // DB rows last; files are wiped after the tx commits
]

// ─── log-vault helpers (SAME base-dir logic as routes/logs.ts) ──────────────

/** Account-log vault root — identical resolution to routes/logs.ts logRoot(). */
function logRoot(): string {
  return process.env.BLASTI_LOG_DIR || path.join(process.cwd(), 'logs')
}

/** Recursively delete `p`, returning the number of FILES removed. */
function rmCountingFiles(p: string): number {
  let st: fs.Stats
  try {
    st = fs.statSync(p)
  } catch {
    return 0
  }
  if (st.isDirectory()) {
    let n = 0
    let entries: string[] = []
    try {
      entries = fs.readdirSync(p)
    } catch {
      return 0
    }
    for (const e of entries) n += rmCountingFiles(path.join(p, e))
    try {
      fs.rmdirSync(p)
    } catch {
      // ignore — best-effort wipe
    }
    return n
  }
  try {
    fs.unlinkSync(p)
  } catch {
    return 0
  }
  return 1
}

/** Wipe every entry under the log vault; returns the file count removed. */
function wipeLogVaultFiles(): number {
  let wiped = 0
  let entries: fs.Dirent[] = []
  try {
    entries = fs.readdirSync(logRoot(), { withFileTypes: true })
  } catch {
    return 0 // missing vault → nothing to wipe
  }
  for (const e of entries) {
    wiped += rmCountingFiles(path.join(logRoot(), e.name))
  }
  return wiped
}

// ─── tx helpers ─────────────────────────────────────────────────────────────

type Summary = Record<string, number>

function bump(summary: Summary, key: string, count: number): void {
  if (count > 0) summary[key] = (summary[key] ?? 0) + count
}

// Prisma's interactive-transaction client type is not exported — the shared
// tx-retry helper (lib/tx-retry.ts) uses the same `(tx: any)` convention.

/**
 * Section: customers — deletes CUSTOMER-role users and everything they own.
 * Cascade-covered children (delayedJobs, devices, local credentials,
 * verification codes, support tickets, audit-log nulling) need no explicit
 * deletes; the RESTRICT FKs (notification/favorite/review/smsPurchase) and
 * the "their reservations" requirement are handled explicitly.
 */
async function resetCustomers(tx: any, summary: Summary): Promise<void> {
  const customers = await tx.user.findMany({
    where: { role: 'CUSTOMER' },
    select: { id: true },
  })
  if (customers.length === 0) return
  const ids = customers.map((u: { id: string }) => u.id)

  bump(summary, 'reviews', (await tx.review.deleteMany({ where: { userId: { in: ids } } })).count)
  bump(summary, 'reservations', (await tx.reservation.deleteMany({ where: { userId: { in: ids } } })).count)
  bump(summary, 'favorites', (await tx.favorite.deleteMany({ where: { userId: { in: ids } } })).count)
  bump(summary, 'notifications', (await tx.notification.deleteMany({ where: { userId: { in: ids } } })).count)
  bump(summary, 'smsPurchases', (await tx.smsPurchase.deleteMany({ where: { userId: { in: ids } } })).count)
  bump(summary, 'users', (await tx.user.deleteMany({ where: { id: { in: ids } } })).count)
}

/**
 * Section: agencies — deletes agencies and ALL agency-owned children:
 * branches, services, staff rows, counters (cascade via branches),
 * agency subscription links, agency devices + commands, saved TVs,
 * default printers, announcements, hardware orders, enterprise requests,
 * queue settings, and the cloud-side sync ledger rows of those agencies.
 * (Owner/staff USER accounts are only removed by a full reset.)
 * Also resets the stored UID sequence counters (UidCounter — see the full
 * reset note above), per the reset contract "agencies or full ⇒ counter reset".
 */
async function resetAgencies(tx: any, summary: Summary): Promise<void> {
  const agencies = await tx.agency.findMany({ select: { id: true } })
  if (agencies.length > 0) {
    const ids = agencies.map((a: { id: string }) => a.id)
    const inIds = { in: ids }

    bump(summary, 'deviceCommands', (await tx.deviceCommand.deleteMany({ where: { device: { agencyId: inIds } } })).count)
    bump(summary, 'agencyDevices', (await tx.agencyDevice.deleteMany({ where: { agencyId: inIds } })).count)
    bump(summary, 'savedTvs', (await tx.savedTv.deleteMany({ where: { agencyId: inIds } })).count)
    bump(summary, 'defaultPrinters', (await tx.defaultPrinter.deleteMany({ where: { agencyId: inIds } })).count)
    bump(summary, 'reviews', (await tx.review.deleteMany({ where: { agencyId: inIds } })).count)
    bump(summary, 'reservations', (await tx.reservation.deleteMany({ where: { agencyId: inIds } })).count)
    bump(summary, 'favorites', (await tx.favorite.deleteMany({ where: { agencyId: inIds } })).count)
    bump(summary, 'transactions', (await tx.transaction.deleteMany({ where: { agencyId: inIds } })).count)
    bump(summary, 'hardwareOrderItems', (await tx.hardwareOrderItem.deleteMany({ where: { order: { agencyId: inIds } } })).count)
    bump(summary, 'hardwareOrders', (await tx.hardwareOrder.deleteMany({ where: { agencyId: inIds } })).count)
    bump(summary, 'enterpriseContractRequests', (await tx.enterpriseContractRequest.deleteMany({ where: { agencyId: inIds } })).count)
    bump(summary, 'announcements', (await tx.announcement.deleteMany({ where: { agencyId: inIds } })).count)
    bump(summary, 'agencyStaff', (await tx.agencyStaff.deleteMany({ where: { agencyId: inIds } })).count)
    bump(summary, 'queueSettings', (await tx.queueSettings.deleteMany({ where: { agencyId: inIds } })).count)
    bump(summary, 'services', (await tx.service.deleteMany({ where: { agencyId: inIds } })).count)
    bump(summary, 'syncChanges', (await tx.syncChange.deleteMany({ where: { agencyId: inIds } })).count)
    bump(summary, 'syncMutations', (await tx.syncMutation.deleteMany({ where: { agencyId: inIds } })).count)
    bump(summary, 'agencyLocalStates', (await tx.agencyLocalState.deleteMany({ where: { agencyId: inIds } })).count)
    bump(summary, 'branches', (await tx.branch.deleteMany({ where: { agencyId: inIds } })).count)
    bump(summary, 'agencies', (await tx.agency.deleteMany({ where: { id: inIds } })).count)
  }

  // UID sequence state: stored in UidCounter (uid-generator.ts) — same reset
  // the full reset applies. Runs even when no agencies exist (the section was
  // explicitly selected). Surviving accounts keep their immutable UIDs; the
  // allocator's unique-constraint retry loop absorbs any collision upward.
  bump(summary, 'uidCounters', (await tx.uidCounter.deleteMany({})).count)
}

/** Section: analytics — the Task-55 data-consumption ledger / aggregates. */
async function resetAnalytics(tx: any, summary: Summary): Promise<void> {
  bump(summary, 'dataUsageEvents', (await tx.dataUsageEvent.deleteMany({})).count)
}

/** Section: transactions — subscription + hardware + SMS payment history. */
async function resetTransactions(tx: any, summary: Summary): Promise<void> {
  bump(summary, 'transactions', (await tx.transaction.deleteMany({})).count)
  bump(summary, 'smsPurchases', (await tx.smsPurchase.deleteMany({})).count)
}

/** Section: logs — account-log DB rows (audit trail). Files after commit. */
async function resetLogRows(tx: any, summary: Summary): Promise<void> {
  bump(summary, 'auditLogs', (await tx.auditLog.deleteMany({})).count)
}

/** Section: support — tickets (+ replies live on the ticket row). */
async function resetSupport(tx: any, summary: Summary): Promise<void> {
  bump(summary, 'supportTickets', (await tx.supportTicket.deleteMany({})).count)
}

/** Section: notifications — notification rows for every account. */
async function resetNotifications(tx: any, summary: Summary): Promise<void> {
  bump(summary, 'notifications', (await tx.notification.deleteMany({})).count)
}

/** Section: reviews — agency + branch reviews. */
async function resetReviews(tx: any, summary: Summary): Promise<void> {
  bump(summary, 'reviews', (await tx.review.deleteMany({})).count)
}

/** Section: favorites — customer→agency favorites. */
async function resetFavorites(tx: any, summary: Summary): Promise<void> {
  bump(summary, 'favorites', (await tx.favorite.deleteMany({})).count)
}

/** Section: reservations — queue tickets (review/counter links auto-null). */
async function resetReservations(tx: any, summary: Summary): Promise<void> {
  bump(summary, 'reservations', (await tx.reservation.deleteMany({})).count)
}

/** Section: queue — per-agency queue state + pending reminder jobs. */
async function resetQueue(tx: any, summary: Summary): Promise<void> {
  bump(summary, 'delayedJobs', (await tx.delayedJob.deleteMany({})).count)
  bump(summary, 'queueSettings', (await tx.queueSettings.deleteMany({})).count)
}

/** Section: devices — user device registrations (push tokens). */
async function resetDevices(tx: any, summary: Summary): Promise<void> {
  bump(summary, 'deviceRegistrations', (await tx.deviceRegistration.deleteMany({})).count)
}

/**
 * Section: sessions — BLASTI sessions are stateless JWTs (no refresh-token
 * table). The server-tracked session state is (a) pending OTP codes and
 * (b) User.lastRoleChangeAt — any token issued BEFORE that timestamp is
 * rejected by verifySessionToken(checkStaleRole) and forces re-login.
 * We bump every OTHER user's stamp (the calling admin keeps their session)
 * and clear the pending verification codes.
 */
async function resetSessions(tx: any, summary: Summary, callerId: string): Promise<void> {
  bump(summary, 'verificationCodes', (await tx.verificationCode.deleteMany({})).count)
  const res = await tx.user.updateMany({
    where: { id: { not: callerId } },
    data: { lastRoleChangeAt: new Date() },
  })
  bump(summary, 'sessionsInvalidated', res.count)
}

/**
 * FULL reset — everything back to the initial state produced by
 * packages/db/prisma/seed-if-empty.ts, PRESERVING (hard guard):
 *   • SUPER_ADMIN/ADMIN user accounts (+ the caller)
 *   • SubscriptionPlan + PlanFeature catalog
 *   • built-in AgencyCategory dictionary rows (isCustom=false) and their
 *     Specialty/CategoryTerm children
 *   • system config rows: SystemSetting, ServicePolicy, PaymentSettings,
 *     SmsSettings, ProviderConfig, NotificationTemplate, HardwareSettings
 * Also resets the stored UID sequence counters (uid-generator.ts allocates
 * from the UidCounter table, so a true initial state = empty counters).
 *
 * (uid-generator.ts allocates from the STORED UidCounter table — not derived
 * from max() — so the counter rows ARE the sequence state and must be reset.
 * A surviving account's already-issued UID still holds its unique slot, and
 * the allocator's P2002 retry loop keeps new allocations collision-free.)
 */
async function resetFull(
  tx: any,
  summary: Summary,
  preserveVersions: boolean,
): Promise<void> {
  // ── device + update-push telemetry ──
  bump(summary, 'updatePushAcks', (await tx.updatePushAck.deleteMany({})).count)
  bump(summary, 'updatePushes', (await tx.updatePush.deleteMany({})).count)
  bump(summary, 'appInstallEvents', (await tx.appInstallEvent.deleteMany({})).count)
  bump(summary, 'appDevices', (await tx.appDevice.deleteMany({})).count)
  bump(summary, 'deviceCommands', (await tx.deviceCommand.deleteMany({})).count)
  bump(summary, 'agencyDevices', (await tx.agencyDevice.deleteMany({})).count)
  bump(summary, 'savedTvs', (await tx.savedTv.deleteMany({})).count)
  bump(summary, 'defaultPrinters', (await tx.defaultPrinter.deleteMany({})).count)

  // ── desktop sync infrastructure (cloud-side mirrors) ──
  bump(summary, 'localPendingMutations', (await tx.localPendingMutation.deleteMany({})).count)
  bump(summary, 'localSyncAppliedMutations', (await tx.localSyncAppliedMutation.deleteMany({})).count)
  bump(summary, 'localDeferredChanges', (await tx.localDeferredChange.deleteMany({})).count)
  bump(summary, 'localSyncConflicts', (await tx.localSyncConflict.deleteMany({})).count)
  bump(summary, 'localSyncMeta', (await tx.localSyncMeta.deleteMany({})).count)
  bump(summary, 'agencyLocalStates', (await tx.agencyLocalState.deleteMany({})).count)
  bump(summary, 'syncChanges', (await tx.syncChange.deleteMany({})).count)
  bump(summary, 'syncMutations', (await tx.syncMutation.deleteMany({})).count)

  // ── jobs + files + hardware ──
  bump(summary, 'delayedJobs', (await tx.delayedJob.deleteMany({})).count)
  bump(summary, 'fileAssets', (await tx.fileAsset.deleteMany({})).count)
  bump(summary, 'uploadedFiles', (await tx.uploadedFile.deleteMany({})).count)
  bump(summary, 'deletedRecords', (await tx.deletedRecord.deleteMany({})).count)
  bump(summary, 'hardwareOrderItems', (await tx.hardwareOrderItem.deleteMany({})).count)
  bump(summary, 'hardwareOrders', (await tx.hardwareOrder.deleteMany({})).count)
  bump(summary, 'enterpriseContractRequests', (await tx.enterpriseContractRequest.deleteMany({})).count)
  bump(summary, 'hardwareProducts', (await tx.hardwareProduct.deleteMany({})).count)
  bump(summary, 'hardwareCommitmentTiers', (await tx.hardwareCommitmentTier.deleteMany({})).count)

  // ── accounts' personal data (RESTRICT FKs before the user purge) ──
  bump(summary, 'deviceRegistrations', (await tx.deviceRegistration.deleteMany({})).count)
  bump(summary, 'verificationCodes', (await tx.verificationCode.deleteMany({})).count)
  bump(summary, 'auditLogs', (await tx.auditLog.deleteMany({})).count)
  bump(summary, 'notifications', (await tx.notification.deleteMany({})).count)
  bump(summary, 'smsLogs', (await tx.smsLog.deleteMany({})).count)
  bump(summary, 'globalAnnouncements', (await tx.globalAnnouncement.deleteMany({})).count)
  bump(summary, 'announcements', (await tx.announcement.deleteMany({})).count)
  bump(summary, 'reviews', (await tx.review.deleteMany({})).count)
  bump(summary, 'reservations', (await tx.reservation.deleteMany({})).count)
  bump(summary, 'transactions', (await tx.transaction.deleteMany({})).count)
  bump(summary, 'smsPurchases', (await tx.smsPurchase.deleteMany({})).count)
  bump(summary, 'favorites', (await tx.favorite.deleteMany({})).count)

  // ── agency tree (children before the Agency parent) ──
  bump(summary, 'counters', (await tx.counter.deleteMany({})).count)
  bump(summary, 'agencyStaff', (await tx.agencyStaff.deleteMany({})).count)
  bump(summary, 'branches', (await tx.branch.deleteMany({})).count)
  bump(summary, 'queueSettings', (await tx.queueSettings.deleteMany({})).count)
  bump(summary, 'services', (await tx.service.deleteMany({})).count)
  bump(summary, 'faqs', (await tx.fAQ.deleteMany({})).count)
  bump(summary, 'appVersions', preserveVersions ? 0 : (await tx.appVersion.deleteMany({})).count)
  bump(summary, 'dataUsageEvents', (await tx.dataUsageEvent.deleteMany({})).count)

  // ── parents last ──
  bump(summary, 'agencies', (await tx.agency.deleteMany({})).count)
  // HARD GUARD: SUPER_ADMIN/ADMIN accounts survive every reset.
  bump(
    summary,
    'users',
    (await tx.user.deleteMany({ where: { role: { notIn: ['SUPER_ADMIN', 'ADMIN'] } } })).count,
  )

  // ── UID sequence state: stored in UidCounter → empty = initial state ──
  bump(summary, 'uidCounters', (await tx.uidCounter.deleteMany({})).count)

  // ── category dictionary: keep BUILT-INS, drop user-created customs ──
  // (Specialty/CategoryTerm of customs cascade with their parent.)
  bump(summary, 'agencyCategories', (await tx.agencyCategory.deleteMany({ where: { isCustom: true } })).count)
}

// ─── route ──────────────────────────────────────────────────────────────────

app.post('/', async (c) => {
  // Same SUPER_ADMIN gate as admin-backups (platform check included).
  const caller = await requireAdmin(c)

  const body = await c.req.json().catch(() => ({} as Record<string, unknown>))

  // 1) Confirmation word — must be exactly "RESET" (uppercase).
  if (body?.confirm !== 'RESET') {
    return c.json(
      { success: false, error: 'Confirmation failed: the confirm field must be exactly "RESET"' },
      400,
    )
  }

  const isFull = body?.mode === 'full'
  const preserveVersions = body?.preserveVersions === true

  // 2) Validate / normalize the requested scope.
  let requested: ResetSection[] = []
  if (!isFull) {
    const raw = body?.sections
    if (!Array.isArray(raw) || raw.length === 0) {
      return c.json(
        { success: false, error: 'Provide a non-empty "sections" array or { mode: "full" }' },
        400,
      )
    }
    const invalid = raw.filter((s: unknown) => !SECTION_SET.has(String(s)))
    if (invalid.length > 0) {
      return c.json(
        { success: false, error: `Unknown section(s): ${invalid.map(String).join(', ')}` },
        400,
      )
    }
    const set = new Set(raw.map(String))
    requested = SECTION_ORDER.filter((s) => set.has(s))
  }

  const summary: Summary = {}
  let wipedLogFiles = 0

  try {
    // ── ONE interactive transaction: everything rolls back on any failure ──
    await db.$transaction(
      async (tx: any) => {
        if (isFull) {
          await resetFull(tx, summary, preserveVersions)
          return
        }
        for (const section of requested) {
          switch (section) {
            case 'customers': await resetCustomers(tx, summary); break
            case 'agencies': await resetAgencies(tx, summary); break
            case 'analytics': await resetAnalytics(tx, summary); break
            case 'transactions': await resetTransactions(tx, summary); break
            case 'logs': await resetLogRows(tx, summary); break
            case 'support': await resetSupport(tx, summary); break
            case 'notifications': await resetNotifications(tx, summary); break
            case 'reviews': await resetReviews(tx, summary); break
            case 'favorites': await resetFavorites(tx, summary); break
            case 'reservations': await resetReservations(tx, summary); break
            case 'queue': await resetQueue(tx, summary); break
            case 'devices': await resetDevices(tx, summary); break
            case 'sessions': await resetSessions(tx, summary, caller.id); break
          }
        }
      },
      { timeout: 60_000, maxWait: 10_000 },
    )
  } catch (err) {
    console.error('[admin-reset] reset transaction failed:', err)
    return c.json(
      { success: false, error: `Reset failed and was rolled back: ${(err as Error).message}` },
      500,
    )
  }

  // ── after commit: wipe the log-VAULT files (DB rollback can't cover files) ──
  const wantsLogFiles = isFull || requested.includes('logs')
  if (wantsLogFiles) {
    try {
      wipedLogFiles = wipeLogVaultFiles()
    } catch (err) {
      console.error('[admin-reset] log-file wipe failed (DB reset unaffected):', err)
    }
  }

  const at = new Date().toISOString()

  // ── audit trail (written AFTER the reset so it survives it) ──
  await auditLog.userAction({
    userId: caller.id,
    action: 'admin.reset',
    entityType: 'SYSTEM',
    entityId: 'system-reset',
    details: {
      mode: isFull ? 'full' : 'sections',
      sections: isFull ? ['*'] : requested,
      preserveVersions,
      summary,
      wipedLogFiles,
    },
  })

  return c.json({
    success: true,
    mode: isFull ? 'full' : 'sections',
    sections: isFull ? ['*'] : requested,
    summary,
    wipedLogFiles,
    at,
  })
})

export const adminResetRoutes = app
