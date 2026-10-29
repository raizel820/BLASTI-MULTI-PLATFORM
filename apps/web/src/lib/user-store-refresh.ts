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
import { mirrorNotifPrefs } from './notification-channel';

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
  // 0.6.17 — the immutable account UID heals into stale sessions too: the
  // phone's persisted login-era user object predating the uid rollout (or
  // minted against an older deployed API) never gains it otherwise, and the
  // profile/settings UID chips render NOTHING while user.uid is undefined.
  'uid',
] as const;

type MergeableField = (typeof MERGEABLE_PROFILE_FIELDS)[number];

let lastRefreshAt = 0;
let inFlight: Promise<void> | null = null;

/**
 * Timestamp of the last LOCAL avatar activation (upload confirm / profile
 * save). Guards the refresher from CLOBBERING a brand-new avatar with the
 * server's slightly-stale answer: a refresh request that STARTED before the
 * local mutation (or lands right after it on a slow network) read the OLD
 * row, and blindly merging it used to overwrite the fresh avatarUrl — the
 * freshly-uploaded picture vanished back to the previous/placeholder state
 * seconds after a successful upload.
 */
let lastLocalAvatarMutationAt = 0;

/** Suppress window: server answers older than this NEVER clobber. */
const AVATAR_MUTATION_SUPPRESS_MS = 15_000;

/** Call from every flow that just applied a new avatarUrl locally. */
export function markLocalAvatarMutation(): void {
  lastLocalAvatarMutationAt = Date.now();
}

function avatarMutationGuardsRefresh(requestStartedAt: number): boolean {
  if (lastLocalAvatarMutationAt === 0) return false;
  // The request started before the local mutation → its answer is stale.
  if (requestStartedAt < lastLocalAvatarMutationAt) return true;
  // Landed within the suppress window → server may not have settled yet.
  return Date.now() - lastLocalAvatarMutationAt < AVATAR_MUTATION_SUPPRESS_MS;
}

/**
 * Language mutation guard (Agencies Management session — language revert fix).
 *
 * The header language switcher (and the profile preferences select) now PATCH
 * the server AND stamp a local mutation. Without this guard the 1.5 s profile
 * refresher merged the DB's slightly-stale answer over the just-picked
 * language — the UI visibly "reverted to Arabic shortly after switching".
 * Mirrors the avatar guard exactly: a refresh that STARTED before the local
 * switch, or lands within the suppress window, never touches `language`.
 */
let lastLocalLanguageMutationAt = 0;

/** Suppress window: server answers older than this NEVER clobber. */
const LANGUAGE_MUTATION_SUPPRESS_MS = 15_000;

/** Call from every flow that just applied a new language locally. */
export function markLocalLanguageMutation(): void {
  lastLocalLanguageMutationAt = Date.now();
}

function languageMutationGuardsRefresh(requestStartedAt: number): boolean {
  if (lastLocalLanguageMutationAt === 0) return false;
  if (requestStartedAt < lastLocalLanguageMutationAt) return true;
  return Date.now() - lastLocalLanguageMutationAt < LANGUAGE_MUTATION_SUPPRESS_MS;
}

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
    const requestStartedAt = Date.now();
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
          // Guard: a local activation (upload/save) always beats this
          // request's snapshot of the row — see markLocalAvatarMutation.
          if (avatarMutationGuardsRefresh(requestStartedAt)) {
            // Keep the local value untouched for this merge.
          } else {
            // Adopt only well-typed values; DB truth wins (a null avatarUrl
            // means the avatar was removed server-side and MUST clear
            // locally).
            merged[field] = typeof value === 'string' && value ? value : undefined;
          }
        } else if (field === 'language') {
          // Guard: a local language switch always beats this request's
          // snapshot — see markLocalLanguageMutation (language revert fix).
          if (languageMutationGuardsRefresh(requestStartedAt)) {
            // Keep the local value untouched for this merge.
          } else if (typeof value === 'string' && value) {
            merged[field] = value;
          }
        } else if (typeof value === 'string' && value) {
          merged[field] = value;
        }
      }

      // Notification-preferences mirror: the realtime turn-alert paths run
      // outside React and read localStorage (notification-channel.ts). Refresh
      // it here so a preference changed on another device (or in Settings)
      // takes effect on this shell too — cross-device parity with the avatar.
      const rawPrefs = (data as Record<string, unknown>).notificationPreferences;
      if (rawPrefs) {
        try {
          mirrorNotifPrefs(
            typeof rawPrefs === 'string' ? JSON.parse(rawPrefs) : (rawPrefs as Record<string, unknown>),
          );
        } catch { /* malformed prefs — keep the previous mirror */ }
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
 * Post-login authoritative sync (0.6.17 — first-login avatar/UID fix).
 *
 * The login response is whatever the DEPLOYED server returns; an older API
 * (or a server race) can mint a session whose user object lacks fresh
 * avatarUrl/uid — the shell then renders initials + no UID chip until the
 * user happens to open a surface that re-fetches. Called once from the
 * store's setSessionToken (i.e. after EVERY fresh login / session heal), it
 * re-reads /api/user/profile and merges the authoritative identity fields
 * into the store ~1.2s later, so the header/sidebar/profile all paint the
 * real picture without waiting for the 30s+ focus cycle.
 *
 * Idempotent: multiple callers inside the dedupe window coalesce into one
 * fetch (dynamic import — no static store cycle).
 */
let lastPostLoginSyncAt = 0;
let postLoginTimer: ReturnType<typeof setTimeout> | null = null;
const POST_LOGIN_SYNC_DEDUPE_MS = 10_000;

export function schedulePostLoginProfileSync(): void {
  if (typeof window === 'undefined') return;
  const now = Date.now();
  if (now - lastPostLoginSyncAt < POST_LOGIN_SYNC_DEDUPE_MS) return;
  lastPostLoginSyncAt = now;
  if (postLoginTimer) clearTimeout(postLoginTimer);
  postLoginTimer = setTimeout(() => {
    postLoginTimer = null;
    refreshSessionUser().catch(() => { /* silent — best-effort */ });
  }, 1200);
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
    // cache-1 — warm the role's core endpoints + avatar into the caches so
    // the first navigation paints instantly (fire-and-forget, throttled).
    import('./boot-prefetch').then((m) => m.warmCoreCaches()).catch(() => { /* silent */ });
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
    if (postLoginTimer) { clearTimeout(postLoginTimer); postLoginTimer = null; }
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
