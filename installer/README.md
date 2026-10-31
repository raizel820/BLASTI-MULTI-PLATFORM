# installer/

Installer staging folders for CI. **Binaries are NOT stored in git or on
GitHub Releases** — git rejects files over 100 MB and the Windows installer
is ~155 MB. Instead, the `Build Installers` GitHub Action uploads them
**directly to the BLASTI VPS**, where they are served by the platform itself.

CI stages the freshly built binaries here inside the runner workspace
(never committed), then the `publish-to-vps` job delivers them.

## Where the installers end up on the VPS

| Built file | VPS path (under `BLASTI_STORAGE_DIR`) | Platform channel |
|---|---|---|
| `desktop/BLASTI-Setup-<version>.exe` — Windows NSIS (Electron, x64) | `app-versions/desktop/<…>.exe` | `windows` |
| `mobile/BLASTI-v<version>-debug.apk` — Android debug APK (Capacitor) | `app-versions/mobile/<…>.apk` | `android-debug` |

The split mirrors this folder layout 1:1 inside the API's storage root, so
**Admin → Database and Storage Management → Storage Manager** shows them
under the `app-versions` category → *Installer folders* (`desktop/`, `mobile/`).

## What the upload does

1. CI runs `node scripts/publish-installer.mjs` per file — a multipart
   `POST /api/app-versions/upload?create=1` authenticated with the shared
   deploy token (`x-deploy-token` header).
2. The API stores the binary, records its SHA-256, and creates/updates an
   **AppVersion draft** (never auto-published).
3. An admin opens **Admin → Public Apps Settings**, reviews the draft and
   clicks **Activate** — that version becomes THE published installer for
   its platform (public download section + app update checks follow).

## Required GitHub secrets

Settings → Secrets and variables → Actions → Repository secrets:

| Secret | Value |
|---|---|
| `BLASTI_API_URL` | Public site URL the VPS Caddy serves, e.g. `https://blasti.example.com` (no trailing slash needed) |
| `BLASTI_DEPLOY_TOKEN` | The `DEPLOY_TOKEN` value from `/etc/blasti/blasti.env` on the VPS |

If either secret is missing, the publish job **skips with a notice** and the
built files remain available as run artifacts
(Actions → *Build Installers* → run → **Artifacts**, 30 days).

## Changing the version (the "old version in the file name" fix)

Each artifact name reads its version from a DIFFERENT file — that is why
bumping one `package.json` used to leave installers named with the old
version:

| Artifact | Version source |
|---|---|
| `BLASTI-Setup-<x.y.z>.exe` (Windows) | `apps/desktop/package.json` → `version` |
| `BLASTI-v<x.y.z>-debug.apk` (Android) | `apps/mobile/package.json` → `version` (synced into `android/app/build.gradle` `versionName`/`versionCode` by `scripts/gradle.js` before every build) |
| API self-report (`GET /api/health`) | `apps/api/package.json` → `version` (read live by `apps/api/src/index.ts`) |
| Mobile launch-animation version badge | Same `versionName` (via the Capacitor Device plugin) |
| Desktop launch-animation version label | `apps/desktop/package.json` (plus the `build-stamp.json` build date) |

**One command bumps everything and keeps the names in sync:**

```bash
bun run version:set 1.2.3     # writes every package.json + build.gradle
bun run version:check         # audit the current version map
```

Commit + push to master → CI builds `BLASTI-Setup-1.2.3.exe` and
`BLASTI-v1.2.3-debug.apk` → the publish job registers AppVersion `1.2.3` as
a DRAFT in **Admin → Public Apps Settings** → click **Activate**.

## Manual upload (local machine or VPS)

```bash
node scripts/publish-installer.mjs \
  --file BLASTI-Setup-0.3.4.exe \
  --platform windows \
  --version 0.3.4 \
  --api-url https://blasti.example.com \
  --token "$DEPLOY_TOKEN" \
  --notes "manual upload"
```

Platforms: `windows` / `electron` / `mac` / `linux` → `desktop/`,
`android` / `android-debug` / `ios` → `mobile/`.

## Manual build (local machine or VPS)

```bash
bun install

# ── Desktop .exe ──────────────────────────────────────────────
bun run build:export
cd apps/desktop
node scripts/prebuild.js
npx electron-builder --win
# → dist/BLASTI-Setup-<version>.exe

# ── Mobile debug APK ──────────────────────────────────────────
bun run --filter @blasti/mobile build:android:debug
# → BLASTI-v<version>-debug.apk copied to the repo root
```

> **Note:** builds are unsigned (no code-signing certificate configured), so
> Windows SmartScreen / Android Play Protect may show a warning on first run.
