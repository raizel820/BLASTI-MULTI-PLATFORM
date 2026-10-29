'use client';

/**
 * MobileBackButtonHandler — Android hardware/system touch back button support.
 *
 * Registers the @capacitor/app `backButton` listener ONLY inside the
 * Capacitor native shell (web + Electron are untouched). Without this the
 * mobile app had NO back navigation (the system back button did nothing
 * useful inside the SPA) and no way to exit.
 *
 * Behavior (standard Android UX):
 *   1. Step back — when the WebView can go back in app navigation history,
 *      the back button navigates to the previous screen (history.back()).
 *   2. Exit — at the entry screen (nothing left to go back to), the FIRST
 *      press shows a "Press back again to exit" toast; a second press within
 *      2 seconds exits the app cleanly via App.exitApp().
 *
 * The listener is registered once on mount with a language ref so the exit
 * toast always speaks the CURRENT language without re-registering.
 */

import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { useLanguage } from '@/hooks/use-language';
import { t as translate, type Language } from '@/i18n';

/** Minimal window.Capacitor shape (mirrors native-bridge.ts). */
interface CapacitorAppPlugin {
  addListener?: (event: string, handler: (data?: BackButtonEvent) => void) => BackButtonSubscription | Promise<BackButtonSubscription>;
  exitApp?: () => void;
}
interface BackButtonEvent {
  canGoBack?: boolean;
}
interface BackButtonSubscription {
  remove?: () => void;
}
interface CapacitorGlobalLike {
  isNativePlatform?: () => boolean;
  isPluginAvailable?: (name: string) => boolean;
  Plugins?: Record<string, CapacitorAppPlugin>;
}

const EXIT_CONFIRM_WINDOW_MS = 2000;

export function MobileBackButtonHandler() {
  const { lang } = useLanguage();
  const langRef = useRef<Language>(lang);
  useEffect(() => {
    // Keep the language current for the long-lived native listener without
    // re-registering it (refs must not be written during render).
    langRef.current = lang;
  }, [lang]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const cap = (window as unknown as { Capacitor?: CapacitorGlobalLike }).Capacitor;
    // Native Capacitor shell only — never hijack the browser/Electron back UX.
    if (!cap || typeof cap.isNativePlatform !== 'function' || !cap.isNativePlatform()) return;
    const App = (typeof cap.isPluginAvailable === 'function' ? cap.isPluginAvailable('App') : true)
      ? cap.Plugins?.['App']
      : undefined;
    if (!App || typeof App.addListener !== 'function') return;

    let lastBackAt = 0;

    const handleBackButton = (data?: BackButtonEvent) => {
      // 1) Step back through in-app navigation history when possible.
      //    Trust the bridge's canGoBack when provided (accurate inside the
      //    WebView); fall back to a history-depth heuristic otherwise.
      const canGoBack = typeof data?.canGoBack === 'boolean'
        ? data.canGoBack
        : window.history.length > 1;
      if (canGoBack) {
        window.history.back();
        return;
      }

      // 2) At the entry screen — double-press-to-exit confirmation.
      const now = Date.now();
      if (now - lastBackAt < EXIT_CONFIRM_WINDOW_MS) {
        if (typeof App.exitApp === 'function') {
          App.exitApp();
        }
      } else {
        lastBackAt = now;
        try {
          toast(translate('pressBackAgainToExit', langRef.current));
        } catch {
          toast('Press back again to exit');
        }
      }
    };

    let active = true;
    let unsubscribe: (() => void) | null = null;
    try {
      const subscription = App.addListener('backButton', handleBackButton);
      if (subscription && typeof (subscription as Promise<BackButtonSubscription>).then === 'function') {
        (subscription as Promise<BackButtonSubscription>)
          .then((sub) => {
            if (!active) { sub.remove?.(); return; }
            unsubscribe = () => sub.remove?.();
          })
          .catch(() => { /* plugin removed mid-flight */ });
      } else if (subscription && typeof (subscription as BackButtonSubscription).remove === 'function') {
        unsubscribe = () => (subscription as BackButtonSubscription).remove?.();
      }
    } catch {
      // Plugin unavailable in this shell — leave default behavior untouched.
    }

    return () => {
      active = false;
      try { unsubscribe?.(); } catch { /* already removed */ }
    };
  }, []);

  // Renders nothing — this component only wires the native back button.
  return null;
}

export default MobileBackButtonHandler;
