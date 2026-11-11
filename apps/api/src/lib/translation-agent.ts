/**
 * BLASTI AI Translation Agent (0.6.61) — GLM-flash powered, dictionary-first.
 *
 * WHAT IT DOES (and NOTHING else — the prompt contract is deliberately
 * rigid): translate user-typed content between the three app languages
 * (ar/en/fr) and, ONLY for a brand-new agency category, pick ONE suitable
 * emoji icon. Everything the agent produces is stored in the local
 * dictionary (TranslationEntry) with its translation key, and the dictionary
 * is consulted FIRST on every future need — the agent is only called for
 * vocabulary it has never seen. The dictionary unit is the WHOLE source
 * string (normalized, sha256-keyed), so it handles single words AND full
 * sentences equally.
 *
 * CAPACITY GATE: the agent NEVER runs per-request. Jobs accumulate in
 * TranslationJob and are processed in ONE batched LLM call every N minutes
 * (config.intervalMinutes, default 5) by startTranslationAgentScheduler().
 * Results are validated, sorted, and applied to the referencing rows
 * (agency name/description, service names, category names, category terms)
 * — only EMPTY target fields are filled, so manual edits are never overrun.
 *
 * PROVIDERS: an active TranslationApiKey with real key material (an explicit
 * 'openai-compatible' entry, or a z.ai platform key pasted under 'zai') wins
 * — z.ai base is the default; otherwise the bundled z-ai-web-dev-sdk is used.
 * 0.6.64: the model is PINNED to glm-4.7-flash (free flash tier) in ALL
 * cases. Transient flash-tier errors (1305/429/5xx) are retried automatically.
 */

import { createHash } from 'node:crypto'
import { db } from '@blasti/db'

// ─── Action trail (0.6.62 — Logs Manager + Category Language page) ──────────

export type AgentLogAction =
  | 'ENQUEUE_AGENCY' | 'ENQUEUE_CATEGORY' | 'CREATE_CATEGORY'
  | 'BATCH_RUN' | 'BATCH_FAIL' | 'KEY_TEST' | 'PROCESS_NOW'
  | 'SETTINGS_UPDATE' | 'KEY_CREATE' | 'KEY_UPDATE' | 'KEY_DELETE'
  | 'DICTIONARY_EDIT' | 'DICTIONARY_DELETE'
  | 'LOGS_EXPORT'

export interface AgentLogInput {
  action: AgentLogAction
  status?: 'success' | 'error' | 'info'
  summary: string
  details?: Record<string, unknown>
  refType?: string | null
  refId?: string | null
  /** 'scheduler' | 'admin:<userId>' | 'owner:<userId>' | 'system'. */
  actor?: string
  provider?: string | null
  durationMs?: number | null
}

/**
 * Append ONE row to the agent action trail (TranslationAgentLog). The trail
 * feeds the Logs Manager's "Translation agent" tab AND the per-category call
 * log on the Category Language page. Logging must NEVER break its caller —
 * every failure is swallowed after a console warning.
 */
export async function logAgentAction(input: AgentLogInput): Promise<void> {
  try {
    await db.translationAgentLog.create({
      data: {
        action: input.action,
        status: input.status ?? 'success',
        summary: String(input.summary || '').slice(0, 500),
        details: input.details ? JSON.stringify(input.details).slice(0, 8000) : null,
        refType: input.refType ?? null,
        refId: input.refId ?? null,
        actor: input.actor || 'system',
        provider: input.provider ?? null,
        durationMs:
          typeof input.durationMs === 'number' && Number.isFinite(input.durationMs)
            ? Math.round(input.durationMs)
            : null,
      },
    })
  } catch (error) {
    console.warn('[translation-agent] action-log failed:', (error as Error)?.message || error)
  }
}

// ─── Constants ───────────────────────────────────────────────────────────────

export const AGENT_LANGS = ['ar', 'en', 'fr'] as const
export type AgentLang = (typeof AGENT_LANGS)[number]

/** Maximum source text accepted (agency descriptions stay well under this). */
const MAX_SOURCE_CHARS = 2000
/** A failed job is retried on the next windows, then parked as 'failed'. */
const MAX_JOB_ATTEMPTS = 3
/** create-category jobs processed per window (each also asks for an icon). */
const MAX_CATEGORY_JOBS_PER_RUN = 5
/** Hard LLM call timeout — a stuck provider must never wedge the window. */
const LLM_TIMEOUT_MS = 120_000

// ─── Provider constants (0.6.63 — verified against the live z.ai platform) ──

/** Default OpenAI-compatible base for the z.ai open platform. */
const ZAI_DEFAULT_BASE = 'https://api.z.ai/api/paas/v4'
/**
 * 0.6.64 — PINNED MODEL, admin decision: the agent calls the free flash
 * model on the z.ai open platform in ALL cases. Nothing can point it at a
 * different model anymore — not a hand-typed id on a stored key, not the
 * editable settings field (now display-only), nothing. `glm-4.6-flash` —
 * the old default — DOES NOT EXIST on api.z.ai (live-verified: error 1211
 * "Unknown Model"), which is exactly why stored-key connections kept
 * failing; every stored/typed id is ignored and every DB row is re-stamped
 * with the pinned id at boot (see the heal in startTranslationAgentScheduler).
 */
export const DEFAULT_AGENT_MODEL = 'glm-4.7-flash'

/** A stored 'zai'-provider key counts as REAL key material unless it is the placeholder. */
function isRealKeyMaterial(apiKey: string | null | undefined): boolean {
  const s = String(apiKey ?? '').trim()
  return s.length > 0 && s !== 'SDK-MANAGED'
}

/**
 * Transient provider failures worth retrying: HTTP 429, any 5xx, and the
 * z.ai flash-tier saturation error 1305 ("temporarily overloaded") —
 * live-verified to clear within a few seconds on retry. Definitive errors
 * (401/403 auth, 1113 balance, 1211 unknown model, 400 body) fail fast.
 */
function isRetryableHttpFailure(status: number, body: string): boolean {
  if (status === 429 || status >= 500) return true
  return /"code"\s*:\s*"1305"/.test(body)
}

/** True when the base URL is a GLM-native endpoint that accepts `thinking`. */
function supportsThinkingDisable(base: string): boolean {
  return /z\.ai|bigmodel\.cn/i.test(base)
}

const REF_TYPES = ['agency', 'service', 'agency-category', 'category-term'] as const
type RefType = (typeof REF_TYPES)[number]

/** Fields the agent may ever write, per ref type (strict whitelist). */
const APPLYABLE_FIELDS: Record<RefType, ReadonlySet<string>> = {
  agency: new Set(['nameAr', 'nameFr', 'descriptionAr', 'descriptionFr']),
  service: new Set(['nameAr', 'nameFr']),
  'agency-category': new Set(['nameAr', 'nameFr']),
  'category-term': new Set(['valueAr', 'valueEn', 'valueFr']),
}

// ─── Small helpers ───────────────────────────────────────────────────────────

export function sanitizeLang(v: unknown): AgentLang {
  const s = String(v ?? '').trim().toLowerCase()
  return (AGENT_LANGS as readonly string[]).includes(s) ? (s as AgentLang) : 'en'
}

/** Dictionary identity: collapse all whitespace variants, then hash. */
export function normalizeForDictionary(text: string): string {
  return String(text || '').replace(/\s+/g, ' ').trim()
}

export function hashText(text: string): string {
  return createHash('sha256').update(normalizeForDictionary(text), 'utf8').digest('hex')
}

/**
 * Light source-language guess for fields whose language is NOT known
 * (e.g. a category base `name` typed months ago). The creation flow does not
 * need this — it passes the UI language explicitly (authoritative).
 * French must also match UNACCENTED text ("Cabinet dentaire") — hence the
 * stopword markers, safe inside the 3-language universe (ar/en/fr).
 */
const FRENCH_MARKERS_RE =
  /\b(le|la|les|des|du|de|un|une|et|pour|avec|dans|sur|au|aux|d'|l'|qu'|centre|cabinet|clinique|institut|salon|agence|societe|société|pharmacie|laboratoire)\b/i

export function detectLang(text: string): AgentLang {
  const s = String(text || '')
  if (/[\u0600-\u06FF]/.test(s)) return 'ar'
  if (/[àâçéèêëîïôùûüœÀÂÇÉÈÊËÎÏÔÙÛÜŒ]/.test(s)) return 'fr'
  if (FRENCH_MARKERS_RE.test(s)) return 'fr'
  return 'en'
}

/** Exactly one emoji glyph (the icon contract for new categories). */
function isValidEmojiIcon(v: unknown): v is string {
  const s = String(v ?? '').trim()
  try {
    return [...s].length === 1 && /\p{Extended_Pictographic}/u.test(s)
  } catch {
    return /\u{1F300}-\u{1FAFF}|[\u{2600}-\u{27BF}]/u.test(s)
  }
}

function empty(v: unknown): boolean {
  return v === null || v === undefined || String(v).trim() === ''
}

// ─── Config ──────────────────────────────────────────────────────────────────

export async function getAgentConfig() {
  const existing = await db.translationAgentConfig.findUnique({ where: { id: 'singleton' } })
  if (existing) return existing
  return db.translationAgentConfig.create({ data: { id: 'singleton' } })
}

// ─── Apply (dictionary hits + batch results) ────────────────────────────────

/**
 * Write a translation into ONE whitelisted field of the referencing row —
 * ONLY when that field is currently empty (manual content always wins).
 * Returns true when a write actually happened.
 */
async function applyTranslation(
  refType: RefType,
  refId: string,
  field: string,
  targetText: string,
): Promise<boolean> {
  const text = String(targetText || '').trim()
  if (!text || !REF_TYPES.includes(refType)) return false
  if (!APPLYABLE_FIELDS[refType]?.has(field)) return false

  try {
    if (refType === 'agency') {
      const row = await db.agency.findUnique({ where: { id: refId }, select: { [field]: true } })
      if (!row || !empty((row as Record<string, unknown>)[field])) return false
      await db.agency.update({ where: { id: refId }, data: { [field]: text } })
      return true
    }
    if (refType === 'service') {
      const row = await db.service.findUnique({ where: { id: refId }, select: { [field]: true } })
      if (!row || !empty((row as Record<string, unknown>)[field])) return false
      await db.service.update({ where: { id: refId }, data: { [field]: text } })
      return true
    }
    if (refType === 'agency-category') {
      const row = await db.agencyCategory.findUnique({ where: { id: refId }, select: { [field]: true } })
      if (!row || !empty((row as Record<string, unknown>)[field])) return false
      await db.agencyCategory.update({ where: { id: refId }, data: { [field]: text } })
      return true
    }
    // category-term
    const row = await db.categoryTerm.findUnique({ where: { id: refId }, select: { [field]: true } })
    if (!row || !empty((row as Record<string, unknown>)[field])) return false
    await db.categoryTerm.update({ where: { id: refId }, data: { [field]: text } })
    return true
  } catch (error) {
    console.warn(`[translation-agent] apply failed (${refType}/${field}):`, (error as Error)?.message || error)
    return false
  }
}

async function storeDictionaryEntry(input: {
  sourceText: string
  sourceLang: AgentLang
  targetLang: AgentLang
  targetText: string
  domain: string
  key?: string | null
  origin?: 'agent' | 'manual'
}): Promise<void> {
  const sourceText = normalizeForDictionary(input.sourceText).slice(0, MAX_SOURCE_CHARS)
  const targetText = String(input.targetText || '').trim()
  if (!sourceText || !targetText) return
  try {
    await db.translationEntry.upsert({
      where: {
        sourceHash_sourceLang_targetLang: {
          sourceHash: hashText(sourceText),
          sourceLang: input.sourceLang,
          targetLang: input.targetLang,
        },
      },
      create: {
        sourceHash: hashText(sourceText),
        sourceLang: input.sourceLang,
        sourceText,
        targetLang: input.targetLang,
        targetText: targetText.slice(0, 4000),
        domain: input.domain || 'general',
        key: input.key ?? null,
        origin: input.origin ?? 'agent',
      },
      update: {
        targetText: targetText.slice(0, 4000),
        origin: input.origin ?? 'agent',
        usageCount: { increment: 1 },
      },
    })
  } catch (error) {
    console.warn('[translation-agent] dictionary store failed:', (error as Error)?.message || error)
  }
}

// ─── Enqueue (dictionary-first) ─────────────────────────────────────────────

export interface EnqueueTextOptions {
  text: string
  sourceLang: AgentLang
  domain: string
  key?: string | null
  refType: RefType
  refId: string
  field: string
}

export interface EnqueueSummary {
  queued: number
  applied: number
  skipped: number
}

/**
 * Queue ONE source string for translation into the two other languages —
 * dictionary hits apply IMMEDIATELY (no agent cost), misses become jobs for
 * the next 5-minute window.
 */
export async function enqueueTextTranslation(opts: EnqueueTextOptions): Promise<EnqueueSummary> {
  const summary: EnqueueSummary = { queued: 0, applied: 0, skipped: 0 }
  const text = normalizeForDictionary(opts.text)
  if (!text || text.length > MAX_SOURCE_CHARS) {
    summary.skipped++
    return summary
  }
  const sourceLang = sanitizeLang(opts.sourceLang)
  const hash = hashText(text)

  for (const targetLang of AGENT_LANGS) {
    if (targetLang === sourceLang) continue
    try {
      const entry = await db.translationEntry.findUnique({
        where: { sourceHash_sourceLang_targetLang: { sourceHash: hash, sourceLang, targetLang } },
      })
      if (entry?.targetText) {
        // Dictionary hit — apply now, count the usage, zero agent cost.
        if (await applyTranslation(opts.refType, opts.refId, opts.field, entry.targetText)) summary.applied++
        else summary.skipped++
        await db.translationEntry.update({ where: { id: entry.id }, data: { usageCount: { increment: 1 } } })
        continue
      }
      const dup = await db.translationJob.findFirst({
        where: {
          type: 'translate-text',
          status: { in: ['pending', 'processing'] },
          sourceHash: hash,
          sourceLang,
          targetLang,
          refType: opts.refType,
          refId: opts.refId,
          field: opts.field,
        },
        select: { id: true },
      })
      if (dup) {
        summary.skipped++
        continue
      }
      await db.translationJob.create({
        data: {
          type: 'translate-text',
          status: 'pending',
          sourceHash: hash,
          sourceLang,
          targetLang,
          sourceText: text,
          domain: opts.domain,
          key: opts.key ?? null,
          refType: opts.refType,
          refId: opts.refId,
          field: opts.field,
        },
      })
      summary.queued++
    } catch (error) {
      console.warn('[translation-agent] enqueue failed:', (error as Error)?.message || error)
      summary.skipped++
    }
  }
  return summary
}

function mergeSummaries(target: EnqueueSummary, add: EnqueueSummary): void {
  target.queued += add.queued
  target.applied += add.applied
  target.skipped += add.skipped
}

/**
 * Fill the source-language canonical column by COPY (never via the agent):
 * text typed in the Arabic UI also lands in nameAr/descriptionAr, etc. The
 * base `name`/`description` column doubles as the English display, so an
 * English-typed string needs no copy.
 */
async function copySourceCanonical(
  refType: RefType,
  refId: string,
  field: 'nameAr' | 'nameFr' | 'descriptionAr' | 'descriptionFr' | 'valueAr' | 'valueEn' | 'valueFr',
  text: string,
): Promise<void> {
  if (!text.trim()) return
  await applyTranslation(refType, refId, field, text)
}

/** Explicit target column for a language on agency/service rows (base column = EN display). */
function nameFieldFor(lang: AgentLang): 'nameAr' | 'nameFr' | null {
  if (lang === 'ar') return 'nameAr'
  if (lang === 'fr') return 'nameFr'
  return null // 'en' lives in the base column — never overwritten by the agent
}

/**
 * One-call enqueue for the agency-creation flow: agency name, description
 * and every service name the owner typed in ONE language. The base column
 * keeps exactly what was typed; the agent fills only the EMPTY explicit
 * language columns.
 */
export async function enqueueAgencyContentTranslations(input: {
  agencyId: string
  name: string
  nameAr?: string | null
  nameFr?: string | null
  description?: string | null
  descriptionAr?: string | null
  descriptionFr?: string | null
  services?: Array<{ id: string; name: string; nameAr?: string | null; nameFr?: string | null }>
  contentLanguage?: string | null
  /** Trail actor (who triggered the enqueue) — defaults to 'system'. */
  actor?: string
}): Promise<EnqueueSummary> {
  const total: EnqueueSummary = { queued: 0, applied: 0, skipped: 0 }
  const sourceLang = sanitizeLang(input.contentLanguage)

  // ── Agency name ──
  const name = normalizeForDictionary(input.name)
  if (name) {
    // Canonical copy for the source language column (ar→nameAr, fr→nameFr).
    const canonField = nameFieldFor(sourceLang)
    if (canonField && empty(canonField === 'nameAr' ? input.nameAr : input.nameFr)) {
      await copySourceCanonical('agency', input.agencyId, canonField, name)
    }
    for (const targetLang of AGENT_LANGS) {
      if (targetLang === sourceLang) continue
      const field = nameFieldFor(targetLang)
      if (!field) continue // en target → base column holds the typed text already
      if (!empty(targetLang === 'ar' ? input.nameAr : input.nameFr)) continue
      mergeSummaries(total, await enqueueTextTranslation({
        text: name, sourceLang, domain: 'agency', refType: 'agency', refId: input.agencyId, field,
      }))
    }
  }

  // ── Agency description ──
  const description = normalizeForDictionary(input.description || '')
  if (description) {
    const canonField = sourceLang === 'ar' ? 'descriptionAr' : sourceLang === 'fr' ? 'descriptionFr' : null
    if (canonField && empty(canonField === 'descriptionAr' ? input.descriptionAr : input.descriptionFr)) {
      await copySourceCanonical('agency', input.agencyId, canonField, description)
    }
    for (const targetLang of AGENT_LANGS) {
      if (targetLang === sourceLang) continue
      const field = targetLang === 'ar' ? 'descriptionAr' : targetLang === 'fr' ? 'descriptionFr' : null
      if (!field) continue
      if (!empty(targetLang === 'ar' ? input.descriptionAr : input.descriptionFr)) continue
      mergeSummaries(total, await enqueueTextTranslation({
        text: description, sourceLang, domain: 'agency', refType: 'agency', refId: input.agencyId, field,
      }))
    }
  }

  // ── Service names ──
  for (const svc of input.services || []) {
    const svcName = normalizeForDictionary(svc.name)
    if (!svcName) continue
    const canonField = nameFieldFor(sourceLang)
    if (canonField && empty(canonField === 'nameAr' ? svc.nameAr : svc.nameFr)) {
      await copySourceCanonical('service', svc.id, canonField, svcName)
    }
    for (const targetLang of AGENT_LANGS) {
      if (targetLang === sourceLang) continue
      const field = nameFieldFor(targetLang)
      if (!field) continue
      if (!empty(targetLang === 'ar' ? svc.nameAr : svc.nameFr)) continue
      mergeSummaries(total, await enqueueTextTranslation({
        text: svcName, sourceLang, domain: 'service', refType: 'service', refId: svc.id, field,
      }))
    }
  }

  // Action trail — one row per agency-content enqueue (never per string).
  if (total.queued > 0 || total.applied > 0) {
    await logAgentAction({
      action: 'ENQUEUE_AGENCY',
      status: total.queued > 0 ? 'success' : 'info',
      summary: `agency content → ${total.queued} queued for the agent, ${total.applied} served from the dictionary, ${total.skipped} skipped`,
      details: {
        ...total,
        name: (input.name || '').slice(0, 80),
        contentLanguage: sourceLang,
        services: (input.services || []).length,
      },
      refType: 'agency',
      refId: input.agencyId,
      actor: input.actor,
    })
  }

  return total
}

/**
 * Category Language page — enqueue the category NAME + every term override
 * still missing translations. Source language per string: explicit columns
 * carry their own language; the base `name` is detected heuristically.
 */
export async function enqueueCategoryTranslations(categoryId: string, actor?: string): Promise<EnqueueSummary> {
  const total: EnqueueSummary = { queued: 0, applied: 0, skipped: 0 }
  const category = await db.agencyCategory.findUnique({
    where: { id: categoryId },
    include: { terms: true },
  })
  if (!category) return total

  // ── Category name: fill only the EMPTY explicit columns ──
  const candidates: Array<{ lang: AgentLang; text: string }> = []
  if (category.nameAr?.trim()) candidates.push({ lang: 'ar', text: category.nameAr.trim() })
  if (category.nameFr?.trim()) candidates.push({ lang: 'fr', text: category.nameFr.trim() })
  if (category.name.trim()) candidates.push({ lang: detectLang(category.name), text: category.name.trim() })
  const source = candidates[0]
  if (source) {
    for (const targetLang of AGENT_LANGS) {
      if (targetLang === source.lang) continue
      const field = nameFieldFor(targetLang)
      if (!field) continue
      if (!empty(targetLang === 'ar' ? category.nameAr : category.nameFr)) continue
      mergeSummaries(total, await enqueueTextTranslation({
        text: source.text, sourceLang: source.lang, domain: 'category',
        refType: 'agency-category', refId: category.id, field,
      }))
    }
  }

  // ── Terms: source = the one filled value, targets = the other two ──
  for (const term of category.terms) {
    const values: Array<{ lang: AgentLang; field: 'valueAr' | 'valueEn' | 'valueFr'; text: string }> = ([
      { lang: 'ar' as AgentLang, field: 'valueAr' as const, text: term.valueAr || '' },
      { lang: 'en' as AgentLang, field: 'valueEn' as const, text: term.valueEn || '' },
      { lang: 'fr' as AgentLang, field: 'valueFr' as const, text: term.valueFr || '' },
    ]).filter((v) => v.text.trim())
    if (!values.length) continue
    const termSource = values[0]
    for (const target of values) {
      if (target.lang === termSource.lang) continue
      mergeSummaries(total, await enqueueTextTranslation({
        text: termSource.text, sourceLang: termSource.lang, domain: 'term', key: term.key,
        refType: 'category-term', refId: term.id, field: target.field,
      }))
    }
  }

  // Action trail — the Category Language page reads this back as its call log.
  if (total.queued > 0 || total.applied > 0) {
    await logAgentAction({
      action: 'ENQUEUE_CATEGORY',
      status: total.queued > 0 ? 'success' : 'info',
      summary: `category "${category.name}" → ${total.queued} queued for the agent, ${total.applied} served from the dictionary, ${total.skipped} skipped`,
      details: {
        ...total,
        categorySlug: category.slug,
        categoryName: category.name,
        terms: category.terms.length,
        termIds: category.terms.map((term) => term.id).slice(0, 60),
      },
      refType: 'agency-category',
      refId: categoryId,
      actor,
    })
  }

  return total
}

// ─── New-category flow (create-agency wizard) ────────────────────────────────

function slugifyCategoryName(raw: string): string {
  const ascii = raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase()
    .slice(0, 32)
  return ascii.length >= 2 ? ascii : ''
}

/**
 * The create-agency wizard accepted a NEW category name: create the row NOW
 * (so Agency.category references a real slug — the agency dashboard works
 * immediately) and queue the agent job that translates the name into the
 * three languages + picks the emoji icon. The agent's window merge makes the
 * category a fully integrated, trilingual citizen of the app within minutes.
 */
export async function createPendingCategory(
  rawName: string,
  sourceLang: AgentLang,
  createdBy?: string | null,
): Promise<{ id: string; slug: string; name: string; alreadyExisted: boolean }> {
  const name = normalizeForDictionary(rawName).slice(0, 60)
  if (!name) throw new Error('EMPTY_CATEGORY_NAME')

  // Case-insensitive dedup — an existing category is REUSED, never duplicated.
  const existing = await db.agencyCategory.findFirst({
    where: { name: { equals: name, mode: 'insensitive' } },
    select: { id: true, slug: true, name: true },
  })
  if (existing) {
    // Still queue enrichment in case its translations/icon are incomplete.
    const pending = await db.translationJob.findFirst({
      where: { type: 'create-category', status: { in: ['pending', 'processing'] }, payload: { contains: existing.id } },
      select: { id: true },
    })
    if (!pending) {
      await db.translationJob.create({
        data: {
          type: 'create-category', status: 'pending',
          payload: JSON.stringify({ categoryRowId: existing.id, slug: existing.slug, name, sourceLang }),
        },
      })
    }
    await logAgentAction({
      action: 'CREATE_CATEGORY',
      status: 'info',
      summary: `category "${name}" reused (existing slug ${existing.slug}) — ${pending ? 'enrichment already queued' : 'enrichment queued for the agent'}`,
      details: { slug: existing.slug, name, sourceLang, reused: true },
      refType: 'agency-category',
      refId: existing.id,
      actor: createdBy ? `owner:${createdBy}` : 'system',
    })
    return { ...existing, alreadyExisted: true }
  }

  // Unique slug: ASCII fold of the name, random fallback, numeric suffix loop.
  let slug = slugifyCategoryName(name)
  if (!slug) slug = `CUSTOM_${createHash('sha256').update(name).digest('hex').slice(0, 6).toUpperCase()}`
  for (let i = 0; i < 20; i++) {
    const candidate = i === 0 ? slug : `${slug}_${i + 1}`
    const clash = await db.agencyCategory.findUnique({ where: { slug: candidate }, select: { id: true } })
    if (!clash) { slug = candidate; break }
    if (i === 19) slug = `CUSTOM_${Date.now().toString(36).toUpperCase()}`
  }

  const row = await db.agencyCategory.create({
    data: { slug, name, isCustom: true, createdBy: createdBy ?? null, isActive: true, sortOrder: 100 },
    select: { id: true, slug: true, name: true },
  })

  await db.translationJob.create({
    data: {
      type: 'create-category', status: 'pending',
      payload: JSON.stringify({ categoryRowId: row.id, slug: row.slug, name, sourceLang }),
    },
  })

  await logAgentAction({
    action: 'CREATE_CATEGORY',
    status: 'success',
    summary: `new category "${name}" created (slug ${row.slug}) — trilingual names + emoji icon queued for the agent`,
    details: { slug: row.slug, name, sourceLang, reused: false },
    refType: 'agency-category',
    refId: row.id,
    actor: createdBy ? `owner:${createdBy}` : 'system',
  })

  return { ...row, alreadyExisted: false }
}

// ─── LLM call (strict contract) ─────────────────────────────────────────────

const AGENT_SYSTEM_PROMPT = `You are the BLASTI translation agent. You do EXACTLY ONE job: translate the given strings between Arabic (ar), English (en) and French (fr), and — only when an item is marked as a category — pick ONE emoji icon for it.
ABSOLUTE RULES:
1. Output ONLY one minified JSON object. No markdown fences, no commentary, no extra keys, no trailing text.
2. Exact shape: {"items":[{"id":"<as given>","t":{"<lang>":"<translation>"}}],"categories":[{"id":"<as given>","name":"<english name>","nameAr":"<arabic name>","nameFr":"<french name>","icon":"<one emoji>"}]}
3. Omit "items" when there are none; omit "categories" when there are none.
4. Translate faithfully, concisely and professionally. Keep numbers, codes and brand names as-is. Do not add quotes, notes or explanations around translations.
5. "icon" MUST be exactly ONE emoji character suitable for the business category. Never a word, never more than one emoji.
6. If a string is already written in a target language, return it unchanged for that language.
7. Never invent content beyond the provided strings. Never answer anything that is not this JSON.`

interface LLMCallResult {
  ok: boolean
  content?: string
  error?: string
  provider: string
}

interface ChatMessage {
  role: 'system' | 'assistant' | 'user'
  content: string
}

interface HTTPAttemptResult {
  ok: boolean
  content?: string
  error?: string
  /** true → the failure is transient (retryable); false → definitive. */
  retryable?: boolean
}

/**
 * ONE OpenAI-compatible chat attempt. Z.ai is live-verified: it returns
 * proper HTTP error codes with a JSON body {error:{code,message}}, and the
 * flash model may answer with `reasoning_content` alongside `content` —
 * only `content` is ever used (strict contract).
 */
async function chatCompletionAttempt(opts: {
  base: string
  apiKey: string
  model: string
  messages: ChatMessage[]
  temperature: number
  timeoutMs: number
}): Promise<HTTPAttemptResult> {
  const base = opts.base.replace(/\/+$/, '')
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify({
        model: opts.model,
        temperature: opts.temperature,
        stream: false,
        ...(supportsThinkingDisable(base) ? { thinking: { type: 'disabled' } } : {}),
        messages: opts.messages,
      }),
      signal: AbortSignal.timeout(opts.timeoutMs),
    })
    const body = await res.text().catch(() => '')
    if (!res.ok) {
      const detail = body.slice(0, 300) || `HTTP ${res.status}`
      return { ok: false, error: `HTTP ${res.status} — ${detail}`, retryable: isRetryableHttpFailure(res.status, body) }
    }
    const data = JSON.parse(body || '{}') as {
      choices?: Array<{ message?: { content?: string } }>
      error?: { code?: string; message?: string }
    }
    // Some gateways answer HTTP 200 with an error object inside — treat it honestly.
    if (data?.error?.message) {
      const code = data.error.code ? ` (${data.error.code})` : ''
      const transient = String(data.error.code) === '1305'
      return { ok: false, error: `${data.error.message}${code}`, retryable: transient }
    }
    const content = data?.choices?.[0]?.message?.content
    if (!content) return { ok: false, error: 'empty response', retryable: true }
    return { ok: true, content }
  } catch (error) {
    const msg = (error as Error)?.message || 'request failed'
    const isTimeout = (error as Error)?.name === 'TimeoutError' || /timeout|abort/i.test(msg)
    return { ok: false, error: msg, retryable: isTimeout }
  }
}

/**
 * OpenAI-compatible chat WITH retries for transient failures (the z.ai flash
 * tier saturates regularly — a single attempt fails the whole batch window;
 * live-verified that later attempts succeed once capacity frees up).
 * 4 attempts, escalating delays 3s → 8s → 15s.
 */
async function chatCompletionWithRetry(opts: {
  base: string
  apiKey: string
  model: string
  messages: ChatMessage[]
  temperature: number
  timeoutMs: number
  attempts?: number
}): Promise<HTTPAttemptResult> {
  const attempts = Math.max(1, Math.min(5, opts.attempts ?? 4))
  const DELAYS_MS = [3_000, 8_000, 15_000, 20_000]
  let last: HTTPAttemptResult = { ok: false, error: 'unreachable' }
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, DELAYS_MS[Math.min(i - 1, DELAYS_MS.length - 1)]))
    last = await chatCompletionAttempt(opts)
    if (last.ok || !last.retryable) return last
  }
  return last
}

async function callTranslationLLM(
  userPrompt: string,
): Promise<LLMCallResult> {
  // Key priority: an explicit openai-compatible key first; then a REAL key
  // material stored under the 'zai' provider (0.6.63 — admins paste their
  // z.ai platform key there, the UI even invites them to — never ignore it).
  // 0.6.64 — the config row is no longer consulted: the model is pinned.
  const [compatKey, zaiKey] = await Promise.all([
    db.translationApiKey.findFirst({
      where: { isActive: true, provider: 'openai-compatible' },
      orderBy: { updatedAt: 'desc' },
    }),
    db.translationApiKey.findFirst({
      where: { isActive: true, provider: 'zai' },
      orderBy: { updatedAt: 'desc' },
    }),
  ])

  const httpKey =
    compatKey && compatKey.apiKey
      ? { key: compatKey, base: compatKey.baseUrl?.trim() || ZAI_DEFAULT_BASE }
      : zaiKey && isRealKeyMaterial(zaiKey.apiKey)
        ? { key: zaiKey, base: zaiKey.baseUrl?.trim() || ZAI_DEFAULT_BASE }
        : null

  if (httpKey) {
    const provider = `key:${httpKey.key.label}`
    const result = await chatCompletionWithRetry({
      base: httpKey.base,
      apiKey: httpKey.key.apiKey,
      // 0.6.64 — pinned in ALL cases: any id stored on the key or in the
      // config is ignored by design (they kept pointing at dead model ids).
      model: DEFAULT_AGENT_MODEL,
      messages: [
        { role: 'system', content: AGENT_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.2,
      timeoutMs: LLM_TIMEOUT_MS,
    })
    if (result.ok) return { ok: true, content: result.content, provider }
    // 0.6.63 — TRANSIENT key-path failures (z.ai flash saturation 1305/429,
    // 5xx, timeouts) fall back to the bundled SDK so the window still ships:
    // the two tiers run on SEPARATE capacity pools (live-verified: the SDK
    // answered in 357ms while the platform key was being 429'd). DEFINITIVE
    // failures (401/403 auth, 1113 balance, 1211 unknown model) do NOT fall
    // back — the admin must see the real key problem in the trail.
    if (!result.retryable) return { ok: false, error: result.error, provider }
    const fallback = await runSdkPath(userPrompt)
    return fallback.ok
      ? { ok: true, content: fallback.content, provider: `${provider}→zai-sdk (fallback)` }
      : { ok: false, error: `${result.error} | sdk fallback: ${fallback.error}`, provider }
  }

  return runSdkPath(userPrompt)
}

/** The bundled SDK path (free GLM flash) with one retry on transient replies. */
async function runSdkPath(userPrompt: string): Promise<LLMCallResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 3_000))
      const { default: ZAI } = await import('z-ai-web-dev-sdk')
      const zai = await ZAI.create()
      const completion = await zai.chat.completions.create({
        // 0.6.64 — the SDK path calls the SAME pinned flash model.
        model: DEFAULT_AGENT_MODEL,
        messages: [
          { role: 'assistant', content: AGENT_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        thinking: { type: 'disabled' },
      })
      const content = completion.choices[0]?.message?.content
      if (!content) continue // transient empty reply → one retry
      return { ok: true, content, provider: 'zai-sdk' }
    } catch (error) {
      if (attempt === 1) return { ok: false, error: (error as Error)?.message || 'SDK failed', provider: 'zai-sdk' }
    }
  }
  return { ok: false, error: 'empty response (2 attempts)', provider: 'zai-sdk' }
}

/** Test one stored API key with a tiny real translation round-trip. */
export async function testTranslationApiKey(
  keyId: string,
  actor?: string,
): Promise<{ ok: boolean; message: string; sample?: string }> {
  const key = await db.translationApiKey.findUnique({ where: { id: keyId } })
  if (!key) return { ok: false, message: 'key not found' }

  const TEST_MESSAGES: ChatMessage[] = [
    { role: 'system', content: 'You are a translator. Reply with the translation only.' },
    { role: 'user', content: 'Translate to French: "Welcome to Blasti"' },
  ]
  let ok = false
  let message = ''
  let sample: string | undefined

  try {
    if (key.provider === 'openai-compatible' || isRealKeyMaterial(key.apiKey)) {
      // Real key material — hit the OpenAI-compatible endpoint directly.
      // 0.6.63: provider 'zai' with a pasted platform key is tested THROUGH
      // that key (previously it silently tested the SDK instead — the exact
      // "key connection failing" confusion). baseUrl is optional for z.ai.
      if (!key.apiKey) throw new Error('apiKey is required')
      const base = key.baseUrl?.trim() || ZAI_DEFAULT_BASE
      // 0.6.64 — pinned in ALL cases (the key's stored id is never used).
      const model = DEFAULT_AGENT_MODEL
      const result = await chatCompletionWithRetry({
        base,
        apiKey: key.apiKey,
        model,
        messages: TEST_MESSAGES,
        temperature: 0,
        timeoutMs: 60_000,
        attempts: 4,
      })
      if (!result.ok) throw new Error(result.error || 'request failed')
      sample = result.content?.trim()
      ok = true
      message = `OK — model ${model} replied`
    } else {
      // 'zai' without key material — the bundled SDK path.
      const { default: ZAI } = await import('z-ai-web-dev-sdk')
      const zai = await ZAI.create()
      const completion = await zai.chat.completions.create({
        // 0.6.64 — pinned flash model here too (ALL cases).
        model: DEFAULT_AGENT_MODEL,
        messages: TEST_MESSAGES,
        thinking: { type: 'disabled' },
      })
      sample = completion.choices[0]?.message?.content?.trim()
      if (!sample) throw new Error('empty response')
      ok = true
      message = 'OK — bundled GLM SDK replied'
    }
  } catch (error) {
    ok = false
    message = (error as Error)?.message || 'test failed'
  }

  await db.translationApiKey.update({
    where: { id: keyId },
    data: { lastTestAt: new Date(), lastTestOk: ok, lastTestMessage: message.slice(0, 500) },
  })
  await logAgentAction({
    action: 'KEY_TEST',
    status: ok ? 'success' : 'error',
    summary: `API key "${key.label}" test ${ok ? 'passed' : 'failed'}: ${message}`,
    details: { ok, message, sample: sample?.slice(0, 200), keyProvider: key.provider, keyModel: key.model },
    refType: 'api-key',
    refId: keyId,
    actor,
    provider: key.provider,
  })
  return { ok, message, sample }
}

// ─── Batch processor (the 5-minute window) ──────────────────────────────────

interface PromptItem {
  id: string
  kind: 'text' | 'category'
  sourceLang: AgentLang
  sourceText: string
  targets: AgentLang[]
}

function extractJsonBlock(raw: string): Record<string, unknown> | null {
  const text = String(raw || '').trim()
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = (fenced ? fenced[1] : text).trim()
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1))
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function failJobs(ids: string[], error: string): Promise<void> {
  return (async () => {
    for (const id of ids) {
      const job = await db.translationJob.findUnique({ where: { id }, select: { attempts: true } })
      if (!job) continue
      const attempts = job.attempts + 1
      await db.translationJob.update({
        where: { id },
        data: {
          attempts,
          status: attempts >= MAX_JOB_ATTEMPTS ? 'failed' : 'pending',
          error: error.slice(0, 500),
          processedAt: attempts >= MAX_JOB_ATTEMPTS ? new Date() : null,
        },
      })
    }
  })()
}

export interface BatchRunStats {
  ran: boolean
  reason?: string
  textJobs: number
  categoryJobs: number
  applied: number
  stored: number
  provider?: string
  message?: string
}

/**
 * ONE agent window: claim pending jobs → single batched LLM call → validate
 * → store dictionary entries → apply to rows. NEVER throws (scheduler-safe).
 */
export async function runTranslationBatch(force = false, actor = 'scheduler'): Promise<BatchRunStats> {
  const startedAt = Date.now()
  const stats: BatchRunStats = { ran: false, textJobs: 0, categoryJobs: 0, applied: 0, stored: 0 }
  const config = await getAgentConfig()
  if (!config.enabled && !force) {
    stats.reason = 'disabled'
    return stats
  }

  const [textJobs, categoryJobs] = await Promise.all([
    db.translationJob.findMany({
      where: { type: 'translate-text', status: 'pending' },
      orderBy: { createdAt: 'asc' },
      take: Math.max(1, Math.min(100, config.batchSize || 40)),
    }),
    db.translationJob.findMany({
      where: { type: 'create-category', status: 'pending' },
      orderBy: { createdAt: 'asc' },
      take: MAX_CATEGORY_JOBS_PER_RUN,
    }),
  ])

  if (!textJobs.length && !categoryJobs.length) {
    stats.reason = 'empty'
    return stats
  }

  // Claim atomically — another run (or another API instance) cannot double-claim.
  const allIds = [...textJobs, ...categoryJobs].map((j) => j.id)
  const claim = await db.translationJob.updateMany({
    where: { id: { in: allIds }, status: 'pending' },
    data: { status: 'processing' },
  })
  if (claim.count === 0) {
    stats.reason = 'nothing-claimed'
    return stats
  }

  // Group text jobs by (hash, sourceLang) → ONE prompt item per unique string.
  const groups = new Map<string, { item: PromptItem; jobs: typeof textJobs }>()
  for (const job of textJobs) {
    const key = `${job.sourceHash}|${job.sourceLang}`
    const g = groups.get(key)
    if (g) {
      g.jobs.push(job)
      const t = job.targetLang as AgentLang
      if (AGENT_LANGS.includes(t) && !g.item.targets.includes(t)) g.item.targets.push(t)
    } else {
      groups.set(key, {
        item: {
          id: `g${groups.size}`,
          kind: 'text',
          sourceLang: sanitizeLang(job.sourceLang),
          sourceText: String(job.sourceText || ''),
          targets: [sanitizeLang(job.targetLang)],
        },
        jobs: [job],
      })
    }
  }

  const promptPayload = {
    items: [...groups.values()].map((g) => ({
      id: g.item.id,
      sourceLang: g.item.sourceLang,
      translateTo: g.item.targets,
      text: g.item.sourceText,
    })),
    categories: categoryJobs.map((job, index) => {
      let payload: { categoryRowId?: string; name?: string } = {}
      try { payload = JSON.parse(String(job.payload || '{}')) } catch { /* malformed → empty */ }
      return { id: `c${index}`, name: String(payload.name || ''), sourceLang: 'auto' }
    }),
  }

  const llm = await callTranslationLLM(
    `Translate for a queue-management platform. Return ONLY the JSON object.\n${JSON.stringify(promptPayload)}`,
  )

  if (!llm.ok) {
    await failJobs(allIds, `${llm.provider}: ${llm.error}`)
    await db.translationAgentConfig.update({
      where: { id: 'singleton' },
      data: { lastRunAt: new Date(), lastRunOk: false, lastRunMessage: `${llm.provider}: ${String(llm.error).slice(0, 400)}` },
    })
    await logAgentAction({
      action: 'BATCH_FAIL',
      status: 'error',
      summary: `batch window failed — ${llm.provider}: ${String(llm.error).slice(0, 300)} (${textJobs.length} text + ${categoryJobs.length} category jobs re-queued/parked)`,
      details: {
        provider: llm.provider,
        error: String(llm.error).slice(0, 500),
        textJobs: textJobs.length,
        categoryJobs: categoryJobs.length,
      },
      actor,
      provider: llm.provider,
      durationMs: Date.now() - startedAt,
    })
    stats.reason = 'llm-failed'
    stats.message = llm.error
    return stats
  }

  const parsed = extractJsonBlock(llm.content || '')
  const itemResults = new Map<string, Record<string, string>>()
  const categoryResults = new Map<string, { name?: string; nameAr?: string; nameFr?: string; icon?: string }>()
  if (parsed) {
    for (const raw of Array.isArray(parsed.items) ? parsed.items : []) {
      const it = raw as { id?: string; t?: Record<string, unknown> }
      if (!it?.id || typeof it.t !== 'object' || !it.t) continue
      const t: Record<string, string> = {}
      for (const lang of AGENT_LANGS) {
        const v = it.t[lang]
        if (typeof v === 'string' && v.trim()) t[lang] = v.trim()
      }
      itemResults.set(String(it.id), t)
    }
    for (const raw of Array.isArray(parsed.categories) ? parsed.categories : []) {
      const ct = raw as { id?: string; name?: unknown; nameAr?: unknown; nameFr?: unknown; icon?: unknown }
      if (!ct?.id) continue
      categoryResults.set(String(ct.id), {
        name: typeof ct.name === 'string' ? ct.name.trim().slice(0, 60) : undefined,
        nameAr: typeof ct.nameAr === 'string' ? ct.nameAr.trim().slice(0, 60) : undefined,
        nameFr: typeof ct.nameFr === 'string' ? ct.nameFr.trim().slice(0, 60) : undefined,
        icon: isValidEmojiIcon(ct.icon) ? ct.icon : undefined,
      })
    }
  }

  // ── Apply text results (sorted: items first, then rows, then jobs) ──
  const doneTextIds: string[] = []
  const failedTextIds: string[] = []
  /** Trail payload — every row the window actually wrote. */
  const appliedRefs: Array<Record<string, unknown>> = []
  for (const g of groups.values()) {
    const result = itemResults.get(g.item.id)
    if (!result) { failedTextIds.push(...g.jobs.map((j) => j.id)); continue }
    for (const job of g.jobs) {
      const targetLang = sanitizeLang(job.targetLang)
      const translated = result[targetLang]
      if (!translated) { failedTextIds.push(job.id); continue }
      await storeDictionaryEntry({
        sourceText: String(job.sourceText || ''),
        sourceLang: sanitizeLang(job.sourceLang),
        targetLang,
        targetText: translated,
        domain: job.domain || 'general',
        key: job.key,
      })
      stats.stored++
      if (await applyTranslation(job.refType as RefType, String(job.refId || ''), String(job.field || ''), translated)) {
        stats.applied++
        appliedRefs.push({
          refType: job.refType,
          refId: job.refId,
          field: job.field,
          targetLang,
          sourceText: String(job.sourceText || '').slice(0, 80),
        })
      }
      doneTextIds.push(job.id)
    }
  }
  if (doneTextIds.length) {
    await db.translationJob.updateMany({
      where: { id: { in: doneTextIds } },
      data: { status: 'done', processedAt: new Date(), error: null },
    })
  }
  if (failedTextIds.length) await failJobs(failedTextIds, 'agent returned no translation for this item')

  // ── Apply category results (trilingual name + icon → merge into the app) ──
  const doneCategoryIds: string[] = []
  const failedCategoryIds: string[] = []
  for (let index = 0; index < categoryJobs.length; index++) {
    const job = categoryJobs[index]
    const result = categoryResults.get(`c${index}`)
    let payload: { categoryRowId?: string; name?: string; sourceLang?: string } = {}
    try { payload = JSON.parse(String(job.payload || '{}')) } catch { /* malformed */ }
    if (!result || (!result.name && !result.nameAr && !result.nameFr)) {
      failedCategoryIds.push(job.id)
      continue
    }
    const row = await db.agencyCategory.findUnique({ where: { id: String(payload.categoryRowId || '') } })
    if (!row) {
      // Row deleted while queued — the job simply completes.
      doneCategoryIds.push(job.id)
      continue
    }
    // Base name = the ENGLISH canonical (built-in convention). Collision-safe.
    let finalName = row.name
    const en = result.name?.trim()
    if (en && en.toLowerCase() !== row.name.toLowerCase()) {
      const clash = await db.agencyCategory.findFirst({
        where: { name: { equals: en, mode: 'insensitive' }, NOT: { id: row.id } },
        select: { id: true },
      })
      if (!clash) finalName = en
    }
    const sourceLang = sanitizeLang(payload.sourceLang)
    await db.agencyCategory.update({
      where: { id: row.id },
      data: {
        name: finalName,
        // Source-language column keeps the owner's original wording.
        ...(sourceLang === 'ar' ? { nameAr: row.nameAr || payload.name || row.name } : result.nameAr ? { nameAr: result.nameAr } : {}),
        ...(sourceLang === 'fr' ? { nameFr: row.nameFr || payload.name || row.name } : result.nameFr ? { nameFr: result.nameFr } : {}),
        ...(sourceLang === 'en' && result.nameAr ? { nameAr: row.nameAr || result.nameAr } : {}),
        ...(sourceLang === 'en' && result.nameFr ? { nameFr: row.nameFr || result.nameFr } : {}),
        ...(result.icon ? { icon: result.icon } : {}),
      },
    })
    // Feed the dictionary so future categories with the same wording cost zero.
    if (payload.name) {
      for (const [lang, text] of [['ar', result.nameAr], ['fr', result.nameFr], ['en', result.name]] as const) {
        if (lang === sourceLang || !text) continue
        await storeDictionaryEntry({
          sourceText: String(payload.name), sourceLang, targetLang: lang as AgentLang,
          targetText: text, domain: 'category',
        })
        stats.stored++
      }
    }
    stats.applied++
    appliedRefs.push({
      refType: 'agency-category',
      refId: row.id,
      name: finalName,
      icon: result.icon || row.icon || null,
    })
    doneCategoryIds.push(job.id)
  }
  if (doneCategoryIds.length) {
    await db.translationJob.updateMany({
      where: { id: { in: doneCategoryIds } },
      data: { status: 'done', processedAt: new Date(), error: null, result: 'category enriched' },
    })
  }
  if (failedCategoryIds.length) await failJobs(failedCategoryIds, 'agent returned no usable category data')

  const message = `text ${doneTextIds.length}/${textJobs.length}, categories ${doneCategoryIds.length}/${categoryJobs.length}, applied ${stats.applied}, stored ${stats.stored}`
  await db.translationAgentConfig.update({
    where: { id: 'singleton' },
    data: { lastRunAt: new Date(), lastRunOk: true, lastRunMessage: message.slice(0, 400) },
  })
  await logAgentAction({
    action: 'BATCH_RUN',
    status: 'success',
    summary: `batch window done — ${message} via ${llm.provider}`,
    details: {
      textJobs: doneTextIds.length,
      textTotal: textJobs.length,
      categories: doneCategoryIds.length,
      categoryTotal: categoryJobs.length,
      applied: stats.applied,
      stored: stats.stored,
      refs: appliedRefs.slice(0, 50),
    },
    actor,
    provider: llm.provider,
    durationMs: Date.now() - startedAt,
  })
  stats.ran = true
  stats.textJobs = doneTextIds.length
  stats.categoryJobs = doneCategoryIds.length
  stats.provider = llm.provider
  stats.message = message
  return stats
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

let schedulerStarted = false
let runInFlight = false

/**
 * Starts the 60s due-check loop: when `intervalMinutes` elapsed since the
 * last run (default 5), ONE batch window executes. Overlap-proof.
 */
export function startTranslationAgentScheduler(): void {
  if (schedulerStarted) return
  schedulerStarted = true

  // 0.6.65 — one-time boot heal: re-stamp EVERY stored model id (keys with a
  // hand-typed/wrong/empty id and the config row) with the pinned flash id so
  // admin displays always match what the engine actually calls. Purely
  // cosmetic on top of the use-time pinning — the engine ignores stored ids.
  // NOTE: TranslationApiKey.model is nullable (null branch is valid there),
  // but TranslationAgentConfig.model is NOT — filtering a non-nullable column
  // with null makes Prisma reject the whole query ("Argument `model` is
  // missing"), so the config heal uses the not-clause only (0.6.64 bug).
  void (async () => {
    try {
      const [keys, cfg] = await Promise.all([
        db.translationApiKey.updateMany({
          where: { OR: [{ model: null }, { model: { not: DEFAULT_AGENT_MODEL } }] },
          data: { model: DEFAULT_AGENT_MODEL },
        }),
        db.translationAgentConfig.updateMany({
          where: { model: { not: DEFAULT_AGENT_MODEL } },
          data: { model: DEFAULT_AGENT_MODEL },
        }),
      ])
      if (keys.count || cfg.count) {
        console.log(`[translation-agent] model pinned to ${DEFAULT_AGENT_MODEL} — healed ${keys.count} key(s), ${cfg.count} config row(s)`)
      }
    } catch (error) {
      console.warn('[translation-agent] model heal failed:', (error as Error)?.message || error)
    }
  })()

  const tick = async (): Promise<void> => {
    if (runInFlight) return
    try {
      const config = await getAgentConfig()
      if (!config.enabled) return
      const intervalMs = Math.max(1, Math.min(120, config.intervalMinutes || 5)) * 60_000
      const last = config.lastRunAt ? config.lastRunAt.getTime() : 0
      if (Date.now() - last < intervalMs - 1500) return
      runInFlight = true
      try {
        const stats = await runTranslationBatch(false)
        if (stats.ran) console.log(`[translation-agent] window done — ${stats.message} (${stats.provider})`)
      } finally {
        runInFlight = false
      }
    } catch (error) {
      runInFlight = false
      console.warn('[translation-agent] scheduler tick failed:', (error as Error)?.message || error)
    }
  }

  // First window 45s after boot, then a due-check every 60s.
  setTimeout(() => { void tick() }, 45_000)
  setInterval(() => { void tick() }, 60_000)
  console.log('[translation-agent] scheduler started (batched windows, dictionary-first)')
}
