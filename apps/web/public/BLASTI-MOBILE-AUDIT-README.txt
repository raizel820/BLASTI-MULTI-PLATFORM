====================================================================
 BLASTI MOBILE (PHONE APP) AUDIT — emulator + real phone
====================================================================
Task 70. Your phone app is a Capacitor wrapper around the same web
app — so the cloud-side fixes you already installed (admin ticket
replies, subscription approvals) ALSO protect phones. But the audit
found 6 phone-only problems. All are fixed below; 3 of them would
have made real phones fail against your VPS in exactly the same way
the desktop did.

WHAT WAS WRONG (phone against the VPS http://68.183.137.227)
------------------------------------------------------------
1. THE VPS REJECTED THE PHONE'S ORIGIN (would block EVERYTHING).
   Your VPS allows one web origin (its own IP). An Android phone app
   presents the origin "https://localhost" — which was on NEITHER the
   REST allow-list NOR the realtime-socket allow-list. Result: on a
   real Android phone every API call dies at CORS and the realtime
   socket handshake is refused, while a desktop browser works fine.
   FIXED cloud-side (apps/api/src/index.ts): "https://localhost" is
   now allowed for both REST and sockets. IMPORTANT: this changes
   the cloud API — after pushing, re-run server-update on the VPS.

2. TYPING YOUR VPS ADDRESS INTO THE PHONE'S SERVER DIALOG WAS
   BOOBY-TRAPPED. The app silently appended ":3003" to any address
   typed without a port — "http://68.183.137.227" became
   "http://68.183.137.227:3003", a port your VPS does NOT expose
   (only port 80 is public). The phone then said "server not found"
   forever. FIXED (native-cloud-resolver.ts): the app now probes the
   address AS TYPED (port 80, through Caddy) AND the :3003 variant,
   and adopts whichever really answers. Both LAN PCs and the VPS
   work from the same dialog.

3. RELEASE (SIGNED/STORE) BUILDS COULD NOT REACH THE HTTP VPS AT
   ALL. Android's release network policy forbids all cleartext HTTP,
   and the WebView "allowMixedContent" flag cannot override that.
   Debug APKs were exempt — which is why emulator/USB testing passed
   but a real release would fail. FIXED (release
   network_security_config.xml): one narrow, temporary exception for
   your VPS IP. Remove it once the server has a domain + HTTPS.

4. OFFLINE QUEUE REPLAYS WENT TO THE PHONE ITSELF. Queued
   operations (offline reservations, kiosk joins) were posted to the
   app bundle's own origin instead of the cloud on phones — silently
   failing. FIXED (offline-queue.ts): phones now use the resolved
   cloud URL.

5. REALTIME GAVE UP AFTER 5 TRIES on phones. After a network flap
   (elevator, tunnel, Wi-Fi to mobile data) the socket never
   reconnected until the screen was reopened. FIXED
   (use-realtime.tsx): once a server URL is resolved, phones retry
   forever, like the web and desktop apps.

6. PUSH NOTIFICATIONS WERE DEAD DESPITE A REAL FIREBASE PROJECT.
   google-services.json sat in android/ but the build reads it from
   android/app/. One copy fixes it (no download needed — see step 2
   below). Until now the app silently skipped FCM registration.

ALREADY GOOD (no changes needed)
--------------------------------
- The health probe and the honest connection banner: the Task 69
  fix (5-second budget, two-strike rule) applies to phones too.
- The admin ticket-reply feed and subscription-approval fixes are
  cloud-side — phones benefit automatically.
- Emulator and real phone share the same resolution logic; the
  emulator additionally reaches a dev PC via 10.0.2.2 as before.
- iOS is NOT built (no ios/ folder exists) — nothing to audit there.

STEP BY STEP (on your PC, where the project folder is)
------------------------------------------------------------
1. Download ALL FIVE files from the PREVIEW PANEL ("Open in New
   Tab", type the file name after the address):

   blasti-api-index.ts                    -> apps/api/src/index.ts
   blasti-native-cloud-resolver.ts        -> apps/web/src/lib/native-cloud-resolver.ts
   blasti-use-realtime.tsx                -> apps/web/src/hooks/use-realtime.tsx
   blasti-offline-queue.ts                -> apps/web/src/lib/offline-queue.ts
   blasti-release-network-security-config.xml
                                          -> apps/mobile/android/app/src/release/res/xml/network_security_config.xml

2. NO DOWNLOAD NEEDED — in your project folder, copy the Firebase
   config one level deeper (this enables push notifications):

   Windows:  copy apps\mobile\android\google-services.json
                  apps\mobile\android\app\google-services.json
   Mac/Linux: cp apps/mobile/android/google-services.json
                   apps/mobile/android/app/google-services.json

3. Commit and push:

      git add -A
      git commit -m "fix(mobile): phone audit — allow Android shell origin on cloud, VPS server dialog, release cleartext, offline replay, realtime retry, FCM config path"
      git push

4. ON THE VPS (fix #1 changes the cloud API — rebuild required):

      git -C /opt/blasti pull
      bash /opt/blasti/scripts/deploy-digitalocean.sh server-update

5. REBUILD THE PHONE APP (the APK must be rebuilt to pick these up):

      cd apps/mobile
      bun run build:android:debug      (or build:android:release + signing)

   Then install the APK on the phone / run on the emulator.
   (Scripts: scripts/gradle.js also copies the APK to the repo root
   as BLASTI-v<version>-<variant>.apk.)

6. ON THE PHONE: open the app; on the login screen tap the server
   pill and type  http://68.183.137.227  — exactly that, no port.
   It should confirm "Connected to 68.183.137.227". Log in.

WHAT YOU SHOULD SEE
-------------------
- Login works on the real phone (not just the emulator).
- Admin ticket replies arrive on the phone within ~30 seconds
  (realtime socket now passes the origin check).
- Offline-created reservations reach the cloud when back online.
- Push notifications register once the app is rebuilt (Firebase).
- On the VPS terminal, the API log should no longer show
  "Rejected connection from origin: https://localhost".

NOTE ON SECURITY
----------------
Fix #3 adds a temporary cleartext exception for your VPS IP. When
you later give the server a domain (the deploy script's --domain
mode gives free auto-HTTPS via Caddy), delete that exception block
— it is clearly marked in the file.
====================================================================
