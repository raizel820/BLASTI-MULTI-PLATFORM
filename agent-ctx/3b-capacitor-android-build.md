# Task 3-b: Capacitor Android Build Configuration

## Agent: Android Build Config Agent
## Date: 2025-06-13

## Summary

Set up and validated the Capacitor Android build configuration for the BLASTI mobile app at `/home/z/my-project/apps/mobile/`.

## Key Findings

### Android Project Was Missing
The `android/` directory only contained:
- `PERMISSIONS.md` — documentation about required permissions
- `app/src/main/res/raw/.gitkeep` and `README.md` — placeholder for alarm sound

There was no actual Android project (no AndroidManifest.xml, no MainActivity, no build.gradle, etc.).

### Web Export Not Configured
The `next.config.ts` had `output: 'export'` commented out because:
- In dev mode, the web app needs rewrites for API proxying
- Static export is incompatible with Next.js rewrites

## Changes Made

### 1. Created Complete Android Project Structure

Copied and customized the Capacitor Android template for BLASTI:

**Core Files:**
- `android/app/src/main/AndroidManifest.xml` — Package `com.blasti.mobile`, all 7 permissions, deep link scheme `blasti://`, cleartext traffic config, network security config
- `android/app/src/main/java/com/blasti/mobile/MainActivity.java` — Extends `BridgeActivity` (Capacitor's activity)
- `android/app/build.gradle` — applicationId `com.blasti.mobile`, version `0.1.0`, all Capacitor dependencies
- `android/build.gradle` — Top-level with AGP 8.13.0, Google Services
- `android/settings.gradle` — Includes capacitor-cordova-android-plugins
- `android/variables.gradle` — SDK versions (min 24, compile/target 36), AndroidX versions
- `android/gradle.properties` — AndroidX, JVM args, legacy packaging
- `android/gradle/wrapper/gradle-wrapper.properties` — Gradle 8.14.3

**Resource Files:**
- `android/app/src/main/res/values/strings.xml` — App name "BLASTI", package `com.blasti.mobile`
- `android/app/src/main/res/values/styles.xml` — BLASTI branding: colorPrimary `#10b981`, colorPrimaryDark `#059669`, colorAccent `#14b8a6`
- `android/app/src/main/res/values/ic_launcher_background.xml` — Emerald `#10b981` for adaptive icon
- `android/app/src/main/res/xml/network_security_config.xml` — Cleartext allowed for localhost, 10.0.2.2, common LAN IPs
- `android/app/src/main/res/xml/file_paths.xml` — FileProvider paths
- `android/app/src/main/res/layout/activity_main.xml` — WebView layout
- Splash PNGs (all densities: port/land, hdpi through xxxhdpi)
- Launcher icons (all densities: hdpi through xxxhdpi, adaptive icon XMLs)
- `android/app/proguard-rules.pro` — Placeholder
- `android/app/.gitignore` and `android/.gitignore` — Android-specific ignores + Capacitor-generated files

**AndroidManifest.xml Permissions:**
| Permission | Purpose |
|---|---|
| `INTERNET` | API calls, Socket.IO |
| `ACCESS_NETWORK_STATE` | Network connectivity detection |
| `VIBRATE` | Haptic feedback for turn alerts |
| `CAMERA` | QR code scanning |
| `WAKE_LOCK` | Wake screen on turn call |
| `USE_FULL_SCREEN_INTENT` | Full-screen turn alert over lock screen |
| `POST_NOTIFICATIONS` | Android 13+ notification permission |

**Deep Link Configuration:**
- Scheme: `blasti://`
- Intent filter added to MainActivity

### 2. Updated next.config.ts for Dual-Mode Build

Added `NEXT_BUILD_MODE=export` environment variable support:
- When `NEXT_BUILD_MODE=export` is set: enables `output: 'export'` and disables rewrites
- When not set (default dev mode): keeps rewrites for API proxying, no static export
- This allows the same next.config.ts to work for both dev and Capacitor builds

### 3. Added Build Scripts to apps/mobile/package.json

```json
"build:web": "cd ../web && NEXT_BUILD_MODE=export next build",
"build:android": "cd ../web && NEXT_BUILD_MODE=export next build && cd ../mobile && cap sync android && cap open android",
"build:android:release": "cd ../web && NEXT_BUILD_MODE=export next build && cd ../mobile && cap sync android && cd android && ./gradlew assembleRelease",
"build:android:debug": "cd ../web && NEXT_BUILD_MODE=export next build && cd ../mobile && cap sync android && cd android && ./gradlew assembleDebug"
```

### 4. Updated PERMISSIONS.md

Replaced the outdated manual-step instructions with a comprehensive reference table of all configured permissions and runtime notes.

### 5. Added tsconfig.json for Mobile Package

Created `apps/mobile/tsconfig.json` with appropriate settings for the TypeScript source files (plugin.ts and setup.ts).

## Verified Configurations

- ✅ `capacitor.config.ts` — appId `com.blasti.mobile`, appName `BLASTI`, webDir `../../apps/web/out`
- ✅ `capacitor.config.ts` — SplashScreen backgroundColor `#10b981`, StatusBar backgroundColor `#10b981`
- ✅ `capacitor.config.ts` — LocalNotifications smallIcon `ic_stat_blasti`, iconColor `#10b981`
- ✅ `capacitor.config.ts` — Deep link scheme `blasti://`
- ✅ `capacitor.config.ts` — Server config with dev mode override (CAPACITOR_SERVER_URL)
- ✅ Android package name matches: `com.blasti.mobile` (AndroidManifest.xml, build.gradle, strings.xml)
- ✅ MainActivity extends `BridgeActivity` (Capacitor's main activity)
- ✅ All 7 required permissions declared in AndroidManifest.xml
- ✅ Network security config allows cleartext for dev server
- ✅ BLASTI branding colors applied (#10b981 emerald) in styles.xml and icon backgrounds
- ✅ Web app still serves correctly after next.config.ts change (HTTP 200)
- ✅ ESLint clean

## Known Limitations / Manual Steps

1. **No Android SDK in this environment** — Cannot run actual Gradle build; configuration validated only
2. **Placeholder icons** — Using default Capacitor template icons; replace with BLASTI custom icons
3. **No google-services.json** — Push notifications via FCM require this file; will skip Google Services plugin gracefully
4. **Splash screen** — Using default Capacitor splash; consider creating custom BLASTI splash images
5. **Alarm sound** — `blasti_alarm.wav` needs to be placed in `android/app/src/main/res/raw/`
6. **ic_stat_blasti** — The small notification icon referenced in capacitor.config.ts needs to be created in `android/app/src/main/res/drawable/`
7. **capacitor-cordova-android-plugins** — This directory is generated by `cap sync android`; not included in the project
8. **Signing config** — Release builds require a keystore; configure in `android/app/build.gradle` or via `capacitor.config.ts` buildOptions
