'use client';

/**
 * UploadImageRecovery — global <img> error retry for uploaded files.
 *
 * WHY THIS EXISTS (the "avatars/logos are placeholders on phone + desktop"
 * bug): an <img> whose src fails NEVER retries by itself, and on native
 * shells the first render can easily get a not-yet-good URL:
 *
 *   • Capacitor — the page renders while the native cloud resolver is still
 *     probing; getProxiedUrl falls back to the baked env base, which can be
 *     dead on a physical phone (emulator alias, stale LAN IP). Once the
 *     resolver ADOPTS a proven base the already-rendered <img> elements keep
 *     their broken src forever → initials placeholder everywhere.
 *   • Packaged Electron — upload URLs are rebased onto the local API origin
 *     (:3080); when the local file store misses AND its cloud proxy is
 *     unreachable the img 404s with no second chance, even though the cloud
 *     base the shell logged in through is fine.
 *   • Old rows — historical ABSOLUTE urls (http://localhost:3003/…) stored
 *     before the relative-URL migration.
 *
 * FIX: mounted once in the root layout, this component listens (capture
 * phase — img error events do not bubble) for <img> load errors whose src is
 * an /api/upload/file/* URL and retries the SAME server path against the
 * other proven bases (desktop shell cloud base → native resolver base →
 * cloud env → page-host :3003 → gateway same-origin + XTransformPort), each
 * candidate once per path. When the native resolver adopts a base it also
 * re-tries every img that failed earlier with a better URL. Zero UI, never
 * throws, data:/blob: pass through untouched.
 */

import { useEffect } from 'react';
import { getNativeCloudUrl, getNativeCloudUrlStatus, onNativeCloudStateChange } from '@/lib/native-cloud-resolver';
import { getCloudApiBaseUrl } from '@/lib/api-client';

const UPLOAD_PATH_MARKER = '/api/upload/file/';
/** Max candidates tried per server path — bounds pathological loops. */
const MAX_ATTEMPTS_PER_PATH = 4;
/** Max tracked paths — the map resets when exceeded (fail-safe, not a leak). */
const MAX_TRACKED_PATHS = 300;

/** path → Set of srcs already tried for it. */
const attempted = new Map<string, Set<string>>();

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/** Candidate bases (most-proven first) for the CURRENT shell. */
function candidateBases(): string[] {
  const bases: string[] = [];
  if (typeof window === 'undefined') return bases;

  // Desktop shell — the exact cloud base the main process resolved for login.
  const electronBase = (window as unknown as { electronAPI?: { cloudBaseUrl?: string } })
    .electronAPI?.cloudBaseUrl?.trim();
  if (electronBase) bases.push(electronBase.replace(/\/+$/, ''));

  // Capacitor — the base the resolver actually ADOPTED (never its dead fallback).
  const resolverStatus = getNativeCloudUrlStatus();
  if (!resolverStatus || resolverStatus.status !== 'failed') {
    const nativeBase = getNativeCloudUrl();
    if (nativeBase) bases.push(nativeBase.replace(/\/+$/, ''));
  }

  const cloudBase = getCloudApiBaseUrl();
  if (cloudBase) bases.push(cloudBase.replace(/\/+$/, ''));

  if (process.env.NEXT_PUBLIC_API_URL) bases.push(process.env.NEXT_PUBLIC_API_URL.replace(/\/+$/, ''));
  if (process.env.NEXT_PUBLIC_CLOUD_URL) bases.push(process.env.NEXT_PUBLIC_CLOUD_URL.replace(/\/+$/, ''));

  // Loopback / LAN page — the API listens on :3003 of the page host itself.
  const host = window.location.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || /^10\./.test(host) || /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
    bases.push(`http://${host === '0.0.0.0' ? 'localhost' : host}:3003`);
  }
  return bases;
}

/** Next untried src for this img path, or null. */
function nextCandidate(img: HTMLImageElement): string | null {
  const src = img.getAttribute('src') || '';
  if (!src) return null;

  let pathWithQuery: string;
  let currentBase = '';
  try {
    const parsed = new URL(src, window.location.origin);
    if (!parsed.pathname.includes(UPLOAD_PATH_MARKER)) return null;
    pathWithQuery = `${parsed.pathname}${parsed.search}`;
    currentBase = isHttpUrl(src) ? `${parsed.protocol}//${parsed.host}` : window.location.origin;
  } catch {
    return null; // data:/blob:/garbage — not ours to fix
  }

  const key = pathWithQuery.split('?')[0];
  if (!key) return null;
  let tried = attempted.get(key);
  if (!tried) {
    if (attempted.size >= MAX_TRACKED_PATHS) attempted.clear();
    tried = new Set<string>();
    attempted.set(key, tried);
  }
  if (tried.has(src)) {
    // The failed src itself may not be recorded yet when multiple errors race.
    // Fall through — candidates below are checked against `tried` anyway.
  }
  tried.add(src);
  if (tried.size > MAX_ATTEMPTS_PER_PATH + 1) return null;

  // 1) absolute bases with the same path
  for (const base of candidateBases()) {
    if (!base || base === currentBase) continue;
    const candidate = `${base}${pathWithQuery}`;
    if (!tried.has(candidate)) return candidate;
  }
  // 2) gateway same-origin relative (public preview / sandbox shells)
  if (window.location.protocol.startsWith('http')) {
    const rel = `${pathWithQuery}${pathWithQuery.includes('?') ? '&' : '?'}XTransformPort=3003`;
    if (!tried.has(rel)) return rel;
  }
  return null;
}

function recoverImg(img: HTMLImageElement): void {
  const candidate = nextCandidate(img);
  if (candidate) {
    try { img.setAttribute('src', candidate); } catch { /* detached node */ }
  }
}

export function UploadImageRecovery() {
  useEffect(() => {
    const onError = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLImageElement)) return;
      const src = target.getAttribute('src') || '';
      if (!src || src.startsWith('data:') || src.startsWith('blob:')) return;
      if (!src.includes(UPLOAD_PATH_MARKER)) return;
      recoverImg(target);
    };

    // Capture phase — img error events do not bubble, but they DO descend.
    document.addEventListener('error', onError, true);

    // The resolver adopting a base retro-fixes every img that failed earlier.
    const unsubscribe = onNativeCloudStateChange((state) => {
      if (state.status !== 'found' || !state.url) return;
      const adoptedBase = state.url.replace(/\/+$/, '');
      const imgs = document.querySelectorAll<HTMLImageElement>(`img[src*="${UPLOAD_PATH_MARKER}"]`);
      imgs.forEach((img) => {
        const src = img.getAttribute('src') || '';
        try {
          const parsed = new URL(src, window.location.origin);
          // Only retry imgs whose base is NOT the adopted one (they have a chance).
          const srcBase = isHttpUrl(src) ? `${parsed.protocol}//${parsed.host}` : '';
          if (srcBase && srcBase === adoptedBase) return;
        } catch { /* relative src — retry is harmless */ }
        if (img.complete && img.naturalWidth > 0) return; // actually fine already
        recoverImg(img);
      });
    });

    return () => {
      document.removeEventListener('error', onError, true);
      unsubscribe();
    };
  }, []);

  return null;
}
