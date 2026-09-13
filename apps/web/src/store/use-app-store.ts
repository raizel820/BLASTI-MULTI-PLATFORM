import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Language } from '@/i18n';
import { isRTL } from '@/i18n';
import { apiFetch } from '@/lib/api-fetch';

export type UserRole = 'CUSTOMER' | 'AGENCY_STAFF' | 'AGENCY_OWNER' | 'SUPER_ADMIN';
export type ViewName =
  | 'landing'
  | 'login'
  | 'register'
  | 'customer-home'
  | 'customer-queue'
  | 'customer-history'
  | 'customer-notifications'
  | 'customer-profile'
  | 'customer-favorites'
  | 'customer-settings'
  | 'customer-sms-wallet'
  | 'agency-dashboard'
  | 'agency-settings'
  | 'agency-employees'
  | 'agency-profile'
  | 'agency-reviews'
  | 'agency-subscription'
  | 'agency-branches'
  | 'agency-devices'
  | 'admin-dashboard'
  | 'admin-transactions'
  | 'admin-agencies'
  | 'admin-audit'
  | 'admin-users'
  | 'admin-analytics'
  | 'admin-settings'
  | 'admin-subscription-plans'
  | 'admin-app-settings'
  | 'admin-hardware'
  | 'admin-hardware-requests'
  | 'admin-enterprise-requests'
  | 'kiosk'
  | 'agency-fullscreen'
  | 'agency-fullscreen-history';

interface UserState {
  id: string;
  username: string;
  fullName: string;
  role: UserRole;
  language: Language;
  avatarUrl?: string;
  agencyId?: string;
  agencyName?: string;
  agencyNameAr?: string;
  agencyNameFr?: string;
  phoneNumber?: string;
  freeSmsCount?: number;
  createdAt?: string;
}

interface AppState {
  // Auth
  user: UserState | null;
  isAuthenticated: boolean;
  sessionToken: string;

  // Navigation
  currentView: ViewName;
  previousView: ViewName | null;

  // UI
  sidebarOpen: boolean;

  // QR Code deep link
  pendingAgencyCode: string | null;

  // Onboarding
  onboarded: boolean;

  // Actions
  setUser: (user: UserState | null) => void;
  setSessionToken: (token: string) => void;
  setView: (view: ViewName) => void;
  goBack: () => void;
  toggleSidebar: () => void;
  logout: () => void;
  setPendingAgencyCode: (code: string | null) => void;
  setOnboarded: (v: boolean) => void;
}

// ─── Hash-based navigation helpers ─────────────────────────────────────────

const viewHashMap: Record<ViewName, string> = {
  'landing': '#/',
  'login': '#/login',
  'register': '#/register',
  'customer-home': '#/customer',
  'customer-queue': '#/customer/queue',
  'customer-history': '#/customer/history',
  'customer-notifications': '#/customer/notifications',
  'customer-profile': '#/customer/profile',
  'customer-favorites': '#/customer/favorites',
  'customer-settings': '#/customer/settings',
  'customer-sms-wallet': '#/customer/sms-wallet',
  'agency-dashboard': '#/agency',
  'agency-settings': '#/agency/settings',
  'agency-employees': '#/agency/employees',
  'agency-profile': '#/agency/profile',
  'agency-reviews': '#/agency/reviews',
  'agency-subscription': '#/agency/subscription',
  'agency-branches': '#/agency/branches',
  'agency-devices': '#/agency/devices',
  'admin-dashboard': '#/admin',
  'admin-transactions': '#/admin/transactions',
  'admin-agencies': '#/admin/agencies',
  'admin-audit': '#/admin/audit',
  'admin-users': '#/admin/users',
  'admin-analytics': '#/admin/analytics',
  'admin-settings': '#/admin/settings',
  'admin-subscription-plans': '#/admin/subscription-plans',
  'admin-app-settings': '#/admin/app-settings',
  'admin-hardware': '#/admin/hardware',
  'admin-hardware-requests': '#/admin/hardware-requests',
  'admin-enterprise-requests': '#/admin/enterprise-requests',
  'kiosk': '#/kiosk',
  'agency-fullscreen': '#/agency/fullscreen',
  'agency-fullscreen-history': '#/agency/fullscreen/history',
};

const hashViewMap: Record<string, ViewName> = Object.fromEntries(
  Object.entries(viewHashMap).map(([view, hash]) => [hash, view as ViewName])
);

// Prefix matches for views that share a base path
const prefixViewMap: [string, ViewName][] = [
  ['#/agency/fullscreen/history', 'agency-fullscreen-history'],
  ['#/agency/fullscreen', 'agency-fullscreen'],
];

let _suppressHashChange = false;

export function isHashChangeSuppressed(): boolean {
  return _suppressHashChange;
}

export function updateHashForView(view: ViewName): void {
  if (typeof window === 'undefined') return;
  const hash = viewHashMap[view] || '#/';
  _suppressHashChange = true;
  window.location.hash = hash;
  setTimeout(() => { _suppressHashChange = false; }, 50);
}

export function parseHashToView(hash: string): ViewName | null {
  // Handle #/join/CODE deep link
  const joinMatch = hash.match(/^#\/join\/(.+)$/);
  if (joinMatch) return 'customer-queue';

  // Handle #/kiosk/CODE deep link
  const kioskMatch = hash.match(/^#\/kiosk\/?(.*)$/);
  if (kioskMatch) {
    if (kioskMatch[1]) {
      try { localStorage.setItem('blasti-kiosk-agency-code', kioskMatch[1]); } catch {}
    }
    return 'kiosk';
  }

  // Exact match
  if (hashViewMap[hash]) return hashViewMap[hash];

  // Specific prefix matches (must check before generic prefix matches)
  for (const [prefix, view] of prefixViewMap) {
    if (hash.startsWith(prefix)) return view;
  }

  // Generic prefix match (e.g., #/customer/queue -> customer-queue)
  for (const [h, v] of Object.entries(hashViewMap)) {
    if (hash.startsWith(h) && h !== '#/') return v;
  }

  return hash === '#/' || hash === '' || hash === '#' ? 'landing' : null;
}

export function parseJoinCodeFromHash(hash: string): string | null {
  const match = hash.match(/^#\/join\/(.+)$/);
  return match ? match[1] : null;
}

// Set view from hash
export function setViewFromHash(hash: string): void {
  const view = parseHashToView(hash);
  if (view) {
    useAppStore.getState().setView(view);
  }
}

// Async hydrate from session (no-op placeholder since the store doesn't have real session hydration)
export async function hydrateFromSession(): Promise<void> {
  // Session hydration is handled by the persist middleware rehydration
}

// ─── Auth view detection ────────────────────────────────────────────────────

const AUTH_VIEWS: ViewName[] = ['landing', 'login', 'register'];

function isAuthView(view: ViewName): boolean {
  return AUTH_VIEWS.includes(view);
}

function getDefaultViewForRole(role: UserRole): ViewName {
  switch (role) {
    case 'SUPER_ADMIN': return 'admin-dashboard';
    case 'AGENCY_STAFF':
    case 'AGENCY_OWNER': return 'agency-dashboard';
    case 'CUSTOMER':
    default: return 'customer-home';
  }
}

// ─── State Sanitization (Phase 6b: Null Island Fix) ────────────────────────────

/** Set of all valid ViewName values for runtime validation */
const VALID_VIEW_NAMES: Set<string> = new Set<string>([
  'landing', 'login', 'register',
  'customer-home', 'customer-queue', 'customer-history', 'customer-notifications',
  'customer-profile', 'customer-favorites', 'customer-settings', 'customer-sms-wallet',
  'agency-dashboard', 'agency-settings', 'agency-employees', 'agency-profile',
  'agency-reviews', 'agency-subscription', 'agency-branches', 'agency-devices',
  'admin-dashboard', 'admin-transactions', 'admin-agencies', 'admin-audit',
  'admin-users', 'admin-analytics', 'admin-settings', 'admin-subscription-plans', 'admin-app-settings',
  'admin-hardware', 'admin-enterprise-requests',
  'admin-hardware-requests',
  'kiosk', 'agency-fullscreen', 'agency-fullscreen-history',
]);

/**
 * Validate that a value is a valid ViewName.
 * Returns the value if valid, otherwise falls back to 'landing'.
 */
function sanitizeViewName(view: unknown): ViewName {
  if (typeof view === 'string' && VALID_VIEW_NAMES.has(view)) {
    return view as ViewName;
  }
  return 'landing';
}

/**
 * Sanitize the user object by replacing NaN number fields with safe defaults.
 * Also ensures required string fields are actual strings (not null/undefined).
 */
function sanitizeUser(user: unknown): UserState | null {
  if (!user || typeof user !== 'object' || Array.isArray(user)) return null;
  const u = user as Record<string, unknown>;

  // Required string fields — must be non-empty strings
  const id = typeof u.id === 'string' && u.id ? u.id : '';
  const username = typeof u.username === 'string' && u.username ? u.username : '';
  const fullName = typeof u.fullName === 'string' && u.fullName ? u.fullName : '';
  const role = (
    typeof u.role === 'string' &&
    ['CUSTOMER', 'AGENCY_STAFF', 'AGENCY_OWNER', 'SUPER_ADMIN'].includes(u.role)
      ? u.role
      : 'CUSTOMER'
  ) as UserRole;
  const language = typeof u.language === 'string' && ['ar', 'fr', 'en'].includes(u.language) ? u.language : 'ar';

  // If any required field is empty, the user object is too corrupted to use
  if (!id || !username) return null;

  // Optional number field — replace NaN/null with undefined
  const freeSmsCount = typeof u.freeSmsCount === 'number' && !Number.isNaN(u.freeSmsCount)
    ? u.freeSmsCount
    : undefined;

  return {
    id,
    username,
    fullName,
    role,
    language: language as Language,
    avatarUrl: typeof u.avatarUrl === 'string' ? u.avatarUrl : undefined,
    agencyId: typeof u.agencyId === 'string' ? u.agencyId : undefined,
    agencyName: typeof u.agencyName === 'string' ? u.agencyName : undefined,
    agencyNameAr: typeof u.agencyNameAr === 'string' ? u.agencyNameAr : undefined,
    agencyNameFr: typeof u.agencyNameFr === 'string' ? u.agencyNameFr : undefined,
    phoneNumber: typeof u.phoneNumber === 'string' ? u.phoneNumber : undefined,
    freeSmsCount,
    createdAt: typeof u.createdAt === 'string' ? u.createdAt : undefined,
  };
}

/**
 * Ensure isAuthenticated is always a boolean, never null/undefined/NaN.
 */
function sanitizeIsAuthenticated(value: unknown): boolean {
  return value === true;
}

/**
 * Sanitize the entire persisted state, replacing NaN/null/corrupted values
 * with safe defaults. Used by both migrate and merge.
 */
function sanitizePersistedState(state: any): {
  user: UserState | null;
  isAuthenticated: boolean;
  currentView: ViewName;
  pendingAgencyCode: string | null;
  onboarded: boolean;
} {
  const user = sanitizeUser(state?.user);
  const isAuthenticated = sanitizeIsAuthenticated(state?.isAuthenticated);
  const currentView = sanitizeViewName(state?.currentView);
  const pendingAgencyCode = typeof state?.pendingAgencyCode === 'string' ? state.pendingAgencyCode : null;
  const onboarded = state?.onboarded === true;

  // If user is null but isAuthenticated is true, fix the inconsistency
  const safeIsAuthenticated = user ? isAuthenticated : false;

  // If user is not authenticated but currentView is a protected view, reset to landing
  const safeView = (!user && !isAuthView(currentView)) ? 'landing' : currentView;

  return {
    user,
    isAuthenticated: safeIsAuthenticated,
    currentView: safeView,
    pendingAgencyCode,
    onboarded,
  };
}

// ─── Store ──────────────────────────────────────────────────────────────────

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      user: null,
      isAuthenticated: false,
      sessionToken: '',
      currentView: 'landing',
      previousView: null,
      sidebarOpen: false,
      pendingAgencyCode: null,
      onboarded: false,

      setSessionToken: (token) => {
        set({ sessionToken: token });
        // Pass auth token to Electron main process for cloud sync
        const w = window as any;
        const currentUser = useAppStore.getState().user;
        if (w.electronAPI?.setCloudSyncAuth) {
          w.electronAPI.setCloudSyncAuth({ token, user: currentUser });
        }
        // CRITICAL: Also import session into the local API (port 3080)
        // so that when cloud goes down and LAN failover kicks in,
        // the local API accepts requests with this same token.
        // Without this, every offline request gets 401 → "Failed to load data"
        if (w.electronAPI?.setLocalApiSession && currentUser) {
          w.electronAPI.setLocalApiSession({ token, user: currentUser });
          // Also store in localStorage so buildAuthHeaders() can find it
          try { localStorage.setItem('blasti-local-api-token', token); } catch { /* ignore */ }
        } else if (w.electronAPI?.setLocalApiSession && !currentUser) {
          // User might not be set yet — schedule a retry after setState settles
          setTimeout(() => {
            const retryUser = useAppStore.getState().user;
            if (retryUser && w.electronAPI?.setLocalApiSession) {
              w.electronAPI.setLocalApiSession({ token, user: retryUser });
              try { localStorage.setItem('blasti-local-api-token', token); } catch { /* ignore */ }
            }
          }, 500);
        }
      },

      setUser: (user) => {
        const newView = user ? getDefaultViewForRole(user.role) : 'landing';
        set({
          user,
          isAuthenticated: !!user,
          currentView: newView,
          previousView: null,
        });
        // Sync hash after state update
        updateHashForView(newView);
      },

      setView: (view) => {
        set((state) => ({
          currentView: view,
          previousView: state.currentView,
          sidebarOpen: false,
        }));
        // Sync hash after state update
        updateHashForView(view);
      },

      goBack: () => {
        set((state) => {
          const newView = state.previousView || state.currentView;
          // Sync hash
          updateHashForView(newView);
          return {
            currentView: newView,
            previousView: null,
            sidebarOpen: false,
          };
        });
      },

      toggleSidebar: () =>
        set((state) => ({ sidebarOpen: !state.sidebarOpen })),

      setPendingAgencyCode: (code) => set({ pendingAgencyCode: code }),

      setOnboarded: (v: boolean) => set({ onboarded: v }),

      logout: () => {
        set({
          user: null,
          isAuthenticated: false,
          sessionToken: '',
          currentView: 'landing',
          previousView: null,
          sidebarOpen: false,
          pendingAgencyCode: null,
          onboarded: false,
        });
        // Clear Electron cloud sync auth on logout
        const w = window as any;
        if (w.electronAPI?.clearCloudSyncAuth) {
          w.electronAPI.clearCloudSyncAuth();
        }
        // Also clear local API session and token
        if (w.electronAPI?.clearLocalApiSession) {
          w.electronAPI.clearLocalApiSession();
        }
        try { localStorage.removeItem('blasti-local-api-token'); } catch { /* ignore */ }
        // Clear persisted storage AFTER set (persist middleware writes during set)
        // Also call the Hono backend logout endpoint to clear the JWT session cookie
        setTimeout(() => {
          if (typeof window !== 'undefined') {
            localStorage.removeItem('blasti-app');
            localStorage.removeItem('blasti-lang');
            // Clear the JWT session cookie by calling the backend logout endpoint
            apiFetch('/api/auth/logout', { method: 'POST' })
              .catch(() => { /* silent — best effort */ })
              .finally(() => { window.location.href = '/'; });
          }
        }, 100);
      },
    }),
    {
      name: 'blasti-app',
      // Bumped version to 3 to trigger clean rehydrate with fixed partialize
      version: 3,
      partialize: (state) => ({
        user: state.user,
        isAuthenticated: state.isAuthenticated,
        sessionToken: state.sessionToken,
        // BUG FIX: Always persist the actual currentView, not 'landing' for unauthenticated users.
        // The previous code was `state.user ? state.currentView : 'landing'` which caused
        // the persist middleware to override view changes (e.g., navigating to login/register)
        // because it would immediately write 'landing' to localStorage and then rehydrate it.
        currentView: state.currentView,
        pendingAgencyCode: state.pendingAgencyCode,
        onboarded: state.onboarded,
      }),
      // Deep merge with null safety — Phase 6b: sanitize persisted state to prevent
      // NaN/null/corrupted values from leaking into the live store.
      merge: (persistedState: any, currentState: AppState) => {
        if (!persistedState || typeof persistedState !== 'object') return currentState;
        // Sanitize the persisted state before merging to catch NaN, null, invalid views, etc.
        const sanitized = sanitizePersistedState(persistedState);
        return {
          ...currentState,
          ...sanitized,
        };
      },
      // Migrate from version 0/1/2 to version 3 — Phase 6b: uses sanitizePersistedState
      // to validate all fields including NaN number checks, ViewName validation, and
      // boolean enforcement for isAuthenticated.
      migrate: (persistedState: any, version: number) => {
        // Guard against null/corrupted persisted state
        if (!persistedState || typeof persistedState !== 'object' || Array.isArray(persistedState)) {
          return {
            user: null,
            isAuthenticated: false,
            currentView: 'landing',
            pendingAgencyCode: null,
            onboarded: false,
          };
        }

        // All versions now go through the same sanitization logic
        return sanitizePersistedState(persistedState);
      },
    }
  )
);

// Helper to get the persist API for clearing storage
if (useAppStore.persist) {
  useAppStore.persist.clearStorage = () => {
    if (typeof window !== 'undefined') {
      localStorage.removeItem('blasti-app');
      localStorage.removeItem('blasti-lang');
    }
  };
}













// Helper to set document direction
export function updateDocumentDirection(lang: Language) {
  if (typeof document !== 'undefined') {
    document.documentElement.dir = isRTL(lang) ? 'rtl' : 'ltr';
    document.documentElement.lang = lang;
  }
}
