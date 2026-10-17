'use client';

/**
 * UserAvatar — avatar <img> with a graceful initials fallback (Task 78).
 *
 * Why: customer avatars were rendered as
 *   `user.avatarUrl ? <img src={...}/> : initials`
 * so a STALE or UNREACHABLE URL (an account registered before the upload
 * pipeline was hardened, a localhost-stored URL viewed from a phone, a file
 * that never synced, …) rendered a broken-image glyph inside the avatar
 * circle instead of falling back — users reported it as "just a
 * placeholder".
 *
 * Rendering now goes through useAvatarSrc (lib/avatar-src.ts): the URL is
 * environment-rebased (getProxiedUrl), a failure gets a delayed cache-busted
 * retry plus — on the Capacitor phone — a native HTTP fetch fallback that
 * bypasses the WebView's image network policy entirely, and only THEN flips
 * to initials. A different URL (profile update, re-login) always restarts
 * the whole pipeline.
 *
 * Task 85 (caching): on top of that, every successfully-loaded avatar is
 * persisted as a data: URL in lib/image-cache (memory + IndexedDB). The next
 * time any view mounts an avatar for the SAME url, it paints instantly from
 * the cache — no network round-trip, no placeholder flash while the WebView
 * re-resolves the image. This is what removes the "avatar shows placeholder
 * for seconds when I switch pages" complaint across web/mobile/desktop.
 */

import { useEffect, useMemo, useState } from 'react';
import { useAvatarSrc } from '@/lib/avatar-src';
import { useSessionAvatarOverride } from '@/lib/avatar-override';
import { peekImage, getImage, captureImage, canonicalImageUrl } from '@/lib/image-cache';

/** First-name + last-name initials, matching the previous inline helpers. */
export function initialsOf(fullName?: string | null): string {
  if (!fullName) return 'U';
  const parts = fullName.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
  }
  return parts[0]?.charAt(0).toUpperCase() || 'U';
}

export function UserAvatar({
  avatarUrl,
  fullName,
  className = 'h-full w-full object-cover',
  size = 80,
}: {
  avatarUrl?: string | null;
  fullName?: string | null;
  className?: string;
  size?: number;
}) {
  const { src, handleError } = useAvatarSrc(avatarUrl);
  // Session override: right after an upload, the LOCAL bytes of the picked
  // file render instantly under the new avatarUrl — no network request that
  // could fail (mobile "placeholder after upload" report).
  const override = useSessionAvatarOverride(avatarUrl);

  // ── Task 85: instant paint from the persistent image cache ──
  // Memory hits resolve synchronously during the FIRST render (no flash at
  // all); IndexedDB hits land one commit later — still far faster than the
  // network round-trip the <img> would need.
  const canonical = useMemo(() => (src ? canonicalImageUrl(src) : null), [src]);
  const [cachedSrc, setCachedSrc] = useState<string | null>(() =>
    canonical ? peekImage(canonical) : null,
  );
  useEffect(() => {
    if (!canonical) {
      setCachedSrc(null);
      return;
    }
    const mem = peekImage(canonical);
    if (mem) {
      setCachedSrc(mem);
      return;
    }
    let alive = true;
    getImage(canonical).then((dataUrl) => {
      if (alive && dataUrl) setCachedSrc(dataUrl);
    });
    return () => {
      alive = false;
    };
  }, [canonical]);

  const effectiveSrc = override ?? cachedSrc ?? src;

  // Persist the avatar bytes once it has rendered, so the NEXT mount of this
  // url paints instantly from the cache. fetch() here rides the browser HTTP
  // cache (immutable upload URLs) — effectively free.
  const handleLoad = (): void => {
    if (override) return;
    if (effectiveSrc && /^https?:/i.test(effectiveSrc)) {
      void captureImage(effectiveSrc);
    }
  };

  if (!effectiveSrc) {
    return <>{initialsOf(fullName)}</>;
  }

  return (
    // key={src} — a retry/override produces a fresh <img> element so the
    // browser genuinely re-requests instead of replaying a cached failure.
    <img
      key={effectiveSrc}
      src={effectiveSrc}
      alt={fullName || 'Avatar'}
      width={size}
      height={size}
      // bg-muted shows a neutral disc while the bytes stream in instead of a
      // stark empty circle (the "placeholder for seconds" feel).
      className={`bg-muted ${className}`}
      onError={override ? undefined : handleError}
      onLoad={handleLoad}
    />
  );
}
