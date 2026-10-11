# BLASTI Android — Firebase / FCM Push Setup

## Why this matters (field incident, Sept 2026)

The uploaded Android logcat showed the app **crash-looping on every launch**:

```
Capacitor      E  Serious error executing plugin
AndroidRuntime E  FATAL EXCEPTION: CapacitorPlugins
Caused by: java.lang.IllegalStateException: Default FirebaseApp is not initialized
    in this process com.blasti.mobile. Make sure to call FirebaseApp.initializeApp(Context) first.
    at com.google.firebase.messaging.FirebaseMessaging.getInstance(...)
    at com.capacitorjs.plugins.pushnotifications.PushNotificationsPlugin.register(...)
```

**Root cause chain:**

1. `apps/mobile/android/app/google-services.json` was **missing** from the repo.
2. `app/build.gradle` silently skips the `com.google.gms.google-services` plugin
   when that file is absent (`try { ... } catch { logger.info("...Push Notifications won't work") }`).
3. Without the plugin, no Firebase options resources are generated, so
   `FirebaseInitProvider` never creates a default `FirebaseApp`.
4. Once the user granted the `POST_NOTIFICATIONS` permission, the web layer
   (`apps/web/src/lib/push-registration.ts` → `PushNotifications.register()`)
   made `FirebaseMessaging.getInstance()` throw — on the `CapacitorPlugins`
   thread → **FATAL EXCEPTION → process killed** on every launch.

## What was fixed (crash-proofing, shipped 2026-09)

Even without Firebase config the app must never crash again. Three layers:

| Layer | File | What it does |
|---|---|---|
| Native init | `MainActivity.java` + `BlastiNativeStatus.java` | Installs a **placeholder** `FirebaseApp` when `google-services.json` is absent, so `register()` degrades to an async `registrationError` event instead of throwing. |
| Native guard | `MainActivity.installFirebaseCrashGuard()` | Last-resort uncaught-exception filter that swallows ONLY the exact "Default FirebaseApp is not initialized" chain (everything else still crashes loudly). |
| Web guard | `apps/web/src/lib/push-registration.ts` | Queries the new `BlastiNativeStatus.isFirebaseReady()` plugin before touching FCM; skips the whole flow (no permission prompt) on unconfigured builds. |

Consequence for an unconfigured build: push via FCM is simply **disabled**;
in-app + local notifications keep working, and the app boots normally.

## Enabling real push (the actual fix)

1. Create/select a project at <https://console.firebase.google.com>.
2. **Project settings → Your apps → Add app → Android**.
   Package name **must** be exactly: `com.blasti.mobile`
3. Download the generated `google-services.json`.
4. Copy it here (next to this repo's `google-services.json.example`):

   ```
   apps/mobile/android/app/google-services.json
   ```

5. Rebuild the app:

   ```bash
   # from apps/web — produce the static web bundle the shell embeds
   bun run build            # or the repo's documented web build command

   # from apps/mobile — sync web assets + plugin config into android/
   npx cap sync android

   # then build/install via Android Studio, or:
   cd android && ./gradlew assembleDebug
   ```

6. Send the FCM server key / use Firebase Cloud Messaging from the BLASTI API
   (`apps/api` notification router) to deliver pushes to registered tokens
   (uploaded by the app to `/api/user/push-token`).

### Template

A stub with the exact JSON shape lives at
`apps/mobile/android/app/google-services.json.example` — do **not** build with
it; the placeholder values will fail FCM registration (gracefully, since the
hardening above).

### Verifying it worked

- `adb logcat -s BLASTI` → should log `Firebase default app present — FCM push available`.
- The app console should log `[PushRegistration] FCM token uploaded to /api/user/push-token`.
- No `FATAL EXCEPTION: CapacitorPlugins` lines, ever.
