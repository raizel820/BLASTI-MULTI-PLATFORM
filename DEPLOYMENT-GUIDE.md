# 🚀 BLASTI (بلاصتي) — Step-by-Step Deployment Guide

> **A beginner-friendly guide to install, set up, and run the BLASTI queue management system.**
> No coding experience required — just follow each step in order.

---

## 📋 Table of Contents

1. [What Is BLASTI?](#1-what-is-blasti)
2. [What You Need Before Starting](#2-what-you-need-before-starting)
3. [Understanding the Project Folders](#3-understanding-the-project-folders)
4. [Step 1 — Download the Project](#step-1--download-the-project)
5. [Step 2 — Install Required Software](#step-2--install-required-software)
6. [Step 3 — Install Project Dependencies](#step-3--install-project-dependencies)
7. [Step 4 — Set Up Environment Variables (.env)](#step-4--set-up-environment-variables-env)
8. [Step 5 — Set Up the Database](#step-5--set-up-the-database)
9. [Step 6 — Start the Application](#step-6--start-the-application)
10. [Step 7 — Verify Everything Works](#step-7--verify-everything-works)
11. [Step 8 — Access From Other Devices on Your Network](#step-8--access-from-other-devices-on-your-network)
12. [Step 9 — Build the Desktop App (Windows/Mac/Linux)](#step-9--build-the-desktop-app-windowsmaclinux)
13. [Step 10 — Build the Mobile App (Android)](#step-10--build-the-mobile-app-android)
14. [Step 11 — Set Up a Kiosk Tablet](#step-11--set-up-a-kiosk-tablet)
15. [Step 12 — Set Up a TV Display](#step-12--set-up-a-tv-display)
16. [Deploying to Production (Going Live)](#deploying-to-production-going-live)
17. [Troubleshooting Common Problems](#troubleshooting-common-problems)
18. [Quick Reference Card](#quick-reference-card)
19. [Feature Guide — What You Can Do](#feature-guide--what-you-can-do)
    - [🔔 Smart Notification Routing System](#-smart-notification-routing-system)
    - [📺 Agency Device Management](#-agency-device-management)
    - [🏢 Enterprise & Government Contract Configurator](#-enterprise--government-contract-configurator)
    - [🚨 Aggressive Turn Alert](#-aggressive-turn-alert)
    - [⏱️ Wait Time Predictor](#️-wait-time-predictor)
    - [⚙️ Customer Notification Preferences UI](#️-customer-notification-preferences-ui)

---

## 1. What Is BLASTI?

BLASTI (بلاصتي) is a **smart queue management system** designed for Algerian institutions like clinics, labs, and government offices. It lets:

- **Customers** join a queue from their phone or a kiosk tablet
- **Staff** call the next person and manage the queue
- **Admins** oversee everything from a dashboard
- **TV screens** show who's being served in real-time

### What BLASTI Includes

| Part | What It Does | Where It Lives (Folder) |
|------|-------------|----------------------|
| **Web App** | The main website users see in their browser | `apps/web/` |
| **API Server** | The backend that handles data and logic | `apps/api/` |
| **Database** | Where all data is stored (SQLite file) | `packages/db/data/custom.db` |
| **Desktop App** | A Windows/Mac/Linux program (like a standalone app) | `apps/desktop/` |
| **Mobile App** | An Android phone app | `apps/mobile/` |

### How the Pieces Connect

```
                    ┌─────────────────────────────┐
                    │      YOUR COMPUTER/SERVER     │
                    │                               │
                    │  ┌─────────┐   ┌───────────┐ │
                    │  │ Web App │   │ API Server │ │
                    │  │ :3000   │──▶│ :3003      │ │
                    │  └─────────┘   └──────┬─────┘ │
                    │                       │        │
                    │              ┌────────▼───────┐│
                    │              │   Database     ││
                    │              │ custom.db      ││
                    │              └────────────────┘│
                    └──────────────┬─────────────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              │                    │                     │
         ┌────▼─────┐       ┌─────▼────┐        ┌──────▼─────┐
         │  Phone   │       │  Tablet  │        │  TV Screen │
         │(Customer)│       │ (Kiosk)  │        │  (Display) │
         └──────────┘       └──────────┘        └────────────┘
```

**Ports explained (think of them as channel numbers):**

| Port | What Uses It | Why |
|------|-------------|-----|
| 3000 | Web App | The website you open in a browser |
| 3003 | API Server | The backend that processes requests |

You only need ports 3000 and 3003 for basic setup. The other ports (3080, 3081) are only used by the desktop app for advanced LAN features.

---

## 2. What You Need Before Starting

### Required Software

You need to install these programs on your computer before you begin. Think of them as tools needed to build and run the app.

| Software | What It Does | How to Install | Check It's Installed |
|----------|-------------|----------------|---------------------|
| **Bun** | Runs the app and installs packages | Go to [bun.sh](https://bun.sh), download and install | Open terminal, type: `bun --version` |
| **Node.js** | Required by some parts of the app | Go to [nodejs.org](https://nodejs.org), download LTS version | Open terminal, type: `node --version` |
| **Git** | Downloads the project code | Go to [git-scm.com](https://git-scm.com), download and install | Open terminal, type: `git --version` |

> **💡 Tip:** "Terminal" means:
> - **Windows**: Open "Command Prompt" or "PowerShell" or "Windows Terminal"
> - **Mac**: Open "Terminal" app (in Applications → Utilities)
> - **Linux**: Open your terminal app (Ctrl+Alt+T)

### For Mobile App Only (Optional)

If you want to build the Android app, you also need:

| Software | How to Install |
|----------|---------------|
| **Java JDK 17+** | Download from [adoptium.net](https://adoptium.net) |
| **Android Studio** | Download from [developer.android.com/studio](https://developer.android.com/studio) |

> **Skip this if you only want the web app running.** You can always come back to build the mobile app later.

### For Desktop App Only (Optional)

If you want to build the Windows/Mac/Linux desktop app:

| Software | How to Install |
|----------|---------------|
| **Electron** | Installed automatically when you run the project (no separate install needed) |

> **Skip this if you only want the web app.** The desktop app is optional.

---

## 3. Understanding the Project Folders

After you download the project, it will look like this. Here's what each folder is for:

```
blasti/                           ← The main project folder
│
├── .env                          ← ⚙️ ENVIRONMENT SETTINGS FILE (you'll edit this)
├── package.json                  ← Project configuration (like a recipe card)
├── Caddyfile                     ← Advanced: reverse proxy settings (skip for now)
│
├── apps/                         ← All the applications live here
│   ├── web/                      ← 🌐 The web application (what users see in browser)
│   │   ├── package.json          ← Web app settings
│   │   ├── src/                  ← Web app source code
│   │   └── public/               ← Images and static files
│   │
│   ├── api/                      ← 🔧 The backend API server
│   │   ├── package.json          ← API settings
│   │   └── src/                  ← API source code
│   │       └── index.ts          ← API entry point (where the server starts)
│   │
│   ├── desktop/                  ← 🖥️ Desktop app (Windows/Mac/Linux)
│   │   ├── package.json          ← Desktop app settings
│   │   └── main.js               ← Desktop app entry point
│   │
│   └── mobile/                   ← 📱 Mobile app (Android)
│       ├── package.json          ← Mobile app settings
│       ├── capacitor.config.ts   ← Mobile app configuration
│       └── android/              ← Android project files
│
├── packages/                     ← Shared code between apps
│   └── db/                       ← 💾 Database package
│       ├── package.json          ← Database package settings
│       ├── prisma/
│       │   ├── schema.prisma     ← Database structure definition
│       │   └── seed.ts           ← Test data generator
│       └── data/
│           └── custom.db         ← The actual database file (created during setup)
│
├── ops/                          ← Production deployment config
│   └── Caddyfile                 ← Production reverse proxy settings
│
└── scripts/                      ← Helper scripts
    └── deploy-guide.sh           ← Deployment helper script (Linux/macOS only)
```

### Key Files You'll Work With

| File | Where It Is | What You'll Do With It |
|------|------------|----------------------|
| `.env` | Project root folder (`blasti/.env`) | Edit to set your environment variables |
| `custom.db` | `packages/db/data/custom.db` | The database — created automatically during setup |

---

## Step 1 — Download the Project

### Option A: Download from GitHub (Recommended)

1. Open your terminal
2. Type this command and press Enter:

```bash
git clone https://github.com/raizel820/BLASTI-MULTI-PLATFORM.git blasti
```

3. Go into the project folder:

```bash
cd blasti
```

### Option B: Download the ZIP File

1. Go to [github.com/raizel820/BLASTI-MULTI-PLATFORM](https://github.com/raizel820/BLASTI-MULTI-PLATFORM)
2. Click the green **"Code"** button
3. Click **"Download ZIP"**
4. Extract the ZIP file to a folder on your computer
5. Open your terminal and navigate to that folder:

```bash
# Replace the path below with where you extracted the ZIP
cd /path/to/BLASTI-MULTI-PLATFORM
```

> **💡 Tip for Windows users:** In File Explorer, right-click the folder while holding Shift, then click "Open PowerShell window here" or "Open in Terminal".

### Verify the Download

Run this command to see the project structure:

**On Mac/Linux:**
```bash
ls -la
```

**On Windows:**
```powershell
dir
```

You should see folders like `apps/`, `packages/`, and files like `package.json` and `.env`.

---

## Step 2 — Install Required Software

If you haven't already installed Bun, Node.js, and Git from Section 2, do that now.

**Check that everything is installed correctly:**

```bash
bun --version
# Should show a version number like 1.1.x or higher

node --version
# Should show a version number like 20.x.x or higher

git --version
# Should show a version number like 2.x.x
```

If any of these say "command not found", go back to Section 2 and install the missing software.

---

## Step 3 — Install Project Dependencies

"Dependencies" are extra packages that the project needs to run. Think of them as ingredients in a recipe.

**In your terminal, from the project root folder (`blasti/`), run:**

```bash
bun install
```

> **⚠️ Important:** This command MUST be run from the project root folder (where `package.json` is). If you're in a subfolder, it won't work.

> **⏳ This may take a few minutes** — it's downloading all the necessary packages. You'll see a lot of text scrolling by. That's normal.

**Verify the installation:**

**On Mac/Linux:**
```bash
ls node_modules
```

**On Windows:**
```powershell
dir node_modules
```

You should see a long list of folders. If you see them, the installation worked.

---

## Step 4 — Set Up Environment Variables (.env)

Environment variables are settings that tell the app how to run. They're stored in a file called `.env`.

### Where Is the .env File?

The `.env` file is located in the **project root folder**:

```
blasti/
├── .env          ← THIS FILE (blasti/.env)
├── apps/
├── packages/
└── ...
```

### What Goes In the .env File

Open the `.env` file in any text editor (Notepad, VS Code, nano, etc.) and make sure it contains:

```bash
# ──────────────────────────────────────────────────────
# BLASTI Environment Variables
# ──────────────────────────────────────────────────────

# DATABASE_URL: Where the database file is located
# This points to the SQLite database file inside the project
# The path must start with "file:" for Prisma to understand it
DATABASE_URL="file:./packages/db/data/custom.db"

# NEXTAUTH_SECRET: A secret key used to encrypt user sessions
# ⚠️ IMPORTANT: Change this for production! Use a long random string.
# For local development, the default is fine.
NEXTAUTH_SECRET="blast1-dev-s3cr3t-k3y-f0r-d3v3l0pm3nt-0nly"

# NEXTAUTH_URL: The URL where your web app runs
# For local development, use http://localhost:3000/
# For production, use your domain like https://blasti.yourdomain.com
NEXTAUTH_URL="http://localhost:3000/"

# CORS_ORIGIN: Which websites are allowed to talk to your API
# Use "*" for development (allows all websites)
# For production, set to your actual domain like "https://blasti.yourdomain.com"
CORS_ORIGIN="*"

# INTERNAL_SECRET: A secret key for internal API communication
# ⚠️ IMPORTANT: Change this for production!
INTERNAL_SECRET="blast1-internal-secret-dev"
```

### How to Edit the .env File

**On Mac/Linux:**

```bash
# Open with nano (simple terminal text editor)
nano .env

# Or open with VS Code
code .env
```

**On Windows:**

```bash
# Open with Notepad
notepad .env

# Or open with VS Code
code .env
```

### Creating the .env File If It Doesn't Exist

If there's no `.env` file in the project root, create one:

```bash
# From the project root folder (blasti/)

# Mac/Linux:
cat > .env << 'EOF'
DATABASE_URL="file:./packages/db/data/custom.db"
NEXTAUTH_SECRET="blast1-dev-s3cr3t-k3y-f0r-d3v3l0pm3nt-0nly"
NEXTAUTH_URL="http://localhost:3000/"
CORS_ORIGIN="*"
INTERNAL_SECRET="blast1-internal-secret-dev"
EOF

# Windows (PowerShell):
@"
DATABASE_URL="file:./packages/db/data/custom.db"
NEXTAUTH_SECRET="blast1-dev-s3cr3t-k3y-f0r-d3v3l0pm3nt-0nly"
NEXTAUTH_URL="http://localhost:3000/"
CORS_ORIGIN="*"
INTERNAL_SECRET="blast1-internal-secret-dev"
"@ | Out-File -Encoding utf8 .env
```

### Each Variable Explained

| Variable | What It Does | Default for Development | What to Change for Production |
|----------|-------------|------------------------|------------------------------|
| `DATABASE_URL` | Points to the database file | `file:./packages/db/data/custom.db` | Change path if needed, e.g., `file:/opt/blasti/packages/db/data/production.db` |
| `NEXTAUTH_SECRET` | Encrypts user login sessions | `blast1-dev-s3cr3t-k3y-f0r-d3v3l0pm3nt-0nly` | **Must change!** Use a long random string like `openssl rand -base64 32` |
| `NEXTAUTH_URL` | The URL of your web app | `http://localhost:3000/` | Change to your domain: `https://blasti.yourdomain.com` |
| `CORS_ORIGIN` | Allowed origins for API | `*` (allows all) | **Must change!** Set to your domain: `https://blasti.yourdomain.com` |
| `INTERNAL_SECRET` | Secret for internal API calls | `blast1-internal-secret-dev` | **Must change!** Use a long random string |

> **⚠️ For Production:** You MUST change `NEXTAUTH_SECRET`, `CORS_ORIGIN`, and `INTERNAL_SECRET` to strong, unique values. Never use the development defaults in production!

### Additional Variables (Optional — Only Needed for Certain Features)

| Variable | When You Need It | What to Set |
|----------|-----------------|-------------|
| `NEXT_PUBLIC_API_URL` | For desktop/mobile apps to find the server | Your server URL: `https://blasti.yourdomain.com` |
| `BLASTI_LAN_ORIGINS` | For desktop app LAN features | Comma-separated IPs: `http://192.168.1.50:3000,http://192.168.1.60:3000` |
| `CAPACITOR_SERVER_URL` | For mobile app development live-reload | Your dev server URL: `http://192.168.1.100:3000` |
| `API_PORT` | Custom API server port | Default: `3003` — only change if you need a different port |
| `ALLOWED_ORIGINS` | Socket.IO allowed origins | `http://localhost:3000` — for production: your domain |
| `NEXT_PUBLIC_APP_URL` | For QR codes and share links | `https://blasti.dz` or your domain |
| `SMS_API_URL` | External SMS gateway URL | Only if using an external SMS provider |
| `SMS_API_KEY` | External SMS gateway API key | Only if using an external SMS provider |

> **💡 Note:** These optional variables can also be set in the `.env` file or passed as environment variables when running commands.

---

### Per-App .env Files (Advanced — Optional)

Each app in the monorepo has its **own `.env.example` file** that documents the specific variables it needs:

```
blasti/
├── .env                     ← Main .env (shared by all apps) — YOU NEED THIS
├── .env.example             ← Template for the main .env
├── apps/
│   ├── api/
│   │   └── .env.example     ← API server variables (ports, CORS, SMS, etc.)
│   ├── web/
│   │   └── .env.example     ← Web app variables (NEXT_PUBLIC_*, rewrites, etc.)
│   ├── desktop/
│   │   └── .env.example     ← Desktop app variables (BLASTI_API_URL, LAN, etc.)
│   └── mobile/
│       └── .env.example     ← Mobile app variables (CAPACITOR_SERVER_URL, etc.)
```

#### Do I Need Per-App .env Files?

| Scenario | What You Need |
|----------|--------------|
| **Just running locally** | The root `.env` is enough — it has all the shared variables |
| **Running the API separately** | Root `.env` is still enough — the API reads from the root |
| **Building the desktop app** | You might want `apps/desktop/.env` for `BLASTI_API_URL` and `BLASTI_LAN_ORIGINS` |
| **Building the mobile app** | You might want `apps/mobile/.env` for `CAPACITOR_SERVER_URL` |
| **Deploying to production** | Set variables in your hosting platform's dashboard (Vercel, Railway, etc.) |

#### How Per-App .env Files Work

1. **Root `.env`** is read first — it provides the shared variables (DATABASE_URL, NEXTAUTH_SECRET, etc.)
2. **App-specific `.env`** is read by that app's framework:
   - **Next.js** (`apps/web/`): Automatically reads `.env`, `.env.local`, `.env.production`, etc. from its own directory AND from the parent directory
   - **Bun/Hono** (`apps/api/`): Reads from the root `.env` when commands are run from the project root
   - **Electron** (`apps/desktop/`): Reads `process.env` variables set by the shell or `.env` file
   - **Capacitor** (`apps/mobile/`): Reads variables during the build step through the web app

3. **Priority order** (highest wins):
   - Shell environment variables (e.g., `DATABASE_URL="..." bun run dev`)
   - App-specific `.env.local` or `.env.production`
   - App-specific `.env`
   - Root `.env`
   - Default values in the code

#### To Set Up Per-App .env Files

```bash
# For the API server:
cp apps/api/.env.example apps/api/.env
# Then edit apps/api/.env with your API-specific values

# For the web app:
cp apps/web/.env.example apps/web/.env
# Then edit apps/web/.env with your web-specific values

# For the desktop app:
cp apps/desktop/.env.example apps/desktop/.env
# Then edit apps/desktop/.env with your desktop-specific values

# For the mobile app:
cp apps/mobile/.env.example apps/mobile/.env
# Then edit apps/mobile/.env with your mobile-specific values
```

> **💡 Tip:** For basic development, you only need the root `.env`. Per-app files are for when you need different settings for different apps (e.g., the desktop app connects to a different server than the web app).

### Which App Uses Which Variables

Here's a complete map of which environment variables each app actually reads:

| Variable | API Server | Web App | Desktop App | Mobile App |
|----------|:----------:|:-------:|:-----------:|:----------:|
| `DATABASE_URL` | ✅ | ✅ | — | — |
| `NEXTAUTH_SECRET` | ✅ | ✅ | ✅ | — |
| `NEXTAUTH_URL` | — | ✅ | — | — |
| `CORS_ORIGIN` | ✅ | — | — | — |
| `INTERNAL_SECRET` | ✅ | — | — | — |
| `API_PORT` | ✅ | ✅ | — | — |
| `ALLOWED_ORIGINS` | ✅ | — | — | — |
| `NEXT_PUBLIC_API_URL` | — | ✅ | — | ✅ |
| `NEXT_PUBLIC_APP_URL` | ✅ | ✅ | — | — |
| `NEXT_PUBLIC_REALTIME_URL` | — | ✅ | — | ✅ |
| `NEXT_PUBLIC_REALTIME_TOKEN` | — | ✅ | — | ✅ |
| `BLASTI_API_URL` | — | — | ✅ | — |
| `BLASTI_LAN_ORIGINS` | — | — | ✅ | — |
| `CAPACITOR_SERVER_URL` | — | — | — | ✅ |
| `SMS_API_URL` | ✅ | — | — | — |
| `SMS_API_KEY` | ✅ | — | — | — |
| `BLOB_READ_WRITE_TOKEN` | ✅ | — | — | — |
| `NEXT_PUBLIC_R2_PUBLIC_URL` | — | ✅ | — | — |
| `QR_HMAC_SECRET` | ✅ | — | — | — |
| `ENCRYPTION_KEY` | ✅ | — | — | — |
| `CRON_SECRET` | ✅ | — | — | — |

---

## Step 5 — Set Up the Database

The database is where all your data lives — user accounts, agencies, queue tickets, etc. BLASTI uses **SQLite**, which stores everything in a single file. No separate database server is needed!

### Where the Database File Lives

```
blasti/
└── packages/
    └── db/
        └── data/
            └── custom.db    ← The database file (will be created here)
```

### Step 5a: Generate the Database Client

This step creates the code that lets the app talk to the database.

**From the project root folder (`blasti/`), run:**

```bash
bun run db:generate
```

> **What this does:** Reads the database schema from `packages/db/prisma/schema.prisma` and generates TypeScript code.

### Step 5b: Create the Database Tables

This step creates the actual database file with all the tables.

**From the project root folder (`blasti/`), run:**

```bash
bun run db:push
```

> **What this does:** Creates `packages/db/data/custom.db` with all the tables defined in the schema. If the file already exists, it updates it.

### Step 5c: Add Test Data (Seed the Database)

This step fills the database with sample data so you can test the app.

**From the project root folder (`blasti/`), run:**

```bash
bun run db:seed
```

> **What this does:** Runs the script at `packages/db/prisma/seed.ts` which creates test users, agencies, and sample data.

### What the Seed Creates

| Data | Details |
|------|---------|
| **Test Users** | 4 users with different roles (see Test Accounts table below) |
| **Sample Agencies** | 3 agencies (a clinic, a lab, a government office) |
| **Sample Services** | Services like "General Consultation", "Blood Test", etc. |
| **Sample Data** | Reservations, reviews, notifications, FAQs |

### Verify the Database Was Created

**On Mac/Linux:**
```bash
ls -la packages/db/data/custom.db
```

**On Windows:**
```powershell
dir packages\db\data\custom.db
```

You should see a file with a size of around 350KB or more. If you see it, the database setup worked!

### Test Accounts

These accounts are created by the seed script. Use them to log in and test different roles:

| Username | Password | Role | What They Can Do |
|----------|----------|------|-----------------|
| `admin` | `admin123` | SUPER_ADMIN | Everything — manage all agencies, users, and settings |
| `owner1` | `owner123` | AGENCY_OWNER | Manage their agency, staff, and services |
| `staff1` | `staff123` | AGENCY_STAFF | Call next customer, manage the queue |
| `customer1` | `customer123` | CUSTOMER | Join queues, track their position, rate services |

### Agency Codes

These codes let customers find and join an agency's queue:

| Code | Agency Name |
|------|-------------|
| `CLINIC001` | Al Salam Clinic |
| `LAB001` | Lab Express M'Sila |
| `GOV001` | Wilaya Citizenship Office |

### Troubleshooting the Database

**If you get an error about `DATABASE_URL`:**

Make sure your `.env` file has the correct path. The path in `.env` should be:

```bash
DATABASE_URL="file:./packages/db/data/custom.db"
```

> **⚠️ Common mistake:** The path is **relative to the project root**, not relative to the `packages/db/` folder. Don't use `./data/custom.db` — use `./packages/db/data/custom.db`.

**If you want to reset the database completely:**

```bash
# Mac/Linux: Delete the existing database
rm packages/db/data/custom.db

# Windows (PowerShell):
Remove-Item packages\db\data\custom.db
```

Then recreate it:
```bash
bun run db:push
bun run db:seed
```

---

## Step 6 — Start the Application

BLASTI has **two servers** that need to run at the same time:
1. **API Server** (port 3003) — handles data and logic
2. **Web App** (port 3000) — the website users see

### The Easy Way — Start Both at Once

**From the project root folder (`blasti/`), run:**

```bash
bun run dev
```

> **What this does:** Starts both the API server AND the web app in a single terminal window using `concurrently` (color-coded output for each server).

> **⏳ Wait for both servers to be ready.** You'll see messages like:
> - `API server running on http://localhost:3003`
> - `Ready in 2s on http://localhost:3000`

> **💡 Windows Users:** This is the recommended way to start on Windows. `bun run dev` works on all platforms (Windows, Mac, Linux).

### The Manual Way — Start Each Server Separately

If you prefer to see each server's logs separately, use two terminal windows:

> **💡 Windows Users:** Open two tabs in **Windows Terminal** or two separate PowerShell windows.

**Terminal 1 — Start the API Server:**

```bash
# From the project root folder
cd apps/api
DATABASE_URL="file:../../packages/db/data/custom.db" NEXTAUTH_SECRET="blast1-dev-s3cr3t-k3y-f0r-d3v3l0pm3nt-0nly" CORS_ORIGIN="*" INTERNAL_SECRET="blast1-internal-secret-dev" bun run src/index.ts
```

> **What this does:** Starts the Hono API server on port 3003. The environment variables are passed inline so you don't need a separate `.env` file for the API.

**Terminal 2 — Start the Web App:**

```bash
# From the project root folder
cd apps/web
DATABASE_URL="file:../../packages/db/data/custom.db" NEXTAUTH_URL="http://localhost:3000/" NEXTAUTH_SECRET="blast1-dev-s3cr3t-k3y-f0r-d3v3l0pm3nt-0nly" bun run dev
```

> **What this does:** Starts the Next.js web app on port 3000.

### How to Stop the Servers

- **If started with `bun run dev`:** Press `Ctrl+C` in the terminal
- **If started separately:** Press `Ctrl+C` in each terminal window

---

## Step 7 — Verify Everything Works

### Test the Web App

1. Open your web browser
2. Go to: **http://localhost:3000**
3. You should see the BLASTI landing page (in Arabic)

### Test the API Server

Open a new terminal window and run:

```bash
curl http://localhost:3003/health
```

You should see something like:
```json
{"status":"ok","service":"@blasti/api","version":"0.1.0"}
```

### Test Logging In

1. In your browser at **http://localhost:3000**
2. Click the login button
3. Log in with test account: `admin` / `admin123`
4. You should see the admin dashboard

### Test the Real-Time Features

```bash
# Check that Socket.IO is running
curl "http://localhost:3003/socket.io/?EIO=4&transport=polling"
```

You should see a response starting with `0{"sid":...}`.

---

## Step 8 — Access From Other Devices on Your Network

If you want to use BLASTI from your phone, a tablet, or another computer on the same WiFi network:

### Step 8a: Find Your Computer's IP Address

**On Mac/Linux:**

```bash
# Option 1:
hostname -I
# Example output: 192.168.1.100

# Option 2:
ip addr show | grep "inet " | grep -v 127.0.0.1
```

**On Windows:**

```powershell
ipconfig
# Look for "IPv4 Address" under your WiFi or Ethernet adapter
# Example: 192.168.1.100
```

> **💡 Note:** `ifconfig` is deprecated on modern Linux. Use `ip addr show` or `hostname -I` instead. On Windows, always use `ipconfig`.

Write down this IP address — you'll need it!

### Step 8b: Open BLASTI From Another Device

On any device connected to the same WiFi network, open a browser and go to:

```
http://YOUR_IP_ADDRESS:3000
```

For example, if your computer's IP is `192.168.1.100`, go to:

```
http://192.168.1.100:3000
```

### Step 8c: Allow Firewall Access (If Needed)

If other devices can't connect, your computer's firewall might be blocking the connection.

**On Linux (Ubuntu):**

```bash
sudo ufw allow 3000/tcp
sudo ufw allow 3003/tcp
```

**On Windows:**
1. Open "Windows Defender Firewall"
2. Click "Allow an app or feature through Windows Defender Firewall"
3. Click "Change settings" → "Allow another app"
4. Add Node.js or Bun and check both "Private" and "Public"

**On Mac:**
1. Open "System Preferences" → "Security & Privacy" → "Firewall"
2. Click "Firewall Options"
3. Make sure Node or Bun is allowed

---

## Step 9 — Build the Desktop App (Windows/Mac/Linux)

The desktop app is an optional standalone program that wraps the web app. It adds features like:
- Native OS notifications
- Silent printing for tickets
- System tray with minimize-to-tray
- LAN server for offline operation

### Prerequisites

Make sure you've already completed Steps 1–7 and the web app is running.

### Step 9a: Install Electron

**From the `apps/desktop/` folder:**

```bash
cd apps/desktop
npm install electron --save-dev
cd ../..
```

### Step 9b: Run the Desktop App in Development Mode

Make sure the web app is running on port 3000 first, then:

```bash
cd apps/desktop
npx electron . --dev
```

This opens a desktop window loading `http://localhost:3000`.

### Step 9c: Build the Desktop App for Distribution

First, build the web app for production:

```bash
# From the project root folder
cd apps/web
bun run build
cd ../..
```

Then, build the desktop app:

```bash
cd apps/desktop

# For Windows:
npm run build:win
# Output: dist/BLASTI-Setup-0.2.0.exe

# For Mac:
npm run build:mac
# Output: dist/BLASTI-0.2.0.dmg

# For Linux:
npm run build:linux
# Output: dist/BLASTI-0.2.0.AppImage

# For all platforms:
npm run build:all
```

The built files will be in `apps/desktop/dist/`.

### Desktop App Environment Variables

| Variable | Where to Set | Default | Purpose |
|----------|-------------|---------|---------|
| `BLASTI_API_URL` | `.env` or system env | `https://blasti.vercel.app` | The URL the desktop app connects to |
| `NEXTAUTH_SECRET` | `.env` or system env | `blast1-dev-secret` | JWT signing for auth |
| `BLASTI_LAN_ORIGINS` | `.env` or system env | (localhost only) | Allowed CORS origins for LAN server |

---

## Step 10 — Build the Mobile App (Android)

The mobile app wraps the web app in a native Android shell using Capacitor.

### Prerequisites

- **Java JDK 17+** installed
- **Android Studio** installed
- **ANDROID_HOME** environment variable set

```bash
# Set ANDROID_HOME (add to your ~/.bashrc or ~/.zshrc)
export ANDROID_HOME=$HOME/Android/Sdk
export PATH=$PATH:$ANDROID_HOME/platform-tools
```

### Step 10a: Build the Web App for Mobile

The mobile app needs a static (pre-built) version of the web app.

**From the project root folder:**

```bash
cd apps/web
NEXT_BUILD_MODE=export bun run build
cd ../..
```

> **What this does:** Creates a static export of the web app in `apps/web/out/`. The `NEXT_BUILD_MODE=export` flag tells Next.js to produce static files instead of a server-rendered app.

### Step 10b: Sync Web Assets to Mobile

**From the project root folder:**

```bash
cd apps/mobile
bun run cap:sync:android
cd ../..
```

> **What this does:** Copies the web app files from `apps/web/out/` into the Android project at `apps/mobile/android/`, and syncs Capacitor plugins.

### Step 10c: Open in Android Studio

```bash
cd apps/mobile
npx cap open android
cd ../..
```

> **What this does:** Opens the Android project in Android Studio. From there you can run it on a connected phone or an emulator.

### Step 10d: Run on a Connected Phone

1. Connect your Android phone via USB
2. Enable **Developer Options** and **USB Debugging** on your phone
3. In Android Studio, click the **Run** button (green play icon)
4. Select your phone from the device list

### Step 10e: Build an APK (Android Package)

```bash
# From apps/mobile/
cd apps/mobile

# Debug APK (for testing):
cd android && ./gradlew assembleDebug
# Output: android/app/build/outputs/apk/debug/app-debug.apk

# Release APK (for distribution):
cd android && ./gradlew assembleRelease
# Output: android/app/build/outputs/apk/release/app-release.apk
```

### Step 10f: Live Development (Hot Reload on Phone)

For development, you can have the phone load from the dev server instead of static files:

**Terminal 1 — Start the web dev server:**

```bash
cd apps/web
bun run dev
```

**Terminal 2 — Point Capacitor to the dev server:**

```bash
cd apps/mobile
# Replace with YOUR computer's IP address
export CAPACITOR_SERVER_URL="http://192.168.1.100:3000"
bun run cap:sync:android
npx cap run android --livereload
```

> **⚠️ Note:** Your phone and computer must be on the same WiFi network for live reload to work.

### Mobile App Capacitor Config

The mobile app configuration is in `apps/mobile/capacitor.config.ts`:

| Setting | Value | What It Means |
|---------|-------|--------------|
| `appId` | `com.blasti.mobile` | The Android app identifier |
| `appName` | `BLASTI` | The name shown on the phone |
| `webDir` | `../../apps/web/out` | Where to find the built web files |
| `server.url` | (dev only) | When `CAPACITOR_SERVER_URL` is set, loads from this URL instead of static files |

---

## Step 11 — Set Up a Kiosk Tablet

A kiosk is a tablet at an agency entrance where customers can walk up, select a service, and get a ticket.

### How to Set Up

1. On the tablet, open the browser and go to `http://YOUR_SERVER_IP:3000`
2. The app will detect the tablet form factor and may show a kiosk-friendly interface
3. Log in with a staff account or use an agency code

### For a Dedicated Kiosk Tablet (Android)

1. Install a **kiosk browser app** from the Play Store (e.g., "Fully Kiosk Browser" or "Kiosk Browser")
2. Set the homepage to: `http://YOUR_SERVER_IP:3000`
3. Enable these settings in the kiosk app:
   - **Full-screen mode** (no address bar)
   - **Disable status bar and navigation buttons**
   - **Keep screen awake** (screen never turns off)
   - **Auto-start on boot**

### Kiosk Auto-Registration

When a device opens the kiosk URL (`/?mode=device&type=KIOSK&agencyId={id}`), it automatically:
1. Scans the local network to find the BLASTI server
2. Registers itself with the server (creates an `AgencyDevice` record)
3. Starts sending heartbeats every 30 seconds (appears ONLINE in device manager)
4. Processes any pending commands from the server (reboot, refresh, config update)

You can see all registered devices in **Agency Settings → Devices** with their online/offline status.

### Printing Tickets from the Kiosk

| Method | How It Works |
|--------|-------------|
| **Desktop Electron app** | Uses silent printing — tickets print automatically |
| **Web browser** | Uses `window.print()` — shows a print dialog |
| **Thermal printer** | Connect via USB to the desktop running Electron, set as default printer |

---

## Step 12 — Set Up a TV Display

The TV display shows real-time queue status for waiting customers — who's being served now, how many people are waiting, estimated wait times, and service breakdown.

### Option 1: Smart TV Browser (Easiest)

1. Log in to BLASTI on your computer
2. Go to **Agency Settings → Devices**
3. Click the **"TV Link"** button (purple, QR icon)
4. The dialog shows the TV URL — copy it
5. On the smart TV, open the browser and paste the URL
6. The page will **automatically go fullscreen** after 1.5 seconds
7. Press **F** on a keyboard (or tap the fullscreen button) to toggle

### Option 2: QR Code (Phone/Tablet as HDMI Source)

1. In the Device Manager, click **"TV Link"**
2. A dialog appears with a **QR code**
3. Scan the QR code with any phone or tablet on the same WiFi
4. The phone opens the TV display page
5. Connect the phone to the TV via HDMI cable or cast to it
6. The TV now shows the live queue board

### Option 3: Chromecast (No Smart TV Browser Needed)

1. Connect a Chromecast device to any TV (HDMI)
2. Make sure Chromecast and your computer are on the **same WiFi**
3. In the Device Manager, click **"Cast to Screen" → "Chromecast Cast"**
4. Select your Chromecast device from the browser dialog
5. The TV display streams directly to your TV — no URL typing needed
6. Works in Chrome and Edge browsers

### Option 4: HDMI via Desktop App (Recommended for Dedicated TV)

1. Install the BLASTI Desktop app (Electron) on a PC
2. Connect the PC to your TV via HDMI cable
3. In the Device Manager, click **"Cast to Screen" → "HDMI Screen"**
4. The desktop app automatically opens a **fullscreen kiosk window** on the external monitor
5. The window locks to fullscreen (no accidental exit)
6. To close: use Ctrl+Alt+Del or close the desktop app

> **Tip:** The desktop app auto-detects which monitor is external (second display) and puts the TV screen there. If you plug/unplug a monitor, it repositions automatically.

### Option 5: Raspberry Pi (Always-On, Low Cost)

```bash
# 1. Install Raspberry Pi OS Lite
# 2. Install Chromium:
sudo apt install chromium-browser

# 3. Create auto-start script:
cat > /home/pi/blasti-tv.sh << 'EOF'
#!/bin/bash
sleep 10  # Wait for network
# Get the TV URL — replace AGENCY_ID with your actual agency ID
TV_URL="http://YOUR_SERVER_IP:3000/?mode=device&type=TV&agencyId=YOUR_AGENCY_ID"
chromium-browser \
  --noerrdialogs \
  --disable-infobars \
  --kiosk \
  --incognito \
  --disable-translate \
  --no-first-run \
  "$TV_URL"
EOF
chmod +x /home/pi/blasti-tv.sh

# 4. Auto-start on boot:
mkdir -p /home/pi/.config/autostart
cat > /home/pi/.config/autostart/blasti.desktop << 'EOF'
[Desktop Entry]
Type=Application
Name=BLASTI TV
Exec=/home/pi/blasti-tv.sh
X-GNOME-Autostart-enabled=true
EOF
```

> **⚠️ Replace `YOUR_SERVER_IP`** with your server's IP (e.g., `192.168.1.100`) and `YOUR_AGENCY_ID` with your agency's ID.

### TV Display Features

| Feature | Description |
|---------|-------------|
| **Auto Fullscreen** | Automatically enters fullscreen 1.5s after page load |
| **Keyboard Shortcut** | Press **F** to toggle fullscreen on/off |
| **Fullscreen Button** | Tap the expand icon in the top-right corner |
| **Live Updates** | Queue data refreshes every 5 seconds via Socket.IO |
| **Multi-Language** | Supports Arabic (RTL), French, and English |
| **Configurable** | Agency owner can set font size, theme, rotation, language |
| **Offline Detection** | Shows "OFFLINE" indicator when connection is lost |
| **Clock Display** | Shows current time in the header |

### How to Find Your TV URL

1. Log in to BLASTI
2. Go to **Agency Settings → Devices** (شاشة العرض / Écrans)
3. Click the purple **"TV Link"** button (رابط التلفاز)
4. The dialog shows:
   - The full URL (e.g., `http://192.168.1.100:3000/?mode=device&type=TV&agencyId=abc123`)
   - A **Copy** button
   - A **QR code** for quick scanning

---

## Deploying to Production (Going Live)

When you're ready to make BLASTI available on the internet (not just your local network), follow one of these options:

### Option A: Self-Hosted Server (Recommended for Full Control)

**Requirements:**
- A server (VPS or physical) with Ubuntu 22.04+
- At least 4GB RAM and 50GB storage
- A domain name (e.g., `blasti.yourdomain.com`)

**Step A1: Install Bun on the Server**

```bash
curl -fsSL https://bun.sh/install | bash
```

**Step A2: Clone and Install the Project**

```bash
git clone https://github.com/raizel820/BLASTI-MULTI-PLATFORM.git /opt/blasti
cd /opt/blasti
bun install
```

**Step A3: Set Up Production Environment Variables**

Create the production `.env` file at `/opt/blasti/.env`:

```bash
cat > /opt/blasti/.env << 'EOF'
# ──────────────────────────────────────────────────────
# BLASTI PRODUCTION Environment Variables
# ──────────────────────────────────────────────────────

# Database path (use a dedicated production database file)
DATABASE_URL="file:/opt/blasti/packages/db/data/production.db"

# ⚠️ IMPORTANT: Generate strong secrets for production!
# Run this command to generate a random secret: openssl rand -base64 32
NEXTAUTH_SECRET="PASTE_YOUR_GENERATED_SECRET_HERE"

# Your domain name (with https://)
NEXTAUTH_URL="https://blasti.yourdomain.com"

# Your domain name (no wildcards in production!)
CORS_ORIGIN="https://blasti.yourdomain.com"

# Another secret for internal use (generate with: openssl rand -base64 32)
INTERNAL_SECRET="PASTE_ANOTHER_GENERATED_SECRET_HERE"

# URL for desktop/mobile apps to connect
NEXT_PUBLIC_API_URL="https://blasti.yourdomain.com"
EOF
```

> **⚠️ Security Warning:** You MUST change `NEXTAUTH_SECRET` and `INTERNAL_SECRET` to strong random strings. Use this command to generate them:
> ```bash
> openssl rand -base64 32
> ```

**Step A4: Set Up the Database**

```bash
cd /opt/blasti
bun run db:generate
bun run db:push
bun run db:seed
```

**Step A5: Build the Web App**

```bash
cd /opt/blasti/apps/web
bun run build
```

**Step A6: Install Caddy (Reverse Proxy with Auto-HTTPS)**

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy
```

**Step A7: Configure Caddy**

Edit the Caddy configuration file:

```bash
sudo nano /etc/caddy/Caddyfile
```

Replace the contents with:

```
blasti.yourdomain.com {
    reverse_proxy /socket.io/* localhost:3003
    reverse_proxy /api/* localhost:3003
    reverse_proxy /* localhost:3000
}
```

> **⚠️ Replace `blasti.yourdomain.com`** with your actual domain name. Make sure your domain's DNS is pointing to your server's IP address.

**Step A8: Create System Services (So the App Starts Automatically)**

Create the API service:

```bash
sudo cat > /etc/systemd/system/blasti-api.service << 'EOF'
[Unit]
Description=BLASTI API Server
After=network.target

[Service]
Type=simple
User=blasti
WorkingDirectory=/opt/blasti/apps/api
ExecStart=/root/.bun/bin/bun run src/index.ts
Restart=on-failure
RestartSec=5
EnvironmentFile=/opt/blasti/.env

[Install]
WantedBy=multi-user.target
EOF
```

Create the Web service:

```bash
sudo cat > /etc/systemd/system/blasti-web.service << 'EOF'
[Unit]
Description=BLASTI Web Server
After=network.target blasti-api.service

[Service]
Type=simple
User=blasti
WorkingDirectory=/opt/blasti/apps/web
ExecStart=/root/.bun/bin/bun run start
Restart=on-failure
RestartSec=5
EnvironmentFile=/opt/blasti/.env

[Install]
WantedBy=multi-user.target
EOF
```

**Step A9: Start Everything**

```bash
# Create a blasti user for security
sudo useradd -r -s /bin/false blasti
sudo chown -R blasti:blasti /opt/blasti

# Enable and start services
sudo systemctl enable blasti-api blasti-web caddy
sudo systemctl start blasti-api blasti-web caddy
```

**Step A10: Verify**

Open your browser and go to: `https://blasti.yourdomain.com`

### Option B: Docker Deployment

If you prefer Docker:

**Step B1: Create a Dockerfile**

Create a file named `Dockerfile` in the project root (`blasti/Dockerfile`):

```dockerfile
FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies
COPY package.json bun.lock ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY packages/db/package.json ./packages/db/
RUN bun install --frozen-lockfile

# Copy all source code
COPY . .

# Set up database
RUN bun run db:generate && bun run db:push

# Build the web app
RUN cd apps/web && bun run build

# Expose ports
EXPOSE 3000 3003

# Start both servers
CMD ["sh", "-c", "cd apps/api && bun run src/index.ts & cd apps/web && bun run start"]
```

> **⚠️ Note:** The Dockerfile uses `sh -c` with `&` which works inside Docker containers (Linux-based). This is not intended for direct use on Windows.

**Step B2: Build and Run**

```bash
# Build the Docker image
docker build -t blasti .

# Run the container
docker run -d \
  --name blasti \
  -p 3000:3000 \
  -p 3003:3003 \
  -e NEXTAUTH_SECRET="your-production-secret" \
  -e NEXTAUTH_URL="https://blasti.yourdomain.com" \
  -e CORS_ORIGIN="https://blasti.yourdomain.com" \
  -e INTERNAL_SECRET="your-internal-secret" \
  blasti
```

### Option C: Cloud Deployment (Vercel + Railway)

| Component | Platform | Cost |
|-----------|----------|------|
| **Web App** | [Vercel](https://vercel.com) | Free tier available |
| **API Server** | [Railway](https://railway.app) | ~$5/month |
| **Database** | Turso (SQLite cloud) | Free tier available |

**Vercel Deployment:**

1. Push your code to GitHub
2. Go to [vercel.com](https://vercel.com) and import your repository
3. Set the root directory to `apps/web`
4. Add environment variables in the Vercel dashboard:
   - `DATABASE_URL` — your Turso/SQLite connection string
   - `NEXTAUTH_SECRET` — a strong random string
   - `NEXTAUTH_URL` — your Vercel URL
5. Deploy

**Railway Deployment:**

1. Go to [railway.app](https://railway.app) and create a new project
2. Deploy from your GitHub repository
3. Set the root directory to `apps/api`
4. Add environment variables in the Railway dashboard
5. Deploy

### Production Security Checklist

Before going live, make sure you've done all of these:

- [ ] Changed `NEXTAUTH_SECRET` to a strong random string (at least 32 characters)
- [ ] Changed `INTERNAL_SECRET` to a strong random string
- [ ] Set `CORS_ORIGIN` to your actual domain (NOT `*`)
- [ ] Enabled HTTPS (via Caddy auto-SSL or your cloud provider)
- [ ] Configured firewall to only allow ports 80 and 443
- [ ] Set up database backups (e.g., `cp custom.db custom.db.backup`)
- [ ] Verified that rate limiting is working (built into the API)
- [ ] Reviewed Socket.IO CORS settings
- [ ] Set `BLASTI_LAN_ORIGINS` to specific IPs only (if using desktop app)
- [ ] Tested logging in with a non-admin account
- [ ] Changed the seed data passwords for production

---

## Troubleshooting Common Problems

### Problem 1: "EADDRINUSE" — Port Already in Use

**What it means:** Another program is already using the port BLASTI needs.

**How to fix:**

**On Mac/Linux:**

```bash
# Find what's using port 3000:
lsof -i :3000

# Kill the process (replace <PID> with the number from above):
kill -9 <PID>

# Same for port 3003:
lsof -i :3003
kill -9 <PID>
```

**On Windows:**

```powershell
netstat -ano | findstr :3000
taskkill /PID <PID> /F
```

### Problem 2: "bun: command not found"

**What it means:** Bun is not installed or not in your system PATH.

**How to fix:**
1. Install Bun: Go to [bun.sh](https://bun.sh) and follow the instructions
2. Restart your terminal
3. Verify: `bun --version`

### Problem 3: Devices Can't Connect on LAN

**What it means:** Other devices on your WiFi can't reach the BLASTI server.

**How to fix:**

1. Make sure you're using the correct IP address:
   - **Mac/Linux:** `hostname -I`
   - **Windows:** `ipconfig` (look for "IPv4 Address")

2. Check your firewall allows incoming connections:
   ```bash
   # Linux:
   sudo ufw allow 3000/tcp
   sudo ufw allow 3003/tcp
   
   # Or temporarily disable the firewall to test:
   sudo ufw disable
   ```

   **On Windows:** See [Step 8c — Allow Firewall Access](#step-8c-allow-firewall-access-if-needed) above.

3. Make sure all devices are on the **same WiFi network** (not guest network)

4. Some public WiFi networks block device-to-device communication ("AP isolation"). Use a private WiFi network instead.

### Problem 4: Socket.IO Not Connecting

**What it means:** The real-time features (live queue updates) aren't working.

**How to fix:**

```bash
# Check if Socket.IO is running:
curl "http://localhost:3003/socket.io/?EIO=4&transport=polling"
# Should return: 0{"sid":"...","upgrades":["websocket"],...}

# If using Caddy, make sure /socket.io/* routes to port 3003
# Check /etc/caddy/Caddyfile (production) or Caddyfile (development)
```

### Problem 5: Database Errors

**What it means:** Something went wrong with the database file.

**How to fix:**

```bash
# From the project root folder:

# Option 1: Reset the database completely
# Mac/Linux:
rm packages/db/data/custom.db
# Windows (PowerShell):
Remove-Item packages\db\data\custom.db

# Then recreate it:
bun run db:push
bun run db:seed

# Option 2: Just regenerate the client
bun run db:generate
```

### Problem 6: "Data Loading Failed" Error on Dashboard

**What it means:** The web app can't get data from the API server.

**How to fix:**

1. Make sure the API server is running on port 3003:
   ```bash
   curl http://localhost:3003/health
   ```

2. Make sure both servers are running (web on 3000, API on 3003)

3. Try logging out and logging back in — your session may have expired

4. Check that `NEXTAUTH_SECRET` is the same in both the web and API environment variables

### Problem 7: Kiosk Printing Not Working

**How to fix:**

- **Desktop Electron app:** Make sure a printer is set as the default printer on your computer
- **Web browser:** Press `Ctrl+P` (or `Cmd+P` on Mac) to test manual printing first
- **Thermal printer:** Install the printer driver, set it as default, then test silent print from the desktop app

### Problem 8: Mobile App Not Connecting

**How to fix:**

- Make sure `NEXT_PUBLIC_API_URL` points to your server's address
- For development, set `CAPACITOR_SERVER_URL` to `http://YOUR_LAN_IP:3000`
- Check that the Android network security config allows cleartext HTTP to your IP
- Make sure your phone and server are on the same WiFi network

### Problem 9: Changes Not Showing Up

**What it means:** You edited code but don't see the changes in the browser.

**How to fix:**

1. Hard refresh the browser: `Ctrl+Shift+R` (or `Cmd+Shift+R` on Mac)
2. Clear browser cache
3. Restart the dev server (stop with `Ctrl+C`, then run `bun run dev` again)

### Problem 10: Build Fails with "Cannot find module"

**How to fix:**

```bash
# Clean install dependencies:
# Mac/Linux:
rm -rf node_modules
# Windows (PowerShell):
Remove-Item -Recurse -Force node_modules -ErrorAction SilentlyContinue

bun install

# Regenerate Prisma client:
bun run db:generate
```

### Problem 11: Shell Scripts Don't Work on Windows

**What it means:** You're trying to run a `.sh` script (like `scripts/deploy-guide.sh`) on Windows.

**How to fix:**

- `.sh` scripts are for **Linux/macOS only** — they won't run natively on Windows.
- Use `bun run dev` (concurrently) or the manual two-terminal approach instead.
- If you need `.sh` scripts, install **WSL (Windows Subsystem for Linux)**:
  1. Open PowerShell as Administrator
  2. Run: `wsl --install`
  3. Restart your computer
  4. Open WSL terminal and run the scripts from there

### Problem 12: DATABASE_URL Path Issues on Windows

**What it means:** Prisma can't find the database file because of path format issues.

**How to fix:**

- Always use **forward slashes** (`/`) in `DATABASE_URL`, even on Windows:
  ```
  DATABASE_URL="file:./packages/db/data/custom.db"     ✅ Correct
  DATABASE_URL="file:.\packages\db\data\custom.db"    ❌ Wrong (backslashes)
  ```
- Prisma requires forward slashes regardless of operating system.

### Problem 13: `export` Command Not Recognized (Windows)

**What it means:** You're using a Linux/Mac command in Windows Command Prompt.

**How to fix:**

- In **Command Prompt**, use `set` instead of `export`:
  ```cmd
  set DATABASE_URL="file:./packages/db/data/custom.db"
  ```
- In **PowerShell**, use `$env:`:
  ```powershell
  $env:DATABASE_URL="file:./packages/db/data/custom.db"
  ```

---

## Quick Reference Card

### Port Map

| Port | What Runs On It | You Need It? |
|------|----------------|-------------|
| 3000 | Web App (Next.js) | ✅ Yes — always needed |
| 3003 | API Server (Hono) | ✅ Yes — always needed |
| 3080 | Desktop LAN Server | Only with desktop app |
| 3081 | LAN Discovery (UDP) | Only with desktop app |

### All Commands (From Project Root)

| What You Want to Do | Command | Run From |
|--------------------|---------|----------|
| Install dependencies | `bun install` | Project root (`blasti/`) |
| Start both servers | `bun run dev` | Project root |
| Start web app only | `bun run dev:web` | Project root |
| Start API only | `bun run dev:api` | Project root |
| Generate database client | `bun run db:generate` | Project root |
| Create database tables | `bun run db:push` | Project root |
| Add test data | `bun run db:seed` | Project root |
| Reset database | `bun run db:reset` | Project root |
| Build web app | `bun run build` | Project root |
| Build desktop app (Windows) | `bun run electron:build:win` | Project root |
| Build desktop app (Mac) | `bun run electron:build:mac` | Project root |
| Build desktop app (Linux) | `bun run electron:build:linux` | Project root |
| Sync mobile app | `bun run cap:sync` | Project root |
| Check code quality | `bun run lint` | Project root |

### Environment Variables Summary

| Variable | Required? | Default (Development) | What to Set for Production |
|----------|----------|----------------------|--------------------------|
| `DATABASE_URL` | ✅ Required | `file:./packages/db/data/custom.db` | Change path if needed |
| `NEXTAUTH_SECRET` | ✅ Required | `blast1-dev-s3cr3t-k3y-f0r-d3v3l0pm3nt-0nly` | **Must change** — use `openssl rand -base64 32` |
| `NEXTAUTH_URL` | ✅ Required | `http://localhost:3000/` | `https://blasti.yourdomain.com` |
| `CORS_ORIGIN` | ✅ Required | `*` | **Must change** — your domain |
| `INTERNAL_SECRET` | ✅ Required | `blast1-internal-secret-dev` | **Must change** — use `openssl rand -base64 32` |
| `NEXT_PUBLIC_API_URL` | Optional | (not set) | Your production URL |
| `BLASTI_LAN_ORIGINS` | Optional | (localhost only) | Specific LAN IPs |
| `CAPACITOR_SERVER_URL` | Optional (dev only) | (not set) | Your dev server IP |

### Where Each Variable Is Used

| Variable | API Server | Web App | Desktop App | Mobile App | Where in the Code |
|----------|:----------:|:-------:|:-----------:|:----------:|-------------------|
| `DATABASE_URL` | ✅ | ✅ | — | — | Prisma ORM — finds the database file |
| `NEXTAUTH_SECRET` | ✅ | ✅ | ✅ | — | NextAuth.js — encrypts sessions and JWTs |
| `NEXTAUTH_URL` | — | ✅ | — | — | NextAuth.js — redirect URLs |
| `CORS_ORIGIN` | ✅ | — | — | — | Hono CORS middleware — API access control |
| `INTERNAL_SECRET` | ✅ | — | — | — | Internal API endpoints — service-to-service auth |
| `API_PORT` | ✅ | ✅ | — | — | Server port (default: 3003), next.config.ts rewrites |
| `ALLOWED_ORIGINS` | ✅ | — | — | — | Socket.IO — allowed WebSocket origins |
| `NEXT_PUBLIC_API_URL` | — | ✅ | — | ✅ | Browser-side API calls (mobile/desktop) |
| `NEXT_PUBLIC_APP_URL` | ✅ | ✅ | — | — | QR codes, share links |
| `NEXT_PUBLIC_REALTIME_URL` | — | ✅ | — | ✅ | Socket.IO client connection URL |
| `NEXT_PUBLIC_REALTIME_TOKEN` | — | ✅ | — | ✅ | Socket.IO auth token |
| `BLASTI_API_URL` | — | — | ✅ | — | Electron — production URL to load |
| `BLASTI_LAN_ORIGINS` | — | — | ✅ | — | LAN server CORS origins |
| `CAPACITOR_SERVER_URL` | — | — | — | ✅ | Dev live-reload server URL |
| `SMS_API_URL` | ✅ | — | — | — | SMS gateway connection |
| `SMS_API_KEY` | ✅ | — | — | — | SMS gateway authentication |
| `BLOB_READ_WRITE_TOKEN` | ✅ | — | — | — | Vercel Blob file uploads |
| `NEXT_PUBLIC_R2_PUBLIC_URL` | — | ✅ | — | — | R2/S3 file access URL |
| `QR_HMAC_SECRET` | ✅ | — | — | — | QR token signing |
| `ENCRYPTION_KEY` | ✅ | — | — | — | Data encryption key |
| `CRON_SECRET` | ✅ | — | — | — | Cron endpoint security |

### Per-App .env Files

Each app has its own `.env.example` file documenting the specific variables it needs:

| File | Documents Variables For |
|------|----------------------|
| `.env.example` (root) | All shared variables — start here |
| `apps/api/.env.example` | API server: ports, CORS, SMS, QR, cron |
| `apps/web/.env.example` | Web app: NEXT_PUBLIC_*, auth, rewrites |
| `apps/desktop/.env.example` | Desktop: BLASTI_API_URL, LAN origins |
| `apps/mobile/.env.example` | Mobile: CAPACITOR_SERVER_URL, build mode |

> **For basic setup, the root `.env` is all you need.** Only create per-app `.env` files if you need different settings for different apps.

### Test Accounts

| Username | Password | Role | Use For |
|----------|----------|------|---------|
| `admin` | `admin123` | SUPER_ADMIN | Full admin access — manage everything |
| `owner1` | `owner123` | AGENCY_OWNER | Agency management — manage staff and services |
| `staff1` | `staff123` | AGENCY_STAFF | Queue management — call next, serve customers |
| `customer1` | `customer123` | CUSTOMER | Customer view — join queues, track position |

### Agency Codes

| Code | Agency Name |
|------|-------------|
| `CLINIC001` | Al Salam Clinic |
| `LAB001` | Lab Express M'Sila |
| `GOV001` | Wilaya Citizenship Office |

---

## Feature Guide — What You Can Do

> 🌟 **This section covers the powerful features that make BLASTI more than just a queue system.**
> Each feature works out of the box — but understanding how they work helps you configure them for your needs.

---

### 🔔 Smart Notification Routing System

BLASTI doesn't just send alerts — it **intelligently routes** them through the cheapest and fastest channel first, saving you money while making sure no customer misses their turn.

#### How the Routing Cascade Works

When BLASTI needs to notify a customer, it tries each channel in order — **free first, paid last**:

```
┌─────────────────────────────────────────────────────┐
│           🔔 NOTIFICATION ROUTING CASCADE            │
│                                                      │
│   1️⃣  WebSocket (Real-time Push)     ← FREE ✅      │
│       ↓ (customer not online?)                       │
│   2️⃣  FCM Push Notification         ← FREE ✅      │
│       ↓ (no mobile app / no FCM token?)              │
│   3️⃣  SMS / WhatsApp                ← PAID 💰      │
│                                                      │
│   💡 Only pays for SMS/WhatsApp as a LAST resort!    │
└─────────────────────────────────────────────────────┘
```

| Channel | Cost | Speed | When It's Used |
|---------|------|-------|----------------|
| **WebSocket** | Free | Instant | Customer has the app open in their browser |
| **FCM Push** | Free | ~1 second | Customer has the mobile app installed |
| **SMS / WhatsApp** | Paid (DZD) | ~3-10 seconds | Customer is offline — last resort |

#### The 25% Mathematical Buffer Rule ⏰

BLASTI uses a clever math trick for **ADVANCE_WARNING** alerts (e.g., "Your turn is approaching!"). Instead of sending the alert at the exact estimated time, it adds a **25% safety buffer** so customers arrive early rather than late:

```
ExecutionTime = Date.now() + (remainingMinutes × 0.25 × 60 × 1000)
```

**Example:** If a customer's turn is 20 minutes away:
- Buffer = 20 × 0.25 = 5 extra minutes
- Alert fires at **15 minutes before** the turn, not 20
- Customer gets a head start and arrives on time! 🎯

> **💡 Why 25%?** It's the sweet spot — not too early (customers forget), not too late (they miss their turn).

#### TURN_CALL Alerts — No Delay! 🚀

When a customer's turn is **actually called** (TURN_CALL alert), the system **bypasses the delay engine completely** and dispatches the notification immediately. No buffers, no waiting — instant delivery across all channels.

```
TURN_CALL Alert Flow:
  Customer's turn called → 🔴 IMMEDIATE dispatch
                          ├── WebSocket: instant
                          ├── FCM Push: instant
                          └── SMS/WhatsApp: instant

ADVANCE_WARNING Alert Flow:
  Turn approaching → ⏳ Buffer calculation → ⏲️ Delayed dispatch
```

#### The Background Notification Worker ⚙️

BLASTI runs a **background worker** that checks for pending notifications every **30 seconds**:

```
Every 30 seconds:
  ┌──────────────────────────────────┐
  │  Notification Worker wakes up     │
  │  ↓                                │
  │  Find PENDING DelayedJob records  │
  │  where executeAt <= Date.now()    │
  │  ↓                                │
  │  For each pending job:            │
  │    → Send via notification cascade│
  │    → Mark as DISPATCHED           │
  └──────────────────────────────────┘
```

| Worker Setting | Value | What It Means |
|----------------|-------|---------------|
| Check interval | 30 seconds | How often it looks for pending alerts |
| Status: PENDING | Waiting to be sent | Not yet time to send |
| Status: DISPATCHED | Already sent | Notification was delivered |
| Status: CANCELLED | Cancelled | Customer opened the app before the alert |

#### How Balance Deduction Works 💰

When a paid notification (SMS/WhatsApp) is sent, BLASTI deducts the cost from the customer's balance in this order:

```
Deduction Order:
  1. agency.sponsorSms     ← Agency covers it first (if enabled)
     ↓ (agency out of SMS credits?)
  2. agency.smsBalance     ← Agency's SMS balance
     ↓ (agency balance depleted?)
  3. user.freeSmsCount     ← Customer's personal free SMS count
```

> **💡 Tip:** Agencies can "sponsor" SMS for their customers, so customers never pay out of pocket. Enable this in the agency dashboard settings.

#### Cancel-Pending-Alerts Utility 🛑

When a customer **opens the app** (via WebSocket connection), BLASTI automatically cancels any pending SMS/WhatsApp alerts that haven't been sent yet — because the customer already saw the update in the app!

```
Customer opens app:
  → WebSocket connects
  → Cancel-pending-alerts utility runs
  → All PENDING DelayedJobs for this customer → CANCELLED
  → 💰 SMS credits saved!
```

#### User Notification Preferences 📱

Customers can choose how they want to be notified using the **NotificationPref** setting:

| Preference | What It Does | When to Use |
|------------|-------------|-------------|
| `SMS` | Only SMS notifications | Customer prefers text messages |
| `WHATSAPP` | Only WhatsApp notifications | Customer uses WhatsApp regularly |
| `BOTH` | SMS + WhatsApp (both channels) | Customer wants maximum coverage |
| `APP_ONLY` | Only in-app + push (no SMS/WhatsApp) | Customer doesn't want paid messages |

#### Configuration

The notification system **works out of the box** with zero configuration. However, you can customize these settings:

| Setting | Where to Configure | Default | Description |
|---------|-------------------|---------|-------------|
| SMS API URL | `.env` → `SMS_API_URL` | — | Your SMS gateway endpoint |
| SMS API Key | `.env` → `SMS_API_KEY` | — | Your SMS gateway authentication key |
| Sponsor SMS | Agency Dashboard → Settings | Disabled | Agency pays for customer SMS |
| Notification Preference | Customer Profile → Settings | `APP_ONLY` | Per-customer notification channel |
| Worker Interval | API server config | 30 seconds | How often the background worker checks |

> **🔧 Developer Note:** To enable SMS/WhatsApp, you must set `SMS_API_URL` and `SMS_API_KEY` in your `.env` file. Without these, BLASTI will only use free channels (WebSocket + FCM Push).

---

### 📺 Agency Device Management

BLASTI lets agency owners connect and manage **physical devices** — TV displays, kiosk tablets, printers, and more — all from the agency dashboard. No more walking to each device to configure it!

#### Supported Device Types

| Device Type | Code | What It's Used For | Example |
|-------------|------|--------------------|---------|
| 📺 **TV** | `TV` | Large screen showing the queue board | Waiting room TV |
| 📱 **Kiosk** | `KIOSK` | Self-service tablet for customers | Take-a-number tablet |
| 🖥️ **Display** | `DISPLAY` | Secondary information screen | Service selector screen |
| 🖨️ **Printer** | `PRINTER` | Ticket printing device | Thermal ticket printer |

#### Connection Types

Devices can connect to BLASTI in different ways:

| Connection | Code | Description | Best For |
|------------|------|-------------|----------|
| 🌐 **LAN** | `LAN` | Wired local network | Desktops, printers |
| 📡 **WiFi** | `WIFI` | Wireless local network | Tablets, kiosks |
| 🔌 **Cable** | `CABLE` | Direct cable connection | Thermal printers |
| ✋ **Manual** | `MANUAL` | Manual setup (no auto-discovery) | Remote devices |

#### Auto-Discovery 🔍

BLASTI can **automatically find devices** on your local network. When the desktop app or LAN server is running, it broadcasts a discovery signal, and compatible devices respond with their details.

```
┌──────────────┐     Discovery Signal      ┌──────────────┐
│   BLASTI     │ ──────────────────────────▶│  TV Display  │
│   Server     │◀──────────────────────────│  (found!)    │
│              │     Device Info Response    └──────────────┘
│              │
│              │     Discovery Signal      ┌──────────────┐
│              │ ──────────────────────────▶│  Printer     │
│              │◀──────────────────────────│  (found!)    │
│              │     Device Info Response    └──────────────┘
└──────────────┘
```

#### Pairing System 🔗

For security, discovered devices must be **paired** before they can receive data:

1. **6-Digit Pairing Code** — The device displays a code, you enter it in the dashboard
2. **QR Code Pairing** — Scan the QR code displayed on the device with the BLASTI app

```
Pairing Flow:
  ┌──────────────────────────────────────────────┐
  │  1. Device shows pairing code: "4 7 2 9 1 5" │
  │     (or displays a QR code)                   │
  │                                               │
  │  2. Agency owner enters code in dashboard     │
  │     (or scans QR code)                        │
  │                                               │
  │  3. ✅ Device paired! Now receiving data       │
  └──────────────────────────────────────────────┘
```

#### Display Settings & Screen Layouts 🎨

Each device can be configured with a specific **screen layout** depending on its purpose:

| Layout | Code | What It Shows | Best Device |
|--------|------|---------------|-------------|
| **Queue Board** | `QUEUE_BOARD` | Live queue — current ticket, waiting list, called numbers | TV 📺 |
| **Ticket Printer** | `TICKET_PRINTER` | Print ticket interface with queue number | Printer 🖨️ |
| **Service Selector** | `SERVICE_SELECTOR` | Choose a service and take a number | Kiosk 📱 |
| **Custom** | `CUSTOM` | Fully customizable layout | Any device |

#### Device Heartbeats 💓

BLASTI tracks whether each device is **online or offline** using a heartbeat system:

| Status | Meaning | Icon |
|--------|---------|------|
| 🟢 **Online** | Device is connected and responding | Green dot |
| 🔴 **Offline** | Device hasn't sent a heartbeat recently | Red dot |
| 🟡 **Pairing** | Device is in pairing mode | Yellow dot |

> **How it works:** Each paired device sends a "heartbeat" signal every few seconds. If BLASTI doesn't receive a heartbeat within the timeout period, the device is marked offline.

#### Where to Manage Devices

All device management is done from the **Devices & Connection** page in the agency dashboard:

1. Log in as an **Agency Owner**
2. Go to **Dashboard → Devices & Connection**
3. You'll see all connected devices, their status, and settings

From this page you can:
- ✅ Pair new devices
- ✅ View online/offline status
- ✅ Change display layouts
- ✅ Remove disconnected devices
- ✅ Rename devices for easy identification

---

### 🏢 Enterprise & Government Contract Configurator

BLASTI includes a powerful **contract configurator** for large institutions — hospitals with multiple branches, government offices across wilayas, or enterprise organizations that need custom pricing and hardware packages.

#### What It Does

Admin users can create **custom enterprise contracts** that define:

| What You Configure | Options | Example |
|---------------------|---------|---------|
| **Branch Fleet** | 1 – 50 branches | 12 branches across 3 wilayas |
| **Counters / Reception Terminals** | 1 – 30 counters | 8 service counters per branch |
| **Hardware Payment Model** | Pure HaaS or Hybrid | See below ⬇️ |
| **Lease Commitment** | 1 – 4 years | 3-year contract |

#### Hardware Payment Models 💳

BLASTI offers two ways to pay for the hardware (screens, printers, tablets):

| Model | Upfront Cost | Monthly Cost | Best For |
|-------|-------------|-------------|----------|
| **Pure HaaS** 🏠 | **0 DZD** (zero upfront!) | Full equipment lease in monthly bill | Startups, small clinics |
| **Hybrid** 🔀 | Reduced upfront capital | Lower monthly lease | Established organizations |

```
Payment Model Comparison:

  Pure HaaS:                        Hybrid:
  ┌──────────────────┐              ┌──────────────────┐
  │ Upfront: 0 DZD   │              │ Upfront: $$$ DZD │
  │ Monthly: Full $   │              │ Monthly: Lower $  │
  │                   │              │                    │
  │ ✅ No capital needed             │ ✅ Lower monthly bill
  │ ❌ Higher monthly  │              │ ❌ Requires upfront │
  └──────────────────┘              └──────────────────┘
```

#### Lease Commitment Timeline 📅

| Term | Duration | Discount |
|------|----------|----------|
| **1 Year** | 12 months | Standard pricing |
| **2 Years** | 24 months | 5% discount |
| **3 Years** | 36 months | 10% discount |
| **4 Years** | 48 months | 15% discount |

#### Real-Time Cost Sheet Calculation 📊

As you configure the contract, BLASTI **instantly calculates** the total cost, showing you a detailed breakdown:

| Cost Component | How It's Calculated | Example |
|----------------|--------------------|---------|
| **Monthly Software License** | Base + extra branches + extra counters | See formula below |
| **HaaS Equipment Lease** | Based on device count × model | Calculated per contract |
| **Upfront Capital** | Only for Hybrid model | Calculated per contract |

**Pricing Formula:**

```
Monthly Software License =
    28,000 DZD                          ← Base price
  + (extra_branches × 3,500 DZD)       ← Each branch above 1
  + (extra_counters × 1,500 DZD)       ← Each counter above 1
```

**Example Calculation:**

| Item | Value | Cost |
|------|-------|------|
| Base software license | 1 branch, 1 counter | 28,000 DZD/month |
| + 9 extra branches | 9 × 3,500 DZD | + 31,500 DZD |
| + 4 extra counters | 4 × 1,500 DZD | + 6,000 DZD |
| **Total Monthly** | | **65,500 DZD/month** |

#### Where to Find It

1. Log in as a **Super Admin**
2. Go to **Admin Panel → Custom Plans**
3. Configure the contract using the interactive form
4. The cost sheet updates in real-time as you change options

> **💡 Tip:** The configurator automatically validates that the branch and counter counts stay within allowed ranges (1-50 branches, 1-30 counters).

---

### 🚨 Aggressive Turn Alert

When a customer's turn is called, BLASTI doesn't just send a quiet notification — it grabs their attention with a **full-screen flashing alert** that's impossible to miss! 🔴🟢

#### What Happens When Your Turn Is Called

```
┌──────────────────────────────────────────────┐
│                                               │
│   🔴🟢🔴🟢🔴🟢  YOUR TURN!  🔴🟢🔴🟢🔴🟢   │
│                                               │
│   ⚡ Red/Green alternating flash animation    │
│   📳 Phone vibration: 200ms on / 200ms off   │
│   🔊 Alarm sound with mute toggle             │
│                                               │
│   [  Mute 🔇  ]      [  Dismiss ✕  ]        │
│                                               │
└──────────────────────────────────────────────┘
```

#### Feature Breakdown

| Feature | How It Works | Can't Miss It? |
|---------|-------------|----------------|
| 🔴🟢 **Flashing Screen** | Full-screen red/green alternating animation | Impossible to ignore |
| 📳 **Vibration** | 200ms on / 200ms off pattern on mobile | You'll feel it |
| 🔊 **Alarm Sound** | Loud notification alarm with mute button | You'll hear it |
| 🔕 **Mute Toggle** | One-tap mute for the alarm sound | Yes, you can silence it! |
| ✕ **Dismiss Button** | Close the alert when you're ready | Tap when acknowledged |

#### How It Works on Different Platforms

| Platform | Technology Used | Behavior |
|----------|----------------|----------|
| **Web Browser** | Web Notification API | Full-screen overlay + sound |
| **Android (Native)** | Capacitor LocalNotifications | High-priority notification + vibration |
| **iOS (Native)** | Capacitor LocalNotifications | Alert banner + sound |

#### Android High-Priority Channel 🔔

On Android, BLASTI creates a special **high-priority notification channel** called `"blasti-turn-alert"`. This ensures:

- ✅ The notification appears at the **top of the notification shade**
- ✅ It **bypasses Do Not Disturb** mode (with permission)
- ✅ It makes **sound and vibration** even in silent mode (with permission)
- ✅ It shows as a **heads-up notification** (pops over the current app)

> **💡 Important:** On Android 13+, the user must grant notification permission when first prompted. Without it, the turn alert will only work when the app is open.

#### Customization

| Setting | Default | Can Change? |
|---------|---------|-------------|
| Flash animation speed | 500ms per color | No (optimized for attention) |
| Vibration pattern | 200ms on / 200ms off | No (standard alert pattern) |
| Alarm sound | Default system alarm | No |
| Mute toggle | Available on-screen | Yes — user can mute per-alert |
| Auto-dismiss | Never (user must dismiss) | No — ensures acknowledgment |

---

### ⏱️ Wait Time Predictor

Nobody likes wondering "How much longer?" — BLASTI's **Wait Time Predictor** shows customers a beautiful animated gauge with their estimated wait time, updating in real-time as the queue progresses.

#### The Semi-Circle Gauge

```
              0 min
               ╭─────────╮
            ╱       ↑       ╲
         ╱     🟢  │  🟢      ╲       ← Green zone (fast!)
       ╱           │           ╲
      │   🟢       │    🟡      │      ← Amber zone (moderate)
      │            │            │
      │  🟢────────┼────────🟠  │
      │            │  ⚫        │      ⚫ = Animated needle
      │   🟡       │    🔴      │      ← Red zone (long wait)
       ╲           │           ╱
         ╲         │         ╱
            ╲      │      ╱
               ╰───┴───╯
              30    60 min

  ┌──────────────────────────────┐
  │  🎫 Position: #4 of 12       │
  │  ⏱️  Estimated Wait: ~18 min  │
  │  ⏳ Avg Service Time: 4.5 min │
  │  👥 Total Waiting: 12        │
  └──────────────────────────────┘
```

#### Color Zones

| Zone | Color | Wait Time | What It Means |
|------|-------|-----------|---------------|
| 🟢 **Green** | Emerald/Teal | 0 – 15 min | You'll be served soon! |
| 🟡 **Amber** | Yellow/Orange | 15 – 35 min | Moderate wait — grab a coffee |
| 🔴 **Red** | Red | 35 – 60 min | Long wait — consider coming back |

#### Spring-Animated Needle 🎯

The gauge needle uses a **spring animation** for smooth, natural movement:

- When the estimated time changes, the needle **doesn't jump** — it glides smoothly
- Spring physics give it a slight **bounce** at the destination (like a real gauge)
- This makes the update feel natural and reassuring, not jarring

```
Needle Movement:
  Old position ──▶ smooth glide ──▶ slight bounce ──▶ new position
                  (spring physics)
```

#### Information Displayed

| What You See | Where | Updates |
|-------------|-------|---------|
| **Current Position** | Below gauge | When someone is called |
| **Estimated Wait (min)** | Below gauge | Real-time as queue moves |
| **Average Service Time** | Below gauge | Calculated from historical data |
| **Total Waiting** | Below gauge | When people join/leave |

#### Real-Time Updates ⚡

The gauge updates automatically as the queue progresses — no need to refresh the page:

- ✅ Someone is called → your position moves up → needle glides left
- ✅ New person joins → total waiting increases → slight adjustment
- ✅ Service speed changes → estimated time recalculates

> **💡 How it's calculated:** BLASTI uses the average service time of the current counter, multiplied by your position in the queue, with adjustments for real-time conditions.

---

### ⚙️ Customer Notification Preferences UI

BLASTI gives customers full control over how and when they receive notifications. The **Notification Preferences** page features beautiful visual toggle cards — no confusing checkboxes!

#### Visual Toggle Cards 🔘

Customers can enable or disable notifications for different events:

| Toggle Card | Event | Default | What It Controls |
|-------------|-------|---------|------------------|
| 🔔 **Queue Called** | `queue_called` | ON | Notify when your turn is called |
| ⏰ **Turn Approaching** | `turn_approaching` | ON | Notify before your turn (advance warning) |
| ✅ **Completed** | `completed` | ON | Notify when your service is finished |

```
  ┌─────────────────────────┐  ┌─────────────────────────┐
  │ 🔔 Queue Called      [●]│  │ ⏰ Turn Approaching  [●]│
  │    Your turn is called   │  │    Advance warning       │
  └─────────────────────────┘  └─────────────────────────┘

  ┌─────────────────────────┐
  │ ✅ Completed          [●]│
  │    Service finished      │
  └─────────────────────────┘
         [●] = ON   [ ○ ] = OFF
```

#### SMS Settings 📱

For SMS-specific settings, customers can configure:

| Setting | Options | Default | Description |
|---------|---------|---------|-------------|
| **Reminder Minutes** | 5 – 30 minutes | 15 min | How far in advance to send the SMS reminder |
| **SMS Notifications** | On / Off | On | Enable or disable SMS alerts entirely |

The **reminder minutes selector** is a visual slider or dropdown that lets customers pick their preferred advance warning time:

```
  Reminder advance time:
  ├── 5 min  ── Fast notification
  ├── 10 min
  ├── 15 min ── Default ✅
  ├── 20 min
  ├── 25 min
  └── 30 min ── Early bird
```

#### SMS Wallet 💰

BLASTI includes a visual **SMS wallet** that shows the customer's SMS balance:

```
  ┌──────────────────────────────────┐
  │  📱 SMS Wallet                   │
  │                                   │
  │  ████████████░░░░  73% remaining  │
  │                                   │
  │  Balance: 15 / 20 SMS remaining   │
  │                                   │
  │  ┌────────┐ ┌────────┐ ┌──────┐  │
  │  │ Pack 20│ │ Pack 50│ │ Pack │  │
  │  │ 200 DZD│ │ 450 DZD│ │ 100  │  │
  │  └────────┘ └────────┘ │800₺  │  │
  │                        └──────┘  │
  └──────────────────────────────────┘
```

| Wallet Feature | What It Shows |
|----------------|---------------|
| **Progress Bar** | Visual indicator of remaining SMS balance |
| **Balance Display** | "X / Y SMS remaining" |
| **Purchase Buttons** | Quick-buy SMS packs |

#### SMS Pack Purchases 📦

Customers can buy SMS packs directly from the wallet:

| Pack Size | Price (DZD) | Price per SMS |
|-----------|-------------|---------------|
| 20 SMS | 200 DZD | 10 DZD |
| 50 SMS | 450 DZD | 9 DZD |
| 100 SMS | 800 DZD | 8 DZD |
| 200 SMS | 1,400 DZD | 7 DZD |

> **💡 The more you buy, the cheaper per SMS!** The 200 SMS pack costs only 7 DZD per message.

#### Purchase History 📋

Customers can view their **SMS purchase history** with detailed statistics:

| What You See | Description |
|-------------|-------------|
| **Purchase Date** | When the pack was bought |
| **Pack Size** | How many SMS were in the pack |
| **Amount Paid** | Total DZD paid |
| **SMS Used** | How many have been sent |
| **SMS Remaining** | How many are left |
| **Total Statistics** | Lifetime SMS sent, total spent, average cost |

```
  Purchase History:
  ┌──────────────────────────────────────────────┐
  │ 📦 50 SMS Pack — 450 DZD — Jan 15, 2026     │
  │    Used: 35 / 50  ████████░░  70%            │
  ├──────────────────────────────────────────────┤
  │ 📦 20 SMS Pack — 200 DZD — Dec 3, 2025      │
  │    Used: 20 / 20  ██████████  100% ✅        │
  ├──────────────────────────────────────────────┤
  │ 📊 Lifetime: 55 SMS sent | 650 DZD total    │
  │    Average: 11.8 DZD per SMS                 │
  └──────────────────────────────────────────────┘
```

> **🌍 Multilingual Support:** All notification preferences are available in **Arabic (RTL)** 🇩🇿, **French** 🇫🇷, and **English** 🇬🇧 — the interface automatically adapts to the customer's language setting.

---

## 🎉 You're Ready!

If you've completed all the steps above, your BLASTI system should be up and running:

- ✅ **Web App** running in your browser
- ✅ **API Server** handling requests
- ✅ **Database** storing your data
- ✅ **Real-time updates** working via Socket.IO

For technical details, see [ARCHITECTURE.md](./ARCHITECTURE.md) and [LOCAL_DEVELOPMENT.md](./LOCAL_DEVELOPMENT.md).
