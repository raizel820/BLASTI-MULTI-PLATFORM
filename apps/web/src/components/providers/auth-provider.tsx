'use client';

import { useEffect, useState } from 'react';
import { useAppStore, updateDocumentDirection, hydrateFromSession, setViewFromHash, parseHashToView, parseJoinCodeFromHash, updateHashForView, isHashChangeSuppressed } from '@/store/use-app-store';
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

    const store = useAppStore.getState();

    // Not authenticated — nothing to settle, render immediately.
    if (!store.isAuthenticated || !store.user) {
      setSessionChecked(true);
      return;
    }

    // ── Electron: Restore local API session on app reload, then render ──
    // When the Electron app restarts/reloads, the local API's sessionToken
    // is null (it's module-level state), but Zustand persist still has the
    // user + token. We need to re-import the session so LAN failover works.
    // (No cloud session check here — the desktop is local-first and has its
    // own auth machinery; see fetch-with-retry handleAuthExpired.)
    try {
      const w = window as any;
      if (w.electronAPI || navigator.userAgent.includes('Electron')) {
        const token = store.sessionToken || localStorage.getItem('blasti-local-api-token');
        if (token && store.user) {
          // 1. Restore via IPC bridge (direct)
          if (w.electronAPI?.setLocalApiSession) {
            w.electronAPI.setLocalApiSession({ token, user: store.user });
          }
          // 2. Also call HTTP import-session as backup
          fetch('http://127.0.0.1:3080/api/auth/import-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'omit',
            body: JSON.stringify({ token, user: store.user }),
          }).catch(() => { /* non-critical */ });
        }
        setSessionChecked(true);
        return;
      }
    } catch { /* ignore */ }

    // ── Web: settle the restored session before rendering authed UI ──
    let cancelled = false;
    (async () => {
      try {
        const { fetchWithRetry } = await import('@/lib/fetch-with-retry');
        // Bounded wait: an unreachable/hanging API must never stall boot —
        // a network failure simply skips the check (offline tolerance).
        const signal = typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
          ? AbortSignal.timeout(6000)
          : undefined;
        const res = await fetchWithRetry('/api/auth/session', { skipAuthCheck: true, maxRetries: 0, signal });

        if (!cancelled && res.ok) {
          const data = await res.json().catch(() => ({}));
          if (!data?.user) {
            // Session invalid per the server. A stale Bearer token poisons
            // every apiClient request (Authorization header wins over the
            // cookie), so the cookie may STILL be valid — try to re-mint
            // the session from the cookie alone before destroying it.
            const { healSessionFromCookie, applyHealedSession } = await import('@/lib/session-heal');
            const healed = await healSessionFromCookie();
            if (!cancelled && healed) {
              console.log('[AuthProvider] Session reported invalid but cookie healed it — fresh token adopted');
              await applyHealedSession(healed);
            } else if (!cancelled && useAppStore.getState().isAuthenticated) {
              const current = useAppStore.getState().user;
              import('sonner').then(({ toast }) => {
                toast.error(current?.language === 'ar' ? 'انتهت الجلسة، يرجى تسجيل الدخول مجدداً' : current?.language === 'fr' ? 'Session expirée, veuillez vous reconnecter' : 'Session expired, please log in again');
              });
              useAppStore.getState().logout();
            }
          }
        }
        // !res.ok → server unreachable/offline → proceed WITHOUT logout
      } catch {
        // never block the app on the settle check
      } finally {
        if (!cancelled) setSessionChecked(true);
      }
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

    // User is NOT authenticated — set view from hash for auth pages
    if (hash) {
      const view = parseHashToView(hash);
      if (view) {
        const joinCode = parseJoinCodeFromHash(hash);
        if (joinCode) {
          setPendingAgencyCode(joinCode);
        }
        setViewFromHash(hash);
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
