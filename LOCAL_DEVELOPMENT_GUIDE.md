# 🚀 BLASTI — Local Development Deployment Guide

> **Who is this for?** Anyone — even if you have never written code before.
> Follow the steps top-to-bottom in the order shown. Every command tells you
> **where to type it** and **what to expect**.

---

## 📑 Table of Contents

1. [What you are building](#1-what-you-are-building)
2. [Prerequisites (install these once)](#2-prerequisites-install-these-once)
3. [Get the project onto your computer](#3-get-the-project-onto-your-computer)
4. [One-time setup (do this before anything else)](#4-one-time-setup-do-this-before-anything-else)
5. [Part A — Run the WEB app (browser)](#part-a--run-the-web-app-browser)
6. [Part B — Run the DESKTOP app (Electron)](#part-b--run-the-desktop-app-electron)
7. [Part C — Run the MOBILE app (Android)](#part-c--run-the-mobile-app-android)
8. [Quick command cheat-sheet](#quick-command-cheat-sheet)
9. [Stopping the apps](#stopping-the-apps)
10. [Troubleshooting common errors](#troubleshooting-common-errors)

---

## 1. What you are building

BLASTI is a **queue-management platform** that runs on three platforms from one
codebase:

| Platform | Technology | What it looks like | Folder |
|----------|------------|--------------------|--------|
| **Web app** | Next.js 16 | Opens in your browser at `http://localhost:3000` | `apps/web/` |
| **Desktop app** | Electron (wraps the web app) | A double-clickable `.exe` / `.dmg` / AppImage window | `apps/desktop/` |
| **Mobile app** | Capacitor 8 (wraps the web app) | An Android `.apk` installed on a phone or emulator | `apps/mobile/` |

Both the desktop and mobile apps are **shells** — they load the web app inside
a native window. So the **web app must always be running first** before you
launch desktop or mobile in development mode.

Behind the scenes there is also an **API server** (port `3003`) that handles
database, auth, real-time updates, and a **SQLite database file** that lives at
`packages/db/data/custom.db`.

---

## 2. Prerequisites (install these once)

These are the only tools you need installed on your computer. Do this once and
you're set forever.

### 2.1 For ALL platforms (web + desktop + mobile)

| Tool | Why | How to install | How to verify |
|------|-----|----------------|---------------|
| **Bun** | JavaScript runtime — runs every script in this project | <https://bun.sh> → download & run installer | Open a terminal, type `bun --version` → should print `1.x.x` |
| **Git** | To download/update the project code | <https://git-scm.com/downloads> | `git --version` |
| **Node.js 20+** | Required by some Electron/Capacitor tooling | <https://nodejs.org> (pick the LTS) | `node --version` |

### 2.2 For the DESKTOP app only

Nothing extra — Electron installs itself automatically the first time you run
`bun install` (see step 4.3).

### 2.3 For the MOBILE app only (Android)

| Tool | Why | Install |
|------|-----|---------|
| **Android Studio** | Provides the Android SDK + emulator | <https://developer.android.com/studio> |
| **JDK 17** | Compiles Android Java code | Bundled with Android Studio, or install separately |

> ⚠️ **Windows users:** After installing Android Studio, open it once and let it
> finish "Setup Wizard" so the SDK downloads. You do **not** need to create a
> virtual device unless you want to test without a real phone.

### 2.4 How to open a terminal

- **Windows:** Press `Win + R`, type `powershell`, press Enter.
  - Whenever you see a command starting with `$env:` — that's PowerShell syntax.
  - If you use CMD instead, use `set VAR="value"` instead of `$env:VAR = "value"`.
- **macOS:** Press `Cmd + Space`, type `Terminal`, press Enter.
- **Linux:** `Ctrl + Alt + T` (most distros).

> 📌 **Always run commands from the project root folder** unless a step says
> otherwise. The project root is the folder that contains `package.json` and
> the `apps/` folder.

---

## 3. Get the project onto your computer

If you're reading this file inside the project, you can skip this section.

```bash
git clone <the-repo-url> blasti
cd blasti
```

You are now in the **project root**. Every command in this guide assumes you
are standing here.

---

## 4. One-time setup (do this before anything else)

You do this **once** after cloning, and again only after a major update or if
someone adds a new dependency.

### 4.1 Create your environment file

The project ships a template called `.env.example`. Copy it to `.env`:

```bash
cp .env.example .env
```

Open `.env` in any text editor (Notepad, VS Code, anything). The default values
are **already correct for local development** — you do not need to change
anything unless you are going to deploy to production later.

> ✅ The defaults look like this (just for your information):
> ```
> DATABASE_URL="file:./packages/db/data/custom.db"
> NEXTAUTH_SECRET="blast1-dev-s3cr3t-k3y-f0r-d3v3l0pm3nt-0nly"
> NEXTAUTH_URL="http://localhost:3000/"
> CORS_ORIGIN="*"
> INTERNAL_SECRET="blast1-internal-secret-dev"
> ```

### 4.2 Make sure the database folder exists

```bash
mkdir -p packages/db/data
```

(If it already exists, this command does nothing — safe to run anytime.)

### 4.3 Install all dependencies

```bash
bun install
```

⏱️ This takes 1–3 minutes the first time. It downloads every library the web,
API, desktop, and mobile apps need. You will see lots of lines scroll by —
that's normal. Wait until you see the prompt again.

### 4.4 Create the database tables

```bash
bun run db:push
```

**What to expect:** Prisma reads `packages/db/prisma/schema.prisma`, creates
the SQLite database file at `packages/db/data/custom.db`, and builds every
table. You should see `🚀 Your database is now in sync with your Prisma schema.`

### 4.5 (Optional) Add demo data

```bash
bun run db:seed
```

This inserts sample agencies, users, and services so you can log in and click
around without setting everything up by hand. Safe to skip.

---

✅ **One-time setup complete.** Now jump to the part you want to run:
- [Part A — Web app](#part-a--run-the-web-app-browser) ← start here if unsure
- [Part B — Desktop app](#part-b--run-the-desktop-app-electron)
- [Part C — Mobile app](#part-c--run-the-mobile-app-android)

---

## Part A — Run the WEB app (browser)

This is the simplest path and the one you should always start with.

### A.1 Start the API + Web servers together

From the **project root**, type:

```bash
bun run dev
```

**What this does:** Runs two things at once using `concurrently`:
1. **API server** on port `3003` (handles database, auth, real-time)
2. **Web app** on port `3000` (the Next.js UI you see in the browser)

**What to expect:** You'll see colored log lines tagged `[api]` (blue) and
`[web]` (green). Wait until you see something like:

```
[web] ▲ Next.js 16.x.x
[web] - Local: http://localhost:3000
[web] ✓ Ready in 1200ms
```

### A.2 Open the app in your browser

Open any browser (Chrome recommended) and go to:

> <http://localhost:3000>

You should see the BLASTI landing page. 🎉

> 💡 **Tip:** On your phone you can also open the web app over Wi-Fi. Find your
> computer's LAN IP (run `ipconfig` on Windows or `ifconfig` on macOS/Linux),
> then on the phone open `http://YOUR-COMPUTER-IP:3000`.

### A.3 Stopping the web app

In the terminal where `bun run dev` is running, press `Ctrl + C`.
You'll see the prompt return. Both servers stop together.

---

## Part B — Run the DESKTOP app (Electron)

The desktop app is a native window that loads the web app. So the web app
**must be running first** (Part A).

### B.1 Make sure the web app is running

If you haven't already, open a **separate terminal** and run:

```bash
bun run dev
```

Leave that terminal running. The desktop app will connect to
`http://localhost:3000`.

### B.2 Open a SECOND terminal (keep the first one running)

Open a new terminal window/tab, navigate to the project root:

```bash
cd /path/to/blasti
```

### B.3 Launch the desktop app in dev mode

From the project root:

```bash
bun run electron:dev
```

**What to expect:** After a few seconds a BLASTI desktop window opens showing
the same UI as the browser, but as a standalone app with its own title bar,
tray icon, and native notifications.

> 🔧 **Under the hood:** This runs `npx electron . --dev` inside `apps/desktop/`.
> The `--dev` flag tells Electron to load `http://localhost:3000` instead of
> looking for bundled files. If you close the web server, the desktop window
> will show an offline page.

### B.4 Stopping the desktop app

Just close the desktop window like any normal app, OR press `Ctrl + C` in the
terminal where `bun run electron:dev` was running.

### B.5 (Optional) Build a real installer

When you want a `.exe` (Windows), `.dmg` (mac), or AppImage (Linux) you can
ship to users:

```bash
bun run build:export      # builds the web app as static files
bun run electron:build:win   # or :mac or :linux
```

The installer appears in `apps/desktop/dist/`.

> ⚠️ Building the desktop installer takes 3–10 minutes and downloads large
> Electron binaries the first time. You do **not** need this for development —
> `bun run electron:dev` is all you need day-to-day.

---

## Part C — Run the MOBILE app (Android)

There are **two ways** to run the mobile app during development. Pick one.

| Mode | What it does | When to use |
|------|--------------|-------------|
| **Live-reload mode** ✅ recommended | App loads from your computer's dev server over Wi-Fi. Edits to the web app appear instantly on the phone. | Day-to-day development |
| **Bundled mode** | App ships a static copy of the web app inside the APK. Works offline. | Final testing before release |

### C.1 Prerequisites check

Make sure these are done (Section 2.3):
- Android Studio installed and opened once (so the SDK is downloaded)
- A real Android phone with **USB debugging** enabled
  - Settings → About phone → tap "Build number" 7 times → Developer options → enable USB debugging
  - Plug the phone in via USB, accept the "Allow USB debugging?" prompt
- **OR** an Android emulator created in Android Studio
  - Tools → Device Manager → Create Device → pick a Pixel → download a system image → Finish

### C.2 Mode 1 — Live-reload (recommended for development)

#### Step 1 — Find your computer's LAN IP

You need the IP address of the computer running the dev server, on your local
Wi-Fi. The phone and the computer **must be on the same Wi-Fi network**.

- **Windows PowerShell:**
  ```powershell
  ipconfig | Select-String "IPv4"
  ```
  Pick the one that looks like `192.168.x.x` (not `127.0.0.1`).

- **macOS / Linux:**
  ```bash
  ipconfig getifaddr en0    # macOS (Wi-Fi)
  hostname -I               # Linux
  ```

Write the IP down — example: `192.168.1.42`.

#### Step 2 — Start the web app bound to all interfaces

From the **project root** (in terminal #1):

```bash
bun run dev:web
```

(The `dev:web` script already passes `-H 0.0.0.0` so other devices on Wi-Fi
can reach it.)

Confirm it's reachable from your phone: open Chrome on the phone and visit
`http://192.168.1.42:3000` (replace with your actual IP). You should see the
BLASTI landing page.

#### Step 3 — Tell Capacitor where the dev server is

Open a **second terminal** (terminal #2) at the project root. Set the
`CAPACITOR_SERVER_URL` environment variable:

- **Windows PowerShell:**
  ```powershell
  $env:CAPACITOR_SERVER_URL = "http://192.168.1.42:3000"
  ```

- **macOS / Linux:**
  ```bash
  export CAPACITOR_SERVER_URL="http://192.168.1.42:3000"
  ```

> ⚠️ Replace `192.168.1.42` with the IP you found in Step 1.
> The phone and computer must be on the **same Wi-Fi**.

#### Step 4 — Sync the Capacitor project (one-time, or after plugin changes)

Still in terminal #2 (with the env var set):

```bash
bun run cap:sync
```

This copies the Capacitor config (including your `CAPACITOR_SERVER_URL`) into
the native Android project at `apps/mobile/android/`.

#### Step 5 — Open the project in Android Studio

```bash
bun run --filter @blasti/mobile cap:open:android
```

Android Studio opens with the BLASTI Android project loaded. The first time
this may take 1–2 minutes while Gradle syncs.

#### Step 6 — Run on a device or emulator

In Android Studio:
1. At the top, pick your device or emulator from the device dropdown.
2. Click the green **▶ Run** button (or press `Shift + F10`).

**What to expect:** The app builds (1–3 minutes the first time), installs on
the device, and opens showing the BLASTI UI — loaded live from your dev server.

> 🎉 Now any edit you make to the web app source instantly shows up on the phone.

### C.3 Mode 2 — Bundled static build (offline-capable APK)

Use this when you want to test the app exactly as users will receive it, with
no dependency on the dev server.

From the **project root**:

```bash
bun run build:mobile
```

**What this does (in order):**
1. Builds the web app as a static export into `apps/web/out/`
2. Runs `cap sync android` to copy those files + native plugins into
   `apps/mobile/android/`

Then open in Android Studio and press Run (same as Step 5 + Step 6 above):

```bash
bun run --filter @blasti/mobile cap:open:android
```

> 💡 To produce a debug or release APK file directly:
> ```bash
> bun run --filter @blasti/mobile build:android:debug    # → apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
> bun run --filter @blasti/mobile build:android:release  # signed release APK (needs keystore config)
> ```

### C.4 Stopping the mobile app

- On the phone/emulator: just close or uninstall the app.
- In Android Studio: press the red ■ Stop button.
- The web dev server (`bun run dev:web`) keeps running in its own terminal —
  stop it with `Ctrl + C` when done.

---

## Quick command cheat-sheet

All commands run from the **project root** unless noted.

### 🌐 Web app
| Goal | Command |
|------|---------|
| Start API + web together (dev) | `bun run dev` |
| Start only the web server | `bun run dev:web` |
| Start only the API server | `bun run dev:api` |
| Lint the web code | `bun run lint` |

### 🖥️ Desktop app
| Goal | Command |
|------|---------|
| Run Electron in dev mode (needs web running) | `bun run electron:dev` |
| Run API + web + desktop all at once | `bun run electron:dev:full` |
| Build a Windows installer | `bun run electron:build:win` |
| Build a macOS DMG | `bun run electron:build:mac` |
| Build a Linux AppImage+deb | `bun run electron:build:linux` |

### 📱 Mobile app (Android)
| Goal | Command |
|------|---------|
| Sync web + plugins → Android project | `bun run cap:sync` |
| Open project in Android Studio | `bun run --filter @blasti/mobile cap:open:android` |
| Run on connected device (from CLI) | `bun run --filter @blasti/mobile cap:run:android` |
| Build static export + sync | `bun run build:mobile` |
| Build a debug APK | `bun run --filter @blasti/mobile build:android:debug` |
| Build a release APK | `bun run --filter @blasti/mobile build:android:release` |

### 🗄️ Database
| Goal | Command |
|------|---------|
| Push schema → database | `bun run db:push` |
| Generate Prisma client | `bun run db:generate` |
| Run migrations | `bun run db:migrate` |
| Reset database (⚠️ deletes data) | `bun run db:reset` |
| Seed demo data | `bun run db:seed` |

### 🏗️ Build everything
| Goal | Command |
|------|---------|
| Build web app (server mode) | `bun run build` |
| Build web app (static export) | `bun run build:export` |
| Build API server | `bun run build:api` |
| Build everything | `bun run build:all` |

---

## Stopping the apps

| App | How to stop |
|-----|-------------|
| Web (Next.js) | In its terminal: `Ctrl + C` |
| API server | Stops together with `bun run dev`, or `Ctrl + C` in its terminal |
| Desktop (Electron) | Close the window, or `Ctrl + C` in the Electron terminal |
| Mobile (Android) | Close the app on the phone, or press ■ Stop in Android Studio |

To **kill everything** on Windows PowerShell:
```powershell
Get-Process -Name "node","bun","electron" -ErrorAction SilentlyContinue | Stop-Process -Force
```

On macOS/Linux:
```bash
pkill -f "next dev" ; pkill -f "electron" ; pkill -f "bun src/index.ts"
```

---

## Troubleshooting common errors

### ❌ `bun: command not found`
Bun is not installed or not on your PATH. Install from <https://bun.sh> and
restart your terminal.

### ❌ `EADDRINUSE: address already in use :::3000` (or 3003)
Another process is using that port. Either stop it, or kill it:
- **Windows:** `netstat -ano | findstr :3000` → note the PID → `taskkill /PID <pid> /F`
- **macOS/Linux:** `lsof -i :3000` → note PID → `kill -9 <pid>`

### ❌ Web page is blank / shows "This site can't be reached"
- Confirm `bun run dev` is still running and shows `✓ Ready`.
- Make sure you're visiting `http://localhost:3000` (not https).
- Check the terminal for red error text.

### ❌ Desktop app shows an offline / blank page
The desktop app could not reach `http://localhost:3000`. Make sure the web dev
server is running first (`bun run dev` in another terminal).

### ❌ Mobile app shows a white screen after splash
- **Live-reload mode:** `CAPACITOR_SERVER_URL` was not set or the phone can't
  reach your computer. Check that:
  - Phone and computer are on the **same Wi-Fi**.
  - The IP you set matches `ipconfig` / `ifconfig` output.
  - Your computer's firewall allows incoming connections on port 3000.
- **Bundled mode:** You forgot to run `bun run build:mobile` before
  `cap:open:android`. Run it and try again.

### ❌ `'R' is not a valid file-based resource name character`
A file inside `apps/mobile/android/app/src/main/res/` has an uppercase letter
in its name. Android forbids this. Remove or rename the offending file
(it is usually a stray `README.md`).

### ❌ `cap sync` fails with ENOENT for `capacitor.plugins.json`
The web export directory `apps/web/out/` does not exist yet. Run
`bun run build:export` first, then `bun run cap:sync` again.

### ❌ Android Studio: "Gradle sync failed"
- Make sure you have an internet connection (Gradle downloads dependencies).
- Try `File → Sync Project with Gradle Files`.
- If it complains about the JDK, set `JAVA_HOME` to JDK 17.

### ❌ PowerShell error: `export` is not recognized
`export` is Linux/macOS syntax. On PowerShell use:
```powershell
$env:VAR_NAME = "value"
```

### ❌ `bun: command not found: next` (Windows)
Bun on Windows sometimes can't resolve `node_modules/.bin`. This project's
`package.json` already uses the explicit path
`node_modules/.bin/next` so this should not happen. If it does, run from
`apps/web` directly:
```powershell
cd apps\web
bun --bun run node_modules\.bin\next dev -p 3000 -H 0.0.0.0
```

### ❌ Emulator/device: `net::ERR_CLEARTEXT_NOT_PERMITTED`
The app loads a blank page with "Webpage not available" because Android 9+
blocks HTTP (non-HTTPS) traffic by default. The fix is already baked into the
project's `network_security_config.xml` (cleartext allowed for all hosts in
debug builds). If you still see this error:

1. **For the Android emulator:** use `10.0.2.2` instead of your LAN IP. This
   is the emulator's special alias for the host's `localhost` and is always
   allowlisted:
   ```powershell
   $env:CAPACITOR_SERVER_URL = "http://10.0.2.2:3000"
   ```
   ```bash
   export CAPACITOR_SERVER_URL="http://10.0.2.2:3000"
   ```

2. **For a real phone over Wi-Fi:** use your computer's LAN IP (any subnet now
   works — `192.168.x.x`, `10.x.x.x`, etc.):
   ```powershell
   $env:CAPACITOR_SERVER_URL = "http://192.168.100.5:3000"   # your IP
   ```

3. After changing the URL, re-sync and rebuild:
   ```bash
   bun run cap:sync
   ```
   Then in Android Studio: `Build → Clean Project` → `Run`.

> 💡 The web dev server must be started with `bun run dev:web` (not `bun run dev`)
> so it binds to `0.0.0.0` and is reachable from the emulator/phone.

### ❌ Android build: `package org.junit does not exist` / `cannot find symbol class Test`
A leftover auto-generated test file (`ExampleUnitTest.java`) was sitting in
`app/src/main/java/...` instead of `app/src/test/java/...`. JUnit is only
declared as `testImplementation` in `build.gradle`, so the `main` source set
can't see it. The file is just a `2 + 2 == 4` example test — safe to delete:
```bash
rm apps/mobile/android/app/src/main/java/com/blasti/mobile/ExampleUnitTest.java
```
Then in Android Studio: `Build → Clean Project`, then `Run` again.

### ❌ Database errors / "table does not exist"
You probably skipped step 4.4. Run:
```bash
bun run db:push
```
If the database file is corrupted, delete it and recreate:
```bash
rm packages/db/data/custom.db
bun run db:push
bun run db:seed
```

### ❌ Changes to the web app don't show up on the phone
- In live-reload mode, the page should refresh automatically. If not, pull
  down to refresh manually in the app.
- In bundled mode, you must re-run `bun run build:mobile` and reinstall the
  app — the static files don't auto-update.

### ❌ Real-time features (live queue updates) don't work
The API server uses Socket.IO on port 3003. If you started only the web
server with `bun run dev:web` (not the full `bun run dev`), the API and
real-time features won't be available. Always use `bun run dev` for full
functionality, or start the API separately with `bun run dev:api`.

**If the TV screen shows static data** (doesn't update when queue moves on):
Check that `INTERNAL_SECRET` is set in the API server's environment. Without
it, the `/emit` endpoint returns 403 and NO realtime events are broadcast.
Verify by checking the API log for `🔒 Emit endpoints secured with
x-internal-secret` (good) vs `⛔ INTERNAL_SECRET not set` (bad).

The `dev:api` script uses `bun --env-file=../../.env` to load the root `.env`
file. Make sure your root `.env` contains at minimum:
```
INTERNAL_SECRET="blast1-internal-secret-dev"
NEXTAUTH_SECRET="blast1-dev-s3cr3t-k3y-f0r-d3v3l0pm3nt-0nly"
CORS_ORIGIN="*"
ALLOWED_ORIGINS="*"
```

---

## ✅ Recommended daily workflow

1. Open terminal #1 in the project root.
2. Run `bun run dev` → leave it running. Open <http://localhost:3000>.
3. (Optional) Open terminal #2, run `bun run electron:dev` for the desktop app.
4. (Optional) Open terminal #3, set `CAPACITOR_SERVER_URL` and run
   `bun run --filter @blasti/mobile cap:open:android` for the mobile app.
5. Edit code — both desktop and mobile update live from the web dev server.
6. When done: `Ctrl + C` in each terminal, close Android Studio.

Happy developing! 🚀
