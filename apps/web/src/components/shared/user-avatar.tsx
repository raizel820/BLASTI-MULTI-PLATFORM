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
 * FLASH FIX (logs-1 round — "profile image placeholder flashing"):
 * the old markup REPLACED the initials node with the <img> the moment a src
 * existed, so every first-ever load (and every remount before the async
 * cache subscription answered) showed initials → blank gradient → image.
 * The initials now STAY PAINTED UNDERNEATH the image (absolute layer) and
 * the img fades in only after its bytes actually decode (onLoad). Combined
 * with the synchronous cache peek in useAvatarSrc, a session-remembered
 * avatar paints instantly with zero placeholder window.
 */

import { useEffect, useState } from 'react';
import { useAvatarSrc } from '@/lib/avatar-src';
import { useSessionAvatarOverride } from '@/lib/avatar-override';

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
  const effectiveSrc = override ?? src;

  // Track DECODED (not just assigned) — opacity flips only when the bytes
  // are actually on screen, so the initials layer never flashes through.
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    setLoaded(false);
  }, [effectiveSrc]);

  if (!effectiveSrc) {
    return <>{initialsOf(fullName)}</>;
  }

  return (
    // Layered container: initials painted underneath (inherited font styles),
    // the image fades in above once decoded — no blank/placeholder flash.
    <span
      className="relative block h-full w-full overflow-hidden"
      role="img"
      aria-label={fullName || 'Avatar'}
    >
      {!loaded && (
        <span className="absolute inset-0 flex items-center justify-center select-none">
          {initialsOf(fullName)}
        </span>
      )}
      {/* key={src} — a retry/override produces a fresh <img> element so the
          browser genuinely re-requests instead of replaying a cached failure. */}
      <img
        key={effectiveSrc}
        src={effectiveSrc}
        alt={fullName || 'Avatar'}
        width={size}
        height={size}
        className={`${className} transition-opacity duration-200 ${loaded ? 'opacity-100' : 'opacity-0'}`}
        onLoad={() => setLoaded(true)}
        onError={override ? undefined : handleError}
      />
    </span>
  );
}
