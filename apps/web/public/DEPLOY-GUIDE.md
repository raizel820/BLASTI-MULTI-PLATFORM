# BLASTI — Step-by-Step DigitalOcean Droplet Deployment Guide

A complete, copy-paste walkthrough: **from "I have a DigitalOcean account" to
"BLASTI is live on my droplet with HTTPS, and my desktop app talks to it."**

Everything here uses one script — `scripts/deploy-digitalocean.sh` — which
automates Docker, firewall, secrets, build and startup. No manual server
configuration is required.

> Reference for every internal detail (compose layout, Caddyfile, env vars,
> backups, restore): see `DEPLOYMENT.md`.

---

## Part 0 — What you will end up with (30 seconds)

One droplet running the full production stack in Docker:

```
                    Internet
                        │
              ┌─────────▼─────────┐
              │   Droplet (VPS)   │
              │  ports 80 + 443   │
              │  ┌─────────────┐  │
              │  │    Caddy    │  │  automatic HTTPS (Let's Encrypt)
              │  └──┬───────┬──┘  │
              │     │       │     │
              │ ┌───▼──┐ ┌──▼───┐ │
              │ │ web  │ │ api  │ │  Next.js UI  +  Hono API (:3003)
              │ └──────┘ └──┬───┘ │                 │
              │         ┌───▼───┐ │         ┌──────▼──────┐
              │         │ postgres│ │        │ /socket.io  │
              │         └───────┘ │         │ realtime    │
              │                   │         └─────────────┘
              └───────────────────┘
   ▲                                    ▲
   │ browser / phone browser            │ desktop app (login + sync + realtime)
   └── http(s)://your-domain ───────────┴── BLASTI_CLOUD_URL="https://your-domain"
```

- **Browser users** open `https://your-domain` (or `http://<droplet-ip>` for testing).
- **Desktop app** keeps running its local SQLite database offline, and uses
  your droplet for login, cloud sync and realtime — configured with ONE
  variable: `BLASTI_CLOUD_URL` (Part 6).

---

## Part 1 — What you need

| # | Requirement | Notes |
|---|-------------|-------|
| 1 | DigitalOcean account | [digitalocean.com](https://www.digitalocean.com) |
| 2 | A machine with `bash` + `ssh` + `tar` | Windows 10/11: use **Git Bash** or **WSL** (both ship ssh/tar) |
| 3 | An SSH key added to your DO account | Part 2, Step 2 |
| 4 | `doctl` CLI (optional) | Only for Path A (one-command droplet creation). Path B uses the DO website instead |
| 5 | A domain name (recommended) | Needed for automatic HTTPS. You can start without one |
| 6 | ~10–15 minutes | Most of it is the Docker build, which runs unattended |

**Recommended droplet:** Basic → Regular → **s-2vcpu-4gb** (2 vCPU / 4 GB /
80 GB SSD, ~$18/mo). The script auto-adds 2 GB swap on smaller droplets so
even s-1vcpu-2gb can build, but 4 GB is noticeably faster and safer for
production. Region: pick the one closest to your users (default `ams3`).

---

## Part 2 — One-time local setup

### Step 1 — Get the BLASTI code

```bash
git clone https://github.com/raizel820/BLASTI-MULTI-PLATFORM.git blasti
cd blasti
```

(Already have it? `git pull` and make sure you are on the latest `master`.)

### Step 2 — Add your SSH key to DigitalOcean

If you already have a key, note its fingerprint/ID and skip to Step 3.

1. DigitalOcean console → **Settings → Security → SSH keys → Add SSH key**.
2. Paste your **public** key (`~/.ssh/id_ed25519.pub` or `~/.ssh/id_rsa.pub`).
   - No key yet? Generate one: `ssh-keygen -t ed25519` (accept defaults).
3. Give it a name you will recognise, e.g. `my-laptop`.

### Step 3 (optional, Path A only) — Install & authenticate doctl

```bash
# macOS
brew install doctl
# Linux — see https://docs.digitalocean.com/reference/doctl/how-to/install/
# Windows — choco install doctl  (or scoop install doctl)

doctl auth init          # paste your API token
                         # (DO console → API → Generate New Token, Read+Write)
```

Verify your key is visible (note the **ID** or **Name** — you will use it):

```bash
doctl compute ssh-key list
```

---

## Part 3 — Deploy

Pick **ONE** path:

- **Path A (recommended)** — you installed `doctl`: one command creates the
  droplet AND deploys BLASTI.
- **Path B** — no `doctl`: create the droplet on the DO website, then one
  command deploys BLASTI to it.

### ── Path A: one command from zero ──────────────────────────────

```bash
./scripts/deploy-digitalocean.sh create \
    --ssh-key my-laptop \
    --region ams3 \
    --size s-2vcpu-4gb \
    --name blasti \
    --domain blasti.example.com
```

- `--ssh-key` accepts the key **name** or **ID** from `doctl compute ssh-key list`.
- `--domain` is optional — include it only if the DNS A-record already points
  this hostname at the IP the script prints (see Part 4). Without it the site
  runs on plain HTTP at the raw IP.
- Add `--yes` to skip the confirmation prompt.

What happens (fully automated, ~10 min):

1. Creates Ubuntu 24.04 droplet, waits until it is network-active.
2. Uploads the code and runs the server bootstrap (see below).
3. Prints your URLs + the droplet IP at the end. **Write the IP down.**

### ── Path B: droplet via the DO website, then one command ───────

1. DO console → **Create → Droplets**.
2. **Region:** closest to your users. **Image:** Ubuntu 24.04 LTS.
3. **Size:** Basic → Regular → **4 GB / 2 vCPU** (s-2vcpu-4gb).
4. **Authentication:** SSH key → select `my-laptop`.
5. **Hostname:** `blasti`. → **Create Droplet**.
6. Copy the droplet's public IP (e.g. `203.0.113.10`), then from the repo:

   ```bash
   ./scripts/deploy-digitalocean.sh deploy root@203.0.113.10 \
       --domain blasti.example.com
   ```

   (Omit `--domain` if you have none yet.) This uploads the code, installs
   Docker, configures the firewall, generates secrets, builds and starts
   everything. **Safe to re-run any time** to ship an update.

### What the server bootstrap does (both paths, automatic)

- Installs Docker + git (skipped when already present)
- Firewall: `ufw` allows only **22 / 80 / 443**
- Generates `ops/.env` with **random** Postgres password + secrets
  (never overwrites an existing one — redeploys keep your data)
- Adds 2 GB swap on small droplets (build headroom)
- `docker compose up -d --build` → postgres → migrations → api → web → caddy
- Waits until `GET /api/health` returns OK (up to 5 min), then prints URLs

---

## Part 4 — Domain + HTTPS

If you deployed **without** a domain, the app is live at
`http://<droplet-ip>` (plain HTTP — fine for testing).

To go to proper HTTPS:

1. In your DNS provider create an **A record**:

   | Type | Name | Value |
   |------|------|-------|
   | A | `blasti` (or `@` for the root domain) | `<droplet IP>` |

2. Wait until it resolves (check: `ping blasti.example.com` → your IP), then
   re-run the deploy with the domain so Caddy picks it up:

   ```bash
   ./scripts/deploy-digitalocean.sh deploy root@<droplet-ip> \
       --domain blasti.example.com
   ```

3. Caddy automatically obtains and later **renews** the Let's Encrypt
   certificate. Verify: open `https://blasti.example.com` — padlock, no
   warnings.

> ⚠️ Do the DNS step BEFORE the very first start when you can — Caddy gets
> the certificate immediately on first boot. Adding it later still works via
> the redeploy above.

---

## Part 5 — Verify the deployment (2-minute checklist)

```bash
# 1. Everything running?
./scripts/deploy-digitalocean.sh status root@<droplet-ip>
#    → 5 containers: caddy, web, api, migrate (exited 0), postgres

# 2. API health from the outside  (NOTE: /api/health — never /api/api/health)
curl https://blasti.example.com/api/health        # → {"status":"ok",...}

# 3. Web UI loads
open https://blasti.example.com                    # login page renders

# 4. Realtime endpoint reachable
curl -i https://blasti.example.com/socket.io/?EIO=4&transport=polling
#    → HTTP 200 with an engine.io handshake payload

# 5. Live logs (Ctrl-C to stop)
./scripts/deploy-digitalocean.sh logs root@<droplet-ip> api
```

**First login — change the defaults NOW:**
The database is seeded with two accounts. Log in at `https://blasti.example.com`
and change both passwords immediately:

| Role | Username | Default password |
|------|----------|------------------|
| Admin | `admin` | `admin123` |
| Owner | `owner` | `owner123` |

---

## Part 6 — Point the desktop app at YOUR droplet

The desktop app is **local-first**: its UI and working data always come from
the embedded local API, while **login, cloud sync and realtime** go to the
server you configure below. One variable controls everything:

```
BLASTI_CLOUD_URL
```

### ⚠️ The value must be the ORIGIN — never append `/api`

The app appends `/api/*` paths **itself**. Writing the suffix yourself
doubles the path and breaks everything:

```
✅ BLASTI_CLOUD_URL="http://68.183.137.227"          ← raw IP, HTTP (testing)
✅ BLASTI_CLOUD_URL="https://blasti.example.com"     ← domain + HTTPS (production)
❌ BLASTI_CLOUD_URL="http://68.183.137.227/api"      ← DO NOT — probes /api/api/health → 404
```

Recent builds **auto-correct** a trailing `/api` and print a warning, but
fix the value anyway.

### Dev mode (`bun run electron:dev`)

The app reads `.env` files automatically at startup (Electron does not do
this by itself — BLASTI ships its own loader). The printed startup line is
the ground truth of what will be used:

```
[BLASTI Desktop] Cloud API → https://blasti.example.com  [source: …\.env]
```

Pick **any one** of these three places (first match wins):

1. **Project root `.env`** — the file you already have for web/api vars.
   Add one line (only `BLASTI_*` keys are read from this file):

   ```bash
   # at the repository root, .env
   BLASTI_CLOUD_URL="https://blasti.example.com"
   ```

2. **`apps/desktop/.env`** — the dedicated desktop file (create it if
   missing; it is gitignored so it stays on your machine):

   ```bash
   cp apps/desktop/.env.example apps/desktop/.env
   # then edit: BLASTI_CLOUD_URL="https://blasti.example.com"
   ```

3. **OS environment variable** (overrides both files):

   ```bash
   export BLASTI_CLOUD_URL="https://blasti.example.com"   # macOS/Linux
   set BLASTI_CLOUD_URL=https://blasti.example.com        # Windows cmd
   ```

Then start the app and **check the console line**:

```bash
bun run electron:dev
```

- ✅ `[BLASTI Desktop] Cloud API → https://blasti.example.com  [source: …\.env]`
  → the app will log in against, sync with, and receive realtime events from
  your droplet.
- ❌ `[source: built-in default — NO cloud URL configured]` → the variable
  was not found; the banner lists every location it looked in. Fix the
  location/name and restart.

> `BLASTI_API_URL` still works as a legacy alias but has **lower** precedence
> than `BLASTI_CLOUD_URL`.

### Installed app (.exe) — no rebuild needed

After installing, edit this file with Notepad (create it if missing):

```
%LOCALAPPDATA%\Programs\BLASTI\resources\.env
```

```
BLASTI_CLOUD_URL="https://blasti.example.com"
```

Restart the app — it repoints without reinstalling or rebuilding.

### Verify the connection inside the app

1. Log in with an account that exists **on the VPS** (e.g. the ones from
   Part 5). Success = the login was proxied to your droplet.
2. Create something (a queue/ticket) → it should appear on the web UI at
   `https://blasti.example.com` after the next sync tick.
3. Offline test: disable Wi-Fi, keep working; re-enable → data syncs up.

> First run shows `initial-sync: ERROR — الإعداد الأول يتطلب اتصالاً بالإنترنت`
> until the cloud is reachable AND you log in once — that is expected: the
> very first workspace import needs the VPS. With the URL fixed, the
> cloud-api diagnostic must turn ✓ before login will work.

---

## Part 7 — Ship updates (and optional auto-deploy)

### Manual update — one command, whenever you want

```bash
git pull                                        # get the latest code
./scripts/deploy-digitalocean.sh deploy root@<droplet-ip> --domain blasti.example.com
```

Zero-downtime restart of changed containers; **secrets and database are
never touched**. (`status` / `logs` subcommands help you watch it land.)

### Auto-deploy on every new commit (git watcher)

```bash
# From your machine — every new commit triggers the same upload+rebuild:
./scripts/watch-and-deploy.sh watch root@<droplet-ip> --domain blasti.example.com

# Or ON the server via cron (recommended for always-on):
ssh root@<droplet-ip>
crontab -e
# add:
*/5 * * * * /opt/blasti/scripts/watch-and-deploy.sh watch --on-server --once >> /var/log/blasti-watch.log 2>&1
```

Useful flags: `--once` (single check), `--dry-run`, `--force`, `--branch master`,
`--deploy-now`. Private repos need a read-only PAT or deploy key on the
machine running the watcher.

---

## Part 8 — Everyday operations cheat sheet

```bash
# Container status
./scripts/deploy-digitalocean.sh status root@IP

# Follow logs: api | web | db | caddy
./scripts/deploy-digitalocean.sh logs root@IP api

# SSH in
ssh root@IP

# Inside the server
cd /opt/blasti
docker compose ps                 # what is running
docker compose logs -f api        # any service's logs
docker compose restart api        # restart one service
docker compose up -d --build      # rebuild everything

# Database backup (weekly at least — see DEPLOYMENT.md §10.1 for automation)
ssh root@IP "docker compose -f /opt/blasti/ops/docker-compose.yml exec -T db \
  pg_dump -U blasti blasti" > blasti-$(date +%F).sql
```

---

## Part 9 — Troubleshooting

| Symptom | Likely cause → Fix |
|---|---|
| Diagnostics probe shows **`/api/api/health` → 404** | `BLASTI_CLOUD_URL` has a trailing `/api` → remove it (origin only). Recent builds auto-strip it with a warning |
| Desktop console: `[source: built-in default — NO cloud URL configured]` | Variable missing → Part 6; the banner lists all checked locations |
| `deploy` fails at upload | `ssh root@IP` asks for a password → your local key is not the DO-registered one. `ssh -i ~/.ssh/id_ed25519 root@IP` to test |
| Build killed / "Killed" during `web` build | Droplet too small for the build → the script adds swap automatically on ≤4 GB; if you built manually, add swap or use s-2vcpu-4gb |
| Site loads but login spins forever | API not healthy → `./scripts/deploy-digitalocean.sh logs root@IP api`; check `/api/health` |
| No HTTPS / certificate pending | DNS A-record not pointing at the droplet yet, or deployed <1 min ago. `dig +short blasti.example.com` must return the droplet IP; Caddy retries automatically |
| Desktop: login fails with "cloud unreachable" | `BLASTI_CLOUD_URL` typo'd, or the droplet firewall blocks you, or the domain's cert is pending → test `curl https://your-domain/api/health` from the same machine |
| Desktop: logs in but never syncs | The VPS account's agency must exist on the cloud; check api logs for `/api/sync/*` calls; realtime uses `/socket.io/*` (Caddy proxies it automatically) |
| Workspace stays locked / REVOKED after a wrong URL was used | Fix the URL, then log in **fresh** — a successful cloud login clears the revoked state (offline unlock stays disabled until then) |
| `curl http://<ip>/api/health` works, HTTPS doesn't | You added the domain after the first boot → re-run `deploy --domain` (Part 4) |

---

## Part 10 — Cost & sizing notes

| Droplet | RAM/vCPU | Verdict |
|---|---|---|
| s-1vcpu-1gb | 1 GB | ❌ Not enough for the Next.js build |
| s-1vcpu-2gb | 2 GB | ⚠️ Works (script adds 2 GB swap) — slow builds, dev/testing only |
| **s-2vcpu-4gb** | 4 GB | ✅ **Recommended** — comfortable builds + headroom for Postgres |
| s-4vcpu-8gb | 8 GB | For many agencies / heavy ticket volume |

Backups: enable **Droplet → Backups** in the DO panel (weekly, +20% cost) on
top of the `pg_dump` routine in Part 8.

---

*Automation behind this guide: `scripts/deploy-digitalocean.sh`
(create/deploy/bootstrap/status/logs) + `scripts/watch-and-deploy.sh`
(commit watcher). Full reference: `DEPLOYMENT.md`.*
