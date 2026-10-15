package com.blasti.mobile;

import android.os.Bundle;
import android.util.Log;
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
