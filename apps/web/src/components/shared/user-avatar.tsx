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
 */

import { useAvatarSrc } from '@/lib/avatar-src';

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

  if (!src) {
    return <>{initialsOf(fullName)}</>;
  }

  return (
    // key={src} — a retry/override produces a fresh <img> element so the
    // browser genuinely re-requests instead of replaying a cached failure.
    <img
      key={src}
      src={src}
      alt={fullName || 'Avatar'}
      width={size}
      height={size}
      className={className}
      onError={handleError}
    />
  );
}
