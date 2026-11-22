package com.blasti.mobile;

import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    private static final String TAG = "BLASTI";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 1) Crash guard — installed FIRST, before any plugin call can happen.
        //    A build without google-services.json must never die from a stray
        //    PushNotifications.register() ("Default FirebaseApp is not
        //    initialized" FATAL EXCEPTION — seen 8× in the Sept 2026 logcat).
        installFirebaseCrashGuard();

        // 2) Expose native status flags (e.g. Firebase readiness) to the web
        //    layer. Must be registered BEFORE super.onCreate() so the bridge
        //    picks it up while building the WebView runtime.
        registerPlugin(BlastiNativeStatus.class);

        super.onCreate(savedInstanceState);

        // 3) Defensive Firebase initialization:
        //      - google-services.json present  → no-op (already initialized),
        //        reports firebaseReady=true so the web layer enables FCM.
        //      - google-services.json missing → installs a placeholder app so
        //        register() fails asynchronously (registrationError) instead
        //        of throwing; reports firebaseReady=false so the web layer
        //        skips the FCM flow entirely.
        BlastiNativeStatus.initializeFirebase(this);

        // 4) Boot-time native prep, web-independent:
        //      - Create the notification channels (blasti-lockscreen,
        //        blasti-turn-alert, blasti-general) so FCM background pushes
        //        and the web layer's notifications land on high-importance
        //        PUBLIC channels even when the app was cold-started by a push.
        //      - Apply the persisted lockscreenTakeover preference
        //        (DEFAULT false → setShowWhenLocked(false)/setTurnScreenOn(false):
        //        the app NEVER renders over the keyguard — full separation,
        //        only the notification shows on the lock screen; the static
        //        showWhenLocked/turnScreenOn manifest attributes were removed
        //        for exactly this reason).
        BlastiNativeStatus.applyLaunchPreferences(this);

        // 5) 0.6.104 — SYSTEM BAR INSETS (user fault: "the app behaves as if
        //    it is always in full-screen — it covers the system data in the
        //    top bar (time, battery, date, signals) and the navigation
        //    buttons at the bottom"). With targetSdk 36 edge-to-edge is
        //    ENFORCED, so the WebView drew UNDER the status bar and the
        //    navigation bar. Capacitor 8.5.2 ships no margin adjustment for
        //    that, so we apply the system-bar + display-cutout insets as
        //    MARGINS on the WebView ourselves: the app content starts below
        //    the status bar and ends above the navigation bar — the clock,
        //    battery, date, signal icons and the back/home buttons stay
        //    permanently visible. The listener re-fires on rotation and
        //    foldable posture changes, keeping the margins correct.
        applySystemBarInsets();
    }

    /**
     * 0.6.104 — inset the WebView by the system bars (status + navigation)
     * and the display cutout. Margins (not padding) are used because the
     * Android WebView ignores padding for page layout. Best-effort: any
     * failure only degrades to the previous edge-to-edge behavior.
     */
    private void applySystemBarInsets() {
        try {
            BridgeActivity activity = this;
            WebView webView = activity.getBridge() != null ? activity.getBridge().getWebView() : null;
            if (webView == null) {
                Log.w(TAG, "applySystemBarInsets: WebView not ready");
                return;
            }
            final View webViewView = webView;
            ViewCompat.setOnApplyWindowInsetsListener(webViewView, (v, windowInsets) -> {
                Insets bars = windowInsets.getInsets(
                        WindowInsetsCompat.Type.systemBars()
                                | WindowInsetsCompat.Type.displayCutout());
                ViewGroup.LayoutParams lpRaw = v.getLayoutParams();
                if (lpRaw instanceof ViewGroup.MarginLayoutParams) {
                    ViewGroup.MarginLayoutParams lp = (ViewGroup.MarginLayoutParams) lpRaw;
                    if (lp.leftMargin != bars.left || lp.topMargin != bars.top
                            || lp.rightMargin != bars.right || lp.bottomMargin != bars.bottom) {
                        lp.setMargins(bars.left, bars.top, bars.right, bars.bottom);
                        v.setLayoutParams(lp);
                    }
                }
                // Consume: no descendant needs the raw insets again.
                return WindowInsetsCompat.CONSUMED;
            });
            // Request a dispatch pass now that the listener is attached.
            ViewCompat.requestApplyInsets(webViewView);
        } catch (Throwable t) {
            Log.w(TAG, "applySystemBarInsets failed (non-fatal)", t);
        }
    }

    /**
     * Last-resort safety net: swallow ONLY the exact "Default FirebaseApp is
     * not initialized" failure chain, delegate everything else to the platform
     * handler so real bugs still crash loudly.
     *
     * In practice the two layers above (placeholder FirebaseApp + the web
     * layer's isFirebaseReady() check) make this guard almost unreachable —
     * it exists so a stale cached web bundle on an unconfigured build can at
     * worst degrade native plugins for one session instead of hard-crashing
     * in a loop on every launch.
     */
    private void installFirebaseCrashGuard() {
        final Thread.UncaughtExceptionHandler previous =
            Thread.getDefaultUncaughtExceptionHandler();

        Thread.setDefaultUncaughtExceptionHandler((thread, throwable) -> {
            if (BlastiNativeStatus.isFirebaseNotInitializedError(throwable)) {
                Log.e(
                    TAG,
                    "Push registration skipped: Firebase is not configured in this build "
                        + "(google-services.json missing from android/app/). "
                        + "FCM push stays disabled; the app keeps running.",
                    throwable
                );
                return;
            }
            if (previous != null) {
                previous.uncaughtException(thread, throwable);
            } else {
                System.exit(2);
            }
        });
    }
}
