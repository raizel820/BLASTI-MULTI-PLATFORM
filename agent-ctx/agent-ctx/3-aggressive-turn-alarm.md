# Task 3: Aggressive Customer Turn Alarm

## Work Summary

Phase 3 implemented the aggressive full-screen turn alert for customers and wired it into the realtime system.

### 3.1 Notification Plugins
- Verified `@capacitor/local-notifications` and `@capacitor/push-notifications` are already in `/home/z/my-project/apps/mobile/package.json`
- Install via npm failed due to monorepo workspace protocol, but packages are already present

### 3.2 Android Permissions
- Android project doesn't exist yet (no `android/app/src/main/AndroidManifest.xml`)
- Created `/home/z/my-project/apps/mobile/android/PERMISSIONS.md` documenting the 4 required permissions:
  - `WAKE_LOCK` — wake device screen on turn call
  - `VIBRATE` — phone vibration during alert
  - `USE_FULL_SCREEN_INTENT` — full-screen intent over lock screen
  - `POST_NOTIFICATIONS` — Android 13+ notification permission

### 3.3 Custom Audio File
- Created directory: `/home/z/my-project/apps/mobile/android/app/src/main/res/raw/`
- Added `.gitkeep` placeholder and `README.md` documenting that `blasti_alarm.wav` should be placed there

### 3.4 Notification Channel Utility
- Created `/home/z/my-project/apps/web/src/lib/notification-channel.ts`
- Uses `window.Capacitor.Plugins.LocalNotifications` (not direct import) to avoid web bundling errors
- Provides `setupTurnAlertChannel()` and `scheduleTurnNotification()` functions
- Falls back to Web Notification API on non-Capacitor platforms
- Channel config: `blasti-turn-alert` with max importance (5), custom alarm sound, vibration, lights

### 3.5 AggressiveTurnAlert Component
- Created `/home/z/my-project/apps/web/src/components/customer/AggressiveTurnAlert.tsx`
- Full-screen overlay (`fixed inset-0 z-[9999]`)
- Flashing red/green background (600ms interval)
- Massive "إنه دورك!" / "It's Your Turn!" text with pulsing animation
- Giant ticket number display
- Animated bell icon
- Sound toggle (mute/unmute)
- Uses existing `startNotificationSound`/`stopNotificationSound` from `@/lib/sounds`
- Also attempts to play `/blasti_alarm.wav` audio file
- Phone vibration via `navigator.vibrate()` with repeating pattern
- Giant "أنا هنا" / "I'm Here" dismiss button (color matches flash)
- Uses `AnimatePresence` for smooth enter/exit transitions

### 3.6 i18n Keys Added
Added to all 3 translation files (ar.ts, en.ts, fr.ts):
- `itIsYourTurn`: "إنه دورك!" / "It's Your Turn!" / "C'est votre tour !"
- `imHere`: "أنا هنا" / "I'm Here" / "Je suis là"
- `turnAlertSubtitle`: "تم استدعاء دورك" / "Your turn has been called" / "Votre tour a été appelé"

### 3.7 useTurnAlert Hook
- Added to both `/home/z/my-project/apps/web/src/hooks/use-realtime.ts` AND `.tsx`
- The `.tsx` file is what the bundler resolves (it has priority over `.ts`)
- Listens for `notification:your-turn` and `queue:called` Socket.IO events
- Filters events by `userId` match
- On match: sets `showTurnAlert=true`, stores ticket number & agency name
- Also fires `scheduleTurnNotification()` via notification-channel
- Provides `dismissTurnAlert()` callback that clears state after 500ms delay

### 3.8 Integration into Main Page
- Modified `/home/z/my-project/apps/web/src/app/page.tsx`:
  - Added imports for `useTurnAlert` and `AggressiveTurnAlert`
  - Hook called with `user?.id` when role is CUSTOMER (always called to satisfy hooks rules)
  - `<AggressiveTurnAlert>` placed outside main containers, after `<Toaster>`, before `<OnboardingWizard>`
  - Component covers everything with `z-[9999]` when triggered

### Key Design Decisions
1. **Capacitor module access**: Used `window.Capacitor.Plugins.LocalNotifications` instead of direct import to avoid Turbopack/webpack resolution errors on web
2. **Hook placement**: Integrated into main `page.tsx` (not `customer/page.tsx`) since customer views are rendered there via ViewRouter
3. **Sound**: Reuses existing `sounds.ts` chime system as primary, with WAV file as secondary
4. **Both .ts and .tsx**: Added hook to both realtime files since the bundler resolves to `.tsx`

### Dev Server Status
- App compiles and serves successfully (HTTP 200)
- No new lint errors introduced (1 unused eslint-disable directive fixed)
- Pre-existing `@capacitor-community/keep-awake` error in SimpleMobileDashboard remains (not from our changes)
