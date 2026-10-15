/**
 * BLASTI Notification Channel Setup
 * 
 * Creates a high-priority notification channel for the "Turn Called" alert.
 * On Android (via Capacitor), this uses LocalNotifications.createChannel()
 * to create a channel with max importance and custom alarm sound.
 * 
 * On web, we use the Notification API with appropriate options.
 * 
 * IMPORTANT: Capacitor plugins are accessed via window.Capacitor.Plugins
 * to avoid bundling errors in the web project (the @capacitor/* packages
 * are only installed in apps/mobile).
 *
 * ── User-controlled alert behavior (field reports #lockscreen + #mute) ──
 * • queue_called=false (existing per-user notification preference) now ALSO
 *   silences the native lock-screen notification — previously only the
 *   in-app banner honored it, so customers had NO way to stop the lock
 *   screen alert when the agency called.
 * • lockscreenTakeover (new preference, default OFF) opts back into the
 *   full-screen app launch over the keyguard. Default behavior is a normal
 *   high-importance notification — the app never takes over the lock
 *   screen by itself anymore.
 */

import { emitLockscreenEvent } from '@/lib/lockscreen-events';

/** localStorage mirror of the per-user notificationPreferences JSON. */
const NOTIF_PREFS_KEY = 'blasti-notif-prefs';

export interface BlastiNotifPrefs {
  queue_called?: boolean;
  turn_approaching?: boolean;
  completed?: boolean;
  /** Opt-in to the app launching itself over the keyguard on a call.
   *  Default FALSE — notification only. */
  lockscreenTakeover?: boolean;
}

/**
 * Persist the notification-preferences mirror used by the realtime alert
 * paths (which run outside React and cannot read the zustand store).
 * Called by user-store-refresh + the profile settings UI.
 */
export function mirrorNotifPrefs(prefs: BlastiNotifPrefs | null | undefined): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (!prefs || typeof prefs !== 'object') return;
    localStorage.setItem(NOTIF_PREFS_KEY, JSON.stringify(prefs));
    // Keep the native lock-screen flag in sync with the server-side
    // preference (single choke point — called from the settings UI save path
    // AND user-store-refresh on boot/focus).
    syncLockscreenTakeoverToNative();
  } catch { /* storage may be unavailable */ }
}

function readNotifPrefs(): BlastiNotifPrefs {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(NOTIF_PREFS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * True when the user ALLOWED turn-call alerts (notification preference
 * queue_called !== false). Default true — existing accounts keep alerts.
 */
export function turnCallAlertsEnabled(): boolean {
  return readNotifPrefs().queue_called !== false;
}

/**
 * True when the user ALLOWED turn-approaching ("cooling turn") alerts
 * (notification preference turn_approaching !== false). Default true.
 * Field report: the approaching alert had NO lock-screen presence at all —
 * it was an in-app toast only. Gated by the SAME per-channel preference
 * card the settings page already exposes for it.
 */
export function turnApproachingAlertsEnabled(): boolean {
  return readNotifPrefs().turn_approaching !== false;
}

interface NotificationChannelConfig {
  id: string;
  name: string;
  importance: number;
  sound?: string;
  vibration?: boolean;
  lights?: boolean;
  lightColor?: string;
}

const BLASTI_TURN_CHANNEL: NotificationChannelConfig = {
  id: 'blasti-turn-alert',
  name: 'BLASTI Turn Alert',
  importance: 5, // Max importance — shows as heads-up notification
  sound: 'blasti_alarm.wav',
  vibration: true,
  lights: true,
  lightColor: '#10b981',
};

let channelCreated = false;

/**
 * Check if we're running inside a Capacitor native shell.
 */
function isCapacitorNative(): boolean {
  if (typeof window === 'undefined') return false;
  const cap = (window as any)?.Capacitor;
  if (!cap) return false;
  if (typeof cap.isNativePlatform === 'function') return cap.isNativePlatform();
  if (typeof cap.isNative === 'boolean') return cap.isNative;
  return false;
}

/**
 * Get the Capacitor LocalNotifications plugin via the global runtime.
 * This avoids importing @capacitor/local-notifications (which doesn't
 * exist in the web package and would cause bundling errors).
 */
function getLocalNotificationsPlugin(): any | null {
  if (typeof window === 'undefined') return null;
  const cap = (window as any)?.Capacitor;
  if (!cap) return null;
  
  // Access pre-registered plugin via Capacitor.Plugins
  // (Do NOT use registerPlugin() as it may trigger dynamic imports that fail on web)
  const plugin = cap.Plugins?.LocalNotifications;
  return plugin || null;
}

export async function setupTurnAlertChannel(): Promise<void> {
  if (channelCreated) return;

  if (isCapacitorNative()) {
    try {
      // Lock-screen channels FIRST (native plugin — IMPORTANCE_HIGH +
      // VISIBILITY_PUBLIC so the full content shows on the lock screen and a
      // full-screen intent can wake the app over the keyguard).
      const status = getBlastiNativeStatusPlugin();
      if (status?.ensureNotificationChannels) {
        await status.ensureNotificationChannels();
        console.log('[NotificationChannel] Native lock-screen channels ensured');
      }
    } catch {
      console.log('[NotificationChannel] Native channel creation failed, falling back');
    }
    try {
      const LocalNotifications = getLocalNotificationsPlugin();
      if (LocalNotifications?.createChannel) {
        await LocalNotifications.createChannel(BLASTI_TURN_CHANNEL);
        console.log('[NotificationChannel] Created high-priority channel:', BLASTI_TURN_CHANNEL.id);
      }
    } catch {
      console.log('[NotificationChannel] Capacitor channel creation failed, skipping');
    }
  } else {
    console.log('[NotificationChannel] Web environment, skipping Capacitor channel creation');
  }

  channelCreated = true;
}

/**
 * BLASTI native status plugin via the runtime global (zero @capacitor imports
 * in the web bundle — the probe pattern used across the web codebase).
 */
function getBlastiNativeStatusPlugin(): {
  ensureNotificationChannels?: () => Promise<unknown>;
  openInstallPermissionSettings?: () => Promise<{ ok?: boolean; canInstall?: boolean }>;
  setLockscreenTakeover?: (opts: { enabled: boolean }) => Promise<{ ok?: boolean; enabled?: boolean }>;
  getTurnDismissState?: () => Promise<{ dismissedAt?: number; dismissedId?: number }>;
  notifyLockscreen?: (opts: {
    title: string;
    body: string;
    notificationId?: number;
    /** Opt-in full-screen app launch over the keyguard (default false). */
    fullScreen?: boolean;
    /** Label for the native "Stop" action button (default "إيقاف / Stop"). */
    stopLabel?: string;
  }) => Promise<{ ok?: boolean; id?: number; fullScreen?: boolean }>;
} | null {
  if (typeof window === 'undefined') return null;
  const cap = (window as any)?.Capacitor;
  if (!cap?.Plugins) return null;
  return cap.Plugins.BlastiNativeStatus ?? null;
}

/**
 * Lock-screen takeover preference: when true, a call may launch the whole
 * app over the keyguard. Default FALSE (notification only) — the old
 * always-takeover behavior is opt-in from Settings → Notifications.
 */
function lockscreenTakeoverEnabled(): boolean {
  return readNotifPrefs().lockscreenTakeover === true;
}

/**
 * Last value synced to the native side — avoids re-issuing the plugin call on
 * every mirrorNotifPrefs() write (user-store-refresh runs on boot AND focus).
 */
let lastSyncedTakeover: boolean | null = null;

/**
 * Push the current lockscreenTakeover preference into the NATIVE layer
 * (SharedPreferences + apply setShowWhenLocked/setTurnScreenOn on the
 * running activity). This is what makes the runtime gating actually work:
 * the manifest flags are gone, so the ONLY way a full-screen takeover can
 * happen is when the native pref says so — and this is the one bridge that
 * keeps the native pref in sync with the server-side user preference.
 * Best-effort: web/desktop shells and older APKs silently no-op.
 */
export function syncLockscreenTakeoverToNative(): void {
  if (!isCapacitorNative()) return;
  const enabled = lockscreenTakeoverEnabled();
  if (lastSyncedTakeover === enabled) return;
  try {
    const status = getBlastiNativeStatusPlugin();
    if (!status?.setLockscreenTakeover) return;
    void status.setLockscreenTakeover({ enabled })
      .then(() => { lastSyncedTakeover = enabled; })
      .catch(() => { /* older APK without the method — stay silent */ });
  } catch { /* never let a sync attempt break the caller */ }
}

/**
 * Did the user already STOP the turn alert from the lock screen (swipe or
 * the native "Stop" action) at or before `at`? The resume-replay gate uses
 * this to avoid re-showing an alert the user explicitly dismissed — full
 * parity with the in-app slide-to-stop.
 */
export async function wasTurnAlertDismissedNatively(at: number): Promise<boolean> {
  if (!isCapacitorNative()) return false;
  try {
    const status = getBlastiNativeStatusPlugin();
    if (!status?.getTurnDismissState) return false;
    const state = await status.getTurnDismissState();
    const dismissedAt = typeof state?.dismissedAt === 'number' ? state.dismissedAt : 0;
    return dismissedAt > 0 && at <= dismissedAt;
  } catch {
    return false;
  }
}

/**
 * Post a LOCK-SCREEN notification through the native plugin (high-importance
 * PUBLIC content on the lock screen, tap → app; the full-screen APP takeover
 * only when the user opted in via lockscreenTakeover).
 * Returns true when the native path handled it.
 */
export async function showLockscreenNotification(
  title: string,
  body: string,
  ticketNumber?: string,
  stopLabel?: string,
): Promise<boolean> {
  if (!isCapacitorNative()) return false;
  try {
    const status = getBlastiNativeStatusPlugin();
    if (!status?.notifyLockscreen) return false;
    // Apply the CURRENT takeover preference to the running activity BEFORE
    // the notification posts — the runtime flags are what the full-screen
    // intent launch obeys (singleTask reuses this very instance).
    syncLockscreenTakeoverToNative();
    const res = await status.notifyLockscreen({
      title,
      body,
      notificationId: Date.now() % 100000,
      // Default OFF — the app must not show itself on the lock screen
      // (field report: the whole app appeared over the keyguard).
      fullScreen: lockscreenTakeoverEnabled(),
      // Lock-screen "Stop" action button — swipe/stop parity with the
      // in-app banner. Bilingual default matches the alert title style.
      stopLabel,
    });
    // Feed the in-app lock-screen UI (visible when the user returns to the
    // app / as a heads-up card while the app is open).
    void emitLockscreenEvent({ title, body, ticketNumber, at: Date.now() });
    return res?.ok === true;
  } catch {
    return false;
  }
}

/** Which alert family is firing — each gated by its own user preference. */
export type TurnAlertKind = 'called' | 'approaching';

export async function scheduleTurnNotification(
  title: string,
  body: string,
  ticketNumber: string,
  stopLabel?: string,
  kind: TurnAlertKind = 'called',
): Promise<void> {
  // ── Preference gate (report: "no way to stop the lock screen notification
  // when agency calls") — queue_called=false silences EVERYTHING here:
  // native lock-screen alert, Capacitor local notification, web Notification.
  // The approaching ("cooling turn") alert is gated by its own card
  // (turn_approaching) so users can mute it without muting the call alert.
  if (kind === 'approaching' ? !turnApproachingAlertsEnabled() : !turnCallAlertsEnabled()) return;

  // Channels MUST exist before anything posts. Idempotent — also covers
  // builds where the native boot hook could not run (the FCM background path
  // targets blasti-turn-alert; without it, pushes land on the OS default
  // low-importance channel: no heads-up, no lock-screen content).
  await setupTurnAlertChannel();

  // 1. Native lock-screen path (public lock-screen visibility + optional
  //    opt-in full-screen takeover) — exactly what the mobile app was missing.
  if (await showLockscreenNotification(title, body, ticketNumber, stopLabel)) {
    // Still play the in-app alarm sound through the LocalNotifications path?
    // No — the lock-screen channel carries its own sound + vibration.
    return;
  }

  // 2. Capacitor LocalNotifications (pre-plugin builds / when the native
  //    method is unavailable).
  if (isCapacitorNative()) {
    try {
      const LocalNotifications = getLocalNotificationsPlugin();
      if (LocalNotifications?.schedule) {
        await LocalNotifications.schedule({
          notifications: [{
            title,
            body,
            id: Date.now() % 100000,
            channelId: BLASTI_TURN_CHANNEL.id,
            sound: 'blasti_alarm.wav',
            smallIcon: 'ic_launcher',
            iconColor: '#10b981',
            extra: { ticketNumber, type: 'TURN_CALLED' },
          }],
        });
        void emitLockscreenEvent({ title, body, ticketNumber, at: Date.now() });
        return;
      }
    } catch {
      // Fallback to web Notification API below
    }
  }

  // Web Notification API fallback
  if (typeof window !== 'undefined' && 'Notification' in window) {
    if (Notification.permission === 'granted') {
      const notification = new Notification(title, {
        body,
        icon: '/logo-192.png',
        badge: '/blasti-icon.png',
        tag: 'blasti-turn-alert',
        requireInteraction: true, // Stay visible until user dismisses
        silent: false,
      });
      
      notification.onclick = () => {
        window.focus();
        notification.close();
      };
    } else if (Notification.permission !== 'denied') {
      const permission = await Notification.requestPermission();
      if (permission === 'granted') {
        // Retry
        scheduleTurnNotification(title, body, ticketNumber);
      }
    }
  }
}

export { BLASTI_TURN_CHANNEL };
