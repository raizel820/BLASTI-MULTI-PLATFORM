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
 * PROVIDERS: an active 'openai-compatible' TranslationApiKey (custom
 * baseUrl + key, e.g. the z.ai open platform serving glm-4.6-flash) wins;
 * otherwise the bundled z-ai-web-dev-sdk (free GLM flash) is used.
 */

import { createHash } from 'node:crypto'
import { db } from '@blasti/db'

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

  return total
}

/**
 * Category Language page — enqueue the category NAME + every term override
 * still missing translations. Source language per string: explicit columns
 * carry their own language; the base `name` is detected heuristically.
 */
export async function enqueueCategoryTranslations(categoryId: string): Promise<EnqueueSummary> {
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

async function callTranslationLLM(
  userPrompt: string,
  config: Awaited<ReturnType<typeof getAgentConfig>>,
): Promise<LLMCallResult> {
  const customKey = await db.translationApiKey.findFirst({
    where: { isActive: true, provider: 'openai-compatible' },
    orderBy: { updatedAt: 'desc' },
  })

  if (customKey?.baseUrl && customKey.apiKey) {
    try {
      const base = customKey.baseUrl.replace(/\/+$/, '')
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${customKey.apiKey}` },
        body: JSON.stringify({
          model: customKey.model || config.model || 'glm-4.6-flash',
          temperature: 0.2,
          stream: false,
          messages: [
            { role: 'system', content: AGENT_SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
          ],
        }),
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        return { ok: false, error: `HTTP ${res.status} — ${body.slice(0, 200)}`, provider: `key:${customKey.label}` }
      }
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
      const content = data?.choices?.[0]?.message?.content
      if (!content) return { ok: false, error: 'empty response', provider: `key:${customKey.label}` }
      return { ok: true, content, provider: `key:${customKey.label}` }
    } catch (error) {
      return { ok: false, error: (error as Error)?.message || 'request failed', provider: `key:${customKey.label}` }
    }
  }

  // Bundled SDK — the free GLM flash path.
  try {
    const { default: ZAI } = await import('z-ai-web-dev-sdk')
    const zai = await ZAI.create()
    const completion = await zai.chat.completions.create({
      messages: [
        { role: 'assistant', content: AGENT_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      thinking: { type: 'disabled' },
    })
    const content = completion.choices[0]?.message?.content
    if (!content) return { ok: false, error: 'empty response', provider: 'zai-sdk' }
    return { ok: true, content, provider: 'zai-sdk' }
  } catch (error) {
    return { ok: false, error: (error as Error)?.message || 'SDK failed', provider: 'zai-sdk' }
  }
}

/** Test one stored API key with a tiny real translation round-trip. */
export async function testTranslationApiKey(keyId: string): Promise<{ ok: boolean; message: string; sample?: string }> {
  const key = await db.translationApiKey.findUnique({ where: { id: keyId } })
  if (!key) return { ok: false, message: 'key not found' }

  let ok = false
  let message = ''
  let sample: string | undefined

  try {
    if (key.provider === 'openai-compatible') {
      if (!key.baseUrl || !key.apiKey) throw new Error('baseUrl and apiKey are required')
      const base = key.baseUrl.replace(/\/+$/, '')
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key.apiKey}` },
        body: JSON.stringify({
          model: key.model || 'glm-4.6-flash',
          temperature: 0,
          stream: false,
          messages: [
            { role: 'system', content: 'You are a translator. Reply with the translation only.' },
            { role: 'user', content: 'Translate to French: "Welcome to Blasti"' },
          ],
        }),
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
      sample = data?.choices?.[0]?.message?.content?.trim()
      if (!sample) throw new Error('empty response')
      ok = true
      message = `OK — model ${key.model || 'glm-4.6-flash'} replied`
    } else {
      // 'zai' — the bundled SDK path (no key material involved).
      const { default: ZAI } = await import('z-ai-web-dev-sdk')
      const zai = await ZAI.create()
      const completion = await zai.chat.completions.create({
        messages: [
          { role: 'assistant', content: 'You are a translator. Reply with the translation only.' },
          { role: 'user', content: 'Translate to French: "Welcome to Blasti"' },
        ],
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
export async function runTranslationBatch(force = false): Promise<BatchRunStats> {
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
    config,
  )

  if (!llm.ok) {
    await failJobs(allIds, `${llm.provider}: ${llm.error}`)
    await db.translationAgentConfig.update({
      where: { id: 'singleton' },
      data: { lastRunAt: new Date(), lastRunOk: false, lastRunMessage: `${llm.provider}: ${String(llm.error).slice(0, 400)}` },
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
