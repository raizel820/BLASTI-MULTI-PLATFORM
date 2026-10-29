'use client';

/**
 * useAvatarSrc — bulletproof <img> src resolution for uploaded avatars/logos.
 *
 * WHY (the mobile "profile image stays a placeholder" saga):
 *   Uploaded files are served from the cloud API as PUBLIC capability URLs
 *   (GET /api/upload/file/... needs no auth), so a plain <img> tag should
 *   just work. On the Capacitor phone the URL is rebased by getProxiedUrl()
 *   onto the baked cloud base (http://129.151.242.219) and loaded from a
 *   https://localhost WebView — a cross-origin CLEARTEXT image. Whether that
 *   renders depends on WebView policy layers (NSC cleartext exception,
 *   mixed-content mode, image cache state) that we cannot fully control from
 *   JS, and a single transient failure (boot-time resolver race, network
 *   blip) used to permanently kill the avatar: raw <img> consumers had NO
 *   error recovery at all, and even UserAvatar only fell back to initials
 *   with no retry.
 *
 * This hook layers THREE defenses so the picture shows whenever the native
 * network stack can physically reach the server:
 *
 *   1. RETRY — one delayed, cache-busted re-attempt of the primary URL
 *      (covers boot races: the resolver may adopt the real server AFTER the
 *      first render; onNativeCloudStateChange('found') also re-arms the img).
 *   2. NATIVE FETCH FALLBACK — Capacitor only: if the WebView refuses the
 *      image (mixed-content/NSC policy), re-fetch it through the native
 *      CapacitorHttp bridge (OkHttp — completely outside the WebView network
 *      policy) and render the bytes as a data: URL.
 *   3. GRACEFUL DEAD — after all attempts fail, src becomes null so every
 *      consumer renders its initials/icon fallback (never a broken glyph).
 *
 * Consumers keep full control of their fallback UI:
 *   const { src, handleError } = useAvatarSrc(user?.avatarUrl);
 *   {src ? <img src={src} onError={handleError}/> : <fallback/>}
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getProxiedUrl } from './utils';
import { onNativeCloudStateChange } from './native-cloud-resolver';
import { subscribeImage, peekImageHandle, putImageBytes } from './image-cache';
import { useResumeRefresh } from './resume-refresh';

// ─── CapacitorHttp (core plugin — ships inside every Capacitor runtime) ──────

interface NativeHttpResult {
  status?: number;
  headers?: Record<string, string>;
  data?: unknown;
}

interface NativeHttpPlugin {
  get?: (opts: {
    url: string;
    headers?: Record<string, string>;
    connectTimeout?: number;
    readTimeout?: number;
    responseType?: string;
  }) => Promise<NativeHttpResult>;
}

/** Feature-detected native HTTP bridge — null on the web/SSR. */
function nativeHttpPlugin(): NativeHttpPlugin | null {
  if (typeof window === 'undefined') return null;
  const cap = (
    window as unknown as {
      Capacitor?: {
        isNativePlatform?: () => boolean;
        Plugins?: Record<string, NativeHttpPlugin | undefined>;
      };
    }
  ).Capacitor;
  if (!cap?.isNativePlatform?.()) return null;
  return cap.Plugins?.CapacitorHttp ?? null;
}

function mimeFromHeaders(headers?: Record<string, string>): string | null {
  if (!headers) return null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'content-type' && value) {
      return value.split(';')[0].trim().toLowerCase();
    }
  }
  return null;
}

function mimeFromUrl(url: string): string {
  const ext = url.split('?')[0].split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'svg') return 'image/svg+xml';
  return 'image/jpeg'; // jpg/jpeg + the overwhelmingly common default
}

/**
 * Store natively-fetched bytes into the SHARED persistent image cache so
 * every other mounted (or future) avatar instance revives too. The WebView
 * fetch path that used to fill the cache is blocked for cleartext cross-origin
 * images (mixed-content) — exactly why dead avatars never revived.
 */
async function cacheNativeBytes(path: string, dataUrl: string): Promise<void> {
  try {
    const comma = dataUrl.indexOf(',');
    const head = dataUrl.slice(0, comma); // data:image/jpeg;base64
    const b64 = dataUrl.slice(comma + 1);
    const mime = head.slice(5).split(';')[0] || 'image/jpeg';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    await putImageBytes(path, bytes, mime);
  } catch { /* cache is best-effort */ }
}

/**
 * Fetch `url` through the native bridge and return an image data: URL.
 * CapacitorHttp with responseType 'arraybuffer' answers with a base64
 * payload on Android — decode-free (we embed it straight into the data URL).
 * Returns null on ANY failure so callers keep their fallback path.
 *
 * 0.6.18 RETRY (field log): single attempts die with "Software caused
 * connection abort" (SocketException) — OkHttp reuses a pooled socket that
 * the OS killed while the app was suspended; a fresh attempt on a NEW socket
 * succeeds. Two attempts with a short backoff, real error logged (was
 * swallowed, leaving only a reason-less warn in the phone log).
 *
 * Exported for the upload-confirm flows: they use it to (a) natively VERIFY
 * that a freshly-uploaded file is actually reachable before trusting it and
 * (b) reuse the fetched bytes as the session avatar override.
 */
export async function nativeImageDataUrl(url: string): Promise<string | null> {
  const http = nativeHttpPlugin();
  if (!http?.get) return null;
  for (let i = 0; i < 2; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 450));
    try {
      const res = await http.get({
        url,
        responseType: 'arraybuffer',
        connectTimeout: 8000,
        readTimeout: 12000,
      });
      const base64 = typeof res.data === 'string' ? res.data : '';
      if (res.status !== 200 || !base64) return null; // server said no — don't retry
      const mime = mimeFromHeaders(res.headers) || mimeFromUrl(url);
      return `data:${mime};base64,${base64}`;
    } catch (e) {
      console.warn(`[Avatar] native fetch attempt ${i + 1}/2 failed for`, url, e);
    }
  }
  return null;
}

/** Append (or refresh) a retry cache-buster — upload files are immutable-cached. */
function withRetryBuster(url: string, attempt: number): string {
  if (attempt <= 0) return url;
  const base = url.split('#')[0];
  return `${base}${base.includes('?') ? '&' : '?'}r=${attempt}`;
}

// ─── The hook ─────────────────────────────────────────────────────────────────

export interface AvatarSrc {
  /** Ready-to-render src, or null → render your initials/icon fallback. */
  src: string | null;
  /** Attach to the <img> onError — drives retry + native fallback. */
  handleError: () => void;
}

export function useAvatarSrc(avatarUrl: string | null | undefined): AvatarSrc {
  // attempt > 0 forces a recomputed (cache-busted) primary URL — used by the
  // retry path AND by resolver-adoption re-arms.
  const [attempt, setAttempt] = useState(0);
  // data: URL from the native fetch fallback (wins over the primary).
  const [nativeSrc, setNativeSrc] = useState<string | null>(null);
  // All options exhausted — render the fallback.
  const [dead, setDead] = useState(false);
  // Persistent-cache object-URL (cache-1): instant paint across remounts,
  // zero network after the first ever load. Wins over the direct URL.
  // FLASH FIX (logs-1 round): the initial state SYNCHRONOUSLY peeks the
  // session handle map — a previously-seen image renders on the very first
  // paint instead of one async tick late (which flashed the placeholder).
  const rebasedUrl = useMemo(() => {
    if (!avatarUrl) return null;
    return getProxiedUrl(avatarUrl);
  }, [avatarUrl]);

  const [cachedSrc, setCachedSrc] = useState<string | null>(() =>
    rebasedUrl ? peekImageHandle(rebasedUrl) : null,
  );

  const primaryUrl = useMemo(() => {
    if (!rebasedUrl) return null;
    return withRetryBuster(rebasedUrl, attempt);
    // `attempt` intentionally drives recompute — the cache-buster IS the retry.
  }, [rebasedUrl, attempt]);

  // Persistent image cache subscription — fires immediately with the cached
  // handle (or null) and again when the background revalidation swaps bytes.
  // Skips data:/blob: inputs (already in-memory) automatically.
  useEffect(() => {
    setCachedSrc(null);
    if (!rebasedUrl) return;
    return subscribeImage(rebasedUrl, (url) => setCachedSrc(url));
  }, [rebasedUrl]);

  const busyRef = useRef(false);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  // Mirror of `dead` for event callbacks that must not capture stale state.
  const deadRef = useRef(false);
  const setDeadState = useCallback((v: boolean) => {
    deadRef.current = v;
    setDead(v);
  }, []);

  // New URL (or a resolver re-arm) → fresh chance for every defense layer.
  useEffect(() => {
    setNativeSrc(null);
    setDeadState(false);
    busyRef.current = false;
  }, [avatarUrl, attempt, setDeadState]);

  // The cloud resolver adopted a server AFTER we may have failed — re-arm.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const cap = (
      window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }
    ).Capacitor;
    if (!cap?.isNativePlatform?.()) return;
    return onNativeCloudStateChange((s) => {
      if (s.status === 'found') {
        setNativeSrc(null);
        setDeadState(false);
        busyRef.current = false;
        setAttempt((a) => a + 1);
      }
    });
  }, [setDeadState]);

  // 0.6.18 RE-ARM (field log: avatars that died during a suspended-socket
  // SocketException stayed on initials until the next full reload): when the
  // app comes back to the foreground (resume-refresh bus) or connectivity
  // returns, give DEAD avatars one fresh pipeline — the deterministic
  // path/permission fixes elsewhere make this cheap and finally worthwhile.
  useResumeRefresh(() => {
    if (!deadRef.current || !rebasedUrl) return;
    busyRef.current = false;
    setNativeSrc(null);
    setDeadState(false);
    setAttempt((a) => a + 1);
  }, !!rebasedUrl);
  useEffect(() => {
    if (typeof window === 'undefined' || !rebasedUrl) return;
    const onOnline = () => {
      if (!deadRef.current) return;
      busyRef.current = false;
      setNativeSrc(null);
      setDeadState(false);
      setAttempt((a) => a + 1);
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [rebasedUrl, setDeadState]);

  // Timer cleanup.
  useEffect(() => () => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
  }, []);

  const handleError = useCallback((): void => {
    if (busyRef.current) return; // one pipeline at a time
    busyRef.current = true;

    const run = async (): Promise<void> => {
      // 1. Native fetch fallback (Capacitor only) — bypasses the WebView's
      //    image network policy entirely (mixed content / NSC edge cases).
      if (nativeSrc === null && primaryUrl && nativeHttpPlugin()) {
        const bareUrl = primaryUrl.split('?')[0]; // buster is pointless for native
        const dataUrl = await nativeImageDataUrl(bareUrl);
        if (dataUrl) {
          setNativeSrc(dataUrl);
          // 0.6.18: fill the SHARED cache — other dead instances revive.
          void cacheNativeBytes(bareUrl, dataUrl);
          busyRef.current = false;
          return;
        }
        console.warn('[Avatar] native fetch exhausted for', bareUrl);
      }

      // 2. One delayed cache-busted retry of the primary URL (transient
      //    boot/network races), then give up to the fallback UI.
      if (primaryUrl && attempt < 1) {
        timersRef.current.push(
          setTimeout(() => {
            busyRef.current = false;
            setAttempt((a) => a + 1);
          }, 2500),
        );
        return;
      }

      console.warn('[Avatar] giving up — falling back to initials for', primaryUrl);
      setDeadState(true);
    };

    void run();
  }, [nativeSrc, primaryUrl, attempt, setDeadState]);

  if (!avatarUrl) return { src: null, handleError };
  // FIRST-LOGIN FIX (field report: "the profile image shows only in the More
  // page"): the persistent image cache is SHARED across every mounted
  // instance — when a freshly-mounted surface (profile page / More sheet)
  // successfully loads the bytes, subscribers that already went `dead` at
  // boot (resolver race / transient WebView failure) receive the handle and
  // MUST revive. The old `dead` short-circuit sat BEFORE this lookup and
  // permanently blocked the revival, leaving boot-mounted surfaces (home
  // header, sidebar) on initials forever while later-mounted surfaces painted
  // the picture. Cache/native hits now beat `dead` — zero network, instant.
  if (nativeSrc || cachedSrc) return { src: nativeSrc ?? cachedSrc, handleError };
  if (dead) return { src: null, handleError };
  // Priority: native recovery bytes → persistent-cache handle (instant, no
  // network) → the direct URL (browser fetch; also warms the cache in bg).
  return { src: primaryUrl, handleError };
}
