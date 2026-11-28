package com.blasti.mobile;

import android.content.Intent;
import android.os.Build;
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

    /** Extra set by BlastiFirebaseMessagingService on the turn-call launch
     *  intent (content intent + full-screen intent): marks this launch as a
     *  CALL — MainActivity temporarily applies setShowWhenLocked(true) +
     *  setTurnScreenOn(true) so the call layout renders over the keyguard
     *  (the incoming-call experience), while every other launch keeps the
     *  safe pref-driven defaults (never show over the lock screen). */
    private static final String EXTRA_FROM_TURN_CALL = "blastiFromTurnCall";

    /** True while the activity is resumed — BlastiFirebaseMessagingService
     *  consults it, plus the notification dedupe, to avoid double alerts. */
    private static volatile boolean appInForeground = false;

    public static boolean isAppForeground() {
        return appInForeground;
    }

    /** 0.6.127 APK build fix: Capacitor 8.5.x BridgeActivity declares
     *  onResume()/onPause() as PUBLIC (BridgeActivity.java:94/104). The
     *  previous protected overrides assigned weaker access privileges and
     *  failed :app:compileDebugJavaWithJavac on CI ("attempting to assign
     *  weaker access privileges; was public"). onNewIntent stays protected
     *  (matches BridgeActivity's protected declaration). */
    @Override
    public void onResume() {
        super.onResume();
        appInForeground = true;
    }

    @Override
    public void onPause() {
        appInForeground = false;
        super.onPause();
    }

    /**
     * 0.6.126 — per-launch flags: a turn-CALL launch (notification tap or
     * full-screen intent carrying EXTRA_FROM_TURN_CALL) may render over the
     * keyguard (incoming-call UX); every other launch keeps the safe
     * pref-driven default (never show over the lock screen — the original
     * "whole app on the lock screen" field bug stays fixed). Best-effort:
     * setShowWhenLocked/setTurnScreenOn exist from API 27.
     */
    private void applyLaunchFlagsForIntent(Intent intent) {
        boolean isTurnCallLaunch = intent != null
            && intent.getBooleanExtra(EXTRA_FROM_TURN_CALL, false);
        if (isTurnCallLaunch && Build.VERSION.SDK_INT >= 27) {
            try {
                setShowWhenLocked(true);
                setTurnScreenOn(true);
            } catch (Throwable t) {
                Log.w(TAG, "applyTurnCallLaunchFlags failed", t);
            }
        } else {
            BlastiNativeStatus.applyLaunchPreferences(this);
        }
    }

    /** singleTask re-launch (app already running when the call notification
     *  is tapped) — same per-launch flag application as onCreate. */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        applyLaunchFlagsForIntent(intent);
    }

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
        //      - Create the notification channels (blasti-lockscreen-v2,
        //        blasti-turn-alert-v2, blasti-general) so FCM background pushes
        //        and the web layer's notifications land on high-importance
        //        PUBLIC channels even when the app was cold-started by a push.
        //      - Apply the persisted lockscreenTakeover preference
        //        (DEFAULT false → setShowWhenLocked(false)/setTurnScreenOn(false):
        //        the app NEVER renders over the keyguard — full separation,
        //        only the notification shows on the lock screen; the static
        //        showWhenLocked/turnScreenOn manifest attributes were removed
        //        for exactly this reason).
        //      - EXCEPTION (0.6.126): a turn-CALL launch (notification tap /
        //        full-screen intent carrying EXTRA_FROM_TURN_CALL) applies
        //        show-when-locked so the call layout renders over the keyguard
        //        — the incoming-call experience the user opted into by
        //        triggering the call notification flow.
        applyLaunchFlagsForIntent(getIntent());

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
