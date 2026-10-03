# BLASTI — Deployment Guide (OVHcloud VPS)

**بلاصتي · darija: kifach t-deployi · English: step-by-step, no developer knowledge required**

This guide takes you from *nothing* to a running BLASTI server on an **OVHcloud VPS**,
using **PostgreSQL** as the database. Every step is copy-paste.

> 🟢 **You only need:** an OVH account, a credit card, and about **45 minutes**.
> Wherever you see a gray box, copy it exactly into the terminal (black window) on your server.

---

## Fast path — DigitalOcean (Docker = PostgreSQL only, everything else native)

> 📘 **New to this? Use the dedicated walkthrough instead:**
> **`DEPLOY-GUIDE.md`** — a numbered, copy-paste, step-by-step DigitalOcean
> guide written for non-developers (account → droplet → installer →
> **all .env configurations** → DNS/HTTPS → verification → desktop app →
> updates → backups → troubleshooting).

**Architecture note:** DigitalOcean deployments use the **"Docker = PostgreSQL
only"** stack: ONE container (`blasti-db`, PostgreSQL 16 on 127.0.0.1:5432)
plus **native systemd services** — `blasti-api` (Bun, :3003), `blasti-web`
(Node/Next.js, :3000) and the **Caddy** apt package (80/443, automatic HTTPS).
The code is **pulled from GitHub** by the VPS itself. The full-docker-compose
stack documented below (OVHcloud style) also still works unchanged.

On a **fresh droplet** (Ubuntu 24.04, no node/bun/docker) ssh in and run
two commands — the installer pulls everything from GitHub:

```bash
# on YOUR machine:  ssh root@<DROPLET_IP>
# on the SERVER:
curl -fsSL https://raw.githubusercontent.com/raizel820/BLASTI-MULTI-PLATFORM/master/scripts/deploy-digitalocean.sh -o blasti-deploy.sh
bash blasti-deploy.sh server-install
```

Or trigger the identical install from your own machine
(needs only `ssh`; Windows PowerShell works — no tar/upload anymore):

```bash
git clone https://github.com/raizel820/BLASTI-MULTI-PLATFORM.git blasti && cd blasti
./scripts/deploy-digitalocean.sh install root@<DROPLET_IP>
```

Everyday operations:

```bash
./scripts/deploy-digitalocean.sh update  root@<DROPLET_IP>   # git pull + rebuild + restart
./scripts/deploy-digitalocean.sh status  root@<DROPLET_IP>   # services + db + health
./scripts/deploy-digitalocean.sh logs    root@<DROPLET_IP> api  # api | web | db | caddy
./scripts/deploy-digitalocean.sh backup  root@<DROPLET_IP>   # pg_dump to a local file
./scripts/deploy-digitalocean.sh restore root@<DROPLET_IP> blasti-DATE.sql
```

Notes:
- **Recommended droplet:** Basic / 2 vCPU / 4 GB (`s-2vcpu-4gb`), image **Ubuntu 24.04** — the
  installer adds swap automatically on smaller sizes so the build never runs out of memory.
- All server .env configuration lives in ONE file: **`/etc/blasti/blasti.env`**
  (random secrets generated on first install, never overwritten, never committed —
  full variable reference in `DEPLOY-GUIDE.md` Part 6).
- Domain later? Re-run update with `--domain your.domain` — Caddy obtains and
  renews the HTTPS certificate automatically.
- Everything else in this guide (first login, DNS, backups, troubleshooting) applies unchanged —
  just replace "OVH Manager" with the DigitalOcean control panel.

---

## Auto-deploy on new commits (git watcher)

`scripts/watch-and-deploy.sh` polls the GitHub repo
(`https://github.com/raizel820/BLASTI-MULTI-PLATFORM.git`) and applies new commits to the VPS
automatically — no manual deploy step.

**On the VPS (recommended, cron-driven):** the VPS holds a git clone of the repo
(`git clone https://github.com/raizel820/BLASTI-MULTI-PLATFORM.git /opt/blasti`),
then cron checks every 5 minutes and on a new commit runs `git fetch + reset --hard`
plus the docker rebuild (your `ops/.env` secrets are never touched):

```bash
sudo crontab -e
# add:
*/5 * * * * /opt/blasti/scripts/watch-and-deploy.sh watch --on-server --once >> /var/log/blasti-watch.log 2>&1
```

**From your own machine (no git needed on the VPS):** uploads the changed code with the
same tar-over-ssh path as a manual deploy, in a long-running loop:

```bash
./scripts/watch-and-deploy.sh watch root@<DROPLET_IP> --domain blasti.example.com
```

Useful flags: `--branch master` (default), `--interval 300`, `--once` (single check),
`--dry-run` (show what would happen), `--deploy-now` (deploy on first run instead of just
recording a baseline). Private repos need a PAT/deploy key on the machine running the
watcher. The watcher never deploys on its very first check unless `--deploy-now` is given.

---

## 0. What you are deploying (30 seconds)

```
                        INTERNET
                            │  ports 80 + 443 only
                    ┌───────▼────────┐
                    │     Caddy      │  door-keeper: HTTPS padlock + traffic routing
                    └───────┬────────┘
              ┌─────────────┴─────────────┐
      ┌───────▼───────┐           ┌───────▼───────┐
      │   Web app     │           │    API        │
      │  (Next.js)    │           │ (Bun, :3003)  │
      └───────────────┘           └───────┬───────┘
                                  ┌───────▼───────┐
                                  │  PostgreSQL   │  all data (accounts, queues…)
                                  └───────────────┘
```

| Piece | What it is | Who can reach it |
|---|---|---|
| **Caddy** | Public entrance, adds the 🔒 HTTPS padlock automatically | everyone |
| **Web app** | The browser/phone interface | only through Caddy |
| **API** | The brain — queues, SMS, payments | only through Caddy |
| **PostgreSQL** | The database — every account, ticket, transaction | only the API |
| **migrate** | Helper that creates tables on first start | nobody (runs and exits) |

Everything runs as **Docker containers** — think of them as self-contained boxes.
If one crashes, Docker restarts it automatically.

---

## 1. What you need

- [ ] An **OVHcloud account** (ovhcloud.com)
- [ ] Your project code (a **zip of this folder**, or a git URL — ask your developer)
- [ ] *(optional but recommended)* a **domain name** (e.g. `blasti.example.com`)
- [ ] *(optional)* OVH **Object Storage** or any off-server backup location

**Recommended server size:** VPS **2 vCores / 4 GB RAM** (OVH *Value* or *Essential*) —
comfortable for testing and easily handles dozens of simultaneous users.
Choose **Ubuntu 24.04** when ordering.

---

## 2. Order & connect to the VPS

### 2.1 Order
1. OVH Manager → **Bare Metal Cloud → VPS** → pick *Value/Essential 2 vCore 4 GB*.
2. **Image: Ubuntu 24.04**. Add your **SSH key** if you have one (else OVH emails you a password).
3. Wait ~5 minutes for install. Note the **IPv4** (e.g. `203.0.113.10`).

### 2.2 Connect (first time)

**On Windows** — use the built-in terminal (Windows 10/11) or PowerShell:
```powershell
ssh ubuntu@203.0.113.10
```
(password: the one OVH emailed you; first visit → type `yes`)

**On Mac / Linux:**
```bash
ssh ubuntu@203.0.113.10
```

> 💡 *No terminal?* In the OVH Manager: VPS → **…** → **Open KVM console** works from the browser.

You are now "inside" the server. Everything below happens there.

### 2.3 Become root (one-time)
```bash
sudo -i
```
If you are no longer `root` after reconnecting later, run `sudo -i` again.

---

## 3. Install Docker (one-time, ~2 minutes)

```bash
curl -fsSL https://get.docker.com | sh
```

Check it works (both commands must print a version):
```bash
docker --version
docker compose version
```

> 🔁 If `docker compose version` fails, you have an old Docker — run:
> `apt-get remove docker-compose && apt-get update && apt-get install docker-compose-plugin`

---

## 4. Put the BLASTI code on the server

**Option A — zip file (easiest without git):**
1. On your PC: zip the project folder (right-click → *Compress*).
2. Upload it — either with **WinSCP** / **FileZilla** (SFTP, same address/password as ssh),
   or from your terminal:
   ```bash
   scp blasti.zip ubuntu@203.0.113.10:/home/ubuntu/
   ```
3. On the server:
   ```bash
   cd /home/ubuntu
   apt-get update && apt-get install -y unzip
   unzip blasti.zip
   mv blasti* blasti        # rename the extracted folder to "blasti"
   ```

**Option B — git:**
```bash
apt-get update && apt-get install -y git
git clone <YOUR_REPO_URL> /home/ubuntu/blasti
```

Now enter the project and remember this folder — it's called the **project root**:
```bash
cd /home/ubuntu/blasti
```

---

## 5. Configure the server (the only file you must edit)

```bash
cd /home/ubuntu/blasti/ops
cp .env.example .env
nano .env        # nano = simple text editor. Ctrl+O = save, Ctrl+X = exit
```

Fill in the ⚠️ lines:

| Line | What to put | How |
|---|---|---|
| `POSTGRES_PASSWORD` | a long random password | run `openssl rand -base64 24`, copy the output |
| `NEXTAUTH_SECRET` | a long random string | `openssl rand -base64 32` |
| `INTERNAL_SECRET` | a long random string | `openssl rand -base64 32` |
| `SITE_ADDRESS` | `https://your-domain` **or** `:80` for IP-only testing | see §9 / §10 |
| `CORS_ORIGIN` + `ALLOWED_ORIGINS` | same address as SITE_ADDRESS but **without** `https://` port nonsense — just the full origin, e.g. `https://blasti.example.com` | keep in sync with SITE_ADDRESS |

> 🔐 `ops/.env` holds your secrets. Never share it, never commit it to git (it's already gitignored).

**Examples:**

*Testing by VPS IP (no domain yet):*
```
SITE_ADDRESS=:80
CORS_ORIGIN=http://203.0.113.10
ALLOWED_ORIGINS=http://203.0.113.10
```

*With a domain:*
```
SITE_ADDRESS=https://blasti.example.com
CORS_ORIGIN=https://blasti.example.com
ALLOWED_ORIGINS=https://blasti.example.com
```

---

## 6. First start (~5–10 minutes: it builds the apps)

```bash
cd /home/ubuntu/blasti/ops
docker compose up -d --build
```

Watch it work:
```bash
docker compose ps           # after a few minutes everything should be "running"
docker compose logs -f      # live output — Ctrl+C to stop watching
```

✅ **Success check** — open in a browser:
- `http://203.0.113.10` (or `https://your-domain`) → the BLASTI landing page
- `http://203.0.113.10/api/health` → `{"status":"ok",...}`

**First-boot note:** the `migrate` helper created all PostgreSQL tables and seeded
**only if the database was empty** (it never erases data on restarts).

### 6.1 Open the firewall
```bash
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw enable
```

> ⚠️ **Log in and change the default passwords NOW** (§7).

---

## 7. First login — change the defaults!

| Account | Username | Default password | Where |
|---|---|---|---|
| Platform super-admin | `admin` | `admin123` | Admin dashboard |
| Agency owner (fresh agency "My Agency", code MYA) | `owner` | `owner123` | Agency dashboard |

1. Open the app → **Log in** → `admin / admin123`.
2. Go to profile → **change the password immediately**.
3. Repeat for `owner`.

---

## 8. Point the mobile & desktop apps at your server

The phone app is built with the server address **baked in**:

1. On your **development PC** (not the VPS), edit `apps/web/.env.production`:
   ```
   NEXT_PUBLIC_API_URL=https://blasti.example.com
   ```
   *(or `http://203.0.113.10` for IP testing)*
2. Rebuild the APK:
   ```
   bun run build:mobile
   ```
   then open Android Studio → ▶ Run / build the APK as usual.
3. **Desktop (Electron):** put `BLASTI_CLOUD_URL="https://blasti.example.com"`
   into **`apps/desktop/.env`** and rebuild (`bun run electron:build:win`). The
   `.env` is baked into the installer, and can also be edited **after**
   installation at `<install>\resources\.env` without rebuilding. (OS environment
   variables do NOT travel into the installer — the `.env` file is the only
   supported build-time configuration.)

---

## 9. (Recommended) Add your domain + automatic HTTPS

1. Buy a domain (OVH domains, or any registrar).
2. OVH Manager → **Domain → DNS zone → Add an entry**:
   - Type: `A` · Sub-domain: `blasti` (or `@` for the bare domain)
   - Target: **your VPS IPv4** (`203.0.113.10`)
3. Wait 5–60 min for DNS to propagate (check: `ping blasti.example.com`).
4. In `ops/.env` set the `https://…` values from §5.
5. Restart the gateway:
   ```bash
   cd /home/ubuntu/blasti/ops
   docker compose up -d caddy
   ```
Caddy obtains and renews the **HTTPS certificate automatically** — nothing else to do. 🔒

---

## 10. Everyday operations (cheat sheet)

All commands run from `/home/ubuntu/blasti/ops`:

| I want to… | Command |
|---|---|
| See if everything is up | `docker compose ps` |
| Read live logs | `docker compose logs -f` |
| Logs of one piece | `docker compose logs -f api` (or `web`, `db`, `caddy`) |
| Restart everything | `docker compose restart` |
| Stop everything | `docker compose down` |
| **Update the app** (new code) | replace the code folder, then `docker compose up -d --build` |
| Enter the database | `docker compose exec db psql -U blasti -d blasti` |
| **Full data wipe + reseed** ⚠️ | `docker compose run --rm migrate sh -c "cd packages/db && bun run db:seed"` |

### 10.1 Backups — DO THIS WEEKLY (or automate)

The database and the uploaded files are the two things that matter:

```bash
# Database → single file with a date in the name
docker compose exec db pg_dump -U blasti -d blasti > ~/blasti-db-$(date +%F).sql

# Uploaded files (avatars, logos, receipts)
tar czf ~/blasti-uploads-$(date +%F).tar.gz -C /var/lib/docker/volumes/blasti_uploads/_data .
```

**Automatic weekly backup (every Sunday 03:00):**
```bash
crontab -e
# add these two lines:
0 3 * * 0 docker compose -f /home/ubuntu/blasti/ops/docker-compose.yml exec -T db pg_dump -U blasti -d blasti > /root/backups/blasti-db-$(date +\%F).sql
15 3 * * 0 tar czf /root/backups/blasti-uploads-$(date +\%F).tar.gz -C /var/lib/docker/volumes/blasti_uploads/_data .
```
(`mkdir -p /root/backups` first. Copy the backup files OFF the server regularly — e.g. download via WinSCP.)

### 10.2 Restore a backup ⚠️
```bash
cat ~/blasti-db-2025-01-01.sql | docker compose exec -T db psql -U blasti -d blasti
```

### 10.3 Storage usage
```bash
docker system df
docker system prune      # clean old build caches (safe)
```

---

## 11. Troubleshooting

| Symptom | Fix |
|---|---|
| Browser shows nothing | `docker compose ps` → is `caddy` up? Then `docker compose logs caddy` |
| Landing page loads but **login fails** | `docker compose logs api` — look for red errors; confirm `db` is `running (healthy)` |
| `Caddy` logs "certificate obtain error" | DNS not pointed yet, or ports 80/443 blocked (check §6.1 and the OVH firewall) |
| Phone app says *Failed to fetch* | APK was built with a different URL — rebuild with `NEXT_PUBLIC_API_URL` (§8) |
| Everything slow after weeks | `docker system prune` + check disk: `df -h` |
| "port already in use" | Something else grabbed 80/443: `docker compose down` then check `ss -tlnp | grep -E ':80|:443'` |
| Need a full restart from zero ⚠️ | `docker compose down -v` **deletes the database volume** — backup first (§10.1) |

**Where things live on the server**

| Thing | Location |
|---|---|
| Code | `/home/ubuntu/blasti` |
| Your settings | `/home/ubuntu/blasti/ops/.env` |
| Database data | Docker volume `blasti_pgdata` |
| Uploaded files | Docker volume `blasti_uploads` |
| HTTPS certificates | Docker volume `blasti_caddy_data` (auto-managed) |

---

## 12. Environment variables reference (`ops/.env`)

| Variable | Required | Meaning |
|---|---|---|
| `POSTGRES_USER` / `POSTGRES_DB` | – | Database user/name (defaults `blasti`/`blasti`) |
| `POSTGRES_PASSWORD` | ⚠️ YES | Database password (random, long) |
| `NEXTAUTH_SECRET` | ⚠️ YES | Signs login sessions — random 32+ chars |
| `INTERNAL_SECRET` | ⚠️ YES | Internal API-to-API key — random 32+ chars |
| `SITE_ADDRESS` | ⚠️ YES | `https://your-domain` (prod) or `:80` (IP testing) |
| `CORS_ORIGIN` / `ALLOWED_ORIGINS` | ⚠️ YES | Full origin(s) allowed to call the API / open WebSockets — comma-separate for several |
| `CRON_SECRET` | – | Protects `/api/cron` maintenance endpoints |

Changes to this file require: `docker compose up -d` (restarts affected services).

---

## 13. Appendix — developers / local development

**Local machine PostgreSQL** (the app defaults to `postgresql://blasti:blasti@127.0.0.1:5432/blasti`):
```bash
docker compose -f ops/docker-compose.dev.yml up -d   # start local PostgreSQL
bun run dev                                          # start API + web as usual
bun run db:push                                      # create/update tables
bun run db:seed                                      # full reset seed (wipes + admin/owner)
bun run reset:all                                    # full platform reset (db + uploads + desktop data)
```

**Architecture notes**
- Schema: `packages/db/prisma/schema.prisma` (`provider = "postgresql"`).
- Zero-config dev: `packages/db/.env` (committed, localhost-only creds) feeds the Prisma CLI;
  a real `DATABASE_URL` env var always wins over it.
- `packages/db/prisma/seed-if-empty.ts` = idempotent bootstrap (used by the `migrate` service);
  `seed.ts` = full-reset seed. Never run `seed.ts` on a server with real data.
- Web container builds with `NEXT_PUBLIC_API_URL=""` → browsers call the API **same-origin**
  through Caddy (`/api/*`, `/socket.io/*` are proxied — see `ops/Caddyfile`).
- The desktop/mobile **offline** SQLite databases (WatermelonDB / Electron local API) are
  **unrelated** to this change — those are per-device caches by design.
