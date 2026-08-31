/**
 * BLASTI Mobile — Capacitor Setup & Event Bridging
 *
 * This module initializes all Capacitor plugins and bridges native events
 * to the BLASTI web app running inside the Capacitor WebView.
 *
 * Responsibilities:
 *   1. Initialize Capacitor plugins on app startup
 *   2. Set up deep link handling (blasti:// URLs)
 *   3. Configure push notification listeners and forward to web
 *   4. Bridge Capacitor lifecycle events (pause, resume) to the web app
 *   5. Expose the native plugin object on `window.__BLASTI_NATIVE__`
 *
 * The web app's platform detection (`platform.ts`) identifies the Capacitor
 * runtime via `window.Capacitor.isNativePlatform()`, and the adapter layer
 * (`apps/web/src/lib/adapters/`) uses Capacitor plugin APIs directly.
 * This setup module complements that by:
 *   - Registering global event listeners that the adapters rely on
 *   - Forwarding push notification tokens to the web app for registration
 *   - Handling deep links that arrive while the app is already running
 *   - Managing app lifecycle state transitions
 *
 * Usage:
 *   Import and call `setupBlastiMobile()` once when the app starts,
 *   typically from the main entry point or a platform-specific bootstrap file.
 */

import { Capacitor } from '@capacitor/core';
import { App, AppUrlOpenEvent } from '@capacitor/app';
import { PushNotifications, PushNotificationDeliverObject, PushNotificationActionPerformedObject } from '@capacitor/push-notifications';
import { LocalNotifications, LocalNotificationActionPerformedEvent } from '@capacitor/local-notifications';
import { blastiNativePlugin, exposeOnWindow, plugins } from './plugin';

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface BlastiMobileConfig {
  /**
   * Whether to automatically request push notification permissions on startup.
   * Default: false (request explicitly when the user opts in)
   */
  autoRequestPushPermission?: boolean;

  /**
   * Whether to expose `window.__BLASTI_NATIVE__` for the web app.
   * Default: true
   */
  exposeWindowBridge?: boolean;

  /**
   * Callback when a deep link is received.
   * The URL is in the format: blasti://path/to/screen
   */
  onDeepLink?: (url: string) => void;

  /**
   * Callback when a push notification is received while the app is in foreground.
   */
  onPushNotificationReceived?: (notification: PushNotificationDeliverObject) => void;

  /**
   * Callback when a push notification action is performed (tap).
   */
  onPushNotificationActionPerformed?: (action: PushNotificationActionPerformedObject) => void;

  /**
   * Callback when a local notification action is performed (tap).
   */
  onLocalNotificationActionPerformed?: (action: LocalNotificationActionPerformedEvent) => void;

  /**
   * Callback when the app is paused (sent to background).
   */
  onAppPause?: () => void;

  /**
   * Callback when the app is resumed (brought to foreground).
   */
  onAppResume?: () => void;

  /**
   * Callback when the push notification registration token is received.
   * This token should be sent to the BLASTI API server for the user's device.
   */
  onPushTokenReceived?: (token: string) => void;

  /**
   * Callback when push notification registration fails.
   */
  onPushTokenError?: (error: Error) => void;
}

export interface BlastiMobileSetupResult {
  /** Whether the setup completed successfully */
  success: boolean;
  /** The platform detected by Capacitor */
  platform: string;
  /** Cleanup function to remove all event listeners */
  cleanup: () => void;
}

// ─── Internal State ─────────────────────────────────────────────────────────────

let isSetup = false;
const cleanupFns: Array<() => void> = [];

// ─── Deep Link Handling ─────────────────────────────────────────────────────────

/**
 * Set up deep link (universal link / app link) handling.
 * When a blasti:// URL opens the app, we forward it to the web app
 * via a custom DOM event that the deep-link adapter can listen for.
 */
function setupDeepLinks(config: BlastiMobileConfig): void {
  try {
    const listener = App.addListener('appUrlOpen', (event: AppUrlOpenEvent) => {
      console.log('[BlastiMobile] Deep link received:', event.url);

      // Forward to the callback if provided
      if (config.onDeepLink) {
        config.onDeepLink(event.url);
      }

      // Also dispatch a DOM event so the web app's JavaScript can handle it
      // The web app's CapacitorDeepLinkAdapter uses the App plugin directly,
      // but this provides an additional DOM-level event for SPA routing.
      if (typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent('blasti:deep-link', {
            detail: { url: event.url },
          }),
        );
      }

      // If the URL uses the blasti:// scheme, convert it to a hash route
      // that the SPA router can process
      if (event.url.startsWith('blasti://')) {
        const path = event.url.replace('blasti://', '/');
        if (typeof window !== 'undefined') {
          // Use hash-based routing compatible with the SPA
          window.location.hash = path;
        }
      }
    });

    cleanupFns.push(async () => {
      try {
        const handle = await listener;
        await handle.remove();
      } catch {
        // Listener might already be removed
      }
    });
  } catch (error) {
    console.error('[BlastiMobile] Failed to set up deep links:', error);
  }
}

// ─── Push Notification Handling ─────────────────────────────────────────────────

/**
 * Set up push notification listeners.
 * Handles registration, foreground notifications, and notification taps.
 */
function setupPushNotifications(config: BlastiMobileConfig): void {
  if (!Capacitor.isNativePlatform()) {
    console.info('[BlastiMobile] Push notifications only available on native platforms');
    return;
  }

  try {
    // ── Registration ────────────────────────────────────────────────────────
    const regTokenListener = PushNotifications.addListener(
      'registration',
      (token) => {
        console.log('[BlastiMobile] Push registration token received');
        if (config.onPushTokenReceived) {
          config.onPushTokenReceived(token.value);
        }

        // Store the token in preferences for later use
        blastiNativePlugin.setPreference('blasti:push_token', token.value);
      },
    );

    cleanupFns.push(async () => {
      try {
        const handle = await regTokenListener;
        await handle.remove();
      } catch { /* already removed */ }
    });

    // ── Registration Error ──────────────────────────────────────────────────
    const regErrorListener = PushNotifications.addListener(
      'registrationError',
      (error) => {
        console.error('[BlastiMobile] Push registration error:', error);
        if (config.onPushTokenError) {
          config.onPushTokenError(new Error(error.error));
        }
      },
    );

    cleanupFns.push(async () => {
      try {
        const handle = await regErrorListener;
        await handle.remove();
      } catch { /* already removed */ }
    });

    // ── Foreground Notification ─────────────────────────────────────────────
    const foregroundListener = PushNotifications.addListener(
      'pushNotificationReceived',
      (notification) => {
        console.log('[BlastiMobile] Push notification received in foreground:', notification.title);

        if (config.onPushNotificationReceived) {
          config.onPushNotificationReceived(notification);
        }

        // Dispatch a DOM event so the web app can react (e.g., show toast, update badge)
        if (typeof window !== 'undefined') {
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
        }
      },
    );

    cleanupFns.push(async () => {
      try {
        const handle = await foregroundListener;
        await handle.remove();
      } catch { /* already removed */ }
    });

    // ── Notification Tap (background / cold start) ─────────────────────────
    const tapListener = PushNotifications.addListener(
      'pushNotificationActionPerformed',
      (action) => {
        console.log('[BlastiMobile] Push notification action performed:', action.actionId);

        if (config.onPushNotificationActionPerformed) {
          config.onPushNotificationActionPerformed(action);
        }

        // Dispatch a DOM event for the web app to navigate or handle the action
        if (typeof window !== 'undefined') {
          window.dispatchEvent(
            new CustomEvent('blasti:notification-action', {
              detail: {
                actionId: action.actionId,
                notification: action.notification,
                source: 'push',
              },
            }),
          );
        }
      },
    );

    cleanupFns.push(async () => {
      try {
        const handle = await tapListener;
        await handle.remove();
      } catch { /* already removed */ }
    });

    // ── Request permission if configured ────────────────────────────────────
    if (config.autoRequestPushPermission) {
      PushNotifications.requestPermissions().then((result) => {
        if (result.receive === 'granted') {
          console.log('[BlastiMobile] Push notification permission granted, registering...');
          PushNotifications.register();
        } else {
          console.warn('[BlastiMobile] Push notification permission denied');
        }
      }).catch((error) => {
        console.error('[BlastiMobile] Failed to request push permission:', error);
      });
    }
  } catch (error) {
    console.error('[BlastiMobile] Failed to set up push notifications:', error);
  }
}

// ─── Local Notification Handling ────────────────────────────────────────────────

/**
 * Set up local notification action listeners.
 * Handles when the user taps on a local notification.
 */
function setupLocalNotifications(config: BlastiMobileConfig): void {
  if (!Capacitor.isNativePlatform()) return;

  try {
    const tapListener = LocalNotifications.addListener(
      'localNotificationActionPerformed',
      (event: LocalNotificationActionPerformedEvent) => {
        console.log('[BlastiMobile] Local notification action performed:', event.actionId);

        if (config.onLocalNotificationActionPerformed) {
          config.onLocalNotificationActionPerformed(event);
        }

        // Dispatch DOM event for the web app
        if (typeof window !== 'undefined') {
          window.dispatchEvent(
            new CustomEvent('blasti:notification-action', {
              detail: {
                actionId: event.actionId,
                notification: event.notification,
                source: 'local',
              },
            }),
          );
        }
      },
    );

    cleanupFns.push(async () => {
      try {
        const handle = await tapListener;
        await handle.remove();
      } catch { /* already removed */ }
    });
  } catch (error) {
    console.error('[BlastiMobile] Failed to set up local notifications:', error);
  }
}

// ─── App Lifecycle Handling ─────────────────────────────────────────────────────

/**
 * Set up app lifecycle event listeners (pause, resume).
 * These are forwarded to the web app as DOM events so the SPA can
 * adjust its behavior (e.g., pause real-time updates when backgrounded).
 */
function setupAppLifecycle(config: BlastiMobileConfig): void {
  try {
    const resumeListener = App.addListener('appStateChange', (state) => {
      if (state.isActive) {
        console.log('[BlastiMobile] App resumed');
        if (config.onAppResume) {
          config.onAppResume();
        }
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('blasti:app-resume'));
        }
      } else {
        console.log('[BlastiMobile] App paused');
        if (config.onAppPause) {
          config.onAppPause();
        }
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('blasti:app-pause'));
        }
      }
    });

    cleanupFns.push(async () => {
      try {
        const handle = await resumeListener;
        await handle.remove();
      } catch { /* already removed */ }
    });

    // Handle back button on Android
    if (Capacitor.getPlatform() === 'android') {
      const backListener = App.addListener('backButton', (event) => {
        // If we can go back in the WebView, do so; otherwise, minimize
        if (typeof window !== 'undefined' && window.history.length > 1) {
          window.history.back();
        } else {
          // Move app to background instead of closing
          App.minimizeApp();
        }
      });

      cleanupFns.push(async () => {
        try {
          const handle = await backListener;
          await handle.remove();
        } catch { /* already removed */ }
      });
    }
  } catch (error) {
    console.error('[BlastiMobile] Failed to set up app lifecycle:', error);
  }
}

// ─── Storage Bridge ─────────────────────────────────────────────────────────────

/**
 * Set up the storage bridge between Capacitor Preferences and the web app.
 * The web app's CapacitorStorageAdapter already uses the Preferences plugin
 * directly, so this mainly ensures the prefix convention is consistent.
 */
function setupStorageBridge(): void {
  // Ensure the storage prefix used by the web app is set
  // The web app uses 'blasti:' prefix via StorageAdapter
  // No additional setup needed — the Preferences plugin handles it transparently
  console.info('[BlastiMobile] Storage bridge initialized (Preferences plugin)');
}

// ─── Main Setup Function ────────────────────────────────────────────────────────

/**
 * Initialize the BLASTI mobile shell.
 *
 * This is the main entry point for the Capacitor mobile app setup.
 * Call this once when the app starts (e.g., from a platform bootstrap file
 * or the app component's initialization).
 *
 * @param config - Configuration options for the mobile shell
 * @returns A result object with setup status and a cleanup function
 *
 * @example
 * ```typescript
 * import { setupBlastiMobile } from '@blasti/mobile/src/setup';
 *
 * const result = setupBlastiMobile({
 *   onDeepLink: (url) => console.log('Deep link:', url),
 *   onPushTokenReceived: (token) => sendTokenToServer(token),
 *   onPushNotificationReceived: (notif) => showToast(notif.title),
 *   onAppResume: () => refreshData(),
 * });
 *
 * // Later, to clean up all listeners:
 * // result.cleanup();
 * ```
 */
export function setupBlastiMobile(config: BlastiMobileConfig = {}): BlastiMobileSetupResult {
  if (isSetup) {
    console.warn('[BlastiMobile] setupBlastiMobile() called more than once. Skipping.');
    return {
      success: false,
      platform: Capacitor.getPlatform(),
      cleanup: () => {},
    };
  }

  const platform = Capacitor.getPlatform();
  console.log(`[BlastiMobile] Initializing on platform: ${platform}`);

  // 1. Expose the native bridge on window
  if (config.exposeWindowBridge !== false) {
    exposeOnWindow();
  }

  // 2. Set up deep link handling
  setupDeepLinks(config);

  // 3. Set up push notifications
  setupPushNotifications(config);

  // 4. Set up local notification actions
  setupLocalNotifications(config);

  // 5. Set up app lifecycle events
  setupAppLifecycle(config);

  // 6. Initialize storage bridge
  setupStorageBridge();

  // 7. Store platform info in preferences for the web app to read
  blastiNativePlugin.setPreference('blasti:platform', platform);
  blastiNativePlugin.setPreference('blasti:native', String(Capacitor.isNativePlatform()));

  isSetup = true;
  console.log('[BlastiMobile] Setup complete');

  return {
    success: true,
    platform,
    cleanup: () => {
      console.log('[BlastiMobile] Cleaning up all listeners');
      cleanupFns.forEach((fn) => {
        try {
          fn();
        } catch (error) {
          console.error('[BlastiMobile] Cleanup error:', error);
        }
      });
      cleanupFns.length = 0;
      isSetup = false;
    },
  };
}

// ─── Auto-setup for Capacitor Native ────────────────────────────────────────────

/**
 * If this module is loaded in a Capacitor native environment and no
 * explicit setup has been called, perform a basic auto-setup.
 * This ensures that deep links and push notifications work even if
 * the developer forgets to call `setupBlastiMobile()` explicitly.
 *
 * The auto-setup uses sensible defaults:
 *   - Deep links are dispatched as DOM events and hash route changes
 *   - Push notifications are NOT auto-registered (requires explicit user consent)
 *   - App lifecycle events are dispatched as DOM events
 *   - The native bridge is exposed on `window.__BLASTI_NATIVE__`
 */
if (Capacitor.isNativePlatform() && typeof window !== 'undefined') {
  // Defer auto-setup to allow the web app to load first
  // Use requestAnimationFrame to ensure the DOM is ready
  requestAnimationFrame(() => {
    if (!isSetup) {
      console.log('[BlastiMobile] Auto-initializing native bridge');
      setupBlastiMobile({
        exposeWindowBridge: true,
        autoRequestPushPermission: false,
      });
    }
  });
}

// ─── Export convenience re-exports ──────────────────────────────────────────────

export { blastiNativePlugin, plugins, exposeOnWindow } from './plugin';
export { Capacitor } from '@capacitor/core';
