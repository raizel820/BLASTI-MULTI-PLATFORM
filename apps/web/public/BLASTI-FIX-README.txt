BLASTI — desktop cloud-URL fix + DigitalOcean guide (downloads)
================================================================

1) blasti-desktop-cloud-fix.patch  — code fix for the desktop app
2) DEPLOY-GUIDE.md                 — step-by-step DigitalOcean droplet guide

IMMEDIATE FIX (no patch needed — do this first!)
------------------------------------------------
Your .env value has a trailing "/api". The app appends /api/* itself,
so your value made it probe /api/api/health -> 404 -> "cloud unreachable".

Edit  apps\desktop\.env  and change it to the BARE ORIGIN:

    BLASTI_CLOUD_URL="http://68.183.137.227"

(only if a domain is set up later: BLASTI_CLOUD_URL="https://your-domain")

Then restart:  bun run electron:dev
Expected: [Diagnostics] cloud-api -> OK, and login works against the VPS.
If the workspace shows REVOKED/locked, log in FRESH once — a successful
cloud login clears it.

OPTIONAL HARDENING (the patch)
------------------------------
From the repo root (PowerShell, git installed):

    git pull
    git apply blasti-desktop-cloud-fix.patch
    git add -A
    git commit -m "desktop cloud-URL self-heal + banner + DO guide"
    git push

What it adds:
 - auto-corrects a trailing /api (with a loud warning)
 - startup banner: [BLASTI Desktop] Cloud API -> <url> [source: <file>]
 - root .env now read too (BLASTI_* keys only) in dev
 - renderer (session heal / browser sync) uses the same cloud URL
 - ops/Caddyfile tracked (was silently gitignored -> missing on GitHub)
 - DEPLOY-GUIDE.md + updated DEPLOYMENT.md + .env.example docs
