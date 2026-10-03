BLASTI — VPS fixes: API not starting + web opens on the login page
====================================================================

WHAT HAPPENED (two separate problems)
-------------------------------------
1) The API service (blasti-api) never started on the droplet.
   The systemd service requires the folder /opt/blasti/apps/api/uploads
   to exist, but a fresh GitHub clone does not contain it. systemd then
   refuses to start the service (mount-namespacing error). The web app
   was fine — that is why the site opened at all.

2) The web app opened on the LOGIN page instead of the home page.
   Your browser still remembers data from the OLD deployment (same IP),
   including "last screen = login". A brand-new visitor would see the
   landing page; your browser restored that stale screen.

FIX 1 — BRING THE API UP (on the droplet, takes 10 seconds)
-----------------------------------------------------------
Run these four commands over SSH:

    mkdir -p /opt/blasti/apps/api/uploads
    systemctl restart blasti-api
    sleep 5
    curl -s http://127.0.0.1:3003/api/health ; echo

Expected: a JSON line containing "status":"ok".
Then open http://68.183.137.227/api/health in your browser to confirm.

If it is NOT ok, send me this output:
    journalctl -u blasti-api -n 50 --no-pager

FIX 2 — SEE THE HOME PAGE IN YOUR BROWSER
-----------------------------------------
Quick proof first: open http://68.183.137.227 in an INCOGNITO / Private
window — you will see the landing page. That confirms the cause is
stored browser data, not the server.

To fix your normal window (Chrome or Edge):
  1. On the site, press F12 -> Application tab -> Storage ->
     Local Storage -> right-click the site -> Clear.
  2. Press Ctrl+Shift+Delete -> Time range "Last hour" ->
     Cached images and files + Cookies -> Clear data.
  3. Reload the page. You will land on the home page.

OPTIONAL HARDENING — SHIP THE PERMANENT FIXES TO GITHUB (the patch)
-------------------------------------------------------------------
blasti-vps-fixes.patch makes three changes:
  - deploy script: creates the missing uploads folder, hardens the
    systemd units, and `server-update` now also refreshes the units
    (a fresh install can never hit problem 1 again);
  - web app: browsers ALWAYS start on the landing page, even with
    stale saved data (problem 2 can never happen again for anyone);
  - adds tailwindcss-animate (removes the build warning and restores
    the shadcn animation utilities).

Download both files from the app preview panel into your repo folder
(C:\Users\Origin Systems\Downloads\TheApp\BLASTI-MULTI\BLASTI-MULTI):

    /blasti-vps-fixes.patch
    /BLASTI-VPS-FIX-README.txt   (this file)

Then in PowerShell, from the repo folder:

    git pull
    git apply blasti-vps-fixes.patch
    git add -A
    git commit -m "fix: VPS API startup + web always boots on landing page"
    git push

(The patch was tested to apply cleanly on the current GitHub master.
bun.lock is intentionally not in the patch: run `bun install` once, or
just let the droplet do it during server-update.)

AFTER PUSHING — UPDATE THE DROPLET (pulls the fixes from GitHub)
----------------------------------------------------------------
    cd /opt/blasti
    bash scripts/deploy-digitalocean.sh server-update

This pulls the latest code from GitHub, rebuilds the web app
(2-4 minutes) and restarts api + web + caddy.

REMINDERS
---------
- Desktop app .env must stay the BARE origin (no /api at the end):
      BLASTI_CLOUD_URL="http://68.183.137.227"
- Log in and CHANGE the default passwords:
      admin / admin123   (platform super-admin)
      owner / owner123   (agency owner)
