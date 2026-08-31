# BLASTI Android Permissions

All required permissions are already configured in `android/app/src/main/AndroidManifest.xml`.

## Configured Permissions

| Permission | Purpose |
|---|---|
| `INTERNET` | Network access for API calls and Socket.IO real-time updates |
| `ACCESS_NETWORK_STATE` | Detect network connectivity for offline/online status |
| `VIBRATE` | Haptic feedback for turn alerts and queue notifications |
| `CAMERA` | QR code scanning at agencies |
| `WAKE_LOCK` | Wake device screen when a turn is called, even if screen is off |
| `USE_FULL_SCREEN_INTENT` | Show turn alert as full-screen intent (over lock screen) |
| `POST_NOTIFICATIONS` | Required on Android 13+ (API 33) to post push/local notifications |

## Important Notes

- Permissions are pre-configured in the Android project — no manual steps needed after `cap sync`
- `POST_NOTIFICATIONS` must also be requested at runtime (handled by the web app's native bridge)
- `CAMERA` must be requested at runtime when the user first tries to scan a QR code
- `USE_FULL_SCREEN_INTENT` requires user permission on Android 14+ (API 34)
