// voice-service.js — BLASTI DEDICATED OFFLINE VOICE-CALLING SERVICE (0.6.121).
//
// User mandate: "to the tv screen add voice calling in all three languages —
// this should be dedicated service using free and open source tools and works
// offline locally". This module IS that dedicated service:
//
//   • A tiny HTTP listener on the predetermined port :3084
//     (BLASTI_LAN_PORTS.VOICE_TTS — lib/lan-ports.js) whose ONLY job is to
//     turn queue-call announcement text into WAV speech audio. Nothing else
//     lives on the port.
//   • Engine: eSpeak-NG compiled to WebAssembly (npm `espeak-ng`, GPL-3.0,
//     the official espeak-ng synthesizer) — bundled INSIDE the desktop app,
//     so the announcement works with ZERO internet, ZERO cloud calls and
//     ZERO external installs on Windows / macOS / Linux master PCs. When a
//     system `espeak-ng` binary exists it is preferred for its newer voice
//     data (Linux kiosks often have it), otherwise the bundled WASM speaks.
//   • Languages: Arabic (ar), French (fr), English (en-us) — the app's three
//     UI languages. Every announcement the TV asks for is synthesized here.
//   • Consumers: the TV boards (apps/web/src/lib/tv-voice.ts) fetch
//     `GET /speak?text=…&lang=…&speed=…` from the SAME LAN host that serves
//     them (:3080) and play the returned WAV through the TV speakers. The
//     service answers with permissive CORS because the TV page origin is the
//     :3080 API, not this port.
//   • Robustness: synthesis requests are serialized (the WASM engine is
//     single-threaded CPU work), finished audio is LRU-cached (queue calls
//     repeat), per-IP rate limited, and a failed bind degrades gracefully —
//     the TV falls back to the browser's speechSynthesis voice if available.
//
// Standalone mode: `node voice-service.js` (or `bun voice-service.js`) runs
// the service without Electron — handy for headless branch servers and for
// field diagnostics. Port override: BLASTI_VOICE_PORT env.

'use strict'

const { BLASTI_LAN_PORTS } = require('./lan-ports')

// ─── Voice map: BLASTI UI language → espeak-ng voice code ───────────────────

const VOICE_LANGS = {
  ar: 'ar',     // Arabic
  fr: 'fr',     // French
  en: 'en-us',  // English (American — clearest at low bitrates)
}

const SPEED_MAP = { slow: 130, normal: 150, fast: 175 } // words/min
const DEFAULT_SPEED = 'normal'
const MAX_TEXT_LEN = 300

// ─── Engine resolution (bundled WASM first, CLI fallback) ───────────────────

let engineKind = null // 'wasm' | 'cli' | 'failed'
let espeakFactory = null // the WASM module factory (resolved once)

/**
 * Resolve the espeak-ng engine ONCE:
 *   1. the bundled WASM build (works everywhere, no external installs), then
 *   2. a system espeak-ng CLI binary (preferred when present — newer voice
 *      data, native speed) — Linux master PCs usually have it.
 * Returns 'wasm' | 'cli' | 'failed'. Never throws.
 */
async function resolveEngine() {
  if (engineKind) return engineKind
  try {
    const mod = await import('espeak-ng')
    espeakFactory = mod.default || mod
    // Sanity: run one tiny synthesis so a broken install fails HERE, not on
    // the first real announcement.
    const m = await espeakFactory({
      arguments: ['-v', 'en', '-w', 'engine-check.wav', 'ok'],
    })
    m.FS.readFile('engine-check.wav')
    engineKind = 'wasm'
    return engineKind
  } catch (wasmErr) {
    try {
      const { spawnSync } = require('child_process')
      const probe = spawnSync('espeak-ng', ['--version'], { timeout: 4000 })
      if (probe.status === 0) {
        engineKind = 'cli'
        return engineKind
      }
    } catch { /* no CLI either */ }
    console.warn('[VOICE] espeak-ng unavailable (wasm + cli):', wasmErr && wasmErr.message)
    engineKind = 'failed'
    return engineKind
  }
}

// ─── Synthesis pipeline (serialized + LRU cached) ───────────────────────────

const audioCache = new Map() // cacheKey → Buffer (WAV bytes)
const CACHE_MAX = 60

function cacheKey({ text, lang, speed }) {
  return `${lang}|${speed}|${text}`
}

function cachePut(key, buf) {
  if (audioCache.has(key)) audioCache.delete(key)
  audioCache.set(key, buf)
  while (audioCache.size > CACHE_MAX) {
    const oldest = audioCache.keys().next().value
    if (oldest === undefined) break
    audioCache.delete(oldest)
  }
}

/** One synthesis NOW (blocking CPU work) — callers serialize via the chain. */
async function synthesizeNow({ text, lang, speed }) {
  const kind = await resolveEngine()
  if (kind === 'failed') throw new Error('espeak-ng engine unavailable')
  const voice = VOICE_LANGS[lang] || VOICE_LANGS.en
  const rate = SPEED_MAP[speed] || SPEED_MAP.normal

  if (kind === 'cli') {
    const { spawnSync } = require('child_process')
    const { tmp } = require('os')
    const { join } = require('path')
    const { readFileSync, unlinkSync } = require('fs')
    const outPath = join(tmp(), `blasti-voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`)
    const res = spawnSync('espeak-ng', [
      '-v', voice, '-s', String(rate), '-a', '200', '-w', outPath, text,
    ], { timeout: 8000 })
    if (res.status !== 0) throw new Error(`espeak-ng CLI failed (${res.status})`)
    try {
      return readFileSync(outPath)
    } finally {
      try { unlinkSync(outPath) } catch { /* best-effort */ }
    }
  }

  // Bundled WASM engine — a fresh module per synthesis (the CLI image runs
  // once per instantiation; ~100ms cold, warm OS-cache makes it faster).
  const mod = await espeakFactory({
    arguments: ['-v', voice, '-s', String(rate), '-a', '200', '-w', 'blasti-voice.wav', text],
  })
  const bytes = mod.FS.readFile('blasti-voice.wav')
  return Buffer.from(bytes)
}

// Serial chain — WASM synthesis is sync CPU work inside async JS; two
// concurrent requests would both hold 18MB wasm instances. One at a time,
// everything else waits (announcements are short and cached anyway).
let synthChain = Promise.resolve()

/**
 * Full synthesis path: sanitize → cache lookup → serialize → synthesize.
 * Always resolves (throws only on engine failure after the chain drain).
 */
function synthesizeWav(spec) {
  const key = cacheKey(spec)
  const hit = audioCache.get(key)
  if (hit) {
    // LRU refresh
    audioCache.delete(key)
    audioCache.set(key, hit)
    return Promise.resolve(hit)
  }
  synthChain = synthChain
    .then(() => synthesizeNow(spec))
    .then((buf) => { cachePut(key, buf); return buf })
  return synthChain
}

/** Sanitize announcement text: trim, cap, no leading dash (argv safety). */
function sanitizeText(raw) {
  let text = String(raw == null ? '' : raw).trim().slice(0, MAX_TEXT_LEN)
  while (text.startsWith('-')) text = text.slice(1).trim()
  return text
}

// ─── Dedicated HTTP listener on :3084 ───────────────────────────────────────

/**
 * Start the dedicated voice service (its own tiny HTTP server on
 * BLASTI_LAN_PORTS.VOICE_TTS — :3084). Like the print-relay listener, a
 * failed bind degrades gracefully (returns null) — the TV falls back to the
 * browser speechSynthesis voice and queue calling stays audible.
 * Returns { port, stop } or null.
 */
function startVoiceService(opts) {
  const log = opts && typeof opts.log === 'function'
    ? opts.log
    : (m) => console.log('[VOICE] ' + m)
  const port = (opts && Number(opts.port) > 0) ? Number(opts.port) : BLASTI_LAN_PORTS.VOICE_TTS

  const Hono = require('hono').Hono
  const { serve } = require('@hono/node-server')
  const app = new Hono()

  // CORS — the TV page is served from :3080 (or a LAN host); THIS service is
  // a different origin (:3084). Old smart-TV browsers do not always send
  // preflights, so every response carries the headers and OPTIONS is an
  // explicit 204.
  app.use('*', async (c, next) => {
    await next()
    c.header('Access-Control-Allow-Origin', '*')
    c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    c.header('Access-Control-Allow-Headers', 'Content-Type')
    c.header('Access-Control-Max-Age', '86400')
  })
  app.options('*', (c) => c.body(null, 204))

  // Per-IP limiter (mirrors the print-relay convention).
  const hits = new Map()
  const LIMIT = 40
  const WINDOW_MS = 60_000

  function limited(c) {
    const ip = (c.req.header('x-forwarded-for') || '').split(',')[0].trim()
      || c.req.header('x-real-ip') || 'lan'
    const now = Date.now()
    const entry = hits.get(ip) || { count: 0, windowStart: now }
    if (now - entry.windowStart > WINDOW_MS) { entry.count = 0; entry.windowStart = now }
    entry.count += 1
    hits.set(ip, entry)
    return entry.count > LIMIT
  }

  function parseSpec(obj) {
    const text = sanitizeText(obj && (obj.text ?? obj.t))
    const langRaw = String((obj && obj.lang) || 'en').toLowerCase()
    const lang = VOICE_LANGS[langRaw] ? langRaw : 'en'
    const speedRaw = String((obj && obj.speed) || DEFAULT_SPEED).toLowerCase()
    const speed = SPEED_MAP[speedRaw] ? speedRaw : DEFAULT_SPEED
    return { text, lang, speed }
  }

  async function handleSpeak(c, spec) {
    if (!spec.text) {
      return c.json({ success: false, error: 'text query param required' }, 400)
    }
    if (limited(c)) {
      return c.json({ success: false, error: 'Too many requests — slow down' }, 429)
    }
    try {
      const buf = await Promise.race([
        synthesizeWav(spec),
        new Promise((_, rej) => setTimeout(() => rej(new Error('synthesis timed out')), 9000)),
      ])
      return c.body(buf, 200, {
        'Content-Type': 'audio/wav',
        'Content-Length': String(buf.length),
        'Cache-Control': 'max-age=600', // identical params → identical audio
        'X-Blasti-Voice-Engine': engineKind || 'unknown',
      })
    } catch (err) {
      log(`speak failed (${spec.lang}): ${err && err.message}`)
      return c.json({ success: false, error: 'Synthesis failed' }, 503)
    }
  }

  // The one route the TV needs.
  app.get('/speak', (c) => {
    const spec = parseSpec({
      text: c.req.query('text'),
      lang: c.req.query('lang'),
      speed: c.req.query('speed'),
    })
    return handleSpeak(c, spec)
  })

  // JSON variant (long texts / programmatic callers).
  app.post('/speak', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    return handleSpeak(c, parseSpec(body))
  })

  // Diagnostics — the TV probes this to decide service vs speechSynthesis.
  app.get('/health', (c) => c.json({
    success: true,
    service: 'blasti-voice',
    version: 1,
    port,
    engine: engineKind || 'pending',
    voices: Object.keys(VOICE_LANGS),
    speeds: Object.keys(SPEED_MAP),
    cacheEntries: audioCache.size,
    uptimeSec: Math.floor(process.uptime()),
  }))

  let server = null
  try {
    server = serve({ fetch: app.fetch, port }, () => {
      log(`dedicated voice service running on http://0.0.0.0:${port} (offline TTS: ar/fr/en)`)
      resolveEngine().then((kind) => log(`voice engine ready: ${kind}`)).catch(() => undefined)
    })
    server.on('error', (err) => {
      log(`listener error: ${err && err.message}`)
    })
  } catch (err) {
    console.warn('[VOICE] failed to bind:', err && err.message)
    return null
  }

  return {
    port,
    stop: () => {
      try { server.close(() => undefined) } catch { /* already closed */ }
    },
  }
}

// ─── Standalone runner ──────────────────────────────────────────────────────
// `node voice-service.js` — run the service without Electron (headless branch
// servers, diagnostics). The desktop app embeds the same module.

if (require.main === module) {
  const port = Number(process.env.BLASTI_VOICE_PORT) > 0
    ? Number(process.env.BLASTI_VOICE_PORT)
    : BLASTI_LAN_PORTS.VOICE_TTS
  const listener = startVoiceService({
    port,
    log: (m) => console.log('[VOICE] ' + m),
  })
  if (!listener) {
    console.error('[VOICE] could not bind port ' + port)
    process.exitCode = 1
  } else {
    const stop = () => { listener.stop(); process.exit(0) }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  }
}

module.exports = {
  startVoiceService,
  synthesizeWav,
  resolveEngine,
  VOICE_LANGS,
  SPEED_MAP,
}
