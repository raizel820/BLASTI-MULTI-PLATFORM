/**
 * BLASTI Mobile Push Registration (Task 47-b)
 *
 * Client-side FCM registration that runs INSIDE the web app, so push works
 * even when the Capacitor shell's auto-setup (apps/mobile/src/setup.ts) did
 * not run or did not request permission.
 *
 * Design notes:
 * - SSR-safe: every guard checks `typeof window` before touching browser APIs.
 * - Zero @capacitor imports: the app must never import @capacitor/* packages
 *   (they are not installed in apps/web). The Capacitor global injected by
 *   the native shell is probed defensively via `(window as any).Capacitor`.
 * - Runs once per session (module-level promise flag).
 * - Token upload is deduped: the last successfully-uploaded FCM token is kept
 *   in localStorage under `blasti:push_token_last`; identical tokens are not
 *   re-uploaded.
 * - Received foreground pushes are forwarded to the app as the
 *   `blasti:notification` CustomEvent (same contract as the mobile shell's
 *   setup.ts) so NotificationCenter / AppState can react.
 * - Re-registers on the existing `blasti:app-resume` window event (OS push
 *   services can invalidate tokens while backgrounded), while keeping token
 *   dedupe so unchanged tokens are never re-uploaded.
 */

import { apiClient } from '@/lib/api-client';
import { getDeviceId } from '@/lib/device-fingerprint';

// ─── Constants ───────────────────────────────────────────────────────────────

/** localStorage key holding the last SUCCESSFULLY-uploaded FCM token. */
const PUSH_TOKEN_LAST_KEY = 'blasti:push_token_last';

// ─── Minimal Capacitor Plugin Shapes ─────────────────────────────────────────

/** Minimal shape of the PushNotifications Capacitor plugin proxy. */
interface PushPluginShape {
  addListener: (
    eventName: string,
    listenerFn: (event: unknown) => void,
  ) => Promise<{ remove: () => Promise<void> }> | { remove: () => void };
  requestPermissions?: () => Promise<{ receive: string }>;
  checkPermissions?: () => Promise<{ receive: string }>;
  register?: () => void;
}

/** Minimal shape of the Capacitor global injected by the native shell. */
interface CapacitorShape {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  Plugins?: Record<string, PushPluginShape | undefined>;
}

// ─── Internal State ──────────────────────────────────────────────────────────

/** Once-per-session guard: the init promise is reused for repeat calls. */
let initPromise: Promise<void> | null = null;

// ─── Token Upload ────────────────────────────────────────────────────────────

/**
 * Upload an FCM registration token to the API, deduped by last-uploaded token.
 * Fire-and-forget by design — a failure is logged but never blocks the app.
 * The token is only remembered AFTER a successful upload, so a later
 * registration event (e.g. after `blasti:app-resume`) retries it.
 */
async function uploadPushToken(token: string, platform: string): Promise<void> {
  try {
    const last = localStorage.getItem(PUSH_TOKEN_LAST_KEY);
    if (last === token) {
      console.log('[PushRegistration] Token unchanged — skipping upload');
      return;
    }

    const deviceId = await getDeviceId();

    await apiClient.post('/api/user/push-token', {
      token,
      platform,
      deviceId,
    });

    localStorage.setItem(PUSH_TOKEN_LAST_KEY, token);
    console.log('[PushRegistration] FCM token uploaded to /api/user/push-token');
  } catch (error) {
    // Console-only per design: push registration must never surface UI errors.
    console.warn('[PushRegistration] FCM token upload failed:', error);
  }
}

// ─── Permission + Register ───────────────────────────────────────────────────

/**
 * Register the device with the OS push service when notifications are
 * permitted. `allowRequest` controls whether a permission prompt may be
 * shown (true on initial boot; false on resume — there we only register if
 * permission is ALREADY granted so the user is never re-prompted).
 */
async function registerIfPermitted(plugin: PushPluginShape, allowRequest: boolean): Promise<void> {
  try {
    let receive: string | undefined;

    if (typeof plugin.checkPermissions === 'function') {
      const status = await plugin.checkPermissions();
      receive = status?.receive;
    }

    if (receive !== 'granted' && allowRequest && typeof plugin.requestPermissions === 'function') {
      const status = await plugin.requestPermissions();
      receive = status?.receive;
    }

    if (receive === 'granted') {
      if (typeof plugin.register === 'function') {
        plugin.register();
        console.log('[PushRegistration] Registered with the OS push service');
      }
    } else {
      console.warn('[PushRegistration] Push permission not granted:', receive ?? 'unknown');
    }
  } catch (error) {
    console.warn('[PushRegistration] Permission/register flow failed:', error);
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Initialize mobile push registration from inside the web app.
 *
 * Safe to call from any client component effect: on plain browsers and
 * Electron it is a no-op (Capacitor absent or not native). Inside the
 * Capacitor WebView it wires the PushNotifications listeners, requests
 * permission, registers, and forwards tokens/notifications.
 *
 * Runs at most once per session; repeat calls return the same promise.
 */
export function initMobilePushRegistration(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      const capacitor = (window as any).Capacitor as CapacitorShape | undefined;

      // Guard: only inside the Capacitor native shell
      if (!capacitor || typeof capacitor.isNativePlatform !== 'function' || !capacitor.isNativePlatform()) {
        return;
      }

      const plugin = capacitor.Plugins?.PushNotifications;
      if (!plugin || typeof plugin.addListener !== 'function') {
        console.warn('[PushRegistration] PushNotifications plugin not available on this device');
        return;
      }

      const platform =
        typeof capacitor.getPlatform === 'function' ? String(capacitor.getPlatform()) : 'unknown';

      // ── Listeners MUST be wired before register() so no token event is lost
      await plugin.addListener('registration', (event: unknown) => {
        const value = (event as { value?: string })?.value;
        if (!value) return;
        // Fire-and-forget upload — never blocks or crashes the app
        void uploadPushToken(value, platform);
      });

      await plugin.addListener('registrationError', (event: unknown) => {
        const message = (event as { error?: string })?.error ?? 'unknown registration error';
        console.warn('[PushRegistration] Push registration error:', message);
      });

      await plugin.addListener('pushNotificationReceived', (event: unknown) => {
        const notification = (event as { title?: string; body?: string; data?: unknown }) ?? {};
        console.log('[PushRegistration] Foreground push received:', notification.title);
        // Same DOM-event contract as the mobile shell's setup.ts
        window.dispatchEvent(
          new CustomEvent('blasti:notification', {
            detail: {
              title: notification.title,
              body: notification.body,
              data: notification.data,
              source: 'push',
            },
          }),
        );
      });

      // ── Initial permission request + register
      await registerIfPermitted(plugin, true);

      // ── Re-register on app resume (token may have been rotated in background)
      // The registration listener's dedupe keeps unchanged tokens from being
      // re-uploaded; only an already-granted permission avoids re-prompting.
      window.addEventListener('blasti:app-resume', () => {
        void registerIfPermitted(plugin, false);
      });
    } catch (error) {
      // Hardened boot task — must never throw into the caller
      console.warn('[PushRegistration] Initialization failed:', error);
    }
  })();

  return initPromise;
}
