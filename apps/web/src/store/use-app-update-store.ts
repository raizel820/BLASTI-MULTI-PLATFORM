'use client';

/**
 * App-update delivery store (Public App Settings rebuild).
 *
 * One state machine for BOTH native shells:
 *   • Electron (desktop) → main-process IPC: checkForUpdates / downloadUpdate
 *     (progress events) / installUpdate (quit + silent NSIS install)
 *   • Capacitor (Android) → BlastiNativeStatus plugin: getAppInfo (real
 *     versionName) / getNetworkInfo (Wi-Fi) / downloadUpdate (system
 *     DownloadManager, polled) / installUpdate (package-installer intent)
 *   • Plain web → no self-update (the VPS serves the latest web bundle);
 *     every check() call no-ops.
 *
 * Update-check triggers (per product spec):
 *   - every app opening (AppUpdateManager mounts → 'startup')
 *   - after a sync cycle (BootGate release → 'sync')
 *   - manual "Check for updates" (sidebar / More sheet / settings → 'manual')
 *
 * Mandatory updates block the ENTIRE app (full-screen gate) until installed;
 * optional updates show a dialog with "Update later" — afterwards every
 * manual-check button turns into "Update now".
 *
 * Check API: PUBLIC GET /api/app-versions/check?platform=&version= (also fed
 * by pushed update:available IPC events from device telemetry check-ins).
 */

import { create } from 'zustand';
import { buildCloudUrl } from '@/lib/api-client';
import { APP_API_LEVEL } from '@/lib/api-level';
import {
  loadAppUpdateSettings,
  loadPostponedVersion,
  savePostponedVersion,
} from '@/lib/app-update-settings';

// ─── Types ───────────────────────────────────────────────────────────────────

export type AppUpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error';

export interface AppUpdateInfo {
  version: string;
  currentVersion: string;
  isMandatory: boolean;
  /** Relative downloadUrl exactly as the API returns it (main resolves it). */
  downloadUrl: string;
  /** Absolute URL for the Capacitor DownloadManager (resolved against cloud). */
  absoluteDownloadUrl: string;
  releaseNotes?: string;
  releaseNotesAr?: string;
  releaseNotesFr?: string;
  fileSize: number;
  /** sha256 of the full installer/APK — the main process verifies after download. */
  fileHash?: string;
  pushMessage?: string;
  pushMessageAr?: string;
  pushMessageFr?: string;
  /**
   * DELTA UPDATES (0.6.30) — differential hop chain offered by /check.
   * Desktop: release patches applied onto app.asar + the out tree. Android:
   * raw APK binary-deltas applied onto the installed base.apk. Absent/null →
   * full installer (the always-correct fallback).
   */
  delta?: DeltaManifest | null;
  /**
   * API COMPATIBILITY MAP (0.6.31) — can this app run against the current
   * server, which functions need a newer app, and is the newest release
   * server-only (apps keep running). Absent on older servers.
   */
  compat?: CompatEvaluation | null;
}

export interface DeltaHop {
  id: string;
  kind: string;
  fromVersion: string;
  toVersion: string;
  url: string;
  size: number;
  sha256: string;
  fromArtifactHash: string;
  toArtifactHash: string;
}

export interface DeltaManifest {
  supported: boolean;
  kind: string;
  runtimeKey: string;
  nativeFingerprint: string;
  targetAsarSha256: string;
  targetApkSha256: string;
  totalSize: number;
  hops: DeltaHop[];
}

export interface AppUpdateProgress {
  percent: number;
  receivedBytes: number;
  totalBytes: number;
}

type Shell = 'electron' | 'capacitor' | 'web';

interface ElectronUpdatesAPI {
  getAppVersion?: () => Promise<string>;
  checkForUpdates?: () => Promise<CheckResponse>;
  downloadUpdate?: (payload: { url: string; version: string; fileHash?: string; fileSize?: number }) => Promise<unknown>;
  installUpdate?: () => Promise<{ ok?: boolean; error?: string }>;
  /** 0.6.30 — download+apply the delta chain (asar + tree patches). */
  installDeltaUpdate?: (payload: { hops: DeltaHop[]; target: { version: string; asarSha256: string } }) => Promise<{ ok?: boolean; error?: string; version?: string; pendingBootSwap?: boolean }>;
  /** 0.6.30 — relaunch after a successful delta apply (new asar loads). */
  relaunchAfterDelta?: () => Promise<{ ok?: boolean }>;
  /** 0.6.30 — fired when the NSIS install could not even be started. */
  onUpdateInstallFailed?: (cb: (payload: { error: string }) => void) => () => void;
  /** 0.6.30 manual fallback — open the downloaded installer with the OS. */
  openDownloadedInstaller?: () => Promise<{ ok?: boolean; error?: string }>;
  getNetworkInfo?: () => Promise<{ isWifi?: boolean }>;
  onUpdateProgress?: (cb: (payload: UpdateProgressEvent) => void) => () => void;
  onUpdateAvailable?: (cb: (payload: PushPayload) => void) => void;
}

interface UpdateProgressEvent {
  status: 'downloading' | 'downloaded' | 'error';
  percent?: number;
  receivedBytes?: number;
  totalBytes?: number;
  error?: string;
  version?: string;
  /** 0.6.30 — delta pipeline stage (download / apply-asar-n / apply-tree-n / swap-asar). */
  stage?: string;
}

interface PushPayload {
  version?: string;
  currentVersion?: string;
  isMandatory?: boolean;
  releaseNotes?: string;
  releaseNotesAr?: string;
  releaseNotesFr?: string;
  downloadUrl?: string;
  fileSize?: number;
  push?: { message?: string; messageAr?: string; messageFr?: string; isMandatory?: boolean } | null;
}

interface CheckResponse {
  success?: boolean;
  updateAvailable?: boolean;
  isMandatory?: boolean;
  latestVersion?: string;
  currentVersion?: string;
  downloadUrl?: string;
  releaseNotes?: string;
  releaseNotesAr?: string;
  releaseNotesFr?: string;
  fileSize?: number;
  fileHash?: string;
  delta?: DeltaManifest | null;
  /** 0.6.36 — why no delta was offered (diagnostic only; absent when one was). */
  deltaUnavailable?: { reason: string; edges?: number; hopBases?: string[] } | null;
  /** 0.6.31 — API compatibility map evaluation (absent on older servers). */
  compat?: CompatEvaluation | null;
}

/** Shape of the server's compat block (apps/api/src/lib/api-compat.ts). */
export interface CompatFeatureGate {
  feature: string;
  severity: 'critical' | 'soft' | 'server';
  minAppVersion: string;
  apiLevel: number;
  description: string;
  descriptionAr?: string | null;
  descriptionFr?: string | null;
}

export interface CompatEvaluation {
  serverVersion: string;
  serverApiLevel: number;
  appVersion: string;
  appApiLevel: number | null;
  /** The app can run against this server (nothing critical pending). */
  compatible: boolean;
  /** Update ABSOLUTELY required — the app is blocked until it updates. */
  updateRequired: boolean;
  /** Update available AND app-facing — recommended. */
  updateRecommended: boolean;
  /** The newest release only changes the server — apps keep running. */
  serverOnlyUpdate: boolean;
  updateAvailable: boolean;
  latestVersion: string;
  latestServerOnly: boolean;
  blockedFeatures: CompatFeatureGate[];
  serverOnlyChanges: string[];
  summary: string;
  summaryAr: string;
  summaryFr: string;
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  Plugins?: Record<string, {
    getAppInfo?: () => Promise<{ versionName?: string; versionCode?: number }>;
    getNetworkInfo?: () => Promise<{ isWifi?: boolean; isUnmetered?: boolean; connectionType?: string }>;
    downloadUpdate?: (opts: { url: string; version?: string }) => Promise<{ downloadId?: number }>;
    getDownloadProgress?: (opts: { downloadId: number }) => Promise<{
      status?: string; percent?: number; bytesSoFar?: number; totalBytes?: number; localUri?: string;
    }>;
    installUpdate?: (opts: { downloadId?: number; filePath?: string }) => Promise<{ ok?: boolean; escalated?: boolean }>;
    /**
     * DELTA UPDATES (0.6.30) — download every APK hop patch, apply the chain
     * onto the installed base.apk, verify the final sha256, stage the result
     * for install. Returns { ok, apkPath? } or { ok:false, error }.
     */
    installDeltaUpdate?: (opts: {
      deltas: Array<{ url: string; sha256: string; fromVersion: string; toVersion: string; fromArtifactHash?: string }>;
      finalSha256: string;
      fromVersion: string;
      toVersion: string;
    }) => Promise<{ ok?: boolean; apkPath?: string; error?: string }>;
    /** Open the system "Install unknown apps" grant screen (newer builds). */
    openInstallPermissionSettings?: () => Promise<{ ok?: boolean; canInstall?: boolean }>;
    /**
     * 0.6.17 side-effect-free permission probe — { canInstall }. Lets the web
     * layer read the grant state WITHOUT opening the settings screen (the
     * old read-path WAS "open settings", half of the field redirect loop).
     * The Android install RESUME itself is owned by the native
     * handleOnResume (pending APK + granted → installer auto-launches).
     */
    getInstallPermissionState?: () => Promise<{ canInstall?: boolean }>;
  }>;
}

export interface AppUpdateState {
  status: AppUpdateStatus;
  info: AppUpdateInfo | null;
  progress: AppUpdateProgress | null;
  error: string | null;
  needsInstallPermission: boolean;
  /** Version the user postponed with "Update later" (drives "Update now"). */
  postponedVersion: string | null;
  lastCheckAt: number;
  checking: boolean;
  /** True when the LAST check could not reach the cloud (manual toast picks). */
  lastCheckFailed: boolean;
  /** User opened the optional-update dialog via a manual button (Update now). */
  dialogRequested: boolean;
  /** 0.6.30 — the applied update was a DELTA chain (install = relaunch, not NSIS). */
  deltaApplied: boolean;
  /** 0.6.30 — NSIS/APK install could not even start → UI offers manual open. */
  manualInstallAvailable: boolean;

  check: (trigger: 'startup' | 'sync' | 'manual' | 'resume' | 'push') => Promise<boolean>;
  startDownload: () => Promise<void>;
  install: () => Promise<void>;
  /**
   * 0.6.30 — the NSIS launcher failed everywhere; open the downloaded
   * installer with the OS handler so the user can run it manually.
   */
  openInstallerManually: () => Promise<void>;
  /**
   * Android honesty gate: after the package installer closes, compare the
   * native versionName against the one recorded when install() handed the
   * APK to the OS. 'updated' → the install really happened; 'not-installed'
   * → Android silently refused it (signature mismatch is the classic case)
   * and the user must be TOLD (uninstall + reinstall once) instead of the
   * app claiming success. Null when no install is pending / not Android.
   */
  resolvePendingInstall: () => Promise<'updated' | 'not-installed' | null>;
  postpone: () => void;
  requestDialog: () => void;
  closeDialog: () => void;
  applyProgress: (payload: UpdateProgressEvent) => void;
  ingestPushPayload: (payload: PushPayload) => Promise<void>;
  clearError: () => void;
  resetNeedsPermission: () => void;
}

// ─── Shell helpers ───────────────────────────────────────────────────────────

function electronAPI(): ElectronUpdatesAPI | null {
  if (typeof window === 'undefined') return null;
  return ((window as unknown as Record<string, unknown>).electronAPI as ElectronUpdatesAPI) ?? null;
}

function capacitor(): CapacitorGlobal | null {
  if (typeof window === 'undefined') return null;
  const cap = (window as unknown as Record<string, unknown>).Capacitor as CapacitorGlobal | undefined;
  return cap?.isNativePlatform?.() ? cap : null;
}

function plugin(): NonNullable<CapacitorGlobal['Plugins']>[string] | null {
  return capacitor()?.Plugins?.BlastiNativeStatus ?? null;
}

function currentShell(): Shell {
  if (electronAPI()) return 'electron';
  if (capacitor()) {
    // Only Android has a sideload update path — iOS has none (App Store).
    return capacitor()?.getPlatform?.() === 'android' ? 'capacitor' : 'web';
  }
  // Dev/preview override (same key the PlatformSwitcher uses): lets the
  // update UI be exercised in a plain browser against the real /check API.
  try {
    if (process.env.NODE_ENV !== 'production' && typeof localStorage !== 'undefined'
      && window.localStorage.getItem('blasti-platform-override') === 'electron') return 'electron';
  } catch { /* no storage */ }
  return 'web';
}

/** Map the detected desktop OS to the API platform channel. */
function desktopPlatform(): string {
  if (typeof navigator === 'undefined') return 'windows';
  const ua = navigator.userAgent;
  if (ua.includes('Windows')) return 'windows';
  if (ua.includes('Mac')) return 'mac';
  return 'linux';
}

async function isWifiConnection(): Promise<boolean> {
  try {
    if (currentShell() === 'electron') {
      const info = await electronAPI()?.getNetworkInfo?.();
      return info?.isWifi !== false; // unknown → never block
    }
    if (currentShell() === 'capacitor') {
      const info = await plugin()?.getNetworkInfo?.();
      return info?.isWifi !== false; // unknown → never block
    }
    const conn = (typeof navigator !== 'undefined' ? (navigator as unknown as { connection?: { type?: string; effectiveType?: string } }).connection : undefined);
    if (conn?.type) return conn.type === 'wifi' || conn.type === 'ethernet';
    return true; // unknown → never block
  } catch {
    return true;
  }
}

/** Minimum spacing between AUTOMATIC checks (manual always goes through). */
const AUTO_CHECK_THROTTLE_MS = 60_000;

async function fetchCheck(platform: string, version: string): Promise<CheckResponse | null> {
  try {
    const res = await fetch(buildCloudUrl('/api/app-versions/check', { platform, version, apiLevel: String(APP_API_LEVEL) }), {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    return (await res.json()) as CheckResponse;
  } catch {
    return null;
  }
}

// ─── Android download polling ────────────────────────────────────────────────

/**
 * 0.6.18 ROOT-CAUSE FIX for the update-install loop (field log: 5×
 * {"message":"apk-not-found"} per attempt): install() used to call the native
 * plugin with installUpdate({}) — NO downloadId, NO filePath — so the native
 * side queried the DownloadManager with id=-1, found zero rows and rejected
 * "apk-not-found" BEFORE its 0.6.17 permission ladder was ever reached. The
 * ladder was dead code; the store then mislabeled the failure as "downloaded +
 * needsInstallPermission" and every trigger re-offered the install forever.
 * The downloadId returned by downloadUpdate is now REMEMBERED HERE and handed
 * to installUpdate. (The native side also gained a deterministic-path fallback
 * for process restarts / old callers.)
 */
let lastAndroidDownloadId: number | null = null;

/** 0.6.30 — local path of the delta-rebuilt APK handed to installUpdate. */
let lastAndroidDeltaPath: string | null = null;

let androidPollTimer: ReturnType<typeof setInterval> | null = null;

function stopAndroidPolling() {
  if (androidPollTimer) {
    clearInterval(androidPollTimer);
    androidPollTimer = null;
  }
}

function startAndroidPolling(downloadId: number) {
  stopAndroidPolling();
  androidPollTimer = setInterval(async () => {
    try {
      const res = await plugin()?.getDownloadProgress?.({ downloadId });
      if (!res) return;
      if (res.status === 'successful') {
        stopAndroidPolling();
        getStore().setState({ status: 'downloaded', progress: { percent: 100, receivedBytes: res.bytesSoFar ?? 0, totalBytes: res.totalBytes ?? 0 } });
        void maybeAutoInstall();
      } else if (res.status === 'failed') {
        stopAndroidPolling();
        getStore().setState({ status: 'error', error: 'download-failed' });
      } else if (res.status === 'running' || res.status === 'pending' || res.status === 'paused') {
        getStore().setState({
          status: 'downloading',
          progress: {
            percent: res.percent ?? 0,
            receivedBytes: res.bytesSoFar ?? 0,
            totalBytes: res.totalBytes ?? 0,
          },
        });
      }
    } catch {
      /* transient query failure — keep polling */
    }
  }, 1200);
}

// Module-level access for the polling closure (created before the store).
let storeInstance: ReturnType<typeof createAppUpdateStore> | null = null;
function getStore() {
  return storeInstance as unknown as { setState: (partial: Partial<AppUpdateState>) => void };
}

// ─── Android install honesty gate ─────────────────────────────────────────

/**
 * The native versionName captured when install() handed the APK to the
 * package installer. The installer UI is asynchronous and FIRE-AND-FORGET
 * from the app's perspective — installUpdate() resolving ok:true only means
 * "the installer opened", NOT "the update installed". When Android refuses
 * the APK (signature mismatch is the classic case — an APK built by a
 * different keystore than the installed build), it silently shows "App not
 * installed" and the old version stays. Comparing the version on the next
 * resume is the only truthful signal the web layer can get.
 */
let pendingInstallFromVersion: string | null = null;

async function readNativeVersion(): Promise<string | null> {
  try {
    const res = await plugin()?.getAppInfo?.();
    return res?.versionName?.trim() || null;
  } catch {
    return null;
  }
}

// ─── Store ───────────────────────────────────────────────────────────────────

function createAppUpdateStore() {
  return create<AppUpdateState>((set, get) => ({
    status: 'idle',
    info: null,
    progress: null,
    error: null,
    needsInstallPermission: false,
    postponedVersion: loadPostponedVersion(),
    lastCheckAt: 0,
    checking: false,
    lastCheckFailed: false,
    dialogRequested: false,
    deltaApplied: false,
    manualInstallAvailable: false,

    check: async (trigger) => {
      const shell = currentShell();
      if (shell === 'web') return false; // plain web never self-updates

      const { lastCheckAt, checking } = get();
      if (checking) return false;
      if (trigger !== 'manual' && Date.now() - lastCheckAt < AUTO_CHECK_THROTTLE_MS) return false;
      set({ checking: true, status: 'checking' });
      try {
        let info: AppUpdateInfo | null = null;
        let checkFailed = false;

        if (shell === 'electron') {
          const api = electronAPI();
          const version = (await api?.getAppVersion?.().catch(() => '')) || '';
          if (api && !version) return finishIdle();
          let res: CheckResponse | null = null;
          if (api) {
            res = (await api.checkForUpdates?.()) ?? null;
          } else {
            // Dev/preview (no preload bridge): query the same public endpoint
            // from the renderer with a placeholder current version.
            res = await fetchCheck(desktopPlatform(), '0.0.1');
          }
          if (!res?.success) checkFailed = true;
          if (res?.success && res.updateAvailable && res.latestVersion && res.downloadUrl) {
            info = {
              version: res.latestVersion,
              currentVersion: res.currentVersion || version,
              isMandatory: res.isMandatory === true,
              downloadUrl: res.downloadUrl,
              absoluteDownloadUrl: '',
              releaseNotes: res.releaseNotes,
              releaseNotesAr: res.releaseNotesAr,
              releaseNotesFr: res.releaseNotesFr,
              fileSize: res.fileSize ?? 0,
              fileHash: res.fileHash,
              delta: res.delta && res.delta.supported && Array.isArray(res.delta.hops) && res.delta.hops.length > 0 ? res.delta : null,
              compat: res.compat ?? null,
            };
            // COMPATIBILITY MAP (0.6.31): a CRITICAL gate (or an API-level
            // floor breach) means the app CANNOT run against this server —
            // escalate the update to the mandatory full-screen gate.
            if (info.compat?.updateRequired) info.isMandatory = true;
          }
        } else {
          // Android: try the release channel first, then the debug channel
          // (CI currently publishes debug APKs to android-debug).
          const capPlugin = plugin();
          const appInfo = await capPlugin?.getAppInfo?.().catch(() => null);
          const version = String(appInfo?.versionName || '');
          if (!version) return finishIdle();
          for (const platform of ['android', 'android-debug']) {
            const res = await fetchCheck(platform, version);
            if (!res?.success || !res.updateAvailable || !res.latestVersion || !res.downloadUrl) continue;
            info = {
              version: res.latestVersion,
              currentVersion: res.currentVersion || version,
              isMandatory: res.isMandatory === true,
              downloadUrl: res.downloadUrl,
              absoluteDownloadUrl: buildCloudUrl(res.downloadUrl),
              releaseNotes: res.releaseNotes,
              releaseNotesAr: res.releaseNotesAr,
              releaseNotesFr: res.releaseNotesFr,
              fileSize: res.fileSize ?? 0,
              fileHash: res.fileHash,
              delta: res.delta && res.delta.supported && Array.isArray(res.delta.hops) && res.delta.hops.length > 0 ? res.delta : null,
              compat: res.compat ?? null,
            };
            // COMPATIBILITY MAP (0.6.31): critical gates escalate to mandatory.
            if (info.compat?.updateRequired) info.isMandatory = true;
            break;
          }
        }

        set({ checking: false, lastCheckAt: Date.now(), lastCheckFailed: checkFailed });

        if (!info) {
          // Up to date (or the cloud was unreachable — lastCheckFailed marks it)
          set({ status: 'idle', error: null });
          return false;
        }

        // COMPATIBILITY MAP (0.6.31) — SERVER-ONLY releases: the newest
        // version only changes the server (flagged serverOnly or same API
        // level with nothing app-facing). The app keeps running with ZERO
        // action — no dialog, no auto-download; the info is kept so the
        // manual check can say "server-side update, nothing to do".
        if (info.compat?.serverOnlyUpdate && !info.isMandatory) {
          set({ status: 'idle', error: null, info });
          return false;
        }

        // A NEWER version than the postponed one clears the postpone.
        if (get().postponedVersion && get().postponedVersion !== info.version) {
          savePostponedVersion(null);
          set({ postponedVersion: null });
        }

        set({ info, status: 'available', error: null, progress: null });
        await maybeAutoDownload(info);
        return true;
      } catch {
        set({ checking: false, status: 'idle', lastCheckFailed: true });
        return false;
      }

      function finishIdle(): boolean {
        set({ checking: false, lastCheckAt: Date.now(), status: 'idle', lastCheckFailed: true });
        return false;
      }
    },

    startDownload: async () => {
      const { info, status } = get();
      if (!info || status === 'downloading' || status === 'downloaded') return;
      set({ status: 'downloading', error: null, needsInstallPermission: false, manualInstallAvailable: false, progress: { percent: 0, receivedBytes: 0, totalBytes: info.fileSize } });
      try {
        if (currentShell() === 'electron') {
          // DELTA FIRST (0.6.30): when the cloud offered a verified hop chain
          // (asar binary-delta + out tree patches) download+apply it IN PLACE
          // — no NSIS run at all, the app relaunches into the new version.
          // Any failure falls back to the full installer download below.
          if (info.delta && info.delta.hops.length > 0 && electronAPI()?.installDeltaUpdate) {
            const result = await electronAPI()?.installDeltaUpdate({
              hops: info.delta.hops,
              target: { version: info.version, asarSha256: info.delta.targetAsarSha256 || '' },
            });
            if (result?.ok) {
              set({ deltaApplied: true, status: 'downloaded', progress: { percent: 100, receivedBytes: info.delta.totalSize, totalBytes: info.delta.totalSize } });
              void maybeAutoInstall();
              return;
            }
            // Delta failed — report why, then fall through to the FULL installer.
            set({ deltaApplied: false });
            console.warn('[update] delta chain failed — falling back to full installer:', result?.error);
          }
          await electronAPI()?.downloadUpdate?.({ url: info.downloadUrl, version: info.version, fileHash: info.fileHash, fileSize: info.fileSize });
          // Progress arrives via onUpdateProgress → applyProgress.
        } else {
          // Android delta path: the native side downloads the hop patches,
          // applies them onto the installed base.apk and stages the rebuilt
          // APK; on success it returns the local path (installUpdate picks it
          // up WITHOUT a DownloadManager id).
          if (info.delta && info.delta.hops.length > 0 && plugin()?.installDeltaUpdate) {
            const result = await plugin()?.installDeltaUpdate({
              deltas: info.delta.hops.map((h) => ({ url: buildCloudUrl(h.url), sha256: h.sha256, fromVersion: h.fromVersion, toVersion: h.toVersion, fromArtifactHash: h.fromArtifactHash || '' })),
              finalSha256: info.delta.targetApkSha256 || '',
              fromVersion: info.currentVersion,
              toVersion: info.version,
            });
            if (result?.ok && result.apkPath) {
              set({ deltaApplied: true, status: 'downloaded', progress: { percent: 100, receivedBytes: info.delta.totalSize, totalBytes: info.delta.totalSize } });
              lastAndroidDeltaPath = result.apkPath;
              void maybeAutoInstall();
              return;
            }
            console.warn('[update] android delta chain failed — falling back to full APK:', result?.error);
          }
          const res = await plugin()?.downloadUpdate?.({ url: info.absoluteDownloadUrl || info.downloadUrl, version: info.version });
          if (res?.downloadId) {
            lastAndroidDownloadId = res.downloadId; // consumed by install() below
            startAndroidPolling(res.downloadId);
          }
          else set({ status: 'error', error: 'download-failed' });
        }
      } catch {
        set({ status: 'error', error: 'download-failed' });
      }
    },

    install: async () => {
      const { status, deltaApplied } = get();
      if (status !== 'downloaded') return;
      set({ status: 'installing' });
      try {
        if (currentShell() === 'electron') {
          if (deltaApplied) {
            // The chain is ALREADY applied on disk — a relaunch is the whole
            // install (the new asar + tree load on boot). No NSIS, no quit
            // dance: this is the differential update payoff.
            await electronAPI()?.relaunchAfterDelta?.();
            return;
          }
          const result = await electronAPI()?.installUpdate?.();
          // 0.6.30 install fix: ok:false means the app did NOT quit — every
          // launcher leg (waiter + PowerShell) failed. Surface the manual
          // fallback instead of pretending.
          if (result && result.ok === false) {
            set({ status: 'downloaded', error: 'install-spawn-failed', manualInstallAvailable: true });
            return;
          }
          // The main process quits and runs the NSIS installer.
        } else {
          // Record the CURRENT native version BEFORE the installer opens —
          // the resume comparison in resolvePendingInstall() needs it to tell
          // "installed for real" from "Android silently refused".
          if (!pendingInstallFromVersion) {
            pendingInstallFromVersion = await readNativeVersion();
          }
          if (deltaApplied && lastAndroidDeltaPath) {
            // Delta path: the rebuilt APK already sits in app files — hand the
            // native installer the DIRECT path (no DownloadManager id).
            await plugin()?.installUpdate?.({ filePath: lastAndroidDeltaPath });
          } else {
            // 0.6.18: hand the native side the download we actually completed —
            // without it the plugin could not locate the APK ("apk-not-found").
            await plugin()?.installUpdate?.({ downloadId: lastAndroidDownloadId ?? undefined });
          }
          // Android: the package installer opens over our activity. It is
          // asynchronous — ok:true only means the installer UI opened, so
          // drop back to 'downloaded' (NOT a success claim). The resume
          // listener decides the real outcome via resolvePendingInstall().
          set({ status: 'downloaded' });
        }
      } catch (err) {
        pendingInstallFromVersion = null;
        const msg = err instanceof Error ? err.message : String(err ?? '');
        // 0.6.18: only a REAL permission rejection may set needsInstallPermission.
        // Labeling file-lookup failures ("apk-not-found", "install-failed") as
        // permission problems was half of the field loop: the UI kept offering
        // the same install and each trigger bounced the user to settings again.
        const permissionGate = msg.includes('needs-install-permission')
          || msg.includes('settings screen opened');
        if (permissionGate) {
          set({ status: 'downloaded', needsInstallPermission: true });
          // Report #3: "the app does not open the dialog so I can grant it the
          // authority to install apps". New native builds open the grant screen
          // THEMSELVES before rejecting (their message carries the marker
          // below) — for older builds, drive the user there from here.
          if (!msg.includes('settings screen opened')) {
            try {
              await plugin()?.openInstallPermissionSettings?.();
            } catch { /* older build without the method — the store flag still guides the UI */ }
          }
        } else {
          set({ status: 'error', error: 'install-failed' });
        }
      }
    },

    resolvePendingInstall: async () => {
      if (currentShell() !== 'capacitor') return null;
      const from = pendingInstallFromVersion;
      pendingInstallFromVersion = null;
      if (!from) return null;
      const nowVersion = await readNativeVersion();
      if (nowVersion && nowVersion !== from) {
        // The install really happened — clear the update state so the dialog
        // never re-opens for the already-installed version.
        set({ status: 'idle', info: null, progress: null, error: null });
        return 'updated';
      }
      // Android refused the APK (signature mismatch / cancelled / corrupt
      // download). Keep the update available and let the UI tell the user
      // the ONE-TIME fix: uninstall + reinstall.
      return 'not-installed';
    },

    postpone: () => {
      const { info } = get();
      if (!info) return;
      savePostponedVersion(info.version);
      set({ postponedVersion: info.version, dialogRequested: false });
    },

    requestDialog: () => set({ dialogRequested: true }),
    closeDialog: () => set({ dialogRequested: false }),

    applyProgress: (payload) => {
      if (payload.status === 'downloading') {
        set({
          status: 'downloading',
          progress: {
            percent: payload.percent ?? 0,
            receivedBytes: payload.receivedBytes ?? 0,
            totalBytes: payload.totalBytes ?? 0,
          },
        });
      } else if (payload.status === 'downloaded') {
        stopAndroidPolling();
        set({
          status: 'downloaded',
          progress: { percent: 100, receivedBytes: payload.receivedBytes ?? 0, totalBytes: payload.totalBytes ?? 0 },
        });
        void maybeAutoInstall();
      } else if (payload.status === 'error') {
        stopAndroidPolling();
        set({ status: 'error', error: payload.error || 'download-failed' });
      }
    },

    ingestPushPayload: async (payload) => {
      const shell = currentShell();
      if (shell === 'web') return;
      if (!payload?.version || !payload?.downloadUrl) return;
      const { info, status } = get();
      // A download already targeting THIS version keeps running untouched.
      if (status === 'downloading' && info?.version === payload.version) return;
      const mandatory = payload.isMandatory === true || payload.push?.isMandatory === true;
      const next: AppUpdateInfo = {
        version: payload.version,
        currentVersion: payload.currentVersion || info?.currentVersion || '',
        isMandatory: mandatory,
        downloadUrl: payload.downloadUrl,
        absoluteDownloadUrl: shell === 'capacitor' ? buildCloudUrl(payload.downloadUrl) : '',
        releaseNotes: payload.releaseNotes,
        releaseNotesAr: payload.releaseNotesAr,
        releaseNotesFr: payload.releaseNotesFr,
        fileSize: payload.fileSize ?? 0,
        pushMessage: payload.push?.message,
        pushMessageAr: payload.push?.messageAr,
        pushMessageFr: payload.push?.messageFr,
      };
      if (get().postponedVersion && get().postponedVersion !== next.version) {
        savePostponedVersion(null);
        set({ postponedVersion: null });
      }
      set({ info: next, status: 'available', error: null, lastCheckAt: Date.now() });
      await maybeAutoDownload(next);
    },

    clearError: () => set({ error: null, status: get().info ? 'available' : 'idle' }),
    resetNeedsPermission: () => set({ needsInstallPermission: false }),

    openInstallerManually: async () => {
      try {
        const result = await electronAPI()?.openDownloadedInstaller?.();
        if (result && result.ok === false) {
          set({ error: 'no-download' });
        }
      } catch { /* the button is best-effort by definition */ }
    },
  }));
}

/** Auto-download honouring the user settings + Wi-Fi-only sub-setting. */
async function maybeAutoDownload(info: AppUpdateInfo) {
  // SERVER-ONLY releases never trigger an app download (nothing app-facing).
  if (info.compat?.serverOnlyUpdate && !info.isMandatory) return;
  const settings = loadAppUpdateSettings();
  if (!settings.autoDownload) return;
  if (settings.autoDownloadWifiOnly && !(await isWifiConnection())) return;
  // Mandatory or optional — download in the background either way.
  storeInstance?.getState().startDownload();
}

/**
 * AUTO-UPDATE (download → install → restart): fire the install the moment a
 * download completes. Desktop = quit + silent NSIS + relaunch (fully
 * automatic). Android = the system package installer opens over the app (the
 * OS always shows its own confirm screen — hard platform limit). Mandatory
 * updates bypass the user's autoInstall preference entirely.
 */
async function maybeAutoInstall() {
  const state = storeInstance?.getState();
  if (!state || state.status !== 'downloaded') return;
  const settings = loadAppUpdateSettings();
  const mandatory = state.info?.isMandatory === true;
  if (!settings.autoInstall && !mandatory) return;
  // Small grace so the UI can paint the "downloaded" state before the
  // desktop app quits / Android's installer screen takes over.
  setTimeout(() => {
    const s = storeInstance?.getState();
    if (s && s.status === 'downloaded') void s.install();
  }, 1500);
}

export const useAppUpdateStore = (() => {
  storeInstance = createAppUpdateStore();
  return storeInstance;
})();

/**
 * Manual-check entry shared by the sidebar button, the mobile More sheet and
 * the settings cards. Returns what happened so callers can toast:
 * 'up-to-date' | 'available' | 'failed' | 'throttled'
 */
export async function manualUpdateCheck(): Promise<ManualCheckResult> {
  if (currentShell() === 'web') return 'up-to-date';
  const state = useAppUpdateStore.getState();
  const alreadyAvailable = state.status === 'available' || state.status === 'downloading' || state.status === 'downloaded';
  const found = await state.check('manual');
  if (found || alreadyAvailable) return 'available';
  // COMPATIBILITY MAP (0.6.31): the newest release is SERVER-ONLY — tell the
  // user the truth instead of a generic "up to date": the server moved, the
  // app did not need to.
  const after = useAppUpdateStore.getState();
  if (after.info?.compat?.serverOnlyUpdate) return 'server-only';
  // Distinguish a failed network check from a genuine "up to date".
  return after.lastCheckFailed ? 'failed' : 'up-to-date';
}

export type ManualCheckResult = 'up-to-date' | 'available' | 'failed' | 'throttled' | 'server-only';
