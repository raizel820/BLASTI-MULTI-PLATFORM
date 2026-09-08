import { create } from 'zustand';
import api from '@/api/client';

interface SyncState {
  isOnline: boolean;
  isSyncing: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  pendingMutations: number;

  checkSyncStatus: () => Promise<void>;
  setOnline: (online: boolean) => void;
}

export const useSync = create<SyncState>((set) => ({
  isOnline: navigator.onLine,
  isSyncing: false,
  lastSyncAt: null,
  lastError: null,
  pendingMutations: 0,

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

  setOnline: (online: boolean) => {
    set({ isOnline: online });
  },
}));

// Listen for browser online/offline events
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => useSync.getState().setOnline(true));
  window.addEventListener('offline', () => useSync.getState().setOnline(false));
}
