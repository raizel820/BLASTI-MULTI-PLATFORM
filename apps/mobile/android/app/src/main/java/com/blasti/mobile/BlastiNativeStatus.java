package com.blasti.mobile;

import android.content.Context;
import android.util.Log;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.lang.reflect.Method;
import java.util.List;

/**
 * BLASTI Native Status — exposes build/runtime status flags to the web app.
 *
 * WHY THIS PLUGIN EXISTS (Android crash fix, Sept 2026)
 * ─────────────────────────────────────────────────────────────────────
 * Without android/app/google-services.json the google-services Gradle plugin
 * is skipped (see the try/catch at the bottom of app/build.gradle), so
 * Firebase is never initialized in the app process. The web layer then calls
 * PushNotifications.register() on boot (apps/web/src/lib/push-registration.ts),
 * and the Capacitor plugin does:
 *
 *     FirebaseMessaging.getInstance()  ← throws IllegalStateException
 *         "Default FirebaseApp is not initialized in this process"
 *
 * Because that throws on the CapacitorPlugins HandlerThread, the whole
 * process died with a FATAL EXCEPTION on every launch where the
 * POST_NOTIFICATIONS permission had already been granted (seen 8× in the
 * uploaded logcat).
 *
 * This plugin fixes the native side of that failure mode:
 *   1. initializeFirebase() installs a PLACEHOLDER default FirebaseApp when
 *      google-services.json is absent, so register() degrades to an async
 *      registrationError event instead of throwing. With google-services.json
 *      present it is a no-op (FirebaseInitProvider already initialized the
 *      real app).
 *   2. isFirebaseReady() lets the web layer detect an unconfigured Firebase
 *      and skip the FCM flow entirely (no pointless permission prompt).
 *
 * All Firebase access is reflective so this class never needs a compile-time
 * dependency on Firebase (the push plugin provides the classes at runtime).
 */
@CapacitorPlugin(name = "BlastiNativeStatus")
public class BlastiNativeStatus extends Plugin {

    private static final String TAG = "BLASTI";

    /** Exact message fragment thrown by FirebaseApp.getInstance() when uninitialized. */
    static final String FIREBASE_MISSING_MESSAGE = "Default FirebaseApp is not initialized";

    /** tri-state: null = not yet probed, true = real config, false = placeholder/absent. */
    private static volatile Boolean firebaseReady = null;

    // ─── Static API (used by MainActivity) ──────────────────────────────────────

    /**
     * True when a REAL Firebase configuration is present in this build
     * (google-services.json compiled in and auto-initialized).
     * A placeholder app installed by {@link #initializeFirebase} does NOT count.
     */
    public static boolean isFirebaseInitialized() {
        return Boolean.TRUE.equals(firebaseReady);
    }

    /**
     * Ensure a default FirebaseApp exists in this process.
     *
     * <ul>
     *   <li>Real build (google-services.json): the auto-init provider already
     *       created it — this verifies and reports ready.</li>
     *   <li>Unconfigured build: installs a placeholder app so that a stray
     *       PushNotifications.register() call fails ASYNC (registrationError)
     *       instead of throwing on the CapacitorPlugins thread and killing
     *       the process.</li>
     * </ul>
     *
     * Safe to call multiple times; the probe runs at most once.
     */
    public static void initializeFirebase(Context context) {
        if (firebaseReady != null) {
            return;
        }
        synchronized (BlastiNativeStatus.class) {
            if (firebaseReady != null) {
                return;
            }
            firebaseReady = tryInitializeFirebase(context);
        }
    }

    /**
     * Matches the exact "Default FirebaseApp is not initialized" failure chain
     * (wrapped by InvocationTargetException / RuntimeException by reflection
     * and the Capacitor bridge). Used by MainActivity's crash guard.
     */
    static boolean isFirebaseNotInitializedError(Throwable error) {
        Throwable current = error;
        while (current != null) {
            if (current instanceof IllegalStateException) {
                String message = current.getMessage();
                if (message != null && message.contains(FIREBASE_MISSING_MESSAGE)) {
                    return true;
                }
            }
            current = current.getCause();
        }
        return false;
    }

    // ─── Plugin Methods (callable from the web app) ─────────────────────────────

    /**
     * Reports whether FCM push is usable in this build. The web app's
     * push-registration.ts queries this before touching PushNotifications so
     * an unconfigured build skips the FCM flow gracefully.
     */
    @PluginMethod
    public void isFirebaseReady(PluginCall call) {
        JSObject result = new JSObject();
        boolean ready = isFirebaseInitialized();
        result.put("ready", ready);
        result.put(
            "reason",
            ready
                ? "ok"
                : "google-services.json is missing from android/app/ — FCM push disabled"
        );
        call.resolve(result);
    }

    // ─── Internals ──────────────────────────────────────────────────────────────

    private static boolean tryInitializeFirebase(Context context) {
        try {
            Class<?> firebaseAppClass = Class.forName("com.google.firebase.FirebaseApp");

            // getApps(context) → List<FirebaseApp>
            Method getApps = firebaseAppClass.getMethod("getApps", Context.class);
            List<?> apps = (List<?>) getApps.invoke(null, context);
            if (apps != null && !apps.isEmpty()) {
                Log.i(TAG, "Firebase default app present — FCM push available");
                return true;
            }

            // google-services.json was NOT compiled into this build. Install a
            // placeholder default app so getInstance() never throws. FCM token
            // requests against the placeholder fail asynchronously and surface
            // as the standard 'registrationError' push event in the web layer.
            Log.w(
                TAG,
                "google-services.json missing — installing placeholder Firebase app so push "
                    + "registration degrades gracefully instead of crashing the app. "
                    + "FCM push stays disabled until android/app/google-services.json is added."
            );

            Class<?> optionsClass = Class.forName("com.google.firebase.FirebaseOptions");
            Class<?> builderClass = Class.forName("com.google.firebase.FirebaseOptions$Builder");
            Object builder = builderClass.getDeclaredConstructor().newInstance();
            builder = builderClass
                .getMethod("setApplicationId", String.class)
                .invoke(builder, "1:000000000000:android:0000000000000000000000");
            builder = builderClass
                .getMethod("setApiKey", String.class)
                .invoke(builder, "BLASTI-FIREBASE-NOT-CONFIGURED");
            builder = builderClass
                .getMethod("setProjectId", String.class)
                .invoke(builder, "blasti-unconfigured");
            builder = builderClass
                .getMethod("setGcmSenderId", String.class)
                .invoke(builder, "000000000000");
            Object options = builderClass.getMethod("build").invoke(builder);

            Method initializeApp = firebaseAppClass.getMethod(
                "initializeApp",
                Context.class,
                optionsClass
            );
            Object app = initializeApp.invoke(null, context, options);
            return app != null;
        } catch (Throwable t) {
            // Firebase classes not on the classpath at all (push plugin absent?)
            // — nothing we can do natively; the web layer also guards its side.
            Log.w(TAG, "Firebase unavailable on the classpath — FCM push disabled", t);
            return false;
        }
    }
}
