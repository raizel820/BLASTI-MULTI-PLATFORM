/**
 * API COMPATIBILITY MAP (0.6.31) — server-authoritative app↔server matrix.
 * ─────────────────────────────────────────────────────────────────────────────
 * Answers, for any RUNNING app version, against THIS server:
 *
 *   1. CAN IT RUN?            — no `critical` gate pending AND the app's API
 *                               protocol level (when known) ≥ the server floor.
 *   2. WHAT CANNOT RUN?       — every enabled `soft`/`critical` gate whose
 *                               minAppVersion > the running app version.
 *   3. IS THE UPDATE ABSOLUTE — updateRequired (blocking) vs updateRecommended
 *      OR OPTIONAL?             (features missing but the app still works).
 *   4. IS THE NEWEST RELEASE  — when the latest published release is flagged
 *      SERVER-ONLY?             serverOnly (or adds nothing app-facing), the
 *                               response says plainly: apps keep running, no
 *                               update needed — the change lives on the server.
 *
 * The SAME evaluation is embedded in GET /api/app-versions/check (the call
 * every app already makes at boot) so clients get compatibility + update +
 * delta-chain in one round trip. GET /api/app-versions/compat exposes the
 * full map (also used by the admin Compatibility tab).
 */

import { readFileSync } from 'node:fs'
import { db } from '@blasti/db'
import { pickLatestAppVersion } from './app-version-rank'

/** Read once — the monorepo version (scripts/version-set.js keeps it true). */
const SERVER_VERSION = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')) as { version: string }
).version

/**
 * API protocol level of THIS server build. Bump by 1 whenever the server
 * ships a BREAKING contract change (removed/reshaped endpoints or payloads
 * that older apps cannot parse at all). Feature-level additions do NOT bump
 * this — they are expressed as ApiFeatureGate rows instead.
 * Level history:
 *   1 — baseline for the 0.6.x line (logs vault, app-versions, sync v2,
 *       counter control, lan topology, delta updates).
 */
export const CURRENT_SERVER_API_LEVEL = 1

/**
 * The absolute floor: an app reporting an apiLevel BELOW this cannot run
 * against this server (a critical contract it does not speak). 0 disables
 * the floor (compat is then decided by the feature gates alone).
 */
export const MIN_SUPPORTED_API_LEVEL = 0

export type GateSeverity = 'critical' | 'soft' | 'server'

export interface CompatGate {
  feature: string
  severity: GateSeverity
  minAppVersion: string
  apiLevel: number
  description: string
  descriptionAr?: string | null
  descriptionFr?: string | null
}

export interface CompatResult {
  serverVersion: string
  serverApiLevel: number
  minSupportedApiLevel: number
  appVersion: string
  appApiLevel: number | null
  /** The app can run against this server (nothing critical pending). */
  compatible: boolean
  /** Update ABSOLUTELY required — the app is blocked until it updates. */
  updateRequired: boolean
  /** Update available AND app-facing — recommended (features missing). */
  updateRecommended: boolean
  /** The newest release only changes the server — apps keep running. */
  serverOnlyUpdate: boolean
  updateAvailable: boolean
  latestVersion: string
  latestVersionCode: number
  latestServerOnly: boolean
  latestApiLevel: number | null
  /** Features unavailable until the app updates (severity sorted critical first). */
  blockedFeatures: CompatGate[]
  /** Server-side-only changes shipped after the app's version (no action). */
  serverOnlyChanges: string[]
  /** Human summary (ar/en/fr provided by the caller's locale param). */
  summary: string
  summaryAr: string
  summaryFr: string
}

function compareVersions(a: string, b: string): number {
  const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0)
  const pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1
    if ((pa[i] || 0) < (pb[i] || 0)) return -1
  }
  return 0
}

/** Seed the gates table with this codebase's real feature history (idempotent). */
export const DEFAULT_GATES: Array<Omit<CompatGate, 'severity'> & { severity: GateSeverity }> = [
  {
    feature: 'delta-updates',
    minAppVersion: '0.6.30',
    severity: 'soft',
    apiLevel: 1,
    description: 'Differential updates — apps older than 0.6.30 still update, but via full installers/APKs only.',
    descriptionAr: 'التحديثات التفاضلية — التطبيقات الأقدم من 0.6.30 تُحدَّث عبر المثبّت الكامل فقط.',
    descriptionFr: 'Mises à jour différentielles — les applications plus anciennes utilisent l’installateur complet.',
  },
  {
    feature: 'logs-strict-upload',
    minAppVersion: '0.6.30',
    severity: 'soft',
    apiLevel: 1,
    description: 'Strict log auto-upload (flush-on-error, kiosk device-token ingest). Older apps keep the legacy 30 s uploader.',
    descriptionAr: 'رفع السجلات الصارم (فوري عند الخطأ) — التطبيقات الأقدم تعمل بالرفع الدوري القديم.',
    descriptionFr: 'Envoi strict des journaux — les anciennes applications gardent l’envoi périodique.',
  },
  {
    feature: 'lan-topology-master-pin',
    minAppVersion: '0.6.29',
    severity: 'soft',
    apiLevel: 1,
    description: 'Owner Master-PC pinning + branch connection map (desktops older than 0.6.29 keep automatic election).',
    descriptionAr: 'تثبيت الـ Master PC وخريطة اتصالات الفرع — الأجهزة الأقدم تكمل بالانتخاب التلقائي.',
    descriptionFr: 'Épinglage du PC maître — les anciennes versions gardent l’élection automatique.',
  },
  {
    feature: 'counter-control-live-holder',
    minAppVersion: '0.6.29',
    severity: 'soft',
    apiLevel: 1,
    description: 'Counter control honours a live holder (open app = active). Older apps lose idle counters after 60 s.',
    descriptionAr: 'التحكم بالشباك يحترم الحساب الحيّ — التطبيقات الأقدم تفقد الشباك بعد دقيقة خمول.',
    descriptionFr: 'Le contrôle de guichet respecte un titulaire actif.',
  },
  {
    feature: 'eddahabia-payments',
    minAppVersion: '0.6.24',
    severity: 'soft',
    apiLevel: 1,
    description: 'EDDAHABIA card payments + Chargily redirect lifecycle fixes (0.6.24).',
    descriptionAr: 'مدفوعات بطاقة الذهبية وإصلاحات دورة Chargily (0.6.24).',
    descriptionFr: 'Paiements carte EDDAHABIA + cycle Chargily (0.6.24).',
  },
]

export async function seedDefaultGates(): Promise<number> {
  let created = 0
  for (const gate of DEFAULT_GATES) {
    const existing = await db.apiFeatureGate.findUnique({ where: { feature: gate.feature } })
    if (existing) continue
    await db.apiFeatureGate.create({ data: { ...gate } })
    created++
  }
  return created
}

/**
 * Evaluate the full compatibility picture for a running app.
 * @param appVersion  the running app's semver
 * @param appApiLevel the API level the app was built for (null = unknown)
 * @param platform    optional — picks the latest published version of that
 *                    platform; when omitted the windows channel is used as
 *                    the reference release (matches /check's semantics).
 */
export async function evaluateCompatibility(
  appVersion: string,
  appApiLevel: number | null,
  platform = 'windows',
): Promise<CompatResult> {
  const gates = await db.apiFeatureGate.findMany({ where: { enabled: true } })
  const candidates = await db.appVersion.findMany({
    where: { platform, isPublished: true },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })
  const latest = pickLatestAppVersion(candidates)
  const updateAvailable = !!latest && compareVersions(latest.version, appVersion) > 0

  // ── Feature gates: what cannot run on THIS app version? ──────────────────
  const blockedFeatures: CompatGate[] = gates
    .filter((g) => compareVersions(appVersion, g.minAppVersion) < 0)
    .map((g) => ({
      feature: g.feature,
      severity: (g.severity as GateSeverity) || 'soft',
      minAppVersion: g.minAppVersion,
      apiLevel: g.apiLevel,
      description: g.description,
      descriptionAr: g.descriptionAr,
      descriptionFr: g.descriptionFr,
    }))
    .sort((a, b) => (a.severity === 'critical' ? -1 : 1) - (b.severity === 'critical' ? -1 : 1))

  const criticalPending = blockedFeatures.some((g) => g.severity === 'critical')

  // ── API-level floor: a build too old to even speak the current protocol ──
  const levelFloorBreached =
    appApiLevel != null && appApiLevel < MIN_SUPPORTED_API_LEVEL

  const compatible = !criticalPending && !levelFloorBreached
  const updateRequired = !compatible

  // ── Server-only detection: does the newest release demand app action? ────
  const latestServerOnly = latest?.serverOnly === true
  // A release whose apiLevel matches the running app's level adds nothing
  // app-facing — treat it as server-side too (when both levels are known).
  const sameLevelNoop =
    updateAvailable &&
    latest?.apiLevel != null &&
    appApiLevel != null &&
    latest.apiLevel === appApiLevel &&
    blockedFeatures.length === 0
  const serverOnlyUpdate = updateAvailable && (latestServerOnly || sameLevelNoop)

  // Server-side-only changes shipped after the app's version (history walk).
  const serverOnlyChanges = candidates
    .filter((v) => compareVersions(v.version, appVersion) > 0 && (v.serverOnly || v.apiLevel === appApiLevel))
    .map((v) => v.version)

  const updateRecommended = updateAvailable && !serverOnlyUpdate && compatible

  // ── Human summaries ──────────────────────────────────────────────────────
  const criticalList = blockedFeatures.filter((g) => g.severity === 'critical')
  const softList = blockedFeatures.filter((g) => g.severity === 'soft')
  let summary: string
  let summaryAr: string
  let summaryFr: string
  if (updateRequired) {
    summary = `This app version ${appVersion} CANNOT run against server ${SERVER_VERSION}: ${criticalList.length ? criticalList.map((g) => g.feature).join(', ') : 'API level too old'}. Update ${latest?.version ?? 'to the latest release'} immediately.`
    summaryAr = `نسخة التطبيق ${appVersion} لا يمكنها العمل مع الخادم ${SERVER_VERSION}: ${criticalList.length ? criticalList.map((g) => g.feature).join('، ') : 'مستوى API قديم جدًا'}. حدِّث إلى ${latest?.version ?? 'أحدث إصدار'} فورًا.`
    summaryFr = `La version ${appVersion} de l’application ne peut pas fonctionner avec le serveur ${SERVER_VERSION} : ${criticalList.length ? criticalList.map((g) => g.feature).join(', ') : 'niveau API trop ancien'}. Mettez à jour vers ${latest?.version ?? 'la dernière version'} immédiatement.`
  } else if (serverOnlyUpdate) {
    summary = `Server ${SERVER_VERSION} shipped a SERVER-ONLY update (${latest?.version}) — your app ${appVersion} can keep running, no app update is needed.`
    summaryAr = `الخادم ${SERVER_VERSION} تلقى تحديثًا من جهة الخادم فقط (${latest?.version}) — تطبيقك ${appVersion} يواصل العمل ولا يحتاج أي تحديث.`
    summaryFr = `Le serveur ${SERVER_VERSION} a reçu une mise à jour côté serveur uniquement (${latest?.version}) — votre application ${appVersion} continue de fonctionner sans mise à jour.`
  } else if (softList.length > 0 && updateAvailable) {
    summary = `Your app ${appVersion} runs fine on server ${SERVER_VERSION}, but ${softList.length} feature(s) need v${latest?.version}: ${softList.map((g) => g.feature).join(', ')}.`
    summaryAr = `تطبيقك ${appVersion} يعمل على الخادم ${SERVER_VERSION}، لكن ${softList.length} وظيفة تحتاج الإصدار ${latest?.version}: ${softList.map((g) => g.feature).join('، ')}.`
    summaryFr = `Votre application ${appVersion} fonctionne sur le serveur ${SERVER_VERSION}, mais ${softList.length} fonctionnalité(s) requièrent la v${latest?.version} : ${softList.map((g) => g.feature).join(', ')}.`
  } else if (softList.length > 0) {
    summary = `Your app ${appVersion} runs fine on server ${SERVER_VERSION}. ${softList.length} newer feature(s) exist but no release is published yet.`
    summaryAr = `تطبيقك ${appVersion} يعمل على الخادم ${SERVER_VERSION}. توجد وظائف أحدث لكن لا إصدار منشور بعد.`
    summaryFr = `Votre application ${appVersion} fonctionne sur le serveur ${SERVER_VERSION}. Des fonctionnalités plus récentes existent mais aucune version n’est publiée.`
  } else {
    summary = `App ${appVersion} is fully compatible with server ${SERVER_VERSION}.`
    summaryAr = `التطبيق ${appVersion} متوافق تمامًا مع الخادم ${SERVER_VERSION}.`
    summaryFr = `L’application ${appVersion} est entièrement compatible avec le serveur ${SERVER_VERSION}.`
  }

  return {
    serverVersion: SERVER_VERSION,
    serverApiLevel: CURRENT_SERVER_API_LEVEL,
    minSupportedApiLevel: MIN_SUPPORTED_API_LEVEL,
    appVersion,
    appApiLevel,
    compatible,
    updateRequired,
    updateRecommended,
    serverOnlyUpdate,
    updateAvailable,
    latestVersion: latest?.version ?? '',
    latestVersionCode: latest?.versionCode ?? 0,
    latestServerOnly,
    latestApiLevel: latest?.apiLevel ?? null,
    blockedFeatures,
    serverOnlyChanges,
    summary,
    summaryAr,
    summaryFr,
  }
}
