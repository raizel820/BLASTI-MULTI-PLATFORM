# BLASTI — Local Development & Testing Guide

Complete guide for running, developing, and testing the BLASTI multi-agency queue management system on your local machine.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Prerequisites](#2-prerequisites)
3. [Initial Setup](#3-initial-setup)
4. [Running the App](#4-running-the-app)
5. [Test Accounts & Login](#5-test-accounts--login)
6. [Testing Each Role](#6-testing-each-role)
7. [Testing Core Features](#7-testing-core-features)
8. [Testing the Desktop App (Electron)](#8-testing-the-desktop-app-electron)
9. [Testing the Mobile App (Capacitor)](#9-testing-the-mobile-app-capacitor)
10. [Cross-Platform Testing Matrix](#10-cross-platform-testing-matrix)
11. [Testing API Endpoints](#11-testing-api-endpoints)
12. [Testing Real-Time (Socket.IO)](#12-testing-real-time-socketio)
13. [Testing Device Mode (Kiosk & TV)](#13-testing-device-mode-kiosk--tv)
14. [Project Structure](#14-project-structure)
15. [Environment Variables](#15-environment-variables)
16. [Common Development Tasks](#16-common-development-tasks)
17. [Troubleshooting](#17-troubleshooting)

---

## 1. Architecture Overview

BLASTI is a **cross-platform monorepo** with 3 running server components and 3 client shells:

```
┌──────────────────────────────────────────────────────────────┐
│                     Caddy Gateway (port 81)                   │
│         Routes /api/* → API, /socket.io/* → API, /* → Web    │
├────────────────────────┬─────────────────────────────────────┤
│                        │                                     │
│   Next.js 16 Frontend │   Hono + Socket.IO Backend          │
│   localhost:3000       │   localhost:3003                     │
│                        │                                     │
│   • SSR + Static Export│   • REST API (/api/*)               │
│   • React Components   │   • WebSocket real-time events      │
│   • Tailwind + shadcn  │   • JWT Auth (cookie-based)         │
│   • Zustand State      │   • ETA Calculation Engine          │
│   • i18n (ar/en/fr)    │   • Rate Limiting                   │
│                        │                                     │
├────────────────────────┴─────────────────────────────────────┤
│                    SQLite Database                            │
│              packages/db/data/custom.db                       │
│              (Prisma ORM — @blasti/db package)                │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│                   3 Client Shells                             │
├──────────────────┬───────────────────┬───────────────────────┤
│   🌐 Web Browser│  🖥️ Electron App  │  📱 Capacitor App    │
│   (any browser) │  (Windows/Mac/    │  (Android/iOS)        │
│                 │   Linux)          │                       │
│   • Same React  │  • Bundled static │  • Bundled static     │
│     codebase    │    files in out/  │    files in out/      │
│   • Relative    │  • Native OS      │  • Native plugins     │
│     API URLs    │    notifications  │    (Camera, Haptics,  │
│   • Cookie auth │  • System tray    │    Push, Share,       │
│   • Socket.IO   │  • Deep links     │    LocalNotif)        │
│     WS         │  • Window controls│  • Deep links         │
│                 │  • Badge counts   │  • Android back btn   │
│                 │  • Auto-updates   │  • Push notifications │
│                 │  • Offline mode   │  • QR Scanner         │
├──────────────────┴───────────────────┴───────────────────────┤
│   All 3 shells share the SAME web codebase (apps/web/)       │
│   Platform detection: window.electronAPI / window.Capacitor  │
│   Native bridge: apps/web/src/lib/native-bridge.ts           │
│   Adapters: apps/web/src/lib/adapters/                       │
└──────────────────────────────────────────────────────────────┘
```

**Data flow:**
- Frontend makes API calls to `/api/*` → Caddy proxies to port 3003 (Hono API)
- Frontend connects to Socket.IO at `/socket.io/*` → Caddy proxies to port 3003
- Hono API reads/writes to SQLite via Prisma (`@blasti/db` package)
- No database access in the frontend — all DB calls happen in the API server

---

## 2. Prerequisites

| Tool | Version | Install |
|---|---|---|
| **Bun** | >= 1.0.0 | `curl -fsSL https://bun.sh/install \| bash` |
| **Node.js** | >= 18 | `nvm install 18` or system package manager |
| **Git** | Any | System package manager |

Verify installations:
```bash
bun --version    # Should be >= 1.0.0
node --version   # Should be >= 18.0.0
git --version
```

---

## 3. Initial Setup

### Step 1: Clone & Install

```bash
# Clone the repository
git clone <your-repo-url> blasti-multiplatform
cd blasti-multiplatform

# Install all workspace dependencies
bun install
```

### Step 2: Initialize the Database

```bash
# Create database tables from Prisma schema
bun run db:push

# Seed the database with demo data
bun run db:seed
```

**What seeding creates:**
- 👤 Admin user: `admin` / `admin123` (role: SUPER_ADMIN)
- 👤 Customer user: `customer1` / `customer123` (role: CUSTOMER)
- 🏢 Demo Agency "BLASTI Demo Agency" (code: DEMO001)
- 🌿 Main Branch with 1 Counter
- 📋 "General Service" with prefix "A"
- ⚙️ Queue settings (serving: 0, issued: 0)
- 📱 SMS settings (disabled)
- 💳 Payment settings (disabled)
- ❓ 7 FAQ entries (trilingual: en/ar/fr)

### Step 3: Verify Database

```bash
# Check the database file exists
ls -la packages/db/data/custom.db

# Quick query test
cd packages/db && bun -e "
const { db } = require('./index');
db.user.findMany({ select: { username: true, role: true } })
  .then(users => { console.log('Users:', users); return db.\$disconnect(); })
"
```

---

## 4. Running the App

You need **two servers** running simultaneously. Open **two terminal windows**:

### Terminal 1 — Start the API Server

```bash
bun run dev:api
```

Wait for this output:
```
🚀 @blasti/api server running on port 3003
   API:    http://localhost:3003/
   Health: http://localhost:3003/health
   Routes: http://localhost:3003/api/*
```

### Terminal 2 — Start the Web Frontend

```bash
bun run dev:web
```

Wait for this output:
```
▲ Next.js 16.1.3 (Turbopack)
- Local:   http://localhost:3000
✓ Ready in Xms
```

> **💡 Windows Users:** If you prefer a single command instead of two terminals, see the [Windows Users section](#windows-users) below.

### Alternative — Start Both at Once (concurrently)

```bash
bun run dev
```

This uses `concurrently` to start both servers in a single terminal with color-coded output. Press `Ctrl+C` to stop both at once.

### Verify Both Servers

```bash
# Test the API
curl http://localhost:3003/health
# Expected: {"status":"ok","service":"@blasti/api",...}

# Test the frontend
curl -s http://localhost:3000 | head -5
# Expected: HTML output starting with <!DOCTYPE html>

# Test the Caddy gateway (port 81)
curl http://localhost:81/api/agencies
# Expected: JSON array of agencies
```

### Windows Users

> **Important:** The shell scripts (`*.sh`) in the `scripts/` folder are for Linux/macOS only.
> On Windows, use one of these methods:

**Option 1 — Two Terminal Windows (Recommended):**
1. Open Terminal 1 and run: `bun run dev:api`
2. Open Terminal 2 and run: `bun run dev:web`

**Option 2 — Single Command (concurrently):**
```bash
bun run dev
```
This starts both API and Web servers with color-coded output.

**Option 3 — PowerShell Launcher:**
```powershell
.\start-dev.ps1
```
Opens both servers in separate windows automatically (if available in your project).

> **💡 Tip:** On Windows, use `PowerShell` or `Windows Terminal` instead of `Command Prompt` for the best experience. You can open multiple tabs in Windows Terminal for the two-terminal approach.

---

## 5. Test Accounts & Login

| Role | Username | Password | Dashboard |
|---|---|---|---|
| **Super Admin** | `admin` | `admin123` | `/admin` |
| **Agency Owner** | `admin` | `admin123` | `/agency` |
| **Customer** | `customer1` | `customer123` | `/customer` |

> **Note:** The `admin` user has SUPER_ADMIN role and also owns the demo agency, so they can access both admin and agency dashboards.

### How to Login

1. Open `http://localhost:3000` in your browser
2. Click **"Login"** or navigate to `/#/login`
3. Choose the correct tab:
   - **Customer tab** → for `customer1`
   - **Agency tab** → for `admin` (agency access)
4. Enter credentials and submit

### Quick Login via API (for testing)

```bash
# Login as admin
curl -X POST http://localhost:3003/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}' \
  -c cookies.txt

# Login as customer
curl -X POST http://localhost:3003/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"customer1","password":"customer123"}' \
  -c cookies.txt

# Check current session
curl http://localhost:3003/api/auth/session -b cookies.txt
```

---

## 6. Testing Each Role

### 🔴 Super Admin Dashboard (`/admin`)

After logging in as `admin`, navigate to `/admin`:

| Page | URL | What to Test |
|---|---|---|
| **Dashboard** | `/admin` | System health panel, agency sync monitoring, stats cards, quick actions |
| **Agencies** | `/admin/agencies` | List all agencies, view details, manage subscriptions |
| **Users** | `/admin/users` | List all users, search, view roles, deactivate accounts |
| **Transactions** | `/admin/transactions` | Payment history, approve/reject pending transactions |
| **Audit Logs** | `/admin/audit` | Recent actions, filter by user/action type |
| **Analytics** | `/admin/analytics` | Charts for reservations, users, revenue over time |
| **Settings** | `/admin/settings` | Global SMS config, payment settings, platform settings |
| **FAQ Manager** | `/admin/settings` | Add/edit/delete FAQ entries in 3 languages |

### 🟢 Agency Dashboard (`/agency`)

After logging in as `admin`, navigate to `/agency`:

| Page | URL | What to Test |
|---|---|---|
| **Dashboard** | `/agency` | Live queue management — **THE CORE FEATURE** |
| **Employees** | `/agency/employees` | Add/remove staff, set permissions, assign to branches |
| **Reviews** | `/agency/reviews` | View customer reviews, reply, see rating distribution |
| **Profile** | `/agency/profile` | Edit agency name, description, working hours, logo |
| **Settings** | `/agency/settings` | Queue config, SMS notifications, kiosk mode |
| **Subscription** | `/agency/subscription` | Current plan, upgrade, payment history |
| **QR Display** | Agency dashboard | Click QR button to show scannable QR code |

**Agency Dashboard Key Actions:**
- **Call Next** → Calls the next waiting customer, updates their ETA to 0
- **Skip No-Show** → Marks current ticket as no-show, moves to next
- **Pause Queue** → Temporarily stops new ticket issuance
- **Walk-in Ticket** → Creates an instant ticket for a walk-in customer
- **Counter Management** → Open/close service counters

### 🔵 Customer Portal (`/customer`)

After logging in as `customer1`, navigate to `/customer`:

| Page | URL | What to Test |
|---|---|---|
| **Home** | `/customer` | Browse agencies, search, filter by category |
| **Queue** | `/customer/queue` | Active reservations with real-time ETA |
| **History** | `/customer/history` | Past reservations, rate completed services |
| **Favorites** | `/customer/favorites` | Saved/bookmarked agencies |
| **Notifications** | `/customer/notifications` | In-app notification center |
| **Profile** | `/customer/profile` | Edit name, phone, password, language, theme |

---

## 7. Testing Core Features

### Feature 1: Full Queue Lifecycle (Walk-in)

This is the most important test — the complete queue flow:

```
Step 1: Login as Customer (customer1/customer123)
        ↓
Step 2: Browse agencies → Find "BLASTI Demo Agency"
        ↓
Step 3: Click "Join Queue" → Select "General Service"
        ↓
Step 4: See ticket confirmation (e.g., A-001, Position 1, ETA ≈ 8-10 min)
        ↓
Step 5: Open another browser/tab → Login as Agency (admin/admin123)
        ↓
Step 6: In agency dashboard, click "Call Next"
        ↓
Step 7: Switch back to customer tab → Status changes to "Called"
        ↓
Step 8: In agency dashboard, click "Complete" → Status changes to "Completed"
        ↓
Step 9: Customer gets rating prompt → Rate 1-5 stars, leave feedback
```

### Feature 2: Real-Time ETA Updates

1. Join a queue as a customer → Note the ETA range (e.g., "≈ 8–12 min")
2. Open a second customer account and join the same queue
3. The first customer's ETA should increase (more people ahead)
4. As the agency calls next/skips no-show, ETAs update live via Socket.IO

### Feature 3: Walk-in Tickets

1. In the agency dashboard → Click the "Walk-in" button
2. Enter a customer name (e.g., "محمد سعيد")
3. A ticket is created immediately with a "Walk-in" badge
4. Walk-in tickets are mixed into the same queue as online reservations

### Feature 4: QR Code Flow

1. In agency dashboard → Click the QR code display button
2. A QR code appears encoding the agency's unique URL
3. Scan with a phone camera → Opens the reservation page for that agency
4. New customers can join the queue directly from the QR link

### Feature 5: Offline Mode

1. Stop the API server (`bun run dev:api`) while the web is running
2. The agency dashboard shows an "Offline Mode Active" banner
3. Queue operations still work locally (queued for sync)
4. Restart the API server → Data syncs automatically
5. The "Online" indicator returns with "Last synced" timestamp

### Feature 6: Kiosk Mode

1. From the landing page → Click "Kiosk Mode" or navigate to `/kiosk`
2. Full-screen display optimized for TV/monitor
3. Shows: current serving number, waiting count, estimated wait
4. Service selector for self-service ticket printing

### Feature 7: Multi-Language Support

1. Click the language switcher in the header (🌐 icon)
2. Switch between: العربية (Arabic RTL), English, Français
3. All UI text updates instantly — including queue labels, ETAs, forms
4. Arabic layout properly mirrors (RTL direction)

### Feature 8: Dark/Light Theme

1. Click the theme toggle in the header (🌙/☀️ icon)
2. The entire app switches between dark and light modes
3. Charts, cards, and all components adapt

---

## 8. Testing the Desktop App (Electron)

The BLASTI desktop app wraps the web app in an Electron shell, adding native OS features like system tray, OS notifications, window controls, deep links, and offline support.

### Prerequisites

```bash
# Electron and electron-builder are already in apps/desktop/package.json
# Just install workspace dependencies
bun install
```

### Running the Desktop App in Dev Mode

**Terminal 1** — Start the API server (required):
```bash
bun run dev:api
```

**Terminal 2** — Start the Next.js dev server:
```bash
bun run dev:web
```

**Terminal 3** — Launch the Electron shell:
```bash
bun run electron:dev
```

This opens a native desktop window loading `http://localhost:3000`. The Electron main process (`apps/desktop/main.js`) detects dev mode and loads from the dev server.

### Building the Desktop App (.exe / .dmg / .AppImage)

```bash
# Step 1: Build the Next.js static export
bun run build

# Step 2: Build the desktop app for your platform
bun run electron:build:win      # Windows → apps/desktop/dist/BLASTI-Setup-0.2.0.exe
bun run electron:build:mac      # macOS → apps/desktop/dist/BLASTI-0.2.0.dmg
bun run electron:build:linux    # Linux → apps/desktop/dist/BLASTI-0.2.0.AppImage
bun run electron:build          # Current platform (auto-detected)
```

The build script automatically copies `apps/web/out/` → `apps/desktop/out/` before packaging.

### Desktop-Specific Features to Test

#### Test 1: Native Window Controls
```
1. Launch the desktop app (bun run electron:dev)
2. ✓ Window opens with title "BLASTI - بلاصتي"
3. ✓ Minimize button works
4. ✓ Maximize/restore button works
5. ✓ Close button → minimizes to system tray (doesn't quit)
6. ✓ Double-click title bar toggles maximize
```

#### Test 2: System Tray
```
1. Close the window → app minimizes to tray (if tray icon exists)
2. Click tray icon → window reappears
3. Right-click tray → context menu with:
   • "فتح BLASTI" (Open BLASTI)
   • "خروج" (Exit)
4. Click "فتح BLASTI" → window shows and focuses
5. Click "خروج" → app fully quits
```

#### Test 3: OS Notifications
```
1. Login as agency (admin/admin123)
2. When a customer joins the queue → OS notification appears
3. Click the notification → BLASTI window focuses
4. In DevTools console, test manually:
   window.electronAPI.sendNotification('Test', 'Hello from BLASTI')
```

#### Test 4: Deep Links
```
1. Open a terminal and run:
   xdg-open "blasti://agency"     # Linux
   open "blasti://agency"          # macOS
   start "blasti://agency"         # Windows
2. BLASTI desktop app opens/focuses
3. The app navigates to the agency section
4. Test with other paths: blasti://customer, blasti://admin
```

#### Test 5: Offline Mode (Desktop)
```
1. Build the desktop app (bun run electron:build)
2. The built app bundles static files in apps/desktop/out/
3. Disconnect from the internet
4. Launch the desktop app → Shows the landing page (from bundled files)
5. API calls fail gracefully → "Offline Mode" banner appears
6. Reconnect → API calls resume automatically
```

#### Test 6: Badge Count
```
1. In DevTools console:
   window.electronAPI.setBadge(3)
2. macOS: Dock icon shows "3" badge
3. Windows: Taskbar overlay shows count (if badge.png exists)
4. Reset: window.electronAPI.setBadge(0)
```

#### Test 7: Single Instance Lock
```
1. Launch BLASTI desktop app
2. Try to launch a second instance
3. ✓ Second instance is blocked
4. ✓ First instance window is brought to focus
```

#### Test 8: Production Build Test
```
1. bun run build && bun run electron:build
2. Run the built executable from apps/desktop/dist/
3. ✓ App loads from bundled static files (no dev server needed)
4. ✓ Set BLASTI_API_URL env var to point to your API server
5. ✓ All features work: login, queue, notifications, tray
```

### Desktop Environment Variables

| Variable | Default | Description |
|---|---|---|
| `BLASTI_API_URL` | `https://blasti.vercel.app` | API server URL for production |
| `BLASTI_REMOTE_URL` | — | If set, loads from this URL instead of bundled files |
| `ELECTRON_DEV` | — | Set to force dev mode |
| `NODE_ENV` | — | Set to `production` for production mode |

---

## 9. Testing the Mobile App (Capacitor)

The BLASTI mobile app wraps the web app in a Capacitor native shell, adding mobile-native features like haptic feedback, push notifications, camera/QR scanning, native share sheet, and deep links.

### Prerequisites

| Tool | Version | Install |
|---|---|---|
| **Android Studio** | Latest | https://developer.android.com/studio |
| **Android SDK** | API 33+ | Installed via Android Studio |
| **JDK** | 17+ | `brew install openjdk@17` or system package |
| **Gradle** | 8+ | Comes with Android Studio |
| **Xcode** | 15+ (iOS only) | Mac App Store (macOS only) |

### Running the Mobile App in Dev Mode (Live Reload)

This is the fastest way to test on a real device during development:

**Terminal 1** — Start the API server:
```bash
bun run dev:api
```

**Terminal 2** — Start the Next.js dev server:
```bash
bun run dev:web
```

**Terminal 3** — Sync and run on device:
```bash
# Set your machine's IP address for the dev server
export CAPACITOR_SERVER_URL="http://YOUR_MACHINE_IP:3000"

# Sync web files to Capacitor
bun run cap:sync:android

# Run on connected Android device/emulator
bun run cap:run:android

# OR open in Android Studio for more control
bun run cap:open:android
```

> **Important:** Replace `YOUR_MACHINE_IP` with your actual local IP (e.g., `192.168.1.100`). Find it with `ifconfig` (macOS/Linux) or `ipconfig` (Windows). Both the phone and computer must be on the same WiFi network.

### Building the Mobile App (APK)

```bash
# Step 1: Build the Next.js static export
bun run build

# Step 2: Sync web files to Capacitor
bun run cap:sync:android

# Step 3: Open in Android Studio
bun run cap:open:android

# Step 4: In Android Studio → Build > Build APK(s)
# OR from command line:
cd apps/mobile/android && ./gradlew assembleDebug

# Output: apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

### Running on iOS (macOS only)

```bash
bun run build
bun run cap:sync:ios
bun run cap:open:ios
# In Xcode: Select simulator/device → Product > Run
```

### Mobile-Specific Features to Test

#### Test 1: Haptic Feedback (Vibration)
```
1. Launch the app on a real Android/iOS device
2. Login as customer
3. Join a queue → Feel the haptic vibration on ticket creation
4. When your turn is called → Feel a different vibration pattern
5. Test in DevTools console (Chrome remote debugging):
   window.__BLASTI_NATIVE__.vibrate('success')
   window.__BLASTI_NATIVE__.vibrate('warning')
   window.__BLASTI_NATIVE__.vibrate('error')
   window.__BLASTI_NATIVE__.vibrate('light')
   window.__BLASTI_NATIVE__.vibrate('heavy')
```

#### Test 2: Push Notifications
```
1. Launch the app on a real device
2. Login as customer
3. Join a queue
4. When the agency calls your ticket → Push notification appears
5. Tap the notification → App opens to your queue status

Test via DevTools:
   window.__BLASTI_NATIVE__.requestNotificationPermission()
   window.__BLASTI_NATIVE__.showNotification({
     title: 'BLASTI',
     body: 'Your turn is approaching! Ticket A-003'
   })
```

#### Test 3: QR Code Scanning
```
1. From the customer home screen → Tap the QR scanner icon
2. Camera opens → Point at a BLASTI agency QR code
3. Scanned URL opens the agency's reservation page
4. Customer can join the queue directly

Test via DevTools:
   nativeBridge.scanQR()  // Opens camera on native, returns null on web
```

#### Test 4: Native Share Sheet
```
1. View an agency → Tap the share button
2. Android share sheet opens with options (WhatsApp, SMS, etc.)
3. Share the agency link

Test via DevTools:
   nativeBridge.shareContent({
     title: 'BLASTI Demo Agency',
     text: 'Join the queue at BLASTI Demo Agency',
     url: 'https://blasti.app/agency/DEMO001'
   })
```

#### Test 5: Deep Links (blasti://)
```
1. On the device, open a link like: blasti://customer/queue
2. BLASTI app opens and navigates to the queue page
3. Test with adb (Android):
   adb shell am start -a android.intent.action.VIEW -d "blasti://customer/queue"
```

#### Test 6: Android Back Button
```
1. Navigate to Customer → Queue → Profile
2. Press Android back button → Goes back to Queue
3. Press back again → Goes back to Customer home
4. Press back one more time → App minimizes (doesn't close)
```

#### Test 7: App Lifecycle (Background/Foreground)
```
1. Open BLASTI, join a queue
2. Press home button → App goes to background
3. Socket.IO may disconnect (expected)
4. Bring app back → App reconnects, data refreshes
5. Queue position is still accurate

Test via DevTools:
   window.addEventListener('blasti:app-pause', () => console.log('Paused'))
   window.addEventListener('blasti:app-resume', () => console.log('Resumed'))
```

#### Test 8: Camera (Photo Upload)
```
1. Login as agency (admin/admin123)
2. Go to Profile → Change logo
3. Tap "Choose File" → Camera option appears
4. Take photo → Photo uploads as agency logo
```

#### Test 9: Local Notifications (Scheduled Reminders)
```
1. Join a queue with ETA ≈ 15 minutes
2. When 10 minutes remain → Local notification fires
3. When your turn is called → Urgent notification fires
4. Tap notification → Opens app to queue view
```

#### Test 10: Splash Screen
```
1. Kill the app completely
2. Relaunch → Green splash screen appears for 2 seconds
3. Status bar matches the emerald BLASTI theme
4. App loads and transitions smoothly to the main screen
```

### Mobile DevTools (Remote Debugging)

**Android (Chrome DevTools):**
```
1. Enable USB debugging on your Android device
2. Connect via USB
3. Open Chrome → chrome://inspect
4. Find your device → Click "inspect"
5. Full DevTools access (Console, Network, Elements)
```

**iOS (Safari Web Inspector):**
```
1. Enable Web Inspector on iOS: Settings → Safari → Advanced → Web Inspector
2. Connect via USB
3. Open Safari → Develop → [Your Device] → [WebView]
4. Full Web Inspector access
```

### Mobile Environment Variables

| Variable | Default | Description |
|---|---|---|
| `CAPACITOR_SERVER_URL` | — | Set to `http://IP:3000` for live reload during dev |
| `NEXT_PUBLIC_API_URL` | — | Production API URL (used by native shell) |

---

## 10. Cross-Platform Testing Matrix

Test the same features across all 3 platforms to ensure consistent behavior:

### Critical Path Tests (Must Pass on All Platforms)

| # | Test Case | Web Browser | Electron Desktop | Capacitor Mobile |
|---|---|---|---|---|
| 1 | Login as customer | ☐ | ☐ | ☐ |
| 2 | Login as agency | ☐ | ☐ | ☐ |
| 3 | Browse agencies | ☐ | ☐ | ☐ |
| 4 | Join queue | ☐ | ☐ | ☐ |
| 5 | See ETA range | ☐ | ☐ | ☐ |
| 6 | Call next ticket | ☐ | ☐ | ☐ |
| 7 | Real-time ETA update | ☐ | ☐ | ☐ |
| 8 | Walk-in ticket | ☐ | ☐ | ☐ |
| 9 | Complete service | ☐ | ☐ | ☐ |
| 10 | Rate service | ☐ | ☐ | ☐ |
| 11 | QR code display | ☐ | ☐ | ☐ |
| 12 | Language switch (ar/en/fr) | ☐ | ☐ | ☐ |
| 13 | Dark/light theme | ☐ | ☐ | ☐ |
| 14 | Offline mode indicator | ☐ | ☐ | ☐ |
| 15 | Notification received | ☐ Browser API | ☐ OS native | ☐ Push/Local |
| 16 | Deep link navigation | — | ☐ blasti:// | ☐ blasti:// |
| 17 | Share agency link | ☐ Web Share | — | ☐ Native share |
| 18 | QR code scanning | — | — | ☐ Camera |
| 19 | Haptic feedback | — | — | ☐ Vibration |
| 20 | Window minimize/tray | — | ☐ | — |
| 21 | Badge count | — | ☐ Dock/Taskbar | — |
| 22 | Android back button | — | — | ☐ |
| 23 | App splash screen | — | — | ☐ |
| 24 | Camera/photo upload | ☐ File picker | ☐ File picker | ☐ Camera |
| 25 | Push notification tap | — | ☐ Click→focus | ☐ Tap→navigate |

### Platform-Specific Behavior Differences

| Feature | Web Browser | Electron Desktop | Capacitor Mobile |
|---|---|---|---|
| **API URL** | Relative (`/api/*`) | `BLASTI_API_URL` env var | `NEXT_PUBLIC_API_URL` env var |
| **Auth** | Cookie (auto-sent) | Cookie (auto-sent) | Bearer token in localStorage |
| **Notifications** | Browser Notification API | OS Notification via IPC | LocalNotifications + PushNotifications |
| **QR Scanning** | Not available | Not available | Camera plugin |
| **Share** | Web Share API | Not available | Share plugin (native sheet) |
| **Storage** | localStorage | localStorage | Capacitor Preferences |
| **Deep Links** | URL hash routing | `blasti://` protocol | `blasti://` app links |
| **Offline** | Service Worker (partial) | Bundled files + offline page | Bundled files in WebView |
| **Window Controls** | Browser handles | Custom titlebar + tray | OS navigation bar |
| **Back Navigation** | Browser back button | Alt+Left | Android back button |

### Full System Integration Test

This is the ultimate end-to-end test — all 3 platforms working together:

```
Setup:
  ┌─ Terminal 1: bun run dev:api      (API server running)
  ├─ Terminal 2: bun run dev:web     (Web server running)
  └─ Terminal 3: bun run electron:dev  (Desktop app running)

Test Flow:
  Step 1: On MOBILE (Capacitor) → Login as customer1 → Join "BLASTI Demo Agency" queue
          ✓ Ticket A-001 created, ETA ≈ 8-10 min on mobile screen
          ✓ Haptic vibration on ticket creation
          ✓ Push notification: "You joined the queue"

  Step 2: On WEB BROWSER → Login as another customer → Join same queue
          ✓ Ticket A-002 created, both customers see updated positions
          ✓ Customer 1's ETA increases (now ≈ 16-20 min)

  Step 3: On DESKTOP (Electron) → Login as agency (admin)
          ✓ Agency dashboard shows 2 waiting customers
          ✓ OS notification: "2 customers in queue"
          ✓ Dock badge shows "2"

  Step 4: On DESKTOP → Click "Call Next"
          ✓ Ticket A-001 status → "Called"
          ✓ MOBILE: Customer 1 sees "It's your turn!" with vibration
          ✓ MOBILE: Push notification fires
          ✓ WEB: Customer 2's ETA decreases (now ≈ 8-10 min)
          ✓ DESKTOP: Badge updates to "1"

  Step 5: On DESKTOP → Click "Complete"
          ✓ Ticket A-001 → "Completed"
          ✓ MOBILE: Customer 1 gets rating prompt
          ✓ Customer 1 rates 5 stars ✓

  Step 6: On DESKTOP → Click "Call Next" again
          ✓ Ticket A-002 → "Called"
          ✓ WEB: Customer 2 sees status update in real-time
          ✓ DESKTOP: Badge clears to "0"

  Step 7: Verify all platforms in sync
          ✓ DESKTOP: Queue shows 0 waiting, 2 completed
          ✓ WEB: Customer 2 history shows completed reservation
          ✓ MOBILE: Customer 1 history shows completed + rating
          ✓ All platforms: Same queue state, same ETA, same stats
```

### Testing the Native Bridge (DevTools Console)

Run these in the browser DevTools console to test the platform detection and native bridge:

```javascript
// ─── Platform Detection ──────────────────────────────
import { detectPlatform } from '@/lib/platform';
const info = detectPlatform();
console.log('Platform:', info.platform);  // 'web' | 'electron' | 'android' | 'ios'

// ─── Native Bridge ───────────────────────────────────
import { nativeBridge } from '@/lib/native-bridge';

// Test notifications
await nativeBridge.sendNotification('Test', 'Hello from BLASTI!');

// Test badge
await nativeBridge.setBadgeCount(3);

// Test share (mobile only)
await nativeBridge.shareContent({ title: 'BLASTI', url: 'https://blasti.app' });

// Test vibration (mobile only)
await nativeBridge.vibrate(200);

// Test QR scanning (mobile only)
const qrResult = await nativeBridge.scanQR();
console.log('QR scanned:', qrResult);

// ─── Adapters ────────────────────────────────────────
import { getNativeAdapters, getAdapterAvailability } from '@/lib/adapters';
const adapters = getNativeAdapters(info.platform);
console.log('Adapter availability:', getAdapterAvailability(adapters));

// ─── Capacitor Native Plugin (mobile only) ──────────
if (window.__BLASTI_NATIVE__) {
  const platformInfo = await window.__BLASTI_NATIVE__.getPlatform();
  console.log('Native platform:', platformInfo);
}

// ─── Electron API (desktop only) ────────────────────
if (window.electronAPI) {
  const version = await window.electronAPI.getAppVersion();
  console.log('Electron app version:', version);
  const plat = await window.electronAPI.getPlatform();
  console.log('Electron platform:', plat);
}
```

---

## 11. Testing API Endpoints

### Health & Info

```bash
# Health check
curl http://localhost:3003/health

# Server info
curl http://localhost:3003/

# Socket.IO stats
curl http://localhost:3003/stats
```

### Authentication

```bash
# Login as admin
curl -X POST http://localhost:3003/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}'

# Login as customer
curl -X POST http://localhost:3003/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"customer1","password":"customer123"}'

# Register new user
curl -X POST http://localhost:3003/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "username":"testuser",
    "fullName":"Test User",
    "password":"test123456",
    "phoneNumber":"+213 555 000 002",
    "role":"CUSTOMER"
  }'

# Check session (with cookie from login)
curl http://localhost:3003/api/auth/session -b cookies.txt

# Logout
curl -X POST http://localhost:3003/api/auth/logout -b cookies.txt
```

### Agencies

```bash
# List all agencies
curl http://localhost:3003/api/agencies

# Get single agency (replace ID)
curl http://localhost:3003/api/agencies/AGENCY_ID

# Agency stats (requires auth as agency owner)
curl http://localhost:3003/api/agency/stats -b cookies.txt
```

### Queue Operations

```bash
# Get queue status
curl "http://localhost:3003/api/queue/status?agencyId=AGENCY_ID"

# Join queue (create reservation)
curl -X POST http://localhost:3003/api/reservations \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{
    "agencyId":"AGENCY_ID",
    "serviceId":"SERVICE_ID"
  }'

# Call next (agency auth required)
curl -X POST http://localhost:3003/api/queue/call-next \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{"agencyId":"AGENCY_ID"}'

# Complete current
curl -X POST http://localhost:3003/api/queue/complete \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{"agencyId":"AGENCY_ID"}'

# Skip no-show
curl -X POST http://localhost:3003/api/queue/skip-no-show \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{"agencyId":"AGENCY_ID"}'

# Pause queue
curl -X POST http://localhost:3003/api/queue/pause \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{"agencyId":"AGENCY_ID"}'
```

### ETA & Sync

```bash
# Get ETA for a reservation
curl http://localhost:3003/api/reservations/RESERVATION_ID/eta

# Get sync status
curl http://localhost:3003/api/sync/status

# Get sync status for specific agency
curl "http://localhost:3003/api/sync/status?agencyId=AGENCY_ID"
```

### Other Endpoints

```bash
# Statistics
curl http://localhost:3003/api/stats

# Services for an agency
curl http://localhost:3003/api/services?agencyId=AGENCY_ID

# Reviews for an agency
curl http://localhost:3003/api/reviews?agencyId=AGENCY_ID

# FAQs
curl http://localhost:3003/api/faqs

# Notifications (requires auth)
curl http://localhost:3003/api/notifications -b cookies.txt

# QR code data
curl "http://localhost:3003/api/qr?agencyId=AGENCY_ID"
```

---

## 12. Testing Real-Time (Socket.IO)

### In Browser Console

Open `http://localhost:3000` and run in the browser DevTools console:

```javascript
// Connect to the Socket.IO server
const socket = io();

// Listen for connection
socket.on('connect', () => console.log('Connected:', socket.id));

// Join an agency room to receive queue updates
socket.emit('join:agency', 'AGENCY_ID');

// Listen for queue events
socket.on('queue:updated', (data) => console.log('Queue updated:', data));
socket.on('queue:called', (data) => console.log('Ticket called:', data));
socket.on('queue:completed', (data) => console.log('Ticket completed:', data));
socket.on('queue:skip-no-show', (data) => console.log('No-show:', data));
socket.on('queue:paused', (data) => console.log('Queue paused:', data));

// Listen for reservation events
socket.on('reservation:created', (data) => console.log('New reservation:', data));
socket.on('reservation:updated', (data) => console.log('Reservation updated:', data));

// Listen for notification events
socket.on('notification:new', (data) => console.log('New notification:', data));

// Disconnect
socket.disconnect();
```

### Testing Real-Time Flow

1. Open two browser tabs
2. Tab 1: Login as customer, join a queue
3. Tab 2: Login as agency, watch the WebSocket events
4. In Tab 2: Call next → See the event arrive in Tab 1's console
5. The customer's queue position and ETA update automatically

### Socket.IO Rooms

| Room Pattern | Who Joins | Events Received |
|---|---|---|
| `agency:{agencyId}` | Agency staff | queue:updated, queue:called, reservation:created |
| `customer:{userId}` | Individual customer | reservation:updated, notification:new |
| `kiosk:{agencyId}` | Kiosk displays | kiosk:update |
| `admin:global` | Super admins | admin:stats, admin:alert |

---

## 13. Testing Device Mode (Kiosk & TV)

### Opening Kiosk Mode

Open the kiosk self-service interface in your browser:

```
http://localhost:3000/?mode=device&type=KIOSK&agencyId=YOUR_AGENCY_ID
```

Replace `YOUR_AGENCY_ID` with your agency's ID (found in the database or via the agency settings API).

**What happens:**
1. The page detects `mode=device&type=KIOSK` URL params
2. It runs `quickDiscover()` to find the API server on LAN
3. It auto-registers as a KIOSK device via `POST /api/agency-devices/public/register`
4. It starts sending heartbeats every 30 seconds
5. The device appears in the Device Manager (Agency Settings → Devices)

### Opening TV Display Mode

Open the TV queue display board:

```
http://localhost:3000/?mode=device&type=TV&agencyId=YOUR_AGENCY_ID
```

**What happens:**
1. The page loads the `DeviceTvBoard` component
2. Auto-fullscreen activates after 1.5 seconds
3. Press **F** to toggle fullscreen manually
4. Auto-registers as a TV device and starts heartbeats
5. Shows live queue data from the agency

### Testing Device Manager

1. Log in as an agency owner (`owner1` / `owner123`)
2. Navigate to **Devices** (شاشة العرض / Écrans)
3. You should see your registered kiosk/TV devices with:
   - Online/offline status (green dot = online, red = offline)
   - Last heartbeat time
   - Device type (KIOSK/TV)
   - Actions: view, reboot, refresh, delete

### Testing Cast to Screen

In the Device Manager, test these options:

| Button | Action | How to Verify |
|--------|--------|---------------|
| **Cast to Screen** dropdown | Opens menu with 5 cast methods | Menu appears with icons |
| **TV Link** (purple button) | Opens QR + URL dialog | Dialog with URL, copy button, QR code |
| **New Tab** | Opens TV display in new tab | New browser tab with fullscreen |
| **Chromecast** | Requires Chrome + Chromecast device | Dialog appears (may fail without hardware) |
| **HDMI** | Calls Electron API or copies URL | URL copied (toast notification in web) |

### Testing LAN Discovery

1. Open browser DevTools Console
2. Open the kiosk or TV URL
3. Look for: `[TV Board] Auto-connected to LAN server: hostname (ip)`
4. If no LAN server found, it falls back to relative URLs (cloud)

### Testing Heartbeat

1. Open two tabs:
   - Tab 1: Agency Device Manager (logged in)
   - Tab 2: TV or Kiosk device page
2. In Tab 2, open DevTools Network tab
3. Watch for `POST /api/agency-devices/device/heartbeat` every 30 seconds
4. In Tab 1, verify the device shows as ONLINE
5. Close Tab 2 — after 90 seconds, the device should show OFFLINE in Tab 1

### Testing Device Commands

1. In Device Manager, click the **reboot** or **refresh** button on a device
2. This queues a command on the server
3. On the next heartbeat, the device receives the command
4. The device executes it (page reload) and acknowledges via `POST /device/command/:id/ack`
5. The command disappears from the pending list

### Quick Device Test URLs

```bash
# Kiosk (self-service ticket machine)
http://localhost:3000/?mode=device&type=KIOSK

# TV Display Board
http://localhost:3000/?mode=device&type=TV

# TV with specific agency
http://localhost:3000/?mode=device&type=TV&agencyId=<agency-id>
```

> **Note:** Without `agencyId`, the device will try to discover its agency from localStorage or prompt for one.

---

## 14. Project Structure

```
blasti-multiplatform/
├── apps/
│   ├── web/                          # Next.js 16 Frontend
│   │   ├── src/
│   │   │   ├── app/                  # App Router pages
│   │   │   │   ├── page.tsx          # Landing page
│   │   │   │   ├── layout.tsx        # Root layout
│   │   │   │   ├── auth/             # Login & Register
│   │   │   │   ├── admin/            # Admin dashboard pages
│   │   │   │   ├── agency/           # Agency dashboard pages
│   │   │   │   └── customer/         # Customer portal pages
│   │   │   ├── components/
│   │   │   │   ├── ui/               # shadcn/ui components (50+)
│   │   │   │   ├── admin/            # Admin dashboard components
│   │   │   │   ├── agency/           # Agency dashboard components
│   │   │   │   ├── customer/         # Customer portal components
│   │   │   │   ├── kiosk/            # Kiosk mode components
│   │   │   │   ├── devices/           # Device mode components
│   │   │   │   │   ├── device-kiosk.tsx    # Kiosk self-service mode
│   │   │   │   │   └── device-tv-board.tsx # TV display board
│   │   │   │   ├── shared/           # Shared components
│   │   │   │   ├── platform/         # Platform frame, sidebar, nav
│   │   │   │   ├── providers/        # Auth provider
│   │   │   │   └── auth/             # Landing page sections
│   │   │   ├── hooks/                # React hooks
│   │   │   │   └── use-lan-discovery.ts # LAN discovery hook
│   │   │   ├── lib/                  # Utilities & API client
│   │   │   │   └── lan-discovery.ts   # LAN network scanning
│   │   │   ├── store/                # Zustand state management
│   │   │   └── i18n/                 # Translations (ar, en, fr)
│   │   ├── public/                   # Static assets, uploads
│   │   ├── next.config.ts            # output: "export"
│   │   └── package.json              # @blasti/web
│   │
│   ├── api/                          # Hono Backend + Socket.IO
│   │   ├── src/
│   │   │   ├── index.ts              # Server entry point (port 3003)
│   │   │   ├── routes/               # API route modules
│   │   │   │   ├── auth.ts           #   Login, register, session, logout
│   │   │   │   ├── agency.ts         #   Agency CRUD, stats
│   │   │   │   ├── admin.ts          #   Admin operations
│   │   │   │   ├── agencies.ts       #   Public agency listing
│   │   │   │   ├── reservations.ts   #   Reservation CRUD, ETA
│   │   │   │   ├── queue.ts          #   Queue operations (call, skip, pause)
│   │   │   │   ├── kiosk.ts          #   Kiosk mode endpoints
│   │   │   │   ├── notifications.ts  #   Notification management
│   │   │   │   ├── reviews.ts        #   Review CRUD
│   │   │   │   ├── services.ts       #   Service management
│   │   │   │   ├── stats.ts          #   Platform statistics
│   │   │   │   ├── sync.ts           #   Sync status
│   │   │   │   ├── qr.ts             #   QR code generation
│   │   │   │   └── ...               #   sms, upload, devices, etc.
│   │   │   └── lib/                  # Backend libraries
│   │   │       ├── auth.ts           #   JWT session handling
│   │   │       ├── password.ts       #   Scrypt password hashing
│   │   │       ├── eta-calculator.ts #   ETA calculation engine
│   │   │       ├── rate-limit.ts     #   Rate limiting middleware
│   │   │       ├── validations.ts    #   Zod schemas
│   │   │       ├── realtime-emit.ts  #   Socket.IO event helpers
│   │   │       └── ...               #   audit, upload, sms-service, etc.
│   │   └── package.json              # @blasti/api
│   │
│   ├── desktop/                      # Electron Shell
│   │   ├── main.js                   # Main process (window, tray, deep links, TV screen IPC)
│   │   ├── preload.js                # Context bridge (openTvScreen, closeTvScreen, getTvScreenStatus)
│   │   ├── electron-builder.yml      # Build config (.exe, .dmg, .AppImage)
│   │   └── package.json              # @blasti/desktop
│   │
│   └── mobile/                       # Capacitor Shell
│       ├── capacitor.config.ts       # Android/iOS config
│       ├── src/
│       │   ├── plugin.ts             # Native bridge (vibrate, notifications, share)
│       │   └── setup.ts              # Deep links, push notifications init
│       └── package.json              # @blasti/mobile
│
├── packages/
│   └── db/                           # Database Package (@blasti/db)
│       ├── index.ts                  # Prisma client export
│       ├── prisma/
│       │   ├── schema.prisma         # Database schema (18 models)
│       │   └── seed.ts               # Demo data seeder
│       └── data/
│           └── custom.db             # SQLite database file
│
├── ops/
│   └── Caddyfile                     # Reverse proxy config (port 81)
│
├── mini-services/
│   └── serve-all/                    # Combined static + API server
│
├── scripts/
│   ├── deploy-guide.sh              # Deployment documentation
│   └── migrate-blob-to-r2.ts        # Storage migration script
│
├── vercel.json                       # Vercel deployment config
├── package.json                      # Root workspace config
├── tsconfig.json                     # Shared TypeScript config
└── LOCAL_DEVELOPMENT.md              # ← This file
```

---

## 15. Environment Variables

### API Server (`apps/api`)

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | — | **Required.** SQLite path, e.g., `file:./data/custom.db` |
| `NEXTAUTH_SECRET` | — | **Required.** JWT signing key (any long string for dev) |
| `API_PORT` | `3003` | Port for the API server |
| `CORS_ORIGIN` | `*` | CORS allowed origins |

### Web Frontend (`apps/web`)

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | — | Used at build time for static export (same path as API) |
| `NEXTAUTH_URL` | `http://localhost:3000/` | Base URL for auth callbacks |
| `NEXTAUTH_SECRET` | — | Must match the API server's secret |
| `NEXT_PUBLIC_API_URL` | — | Override API base URL (for Electron/Capacitor) |

### Quick Setup (Development)

```bash
# The package.json scripts already include these for you:
export DATABASE_URL="file:/path/to/packages/db/data/custom.db"
export NEXTAUTH_SECRET="blast1-dev-s3cr3t-k3y-f0r-d3v3l0pm3nt-0nly"
export NEXTAUTH_URL="http://localhost:3000/"
```

---

## 16. Common Development Tasks

### Reset the Database

```bash
# Option 1: Full reset (deletes everything, re-seeds)
bun run db:reset

# Option 2: Push schema changes + re-seed
bun run db:push
bun run db:seed

# Option 3: Delete and recreate from scratch
# Mac/Linux:
rm packages/db/data/custom.db
# Windows (PowerShell):
Remove-Item packages\db\data\custom.db
bun run db:push
bun run db:seed
```

### Add a New Database Field

1. Edit `packages/db/prisma/schema.prisma` — add your field
2. Run `bun run db:push` to apply the schema change
3. Use the field in your API routes via `db.model.findMany({...})`
4. **Never** import `@blasti/db` or `@prisma/client` in the frontend

### Add a New API Route

1. Create a new file in `apps/api/src/routes/your-route.ts`:

```typescript
import { Hono } from 'hono'
import { db } from '@blasti/db'

const app = new Hono()

app.get('/', async (c) => {
  const data = await db.yourModel.findMany()
  return c.json({ success: true, data })
})

export const yourRoutes = app
```

2. Register it in `apps/api/src/index.ts`:

```typescript
import { yourRoutes } from './routes/your-route'
app.route('/api/your-route', yourRoutes)
```

3. Test: `curl http://localhost:3003/api/your-route`

### Add a New Frontend Page

1. Create `apps/web/src/app/your-path/page.tsx`
2. Use `apiClient` from `@/lib/api-client` for API calls
3. Use Zustand store from `@/store/use-app-store` for client state
4. Use `useRealtime` hook from `@/hooks/use-realtime` for Socket.IO events

### Build for Production (Static Export)

```bash
# Build the frontend as static HTML/JS/CSS
bun run build

# Output goes to: apps/web/out/
# Serve with any static file server
cd apps/web && npx serve out -p 3000
```

### Run Linter

```bash
bun run lint
```

---

## 17. Troubleshooting

### Port Already in Use

**On Mac/Linux:**

```bash
# Find what's using port 3000
lsof -ti:3000 | xargs kill -9

# Find what's using port 3003
lsof -ti:3003 | xargs kill -9
```

**On Windows:**

```powershell
# Find what's using port 3000
netstat -ano | findstr :3000
# Kill the process (replace <PID> with the number from above)
taskkill /PID <PID> /F

# Same for port 3003
netstat -ano | findstr :3003
taskkill /PID <PID> /F
```

### Database Not Found

```bash
# Make sure the database file exists
ls -la packages/db/data/custom.db
```

**On Windows:**
```powershell
dir packages\db\data\custom.db
```

```bash
# If missing, recreate it
bun run db:push
bun run db:seed
```

### API Returns Empty Data

- Check that `DATABASE_URL` points to the correct `.db` file
- Verify the database has been seeded: `bun run db:seed`
- Check API server logs for Prisma errors

### Login Not Working

- Clear browser cookies for `localhost`
- Verify the API server is running (`curl http://localhost:3003/health`)
- Check that `NEXTAUTH_SECRET` matches between web and API
- Re-seed the database if users were deleted

### Real-Time (Socket.IO) Not Working

- Ensure the API server is running on port 3003
- Check browser console for WebSocket connection errors
- Verify the Caddyfile routes `/socket.io/*` to port 3003
- Try connecting manually in browser console: `const s = io(); s.on('connect', () => console.log('OK'));`

### Frontend Shows Blank Page

- Check the dev server console output for errors
- Clear `.next` cache:
  - **Mac/Linux:** `rm -rf apps/web/.next`
  - **Windows:** `Remove-Item -Recurse -Force apps\web\.next`
- Restart the dev server
- Check browser DevTools console for hydration errors

### "Module not found" Errors

```bash
# Reinstall all dependencies
rm -rf node_modules apps/*/node_modules packages/*/node_modules
bun install
```

**On Windows:**
```powershell
# Reinstall all dependencies
Remove-Item -Recurse -Force node_modules, apps\web\node_modules, apps\api\node_modules, packages\db\node_modules -ErrorAction SilentlyContinue
bun install
```

### Prisma Client Errors

```bash
# Regenerate Prisma client
bun run db:generate

# If that doesn't work, reinstall
cd packages/db && bun install && cd ../..
bun run db:generate
```

### Static Export Build Fails

- Make sure no server-side code leaks into client components
- Check that `output: "export"` is set in `apps/web/next.config.ts`
- Look for `getServerSideProps` or API routes in the web app (they should not exist)
- Run `bun run lint` to check for code issues

### Electron Won't Start

- Make sure the Next.js dev server is running on port 3000 (for dev mode)
- Check that `electron` is installed: `cd apps/desktop && bun install`
- Try running with explicit dev flag: `ELECTRON_DEV=1 bun run electron:dev`
- If the window is blank, check DevTools (Ctrl+Shift+I) for errors
- For production build: ensure `apps/desktop/out/` contains the web build

### Electron Build Fails (electron-builder)

- **Windows**: Install `wine` if cross-compiling from Linux/Mac
- **macOS**: Can only build `.dmg` on macOS (requires Xcode tools)
- **Icons missing**: Place `icon.ico` (Windows), `icon.icns` (macOS), `icon.png` (Linux) in `apps/desktop/assets/`
- **ASAR errors**: Try `bun run electron:build` instead of `npm run build`
- **Prebuild script fails**: Run `bun run build` in root first, then `cd apps/desktop && npm run build`

### Capacitor Sync Fails

- Run `bun install` first (all workspace deps must be installed)
- Ensure `apps/web/out/` exists (run `bun run build` first)
- Check that `@capacitor/cli` is installed: `cd apps/mobile && bun install`
- Clear cache:
  - **Mac/Linux:** `rm -rf apps/mobile/android && bun run cap:sync:android`
  - **Windows:** `Remove-Item -Recurse -Force apps\mobile\android; bun run cap:sync:android`

### Android Build Fails

- Make sure Android Studio is installed with SDK API 33+
- Set `JAVA_HOME` to JDK 17+: `export JAVA_HOME=/path/to/jdk-17`
- Run `cd apps/mobile/android && ./gradlew clean` then rebuild
- If Gradle sync fails: File → Sync Project with Gradle Files in Android Studio
- Check `local.properties` has correct `sdk.dir` path

### Mobile App Shows White Screen

- Verify the web build exists: `ls apps/web/out/index.html`
  - **On Windows:** `dir apps\web\out\index.html`
- Re-sync: `bun run build && bun run cap:sync:android`
- Check `capacitor.config.ts` → `webDir` points to `../../apps/web/out`
- For live reload: ensure `CAPACITOR_SERVER_URL` uses your machine's IP (not localhost)
- Check Chrome DevTools (chrome://inspect) for console errors

### Push Notifications Not Working (Mobile)

- Test on a **real device** (emulators have limited push support)
- Ensure Google Play Services is installed on the Android device
- Check notification permissions: Settings → Apps → BLASTI → Notifications
- Verify Firebase is configured (for FCM push) — or test with LocalNotifications
- Use `window.__BLASTI_NATIVE__.requestNotificationPermission()` to request

### Windows-Specific Issues

**Shell scripts (`*.sh`) don't work on Windows:**
- The `scripts/` folder contains Linux/macOS shell scripts that won't run natively on Windows.
- Use `bun run dev` (concurrently) or `bun run dev:api` + `bun run dev:web` instead.
- Alternatively, use **WSL (Windows Subsystem for Linux)** if you need to run `.sh` scripts.

**DATABASE_URL path issues on Windows:**
- Always use **forward slashes** in `DATABASE_URL`, even on Windows: `file:./packages/db/data/custom.db`
- Do **not** use backslashes: `file:.\packages\db\data\custom.db` ❌
- Prisma requires forward slashes regardless of your operating system.

**`export` command not recognized:**
- On Windows, use `set` instead of `export` in Command Prompt:
  ```cmd
  set DATABASE_URL="file:./packages/db/data/custom.db"
  ```
- Or use `$env:` in PowerShell:
  ```powershell
  $env:DATABASE_URL="file:./packages/db/data/custom.db"
  ```

---

## Quick Reference Card

```bash
# ─── Setup (first time) ───────────────────────────────
bun install                     # Install dependencies
bun run db:push                 # Create database tables
bun run db:seed                 # Add demo data

# ─── Running Web (two terminals) ──────────────────────
bun run dev:api                 # Terminal 1: API server (port 3003)
bun run dev:web                 # Terminal 2: Web frontend (port 3000)
# OR (single command — uses concurrently)
bun run dev                     # Start both at once with color-coded output

# ─── Running Desktop (Electron) ───────────────────────
bun run dev:api                 # Terminal 1: API server
bun run dev:web                 # Terminal 2: Web server
bun run electron:dev            # Terminal 3: Electron app

# ─── Running Mobile (Capacitor) ───────────────────────
bun run dev:api                 # Terminal 1: API server
bun run dev:web                 # Terminal 2: Web server
CAPACITOR_SERVER_URL="http://YOUR_IP:3000" bun run cap:sync:android
bun run cap:run:android         # Terminal 3: Run on device

# ─── Building Desktop ─────────────────────────────────
bun run build                   # Build Next.js static export
bun run electron:build:win      # Windows .exe
bun run electron:build:mac      # macOS .dmg
bun run electron:build:linux    # Linux .AppImage

# ─── Building Mobile ──────────────────────────────────
bun run build                   # Build Next.js static export
bun run cap:sync:android        # Sync to Android project
bun run cap:open:android        # Open in Android Studio
# Then: Build > Build APK(s)

# ─── Test Accounts ────────────────────────────────────
# Admin:    admin / admin123         → /admin
# Agency:   admin / admin123         → /agency
# Customer: customer1 / customer123  → /customer

# ─── Useful Commands ──────────────────────────────────
bun run lint                    # Check code quality
bun run build                   # Build static export
bun run db:reset                # Reset database
bun run db:seed                 # Re-seed demo data

# ─── API Quick Tests ──────────────────────────────────
curl http://localhost:3003/health
curl http://localhost:3003/api/agencies
curl http://localhost:3003/api/stats
curl -X POST http://localhost:3003/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}'

# ─── Native Bridge Tests (DevTools Console) ───────────
# Desktop: window.electronAPI.sendNotification('Test', 'Hello')
# Mobile:  window.__BLASTI_NATIVE__.vibrate('success')
# All:     nativeBridge.setBadgeCount(3)
```
