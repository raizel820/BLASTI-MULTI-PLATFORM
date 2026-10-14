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

    /** Fixed file name for downloaded update APKs (external files /Download). */
    private static final String UPDATE_APK_NAME = "blasti-update.apk";

    /** DownloadManager id of the running/last update APK download. */
    private volatile long lastUpdateDownloadId = 0;

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

    /**
     * Stable device identity for install tracking (Public App Settings).
     *
     * Returns the Widevine MediaDrm device ID — an OS-level identity that
     * SURVIVES uninstall → reinstall cycles and needs NO runtime permission.
     * ANDROID_ID alone is regenerated on every reinstall (Android 8+), so it
     * is only a last-resort fallback: the cloud dedupes devices by the hash
     * of this value, so a stable source here is what keeps one physical
     * phone counted exactly once.
     *
     * Also returns the app's own versionName so the phone reports the exact
     * installed version for per-version active-device tracking.
     */
    @PluginMethod
    public void getStableDeviceId(PluginCall call) {
        JSObject result = new JSObject();
        String stableId = "";
        String source = "unavailable";
        try {
            // Widevine UUID: edef8ba9-79d6-4ace-a3c8-27dcd51d21ed
            java.util.UUID WIDEVINE_UUID = new java.util.UUID(0xEDEF8BA979D64ACEL, 0xA3C827DCD51D21EDL);
            android.media.MediaDrm mediaDrm = new android.media.MediaDrm(WIDEVINE_UUID);
            // PROPERTY_DEVICE_UNIQUE_ID is the real MediaDrm constant (API 18+);
            // PROPERTY_DEVICE_ID does not exist and broke compileDebugJavaWithJavac.
            byte[] drmId = mediaDrm.getPropertyByteArray(android.media.MediaDrm.PROPERTY_DEVICE_UNIQUE_ID);
            mediaDrm.release();
            StringBuilder hex = new StringBuilder(drmId.length * 2);
            for (byte b : drmId) {
                hex.append(Character.forDigit((b >> 4) & 0xF, 16));
                hex.append(Character.forDigit(b & 0xF, 16));
            }
            stableId = hex.toString();
            source = "mediadrm-widevine";
        } catch (Throwable t) {
            Log.w(TAG, "Widevine device id unavailable — falling back to ANDROID_ID", t);
        }
        if (stableId.isEmpty()) {
            try {
                String androidId = android.provider.Settings.Secure.getString(
                    getContext().getContentResolver(),
                    android.provider.Settings.Secure.ANDROID_ID
                );
                if (androidId != null && !androidId.isEmpty()) {
                    stableId = androidId;
                    source = "android-id";
                }
            } catch (Throwable t2) {
                Log.w(TAG, "ANDROID_ID unavailable too", t2);
            }
        }
        result.put("deviceId", stableId);
        result.put("source", source);
        try {
            android.content.pm.PackageInfo pi = getContext().getPackageManager()
                .getPackageInfo(getContext().getPackageName(), 0);
            result.put("appVersion", pi.versionName);
        } catch (Throwable t) {
            // version reporting is best-effort
        }
        call.resolve(result);
    }

    // ─── App Update Delivery (Public App Settings → Android client) ──────────

    /**
     * Real installed version for update checks. The web bundle ships a stale
     * hardcoded APP_VERSION, so update checks on Android MUST use this.
     */
    @PluginMethod
    public void getAppInfo(PluginCall call) {
        JSObject result = new JSObject();
        try {
            android.content.pm.PackageInfo pi = getContext().getPackageManager()
                .getPackageInfo(getContext().getPackageName(), 0);
            result.put("versionName", pi.versionName == null ? "" : pi.versionName);
            long code = android.os.Build.VERSION.SDK_INT >= 28
                ? pi.getLongVersionCode()
                : pi.versionCode;
            result.put("versionCode", code);
        } catch (Throwable t) {
            Log.w(TAG, "getAppInfo failed", t);
            call.reject("unavailable", t.getMessage());
            return;
        }
        call.resolve(result);
    }

    /**
     * Connection classification for "auto-download only on Wi-Fi":
     * { connectionType: wifi|cellular|ethernet|vpn|none|unknown,
     *   isWifi, isUnmetered } — ACCESS_NETWORK_STATE is already granted.
     */
    @PluginMethod
    public void getNetworkInfo(PluginCall call) {
        JSObject result = new JSObject();
        String connectionType = "unknown";
        boolean isWifi = false;
        boolean isUnmetered = false;
        try {
            android.net.ConnectivityManager cm = (android.net.ConnectivityManager)
                getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm != null) {
                android.net.Network active = cm.getActiveNetwork();
                if (active == null) {
                    connectionType = "none";
                } else {
                    android.net.NetworkCapabilities caps = cm.getNetworkCapabilities(active);
                    if (caps != null) {
                        if (caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI)) {
                            connectionType = "wifi";
                            isWifi = true;
                        } else if (caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_CELLULAR)) {
                            connectionType = "cellular";
                        } else if (caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_ETHERNET)) {
                            connectionType = "ethernet";
                            isWifi = true;
                        } else if (caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_VPN)) {
                            // VPN: the underlying transports are folded in on
                            // modern Android; when they are not, don't block.
                            connectionType = "vpn";
                            isWifi = true;
                        }
                        isUnmetered = caps.hasCapability(
                            android.net.NetworkCapabilities.NET_CAPABILITY_NOT_METERED);
                    }
                }
            }
        } catch (Throwable t) {
            Log.w(TAG, "getNetworkInfo failed", t);
        }
        result.put("connectionType", connectionType);
        result.put("isWifi", isWifi);
        result.put("isUnmetered", isUnmetered);
        call.resolve(result);
    }

    /**
     * Enqueue the update APK in the system DownloadManager (handles progress,
     * retries and a notification; honours the app's cleartext policy for the
     * VPS). Resolves { downloadId } — poll getDownloadProgress with it.
     */
    @PluginMethod
    public void downloadUpdate(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.trim().isEmpty()) {
            call.reject("missing-url");
            return;
        }
        try {
            android.app.DownloadManager dm = (android.app.DownloadManager)
                getContext().getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm == null) {
                call.reject("download-manager-unavailable");
                return;
            }
            // One update APK at a time: drop the previous entry + file so the
            // DownloadManager never "renames" to blasti-update-1.apk.
            if (lastUpdateDownloadId > 0) {
                try { dm.remove(lastUpdateDownloadId); } catch (Throwable ignored) { }
                lastUpdateDownloadId = 0;
            }
            try {
                java.io.File old = new java.io.File(getContext().getExternalFilesDir(
                    android.os.Environment.DIRECTORY_DOWNLOADS), UPDATE_APK_NAME);
                if (old.exists()) old.delete();
            } catch (Throwable ignored) { }

            android.app.DownloadManager.Request req = new android.app.DownloadManager.Request(android.net.Uri.parse(url.trim()));
            String version = call.getString("version");
            req.setTitle("BLASTI " + (version == null ? "" : version).trim());
            req.setDescription("BLASTI app update");
            req.setMimeType("application/vnd.android.package-archive");
            req.setNotificationVisibility(android.app.DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            req.setDestinationInExternalFilesDir(getContext(),
                android.os.Environment.DIRECTORY_DOWNLOADS, UPDATE_APK_NAME);
            long id = dm.enqueue(req);
            lastUpdateDownloadId = id;
            JSObject result = new JSObject();
            result.put("downloadId", id);
            call.resolve(result);
        } catch (Throwable t) {
            Log.w(TAG, "downloadUpdate failed", t);
            call.reject("download-failed", t.getMessage());
        }
    }

    /**
     * Poll download status: { status: pending|running|paused|successful|failed,
     * bytesSoFar, totalBytes, percent, localUri, reason }.
     */
    @PluginMethod
    public void getDownloadProgress(PluginCall call) {
        Object raw = call.getData() == null ? null : call.getData().opt("downloadId");
        long id = raw instanceof Number ? ((Number) raw).longValue() : -1;
        JSObject result = new JSObject();
        if (id <= 0) {
            result.put("status", "unknown");
            call.resolve(result);
            return;
        }
        try {
            android.app.DownloadManager dm = (android.app.DownloadManager)
                getContext().getSystemService(Context.DOWNLOAD_SERVICE);
            android.database.Cursor cur = dm.query(
                new android.app.DownloadManager.Query().setFilterById(id));
            if (cur != null && cur.moveToFirst()) {
                int status = cur.getInt(
                    cur.getColumnIndexOrThrow(android.app.DownloadManager.COLUMN_STATUS));
                int bytes = cur.getInt(cur.getColumnIndexOrThrow(
                    android.app.DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));
                int total = cur.getInt(cur.getColumnIndexOrThrow(
                    android.app.DownloadManager.COLUMN_TOTAL_SIZE_BYTES));
                String localUri = "";
                try {
                    localUri = cur.getString(cur.getColumnIndexOrThrow(
                        android.app.DownloadManager.COLUMN_LOCAL_URI));
                } catch (Throwable ignored) { }
                int reason = 0;
                try {
                    reason = cur.getInt(cur.getColumnIndexOrThrow(
                        android.app.DownloadManager.COLUMN_REASON));
                } catch (Throwable ignored) { }
                String statusStr;
                switch (status) {
                    case android.app.DownloadManager.STATUS_SUCCESSFUL: statusStr = "successful"; break;
                    case android.app.DownloadManager.STATUS_FAILED:      statusStr = "failed"; break;
                    case android.app.DownloadManager.STATUS_PAUSED:      statusStr = "paused"; break;
                    case android.app.DownloadManager.STATUS_PENDING:     statusStr = "pending"; break;
                    case android.app.DownloadManager.STATUS_RUNNING:     statusStr = "running"; break;
                    default:                                             statusStr = "unknown";
                }
                int percent = total > 0 ? Math.min(100, (int) Math.round(bytes * 100.0 / total)) : 0;
                result.put("status", statusStr);
                result.put("bytesSoFar", bytes);
                result.put("totalBytes", Math.max(total, 0));
                result.put("percent", percent);
                result.put("localUri", localUri == null ? "" : localUri);
                result.put("reason", reason);
            } else {
                result.put("status", "unknown");
            }
            if (cur != null) cur.close();
        } catch (Throwable t) {
            Log.w(TAG, "getDownloadProgress failed", t);
            result.put("status", "unknown");
        }
        call.resolve(result);
    }

    /**
     * Open the downloaded APK in the system package installer. Needs the
     * REQUEST_INSTALL_PACKAGES permission (declared in the manifest); on
     * first use Android 8+ shows its own "allow from this source" screen —
     * when that blocks us we open the settings screen and reject with
     * needs-install-permission so the web layer can guide the user.
     */
    @PluginMethod
    public void installUpdate(PluginCall call) {
        Object raw = call.getData() == null ? null : call.getData().opt("downloadId");
        long id = raw instanceof Number ? ((Number) raw).longValue() : -1;
        String filePath = call.getString("filePath");
        try {
            if (filePath == null || filePath.trim().isEmpty()) {
                android.app.DownloadManager dm = (android.app.DownloadManager)
                    getContext().getSystemService(Context.DOWNLOAD_SERVICE);
                android.database.Cursor cur = dm.query(
                    new android.app.DownloadManager.Query().setFilterById(id));
                if (cur != null && cur.moveToFirst()) {
                    try {
                        String direct = cur.getString(cur.getColumnIndexOrThrow(
                            android.app.DownloadManager.COLUMN_LOCAL_FILENAME));
                        if (direct != null && !direct.isEmpty()) {
                            filePath = direct;
                        }
                    } catch (Throwable ignored) { }
                    if (filePath == null || filePath.isEmpty()) {
                        String uriStr = cur.getString(cur.getColumnIndexOrThrow(
                            android.app.DownloadManager.COLUMN_LOCAL_URI));
                        if (uriStr != null && uriStr.startsWith("file:")) {
                            filePath = android.net.Uri.parse(uriStr).getPath();
                        }
                    }
                }
                if (cur != null) cur.close();
            }
            if (filePath == null || filePath.isEmpty()) {
                call.reject("apk-not-found");
                return;
            }
            java.io.File apk = new java.io.File(filePath);
            if (!apk.exists()) {
                call.reject("apk-not-found");
                return;
            }
            android.net.Uri apkUri = androidx.core.content.FileProvider.getUriForFile(
                getContext(), getContext().getPackageName() + ".fileprovider", apk);
            android.content.Intent intent = new android.content.Intent(android.content.Intent.ACTION_VIEW);
            intent.setDataAndType(apkUri, "application/vnd.android.package-archive");
            intent.addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION
                | android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
            try {
                getContext().startActivity(intent);
            } catch (Throwable act) {
                if (android.os.Build.VERSION.SDK_INT >= 26) {
                    try {
                        android.content.Intent settings = new android.content.Intent(
                            android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                            android.net.Uri.parse("package:" + getContext().getPackageName()));
                        settings.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                        getContext().startActivity(settings);
                    } catch (Throwable ignored) { }
                }
                call.reject("needs-install-permission", act.getMessage());
                return;
            }
            JSObject result = new JSObject();
            result.put("ok", true);
            call.resolve(result);
        } catch (Throwable t) {
            Log.w(TAG, "installUpdate failed", t);
            call.reject("install-failed", t.getMessage());
        }
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
