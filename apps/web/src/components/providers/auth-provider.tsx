'use client';

import { useEffect, useState } from 'react';
import { useAppStore, updateDocumentDirection, hydrateFromSession, setViewFromHash, parseHashToView, parseJoinCodeFromHash, updateHashForView, isHashChangeSuppressed } from '@/store/use-app-store';
import { isRevoked, setRevoked, clearRevoked } from '@/lib/authz-state';
import { adoptImportedLocalSessionUser } from '@/lib/session-heal';
// Task 2-b (sub-tasks 1+3) — boot-time enforcement of the remember-me
// persistence policy + the renderer-side purge when the desktop app quits.
import { enforcePersistencePolicyAtBoot, purgeAuthState, isSessionEphemeral } from '@/lib/auth-storage';
// Task 2-b-2 (sub-task 2) — ONE boot-time session sanity check (desktop):
// expiry check → single-flight refresh → purge on failure. See session-boot.ts.
import { validateSessionOnBoot } from '@/lib/session-boot';
// r21-8 (counter control) — pagehide/beforeunload release of any counter the
// session still CONTROLS (keepalive POST lives past the unload). The lib's
// 5s double-fire guard also keeps this idempotent with logout()'s call.
import { fireReleaseMine, readPersistedSessionToken } from '@/lib/counter-release';
import { Loader2 } from 'lucide-react';

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const setPendingAgencyCode = useAppStore((state) => state.setPendingAgencyCode);
  const currentView = useAppStore((state) => state.currentView);
  const isAuthenticated = useAppStore((state) => state.isAuthenticated);
  const [sessionChecked, setSessionChecked] = useState(false);
  const [persistRehydrated, setPersistRehydrated] = useState(false);

  // Wait for Zustand persist middleware to rehydrate from localStorage
  // before doing any navigation logic. This prevents the hash-based
  // navigation from overriding the persisted user state.
  useEffect(() => {
    // The persist middleware rehydrates asynchronously. We need to wait
    // for it before reading isAuthenticated.
    const checkRehydration = () => {
      const state = useAppStore.getState();
      if (state.user !== undefined) {
        // Persist has rehydrated — the user field will be either null or a user object
        setPersistRehydrated(true);
      } else {
        // Not yet rehydrated — check again in 50ms
        setTimeout(checkRehydration, 50);
      }
    };
    // Start checking after a short delay to allow persist to kick in
    setTimeout(checkRehydration, 100);
  }, []);

  // ── Task 67: desktop token-rotation catch-up watch ──────────────────────────
  // The local API rotates the session token on import/refresh and keeps the
  // previous one valid for a grace window. This watch catches the renderer up
  // within ~45s even if the rotation header goes unnoticed (Electron only —
  // the watcher is a no-op in browsers and on phones).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!window.electronAPI) return;
    let cancelled = false;
    import('@/lib/session-adopt')
      .then(({ startSessionAdoptWatch }) => {
        if (!cancelled) startSessionAdoptWatch();
      })
      .catch(() => { /* best effort */ });
    return () => { cancelled = true; };
  }, []);

  // ── Task 33-E: desktop revocation push (Task 33-C) ────────────────────────
  // When the desktop's revocation state machine locks the local API it pushes
  // electronAPI.onAuthRevoked(cb({ reason })). Subscribe defensively — browser
  // builds have no electronAPI and older preloads lack the API → plain no-op.
  // On revocation: mark the shared authz state and force the logged-out state
  // so the login form renders. logout() guards the cloud /api/auth/logout call
  // (best-effort .catch) so an unauthenticated call cannot error loudly.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.electronAPI?.onAuthRevoked) return;
    return window.electronAPI.onAuthRevoked((payload) => {
      console.log('[AuthProvider] auth revoked by desktop — reason:', payload?.reason || 'unknown');
      setRevoked(payload?.reason || 'token-rejected');
      try {
        useAppStore.getState().logout();
      } catch (err) {
        console.warn('[AuthProvider] logout after revocation failed:', err);
        useAppStore.setState({ user: null, isAuthenticated: false, sessionToken: '' });
      }
    });
  }, []);

  // ── Task 2-b (sub-task 3): quit purge (desktop) ────────────────────────────
  // When the current login did NOT check "Remember me", every renderer token
  // surface is purged when the app goes away so nothing durable outlives the
  // window (the main process independently deletes userData/blasti-auth.json
  // for non-remember sessions — defense in depth). Remember-me sessions are
  // left intact.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const w = window as any;
    const isElectron = !!w.electronAPI || navigator.userAgent.includes('Electron');
    if (!isElectron) return;

    // Task 2-b-2 — shared purge body: token mirrors + persisted auth fields
    // (purgeAuthState) ONLY for ephemeral sessions; pure synchronous
    // localStorage work, so it is safe inside unload handlers.
    const purgeIfEphemeral = () => {
      try {
        if (isSessionEphemeral()) {
          purgeAuthState();
          console.log('[AuthProvider] App quitting — ephemeral (non remember-me) session purged');
        }
      } catch { /* best-effort — main-process purge is the backstop */ }
    };

    // Primary channel: the main process broadcasts 'app:quitting' on
    // before-quit (its own comment marks this as best-effort — the window may
    // already be gone when the broadcast is sent).
    const offQuitting = w.electronAPI?.onAppQuitting
      ? (w.electronAPI.onAppQuitting(purgeIfEphemeral) as unknown)
      : null;

    // Task 2-b-2 — beforeunload/pagehide FALLBACK: these fire synchronously
    // in the renderer even when the 'app:quitting' broadcast is missed
    // (window destroyed before IPC delivery, hard quit, webContents reload).
    // Idempotent with the broadcast path; pagehide never fires on a plain
    // tray-hide/minimize, so a running ephemeral session is never disturbed.
    // r21-8 (counter control) — the page is going away (quit / reload / hard
    // navigation): free any counter this session still CONTROLS so the next
    // staff member is not locked out for the sweeper window. The lib sends
    // keepalive:true (survives unload) and guards the token internally — a
    // logged-out session simply no-ops. Fire-and-forget, never throws.
    const onPageHide = () => {
      try {
        const token = readPersistedSessionToken();
        if (token) fireReleaseMine(token);
      } catch { /* never block unload */ }
      purgeIfEphemeral();
    };
    try { window.addEventListener('pagehide', onPageHide); } catch { /* ignore */ }
    try { window.addEventListener('beforeunload', onPageHide); } catch { /* ignore */ }

    return () => {
      if (typeof offQuitting === 'function') offQuitting();
      try { window.removeEventListener('pagehide', onPageHide); } catch { /* ignore */ }
      try { window.removeEventListener('beforeunload', onPageHide); } catch { /* ignore */ }
    };
  }, []);

  // ── Boot session settle (BLOCKING on web) / local session restore (Electron) ──
  // Runs once after persist rehydration, BEFORE any authed UI is rendered.
  //
  // WHY BLOCKING (ghost-account logout fix): with a stale Bearer token in the
  // rehydrated store, authed requests fired by eagerly-mounted screens 401 and
  // handleAuthExpired() logged the user out BEFORE the (previously parallel)
  // session heal could complete — the user landed on the landing page even
  // though the httpOnly cookie was still perfectly valid. Settling the session
  // first (validate → heal-or-logout) means every screen mounts with fresh,
  // working credentials.
  useEffect(() => {
    if (!persistRehydrated) return;

    // ── Task 2-b (sub-task 3): boot persistence-policy enforcement ──────────
    // A previous run that ended WITHOUT a clean quit (crash, force-kill,
    // power loss) can leave token mirrors behind even though the login did
    // not opt into being remembered. Purge any such leftover BEFORE the
    // restore logic below can revive the stale session — a non remember-me
    // login MUST always require a fresh sign-in after the app reopens.
    try { enforcePersistencePolicyAtBoot(); } catch { /* never block boot */ }

    const store = useAppStore.getState();

    // ── Task 33-E: REVOKED session — skip every restore path ──────────────
    // Neither the IPC import-session nor the HTTP import-session (nor the
    // cloud settle) may re-import a session the auth authority explicitly
    // rejected. Force the logged-out state so the login form renders.
    // (Minimal state clear instead of logout() — logout navigates to '/' and
    // with the flag persisted that would reload-loop at boot.) A legitimate
    // re-login clears the flag via setSessionToken → clearRevoked().
    if (isRevoked()) {
      console.log('[AuthProvider] Session is revoked — forcing logged-out state (no import-session restore)');
      useAppStore.setState({ user: null, isAuthenticated: false, sessionToken: '' });
      setSessionChecked(true);
      // Task 2-b-2 — the clear above leaves the token mirrors behind; sweep
      // them (Electron-only inside the validator) so no dead Bearer reaches
      // PUBLIC requests. Fire-and-forget: pure storage work, the login
      // screen must not wait for it.
      void validateSessionOnBoot().catch(() => { /* never block boot */ });
      return;
    }

    // Not authenticated — nothing to settle, render immediately.
    if (!store.isAuthenticated || !store.user) {
      setSessionChecked(true);
      // Task 2-b-2 — even WITHOUT a live session, leftover token mirrors
      // (revoked-clear, crashed logout, a remembered login later revoked
      // remotely) must be swept: buildAuthHeaders() would still attach the
      // dead Bearer and the cloud reads the Authorization header FIRST.
      // validateSessionOnBoot() case 1 performs exactly this sweep
      // (Electron-only; browsers → 'skipped', unchanged web behavior).
      void validateSessionOnBoot().catch(() => { /* never block boot */ });
      return;
    }

    let cancelled = false;
    (async () => {
      // ── Task 2-b-2 (sub-task 2): boot session sanity check (desktop) ──────
      // Runs BEFORE any restore path can revive a stale session: checks the
      // token's expiry, attempts exactly ONE refresh through the existing
      // single-flight logic (token-refresh.ts), and — when the session cannot
      // be proven valid (expired + refresh rejected/unavailable, tokens
      // absent, or the 3-day remember-me wall reached) — purges ALL auth
      // surfaces so the restart lands on a clean login instead of continuing
      // a half-valid offline session. Electron-only: browsers return
      // 'skipped' and their settle below stays the sole boot authority.
      try {
        const verdict = await validateSessionOnBoot();
        if (verdict === 'purged') {
          console.log('[AuthProvider] Boot validation purged the stale session — login screen');
        }
        if (verdict === 'purged' || cancelled) {
          setSessionChecked(true);
          return;
        }
      } catch (bootErr) {
        // Never block boot on the validator — the restore/settle below keeps
        // today's behavior when the check cannot run.
        console.warn('[AuthProvider] Boot session validation skipped:', bootErr);
      }
      if (cancelled) return;

      // Re-read AFTER validation: a successful refresh rotated the token.
      const current = useAppStore.getState();

      // ── Electron: Restore local API session on app reload, then render ──
      // When the Electron app restarts/reloads, the local API's sessionToken
      // is null (it's module-level state), but Zustand persist still has the
      // user + token. We need to re-import the session so LAN failover works.
      // (No cloud session check here — the desktop is local-first and has its
      // own auth machinery; see fetch-with-retry handleAuthExpired.)
      try {
        const w = window as any;
        if (w.electronAPI || navigator.userAgent.includes('Electron')) {
          const token = current.sessionToken || localStorage.getItem('blasti-local-api-token');
          if (token && current.user) {
            // 1. Restore via IPC bridge (direct)
            if (w.electronAPI?.setLocalApiSession) {
              w.electronAPI.setLocalApiSession({ token, user: current.user });
            }
            // 2. Also call HTTP import-session as backup. Task 37-a: ADOPT the
            //    refreshed user the local API returns after its cloud validation
            //    — the response used to be discarded, leaving the persisted
            //    user (and its agencyId) stale while the local session moved on
            //    (the root cause of the desktop branch list showing nothing).
            //    Only success:false responses (e.g. AUTHORIZATION_REVOKED)
            //    carry no user — the adoption helper no-ops on them, so the
            //    Task 33-E revoked handling above is unaffected.
            (async () => {
              try {
                const res = await fetch('http://127.0.0.1:3080/api/auth/import-session', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  credentials: 'omit',
                  body: JSON.stringify({ token, user: current.user }),
                });
                if (!res.ok) return; // non-critical — offline / rejected
                const data = await res.json().catch(() => null);
                await adoptImportedLocalSessionUser(data);
              } catch { /* non-critical */ }
            })();
          }
          setSessionChecked(true);
          return;
        }
      } catch { /* ignore */ }

    // ── Web: settle the restored session before rendering authed UI ──
    // (Runs inside the boot IIFE above so the desktop sanity check always
    // precedes it; `webCancelled` aliases the shared effect cancellation.)
      let webCancelled = cancelled;
      (async () => {
        try {
          const { fetchWithRetry } = await import('@/lib/fetch-with-retry');
          // Bounded wait: an unreachable/hanging API must never stall boot —
          // a network failure simply skips the check (offline tolerance).
          const signal = typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
            ? AbortSignal.timeout(6000)
            : undefined;
          const res = await fetchWithRetry('/api/auth/session', { skipAuthCheck: true, maxRetries: 0, signal });

          if (!webCancelled && res.ok) {
            const data = await res.json().catch(() => ({}));
            if (!data?.user) {
              // Session invalid per the server. A stale Bearer token poisons
              // every apiClient request (Authorization header wins over the
              // cookie), so the cookie may STILL be valid — try to re-mint
              // the session from the cookie alone before destroying it.
              const { healSessionFromCookie, applyHealedSession } = await import('@/lib/session-heal');
              const healed = await healSessionFromCookie();
              if (!webCancelled && healed) {
                console.log('[AuthProvider] Session reported invalid but cookie healed it — fresh token adopted');
                await applyHealedSession(healed);
                // Task 33-E — a healed session is a VALID session: clear any
                // stale revocation so sync/restore paths re-enable.
                clearRevoked();
              } else if (!webCancelled && useAppStore.getState().isAuthenticated) {
                const staleUser = useAppStore.getState().user;
                import('sonner').then(({ toast }) => {
                  toast.error(staleUser?.language === 'ar' ? 'انتهت الجلسة، يرجى تسجيل الدخول مجدداً' : staleUser?.language === 'fr' ? 'Session expirée, veuillez vous reconnecter' : 'Session expired, please log in again');
                });
                useAppStore.getState().logout();
              }
            } else if (!webCancelled) {
              // Task 33-E — the session validated successfully at boot: any
              // previously persisted revocation (e.g. a stale token that has
              // since been re-minted by the server) is fully recovered.
              clearRevoked();
            }
          }
          // !res.ok → server unreachable/offline → proceed WITHOUT logout
        } catch {
          // never block the app on the settle check
        } finally {
          if (!webCancelled) setSessionChecked(true);
        }
      })();
    })();

    return () => { cancelled = true; };
  }, [persistRehydrated]);

  // On initial load, read hash and set the appropriate view
  // BUT only if user is NOT authenticated (persist hasn't loaded a session)
  useEffect(() => {
    if (!persistRehydrated) return;
    if (typeof window === 'undefined') return;

    const hash = window.location.hash;
    const store = useAppStore.getState();

    // If user is authenticated from persisted state, update the hash to match
    // their current view instead of navigating away from it
    if (store.isAuthenticated && store.user) {
      // User is logged in — update the hash to match their current view
      // but also handle deep links (#/join/CODE, #/kiosk/CODE)
      if (hash) {
        const joinCode = parseJoinCodeFromHash(hash);
        if (joinCode) {
          setPendingAgencyCode(joinCode);
          // Navigate to customer-home to process the join code
          useAppStore.getState().setView('customer-home');
          return;
        }
        const kioskMatch = hash.match(/^#\/kiosk\/?(.*)$/);
        if (kioskMatch) {
          useAppStore.getState().setView('kiosk');
          return;
        }
      }
      // No deep link — just update the hash to match the persisted view
      updateHashForView(store.currentView);
      return;
    }

    // User is NOT authenticated — set view from hash for auth pages.
    // NATIVE SHELLS (mobile APK / desktop exe): an empty/'#/' hash (exactly
    // what the packaged WebView boots with) used to resolve to 'landing'
    // here — AFTER the store/page-level native redirect had already selected
    // the dedicated login — putting the mobile app back on the marketing
    // landing page. Native shells now boot to 'login' no matter what the
    // hash says (deep links like #/join/CODE still win below).
    if (hash) {
      const view = parseHashToView(hash);
      if (view) {
        const joinCode = parseJoinCodeFromHash(hash);
        if (joinCode) {
          setPendingAgencyCode(joinCode);
        }
        const isNativeShell =
          !!window.electronAPI ||
          !!(window as unknown as { Capacitor?: unknown }).Capacitor;
        if (isNativeShell && view === 'landing') {
          useAppStore.getState().setView('login');
          updateHashForView('login');
        } else {
          setViewFromHash(hash);
        }
      }
    } else if (currentView === 'login' || currentView === 'register') {
      // Web must always START on the landing page. A stale persisted
      // 'login'/'register' view (left over from an earlier visit to this
      // origin) used to make the site boot straight into the login screen —
      // correct for the native shells (Electron / Capacitor skip the
      // marketing landing) but wrong for browsers. This runs ONCE per page
      // load, so in-app navigation to login is untouched.
      const isNativeShell =
        !!window.electronAPI ||
        !!(window as unknown as { Capacitor?: unknown }).Capacitor;
      if (!isNativeShell) {
        useAppStore.getState().setView('landing');
      } else {
        updateHashForView(currentView);
      }
    } else if (currentView === 'landing') {
      const isNativeShell =
        !!window.electronAPI ||
        !!(window as unknown as { Capacitor?: unknown }).Capacitor;
      if (isNativeShell) {
        // Native shell booting with an empty hash — land on the dedicated
        // login screen, never the marketing landing page.
        useAppStore.getState().setView('login');
        updateHashForView('login');
      } else {
        updateHashForView(currentView);
      }
    } else {
      updateHashForView(currentView);
    }
  }, [persistRehydrated]);

  // Listen for browser back/forward via hashchange
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleHashChange = () => {
      if (isHashChangeSuppressed()) return;

      const hash = window.location.hash;
      const store = useAppStore.getState();

      // If user is authenticated, ignore hash changes to auth pages
      // (prevent navigating back to login while logged in)
      if (store.isAuthenticated && store.user) {
        if (hash) {
          const view = parseHashToView(hash);
          if (view) {
            // Allow deep links even when authenticated
            const joinCode = parseJoinCodeFromHash(hash);
            if (joinCode) {
              setPendingAgencyCode(joinCode);
              store.setView('customer-home');
              return;
            }
            const kioskMatch = hash.match(/^#\/kiosk\/?(.*)$/);
            if (kioskMatch) {
              store.setView('kiosk');
              return;
            }
            // Allow navigation between authenticated views
            const authViews = ['landing', 'login', 'register'];
            if (!authViews.includes(view) && view !== store.currentView) {
              setViewFromHash(hash);
            } else {
              // Ignore navigation to auth pages while logged in
              updateHashForView(store.currentView);
            }
          }
        }
        return;
      }

      // Not authenticated — allow hash navigation normally
      if (hash) {
        const view = parseHashToView(hash);
        if (view) {
          const joinCode = parseJoinCodeFromHash(hash);
          if (joinCode) {
            setPendingAgencyCode(joinCode);
          }
          const current = store.currentView;
          if (view !== current) {
            setViewFromHash(hash);
          }
        }
      } else {
        const current = store.currentView;
        if (current !== 'landing') {
          setViewFromHash('#/');
        }
      }
    };

    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, [setViewFromHash, setPendingAgencyCode]);

  // Show loading spinner while waiting for persist rehydration
  if (!sessionChecked) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-emerald-600" />
          <p className="text-sm text-muted-foreground animate-pulse">Loading...</p>
        </div>
      </div>
    );
  }

  // No SessionProvider needed — auth is managed entirely by Zustand + JWT session cookies.
  // The session is validated via /api/auth/session on the Hono backend.
  return <>{children}</>;
}
