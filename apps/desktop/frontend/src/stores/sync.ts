import { create } from 'zustand';
import api from '@/api/client';
import { apiFetch } from '@/lib/api-fetch';

// ─── Conflict item shape ─────────────────────────────────────────────────────

/**
 * Normalized conflict item — structurally compatible with
 * `ConflictItem` in components/shared/conflict-resolution-dialog.tsx.
 */
export interface SyncConflictItem {
  id: string;
  model: string;
  recordId: string;
  serverData: Record<string, unknown>;
  localData: Record<string, unknown>;
  timestamp: string;
  resolved?: boolean;
  resolution?: 'server' | 'local';
}

/** Shape of the raw rows produced by the sync service conflicts table. */
interface RawConflictRow {
  id?: string;
  model?: string;
  modelName?: string;
  recordId?: string;
  serverData?: unknown;
  cloudData?: unknown;
  localData?: unknown;
  timestamp?: string;
  createdAt?: string;
  resolved?: boolean;
  resolution?: string;
}

/**
 * Minimal shape of the Electron preload sync-conflict bridge
 * (preload.js: getSyncConflicts / resolveSyncConflict). Optional — the
 * renderer may run outside Electron (dev server) where the bridge is absent.
 */
interface SyncElectronBridge {
  getSyncConflicts?: () => Promise<unknown>;
  resolveSyncConflict?: (params: {
    conflictId: string;
    resolution: string;
  }) => Promise<{ success?: boolean; error?: string } | undefined>;
}

function getElectronBridge(): SyncElectronBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { electronAPI?: SyncElectronBridge }).electronAPI;
}

/**
 * Tolerant normalizer: maps raw `_sync_conflicts` rows (modelName/cloudData/
 * createdAt spelling used by local-api/sync-service.js `_logConflict`) OR
 * already-normalized items into the `SyncConflictItem` shape expected by
 * ConflictResolutionDialog.
 */
function normalizeConflict(raw: RawConflictRow, index: number): SyncConflictItem {
  const resolutionRaw = raw.resolution ?? '';
  const resolution =
    resolutionRaw === 'local' || resolutionRaw === 'local_kept'
      ? ('local' as const)
      : resolutionRaw === 'server' || resolutionRaw === 'cloud' || resolutionRaw === 'cloud_applied'
        ? ('server' as const)
        : undefined;

  const serverData =
    raw.serverData !== undefined && raw.serverData !== null && typeof raw.serverData === 'object'
      ? (raw.serverData as Record<string, unknown>)
      : {};
  const localData =
    raw.localData !== undefined && raw.localData !== null && typeof raw.localData === 'object'
      ? (raw.localData as Record<string, unknown>)
      : {};

  return {
    id: raw.id ?? `conflict_${index}`,
    model: raw.model ?? raw.modelName ?? 'Unknown',
    recordId: raw.recordId ?? '',
    serverData,
    localData,
    timestamp: raw.timestamp ?? raw.createdAt ?? new Date().toISOString(),
    resolved: Boolean(raw.resolved) || resolution !== undefined,
    resolution,
  };
}

function normalizeConflicts(raw: unknown): SyncConflictItem[] {
  const list = Array.isArray(raw)
    ? raw
    : raw !== null && typeof raw === 'object' && Array.isArray((raw as { conflicts?: unknown }).conflicts)
      ? (raw as { conflicts: unknown[] }).conflicts
      : [];
  return list.map((item, i) => normalizeConflict((item ?? {}) as RawConflictRow, i));
}

// ─── Sync status contract (GET /api/sync/status — desktop local API) ─────────

interface SyncState {
  // Legacy fields (kept — used by use-offline-aware-polling, use-notifications,
  // Sidebar, SyncStatusDetail, SyncIndicator)
  isOnline: boolean;
  isSyncing: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  pendingMutations: number;

  // Current GET /api/sync/status contract fields
  lastSuccessfulSync: string | null;
  lastCloudContactAt: string | null;
  pendingMutationsCount: number;
  abandonedMutationsCount: number;
  conflictsCount: number;
  offlineTokenRemainingMs: number | null;
  syncProtocolVersion: number | null;
  syncModelCount: number | null;
  syncError: string | null;

  // Conflicts (for ConflictResolutionDialog)
  conflicts: SyncConflictItem[];
  conflictsLoading: boolean;

  checkSyncStatus: () => Promise<void>;
  fetchSyncStatus: () => Promise<void>;
  setOnline: (online: boolean) => void;
  startPeriodicCheck: () => () => void;
  refreshConflicts: () => Promise<void>;
  resolveConflict: (id: string, resolution: 'server' | 'local') => Promise<void>;
}

let periodicTimer: ReturnType<typeof setInterval> | null = null;

/** Safe numeric coercion for API fields that may arrive as strings/null. */
function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Safe string coercion (empty string → null). */
function toNullableString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.length > 0 ? value : null;
}

export const useSync = create<SyncState>((set, get) => ({
  isOnline: navigator.onLine,
  isSyncing: false,
  lastSyncAt: null,
  lastError: null,
  pendingMutations: 0,

  lastSuccessfulSync: null,
  lastCloudContactAt: null,
  pendingMutationsCount: 0,
  abandonedMutationsCount: 0,
  conflictsCount: 0,
  offlineTokenRemainingMs: null,
  syncProtocolVersion: null,
  syncModelCount: null,
  syncError: null,

  conflicts: [],
  conflictsLoading: false,

  checkSyncStatus: async () => {
    try {
      const status = await api.getSyncStatus();
      const s = status as Record<string, unknown>;
      set({
        isSyncing: (s.isSyncing as boolean) || false,
        lastSyncAt: toNullableString(s.lastSyncAt),
        lastError: toNullableString(s.lastError),
        pendingMutations: (s.pendingMutations as number) || 0,
        // Keep the extended fields in sync too
        lastSuccessfulSync: toNullableString(s.lastSuccessfulSync),
        lastCloudContactAt: toNullableString(s.lastCloudContactAt),
        pendingMutationsCount: (s.pendingMutationsCount as number) || 0,
        abandonedMutationsCount: (s.abandonedMutationsCount as number) || 0,
        conflictsCount: (s.conflictsCount as number) || 0,
        offlineTokenRemainingMs: toNumber(s.offlineTokenRemainingMs),
        syncProtocolVersion: toNumber(s.syncProtocolVersion),
        syncModelCount: toNumber(s.syncModelCount),
        syncError: toNullableString(s.syncError),
      });
    } catch {
      // Sync status check failed - likely offline
    }
  },

  fetchSyncStatus: async () => {
    try {
      const status = (await api.getSyncStatus()) as Record<string, unknown>;
      set({
        isSyncing: (status.isSyncing as boolean) || false,
        lastSyncAt: toNullableString(status.lastSyncAt),
        lastError: toNullableString(status.lastError),
        pendingMutations: (status.pendingMutations as number) || 0,
        // Contract fields returned by GET /api/sync/status
        lastSuccessfulSync: toNullableString(status.lastSuccessfulSync),
        lastCloudContactAt: toNullableString(status.lastCloudContactAt),
        pendingMutationsCount: (status.pendingMutationsCount as number) || 0,
        abandonedMutationsCount: (status.abandonedMutationsCount as number) || 0,
        conflictsCount: (status.conflictsCount as number) || 0,
        offlineTokenRemainingMs: toNumber(status.offlineTokenRemainingMs),
        syncProtocolVersion: toNumber(status.syncProtocolVersion),
        syncModelCount: toNumber(status.syncModelCount),
        syncError: toNullableString(status.syncError),
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

  refreshConflicts: async () => {
    set({ conflictsLoading: true });
    try {
      // Preferred transport: Electron preload bridge (ipcRenderer →
      // 'sync:conflicts' → sync-service conflict store).
      const bridge = getElectronBridge();
      if (bridge?.getSyncConflicts) {
        const raw = await bridge.getSyncConflicts();
        set({ conflicts: normalizeConflicts(raw), conflictsLoading: false });
        return;
      }
      // Fallback: local API route (may not exist yet — handled gracefully).
      const res = await apiFetch('/api/sync/conflicts');
      if (res.ok) {
        const data: unknown = await res.json().catch(() => null);
        set({ conflicts: normalizeConflicts(data), conflictsLoading: false });
        return;
      }
      // Route missing / not authenticated — leave conflicts as-is.
      set({ conflictsLoading: false });
    } catch {
      set({ conflictsLoading: false });
    }
  },

  resolveConflict: async (id: string, resolution: 'server' | 'local') => {
    // Optimistically mark resolved in the store so the dialog reflects it
    set((state) => ({
      conflicts: state.conflicts.map((c) =>
        c.id === id ? { ...c, resolved: true, resolution } : c,
      ),
      conflictsCount: Math.max(0, state.conflictsCount - 1),
    }));
    try {
      const bridge = getElectronBridge();
      if (bridge?.resolveSyncConflict) {
        await bridge.resolveSyncConflict({ conflictId: id, resolution });
        return;
      }
      // Fallback: local API route (may not exist yet — non-fatal).
      await apiFetch('/api/sync/conflicts/resolve', {
        method: 'POST',
        body: JSON.stringify({ conflictId: id, resolution }),
      }).catch(() => undefined);
    } catch {
      // Resolution transport failed — optimistic UI state kept; the next
      // refreshConflicts() will reconcile with the sync service.
    }
  },
}));

// Listen for browser online/offline events
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => useSync.getState().setOnline(true));
  window.addEventListener('offline', () => useSync.getState().setOnline(false));
}
