'use client';

/**
 * user-store-refresh — the "profile image must reach every device" fix.
 *
 * THE PROBLEM (field report: "avatar works only in the customer webapp; the
 * mobile app, desktop app and other accounts still see the placeholder"):
 *
 * The zustand `user` object is PERSISTED to localStorage and was only ever
 * refreshed at LOGIN or after an in-place profile edit on the SAME device.
 * Every other device kept its stale copy forever:
 *
 *   - A customer uploaded an avatar in the webapp → the webapp's store
 *     updated (activateAvatar/handleSavePersonalInfo call setUser there) →
 *     the SAME account on the phone/desktop still had the login-era
 *     user object with avatarUrl=null → header, sidebar and profile
 *     identity card rendered the initials placeholder.
 *   - Nothing on boot re-validated the persisted user against the server:
 *     session-heal only fires on AUTH FAILURE, not on stale profile data.
 *
 * THE FIX: one gentle refresher, mounted app-wide (ClientBootHardening),
 * that runs
 *   - once shortly after boot, and
 *   - whenever the app regains focus / becomes visible (throttled),
 * then merges the authoritative profile fields into the store.
 *
 * CONTRACTS honoured:
 *   - Navigation-safe: raw setState merge — NEVER setUser(), which resets
 *     currentView to the role's default view (same rationale as
 *     applyHealedSession in session-heal.ts).
 *   - Shell-agnostic: apiFetch targets the right API per shell — the cloud
 *     API on web + Capacitor (phone), the LOCAL API on desktop (Electron),
 *     whose /api/user/profile reads the synced local User row and LOCALIZES
 *     the avatar URL (serveLocalFile + cloud-proxy fallback for blobs that
 *     have not been downloaded yet). The local row itself is kept fresh by
 *     the existing cloud→local User pull (USER_SYNC_FIELDS carries
 *     avatarUrl) — refresher + that pull = end-to-end propagation.
 *   - Cross-account freshness: every viewer (SUPER_ADMIN, AGENCY_*) that
 *     renders the CURRENT user's avatar benefits; OTHER users' avatars
 *     (admin users list, agency reviews, queue screens) come from their own
 *     endpoints, which already carry avatarUrl.
 */

import { apiFetch } from './api-fetch';

/** Minimum interval between two refreshes triggered by focus/visibility. */
const FOCUS_REFRESH_MIN_INTERVAL_MS = 30_000;

/** Fields the refresher is allowed to merge into the persisted user. */
const MERGEABLE_PROFILE_FIELDS = [
  'fullName',
  'email',
  'phoneNumber',
  'avatarUrl',
  'freeSmsCount',
  'language',
] as const;

type MergeableField = (typeof MERGEABLE_PROFILE_FIELDS)[number];

let lastRefreshAt = 0;
let inFlight: Promise<void> | null = null;

/**
 * Fetch the logged-in user's profile from the authoritative API and gently
 * merge the fresh values into the persisted store. Safe to call from
 * anywhere; concurrent calls coalesce into one network request.
 */
export async function refreshSessionUser(): Promise<void> {
  const { useAppStore } = await import('@/store/use-app-store');
  const { user, sessionToken } = useAppStore.getState();
  if (!user?.id || !sessionToken) return; // signed out — nothing to refresh

  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const res = await apiFetch(`/api/user/profile?userId=${encodeURIComponent(user.id)}`);
      if (!res.ok) return; // 401 → session-heal owns auth repair; silent here
      const data = await res.json().catch(() => null);
      if (!data || typeof data !== 'object') return;

      const prev = useAppStore.getState().user;
      // The account may have switched while the request was in flight.
      if (!prev || prev.id !== user.id) return;

      const merged: Record<string, unknown> = { ...prev };
      for (const field of MERGEABLE_PROFILE_FIELDS as readonly MergeableField[]) {
        const value = (data as Record<string, unknown>)[field];
        // Adopt only well-typed values; DB truth wins (a null avatarUrl means
        // the avatar was removed server-side and MUST clear locally).
        if (field === 'freeSmsCount') {
          if (typeof value === 'number' && Number.isFinite(value)) merged[field] = value;
        } else if (field === 'avatarUrl') {
          merged[field] = typeof value === 'string' && value ? value : undefined;
        } else if (typeof value === 'string' && value) {
          merged[field] = value;
        }
      }

      // Skip the write when nothing actually changed (avoids re-render churn
      // on every focus event).
      const changed = MERGEABLE_PROFILE_FIELDS.some(
        (f) => (merged as Record<string, unknown>)[f] !== (prev as unknown as Record<string, unknown>)[f],
      );
      if (!changed) return;

      useAppStore.setState({ user: merged as typeof prev });
    } catch {
      // Best-effort refresh — network errors must never disturb the session.
    } finally {
      lastRefreshAt = Date.now();
      inFlight = null;
    }
  })();
  return inFlight;
}

/**
 * App-lifetime listener wiring: refresh once after boot, then on every
 * window focus / tab-visible event (throttled). Returns a cleanup fn.
 * Designed to be started once from ClientBootHardening.
 */
export function startUserStoreRefresh(): () => void {
  // Boot refresh — slight delay so it never competes with the critical
  // first-paint data fetches.
  const bootTimer = setTimeout(() => {
    refreshSessionUser().catch(() => { /* silent */ });
  }, 1500);

  const onFocus = () => {
    if (Date.now() - lastRefreshAt < FOCUS_REFRESH_MIN_INTERVAL_MS) return;
    refreshSessionUser().catch(() => { /* silent */ });
  };
  const onVisibility = () => {
    if (document.visibilityState !== 'visible') return;
    onFocus();
  };

  window.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    clearTimeout(bootTimer);
    window.removeEventListener('focus', onFocus);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

/**
 * Gently merge a partial profile patch into the persisted store user —
 * the shared primitive for code paths that LEARN a fresher profile than the
 * store holds (e.g. the profile page's own fetchProfile). Same navigation
 * safety contract as refreshSessionUser.
 */
export function mergeSessionUser(patch: Partial<Record<MergeableField, unknown>>): void {
  void (async () => {
    try {
      const { useAppStore } = await import('@/store/use-app-store');
      const prev = useAppStore.getState().user;
      if (!prev) return;
      const merged: Record<string, unknown> = { ...prev, ...patch };
      useAppStore.setState({ user: merged as typeof prev });
    } catch {
      // Best-effort — never break the caller's flow.
    }
  })();
}
