====================================================================
 BLASTI - GitHub AUTO-UPDATER (the droplet updates itself)
====================================================================

WHAT THIS IS
------------
You asked: "shouldn't there be a GitHub watcher for auto-updates?"
Yes - and now there is one, built in. From now on:

    git push   ->   about 2 minutes later the droplet has pulled,
                    rebuilt and restarted ALL BY ITSELF.

No more ssh + server-update by hand after every change.

A watcher script already existed in the repo (scripts/watch-and-deploy.sh)
but nothing on the droplet ever RAN it. These two updated files fix that:
the deploy script now installs a systemd timer (blasti-watcher.timer) that
checks GitHub every 2 minutes and deploys new commits automatically.

THE TWO FILES IN THIS DELIVERY
------------------------------
1. blasti-deploy-digitalocean.sh
   -> REPLACE  scripts/deploy-digitalocean.sh  in your project.
   New: "server-watch-install" / "server-watch-disable" commands, the
   auto-updater is armed automatically by install/update, and a shared
   lock makes sure the watcher and a manual update NEVER run at the same
   time (important on your small 512 MB droplet).

2. blasti-watch-and-deploy.sh
   -> REPLACE  scripts/watch-and-deploy.sh  in your project.
   New: only SUCCESSFUL updates are remembered - a failed build is never
   forgotten, it retries after 30 minutes (or immediately when your next
   commit lands), and the site keeps running the previous working build.

--------------------------------------------------------------------
STEP BY STEP - on your own computer (where the project folder is)
--------------------------------------------------------------------
1. Download both files from the PREVIEW PANEL of this chat (open the
   preview, click "Open in New Tab", then add the file name at the end
   of the address, e.g.  .../blasti-deploy-digitalocean.sh):

      blasti-deploy-digitalocean.sh
      blasti-watch-and-deploy.sh

2. Put them in the project folder:
      - replace  scripts/deploy-digitalocean.sh  with file 1
      - replace  scripts/watch-and-deploy.sh     with file 2

3. Open a terminal in the project folder and run:
      git add scripts/deploy-digitalocean.sh scripts/watch-and-deploy.sh
      git commit -m "ops: built-in GitHub auto-updater (systemd timer)"
      git push

--------------------------------------------------------------------
STEP BY STEP - on the droplet (ONE TIME ONLY, after the push)
--------------------------------------------------------------------
4. ssh into the droplet (same as when you installed), then run:

      curl -fsSL https://raw.githubusercontent.com/raizel820/BLASTI-MULTI-PLATFORM/master/scripts/deploy-digitalocean.sh -o blasti-deploy.sh

      bash blasti-deploy.sh server-watch-install

   The second command only switches the auto-updater on - it does NOT
   rebuild anything, so it finishes in a second or two and ends with:
      [  ok  ] auto-updater armed (blasti-watcher.timer) ...

WHAT HAPPENS FROM NOW ON
------------------------
- Every  git push  deploys itself within ~2 minutes. Nothing else to do.
- Watch it live on the droplet:
      journalctl -u blasti-watcher.service -f
- Check that it is on:
      systemctl status blasti-watcher.timer
- Turn it OFF (back to manual updates):
      bash /opt/blasti/scripts/deploy-digitalocean.sh server-watch-disable
- Turn it back ON:
      bash /opt/blasti/scripts/deploy-digitalocean.sh server-watch-install
- It also appears in the health report:
      bash blasti-deploy.sh server-doctor

GOOD TO KNOW
------------
- Safe by design: an auto-update NEVER touches your database, the uploaded
  files or /etc/blasti/blasti.env (secrets).
- Whatever you push to "master" goes live automatically. Push small,
  tested commits. If a push breaks the site, just push the fix - or turn
  the watcher off first with the disable command above.
- The watcher cannot collide with you: if a manual server-update is
  running, the watcher simply waits for the next 2-minute cycle.

====================================================================
