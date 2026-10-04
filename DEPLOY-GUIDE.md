# BLASTI — Step-by-Step DigitalOcean VPS Deployment Guide

**For everyone — no developer experience required.** This guide takes you
from *"I have a DigitalOcean account"* to *"BLASTI is live on my own VPS,
pulled straight from GitHub, and my desktop app talks to it."*

Just copy-paste the commands exactly as shown. Every step explains what it
does and what you should see.

> **How the app is deployed (the short version):**
> Docker on the VPS runs **only ONE container: PostgreSQL (the database)**.
> Everything else — the API, the web app and the HTTPS gateway — runs
> natively on the server as **system services** that start on boot and
> restart on crash. The code is **pulled from your GitHub repository** —
> nothing is uploaded by hand.

---

## Part 0 — What you will end up with (30 seconds)

```
                        Internet
                            │
              ┌─────────────▼──────────────────┐
              │   DigitalOcean Droplet (VPS)   │
              │                                │
              │   Caddy  :80 / :443            │  ◀── the ONLY public door
              │     ├─ /api/*        ─────┐    │      (automatic HTTPS)
              │     ├─ /socket.io/* ──────┤    │
              │     └─ everything else ──┐│    │
              │                          ││    │
              │   blasti-web  :3000 ◀────┘│    │  systemd service (Next.js)
              │   blasti-api  :3003 ◀─────┘    │  systemd service (Bun)
              │          │                     │
              │   ┌──────▼───────────────┐      │
              │   │ Docker: blasti-db    │      │  ← the ONLY container
              │   │ PostgreSQL 127.0.0.1:5432   │
              │   └──────────────────────┘      │
              └────────────────────────────────┘
        ▲                                      ▲
        │ browser / phone browser              │ desktop app (login, sync, realtime)
        └── http://YOUR-IP  or  https://your-domain
                                  BLASTI_CLOUD_URL="http://YOUR-IP"   ← no /api!
```

| Piece | What it is | How it runs | Port |
|---|---|---|---|
| **Caddy** | HTTPS gateway (padlock 🔒) | native service (`systemd`) | 80, 443 — public |
| **blasti-api** | BLASTI backend (Hono + Socket.IO) | native service, **Bun** | 3003 — localhost only |
| **blasti-web** | BLASTI web app (Next.js) | native service, **Node** | 3000 — localhost only |
| **blasti-db** | PostgreSQL 16 database | **Docker — the only container** | 5432 — localhost only |

Everything is installed for you by **one script**: `scripts/deploy-digitalocean.sh`
(it is part of the GitHub repo — the server downloads it itself).

---

## Part 1 — What you need

| # | Requirement | Notes |
|---|---|---|
| 1 | A DigitalOcean account | [digitalocean.com](https://www.digitalocean.com) — sign up, add a payment method |
| 2 | Your computer | Windows 10/11 (use **PowerShell**), macOS or Linux (use **Terminal**) |
| 3 | The BLASTI GitHub repo | `https://github.com/raizel820/BLASTI-MULTI-PLATFORM` (public — no GitHub login needed on the server) |
| 4 | A domain name *(optional but recommended)* | Needed for automatic HTTPS. You can start with just the IP |
| 5 | 30–45 minutes | Most of it is unattended installing/building |

**Recommended droplet:** Basic plan → Regular CPU → **4 GB RAM / 2 vCPU**
(~$18/month). Smaller 2 GB droplets work too (the installer adds swap
memory automatically), but 4 GB builds noticeably faster.

---

## Part 2 — Create the droplet (on the DigitalOcean website)

1. Log in at [cloud.digitalocean.com](https://cloud.digitalocean.com).
2. Click the green **Create** button (top right) → **Droplets**.
3. **Choose Region** — pick the region closest to your users
   (e.g. *Frankfurt* for Europe, *New York* for the Americas).
4. **Choose an Image** — under *OS* select **Ubuntu 24.04 (LTS) x64**.
5. **Choose Size** — *Shared CPU → Basic → Regular* → **4 GB / 2 vCPU**.
6. **Choose Authentication Method:**
   - **Password** (easiest for beginners): choose a **strong root password**
     and save it somewhere safe. DigitalOcean emails it to you as well.
   - **SSH Key** (more convenient later): upload your key if you have one.
7. **Hostname:** change to `blasti` (nice to recognise it later).
8. Click **Create Droplet**.
9. Wait ~60 seconds until the droplet shows **green "Active"**.
10. **Write down the droplet's IP address** (shown next to the droplet name,
    e.g. `203.0.113.10`). You will use it constantly.

> 💡 If a firewall prompt appears on the creation screen, you can skip it —
> the installer configures the server's own firewall for you.

---

## Part 3 — Connect to the droplet (first time)

**Windows:** click Start, type **PowerShell**, press Enter, then type
(replace `203.0.113.10` with YOUR droplet IP):

ssh-keygen -R 68.183.137.227
```
ssh root@68.183.137.227
```

**macOS / Linux:** open **Terminal** and type the same command.

- First time only, you will see a fingerprint question — type `yes` and Enter.
- With **password auth**: type the root password (nothing appears while
  typing — that is normal) and press Enter.
- ✅ Success looks like: the prompt changes to something like
  `root@blasti:~#`. You are now "inside" the server. All commands in the
  next Part are typed there.

---

## Part 4 — Install BLASTI (one shot, from GitHub)

Stay inside the ssh session (`root@blasti:~#`). A fresh droplet has no
curl/git/node/bun — **the installer adds everything itself**. Copy-paste
these **two commands**, one at a time:

**Command 1 — download the installer from GitHub:**

```bash
curl -fsSL https://raw.githubusercontent.com/raizel820/BLASTI-MULTI-PLATFORM/master/scripts/deploy-digitalocean.sh -o blasti-deploy.sh
```

**Command 2 — run it:**

```bash
bash blasti-deploy.sh server-install
```

That's it. The installer now runs unattended for roughly **8–15 minutes**
(installing Docker, Bun, Node, Caddy, cloning the code from GitHub, building
the web app). You will see `[deploy]` progress lines the whole time.

> ✅ **Success looks like** a box at the end that says **"BLASTI is UP on
> this droplet"** with your web address. Open that address in your browser —
> you should see the BLASTI login page.
>
> ❌ If a line ends with `[FAIL]`, note the message and jump to Part 12
> (Troubleshooting).

### Alternative: run the installer from your own computer

If you have a copy of the repo on your own machine and prefer to trigger
everything remotely (works from Windows PowerShell too):

```bash
git clone https://github.com/raizel820/BLASTI-MULTI-PLATFORM.git blasti
cd blasti
./scripts/deploy-digitalocean.sh install root@203.0.113.10
```

This connects to the droplet over ssh and performs **exactly the same
install** (the code still comes from GitHub, not from your machine).
If your droplet uses password auth, ssh asks for it once.

---

## Part 5 — What the installer did (plain English)

1. Added **2 GB swap** if the droplet has under 4 GB RAM (build headroom).
2. Installed **Docker** — used **only** to run the PostgreSQL container.
3. Installed **Bun** (runs the API) and **Node.js 22** (runs the web app).
4. Installed **Caddy** — the HTTPS gateway on ports 80/443.
5. Turned on the **firewall**: only ssh (22), HTTP (80) and HTTPS (443) are
   reachable. The database and both app services are **localhost-only**.
6. Created the **environment file** `/etc/blasti/blasti.env` with **random
   secrets** (see Part 6).
7. **Cloned your GitHub repo** to `/opt/blasti`.
8. Started **one Docker container**: `blasti-db` (PostgreSQL 16, data stored
   in a Docker volume that survives restarts and updates).
9. Created the database tables and seeded the default accounts (only when
   the database is empty — your data is never wiped by updates).
10. Built the web app (`next build`) and registered two **system services**:
    `blasti-api` and `blasti-web` — they start on boot and restart on crash.
11. Rendered `/etc/caddy/Caddyfile` and started Caddy with **automatic
    HTTPS** (once a domain points here).
12. Waited until `GET /api/health` answered OK.

---

## Part 6 — .env configurations (all of them, in one place)

BLASTI uses **three small configuration files**. Only the first one lives on
the VPS; the other two live where the app runs (your Windows PC / phone).

### 6.1 Server: `/etc/blasti/blasti.env` (the VPS environment file)

Created **automatically** with random secrets. It is the single place that
configures the database container, the API and the web app on the VPS.

**View it** (on the server):

```bash
cat /etc/blasti/blasti.env
```

**What it looks like after a fresh install** (your values differ):

```bash
# ══════════════════════════════════════════════════════════════
# BLASTI VPS environment - generated by deploy-digitalocean.sh
# ══════════════════════════════════════════════════════════════

# ── PostgreSQL (the ONLY Docker container) ─────────────────────
POSTGRES_USER=blasti
POSTGRES_PASSWORD=9f2c4ba71d0e8a63c5f7...      # random - keep private
POSTGRES_DB=blasti

# ── Database URL used by the API + Prisma CLI ──────────────────
DATABASE_URL=postgresql://blasti:9f2c4ba7...@127.0.0.1:5432/blasti?schema=public

# ── Security secrets ───────────────────────────────────────────
NEXTAUTH_SECRET=4be21d0c9f7a8b6355e0c1...     # signs login sessions
INTERNAL_SECRET=77c0ffa1b2e34d5589aa0f...     # API-to-API trust
CRON_SECRET=52aa0be17c3d94f6bb12e0a1f...      # maintenance endpoint

# ── Networking (all app ports bind to localhost only) ──────────
API_PORT=3003
HOST=127.0.0.1
WEB_PORT=3000
INTERNAL_API_URL=http://127.0.0.1:3003
API_PROXY_URL=http://127.0.0.1:3003

# ── Public address (set by the installer; --domain updates it) ─
SITE_ADDRESS=:80                          # ← becomes https://your-domain
CORS_ORIGIN=http://203.0.113.10           # ← becomes https://your-domain
ALLOWED_ORIGINS=http://203.0.113.10       # ← becomes https://your-domain
```

**Variable reference:**

| Variable | Meaning | Change it when… |
|---|---|---|
| `POSTGRES_USER` / `POSTGRES_DB` | Database login + database name | Never (keep `blasti`) |
| `POSTGRES_PASSWORD` | Database password (random) | Never — regenerate only on a full reset |
| `DATABASE_URL` | Full database address — must match the three lines above | Never edit alone (keep it in sync with the password) |
| `NEXTAUTH_SECRET` | Session-signing key (random) | Never |
| `INTERNAL_SECRET` | Trust secret between BLASTI components | Never |
| `CRON_SECRET` | Protects the maintenance endpoint | Never |
| `API_PORT` / `HOST` | Where the API listens — `127.0.0.1` = not reachable from outside | Never |
| `WEB_PORT` | Where the web app listens | Never |
| `INTERNAL_API_URL` / `API_PROXY_URL` | How the web app reaches the API internally | Never |
| `SITE_ADDRESS` | The public door Caddy opens: `:80` (IP, HTTP) or `https://your-domain` | When adding/changing the domain — or just re-run `update --domain` |
| `CORS_ORIGIN` / `ALLOWED_ORIGINS` | Which origins may call the API | Automatically updated together with the domain |

**Editing it safely** (on the server):

```bash
nano /etc/blasti/blasti.env      # edit: arrows to move, Ctrl+O then Enter to save, Ctrl+X to exit
systemctl restart blasti-api blasti-web   # apply the change
```

> ⚠️ The file is `chmod 600` (root-only) and lives **outside the repo** —
> git updates never touch it, and it is never committed anywhere.

### 6.2 Desktop app: `apps/desktop/.env` (on your Windows PC)

The desktop app is local-first: it works offline and uses your VPS **only
for login, cloud sync and realtime**. One variable points it at the VPS.

Create or edit the file `apps/desktop/.env` inside your local BLASTI folder:

```bash
BLASTI_CLOUD_URL="http://203.0.113.10"
```

> ### ⚠️ The value must be the bare origin — NEVER add `/api`
> The app adds `/api/...` paths **itself**. Adding the suffix yourself
> doubles it and breaks the connection (`/api/api/health` → 404):
>
> ```
> ✅ BLASTI_CLOUD_URL="http://203.0.113.10"        ← raw IP (testing)
> ✅ BLASTI_CLOUD_URL="https://your-domain.com"    ← domain + HTTPS (production)
> ❌ BLASTI_CLOUD_URL="http://203.0.113.10/api"    ← DO NOT — double /api
> ```

Recent builds **auto-correct** a trailing `/api` and print a warning, but
write the correct value anyway.

**Where the app looks for the variable** (first match wins):

1. `apps/desktop/.env` — the dedicated desktop file (recommended)
2. Project root `.env` — only `BLASTI_*` keys are read from it
3. OS environment variable — overrides both files

**For the installed .exe** (no rebuild needed): edit (or create) this file
with Notepad, then restart the app:

```
%LOCALAPPDATA%\Programs\BLASTI\resources\.env
```

**Verify inside the app:** start it with `bun run electron:dev` and check
the startup line — it is the ground truth of what will be used:

```
[BLASTI Desktop] Cloud API → http://203.0.113.10  [source: …apps\desktop\.env]
```

✅ That line + a successful login = the desktop is talking to YOUR droplet.
❌ `[source: built-in default — NO cloud URL configured]` = the file/variable
name is wrong (the banner lists every location it checked).

> The first login imports ("initial-sync") your workspace from the VPS, so
> the VPS must be reachable **before** the first login succeeds. If a
> previous wrong URL locked the workspace (REVOKED), fixing the URL and
> logging in fresh clears it.

### 6.3 Web app build: `NEXT_PUBLIC_API_URL` (leave it EMPTY on the VPS)

This variable is **baked into the web bundle at build time**. On the VPS the
installer explicitly builds with `NEXT_PUBLIC_API_URL=""` (empty) so the
browser calls the API **same-origin** (`/api/*` on your own domain) and
Caddy routes it to the internal API. You never need to touch this — it is
listed here so you know why it must stay empty for VPS deployments.
(It is only used non-empty for phone/emulator builds.)

### 6.4 PostgreSQL container: `ops/postgres.compose.yml`

The database container reads `POSTGRES_USER`, `POSTGRES_PASSWORD`,
`POSTGRES_DB` **from `/etc/blasti/blasti.env`** (section 6.1) — there is no
separate database .env file to manage. The compose file also publishes the
port on **127.0.0.1 only**, so the database is invisible to the internet.

---

## Part 7 — Verify the deployment (2-minute checklist)

On the **server** (ssh session):

```bash
systemctl status blasti-api blasti-web caddy --no-pager   # all three: active (running)
docker ps                                                  # ONE container: blasti-db (healthy)
curl http://127.0.0.1:3003/api/health                      # {"status":"ok",...}
```

From **your own computer** (replace the IP):

```
curl http://203.0.113.10/api/health       → {"status":"ok",...}
```

then open **http://203.0.113.10** in a browser → the BLASTI login page.

**First login — change the default passwords NOW:**

| Role | Username | Default password |
|---|---|---|
| Platform super-admin | `admin` | `admin123` |
| Demo agency owner | `owner1` | `owner123` |

---

## Part 8 — Add a domain + automatic HTTPS

1. At your domain provider (or DigitalOcean → Networking → Domains), create
   a DNS **A record** pointing your name at the droplet IP:

   | Type | Name | Value |
   |---|---|---|
   | A | `blasti` (or `@` for the root domain) | `203.0.113.10` |

2. Wait until the name resolves (`ping blasti.yourdomain.com` must show the
   droplet IP), then run the **update with the domain** — ssh into the
   server and run:

   ```bash
   bash /opt/blasti/scripts/deploy-digitalocean.sh server-update --domain blasti.yourdomain.com
   ```

   This rewrites `SITE_ADDRESS` / `CORS_ORIGIN` / `ALLOWED_ORIGINS` in
   `/etc/blasti/blasti.env` (Part 6.1) and reconfigures Caddy.

3. Caddy **automatically obtains and renews** the Let's Encrypt certificate.
   Verify: open `https://blasti.yourdomain.com` — padlock 🔒, no warnings.

4. Update the desktop (Part 6.2) and phone apps to the `https://` URL.

> The domain also switches the web login/sessions to secure cookies — tell
> all users the new `https://` address.

---

## Part 9 — Update the app (always from GitHub)

New code is deployed by **pulling the latest commit from GitHub** and
rebuilding — your database, uploaded files and secrets are never touched.

**Update from your computer (one command):**

```bash
./scripts/deploy-digitalocean.sh update root@203.0.113.10
```

**Or update on the server (ssh in, then):**

```bash
bash /opt/blasti/scripts/deploy-digitalocean.sh server-update
```

Both do: `git pull` from GitHub → `bun install` → database schema update →
`next build` → restart `blasti-api` + `blasti-web` + Caddy.

### Auto-update on every new commit (BUILT-IN, on by default)

The droplet updates **itself**: a systemd timer (`blasti-watcher.timer`)
checks GitHub every 2 minutes, and when a new commit is there it runs a full
update automatically (pull → rebuild → restart — your data and secrets are
never touched). It is armed by the installer and by every `server-update`.

You just work normally: `git push` → ~2 minutes later the site is updated.

**Useful commands (ssh into the droplet):**

```bash
systemctl status blasti-watcher.timer                 # is it on?
journalctl -u blasti-watcher.service -n 50 --no-pager # what did it do?
bash /opt/blasti/scripts/deploy-digitalocean.sh server-watch-disable  # turn OFF
bash /opt/blasti/scripts/deploy-digitalocean.sh server-watch-install  # turn ON again
```

**Good to know:**

- A failed rebuild (e.g. a broken push) does **not** get forgotten: the
  watcher retries it after 30 minutes, and immediately when your **next**
  commit lands. The site keeps running the previous working build until a
  deploy succeeds at the restart stage.
- The watcher and a manual `server-update` can never run at the same time
  (they share one lock — no memory problems on the small droplet).
- One caveat of true auto-deploy: whatever lands on `master` goes live. Push
  small, tested commits — and if a push breaks the site, push the fix (or
  disable the watcher first).

---

## Part 10 — Backups

**Quick manual backup** (from your computer — writes a .sql file next to you):

```bash
./scripts/deploy-digitalocean.sh backup root@203.0.113.10
```

**Restore a backup** (careful — overwrites the current database):

```bash
./scripts/deploy-digitalocean.sh restore root@203.0.113.10 blasti-2026-01-01.sql
```

**Automated safety net:** DigitalOcean panel → your droplet → **Backups** →
enable (weekly, +20% of droplet price). Keep both.

---

## Part 11 — Everyday operations cheat sheet

```bash
# ── from your computer ────────────────────────────────────────
./scripts/deploy-digitalocean.sh status root@IP          # everything at a glance
./scripts/deploy-digitalocean.sh logs  root@IP api       # api | web | db | caddy
./scripts/deploy-digitalocean.sh update root@IP          # ship the latest code
./scripts/deploy-digitalocean.sh backup root@IP          # dump the database

# ── on the server (ssh root@IP) ───────────────────────────────
systemctl status blasti-api blasti-web caddy   # are the services running?
systemctl restart blasti-api                   # restart one service
journalctl -u blasti-api -n 100 --no-pager     # last 100 API log lines
journalctl -u blasti-api -f                    # live-follow the API log (Ctrl-C stops)
docker logs --tail 100 blasti-db               # database logs
docker restart blasti-db                       # restart the database container
cat /etc/blasti/blasti.env                     # view the .env configuration (Part 6.1)
cd /opt/blasti                                 # the app's code (from GitHub)
```

---

## Part 12 — Troubleshooting

| Symptom | Likely cause → Fix |
|---|---|
| Installer line `[FAIL] could not detect the public IP` | Rare network hiccup → re-run `bash blasti-deploy.sh server-install` (it resumes safely) |
| `curl /api/health` says connection refused | API not running → `systemctl status blasti-api` and `journalctl -u blasti-api -n 50 --no-pager`; after fixing, `systemctl restart blasti-api` |
| `docker ps` shows blasti-db restarting/unhealthy | Check `docker logs blasti-db`; usually a mismatched `POSTGRES_PASSWORD` vs `DATABASE_URL` in `/etc/blasti/blasti.env` (Part 6.1) — keep them in sync |
| Web page loads but login spins | API unhealthy → check `curl http://127.0.0.1:3003/api/health` **on the server** and the API logs |
| Desktop probe shows **`/api/api/health` → 404** | `BLASTI_CLOUD_URL` has a trailing `/api` → remove it (bare origin only, Part 6.2) |
| Desktop: `[source: built-in default — NO cloud URL configured]` | Variable not found → create `apps/desktop/.env` exactly as in Part 6.2 and restart the app |
| Desktop: workspace locked / REVOKED after a wrong URL | Fix the URL, then log in **fresh** — a successful cloud login clears the revoked state |
| No HTTPS / certificate pending | DNS A-record not pointing at the droplet yet, or re-run `server-update --domain …` (Part 8). Caddy retries automatically |
| `update` says "no git repo" | You installed long ago with the old method → re-run the Part 4 installer (it detects and refreshes the clone) |
| Build killed / "Killed" during update | Droplet ran out of memory → the installer adds swap automatically on ≤4 GB; for manual runs: `sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile` |
| Site reachable on the IP but not the domain | DNS not propagated (can take up to 24 h) → `ping your-domain` until it shows the droplet IP |
| Everything is slow / server unresponsive | Check memory: `free -h` (on the server). 4 GB droplets are the comfortable minimum |

**Reset a service to factory settings** (last resort — wipes the database):

```bash
# on the server
docker stop blasti-db && docker rm blasti-db
docker volume rm blasti_pgdata
docker compose -f /opt/blasti/ops/postgres.compose.yml --env-file /etc/blasti/blasti.env up -d
systemctl restart blasti-api blasti-web
# the seed re-creates the default accounts on the next API start
```

---

## Part 13 — Cost & sizing notes

| Droplet | RAM/vCPU | Verdict |
|---|---|---|
| s-1vcpu-1gb | 1 GB | ❌ Not enough for the Next.js build |
| s-1vcpu-2gb | 2 GB | ⚠️ Works (installer adds 2 GB swap) — testing/small teams |
| **s-2vcpu-4gb** | 4 GB | ✅ **Recommended** — comfortable builds + Postgres headroom |
| s-4vcpu-8gb | 8 GB | Many agencies / heavy ticket volume |

- Docker runs **only** the tiny Postgres container — the apps run natively,
  so a 4 GB droplet has plenty of headroom.
- Enable **Droplet → Backups** (+20%) on top of the Part 10 `pg_dump` routine.
- Firewall keeps the database and app ports **invisible from the internet** —
  only Caddy's 80/443 are public.

---

*Automation behind this guide: `scripts/deploy-digitalocean.sh`
(install / update / status / logs / backup / restore — plus the on-VPS
`server-install` / `server-update` / `server-watch-install` helpers) and
`scripts/watch-and-deploy.sh` (the engine behind the built-in auto-updater).
Full architecture reference: `DEPLOYMENT.md`.*
