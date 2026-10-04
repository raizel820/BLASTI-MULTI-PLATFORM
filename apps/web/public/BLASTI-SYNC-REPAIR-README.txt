====================================================================
 BLASTI SYNC REPAIR (round 2) — banner + admin replies + stuck queue
====================================================================

WHAT WAS STILL WRONG (proven from your latest log — the engine was online,
but 4 separate defects hid it / blocked the data):

1. THE ADMIN'S TICKET REPLY NEVER LEFT THE CLOUD.
   The cloud change-feed DROPPED every SupportTicket update (a routing
   table was missing the SupportTicket entry), so the reply your admin
   wrote could never reach the desktop — no amount of desktop retries
   could help. FIXED cloud-side: ticket updates now flow to the owning
   agency's desktops.

2. THE SUBSCRIPTION APPROVAL WAS STUCK IN A FOREIGN-KEY LOOP
   ("deferredPending: 1" + "FOREIGN KEY constraint failed" every cycle).
   The approval row carried the ADMIN's user id, but admin users are
   never synced to desktops — so the row could never be applied, and the
   page it arrived in was (wrongly) marked as fully applied, hiding it
   from every future re-fetch. FIXED on both sides:
   - cloud no longer ships the reviewer id on Transaction rows;
   - desktop strips it when applying (this un-sticks the row already
     parked on your PC), stops marking half-applied pages, and can
     un-strand pages marked by older builds automatically.

3. THE AMBER "RUNNING IN LOCAL MODE — CLOUD SYNC PAUSED" BANNER LIED.
   It was driven by the renderer's own 1.5s-timeout probe (which poisons
   itself after one hiccup) instead of the sync engine's real verdict.
   That is why it stayed amber while the app ALSO said "connected to the
   server". FIXED: in the desktop app the banner now follows the sync
   engine's verdict (socket + pulls, measured in the main process).

4. TWO DIAGNOSTIC TEST MUTATIONS RETRIED FOREVER ("Mutation replay:
   0 succeeded, 2 failed"). The startup diagnostic creates its test
   service directly in the local DB (never synced), so its test
   reservation is an orphan on the cloud — rejected with a foreign-key
   error, retried forever. FIXED: FK-rejected mutations become permanent
   after 3 tries, and the diagnostic now cleans up its test rows in the
   correct order (reservation first).

YOUR DATA IS SAFE — nothing was deleted; the local database is untouched.

====================================================================
STEP BY STEP (on your PC, where the project folder is)
====================================================================

1. Download ALL FIVE files from the PREVIEW PANEL of this chat (open the
   preview, click "Open in New Tab", add the file name to the address):

   blasti-sync-helpers.ts        (cloud API  — the admin-reply fix)
   blasti-initial-sync.ts        (cloud API  — same fix, import path)
   blasti-sync-service.js        (desktop    — stuck-queue + FK fixes)
   blasti-loading-screen.js      (desktop    — diagnostics cleanup)
   blasti-connection-status.tsx  (renderer   — honest banner)

2. Copy each one INTO YOUR PROJECT (replace the existing file):

   blasti-sync-helpers.ts        ->  apps/api/src/lib/sync-helpers.ts
   blasti-initial-sync.ts        ->  apps/api/src/routes/initial-sync.ts
   blasti-sync-service.js        ->  apps/desktop/local-api/sync-service.js
   blasti-loading-screen.js      ->  apps/desktop/loading-screen.js
   blasti-connection-status.tsx  ->  apps/web/src/components/shared/connection-status.tsx

3. In the project folder terminal:

      git add -A
      git commit -m "fix(sync): deliver admin ticket replies to desktops + unstick FK-deferred approvals + honest cloud banner"
      git push

4. ON THE DROPLET (this fix changes the CLOUD API, so a rebuild is
   required this one time — the auto-updater will do it automatically
   within ~2 minutes of your push IF it is armed; otherwise run):

      git -C /opt/blasti pull
      bash /opt/blasti/scripts/deploy-digitalocean.sh server-update
      bash /opt/blasti/scripts/deploy-digitalocean.sh server-doctor

5. RESTART the desktop app:
      - stop the running  bun run electron:dev  (Ctrl+C)
      - start it again:  bun run electron:dev
   (no need to re-login — your session is fine)

WHAT YOU SHOULD SEE AFTERWARDS
------------------------------
- The amber "Running in local mode" banner is GONE (it now follows the
  engine, which your log proves is online).
- Within ~1 minute of the restart, the console should show the stuck
  change resolving — either "Deferred retry pass: 1 resolved" or
  "Deferred change UN-STRANDED ... page will re-deliver" followed by a
  pull that applies it. deferredPending drops to 0.
- The two poisoned test mutations stop after
  "marking PERMANENT (parent record will never be pushed)" — that is
  expected and correct (they were diagnostic leftovers).
- Ask your admin to reply to a ticket AGAIN (replies written before the
  cloud fix were dropped at the source and cannot be recovered). The new
  reply arrives on the desktop within ~30 seconds.

IF YOU WANT TO CHECK (optional)
------------------------------
In the electron terminal, the healthy pattern looks like:

   [SyncService] Pulling from cloud ... sinceSequence: N
   [SyncService] Pull applied: 1, conflicts: 0, ... deferredPending: 0
   [SyncService] Realtime socket connected: ...

and the banner area should show the normal/online state, not amber.
====================================================================
