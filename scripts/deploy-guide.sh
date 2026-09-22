#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════╗
# ║  ⚠️  Linux/macOS ONLY — This script uses Bash-specific       ║
# ║       commands (pkill, setsid, ss, etc.)                    ║
# ║                                                              ║
# ║  Windows users:                                              ║
# ║    Use the npm scripts in package.json instead:              ║
# ║      bun run dev      → Start both API + Web                ║
# ║      bun run dev:api  → Start API only (port 3003)           ║
# ║      bun run dev:web  → Start Web only (port 3000)          ║
# ║                                                              ║
# ║  Or open two separate terminal windows and run:              ║
# ║      Terminal 1: bun run dev:api                            ║
# ║      Terminal 2: bun run dev:web                            ║
# ╚══════════════════════════════════════════════════════════════╝
# ============================================================================
# BLASTI Deployment Guide & Build Scripts
# ============================================================================
#
# This script documents how to:
#   1. Deploy the BLASTI frontend to Vercel
#   2. Build the Windows .exe (Electron desktop app)
#   3. Build the Android .apk (Capacitor mobile app)
#   4. Self-host the full stack (API + Web + Database)
#
# ============================================================================

# ============================================================================
# SECTION 1: DEPLOY TO VERCEL (Frontend Only)
# ============================================================================
#
# BLASTI's frontend (apps/web) uses Next.js with `output: "export"`,
# generating static HTML/JS/CSS files — perfect for Vercel's CDN.
#
# IMPORTANT: The Hono API server (apps/api) and Socket.IO real-time
# features CANNOT run on Vercel. You need a separate backend host.
#
# --- Step-by-Step ---
#
# 1. Push your code to GitHub
#
# 2. Go to https://vercel.com/new and import your repository
#
# 3. Configure the project:
#    - Framework Preset: Other
#    - Root Directory: / (leave as root, vercel.json handles paths)
#    - Build Command: (auto-detected from vercel.json)
#    - Output Directory: (auto-detected from vercel.json)
#
# 4. Set environment variables in Vercel dashboard:
#    NEXT_PUBLIC_API_URL=https://your-api-server.com
#
# 5. Deploy!
#
# --- Using Vercel CLI ---
#
# npm i -g vercel
# vercel login
# vercel --prod
#
# ============================================================================

# ============================================================================
# SECTION 2: BUILD WINDOWS .EXE (Electron Desktop App)
# ============================================================================
#
# Prerequisites:
#   - Node.js 18+ and npm/bun installed
#   - Windows: For .exe builds (cross-compilation from Linux/Mac is possible
#     but may require Wine; building on Windows is recommended)
#   - macOS: For .dmg builds
#   - Linux: For .AppImage/.deb builds
#
# --- Step-by-Step ---
#
# 1. Build the Next.js static export first:
#
#    cd apps/web
#    DATABASE_URL="file:../../packages/db/data/custom.db" bun run build
#    cd ../..
#
# 2. Build the Electron app:
#
#    cd apps/desktop
#    npm run build:win        # Windows .exe (NSIS installer)
#    npm run build:mac        # macOS .dmg
#    npm run build:linux      # Linux .AppImage + .deb
#    npm run build:all        # All platforms
#
# 3. Output location:
#    apps/desktop/dist/BLASTI-Setup-0.2.0.exe   (Windows)
#    apps/desktop/dist/BLASTI-0.2.0.dmg          (macOS)
#    apps/desktop/dist/BLASTI-0.2.0.AppImage     (Linux)
#
# --- How It Works ---
#
# The `npm run prebuild` script (defined in apps/desktop/package.json)
# automatically copies the Next.js static export from apps/web/out
# into apps/desktop/out/ before electron-builder runs.
#
# In production, the Electron app loads from bundled local files (out/),
# making it work offline. API calls go to the server configured via
# BLASTI_API_URL environment variable.
#
# --- Custom Icon ---
#
# Replace the placeholder icons in apps/desktop/assets/:
#   - icon.ico   (Windows, 256x256 minimum)
#   - icon.icns  (macOS, 512x512 minimum)
#   - icon.png   (Linux, 512x512)
#   - tray-icon.png (16x16 or 32x32 for system tray)
#
# You can generate .ico and .icns from a PNG using:
#   npm install -g electron-icon-builder
#   electron-icon-builder --input=logo.png --output=assets
#
# ============================================================================

# ============================================================================
# SECTION 3: BUILD ANDROID .APK (Capacitor Mobile App)
# ============================================================================
#
# Prerequisites:
#   - Android Studio installed (https://developer.android.com/studio)
#   - Android SDK (API level 33+, installed via Android Studio)
#   - Java Development Kit (JDK 17+)
#   - Gradle (comes with Android Studio)
#
# --- Step-by-Step ---
#
# 1. Build the Next.js static export:
#
#    cd apps/web
#    DATABASE_URL="file:../../packages/db/data/custom.db" bun run build
#    cd ../..
#
# 2. Sync web files to Capacitor:
#
#    cd apps/mobile
#    npx cap sync android
#    cd ../..
#
#    Or from the root:
#    bun run cap:sync:android
#
# 3. Open the Android project in Android Studio:
#
#    cd apps/mobile
#    npx cap open android
#
# 4. Build the APK in Android Studio:
#    - Go to Build > Build Bundle(s) / APK(s) > Build APK(s)
#    - Or use the command line:
#
#    cd apps/mobile/android
#    ./gradlew assembleDebug          # Debug APK
#    ./gradlew assembleRelease        # Release APK (needs signing)
#
# 5. Output location:
#    apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
#    apps/mobile/android/app/build/outputs/apk/release/app-release.apk
#
# --- Release Signing ---
#
# To create a release APK (for Play Store distribution):
#
# 1. Generate a keystore:
#    keytool -genkey -v -keystore blasti-release.keystore \
#      -alias blasti -keyalg RSA -keysize 2048 -validity 10000
#
# 2. Create apps/mobile/android/app/keystore.properties:
#    storeFile=../../blasti-release.keystore
#    storePassword=YOUR_PASSWORD
#    keyAlias=blasti
#    keyPassword=YOUR_PASSWORD
#
# 3. Update apps/mobile/android/app/build.gradle to use the keystore
#
# 4. Build the signed release:
#    ./gradlew assembleRelease
#
# --- iOS Build (macOS only) ---
#
# 1. Install Xcode from the Mac App Store
# 2. cd apps/mobile && npx cap sync ios && npx cap open ios
# 3. In Xcode: Product > Archive > Distribute App
#
# ============================================================================

# ============================================================================
# SECTION 4: SELF-HOST THE FULL STACK (Recommended)
# ============================================================================
#
# BLASTI is designed as a local-first, offline-capable system.
# Self-hosting is the recommended deployment approach because:
#   - Socket.IO needs persistent WebSocket connections
#   - SQLite database requires persistent filesystem
#   - Offline-first architecture works best with a dedicated server
#
# --- Quick Start (VPS / Dedicated Server) ---
#
# 1. Set up your server:
#    apt update && apt install -y curl
#    curl -fsSL https://bun.sh/install | bash
#
# 2. Clone and install:
#    git clone <your-repo> /opt/blasti
#    cd /opt/blasti
#    bun install
#
# 3. Initialize database:
#    bun run db:push
#    bun run db:seed
#
# 4. Build the frontend:
#    cd apps/web && DATABASE_URL="file:../../packages/db/data/custom.db" bun run build && cd ../..
#
# 5. Start with pm2:
#    npm install -g pm2
#    pm2 start "bun run dev:api" --name blasti-api
#    pm2 start "bun run dev:web" --name blasti-web
#    pm2 save && pm2 startup
#
# 6. Set up Caddy as reverse proxy (config in ops/Caddyfile):
#    apt install -y caddy
#    cp ops/Caddyfile /etc/caddy/Caddyfile
#    # Edit the domain name in the Caddyfile
#    systemctl restart caddy
#
# --- Docker Compose (Alternative) ---
#
# Create a Dockerfile:
#
#    FROM oven/bun:1
#    WORKDIR /app
#    COPY . .
#    RUN bun install
#    RUN bun run db:push
#    RUN cd apps/web && DATABASE_URL="file:../../packages/db/data/custom.db" bun run build
#    EXPOSE 3000 3003
#    CMD ["sh", "-c", "bun run dev:api & bun run dev:web"]
#
# --- Cloud Platforms ---
#
# | Platform    | Socket.IO | SQLite | Cost     | Notes                    |
# |-------------|-----------|--------|----------|--------------------------|
# | Railway     | ✅        | ⚠️*    | Free+    | *Use attached volume     |
# | Fly.io      | ✅        | ⚠️*    | Free+    | *Use persistent volume   |
# | Render      | ✅        | ❌     | $7/mo+   | Need external DB         |
# | DigitalOcean| ✅        | ✅     | $5/mo+   | Full VPS control         |
# | Hetzner     | ✅        | ✅     | €4/mo+   | Best value VPS           |
#
# ============================================================================

echo "BLASTI Deployment Guide"
echo "======================="
echo ""
echo "Available build commands:"
echo "  bun run build              - Build Next.js static export"
echo "  bun run electron:build     - Build Electron desktop app (.exe/.dmg/AppImage)"
echo "  bun run cap:sync:android   - Sync web build to Capacitor Android project"
echo "  bun run cap:sync:ios       - Sync web build to Capacitor iOS project"
echo ""
echo "See the comments in this file for detailed instructions."
