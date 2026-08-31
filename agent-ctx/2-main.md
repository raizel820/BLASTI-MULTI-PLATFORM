# Task ID: 2 — Agency Mobile "Simple Mode" (For Barbers/Mechanics)

## Agent: Main

## Summary
Implemented Phase 2: Agency Mobile "Simple Mode" — an always-on, finger-friendly mobile dashboard for barbers, mechanics, and other service providers who use BLASTI on their phones.

## Work Completed

### 2.1 Install Keep-Awake Plugin
- Attempted `npm install @capacitor-community/keep-awake` in the mobile app directory — failed due to workspace protocol incompatibility
- Manually added `@capacitor-community/keep-awake: "^7.0.0"` to `/home/z/my-project/apps/mobile/package.json` dependencies
- The web version uses the WakeLock API as fallback (see component implementation)

### 2.2 Build SimpleMobileDashboard.tsx
Created `/home/z/my-project/apps/web/src/components/agency/dashboard/SimpleMobileDashboard.tsx` with:

**KeepAwake Integration:**
- Uses WakeLock API (web standard) as primary screen-awake mechanism
- Checks for Capacitor KeepAwake via `window.__CAPACITOR_KEEP_AWAKE__` bridge for native builds
- Re-acquires wake lock on visibility change (when user switches back to the tab)
- Properly cleans up wake lock on component unmount

**Massive "Currently Serving" Number:**
- 40vw responsive font size with `text-[min(40vw,180px)]` for maximum visibility
- Gradient text effect (emerald → teal → cyan) with animated background shift
- Pulsing glow animation using framer-motion
- Blur backdrop effect behind the number for emphasis
- AnimatePresence for smooth transitions when ticket numbers change

**Giant "Call Next" Button:**
- Full-width, min-height 80px button
- Bright gradient (emerald-600 → teal-500 → cyan-500)
- Shadow glow effect
- Scale-down animation on press (haptic-like feedback)
- Disabled state when queue is paused
- Loading spinner during API call

**No-Show Action with SlideToConfirm:**
- Uses existing `<SlideToConfirm />` component from `@/components/shared/slide-to-confirm`
- Wrapped in a red-themed container with label
- Only shown when a customer is currently being served

**Key Stats Row:**
- Three big tiles: Waiting count, Completed today, Avg service time
- Each tile has icon, large number, and label
- Backdrop blur styling with subtle borders

**Additional Features:**
- Mark Completed button (emerald gradient)
- Pause/Resume queue toggle (amber for pause, emerald for resume)
- Sound toggle for queue events
- Connection status indicator (Wifi icon, green/amber)
- Auto-refresh every 30 seconds
- Real-time updates via useRealtime hook (subscribes to all queue events)
- Loading state with spinner
- Error handling with toast notifications
- Agency name in top bar
- Last updated timestamp
- RTL support via language detection

**API Endpoints Used:**
- `GET /api/agency/stats?agencyId=` — dashboard stats
- `GET /api/agency/queue?agencyId=&status=CALLED` — currently serving
- `POST /api/agency/queue/call-next` — call next customer
- `PUT /api/reservations/:id/status` — mark completed/no-show
- `PUT /api/queue/pause` — pause queue
- `PUT /api/queue/resume` — resume queue

### 2.3 Implement Auto-Routing
Modified `/home/z/my-project/apps/web/src/components/agency/agency-dashboard.tsx`:

- Added imports: `useIsMobile` hook and `SimpleMobileDashboard` component
- Called `useIsMobile()` hook at the top of `AgencyDashboard` component (after all other hooks)
- Added conditional return after all hooks are called (after the last `useMemo` at line 746):
  - If `isMobile` is true, renders `<SimpleMobileDashboard agencyId={agencyId} />`
  - Otherwise, continues with the full desktop dashboard
- This ensures all React hooks are called in consistent order (no rules-of-hooks violation)

### 2.4 Verification
- Dev server runs without crashes
- No module resolution errors for new component
- Pre-existing `@capacitor/local-notifications` warning is unrelated to our changes
- Lint warnings are consistent with existing codebase patterns (setState in effect, etc.)
- The mobile dashboard properly renders when viewport < 768px

## Files Modified
- `/home/z/my-project/apps/mobile/package.json` — Added @capacitor-community/keep-awake dependency
- `/home/z/my-project/apps/web/src/components/agency/dashboard/SimpleMobileDashboard.tsx` — New file (697 lines)
- `/home/z/my-project/apps/web/src/components/agency/agency-dashboard.tsx` — Added mobile auto-routing

## Design Decisions
1. Used WakeLock API as primary keep-awake method (works in all modern browsers) with Capacitor bridge detection for native builds, avoiding the bundling issue with dynamic `import('@capacitor-community/keep-awake')` in the web app
2. Placed the mobile conditional return after all hooks to avoid React rules-of-hooks violations
3. Used the existing `useRealtime` hook (from `.ts` file) rather than the `.tsx` variant for consistency with the agency dashboard
4. The component is fully self-contained — it fetches its own data independently from the desktop dashboard
