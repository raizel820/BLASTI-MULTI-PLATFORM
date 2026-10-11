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
 * placeholder". This component flips to initials the moment the image fails
 * to load, resets when the URL changes, and keeps the exact previous
 * rendering (getProxiedUrl + object-cover) when the URL is healthy.
 */

import { useEffect, useState } from 'react';
import { getProxiedUrl } from '@/lib/utils';

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
  const [failed, setFailed] = useState(false);

  // A different URL (profile update, re-login) gets a fresh chance to load.
  useEffect(() => {
    setFailed(false);
  }, [avatarUrl]);

  if (!avatarUrl || failed) {
    return <>{initialsOf(fullName)}</>;
  }

  return (
    <img
      src={getProxiedUrl(avatarUrl)}
      alt={fullName || 'Avatar'}
      width={size}
      height={size}
      className={className}
      onError={() => setFailed(true)}
    />
  );
}
