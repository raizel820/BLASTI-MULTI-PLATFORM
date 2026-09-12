/**
 * useAppStore — Desktop shim for Web agency components.
 *
 * The Web components import `useAppStore` from `@/store/use-app-store`. This
 * Desktop shim provides the same interface so those components work unmodified,
 * but delegates auth concerns to the Desktop's existing `useAuth` store where
 * possible.
 *
 * Key differences from the Web store:
 *  - Auth state (`user`, `isAuthenticated`, `sessionToken`) is **derived**
 *    from the Desktop's `useAuth` Zustand store via `getState()` reads.
 *  - `pendingAgencyCode` is always `null` (no QR deep links on Desktop).
 *  - `logout()` delegates to the Desktop's `useAuth.logout()`.
 *  - Navigation uses `window.location.hash` (same as Web) so hash-based
 *    routing helpers (`updateHashForView`, `parseHashToView`, etc.) work
 *    identically.
 *  - `Language` and `isRTL` are defined locally (Desktop has no shared i18n
 *    module yet).
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { apiFetch } from '@/lib/api-fetch';

// ─── i18n types (now available via @/i18n) ────────────────────────────────────

export type Language = 'ar' | 'fr' | 'en';

const RTL_LANGUAGES: Set<string> = new Set(['ar']);

function isRTL(lang: Language): boolean {
  return RTL_LANGUAGES.has(lang);
}

// ─── Types ───────────────────────────────────────────────────────────────────

export type UserRole =
  | 'CUSTOMER'
  | 'AGENCY_STAFF'
  | 'AGENCY_OWNER'
  | 'SUPER_ADMIN';

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
  // Auth — derived from Desktop's useAuth store
  user: UserState | null;
  isAuthenticated: boolean;
  sessionToken: string;

  // Navigation
  currentView: ViewName;
  previousView: ViewName | null;

  // UI
  sidebarOpen: boolean;

  // QR Code deep link — always null on Desktop
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

// ─── Hash-based navigation helpers ───────────────────────────────────────────

const viewHashMap: Record<ViewName, string> = {
  landing: '#/',
  login: '#/login',
  register: '#/register',
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
  'admin-enterprise-requests': '#/admin/enterprise-requests',
  kiosk: '#/kiosk',
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
  setTimeout(() => {
    _suppressHashChange = false;
  }, 50);
}

export function parseHashToView(hash: string): ViewName | null {
  // Handle #/join/CODE deep link
  const joinMatch = hash.match(/^#\/join\/(.+)$/);
  if (joinMatch) return 'customer-queue';

  // Handle #/kiosk/CODE deep link
  const kioskMatch = hash.match(/^#\/kiosk\/?(.*)$/);
  if (kioskMatch) {
    if (kioskMatch[1]) {
      try {
        localStorage.setItem('blasti-kiosk-agency-code', kioskMatch[1]);
      } catch {}
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

// ─── Auth view detection ─────────────────────────────────────────────────────

const AUTH_VIEWS: ViewName[] = ['landing', 'login', 'register'];

function isAuthView(view: ViewName): boolean {
  return AUTH_VIEWS.includes(view);
}

function getDefaultViewForRole(role: UserRole): ViewName {
  switch (role) {
    case 'SUPER_ADMIN':
      return 'admin-dashboard';
    case 'AGENCY_STAFF':
    case 'AGENCY_OWNER':
      return 'agency-dashboard';
    case 'CUSTOMER':
    default:
      return 'customer-home';
  }
}

// ─── State Sanitization ──────────────────────────────────────────────────────

const VALID_VIEW_NAMES: Set<string> = new Set<string>([
  'landing',
  'login',
  'register',
  'customer-home',
  'customer-queue',
  'customer-history',
  'customer-notifications',
  'customer-profile',
  'customer-favorites',
  'customer-settings',
  'customer-sms-wallet',
  'agency-dashboard',
  'agency-settings',
  'agency-employees',
  'agency-profile',
  'agency-reviews',
  'agency-subscription',
  'agency-branches',
  'agency-devices',
  'admin-dashboard',
  'admin-transactions',
  'admin-agencies',
  'admin-audit',
  'admin-users',
  'admin-analytics',
  'admin-settings',
  'admin-subscription-plans',
  'admin-app-settings',
  'admin-enterprise-requests',
  'kiosk',
  'agency-fullscreen',
  'agency-fullscreen-history',
]);

function sanitizeViewName(view: unknown): ViewName {
  if (typeof view === 'string' && VALID_VIEW_NAMES.has(view)) {
    return view as ViewName;
  }
  return 'landing';
}

function sanitizeUser(user: unknown): UserState | null {
  if (!user || typeof user !== 'object' || Array.isArray(user)) return null;
  const u = user as Record<string, unknown>;

  const id = typeof u.id === 'string' && u.id ? u.id : '';
  const username = typeof u.username === 'string' && u.username ? u.username : '';
  const fullName = typeof u.fullName === 'string' && u.fullName ? u.fullName : '';
  const role =
    typeof u.role === 'string' &&
    ['CUSTOMER', 'AGENCY_STAFF', 'AGENCY_OWNER', 'SUPER_ADMIN'].includes(u.role)
      ? u.role
      : 'CUSTOMER';
  const language =
    typeof u.language === 'string' && ['ar', 'fr', 'en'].includes(u.language)
      ? u.language
      : 'ar';

  // If any required field is empty, the user object is too corrupted to use
  if (!id || !username) return null;

  const freeSmsCount =
    typeof u.freeSmsCount === 'number' && !Number.isNaN(u.freeSmsCount)
      ? u.freeSmsCount
      : undefined;

  return {
    id,
    username,
    fullName,
    role: role as UserRole,
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

function sanitizeIsAuthenticated(value: unknown): boolean {
  return value === true;
}

function sanitizePersistedState(
  state: unknown
): {
  user: UserState | null;
  isAuthenticated: boolean;
  currentView: ViewName;
  pendingAgencyCode: string | null;
  onboarded: boolean;
} {
  const s = state as Record<string, unknown> | null;
  const user = sanitizeUser(s?.user);
  const isAuthenticated = sanitizeIsAuthenticated(s?.isAuthenticated);
  const currentView = sanitizeViewName(s?.currentView);
  const pendingAgencyCode =
    typeof s?.pendingAgencyCode === 'string' ? s.pendingAgencyCode : null;
  const onboarded = s?.onboarded === true;

  // If user is null but isAuthenticated is true, fix the inconsistency
  const safeIsAuthenticated = user ? isAuthenticated : false;

  // If user is not authenticated but currentView is a protected view, reset to landing
  const safeView = !user && !isAuthView(currentView) ? 'landing' : currentView;

  return {
    user,
    isAuthenticated: safeIsAuthenticated,
    currentView: safeView,
    pendingAgencyCode,
    onboarded,
  };
}

// ─── Desktop auth store bridge ───────────────────────────────────────────────
// Lazily import the Desktop's useAuth store so we can delegate auth reads.
// We use a dynamic getter to avoid circular-import issues at module init time.

let _useAuth: typeof import('@/stores/auth').useAuth | null = null;

function getAuthStore() {
  if (!_useAuth) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      _useAuth = require('@/stores/auth').useAuth;
    } catch {
      // Fallback: try a dynamic import path (won't work synchronously, but
      // the store is designed to degrade gracefully when auth is unavailable)
    }
  }
  return _useAuth;
}

/**
 * Read the current auth token from localStorage (same source as the Desktop
 * API client). This is used instead of `useAuth.getState().token` to avoid
 * timing issues during store rehydration.
 */
function readSessionTokenFromStorage(): string {
  try {
    return localStorage.getItem('blasti-local-api-token') ?? '';
  } catch {
    return '';
  }
}

/**
 * Attempt to read user data from localStorage (the Desktop auth store
 * persists it under 'blasti-user').
 */
function readUserFromStorage(): UserState | null {
  try {
    const json = localStorage.getItem('blasti-user');
    if (json) {
      return sanitizeUser(JSON.parse(json));
    }
  } catch {}
  return null;
}

// ─── Desktop logout delegate ─────────────────────────────────────────────────

function desktopLogout(): void {
  // Try the Desktop auth store first (full logout flow)
  const authStore = getAuthStore();
  if (authStore) {
    try {
      authStore.getState().logout();
      return;
    } catch {}
  }

  // Fallback: manually clear the same keys the Desktop auth store clears
  try {
    localStorage.removeItem('blasti-local-api-token');
    localStorage.removeItem('blasti-user');
  } catch {}

  // Best-effort: notify the local API to clear its session
  apiFetch('/api/auth/logout', { method: 'POST' }).catch(() => {});

  // Also notify the Electron main process (if running)
  try {
    (window as unknown as Record<string, unknown>).electronAPI &&
      (
        (window as unknown as Record<string, Record<string, () => void>>)
          .electronAPI as Record<string, () => void>
      ).clearCloudSyncAuth?.();
    (window as unknown as Record<string, Record<string, () => void>>)
      .electronAPI?.clearLocalApiSession?.();
  } catch {}

  // Redirect to login
  if (typeof window !== 'undefined') {
    window.location.href = '/login';
  }
}

// ─── Store ───────────────────────────────────────────────────────────────────

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      // Auth — derived from Desktop auth store / localStorage
      user: readUserFromStorage(),
      isAuthenticated: !!readSessionTokenFromStorage(),
      sessionToken: readSessionTokenFromStorage(),

      // Navigation
      currentView: 'landing',
      previousView: null,

      // UI
      sidebarOpen: false,

      // QR Code deep link — always null on Desktop (no QR scanner)
      pendingAgencyCode: null,

      // Onboarding
      onboarded: false,

      setSessionToken: (token: string) => {
        set({ sessionToken: token });
        // Also sync to the Desktop API client's token store
        try {
          if (token) {
            localStorage.setItem('blasti-local-api-token', token);
          } else {
            localStorage.removeItem('blasti-local-api-token');
          }
        } catch {}
      },

      setUser: (user: UserState | null) => {
        const newView = user ? getDefaultViewForRole(user.role) : 'landing';
        set({
          user,
          isAuthenticated: !!user,
          currentView: newView,
          previousView: null,
          // Derive sessionToken from localStorage when setting user
          sessionToken: readSessionTokenFromStorage(),
        });
        // Sync hash after state update
        updateHashForView(newView);
      },

      setView: (view: ViewName) => {
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

      setPendingAgencyCode: (_code: string | null) => {
        // No-op on Desktop — QR deep links are not supported
        set({ pendingAgencyCode: null });
      },

      setOnboarded: (v: boolean) => set({ onboarded: v }),

      logout: () => {
        // Reset all local state first
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

        // Delegate to the Desktop's full logout flow
        // Use setTimeout to let persist middleware write the reset state first
        setTimeout(() => {
          if (typeof window !== 'undefined') {
            localStorage.removeItem('blasti-desktop-app');
            localStorage.removeItem('blasti-lang');
          }
          desktopLogout();
        }, 100);
      },
    }),
    {
      name: 'blasti-desktop-app',
      version: 1,
      partialize: (state) => ({
        user: state.user,
        isAuthenticated: state.isAuthenticated,
        sessionToken: state.sessionToken,
        currentView: state.currentView,
        pendingAgencyCode: state.pendingAgencyCode,
        onboarded: state.onboarded,
      }),
      merge: (persistedState: unknown, currentState: AppState) => {
        if (!persistedState || typeof persistedState !== 'object')
          return currentState;
        const sanitized = sanitizePersistedState(persistedState);
        return {
          ...currentState,
          ...sanitized,
        };
      },
      migrate: (persistedState: unknown, version: number) => {
        if (
          !persistedState ||
          typeof persistedState !== 'object' ||
          Array.isArray(persistedState)
        ) {
          return {
            user: null,
            isAuthenticated: false,
            currentView: 'landing',
            pendingAgencyCode: null,
            onboarded: false,
          };
        }
        // All versions go through the same sanitization logic
        return sanitizePersistedState(persistedState);
      },
    }
  )
);

// ─── Persist API helpers ─────────────────────────────────────────────────────

if (useAppStore.persist) {
  useAppStore.persist.clearStorage = () => {
    if (typeof window !== 'undefined') {
      localStorage.removeItem('blasti-desktop-app');
      localStorage.removeItem('blasti-lang');
    }
  };
}

// ─── Document direction helper ───────────────────────────────────────────────

export function updateDocumentDirection(lang: Language): void {
  if (typeof document !== 'undefined') {
    document.documentElement.dir = isRTL(lang) ? 'rtl' : 'ltr';
    document.documentElement.lang = lang;
  }
}

// ─── Async hydrate from session ──────────────────────────────────────────────

/**
 * Re-read auth state from localStorage / the Desktop auth store and sync it
 * into this store. Call this after the Desktop auth store has restored its
 * session (e.g. on app startup).
 */
export async function hydrateFromSession(): Promise<void> {
  const token = readSessionTokenFromStorage();
  const user = readUserFromStorage();

  if (token && user) {
    useAppStore.setState({
      user,
      isAuthenticated: true,
      sessionToken: token,
      currentView: getDefaultViewForRole(user.role),
    });
  } else {
    useAppStore.setState({
      user: null,
      isAuthenticated: false,
      sessionToken: '',
    });
  }
}
