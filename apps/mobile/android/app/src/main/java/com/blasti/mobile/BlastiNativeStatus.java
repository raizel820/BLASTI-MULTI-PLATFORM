package com.blasti.mobile;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
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

    // ─── Update-install permission ladder state (0.6.17 install-loop fix) ────
    // Field report (Xiaomi / Android 16): after the proactive gate opens the
    // "Install unknown apps" screen and the user enables the toggle (or it
    // was ALREADY enabled), returning to the app resumed NOTHING — and every
    // further "Install now" tap bounced back to the same settings screen
    // forever, because canRequestPackageInstalls() kept answering false on
    // that build. The ladder below makes the loop STRUCTURALLY impossible:
    //
    //   tap 1 → gate fails → open settings ONCE (state saved)
    //   resume → permission granted? → auto-launch the installer
    //   tap 2 → gate STILL fails → NEVER open settings again; fire the
    //           ACTION_VIEW installer intent directly. The system installer
    //           runs its own inline grant flow whose SETTINGS button returns
    //           to the INSTALLER (not to our app) and the install continues
    //           automatically — the self-resuming path stock Android has
    //           always had.

    /** Prefs file holding the pending-install ladder state. */
    private static final String UPDATE_PREFS = "blasti-update";
    /** Absolute path of the APK waiting for its post-settings resume launch. */
    private static final String KEY_PENDING_APK = "pendingInstallApkPath";
    /** How many times the gate has opened the settings screen for this APK. */
    private static final String KEY_SETTINGS_OPENS = "installSettingsOpens";

    private android.content.SharedPreferences updatePrefs() {
        return getContext().getSharedPreferences(UPDATE_PREFS, Context.MODE_PRIVATE);
    }

    private boolean canRequestInstalls() {
        if (android.os.Build.VERSION.SDK_INT < 26) return true;
        try {
            return getContext().getPackageManager().canRequestPackageInstalls();
        } catch (Throwable ignored) {
            return false;
        }
    }

    /**
     * Launch the system package installer for the given APK. Returns true
     * when startActivity did not throw (the installer — or its inline
     * grant flow — is now on screen).
     */
    private static boolean launchInstaller(Context ctx, String filePath) {
        try {
            java.io.File apk = new java.io.File(filePath);
            if (!apk.exists()) return false;
            android.net.Uri apkUri = androidx.core.content.FileProvider.getUriForFile(
                ctx, ctx.getPackageName() + ".fileprovider", apk);
            android.content.Intent intent = new android.content.Intent(android.content.Intent.ACTION_VIEW);
            intent.setDataAndType(apkUri, "application/vnd.android.package-archive");
            intent.addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION
                | android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(intent);
            return true;
        } catch (Throwable t) {
            Log.w(TAG, "launchInstaller failed", t);
            return false;
        }
    }

    private void clearPendingInstallState() {
        try {
            updatePrefs().edit().remove(KEY_PENDING_APK).remove(KEY_SETTINGS_OPENS).apply();
        } catch (Throwable ignored) { }
    }

    /**
     * Plugin lifecycle hook — THE resume half of the install-loop fix.
     * Fires when the user comes back from the "Install unknown apps"
     * settings screen (or from a cancelled installer): if a downloaded APK
     * is waiting and the permission is NOW granted, the installer launches
     * itself — the user must NOT have to find and tap "Install now" again
     * ("after enabling it … nothing happens"). If the permission is still
     * NOT granted we deliberately do nothing here (no settings re-open —
     * that was the loop); the next explicit install tap escalates instead.
     */
    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        try {
            android.content.SharedPreferences prefs = updatePrefs();
            String pending = prefs.getString(KEY_PENDING_APK, null);
            if (pending == null || pending.isEmpty()) return;
            if (!new java.io.File(pending).exists()) {
                clearPendingInstallState();
                return;
            }
            if (canRequestInstalls()) {
                Context ctx = getContext();
                if (launchInstaller(ctx, pending)) {
                    clearPendingInstallState();
                    Log.i(TAG, "Resumed pending update install after settings grant");
                }
            }
            // else: leave the pending state — the next installUpdate tap
            // takes the escalation branch (installer fired directly).
        } catch (Throwable t) {
            Log.w(TAG, "handleOnResume install-resume failed", t);
        }
    }

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
     * Mobile "this page could not load" diagnostics — Task: on-device recovery.
     *
     * Returns everything the in-app diagnostics sheet needs to explain the
     * state of the shell in ONE call: the REAL installed version (versionName
     * + versionCode straight from PackageManager — the same values the update
     * system uses), the platform build, the WebView engine version (from the
     * live User-Agent — a stale/old WebView explains modern-JS render
     * failures), and whether a downloaded update APK is still pending.
     *
     * Every field is best-effort: a failure to read one never rejects the
     * whole call — the sheet degrades to fewer rows instead of dying.
     */
    @PluginMethod
    public void getDiagnostics(PluginCall call) {
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
            Log.w(TAG, "getDiagnostics: getAppInfo failed", t);
            result.put("versionName", "");
            result.put("versionCode", -1);
        }
        try {
            result.put("packageName", getContext().getPackageName());
        } catch (Throwable ignored) { }
        result.put("androidSdk", android.os.Build.VERSION.SDK_INT);
        result.put("deviceModel", android.os.Build.MODEL == null ? "" : android.os.Build.MODEL);
        result.put("manufacturer", android.os.Build.MANUFACTURER == null ? "" : android.os.Build.MANUFACTURER);
        // WebView engine version straight from the live UA string — e.g.
        // "…; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0…"
        try {
            if (getBridge() != null && getBridge().getWebView() != null) {
                String ua = getBridge().getWebView().getSettings().getUserAgentString();
                result.put("userAgent", ua == null ? "" : ua);
            }
        } catch (Throwable t) {
            Log.w(TAG, "getDiagnostics: userAgent failed", t);
        }
        // Is a downloaded update APK sitting on disk right now? (the phone
        // downloaded but did not finish installing an update)
        try {
            java.io.File apk = new java.io.File(
                getContext().getExternalFilesDir(android.os.Environment.DIRECTORY_DOWNLOADS),
                UPDATE_APK_NAME);
            result.put("pendingUpdateApk", apk.exists() && apk.length() > 0);
            result.put("pendingUpdateApkBytes", apk.exists() ? apk.length() : 0);
        } catch (Throwable ignored) {
            result.put("pendingUpdateApk", false);
        }
        call.resolve(result);
    }

    /**
     * Recovery "reset shell data" — clears EVERYTHING the WebView persisted:
     *   • HTTP cache (WebView.clearCache) — stale asset responses,
     *   • localStorage / IndexedDB / Web SQL (WebStorage.deleteAllData) — the
     *     poisoned-state killer (a broken session, an old offline schema,
     *     a dead last-good server URL from a previous build),
     *   • cookies (CookieManager.removeAllCookies),
     *   • Service Worker registrations + Cache Storage (the app_webview
     *     "Service Worker" directory — no SW is registered today, but a
     *     future build or a plugin could register one; clearing keeps the
     *     reset honest),
     *   • the pending update APK (blasti-update.apk) so a corrupted download
     *     is never retried.
     *
     * Called from the in-app diagnostics sheet's "reset app data" action
     * (with a confirm dialog) when the shell cannot heal itself. The web
     * layer reloads after this resolves.
     */
    @PluginMethod
    public void clearWebviewData(PluginCall call) {
        int cleared = 0;
        // 1. HTTP cache
        try {
            if (getBridge() != null && getBridge().getWebView() != null) {
                getBridge().getWebView().clearCache(true);
                cleared++;
            }
        } catch (Throwable t) {
            Log.w(TAG, "clearWebviewData: clearCache failed", t);
        }
        // 2. localStorage / IndexedDB / Web SQL
        try {
            android.webkit.WebStorage.getInstance().deleteAllData();
            cleared++;
        } catch (Throwable t) {
            Log.w(TAG, "clearWebviewData: WebStorage failed", t);
        }
        // 3. Cookies
        try {
            android.webkit.CookieManager.getInstance().removeAllCookies(null);
            android.webkit.CookieManager.getInstance().flush();
            cleared++;
        } catch (Throwable t) {
            Log.w(TAG, "clearWebviewData: cookies failed", t);
        }
        // 4. Service Worker registrations + Cache Storage (best-effort dir wipe)
        try {
            java.io.File swDir = new java.io.File(
                getContext().getCacheDir().getParentFile(), "app_webview/Service Worker");
            if (!swDir.exists()) {
                // Some WebView versions use a different profile root layout.
                swDir = new java.io.File(getContext().getDataDir(), "app_webview/Service Worker");
            }
            deleteRecursively(swDir);
            cleared++;
        } catch (Throwable t) {
            Log.w(TAG, "clearWebviewData: SW dir failed", t);
        }
        // 5. The downloaded update APK (a corrupted/partial download must not
        //    be re-offered by the next update check)
        try {
            java.io.File apk = new java.io.File(
                getContext().getExternalFilesDir(android.os.Environment.DIRECTORY_DOWNLOADS),
                UPDATE_APK_NAME);
            if (apk.exists()) apk.delete();
        } catch (Throwable ignored) { }
        // 6. The install-permission ladder state (a pending APK that no
        //    longer exists must never auto-launch on resume).
        clearPendingInstallState();
        JSObject result = new JSObject();
        result.put("ok", true);
        result.put("clearedSteps", cleared);
        call.resolve(result);
    }

    /** Depth-bounded recursive delete used by clearWebviewData (SW directory). */
    private static void deleteRecursively(java.io.File file) {
        if (file == null || !file.exists()) return;
        java.io.File[] children = file.listFiles();
        if (children != null) {
            for (java.io.File child : children) {
                deleteRecursively(child);
            }
        }
        //noinspection ResultOfMethodCallIgnored
        file.delete();
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
            // A fresh download also resets the install-permission ladder —
            // the new APK gets its own first-bounce → resume → escalate cycle.
            clearPendingInstallState();
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
            // 0.6.18 root-cause fix (field log: 5× {"message":"apk-not-found"}
            // after every download): the web layer used to call installUpdate({})
            // with NO downloadId → the query below ran with id=-1 → zero rows →
            // reject BEFORE the 0.6.17 permission ladder was ever reached.
            // Recover the id this process enqueued (downloadUpdate remembers it).
            if (id <= 0 && lastUpdateDownloadId > 0) {
                id = lastUpdateDownloadId;
            }
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
            // 0.6.18 deterministic fallback — the FINAL answer before
            // "apk-not-found": downloadUpdate always writes the APK to THIS
            // plugin-owned destination (setDestinationInExternalFilesDir above),
            // so the file is here whenever a download completed, regardless of
            // whether the caller passed a downloadId and regardless of
            // DownloadManager hiding COLUMN_LOCAL_FILENAME (API 24+) or
            // returning a content:// LOCAL_URI. With a file in hand the whole
            // 0.6.17 permission ladder below is now actually reachable.
            if (filePath == null || filePath.trim().isEmpty()) {
                try {
                    java.io.File fixed = new java.io.File(getContext().getExternalFilesDir(
                        android.os.Environment.DIRECTORY_DOWNLOADS), UPDATE_APK_NAME);
                    if (fixed.exists()) filePath = fixed.getAbsolutePath();
                } catch (Throwable ignored) { }
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

            // ── PROACTIVE install-permission gate with an ESCALATION LADDER
            // (0.6.17 install-loop fix — field report: "after enabling it or
            // it was already enabled, nothing happens; it keeps redirecting
            // me to it again without installing the update").
            //
            //   tap 1: permission missing → open the grant screen ONCE and
            //          remember the pending APK (handleOnResume finishes the
            //          job the moment the user returns with the toggle on).
            //   tap 2+: if the check STILL fails (MIUI/HyperOS builds where
            //          canRequestPackageInstalls() stays false even with the
            //          toggle on), NEVER open the settings screen again —
            //          fire the installer intent directly. The system
            //          installer's own inline grant flow returns to the
            //          INSTALLER and continues automatically, so this cannot
            //          loop. A throw here rejects install-failed (no more
            //          settings bounce).
            if (android.os.Build.VERSION.SDK_INT >= 26 && !canRequestInstalls()) {
                android.content.SharedPreferences prefs = updatePrefs();
                int opens = prefs.getInt(KEY_SETTINGS_OPENS, 0);
                if (opens < 1) {
                    // First bounce: drive the user to the grant screen.
                    try {
                        prefs.edit()
                            .putString(KEY_PENDING_APK, apk.getAbsolutePath())
                            .putInt(KEY_SETTINGS_OPENS, 1)
                            .apply();
                    } catch (Throwable ignored) { }
                    openInstallPermissionSettingsInternal();
                    call.reject("needs-install-permission",
                        "Install-from-this-source permission not granted — settings screen opened");
                    return;
                }
                // Second attempt: escalate straight to the installer (the
                // system runs its own self-resuming grant flow from here).
                boolean launched = launchInstaller(getContext(), apk.getAbsolutePath());
                clearPendingInstallState();
                if (launched) {
                    JSObject okResult = new JSObject();
                    okResult.put("ok", true);
                    okResult.put("escalated", true);
                    call.resolve(okResult);
                } else {
                    call.reject("install-failed",
                        "Installer could not be launched and the permission is still ungranted");
                }
                return;
            }

            // Permission granted (or SDK < 26): launch the installer normally.
            clearPendingInstallState();
            android.content.Intent intent = new android.content.Intent(android.content.Intent.ACTION_VIEW);
            intent.setDataAndType(apkUri, "application/vnd.android.package-archive");
            intent.addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION
                | android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
            try {
                getContext().startActivity(intent);
            } catch (Throwable act) {
                if (android.os.Build.VERSION.SDK_INT >= 26) {
                    openInstallPermissionSettingsInternal();
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

    // ─── Lock-screen notifications (channels + full-screen alerts) ──────────

    /**
     * Internal: open the system "Install unknown apps" grant screen for THIS
     * app. Used by installUpdate when canRequestPackageInstalls() is false
     * and exposed directly as a plugin method so the web layer can drive the
     * user back here after an interrupted grant.
     */
    private void openInstallPermissionSettingsInternal() {
        try {
            android.content.Intent settings = new android.content.Intent(
                android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                android.net.Uri.parse("package:" + getContext().getPackageName()));
            settings.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(settings);
        } catch (Throwable t) {
            // Some OEM builds lack the action — fall back to the app details
            // screen where the same toggle lives.
            try {
                android.content.Intent fallback = new android.content.Intent(
                    android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    android.net.Uri.parse("package:" + getContext().getPackageName()));
                fallback.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(fallback);
            } catch (Throwable ignored) { }
        }
    }

    /**
     * Plugin method: open the system "Install unknown apps" screen for this
     * app so the user can grant the install authority, then report the
     * CURRENT grant state. Returns { ok, canInstall }.
     */
    @PluginMethod
    public void openInstallPermissionSettings(PluginCall call) {
        openInstallPermissionSettingsInternal();
        JSObject result = new JSObject();
        boolean canInstall = false;
        try {
            canInstall = getContext().getPackageManager().canRequestPackageInstalls();
        } catch (Throwable ignored) { }
        result.put("ok", true);
        result.put("canInstall", canInstall);
        call.resolve(result);
    }

    /**
     * Plugin method (0.6.17): SIDE-EFFECT-FREE permission probe —
     * { canInstall: boolean }. The web layer uses it to distinguish "the
     * user returned from the settings screen with the toggle ON" (safe to
     * re-offer the install) from "still ungranted" (keep showing the hint)
     * WITHOUT opening the settings screen again — the probe replaces the
     * old pattern where the only way to read the state was to open settings
     * (which was itself half of the redirect loop).
     */
    @PluginMethod
    public void getInstallPermissionState(PluginCall call) {
        JSObject result = new JSObject();
        result.put("canInstall", canRequestInstalls());
        call.resolve(result);
    }

    /** Channel that surfaces ticket calls / critical alerts ON the lock screen. */
    static final String LOCKSCREEN_CHANNEL_ID = "blasti-lockscreen";

    /** Default-importance channel for non-critical notifications. */
    static final String GENERAL_CHANNEL_ID = "blasti-general";

    /**
     * Turn-alert channel — MUST exist natively because the FCM payload
     * (apps/api/src/lib/notification-router.ts) targets exactly this id for
     * background pushes (app closed → the web layer cannot create channels).
     * Before this channel existed, FCM notifications fell back to the OS
     * default "Miscellaneous" channel: low importance, no heads-up, no
     * lock-screen content. The Capacitor LocalNotifications fallback path
     * (notification-channel.ts BLASTI_TURN_CHANNEL) uses the same id.
     */
    static final String TURN_ALERT_CHANNEL_ID = "blasti-turn-alert";

    /** Prefs file shared with BlastiNotificationDismissReceiver. */
    static final String NATIVE_PREFS_FILE = "blasti-native-prefs";
    static final String KEY_LOCKSCREEN_TAKEOVER = "lockscreenTakeover";

    /**
     * Create the BLASTI notification channels exactly the way the lock-screen
     * UI needs them:
     *   • blasti-lockscreen — IMPORTANCE_HIGH (heads-up + lock screen),
     *     VISIBILITY_PUBLIC (full content readable on the lock screen),
     *     vibration + lights; used for turn-called alerts.
     *   • blasti-turn-alert — IMPORTANCE_HIGH + PUBLIC: the channel the FCM
     *     payload and the Capacitor LocalNotifications fallback both target
     *     (creating it here fixes background pushes landing on the OS default
     *     low-importance channel).
     *   • blasti-general — IMPORTANCE_DEFAULT, PRIVATE visibility.
     * Idempotent — safe to call on every app start.
     */
    @PluginMethod
    public void ensureNotificationChannels(PluginCall call) {
        JSObject result = new JSObject();
        try {
            boolean ok = ensureNotificationChannelsInternal(getContext());
            if (!ok) {
                if (call != null) call.reject("notification-manager-unavailable");
                return;
            }
            result.put("ok", true);
            result.put("channels", new String[]{ LOCKSCREEN_CHANNEL_ID, TURN_ALERT_CHANNEL_ID, GENERAL_CHANNEL_ID });
            if (call != null) call.resolve(result);
        } catch (Throwable t) {
            Log.w(TAG, "ensureNotificationChannels failed", t);
            if (call != null) call.reject("channels-failed", t.getMessage());
        }
    }

    /**
     * Real channel setup. Returns false only when the NotificationManager is
     * unavailable. Static + context-parametrized so MainActivity boot code can
     * call it without a plugin instance.
     */
    private static boolean ensureNotificationChannelsInternal(Context context) {
        if (context == null) return false;
        if (android.os.Build.VERSION.SDK_INT < 26) {
            // Pre-O: importance/visibility are per-notification, not per-channel.
            return true;
        }
        android.app.NotificationManager nm = (android.app.NotificationManager)
            context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return false;

        android.app.NotificationChannel lock = new android.app.NotificationChannel(
            LOCKSCREEN_CHANNEL_ID,
            "BLASTI Alerts",
            android.app.NotificationManager.IMPORTANCE_HIGH);
        lock.setDescription("Ticket calls and important BLASTI alerts");
        // PUBLIC = the notification's full content is readable on the lock screen.
        lock.setLockscreenVisibility(android.app.Notification.VISIBILITY_PUBLIC);
        lock.enableVibration(true);
        lock.enableLights(true);
        lock.setLightColor(android.graphics.Color.parseColor("#10b981"));
        try {
            lock.setSound(
                android.media.RingtoneManager.getDefaultUri(android.media.RingtoneManager.TYPE_NOTIFICATION),
                new android.media.AudioAttributes.Builder()
                    .setUsage(android.media.AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build());
        } catch (Throwable ignored) { }

        android.app.NotificationChannel turn = new android.app.NotificationChannel(
            TURN_ALERT_CHANNEL_ID,
            "BLASTI Turn Alert",
            android.app.NotificationManager.IMPORTANCE_HIGH);
        turn.setDescription("Your-turn alerts (in-app fallback + push while the app is closed)");
        // PUBLIC so FCM background pushes show full content on the lock screen.
        turn.setLockscreenVisibility(android.app.Notification.VISIBILITY_PUBLIC);
        turn.enableVibration(true);
        turn.enableLights(true);
        turn.setLightColor(android.graphics.Color.parseColor("#10b981"));
        try {
            turn.setSound(
                android.media.RingtoneManager.getDefaultUri(android.media.RingtoneManager.TYPE_NOTIFICATION),
                new android.media.AudioAttributes.Builder()
                    .setUsage(android.media.AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build());
        } catch (Throwable ignored) { }

        android.app.NotificationChannel general = new android.app.NotificationChannel(
            GENERAL_CHANNEL_ID,
            "BLASTI",
            android.app.NotificationManager.IMPORTANCE_DEFAULT);
        general.setDescription("General BLASTI notifications");
        general.setLockscreenVisibility(android.app.Notification.VISIBILITY_PRIVATE);

        nm.createNotificationChannel(lock);
        nm.createNotificationChannel(turn);
        nm.createNotificationChannel(general);
        return true;
    }

    /**
     * Boot-time hook for MainActivity: create the notification channels and
     * apply the persisted lock-screen flags WITHOUT any web-layer involvement
     * (channels must exist before FCM can post into them; the flags must be
     * applied before any full-screen intent can fire).
     */
    public static void applyLaunchPreferences(Activity activity) {
        try {
            ensureNotificationChannelsInternal(activity.getApplicationContext());
        } catch (Throwable ignored) { }
        applyLockscreenFlags(activity);
    }

    /**
     * Apply the persisted lockscreenTakeover preference to the activity:
     *   • false (DEFAULT) → setShowWhenLocked(false) + setTurnScreenOn(false):
     *     the app can NEVER render over the keyguard — only the notification
     *     shows on the lock screen (full separation).
     *   • true (explicit opt-in from Settings → Notifications) → the legacy
     *     full-screen takeover behavior.
     *
     * Called from MainActivity.onCreate (boot) and from
     * setLockscreenTakeover() (preference change while running).
     */
    private static void applyLockscreenFlags(Activity activity) {
        if (activity == null) return;
        if (android.os.Build.VERSION.SDK_INT < 27) {
            // setShowWhenLocked/setTurnScreenOn exist from API 27; below that
            // the removed manifest flags keep the safe default (never show).
            return;
        }
        try {
            SharedPreferences prefs = activity.getSharedPreferences(NATIVE_PREFS_FILE, Context.MODE_PRIVATE);
            boolean takeover = prefs.getBoolean(KEY_LOCKSCREEN_TAKEOVER, false);
            activity.setShowWhenLocked(takeover);
            activity.setTurnScreenOn(takeover);
        } catch (Throwable t) {
            Log.w(TAG, "applyLockscreenFlags failed", t);
        }
    }

    /**
     * Persist + apply the lockscreenTakeover preference. The web layer calls
     * this whenever the Settings → Notifications toggle changes (and on boot
     * to keep native in sync with the server-side preference).
     * Returns { ok, enabled }.
     */
    @PluginMethod
    public void setLockscreenTakeover(PluginCall call) {
        Boolean enabled = call.getBoolean("enabled", false);
        boolean value = enabled != null && enabled;
        try {
            getContext().getSharedPreferences(NATIVE_PREFS_FILE, Context.MODE_PRIVATE)
                .edit()
                .putBoolean(KEY_LOCKSCREEN_TAKEOVER, value)
                .apply();
            Activity activity = bridge != null ? bridge.getActivity() : null;
            if (activity != null) {
                applyLockscreenFlags(activity);
            }
            JSObject result = new JSObject();
            result.put("ok", true);
            result.put("enabled", value);
            call.resolve(result);
        } catch (Throwable t) {
            Log.w(TAG, "setLockscreenTakeover failed", t);
            call.reject("takeover-failed", t.getMessage());
        }
    }

    /**
     * Last turn-notification dismissal recorded by
     * BlastiNotificationDismissReceiver (swipe or Stop action). The web layer
     * compares this against a pending in-app replay on resume and DROPS the
     * replay when the user already stopped the alert from the lock screen.
     * Returns { dismissedAt, dismissedId } (epoch ms, notification id; 0/-1
     * when nothing was ever dismissed).
     */
    @PluginMethod
    public void getTurnDismissState(PluginCall call) {
        try {
            SharedPreferences prefs = getContext().getSharedPreferences(NATIVE_PREFS_FILE, Context.MODE_PRIVATE);
            JSObject result = new JSObject();
            result.put("dismissedAt", prefs.getLong(BlastiNotificationDismissReceiver.KEY_TURN_DISMISSED_AT, 0L));
            result.put("dismissedId", prefs.getInt(BlastiNotificationDismissReceiver.KEY_TURN_DISMISSED_ID, -1));
            call.resolve(result);
        } catch (Throwable t) {
            Log.w(TAG, "getTurnDismissState failed", t);
            call.reject("dismiss-state-failed", t.getMessage());
        }
    }

    /**
     * Post a lock-screen-ready notification directly through the native
     * NotificationManager (the Capacitor LocalNotifications plugin cannot set
     * full-screen intents or lock-screen visibility from JS):
     *   • VISIBILITY_PUBLIC on the blasti-lockscreen channel → full content on
     *     the lock screen;
     *   • OPTIONAL full-screen intent — ONLY when the caller passes
     *     fullScreen:true AND the device is LOCKED. Default is FALSE: the app
     *     must never launch itself over the keyguard (field report: "the
     *     mobile app as a whole shows on the lock screen, not just a
     *     notification" — the old unconditional full-screen intent made the
     *     whole activity appear ON the lock screen). The notification itself
     *     (heads-up banner + lock-screen content + tap-to-open) still fires.
     *   • tapping the notification opens the app.
     * Returns { ok, id, fullScreen }.
     */
    @PluginMethod
    public void notifyLockscreen(PluginCall call) {
        String title = call.getString("title");
        String body = call.getString("body");
        if (title == null || title.trim().isEmpty()) {
            call.reject("missing-title");
            return;
        }
        boolean wantFullScreen = call.getBoolean("fullScreen", false);
        try {
            // Channels must exist before the notification posts (no-op pre-O).
            try { ensureNotificationChannelsInternal(getContext()); } catch (Throwable ignored) { }

            Object rawId = call.getData() == null ? null : call.getData().opt("notificationId");
            int id = rawId instanceof Number
                ? ((Number) rawId).intValue()
                : (int) (System.currentTimeMillis() % 100000L);

            android.app.NotificationManager nm = (android.app.NotificationManager)
                getContext().getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) {
                call.reject("notification-manager-unavailable");
                return;
            }

            androidx.core.app.NotificationCompat.Builder builder =
                new androidx.core.app.NotificationCompat.Builder(getContext(), LOCKSCREEN_CHANNEL_ID)
                    .setSmallIcon(getContext().getApplicationInfo().icon)
                    .setContentTitle(title)
                    .setContentText(body == null ? "" : body)
                    .setStyle(new androidx.core.app.NotificationCompat.BigTextStyle()
                        .bigText(body == null ? "" : body))
                    // Full content readable on the lock screen (pre-O too).
                    .setVisibility(androidx.core.app.NotificationCompat.VISIBILITY_PUBLIC)
                    .setPriority(androidx.core.app.NotificationCompat.PRIORITY_HIGH)
                    .setCategory(androidx.core.app.NotificationCompat.CATEGORY_EVENT)
                    .setAutoCancel(true)
                    .setWhen(System.currentTimeMillis())
                    .setShowWhen(true)
                    .setColor(android.graphics.Color.parseColor("#10b981"));

            android.content.Intent launch = getContext().getPackageManager()
                .getLaunchIntentForPackage(getContext().getPackageName());
            // Hoisted so the result payload can report it below.
            boolean locked = false;
            try {
                Object kg = getContext().getSystemService(Context.KEYGUARD_SERVICE);
                if (kg instanceof android.app.KeyguardManager) {
                    locked = ((android.app.KeyguardManager) kg).isKeyguardLocked();
                }
            } catch (Throwable ignored) { }
            if (launch != null) {
                launch.addFlags(android.content.Intent.FLAG_ACTIVITY_SINGLE_TOP
                    | android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                android.app.PendingIntent contentPi = android.app.PendingIntent.getActivity(
                    getContext(), id, launch,
                    android.app.PendingIntent.FLAG_IMMUTABLE | android.app.PendingIntent.FLAG_UPDATE_CURRENT);
                builder.setContentIntent(contentPi);

                // Device locked → wake the screen and show OVER the keyguard —
                // ONLY when the caller explicitly opted in (web preference
                // lockscreenTakeover, synced to native SharedPreferences and
                // applied by MainActivity/applyLaunchPreferences + the
                // setLockscreenTakeover plugin method). With the manifest
                // flags removed, the DEFAULT is full separation: tapping the
                // notification while locked shows the keyguard first; the app
                // paints only after unlock.
                if (wantFullScreen && locked) {
                    android.app.PendingIntent fullPi = android.app.PendingIntent.getActivity(
                        getContext(), id + 1, launch,
                        android.app.PendingIntent.FLAG_IMMUTABLE | android.app.PendingIntent.FLAG_UPDATE_CURRENT);
                    builder.setFullScreenIntent(fullPi, true);
                }
            }

            // ── Swipe-to-stop + explicit Stop action (parity with the in-app
            //    banner's slide-to-stop). Both paths hit
            //    BlastiNotificationDismissReceiver, which cancels the
            //    notification, kills vibration and records the dismissal so
            //    the web layer drops the pending in-app replay on resume.
            try {
                Intent stopIntent = new Intent(getContext(), BlastiNotificationDismissReceiver.class);
                stopIntent.setAction(BlastiNotificationDismissReceiver.ACTION_STOP_TURN_ALERT);
                stopIntent.putExtra(BlastiNotificationDismissReceiver.EXTRA_NOTIFICATION_ID, id);
                android.app.PendingIntent stopPi = android.app.PendingIntent.getBroadcast(
                    getContext(), id + 2, stopIntent,
                    android.app.PendingIntent.FLAG_IMMUTABLE | android.app.PendingIntent.FLAG_UPDATE_CURRENT);
                // Swipe the notification away → same receiver records the stop.
                builder.setDeleteIntent(stopPi);
                // Visible "Stop" button on the heads-up/lock-screen shade.
                String stopLabel = call.getString("stopLabel");
                if (stopLabel == null || stopLabel.trim().isEmpty()) stopLabel = "إيقاف / Stop";
                builder.addAction(
                    new androidx.core.app.NotificationCompat.Action.Builder(
                        0, stopLabel, stopPi).build());
            } catch (Throwable t) {
                Log.w(TAG, "stop-action wiring failed", t);
            }

            nm.notify(id, builder.build());
            JSObject result = new JSObject();
            result.put("ok", true);
            result.put("id", id);
            result.put("fullScreen", wantFullScreen && locked);
            call.resolve(result);
        } catch (Throwable t) {
            Log.w(TAG, "notifyLockscreen failed", t);
            call.reject("notify-failed", t.getMessage());
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
