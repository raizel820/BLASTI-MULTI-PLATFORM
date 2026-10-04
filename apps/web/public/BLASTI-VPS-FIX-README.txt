BLASTI — droplet API fix ("Bad Gateway" on login) — one sequence
=================================================================

WHAT I VERIFIED FROM HERE
-------------------------
I probed your droplet directly:
    http://68.183.137.227/             -> 200 OK   (web app is UP)
    http://68.183.137.227/api/health   -> 502      (API is DOWN)
Caddy and the web app are fine. Only the blasti-api service is not
running, which is exactly why logging in gives "Bad Gateway".

WHY IT IS STILL DOWN
--------------------
Your GitHub push arrived (master now contains all the fixes) — good
job! But the DROPLET still runs the OLD service setup: its systemd
unit still requires the missing uploads folder, and re-running the
old script copy cannot install the new unit (a running bash script
keeps its old code even after the repo is updated).

THE FIX — paste this on the droplet (5-10 minutes, mostly the build)
--------------------------------------------------------------------
    cd /opt/blasti
    curl -fsSL https://raw.githubusercontent.com/raizel820/BLASTI-MULTI-PLATFORM/master/scripts/deploy-digitalocean.sh -o blasti-deploy.sh
    bash blasti-deploy.sh server-update

This re-downloads the FIXED script fresh from GitHub, then:
    - pulls the latest code (already up to date)
    - creates the missing apps/api/uploads folder
    - installs the corrected systemd units
    - rebuilds the web app (2-4 minutes on your droplet)
    - restarts api + web + caddy and waits for the health check

Expected ending:
    [  ok  ] API is healthy
    ============================================================
     BLASTI is UP on this droplet. ...

THEN IN YOUR BROWSER
--------------------
1. http://68.183.137.227/api/health  -> should show JSON with "status".
2. Open the site in an INCOGNITO window: the HOME page now appears
   (the login-screen problem is fixed in this build).
3. For your normal window: F12 -> Application -> Local Storage ->
   right-click the site -> Clear, then reload.
4. Log in (admin/admin123 or owner/owner123) — CHANGE these passwords.

IF IT STILL SAYS "API did not become healthy"
---------------------------------------------
Run this on the droplet and paste me the COMPLETE output:

    cd /opt/blasti
    git fetch origin master && git reset --hard origin/master
    mkdir -p apps/api/uploads
    systemctl daemon-reload
    systemctl restart blasti-api
    sleep 6
    echo "── health ──"; curl -s -m 5 http://127.0.0.1:3003/api/health; echo
    echo "── version ──"; git log --oneline -1
    echo "── status ──"; systemctl status blasti-api --no-pager | head -12
    echo "── logs ──"; journalctl -u blasti-api -n 30 --no-pager | tail -30
    echo "── memory ──"; free -m | head -2

(NOTE: once this script reaches GitHub via your next push, the same
report is one command:  bash blasti-deploy.sh server-doctor)

REMINDERS
---------
- Desktop .env keeps the BARE origin (no /api at the end):
      BLASTI_CLOUD_URL="http://68.183.137.227"
- The script now also has a `server-doctor` mode for future debugging.
