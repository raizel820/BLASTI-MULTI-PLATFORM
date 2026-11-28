/**
 * tv-voice.ts — BLASTI TV voice-calling client (0.6.121).
 * ─────────────────────────────────────────────────────────────────────────────
 * Client half of the DEDICATED OFFLINE VOICE-CALLING SERVICE (user mandate:
 * "to the tv screen add voice calling in all three languages — dedicated
 * service, free and open source tools, works offline locally").
 *
 * The server half lives in the desktop app (apps/desktop/local-api/lib/
 * voice-service.js): a tiny HTTP listener on the predetermined port :3084
 * (BLASTI_LAN_PORTS.VOICE_TTS) that synthesizes queue-call announcements
 * with the bundled eSpeak-NG WASM engine (GPL-3.0, free and open source)
 * in Arabic, French and English — fully offline, no cloud TTS, no API keys.
 *
 * This module:
 *   1. finds the voice service (direct :3084 on the LAN host that serves the
 *      TV page, or through the dev gateway with XTransformPort in the sandbox),
 *   2. fetches the announcement WAVs and plays them SEQUENTIALLY through the
 *      TV speakers (chime → language cycle),
 *   3. falls back to the browser's built-in speechSynthesis voice when the
 *      service cannot be reached (cloud-hosted previews, old desktop builds),
 *      so calling stays audible everywhere.
 *
 * Config comes from the device row's displaySettings.voiceCalling JSON —
 * edited by the agency owner in Device Manager → Edit TV → "Voice Calling".
 */

// ─── Types & defaults ───────────────────────────────────────────────────────

export type VoiceLang = 'ar' | 'fr' | 'en';
export type VoiceSpeed = 'slow' | 'normal' | 'fast';

export interface VoiceCallingConfig {
  /** Master switch (default true — device-surface gating happens in the hook). */
  enabled?: boolean;
  /** Announcement language cycle, in order (default ar → fr → en). */
  languages?: VoiceLang[];
  /** 0..1 playback volume (default 0.9). */
  volume?: number;
  /** Speech rate preset (default 'normal'). */
  speed?: VoiceSpeed;
  /** Short chime before the announcement (default true). */
  chime?: boolean;
  /** How many times the whole language cycle repeats (1..3, default 1). */
  cycles?: number;
}

export const VOICE_LANGUAGES: VoiceLang[] = ['ar', 'fr', 'en'];
const DEFAULT_VOLUME = 0.9;

function clampVolume(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_VOLUME;
  return Math.min(1, Math.max(0, n));
}

/** Parse + normalize the voice-calling config from any displaySettings blob. */
export function parseVoiceCalling(ds: unknown): Required<VoiceCallingConfig> {
  let raw: Record<string, unknown> = {};
  if (ds && typeof ds === 'object' && !Array.isArray(ds)) {
    const vc = (ds as Record<string, unknown>).voiceCalling;
    if (vc && typeof vc === 'object' && !Array.isArray(vc)) raw = vc as Record<string, unknown>;
  }
  const langsRaw = Array.isArray(raw.languages)
    ? (raw.languages as unknown[]).filter((l): l is VoiceLang => l === 'ar' || l === 'fr' || l === 'en')
    : [];
  const cyclesRaw = Number(raw.cycles);
  const speedRaw = raw.speed;
  return {
    enabled: raw.enabled !== false,
    languages: langsRaw.length > 0 ? langsRaw : [...VOICE_LANGUAGES],
    volume: clampVolume(raw.volume),
    speed: speedRaw === 'slow' || speedRaw === 'fast' ? speedRaw : 'normal',
    chime: raw.chime !== false,
    cycles: Number.isFinite(cyclesRaw) ? Math.min(3, Math.max(1, Math.round(cyclesRaw))) : 1,
  };
}

// ─── Announcement text (speech grammar — one template per language) ─────────
// Counter numbers are extracted from counterName ("Guichet 3" → 3) so each
// language speaks its OWN word for counter, never a mixed-language phrase.

const WITH_COUNTER: Record<VoiceLang, string> = {
  ar: 'تذكرة رقم {t}، الشباك {c}',
  fr: 'Ticket numéro {t}, guichet {c}',
  en: 'Ticket number {t}, counter {c}',
};

const WITHOUT_COUNTER: Record<VoiceLang, string> = {
  ar: 'تذكرة رقم {t}، من فضلك توجه إلى الشباك',
  fr: 'Ticket numéro {t}, veuillez vous présenter au guichet',
  en: 'Ticket number {t}, please go to the counter',
};

/** "A-12" → "A 12" (espeak reads letter + cardinal number, not "A-twelve-code"). */
function ticketSpeech(ticketNumber: string): string {
  const clean = String(ticketNumber || '').trim().toUpperCase();
  if (!clean) return '';
  return clean
    .replace(/[^A-Z0-9]/g, ' ')
    .replace(/([A-Z]+)(\d)/g, '$1 $2')
    .replace(/(\d)([A-Z]+)/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

/** First digit group of a counter label ("Guichet 3" → "3"), else ''. */
function counterSpeech(counterName: string | null | undefined): string {
  const m = String(counterName || '').match(/\d+/);
  return m ? m[0] : '';
}

export interface AnnouncementLine {
  lang: VoiceLang;
  text: string;
}

/** Build the announcement lines for one called ticket, in the configured cycle. */
export function buildAnnouncementLines(
  entry: { ticketNumber: string; counterName?: string | null },
  languages: VoiceLang[],
): AnnouncementLine[] {
  const ticket = ticketSpeech(entry && entry.ticketNumber);
  if (!ticket) return [];
  const counter = counterSpeech(entry && entry.counterName);
  return (languages.length ? languages : [...VOICE_LANGUAGES]).map((lang) => ({
    lang,
    text: counter
      ? WITH_COUNTER[lang].replace('{t}', ticket).replace('{c}', counter)
      : WITHOUT_COUNTER[lang].replace('{t}', ticket),
  }));
}

// ─── Voice-service endpoint discovery ───────────────────────────────────────

interface VoiceEndpoint {
  /** Base origin ('' = same origin, gateway-forwarded). */
  base: string;
  /** Extra query suffix (XTransformPort in the sandbox gateway). */
  suffix: string;
  label: string;
}

function isLanHost(host: string): boolean {
  return host === 'localhost'
    || host === '127.0.0.1'
    || /^10\./.test(host)
    || /^192\.168\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    || (!host.includes('.') && host.length > 0);
}

/**
 * Endpoints to probe, in order:
 *   1. direct :3084 on the host that serves this page (the production TV
 *      case — the board is loaded from the desktop's LAN origin) — only for
 *      loopback/private hosts (never probe a public cloud domain),
 *   2. same-origin gateway forward (sandbox/dev preview → XTransformPort).
 */
function candidateEndpoints(): VoiceEndpoint[] {
  if (typeof window === 'undefined') return [];
  const out: VoiceEndpoint[] = [];
  try {
    const host = window.location.hostname;
    if (isLanHost(host)) {
      out.push({ base: `${window.location.protocol}//${host}:3084`, suffix: '', label: 'lan-direct' });
    }
  } catch { /* sandboxed */ }
  out.push({ base: '', suffix: 'XTransformPort=3084', label: 'gateway' });
  return out;
}

/**
 * Auth headers for /speak calls (SECURITY 0.6.126 audit T1-8): the desktop
 * voice service now token-gates non-loopback callers. Device surfaces (TV
 * boards / kiosks) hold a device token in localStorage — attach it so the
 * LAN endpoint accepts the request. A tokenless caller degrades to the
 * browser-voice fallback (the probe/health endpoint stays open).
 */
function speakAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'audio/wav, application/json' };
  try {
    const deviceToken =
      localStorage.getItem('blasti_kiosk_device_token') ||
      localStorage.getItem('blasti_tv_device_token') ||
      '';
    if (deviceToken) headers['X-Device-Token'] = deviceToken;
  } catch { /* storage unavailable */ }
  try {
    const raw = localStorage.getItem('blasti-app') || '';
    const parsed = raw ? JSON.parse(raw) : null;
    const sessionToken = parsed?.state?.sessionToken || parsed?.sessionToken || '';
    if (sessionToken) headers['Authorization'] = `Bearer ${sessionToken}`;
  } catch { /* storage unavailable */ }
  return headers;
}

let resolvedEndpoint: (VoiceEndpoint & { at: number }) | null = null;
let failedUntil = 0;

async function probeEndpoint(ep: VoiceEndpoint, timeoutMs = 1600): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const url = `${ep.base}/health${ep.suffix ? `?${ep.suffix}` : ''}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: ctl.signal });
    if (!res.ok) return false;
    const data = (await res.json().catch(() => null)) as { service?: string } | null;
    return data?.service === 'blasti-voice';
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve the live voice-service endpoint (cached 5 min on success, 20 s
 * back-off on failure so idle boards do not hammer the network). Returns
 * null when no service answers — callers fall back to browser TTS.
 * Each candidate is probed twice: the first attempt can transiently abort
 * while the board's boot storm (hydration + prefetch) saturates the tab.
 */
export async function resolveVoiceServiceBase(): Promise<VoiceEndpoint | null> {
  if (typeof window === 'undefined') return null;
  if (resolvedEndpoint && Date.now() - resolvedEndpoint.at < 5 * 60_000) return resolvedEndpoint;
  if (Date.now() < failedUntil) return null;
  for (const ep of candidateEndpoints()) {
    let ok = await probeEndpoint(ep);
    if (!ok) {
      await new Promise((r) => setTimeout(r, 350));
      ok = await probeEndpoint(ep);
    }
    if (ok) {
      resolvedEndpoint = { ...ep, at: Date.now() };
      console.info(`[TVVoice] voice service found via ${ep.label}`);
      return resolvedEndpoint;
    }
  }
  failedUntil = Date.now() + 20_000;
  return null;
}

/** Drop the cached probe result (e.g. after a failed playback — retry soon). */
export function invalidateVoiceServiceProbe(): void {
  resolvedEndpoint = null;
  failedUntil = 0;
}

// ─── Audio plumbing ─────────────────────────────────────────────────────────

let audioUnlocked = false;
let announcementSeq = 0;
let currentAudioStop: (() => void) | null = null;

// PERSISTENT WebAudio context — the kiosk autoplay key. An AudioContext that
// was resumed during one user gesture stays unlocked FOREVER, so every later
// announcement (hours after the first remote key press) plays without a new
// gesture. HTMLAudio.play() cannot do that — its activation expires ~5s.
let voiceCtx: AudioContext | null = null;

function getVoiceContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (voiceCtx) return voiceCtx;
  try {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    voiceCtx = new Ctor();
    return voiceCtx;
  } catch {
    return null;
  }
}

/**
 * TV browsers gate audio behind a user gesture. Call once at board boot —
 * the first interaction (remote key / touch) resumes the PERSISTENT audio
 * context so every later queue call can announce without one.
 */
export function warmUpVoiceAudio(): void {
  if (typeof window === 'undefined' || audioUnlocked) return;
  const unlock = () => {
    if (audioUnlocked) return;
    audioUnlocked = true;
    try {
      const ctx = getVoiceContext();
      if (!ctx) return;
      void ctx.resume().catch(() => undefined);
      const buf = ctx.createBuffer(1, 512, ctx.sampleRate);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start();
    } catch { /* best-effort */ }
  };
  window.addEventListener('pointerdown', unlock, { once: true, passive: true });
  window.addEventListener('keydown', unlock, { once: true, passive: true });
  window.addEventListener('touchstart', unlock, { once: true, passive: true });
}

/** Short two-tone chime via the persistent WebAudio context (free, offline). */
function playVoiceChime(volume: number): void {
  try {
    const ctx = getVoiceContext();
    if (!ctx || ctx.state === 'closed') return;
    void ctx.resume().catch(() => undefined);
    const now = ctx.currentTime;
    const tone = (freq: number, at: number, dur: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + at);
      gain.gain.setValueAtTime(0.28 * volume, now + at);
      gain.gain.exponentialRampToValueAtTime(0.01, now + at + dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + at);
      osc.stop(now + at + dur);
    };
    tone(880, 0, 0.22);   // A5
    tone(1174.7, 0.22, 0.3); // D6
  } catch { /* chime is optional */ }
}

/**
 * Play WAV bytes through the PERSISTENT WebAudio context (gesture-free once
 * unlocked), falling back to an HTMLAudio element on old TV browsers.
 * Resolves false when playback was blocked.
 */
async function playWavBytes(bytes: ArrayBuffer, volume: number): Promise<boolean> {
  // Preferred path: persistent WebAudio (no per-play activation needed).
  const ctx = getVoiceContext();
  if (ctx && ctx.state !== 'closed' && typeof ctx.decodeAudioData === 'function') {
    try {
      void ctx.resume().catch(() => undefined);
      const audioBuf = await ctx.decodeAudioData(bytes.slice(0));
      return await new Promise<boolean>((resolve) => {
        try {
          const src = ctx.createBufferSource();
          src.buffer = audioBuf;
          const gain = ctx.createGain();
          gain.gain.value = volume;
          src.connect(gain);
          gain.connect(ctx.destination);
          currentAudioStop = () => { try { src.stop(); } catch { /* ignore */ } };
          let settled = false;
          const done = (ok: boolean) => {
            if (settled) return;
            settled = true;
            currentAudioStop = null;
            try { src.stop(); } catch { /* ignore */ }
            resolve(ok);
          };
          src.onended = () => done(true);
          src.start();
          // Safety net — never hang the announcement chain.
          setTimeout(() => done(true), Math.min(30000, (audioBuf.duration + 5) * 1000));
        } catch {
          resolve(false);
        }
      });
    } catch {
      /* decode failed — fall through to the HTMLAudio path */
    }
  }
  // Fallback: HTMLAudio element (older TV browsers).
  return new Promise((resolve) => {
    let url = '';
    try {
      url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
      const audio = new Audio(url);
      audio.volume = volume;
      currentAudioStop = () => { try { audio.pause(); } catch { /* ignore */ } };
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        currentAudioStop = null;
        try { audio.pause(); } catch { /* ignore */ }
        try { URL.revokeObjectURL(url); } catch { /* ignore */ }
        resolve(ok);
      };
      audio.onended = () => done(true);
      audio.onerror = () => done(false);
      const p = audio.play();
      if (p && typeof p.catch === 'function') p.catch(() => done(false));
      // Safety net — never hang the announcement chain.
      setTimeout(() => done(true), 20000);
    } catch {
      if (url) { try { URL.revokeObjectURL(url); } catch { /* ignore */ } }
      resolve(false);
    }
  });
}

/** Browser speechSynthesis fallback (no dedicated service reachable). */
function speakWithBrowserTts(text: string, lang: VoiceLang, volume: number, speed: VoiceSpeed): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const synth = window.speechSynthesis;
      if (!synth) return resolve(false);
      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = lang === 'ar' ? 'ar-SA' : lang === 'fr' ? 'fr-FR' : 'en-US';
      utter.volume = volume;
      utter.rate = speed === 'slow' ? 0.85 : speed === 'fast' ? 1.15 : 1;
      utter.onend = () => resolve(true);
      utter.onerror = () => resolve(false);
      synth.speak(utter);
      setTimeout(() => resolve(true), 15000);
    } catch {
      resolve(false);
    }
  });
}

// ─── Announcement playback ──────────────────────────────────────────────────

/** Cancel any announcement in progress (component unmount / supersede). */
export function stopAnnouncement(): void {
  announcementSeq += 1;
  try { currentAudioStop?.(); } catch { /* ignore */ }
}

async function speakLine(line: AnnouncementLine, config: Required<VoiceCallingConfig>, service: VoiceEndpoint | null): Promise<void> {
  if (service) {
    try {
      const qs = new URLSearchParams({ text: line.text, lang: line.lang, speed: config.speed });
      const url = `${service.base}/speak?${qs.toString()}${service.suffix ? `&${service.suffix}` : ''}`;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 8000);
      const res = await fetch(url, { headers: speakAuthHeaders(), signal: ctl.signal });
      clearTimeout(timer);
      if (res.ok) {
        const bytes = await res.arrayBuffer();
        // Playback may be blocked by autoplay policy (no user gesture yet) —
        // that is NOT a service failure: the endpoint stays cached, the
        // browser-voice fallback covers this line, and the next announcement
        // (after the first remote key unlocks audio) speaks normally.
        const played = await playWavBytes(bytes, config.volume);
        if (played) return;
      } else {
        invalidateVoiceServiceProbe();
      }
    } catch {
      invalidateVoiceServiceProbe();
    }
  }
  await speakWithBrowserTts(line.text, line.lang, config.volume, config.speed);
}

/**
 * Play one announcement (chime + language cycle). Supersedes any announcement
 * still in progress (a new queue call wins over a half-finished older one).
 * Resolves true when every line reached playback.
 */
export async function playAnnouncement(lines: AnnouncementLine[], config: Required<VoiceCallingConfig>): Promise<boolean> {
  if (!lines.length) return false;
  const myToken = ++announcementSeq;
  const service = await resolveVoiceServiceBase();
  if (myToken !== announcementSeq) return false;
  if (config.chime) {
    playVoiceChime(config.volume);
    await new Promise((r) => setTimeout(r, 450));
    if (myToken !== announcementSeq) return false;
  }
  for (let cycle = 0; cycle < config.cycles; cycle++) {
    for (const line of lines) {
      if (myToken !== announcementSeq) return false;
      await speakLine(line, config, service);
    }
  }
  return true;
}

/**
 * Play a sample announcement (Device Manager "Test" button). Uses ONLY the
 * dedicated service so the owner hears the real offline voice; returns false
 * when the service is unreachable (the UI then explains why).
 */
export async function playTestAnnouncement(config: Required<VoiceCallingConfig>): Promise<boolean> {
  const service = await resolveVoiceServiceBase();
  if (!service) return false;
  const lines = buildAnnouncementLines({ ticketNumber: 'A-12', counterName: '3' }, config.languages);
  if (!lines.length) return false;
  if (config.chime) {
    playVoiceChime(config.volume);
    await new Promise((r) => setTimeout(r, 450));
  }
  for (const line of lines) {
    const qs = new URLSearchParams({ text: line.text, lang: line.lang, speed: config.speed });
    const url = `${service.base}/speak?${qs.toString()}${service.suffix ? `&${service.suffix}` : ''}`;
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 8000);
      const res = await fetch(url, { headers: speakAuthHeaders(), signal: ctl.signal });
      clearTimeout(timer);
      if (!res.ok) return false;
      const bytes = await res.arrayBuffer();
      const played = await playWavBytes(bytes, config.volume);
      if (!played) return false;
    } catch {
      return false;
    }
  }
  return true;
}
