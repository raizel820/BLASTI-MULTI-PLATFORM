import { create } from 'zustand';
import api from '@/api/client';

interface SyncState {
  isOnline: boolean;
  isSyncing: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  pendingMutations: number;

  // New fields
  lastSuccessfulSync: string | null;
  pendingMutationsCount: number;
  syncError: string | null;
  conflictsCount: number;

  checkSyncStatus: () => Promise<void>;
  fetchSyncStatus: () => Promise<void>;
  setOnline: (online: boolean) => void;
  startPeriodicCheck: () => () => void;
}

let periodicTimer: ReturnType<typeof setInterval> | null = null;

export const useSync = create<SyncState>((set, get) => ({
  isOnline: navigator.onLine,
  isSyncing: false,
  lastSyncAt: null,
  lastError: null,
  pendingMutations: 0,

  // New fields
  lastSuccessfulSync: null,
  pendingMutationsCount: 0,
  syncError: null,
  conflictsCount: 0,

  checkSyncStatus: async () => {
    try {
      const status = await api.getSyncStatus();
      set({
        isSyncing: (status as Record<string, unknown>).isSyncing as boolean || false,
        lastSyncAt: (status as Record<string, unknown>).lastSyncAt as string || null,
        lastError: (status as Record<string, unknown>).lastError as string || null,
        pendingMutations: (status as Record<string, unknown>).pendingMutations as number || 0,
      });
    } catch {
      // Sync status check failed - likely offline
    }
  },

  fetchSyncStatus: async () => {
    try {
      const status = await api.getSyncStatus() as Record<string, unknown>;
      set({
        isSyncing: (status.isSyncing as boolean) || false,
        lastSyncAt: (status.lastSyncAt as string) || null,
        lastError: (status.lastError as string) || null,
        pendingMutations: (status.pendingMutations as number) || 0,
        // New fields from enhanced API response
        lastSuccessfulSync: (status.lastSuccessfulSync as string) || null,
        pendingMutationsCount: (status.pendingMutationsCount as number) || 0,
        syncError: (status.syncError as string) || null,
        conflictsCount: (status.conflictsCount as number) || 0,
      });
    } catch {
      // Sync status check failed - likely offline; keep existing state
    }
  },

  setOnline: (online: boolean) => {
    set({ isOnline: online });
    // When coming back online, immediately fetch sync status
    if (online) {
      get().fetchSyncStatus();
    }
  },

  startPeriodicCheck: () => {
    // Clear any existing timer
    if (periodicTimer) {
      clearInterval(periodicTimer);
      periodicTimer = null;
    }

    // Fetch immediately
    get().fetchSyncStatus();

    // Set up 30-second polling
    periodicTimer = setInterval(() => {
      if (get().isOnline) {
        get().fetchSyncStatus();
      }
    }, 30_000);

    // Return cleanup function
    return () => {
      if (periodicTimer) {
        clearInterval(periodicTimer);
        periodicTimer = null;
      }
    };
  },
}));

// Listen for browser online/offline events
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => useSync.getState().setOnline(true));
  window.addEventListener('offline', () => useSync.getState().setOnline(false));
}
