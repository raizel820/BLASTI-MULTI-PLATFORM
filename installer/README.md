# installer/

Auto-generated installer artifacts. **Do not commit edits by hand** — the
`Build Installers` GitHub Action refreshes this folder automatically.

| Folder | File | What it is |
|---|---|---|
| `desktop/` | `BLASTI-Setup-<version>.exe` | Windows NSIS installer (Electron desktop app, x64) |
| `mobile/` | `BLASTI-v<version>-debug.apk` | Android **debug** APK (Capacitor, for testing — not Play-Store release) |

## How files get here

1. Every push to `master` (and every manual run from the **Actions** tab)
   triggers the `Build Installers` workflow.
2. `desktop-exe` job builds the Windows installer; `mobile-apk` job builds
   the Android debug APK.
3. A final `publish-installers` job replaces the previous files here and
   commits them with `[skip ci]` (so it never re-triggers itself).
4. Each file is also attached to the workflow run as a downloadable artifact
   (`desktop-exe`, `mobile-apk`) — kept 30 days.

## Download options

- **Latest:** grab the files directly from this folder on GitHub.
- **Per run:** Actions → *Build Installers* → pick the run → **Artifacts**.

## Manual build (local machine or VPS)

```bash
bun install

# ── Desktop .exe ──────────────────────────────────────────────
bun run build:export
cd apps/desktop
node scripts/prebuild.js
npx electron-builder --win
cp dist/BLASTI-Setup-*.exe ../../installer/desktop/

# ── Mobile debug APK ──────────────────────────────────────────
bun run --filter @blasti/mobile build:android:debug
cp BLASTI-v*-debug.apk ../../installer/mobile/
```

> **Note:** builds are unsigned (no code-signing certificate configured), so
> Windows SmartScreen / Android Play Protect may show a warning on first run.
