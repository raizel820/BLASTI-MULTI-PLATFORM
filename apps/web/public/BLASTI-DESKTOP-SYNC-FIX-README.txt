====================================================================
 BLASTI DESKTOP FIX — "local mode" / missing admin approval
====================================================================

WHAT WAS WRONG (found in your log, all confirmed)
-------------------------------------------------
1. THE MAIN BUG — the desktop sync engine checked the cloud health at the
   WRONG ADDRESS. On your VPS, only /api/* reaches the API; the address it
   checked (/health) is answered by the WEB APP with a 404 page. So the
   engine believed "cloud offline" FOREVER while the cloud was perfectly
   healthy — that is exactly the "Running in local mode — cloud sync
   paused" banner. Because the engine was paused, the admin's subscription
   approval never PULLED down to the desktop (it worked in your browser
   because the browser talks to the cloud directly).

2. The second login unlocked your PC LOCALLY instead of logging in to the
   cloud (your password matched a saved device credential). That local
   token cannot be recognized by the cloud, and the old code then LOCKED
   the whole workspace ("Session rejected by cloud — no longer authorized").
   Fixed: when the internet is available the app now ALWAYS does a real
   cloud login; the offline unlock is only used when the cloud is truly
   unreachable. A local token can also never trigger a lock anymore.

3. Smaller fix: the desktop now catches up to refreshed session tokens
   immediately (it used to keep presenting the old one for up to 30 min).

Verified against your live server: /health really returns the web app's
404 page and /api/health returns the API's healthy answer — the fix makes
the engine look at the right one.

YOUR DATA IS SAFE — nothing was deleted; the local database is untouched.

====================================================================
STEP BY STEP (on your PC, where the project folder is)
====================================================================
The fix is in the DESKTOP APP on your PC — the VPS itself needs NO change
for this (but commit + push anyway so your repo stays the master copy and
the auto-updater keeps the webapp in sync).

1. Download ALL SIX files from the PREVIEW PANEL of this chat (open the
   preview, click "Open in New Tab", add the file name to the address):

   blasti-sync-service.js
   blasti-local-api-index.js
   blasti-session-adopt.ts
   blasti-api-client.ts
   blasti-auth-provider.tsx
   blasti-connection-status.tsx

2. Copy each one INTO YOUR PROJECT (replace the existing file):

   blasti-sync-service.js        ->  apps/desktop/local-api/sync-service.js
   blasti-local-api-index.js     ->  apps/desktop/local-api/index.js
   blasti-session-adopt.ts       ->  apps/web/src/lib/session-adopt.ts
   blasti-api-client.ts          ->  apps/web/src/lib/api-client.ts
   blasti-auth-provider.tsx      ->  apps/web/src/components/providers/auth-provider.tsx
   blasti-connection-status.tsx  ->  apps/web/src/components/shared/connection-status.tsx

3. In the project folder terminal:

      git add -A
      git commit -m "fix(desktop): cloud health probe /api/health + online logins prefer the cloud + no false workspace lock + token rotation catch-up"
      git push

   (the VPS will auto-update its copy of the webapp a couple of minutes
   after the push — nothing for you to do there)

4. RESTART the desktop app:
      - stop the running  bun run electron:dev  (Ctrl+C)
      - start it again:  bun run electron:dev

5. In the desktop app, SIGN IN WITH YOUR USERNAME + PASSWORD (do not use
   the PIN/fingerprint unlock this one time). This creates a fresh cloud
   session, clears the old "revoked" lock automatically, and resumes sync.

WHAT YOU SHOULD SEE AFTERWARDS
------------------------------
- The amber "Running in local mode — cloud sync paused" banner disappears.
- The admin's subscription approval arrives on the desktop (a pull brings
  it down within ~30 seconds, and future approvals arrive live).
- If it ever says "cloud auth required" it means you are using the offline
  unlock — sign in with the password once while online and sync resumes.

IF YOU WANT TO CHECK (optional)
------------------------------
In the terminal running electron:dev you should now see the engine going
online instead of the endless "Cloud offline, local API healthy" line.

====================================================================
