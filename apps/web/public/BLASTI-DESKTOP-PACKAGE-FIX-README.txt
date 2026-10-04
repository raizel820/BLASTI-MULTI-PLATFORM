====================================================================
 BLASTI DESKTOP FIX — packaged app crash "Cannot find module
 './load-env'" (+ a silent realtime fix the audit surfaced)
====================================================================

THE CRASH, EXPLAINED
--------------------
The desktop packager ships ONLY the files listed in its allowlist
(apps/desktop/electron-builder.yml -> files:). That list contained
main.js, preload.js, local-api/, etc. — but NOT load-env.js (the new
.env loader). So:

  - bun run electron:dev  → works (the real file is on disk)
  - win-unpacked / installer → CRASH at startup:
      Error: Cannot find module './load-env'

Nothing is wrong with your .env or your machine — the file simply
was never put inside the package. FIXED: load-env.js is now in the
packaging allowlist.

BONUS FIX (found by the new automatic check): the sync engine had a
typo'd require (./lib/local-realtime instead of ./local-realtime)
silently swallowed by a try/catch — realtime "new data" hints after
each pull never fired (the 30s polling masked it). FIXED in
sync-service.js.

NEW SAFETY NET: the build now runs a packaging-completeness check
(scripts/check-packaging.js) that walks every require() in the app
and FAILS THE BUILD with a clear message if any file is missing
from disk or from the packaging allowlist — this exact crash can
never ship silently again.

IMPORTANT — YOUR load-env.js IS NOT ON GITHUB YET
-------------------------------------------------
Your local folder has load-env.js (that's why dev works), but it was
never committed (it is absent from the GitHub master branch). When
you do `git add -A` below, it gets included automatically. Do NOT
skip that step.

STEP BY STEP (on your PC, where the project folder is)
------------------------------------------------------------
1. Download ALL FOUR files from the PREVIEW PANEL ("Open in New
   Tab", type the file name after the address):

   blasti-electron-builder.yml   -> apps/desktop/electron-builder.yml
   blasti-check-packaging.js     -> apps/desktop/scripts/check-packaging.js
   blasti-prebuild.js            -> apps/desktop/scripts/prebuild.js
   blasti-sync-service.js        -> apps/desktop/local-api/sync-service.js
                                    (same name as the earlier sync fix —
                                    this is the newest version, replace it)

2. Commit and push (this also publishes your local load-env.js):

      git add -A
      git commit -m "fix(desktop): package load-env.js (win-unpacked crash) + packaging completeness guard + sync realtime require path"
      git push

3. REBUILD the desktop app:

      cd apps\desktop
      bun run build:win

   (or `bun run build:portable` if you test from win-unpacked).
   During the build you should see:
      [prebuild] Packaging completeness OK (all require()d files
      exist and are allow-listed)

4. Run the NEW build from dist\win-unpacked — no crash. The app
   reads your existing .env (BLASTI_CLOUD_URL) as before.

No VPS action needed — this fix is entirely on the desktop side.

====================================================================
YOUR OTHER QUESTION — WHAT TO PUT IN THE PHONE APP .ENV
====================================================================
The phone app cannot read a .env at runtime — values are baked in
when you BUILD the APK on your PC. Create this file in your project:

   apps\web\.env.production.local

containing exactly one line:

   NEXT_PUBLIC_API_URL=http://68.183.137.227

(bare address — no port, no /api). Then rebuild the phone app:

   cd apps\mobile
   bun run build:android:debug

The app auto-connects to your VPS on first launch, remembers it, and
the login-screen "Server connection" pill stays as a manual backup.

PowerShell one-liner for step 1 (run in the project folder):

   Set-Content -Path apps\web\.env.production.local -Value "NEXT_PUBLIC_API_URL=http://68.183.137.227"
====================================================================
