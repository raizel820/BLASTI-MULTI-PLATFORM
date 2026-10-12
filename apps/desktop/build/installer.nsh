; BLASTI Desktop — NSIS uninstall hook (Task 2-b-1)
; ─────────────────────────────────────────────────────────────────────────────
; USER BUG: "when uninstall the app, delete all local stored data so a new
; install will not reopen old offline sessions."
;
; `nsis.deleteAppDataOnUninstall: true` (electron-builder.yml) already removes
; the PACKAGED userData dir (%APPDATA%\BLASTI). This hook additionally wipes
; every OTHER directory the app ever wrote data into, so a re-install always
; starts from a truly clean slate.
;
; ── COMPLETE INVENTORY OF DISCOVERED DATA PATHS (evidence) ──────────────────
;
; 1. %APPDATA%\BLASTI\                          — PACKAGED userData
;    (Electron app.name = productName "BLASTI" from electron-builder.yml)
;    • blasti-local\local.db (+ .db-wal/.db-shm) — the authoritative local
;      SQLite DB (main.js setAuthoritativeDbPath → <userData>\blasti-local;
;      local-api/lib/db.js: "BLASTI_LOCAL_DB_DIR … <userData>/blasti-local").
;      THIS is the offline session DB the bug report is about.
;    • blasti-files\            — local file store (main.js
;      setAuthoritativeFilesDir → <userData>\blasti-files; mirrored to cloud
;      by local-api/lib/file-sync.js).
;    • logs\main.log            — file logger (main.js initFileLogger).
;    • blasti-auth.json         — durable remember-me session file
;      (main.js authFilePath → <userData>\blasti-auth.json).
;
; 2. %APPDATA%\@blasti\desktop\                 — DEV-run userData
;    (electron . --dev resolves app.name from package.json "name"
;    "@blasti/desktop" — no productName at dev time; see main.js comment
;    "%APPDATA%/@blasti/desktop/blasti-local/local.db on Windows").
;
; 3. %LOCALAPPDATA%\BLASTI\                     — Chromium/OS-side leftovers
;    (Crashpad reports, GPU cache variants; also the historical Squirrel-style
;    per-user app-data location).
;
; 4. %LOCALAPPDATA%\@blasti\desktop\            — dev variant of (3).
;
; 5. %LOCALAPPDATA%\@blastidesktop-updater\     — electron-updater download
;    %LOCALAPPDATA%\blasti-desktop-updater\       cache (electron-builder
;    %LOCALAPPDATA%\BLASTI-updater\               derives the cache dir name
;    from the package/app name — all three spellings wiped, non-existent ones
;    are no-ops).
;
; 6. %USERPROFILE%\.blasti\                     — LEGACY pre-v2 local data
;    • .blasti\local\local.db — the pre-v2 lib/db.js default DB location
;      (~/.blasti/local; the startup migration copies it into userData —
;      removing it prevents an old DB being re-adopted by a fresh install).
;    • .blasti\files\         — legacy file-store fallback
;      (lib/file-store.js resolves BLASTI_LOCAL_FILES_DIR → ~/.blasti/files).
;    • .blasti\test-sync\     — legacy test DB dir.
;
; The per-user uninstaller runs AS the user, so $APPDATA, $LOCALAPPDATA and
; $PROFILE all resolve to that user's real directories. `RMDir /r` on a
; non-existent directory is a silent no-op, so every line is unconditional.
; The install dir itself ($INSTDIR, incl. the packaged resources\data seed DB)
; is removed by electron-builder's own uninstaller code — not duplicated here.
; ─────────────────────────────────────────────────────────────────────────────

!macro customUnInstall
  DetailPrint "Removing all BLASTI local data (offline sessions, local DB, files, logs)…"

  ; 1. Packaged userData (belt-and-braces — deleteAppDataOnUninstall also
  ;    targets this; a second RMDir is free and future-proofs the flag).
  RMDir /r "$APPDATA\BLASTI"

  ; 2. Dev-run userData + its now-empty scoped parent.
  RMDir /r "$APPDATA\@blasti\desktop"
  RMDir    "$APPDATA\@blasti"

  ; 3. LOCALAPPDATA packaged leftovers.
  RMDir /r "$LOCALAPPDATA\BLASTI"

  ; 4. LOCALAPPDATA dev leftovers + scoped parent.
  RMDir /r "$LOCALAPPDATA\@blasti\desktop"
  RMDir    "$LOCALAPPDATA\@blasti"

  ; 5. electron-updater caches (name-derived spellings).
  RMDir /r "$LOCALAPPDATA\@blastidesktop-updater"
  RMDir /r "$LOCALAPPDATA\blasti-desktop-updater"
  RMDir /r "$LOCALAPPDATA\BLASTI-updater"

  ; 6. Legacy ~/.blasti data (old DB default + legacy file store).
  RMDir /r "$PROFILE\.blasti"
!macroend
