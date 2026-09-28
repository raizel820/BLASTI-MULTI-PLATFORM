# Task 47-b — Native bridge repair + real FCM push + public update check

Agent: Z.ai Code (full-stack, mobile-bridge agent)
Status: COMPLETE (lint 0; live HTTP + DB E2E verified; dev servers left running)

## Scope

Wire the Capacitor-8 plugin set (MLKit BarcodeScanner, NativeBiometric,
Geolocation, DeviceMotion) into `apps/web/src/lib/native-bridge.ts`; add
client-side FCM push registration; add the API endpoints that receive tokens
and publish update checks; make the notification router send REAL Firebase
push instead of the fake-success stub.

## Files changed / created

| File | Change |
|---|---|
| `apps/web/src/lib/native-bridge.ts` | scanQR rewritten for MLKit `scan({formats:['QR_CODE']})` (+ legacy `start()` fallback, best-effort `requestCameraPermission()`); new `isBiometricsAvailable/authenticateWithBiometrics/setBiometricCredentials/getBiometricCredentials` (NativeBiometric); `requestSinglePermission('biometrics')` dead 'BiometricAuth' path removed; new `getCurrentPosition()` (Capacitor Geolocation → web fallback); new `isMotionAvailable()`/`startMotionUpdates()` (DeviceMotionEvent); Badge probe verified compatible with @capawesome (`set({count})`) — untouched |
| `apps/web/src/lib/push-registration.ts` | NEW. `initMobilePushRegistration()`: SSR-safe, no @capacitor imports, `(window as any).Capacitor` probing; once-per-session flag; listeners before `register()`; token upload via `apiClient.post('/api/user/push-token', {token, platform, deviceId})` deduped by localStorage `blasti:push_token_last` (remembered only on success); deviceId from existing `getDeviceId()` (`@/lib/device-fingerprint`); foreground pushes → `blasti:notification` CustomEvent (same contract as mobile setup.ts); `blasti:app-resume` → re-register only if already granted |
| `apps/web/src/components/shared/client-boot-hardening.tsx` | Calls `initMobilePushRegistration()` fire-and-forget as boot task #0; existing SW-cleanup + chunk-recovery behavior intact |
| `apps/api/src/lib/notification-router.ts` | `sendViaPushNotification` REAL: lazy module-level `getFirebaseMessaging()` from `FIREBASE_SERVICE_ACCOUNT_JSON` (inline, recommended) or `FIREBASE_SERVICE_ACCOUNT_PATH`; neither → one log line "Push disabled: FIREBASE_SERVICE_ACCOUNT_JSON not configured" → false → SMS/WhatsApp fallback engages; message per spec (TURN_CALL title `messageAr || 'دورك الآن!'`, string-only data, android channel `blasti-turn-alert` + `blasti_alarm.wav`, apns `sound:'default'`); exported signature unchanged |
| `apps/api/package.json` | `"firebase-admin": "^12"` added to dependencies (NOT installed — operator installs; notification-router.ts has no runtime importers yet, verified by grep, so the running API is unaffected pre-install) |
| `apps/api/src/routes/user.ts` | NEW `POST /push-token` (requireAuth pattern of the file): zod {token 10..4096, platform ≤20?, deviceId ≤100?}; `user.fcmToken` update; `deviceRegistration.upsert` on `userId_deviceId` when deviceId present; `{success:true}` |
| `apps/api/src/routes/app-versions.ts` | NEW PUBLIC `GET /check` (platform+version query): latest published row ordered `[{versionCode:'desc'},{createdAt:'desc'}]`, tiny numeric semver compare (reuses `compareVersions`), full contract response, graceful empty → `updateAvailable:false`; registered BEFORE `GET /:id` (registration order) |
| `apps/api/.env.example` | Documented FIREBASE_SERVICE_ACCOUNT_JSON / FIREBASE_SERVICE_ACCOUNT_PATH + graceful-skip behavior |
| `worklog.md` | Task 47-b record appended |

## Deviations (with reasons)

1. **firebase-admin not installed / `bun add` not run** — per task spec ("I
   will install"). Declared `"^12"` in `apps/api/package.json`. Verified
   `notification-router.ts` currently has ZERO runtime importers in
   `apps/api/src` (grep) → the top-level `firebase-admin` import is never
   evaluated by the running server → no crash before `bun install`.
2. **GET /check placement** — initially appended near `/check-update`, then
   MOVED to sit before `GET /:id` (Hono matches in registration order;
   `/check` would have been captured by the admin-gated `/:id` handler).
3. **dev.log missing** — `/home/z/my-project/dev.log` does not exist in this
   environment (servers run under `concurrently` on a pts). Health verified
   by HTTP probes instead: web 200 on `/`, `/customer`, `/auth/login`; API
   `/health` 200 with unchanged bootId.
4. **deviceId helper** — spec fallback mentioned localStorage key
   `blasti:device_id`; the existing `getDeviceId()` (`@/lib/device-fingerprint`,
   key `blasti_device_id`) was available and used instead, as the spec
   preferred the existing helper.

## Live E2E proofs (dev DB rows all reverted)

- Temp AppVersion 9.9.9/99999/isPublished → `GET /check?platform=android&version=1.0.0`
  → 200 `updateAvailable:true, latestVersion:"9.9.9", versionCode:99999,
  isMandatory:true, downloadUrl, releaseNotes/Ar/Fr` (PASS); `version=9.9.9`
  → `updateAvailable:false` (PASS); row deleted after.
- `POST /api/user/push-token` unauthenticated → 401. Authenticated (seeded
  admin, Bearer) → 200 `{success:true}`, `user.fcmToken` persisted,
  `DeviceRegistration` upserted (platform=android, token match, lastActiveAt
  set); token reverted + device row deleted.
- `GET /api/app-versions/:id` still 401 unauthenticated (/:id gating intact).
- `bun run lint` (repo root → apps/web): exit 0, zero output.
