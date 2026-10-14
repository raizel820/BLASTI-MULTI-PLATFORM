/**
 * BLASTI Native Back-Button Handler (hardware / gesture "step back + exit")
 *
 * Inside the Capacitor WebView the Android hardware/gesture back button had
 * NO working policy: the Capacitor default (webView.goBack() or background)
 * silently navigated the hash-SPA even past its first view, and there was no
 * way to exit the app. The dead shell-side handler in apps/mobile/src/setup.ts
 * is NOT wired into the build (capacitor.config.ts never imports it), so this
 * lives in the shared web bundle — registered once at boot from
 * ClientBootHardening, next to the push-registration boot task.
 *
 * Policy (standard Android UX, home-first per Task 2-a):
 *   1. A Radix overlay is open (dialog / alertdialog / menu / listbox /
 *      popover…) → close it with a synthetic Escape, do NOT navigate.
 *   2. Home-first: NOT on the signed-in role's home view → navigate straight
 *      HOME via useAppStore.getState().setView(<home>) instead of stepping
 *      back. The role → home mapping mirrors the store's own
 *      getDefaultViewForRole() (use-app-store.ts):
 *        CUSTOMER → 'customer-home'; AGENCY_STAFF/AGENCY_OWNER →
 *        'agency-dashboard'; SUPER_ADMIN → 'admin-dashboard'.
 *   3. Already AT the role's home view → NON-BLOCKING exit confirm: a sonner
 *      toast ("Press back again to exit" + an explicit Exit action). Pressing
 *      back again within 2.5 s — or tapping the toast action — calls
 *      App.exitApp(). Any navigation re-arms (disarms) the prompt.
 *   4. Legacy step-back (unknown role / store unavailable only):
 *      window.history.back() when the app can step back in its navigation
 *      history. Depth detection, best-first:
 *        a) history.state.idx > 0   (any router that maintains React-Router
 *                                   style idx — forward-compatible)
 *        b) our own hash-depth stack: this app is a hash-SPA (setView ↔
 *           location.hash), so every in-app navigation fires `hashchange`.
 *           We push the hash we leave and pop it when a back completes —
 *           unlike window.history.length (monotonic, never shrinks) this
 *           knows when the user is at the app's ROOT view.
 *      Unknown-role users at the root view fall through to step 3.
 *
 * Design constraints (same rules as push-registration.ts):
 * - SSR-safe: every guard checks `typeof window` first.
 * - ZERO @capacitor imports: @capacitor/* is not installed in apps/web. The
 *   global Capacitor object injected by the native shell is probed via
 *   `(window as any).Capacitor` (@capacitor/app IS bundled in the APK — see
 *   apps/mobile/android/app/capacitor.build.gradle → ':capacitor-app').
 * - Registers the listener at most once per session (module promise guard).
 * - The listener is intentionally never removed: the WebView process owns it
 *   for its whole lifetime (same convention as push-registration).
 * - Browser web / Electron are untouched: the Capacitor.isNativePlatform()
 *   guard returns early (Electron never exposes window.Capacitor).
 * - Registering a `backButton` listener disables Capacitor's default back
 *   handling, so this handler fully owns the button — including the
 *   exit-confirm at the root (default Capacitor would just background/kill).
 *
 * capacitor.config.ts needs NO change: the App plugin block already exists
 * (launchUrl), and `disableBackButtonHandler` stays false so our listener
 * receives the event.
 */

import { toast } from 'sonner';

// ─── Minimal plugin shapes (mirrors @capacitor/app's public API) ────────────

interface BackButtonEventShape {
  /** False when the WebView history stack is on its first entry. */
  canGoBack?: boolean;
}

interface AppPluginShape {
  exitApp?: () => Promise<void>;
  minimizeApp?: () => Promise<void>;
  addListener?: (
    eventName: string,
    listenerFn: (event: BackButtonEventShape) => void,
  ) => Promise<{ remove: () => Promise<void> }>;
}

interface CapacitorShape {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  Plugins?: Record<string, AppPluginShape | undefined>;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Window in which a second back press confirms the exit (ms). */
const EXIT_ARM_MS = 2500;

/** Safety cap for the tracked hash stack (long sessions). */
const MAX_DEPTH = 40;

/** Watchdog that clears the "back in flight" flag if back() fired no event. */
const BACK_WATCHDOG_MS = 1500;

// ─── Module state (one registration per session) ────────────────────────────

let initPromise: Promise<void> | null = null;

/**
 * Hashes we can still return to, most recent last. Kept by observing
 * `hashchange` (the app's setView ↔ location.hash sync fires it on every
 * in-app navigation). Empty stack ⇒ the user is at the app's root view.
 */
let navStack: string[] = [];

/** The hash of the view we are currently on ('' before the first hash). */
let lastHash = '';

/** Set while a handler-initiated history.back() is pending. */
let backInFlight = false;
let backWatchdog: ReturnType<typeof setTimeout> | null = null;

/** Timestamp until which a second back press confirms the exit (0 = unarmed). */
let exitArmedUntil = 0;

// ─── Helpers ────────────────────────────────────────────────────────────────

function hashOf(url: string): string {
  try {
    return new URL(url).hash;
  } catch {
    return typeof window !== 'undefined' ? window.location.hash : '';
  }
}

/**
 * Close the topmost open Radix overlay by synthesizing the Escape keypress
 * Radix's dismissable layer listens for. Returns true when an overlay was
 * found (the back press is then fully consumed).
 */
function closeTopOverlay(): boolean {
  try {
    const open = document.querySelector(
      '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"], [role="listbox"][data-state="open"]',
    );
    if (!open) return false;
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        keyCode: 27,
        bubbles: true,
        cancelable: true,
      }),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort current app language (same priority the app uses: store
 * language → legacy localStorage key → Arabic default). The store is
 * dynamically imported so this module never pulls the zustand graph into its
 * own chunk and cannot create an import cycle.
 */
async function currentLanguage(): Promise<'ar' | 'fr' | 'en'> {
  try {
    const { useAppStore } = await import('@/store/use-app-store');
    const lang = useAppStore.getState().user?.language;
    if (lang === 'ar' || lang === 'fr' || lang === 'en') return lang;
  } catch { /* store unavailable — fall through */ }
  try {
    const stored = localStorage.getItem('blasti-lang');
    if (stored === 'ar' || stored === 'fr' || stored === 'en') return stored;
  } catch { /* storage blocked */ }
  return 'ar';
}

/**
 * Task 2-a home-first policy.
 *
 * Resolves the signed-in role's home view and either navigates to it or
 * reports that the user is already there:
 *   - 'navigated' → setView(home) was called; the back press is consumed.
 *   - 'at-home'   → already on the home view; the caller arms the exit flow.
 *   - 'unknown'   → no usable role (logged out / unrecognized) or the store
 *                   chunk failed to load — the caller falls back to the
 *                   legacy history.back() step.
 *
 * The store is dynamically imported (same rule as currentLanguage()) so this
 * module never pulls the zustand graph into its own chunk and cannot create
 * an import cycle. The store's `currentView` is the SPA's own source of
 * truth — kept in lockstep with location.hash by setView →
 * updateHashForView() (use-app-store.ts) and by the auth-provider's
 * hashchange listener → setViewFromHash().
 */
type HomeFirstOutcome = 'navigated' | 'at-home' | 'unknown';

async function homeFirstPolicy(): Promise<HomeFirstOutcome> {
  try {
    const { useAppStore } = await import('@/store/use-app-store');
    const store = useAppStore.getState();

    // Role → home view. Mirrors getDefaultViewForRole() in use-app-store.ts
    // (the exact ViewNames the store navigates to after each role's login).
    let home: 'customer-home' | 'agency-dashboard' | 'admin-dashboard';
    switch (store.user?.role) {
      case 'AGENCY_STAFF':
      case 'AGENCY_OWNER':
        home = 'agency-dashboard';
        break;
      case 'SUPER_ADMIN':
        home = 'admin-dashboard';
        break;
      case 'CUSTOMER':
        home = 'customer-home';
        break;
      default:
        return 'unknown';
    }

    if (store.currentView === home) return 'at-home';

    // Zustand action, safe outside React: updates currentView AND syncs
    // location.hash via updateHashForView() — the whole SPA follows.
    store.setView(home);
    return 'navigated';
  } catch {
    return 'unknown'; // store chunk unavailable — legacy behavior
  }
}

/** Fire-and-forget native exit — the only sanctioned way to close the shell. */
function exitApp(plugin: AppPluginShape): void {
  if (typeof plugin.exitApp === 'function') {
    Promise.resolve(plugin.exitApp()).catch((error) => {
      console.warn('[NativeBack] exitApp() failed:', error);
    });
  } else {
    console.warn('[NativeBack] App.exitApp() unavailable on this shell');
  }
}

/** Non-blocking exit confirm: toast + "back again" / explicit Exit action. */
async function requestExitConfirmation(plugin: AppPluginShape): Promise<void> {
  if (Date.now() < exitArmedUntil) {
    exitApp(plugin);
    return;
  }
  exitArmedUntil = Date.now() + EXIT_ARM_MS;

  const lang = await currentLanguage();
  const messages: Record<'ar' | 'fr' | 'en', { message: string; action: string }> = {
    ar: { message: 'اضغط زر الرجوع مرة أخرى للخروج من التطبيق', action: 'خروج' },
    fr: { message: 'Appuyez à nouveau sur Retour pour quitter l\u2019application', action: 'Quitter' },
    en: { message: 'Press back again to exit the app', action: 'Exit' },
  };
  const text = messages[lang];

  try {
    toast(text.message, {
      id: 'blasti-exit-arm',
      duration: EXIT_ARM_MS,
      action: {
        label: text.action,
        onClick: () => exitApp(plugin),
      },
    });
  } catch {
    // Toaster not mounted (e.g. boot gate) or sonner failed — fall back to
    // the WebView's native confirm dialog so the user is never without an
    // explicit confirmation before the app closes.
    if (window.confirm(`${text.message} (${text.action}?)`)) {
      exitApp(plugin);
    }
  }
}

// ─── Init ────────────────────────────────────────────────────────────────────

/**
 * Register the hardware back-button handler from inside the web app.
 *
 * Safe to call from any client component effect (ClientBootHardening does it
 * once at boot): on plain browsers and Electron it is a no-op (Capacitor
 * absent or not native). Inside the Capacitor WebView it wires the
 * step-back/exit policy described in the header comment.
 *
 * Runs at most once per session; repeat calls return the same promise.
 */
export function initNativeBackHandler(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const capacitor = (window as any).Capacitor as CapacitorShape | undefined;

    // Guard: only inside the Capacitor native shell (browser web + Electron
    // never reach this — Electron has no window.Capacitor at all).
    if (!capacitor || typeof capacitor.isNativePlatform !== 'function' || !capacitor.isNativePlatform()) {
      return;
    }

    const plugin = capacitor.Plugins?.App;
    if (!plugin || typeof plugin.addListener !== 'function') {
      console.warn('[NativeBack] Capacitor App plugin not available on this shell — hardware back keeps the shell default');
      return;
    }

    // ── Track the hash-SPA navigation depth ───────────────────────────────
    lastHash = window.location.hash;

    window.addEventListener('hashchange', (event: HashChangeEvent) => {
      const to = hashOf(event.newURL);

      // Any fresh navigation disarms a pending exit confirmation.
      exitArmedUntil = 0;

      if (backInFlight) {
        // This hashchange is the completion of OUR history.back() — the
        // stack shrinks (nothing is added). No in-app navigation can
        // interleave here: JS is single-threaded and the back's hashchange
        // always fires before any later user action.
        if (navStack.length > 0) navStack.pop();
      } else {
        // Forward navigation: remember the hash we just left.
        navStack.push(lastHash);
        if (navStack.length > MAX_DEPTH) navStack.shift();
      }
      lastHash = to;
    });

    // ── Own the hardware back button (Android; the event never fires on iOS)
    await plugin.addListener('backButton', async (event: BackButtonEventShape) => {
      try {
        // 1. An overlay (dialog / menu / select…) is open → close it instead
        //    of navigating behind it.
        if (closeTopOverlay()) return;

        // 2. Home-first (Task 2-a): a back press with nothing to dismiss
        //    takes the user to their role's home view. At the home view
        //    itself the press goes straight to the exit confirmation (3).
        //    'unknown' (logged out / store unavailable) → legacy step-back.
        const homeStep = await homeFirstPolicy();
        if (homeStep === 'navigated') return;
        if (homeStep === 'at-home') {
          void requestExitConfirmation(plugin);
          return;
        }

        // 4. Legacy step-back (unknown role only): step back when the app
        //    has somewhere to go back to.
        const state = window.history.state as { idx?: number } | null;
        const idx = typeof state?.idx === 'number' ? state.idx : undefined;
        const nativeSaysRoot = event?.canGoBack === false;
        const hasRouterDepth = typeof idx === 'number' && idx > 0;
        const hasSpaDepth = navStack.length > 0;

        if (!nativeSaysRoot && (hasRouterDepth || hasSpaDepth)) {
          backInFlight = true;
          if (backWatchdog) clearTimeout(backWatchdog);
          // If back() produced no hashchange (same-hash entry), the watchdog
          // clears the flag so a later real navigation is not miscounted.
          backWatchdog = setTimeout(() => { backInFlight = false; }, BACK_WATCHDOG_MS);
          window.history.back();
          return;
        }

        // At the root view → non-blocking confirm, then exit.
        void requestExitConfirmation(plugin);
      } catch (error) {
        // The back handler must never throw into the native bridge.
        console.warn('[NativeBack] backButton handling failed:', error);
      }
    });

    console.log('[NativeBack] Hardware back handler registered (Capacitor shell)');
  })();

  return initPromise;
}
