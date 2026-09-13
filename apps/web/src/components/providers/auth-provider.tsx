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
        // After rehydration, we can check the actual auth state
        setPersistRehydrated(true);
        setSessionChecked(true);
      } else {
        // Not yet rehydrated — check again in 50ms
        setTimeout(checkRehydration, 50);
      }
    };
    // Start checking after a short delay to allow persist to kick in
    setTimeout(checkRehydration, 100);
  }, []);

  // Validate the JWT session with the server after persist rehydration
  useEffect(() => {
    if (!persistRehydrated) return;
    if (!isAuthenticated || !useAppStore.getState().user) return;

    // ── Electron: Restore local API session on app reload ──
    // When the Electron app restarts/reloads, the local API's sessionToken
    // is null (it's module-level state), but Zustand persist still has the
    // user + token. We need to re-import the session so LAN failover works.
    try {
      const w = window as any;
      if (w.electronAPI || navigator.userAgent.includes('Electron')) {
        const store = useAppStore.getState();
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
      }
    } catch { /* ignore */ }

    // Validate JWT session with the Hono backend (/api/auth/session)
    // Returns {user: {...}, expires: "..."} for valid sessions
    // and {} for expired/unauthenticated sessions
    (async () => {
      try {
        const { fetchWithRetry } = await import('@/lib/fetch-with-retry');
        const res = await fetchWithRetry('/api/auth/session', { skipAuthCheck: true });

        // Network/server error — don't clear session (user might be offline)
        if (!res.ok) return;

        const data = await res.json();
        // If session has no user object, the session is expired/invalid
        if (!data.user) {
          const store = useAppStore.getState();
          if (store.isAuthenticated) {
            import('sonner').then(({ toast }) => {
              toast.error(store.user?.language === 'ar' ? 'انتهت الجلسة، يرجى تسجيل الدخول مجدداً' : store.user?.language === 'fr' ? 'Session expirée, veuillez vous reconnecter' : 'Session expired, please log in again');
            });
            store.logout();
          }
        }
      } catch {
        // fetchWithRetry or JSON parse threw — don't clear session (might be offline)
      }
    })();
  }, [persistRehydrated, isAuthenticated]);

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
