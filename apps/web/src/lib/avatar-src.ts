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
 * Fetch `url` through the native bridge and return an image data: URL.
 * CapacitorHttp with responseType 'arraybuffer' answers with a base64
 * payload on Android — decode-free (we embed it straight into the data URL).
 * Returns null on ANY failure so callers keep their fallback path.
 */
async function nativeImageDataUrl(url: string): Promise<string | null> {
  const http = nativeHttpPlugin();
  if (!http?.get) return null;
  try {
    const res = await http.get({
      url,
      responseType: 'arraybuffer',
      connectTimeout: 8000,
      readTimeout: 12000,
    });
    const base64 = typeof res.data === 'string' ? res.data : '';
    if (res.status !== 200 || !base64) return null;
    const mime = mimeFromHeaders(res.headers) || mimeFromUrl(url);
    return `data:${mime};base64,${base64}`;
  } catch {
    return null;
  }
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

  const primaryUrl = useMemo(() => {
    if (!avatarUrl) return null;
    const rebased = getProxiedUrl(avatarUrl);
    return rebased ? withRetryBuster(rebased, attempt) : null;
    // `attempt` intentionally drives recompute — the cache-buster IS the retry.
  }, [avatarUrl, attempt]);

  const busyRef = useRef(false);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // New URL (or a resolver re-arm) → fresh chance for every defense layer.
  useEffect(() => {
    setNativeSrc(null);
    setDead(false);
    busyRef.current = false;
  }, [avatarUrl, attempt]);

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
        setDead(false);
        busyRef.current = false;
        setAttempt((a) => a + 1);
      }
    });
  }, []);

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
          busyRef.current = false;
          return;
        }
        console.warn('[Avatar] native fetch failed for', bareUrl);
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
      setDead(true);
    };

    void run();
  }, [nativeSrc, primaryUrl, attempt]);

  if (!avatarUrl || dead) return { src: null, handleError };
  return { src: nativeSrc ?? primaryUrl, handleError };
}
