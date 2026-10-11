/**
 * Task 82 — Notification sound settings (customer, mobile-first).
 *
 * Lets the customer pick WHAT the queue-call alert sounds like and HOW LOUD:
 *   • volume: 0–100 (%)
 *   • source: 'default' (BLASTI built-in chime) | 'custom' (a song/audio the
 *     customer picked from their phone via the file picker)
 *
 * Persistence:
 *   • settings → localStorage (`blasti-notification-sound-v1`)
 *   • custom audio blob → IndexedDB (`blasti-sounds` / `custom`, key
 *     `notification`) — songs are far too big for localStorage.
 *
 * The playing engine in lib/sounds.ts reads the shared live state here via
 * `getNotificationSoundEngineState()`; every mutation keeps that state in
 * sync so the next alert immediately uses the new sound/volume. All storage
 * access is defensive — a failed IndexedDB/localStorage must never break
 * the alert itself (it then just falls back to the default chime).
 */

export interface NotificationSoundSettings {
  /** 0–100 */
  volume: number;
  source: 'default' | 'custom';
}

export interface CustomSoundMeta {
  name: string;
}

const SETTINGS_KEY = 'blasti-notification-sound-v1';
const DB_NAME = 'blasti-sounds';
const DB_VERSION = 1;
const STORE_NAME = 'custom';
const BLOB_KEY = 'notification';
const META_KEY = 'notification-meta';

const DEFAULT_SETTINGS: NotificationSoundSettings = { volume: 100, source: 'default' };

function clampVolume(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  if (!Number.isFinite(n)) return DEFAULT_SETTINGS.volume;
  return Math.min(100, Math.max(0, Math.round(n)));
}

function readStoredSettings(): NotificationSoundSettings {
  if (typeof window === 'undefined') return { ...DEFAULT_SETTINGS };
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<NotificationSoundSettings>;
    return {
      volume: clampVolume(parsed.volume),
      source: parsed.source === 'custom' ? 'custom' : 'default',
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function writeStoredSettings(settings: NotificationSoundSettings): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* private mode — settings stay session-only */
  }
}

// ─── Live engine state (consumed by lib/sounds.ts) ──────────────────────────

export interface NotificationSoundEngineState {
  /** 0–1 for WebAudio gains / HTMLAudioElement.volume */
  volume: number;
  source: 'default' | 'custom';
  /** Object URL of the loaded custom audio (null when none/default). */
  customSoundUrl: string | null;
  customSoundName: string | null;
  /** 0..1 linear gain for an HTMLAudioElement (same as volume). */
}

let engineState: NotificationSoundEngineState = {
  volume: 1,
  source: 'default',
  customSoundUrl: null,
  customSoundName: null,
};

const listeners = new Set<() => void>();

export function getNotificationSoundEngineState(): NotificationSoundEngineState {
  return engineState;
}

export function subscribeNotificationSound(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publish(): void {
  listeners.forEach((fn) => {
    try {
      fn();
    } catch {
      /* listener errors never break the engine */
    }
  });
}

// ─── IndexedDB helpers (custom audio blob) ──────────────────────────────────

function openSoundDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
}

function idbGet<T>(db: IDBDatabase, key: string): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve((req.result as T) ?? null);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB get failed'));
  });
}

function idbSet(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB put failed'));
  });
}

function idbDelete(db: IDBDatabase, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB delete failed'));
  });
}

// ─── Init / mutations ────────────────────────────────────────────────────────

let initStarted = false;

/**
 * Load persisted settings + the custom audio blob into the live engine
 * state. Called once from lib/sounds.ts module init; safe to call again.
 */
export async function initNotificationSoundEngine(): Promise<void> {
  if (initStarted || typeof window === 'undefined') return;
  initStarted = true;

  const settings = readStoredSettings();
  engineState = {
    ...engineState,
    volume: settings.volume / 100,
    source: settings.source,
  };
  publish();

  if (settings.source !== 'custom') {
    // Keep the blob loaded anyway so toggling the source works instantly.
  }
  try {
    const db = await openSoundDb();
    const blob = await idbGet<Blob>(db, BLOB_KEY);
    const meta = await idbGet<CustomSoundMeta>(db, META_KEY);
    if (blob) {
      if (engineState.customSoundUrl) URL.revokeObjectURL(engineState.customSoundUrl);
      engineState = {
        ...engineState,
        customSoundUrl: URL.createObjectURL(blob),
        customSoundName: meta?.name ?? null,
      };
      publish();
    }
    db.close();
  } catch {
    /* no custom audio available — default chime remains */
  }
}

/** Update volume (0–100) and/or the active source. */
export function saveNotificationSoundSettings(next: Partial<NotificationSoundSettings>): NotificationSoundSettings {
  const merged = readStoredSettings();
  if (next.volume !== undefined) merged.volume = clampVolume(next.volume);
  if (next.source !== undefined) merged.source = next.source;
  // A custom source without a loaded sound falls back to the default chime.
  if (merged.source === 'custom' && !engineState.customSoundUrl) merged.source = 'default';
  writeStoredSettings(merged);
  engineState = { ...engineState, volume: merged.volume / 100, source: merged.source };
  publish();
  return merged;
}

/** Store a customer-picked audio file as the custom notification sound. */
export async function saveCustomNotificationSound(file: File): Promise<{ ok: boolean; error?: string }> {
  if (!file) return { ok: false, error: 'no-file' };
  if (!file.type.startsWith('audio/') && !/\.(mp3|ogg|wav|m4a|aac|flac|opus)$/i.test(file.name)) {
    return { ok: false, error: 'not-audio' };
  }
  // Hard cap — huge songs would blow the mobile storage budget.
  const MAX_BYTES = 8 * 1024 * 1024;
  if (file.size > MAX_BYTES) return { ok: false, error: 'too-large' };

  try {
    const db = await openSoundDb();
    await idbSet(db, BLOB_KEY, file);
    await idbSet(db, META_KEY, { name: file.name } satisfies CustomSoundMeta);
    db.close();
  } catch {
    return { ok: false, error: 'storage-failed' };
  }

  if (engineState.customSoundUrl) URL.revokeObjectURL(engineState.customSoundUrl);
  engineState = {
    ...engineState,
    customSoundUrl: URL.createObjectURL(file),
    customSoundName: file.name,
  };
  const settings = saveNotificationSoundSettings({ source: 'custom' });
  engineState = { ...engineState, source: settings.source };
  publish();
  return { ok: true };
}

/** Remove the custom sound and revert to the default chime. */
export async function clearCustomNotificationSound(): Promise<void> {
  try {
    const db = await openSoundDb();
    await idbDelete(db, BLOB_KEY);
    await idbDelete(db, META_KEY);
    db.close();
  } catch {
    /* best effort */
  }
  if (engineState.customSoundUrl) URL.revokeObjectURL(engineState.customSoundUrl);
  engineState = { ...engineState, customSoundUrl: null, customSoundName: null };
  saveNotificationSoundSettings({ source: 'default' });
  publish();
}

/** Current persisted settings (for UI display). */
export function getNotificationSoundSettings(): NotificationSoundSettings {
  const settings = readStoredSettings();
  // Reflect engine truth: a custom source without a playable sound is default.
  if (settings.source === 'custom' && !engineState.customSoundUrl) {
    return { ...settings, source: 'default' };
  }
  return settings;
}
