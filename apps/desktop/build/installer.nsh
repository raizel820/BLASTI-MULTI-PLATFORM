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

!macro customInstall
  ; ── 0.6.82 — blasti:// deep-link protocol AT INSTALL TIME ────────────────
  ; The gateway's "return to store" button must be able to bounce the payer's
  ; browser back into the desktop app (blasti://payment/result). Registration
  ; used to depend ONLY on the runtime setAsDefaultProtocolClient call (HKCU,
  ; first app launch). If the protocol was not yet registered under the
  ; current user, the browser's blasti:// navigation silently no-oped and the
  ; payer stayed on the web result page forever. Writing the same HKCU keys
  ; during installation removes that first-launch dependency; the runtime
  ; call keeps reinforcing them on every launch (exe path updates).
  ; Per-user install (perMachine: false) → HKCU is the correct hive and the
  ; uninstaller runs as the same user, so cleanup is symmetric.
  DetailPrint "Registering the blasti:// payment deep-link protocol…"
  WriteRegStr HKCU "Software\Classes\blasti" "" "URL:BLASTI"
  WriteRegStr HKCU "Software\Classes\blasti" "URL Protocol" ""
  ; electron-builder names the installed executable from `executableName`
  ; (blasti.exe); probe both spellings so a future rename cannot silently
  ; kill the payment return path.
  IfFileExists "$INSTDIR\blasti.exe" blasti_reg_exe_lower blasti_reg_exe_upper
  blasti_reg_exe_lower:
    WriteRegStr HKCU "Software\Classes\blasti\DefaultIcon" "" "$INSTDIR\blasti.exe,0"
    WriteRegStr HKCU "Software\Classes\blasti\shell\open\command" "" '"$INSTDIR\blasti.exe" "%1"'
    Goto blasti_reg_done
  blasti_reg_exe_upper:
    WriteRegStr HKCU "Software\Classes\blasti\DefaultIcon" "" "$INSTDIR\BLASTI.exe,0"
    WriteRegStr HKCU "Software\Classes\blasti\shell\open\command" "" '"$INSTDIR\BLASTI.exe" "%1"'
  blasti_reg_done:
!macroend

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

  ; 7. 0.6.82 — remove the blasti:// deep-link protocol keys written by
  ;    customInstall (HKCU\Software\Classes\blasti). The runtime
  ;    setAsDefaultProtocolClient writes the SAME keys, so deleting the key
  ;    root removes both registrations in one shot.
  DeleteRegKey HKCU "Software\Classes\blasti"
!macroend
