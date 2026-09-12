import { create } from 'zustand';
import api from '@/api/client';

interface User {
  id: string;
  username: string;
  fullName?: string;
  email?: string;
  role: string;
  agencyId: string;
  agencyName?: string;
}

interface AuthState {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;

  // Login source tracking
  loginSource: 'cloud' | 'offline' | null;
  offlineWarning: string | null;

  // Offline token awareness
  offlineTokenRemainingMs: number | null;
  isExpiringSoon: boolean;
  lastCloudContact: number | null;

  // Initial sync awareness
  needsInitialSync: boolean;
  initialSyncChecked: boolean;

  _offlineCheckInterval: ReturnType<typeof setInterval> | null;

  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  restoreSession: () => void;
  clearError: () => void;
  checkOfflineStatus: () => Promise<void>;
  startOfflineCheck: () => void;
  stopOfflineCheck: () => void;
  checkInitialSync: () => Promise<boolean>;
  setInitialSyncComplete: () => void;
}

export const useAuth = create<AuthState>((set, get) => ({
  user: null,
  token: null,
  isAuthenticated: false,
  isLoading: false,
  error: null,

  // Login source tracking
  loginSource: null,
  offlineWarning: null,

  // Offline token awareness
  offlineTokenRemainingMs: null,
  isExpiringSoon: false,
  lastCloudContact: null,

  // Initial sync awareness
  needsInitialSync: false,
  initialSyncChecked: false,

  _offlineCheckInterval: null,

  login: async (username: string, password: string) => {
    set({ isLoading: true, error: null });
    try {
      const result = await api.login(username, password);
      const user = result.user as User;
      set({
        user,
        token: result.token,
        isAuthenticated: true,
        isLoading: false,
        loginSource: result.source || null,
        offlineWarning: result.offlineWarning || null,
      });
      // Also store user info
      localStorage.setItem('blasti-user', JSON.stringify(user));
      // Notify Electron main process about cloud auth (for sync service)
      try {
        (window as any).electronAPI?.setCloudSyncAuth?.(result.token, user);
      } catch {}
      // Start periodic offline token check
      get().startOfflineCheck();
      // Check if initial sync is needed
      get().checkInitialSync();
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Login failed';
      set({ error, isLoading: false });
      throw err;
    }
  },

  logout: () => {
    get().stopOfflineCheck();
    api.setToken(null);
    localStorage.removeItem('blasti-user');
    localStorage.removeItem('blasti-local-api-token');
    // Notify the local API to clear its in-memory session
    fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    // Notify the Electron main process to clear cloud auth and persisted session file
    try {
      (window as any).electronAPI?.clearCloudSyncAuth?.();
      (window as any).electronAPI?.clearLocalApiSession?.();
    } catch {}
    set({ user: null, token: null, isAuthenticated: false, loginSource: null, offlineWarning: null, offlineTokenRemainingMs: null, isExpiringSoon: false, lastCloudContact: null, needsInitialSync: false, initialSyncChecked: false });
  },

  restoreSession: () => {
    const token = localStorage.getItem('blasti-local-api-token');
    const userJson = localStorage.getItem('blasti-user');
    if (token && userJson) {
      try {
        const user = JSON.parse(userJson) as User;
        api.setToken(token);
        set({ user, token, isAuthenticated: true });
      } catch {
        // Invalid stored data
        localStorage.removeItem('blasti-local-api-token');
        localStorage.removeItem('blasti-user');
      }
    }
  },

  clearError: () => set({ error: null }),

  checkOfflineStatus: async () => {
    try {
      // Use relative URL when on dev server (proxied), absolute when served by local API
      const baseUrl = window.location.port === '5173' || window.location.port === '3000' ? '' : 'http://127.0.0.1:3080';
      const resp = await fetch(`${baseUrl}/api/auth/session`, {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('blasti-local-api-token')}` }
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data.offline) {
          set({
            offlineTokenRemainingMs: data.offline.offlineTokenRemainingMs,
            isExpiringSoon: data.offline.isExpiringSoon || false,
            lastCloudContact: data.offline.lastCloudContact || null,
          });
          // Show warning if expiring soon
          if (data.offline.isExpiringSoon) {
            console.warn('[Auth] Offline token expiring soon:', data.offline);
          }
        }
      }
    } catch {
      // Non-critical — don't disrupt the app
    }
  },

  startOfflineCheck: () => {
    const state = get();
    if (state._offlineCheckInterval) return;
    // Check immediately, then every 5 minutes
    get().checkOfflineStatus();
    const interval = setInterval(() => get().checkOfflineStatus(), 5 * 60 * 1000);
    set({ _offlineCheckInterval: interval });
  },

  stopOfflineCheck: () => {
    const state = get();
    if (state._offlineCheckInterval) {
      clearInterval(state._offlineCheckInterval);
      set({ _offlineCheckInterval: null });
    }
  },

  checkInitialSync: async () => {
    try {
      const result = await api.getInitialSyncStatus();
      const needsSync = result.needsInitialSync === true;
      set({ needsInitialSync: needsSync, initialSyncChecked: true });
      return needsSync;
    } catch {
      // If we can't check, assume no initial sync needed
      // (the local DB might already have data from a previous session)
      set({ needsInitialSync: false, initialSyncChecked: true });
      return false;
    }
  },

  setInitialSyncComplete: () => {
    set({ needsInitialSync: false });
  },
}));
