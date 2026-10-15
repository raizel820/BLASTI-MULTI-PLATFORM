package com.blasti.mobile;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Vibrator;
import android.os.VibratorManager;

/**
 * BLASTI Notification Stop/Dismiss receiver — swipe-to-stop parity for the
 * lock-screen turn notification.
 *
 * WHY (field report: "add a swipe to the lockscreen notification to stop it
 * just like the in-app notification"):
 *   • The in-app turn banner has a slide-to-stop control that kills the alert
 *     loop and persists the acknowledgement. The NATIVE lock-screen
 *     notification had no equivalent: swiping it away only removed the
 *     notification itself, and the web layer had no idea it happened.
 *
 * WHAT IT DOES (wired as BOTH the notification's deleteIntent — swipe
 * dismiss — and its "Stop" action button):
 *   1. Cancels the notification (deleteIntent removes it implicitly; the
 *      explicit Stop action button needs the manual cancel).
 *   2. Cancels any ongoing vibration immediately.
 *   3. Records the dismissal (turnDismissedAt/turnDismissedId in
 *      blasti-native-prefs) so the web layer can reconcile on resume:
 *      LockscreenNotificationGate drops the pending in-app replay of an
 *      event the user ALREADY dismissed on the lock screen.
 *
 * Manifest-registered (not exported) — only the app's own PendingIntents can
 * reach it.
 */
public class BlastiNotificationDismissReceiver extends BroadcastReceiver {

    /** Action carried by the explicit "Stop" notification action button. */
    static final String ACTION_STOP_TURN_ALERT = "com.blasti.mobile.STOP_TURN_ALERT";

    /** Notification id extra so the receiver can cancel the right one. */
    static final String EXTRA_NOTIFICATION_ID = "notificationId";

    /** Shared prefs file — the same one BlastiNativeStatus.setLockscreenTakeover uses. */
    static final String PREFS_FILE = "blasti-native-prefs";
    static final String KEY_TURN_DISMISSED_AT = "turnDismissedAt";
    static final String KEY_TURN_DISMISSED_ID = "turnDismissedId";
    static final String KEY_LOCKSCREEN_TAKEOVER = "lockscreenTakeover";

    @Override
    public void onReceive(Context context, Intent intent) {
        int id = intent.getIntExtra(EXTRA_NOTIFICATION_ID, -1);

        // 1) Cancel the notification. On swipe (deleteIntent) the system has
        //    already removed it — cancelling a stale id is a harmless no-op.
        //    On the explicit Stop ACTION button this is the actual removal.
        if (id >= 0) {
            try {
                Object nm = context.getSystemService(Context.NOTIFICATION_SERVICE);
                if (nm instanceof android.app.NotificationManager) {
                    ((android.app.NotificationManager) nm).cancel(id);
                }
            } catch (Throwable ignored) { }
        }

        // 2) Stop any ongoing vibration right now.
        cancelVibration(context);

        // 3) Record the dismissal timestamp so the web layer (which owns the
        //    in-app alert replay) can drop a pending event that the user
        //    already stopped from the lock screen.
        try {
            context.getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE)
                .edit()
                .putLong(KEY_TURN_DISMISSED_AT, System.currentTimeMillis())
                .putInt(KEY_TURN_DISMISSED_ID, id)
                .apply();
        } catch (Throwable ignored) { }
    }

    /**
     * Cancel vibration across API levels (VibratorManager on 31+, Vibrator
     * before). Best-effort — never throws.
     */
    static void cancelVibration(Context context) {
        try {
            if (Build.VERSION.SDK_INT >= 31) {
                Object vm = context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
                if (vm instanceof VibratorManager) {
                    ((VibratorManager) vm).cancel();
                    return;
                }
            }
            Object v = context.getSystemService(Context.VIBRATOR_SERVICE);
            if (v instanceof Vibrator) {
                ((Vibrator) v).cancel();
            }
        } catch (Throwable ignored) { }
    }
}
