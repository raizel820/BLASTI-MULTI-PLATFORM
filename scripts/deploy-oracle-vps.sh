#!/usr/bin/env bash
# ====================================================================
# BLASTI — Oracle Cloud VPS one-command deploy (Ubuntu image)
# ====================================================================
# For: Oracle Cloud (OCI) instances — Ampere A1 (ARM, e.g. 2 OCPU /
#      12 GB RAM) or any Intel/AMD shape — running an UBUNTU 22.04 /
#      24.04 image. A fresh instance needs NOTHING pre-installed.
#
# ARCHITECTURE (identical to the proven DigitalOcean pipeline):
#
#     Internet ──▶ Caddy  :80/:443   (native apt package, auto-HTTPS)
#                    │
#                    ├─ /api/*       ──▶ 127.0.0.1:3003  blasti-api (systemd, Bun)
#                    ├─ /socket.io/* ──▶ 127.0.0.1:3003  blasti-api (systemd, Bun)
#                    └─ everything   ──▶ 127.0.0.1:3000  blasti-web (systemd, Node)
#
#     Docker runs EXACTLY ONE container:
#         blasti-db  →  PostgreSQL 16   (published on 127.0.0.1:5432 ONLY)
#
#     Code comes from GITHUB (this repo) — the VPS clones it itself.
#
# ORACLE-SPECIFIC (why this script exists next to deploy-digitalocean.sh):
#   • Oracle Ubuntu images ship REJECT-all iptables rules that block
#     80/443 even with ufw "inactive" — this script inserts ACCEPT
#     rules at the top of INPUT and persists them across reboots.
#   • The public IP is 1:1-NAT'd — the OS only sees a private IP, so
#     the script reads the real public IP from the OCI metadata
#     service (or take --ip <PUBLIC_IP>).
#   • ARM64 (aarch64) is fully supported: Docker, Bun, Node 22,
#     Caddy and postgres:16-alpine all ship arm64 builds.
#   • ⚠ The OCI *Security List* (cloud-level firewall) can ONLY be
#     opened in the Oracle web console — see the warning this script
#     prints. Until it is done the site stays unreachable from the
#     internet, no matter what the server-side firewall says.
#
# USAGE — ON the VPS, as root (Oracle's default user is "ubuntu"):
#   ssh ubuntu@YOUR_ORACLE_IP
#   curl -fsSL https://raw.githubusercontent.com/raizel820/BLASTI-MULTI-PLATFORM/master/scripts/deploy-oracle-vps.sh -o deploy-oracle-vps.sh
#   sudo bash deploy-oracle-vps.sh                       # HTTP on the raw IP
#   sudo bash deploy-oracle-vps.sh --domain blasti.dz    # + automatic HTTPS
#
# MODES
#   install  (default)  First-time install on a fresh instance.
#   update              Pull latest code + rebuild + restart.
#   doctor              Full health report (one paste = full picture).
#   status              Quick services overview.
#   logs [svc] [-f]     Show service logs (api | web | db | caddy).
#   firewall            Re-apply the Oracle iptables fix + show the
#                       Security-List instructions.
#
# OPTIONS (install)
#   --domain D   domain for automatic HTTPS (A-record must point here)
#   --ip IP      public IP override (default: OCI metadata → ifconfig.me)
#   --repo URL   git repo (default: the BLASTI GitHub repo)
#   --branch B   branch to track (default: master)
#   --dir PATH   install location (default: /opt/blasti)
#   --token T    GitHub token (private repos only)
# ====================================================================
set -euo pipefail

REPO_DEFAULT="https://github.com/raizel820/BLASTI-MULTI-PLATFORM.git"
BRANCH_DEFAULT="master"
DIR_DEFAULT="/opt/blasti"
ENV_FILE="/etc/blasti/blasti.env"

log()  { printf '\033[1;34m[deploy]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[  ok  ]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[ warn ]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[FAIL  ]\033[0m %s\n' "$*" >&2; exit 1; }

usage() { sed -n '2,58p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

require_root() {
  [ "$(id -u)" -eq 0 ] || die "must run as root — Oracle's default user is 'ubuntu':
  ssh ubuntu@YOUR_ORACLE_IP
  sudo bash $0 $1"
}

# --------------------------------------------------------------------
# Oracle public IP: the OS only knows its PRIVATE address (the public
# one is 1:1-NAT'd by Oracle). Detection order:
#   --ip flag  →  OCI metadata service  →  ifconfig.me  →  hostname -I
# --------------------------------------------------------------------
detect_public_ip() {
  local ip=""
  # 1) OCI instance metadata — authoritative on Oracle Cloud
  ip="$(curl -fsS -m 4 -H 'Authorization: Bearer Oracle' \
        http://169.254.169.254/opc/v2/instance/ 2>/dev/null \
        | grep -o '"publicIp"[[:space:]]*:[[:space:]]*"[0-9.]*"' | head -n1 \
        | grep -o '[0-9.]\+"' | tr -d '"' || true)"
  # 2) external echo service
  case "$ip" in ''|null) ip="$(curl -4 -fsS -m 6 https://ifconfig.me 2>/dev/null || true)" ;; esac
  # 3) last resort — often the PRIVATE ip on Oracle, so warn loudly
  if [ -z "$ip" ]; then
    ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
    case "$ip" in
      10.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*|192.168.*)
        warn "detected PRIVATE ip '$ip' — Oracle NATs the public ip; pass --ip <PUBLIC_IP>" ;;
    esac
  fi
  printf '%s' "$ip"
}

# --------------------------------------------------------------------
# THE Oracle gotcha: Ubuntu images on OCI boot with iptables rules that
# REJECT everything except ssh (22) — even though `ufw status` says
# inactive. Insert ACCEPT rules for 80/443 at the TOP of INPUT (they
# are then evaluated before Oracle's catch-all REJECT) and persist the
# ruleset so it survives reboots. ufw is deliberately NOT used here —
# stacking it on Oracle's pre-loaded rules only creates confusion.
# --------------------------------------------------------------------
fix_oracle_firewall() {
  log "Oracle host firewall: opening 80/443 in iptables (Oracle ships REJECT-all rules)..."
  if ! iptables -C INPUT -p tcp --dport 80 -j ACCEPT 2>/dev/null; then
    iptables -I INPUT 1 -p tcp --dport 80 -j ACCEPT
  fi
  if ! iptables -C INPUT -p tcp --dport 443 -j ACCEPT 2>/dev/null; then
    iptables -I INPUT 1 -p tcp --dport 443 -j ACCEPT
  fi
  # same for IPv6 (Oracle blocks that stack too)
  if command -v ip6tables >/dev/null 2>&1; then
    ip6tables -C INPUT -p tcp --dport 80  -j ACCEPT 2>/dev/null || ip6tables -I INPUT 1 -p tcp --dport 80  -j ACCEPT
    ip6tables -C INPUT -p tcp --dport 443 -j ACCEPT 2>/dev/null || ip6tables -I INPUT 1 -p tcp --dport 443 -j ACCEPT
  fi
  # persist across reboots (Oracle images normally have iptables-persistent)
  if command -v netfilter-persistent >/dev/null 2>&1; then
    netfilter-persistent save >/dev/null 2>&1 || true
  else
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq iptables-persistent >/dev/null 2>&1 || true
    if command -v netfilter-persistent >/dev/null 2>&1; then
      netfilter-persistent save >/dev/null 2>&1 || true
    elif [ -d /etc/iptables ]; then
      iptables-save > /etc/iptables/rules.v4 2>/dev/null || true
      ip6tables-save > /etc/iptables/rules.v6 2>/dev/null || true
    fi
  fi
  ok "host firewall: 22 (ssh) + 80 + 443 accepted, rules persisted"
}

# --------------------------------------------------------------------
# The cloud-level firewall — the ONLY thing this script cannot do for
# you. Printed at install start (so you can click along while the
# build runs) and again in the final summary.
# --------------------------------------------------------------------
security_list_notice() {
  cat <<'EOF'

  ┌──────────────────────────────────────────────────────────────┐
  │  ⚠  ORACLE CLOUD SECURITY LIST — YOU must open 80/443  ⚠     │
  │                                                              │
  │  Oracle blocks every port except 22 at the CLOUD level by    │
  │  default. The server-side firewall is already handled by     │
  │  this script, but the Security List lives in the Oracle web  │
  │  console only:                                               │
  │                                                              │
  │   1. https://cloud.oracle.com → Networking → Virtual Cloud   │
  │      Networks → your VCN → Subnets → your subnet → its       │
  │      Security List                                           │
  │   2. "Add Ingress Rules":                                    │
  │        Source CIDR 0.0.0.0/0 · IP Protocol TCP · Port 80     │
  │        Source CIDR 0.0.0.0/0 · IP Protocol TCP · Port 443    │
  │   3. Save — the site is reachable within seconds (no         │
  │      server restart needed).                                 │
  │                                                              │
  │  Until this is done, the site will NOT load in your browser, │
  │  even while every service on the server is healthy.          │
  └──────────────────────────────────────────────────────────────┘
EOF
}

# --------------------------------------------------------------------
# ON-VPS helpers (same contracts as deploy-digitalocean.sh)
# --------------------------------------------------------------------
env_set() { # env_set <file> <KEY> <value>
  local file="$1" key="$2" value="$3"
  if grep -q "^${key}=" "$file" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

resolve_next_bin() { # prints the Next.js CLI path inside bun's layout
  local root="$1" p
  for p in "$root/apps/web/node_modules/next/dist/bin/next" "$root/node_modules/next/dist/bin/next"; do
    [ -f "$p" ] && { printf '%s' "$p"; return 0; }
  done
  for p in "$root/apps/web/node_modules/.bin/next" "$root/node_modules/.bin/next"; do
    [ -e "$p" ] && { printf '%s' "$p"; return 0; }
  done
  return 1
}

run_next() { # run_next <bin> <args...>
  local bin="$1"; shift
  case "$bin" in
    */dist/bin/next) node "$bin" "$@" ;;
    *)               "$bin" "$@" ;;
  esac
}

build_web() { # empty NEXT_PUBLIC_API_URL = same-origin calls through Caddy
  local root="$1" next_bin
  next_bin="$(resolve_next_bin "$root")" || die "Next.js CLI not found under $root (did bun install run?)"
  log "Building the web app (next build on Node — a few minutes on 2 OCPU)..."
  ( cd "$root/apps/web" \
      && NEXT_PUBLIC_API_URL="" NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 \
         run_next "$next_bin" build )
  ok "web app built"
}

migrate_db() { # prisma generate + db push + seed-if-empty (seed skips when users exist)
  local root="$1"
  log "Applying database schema (prisma generate + db push + seed-if-empty)..."
  set -a; . "$ENV_FILE"; set +a
  ( cd "$root/packages/db" \
      && bun run db:generate \
      && bun run db:push \
      && bun run db:seed-if-empty )
  ok "database ready"
}

render_caddyfile() { # repo template → /etc/caddy/Caddyfile with localhost upstreams
  local root="$1" site="$2"
  [ -f "$root/ops/Caddyfile" ] || die "ops/Caddyfile missing in $root"
  mkdir -p /etc/caddy
  sed -e "s|{\$SITE_ADDRESS}|${site}|g" \
      -e 's|reverse_proxy api:3003|reverse_proxy 127.0.0.1:3003|g' \
      -e 's|reverse_proxy web:3000|reverse_proxy 127.0.0.1:3000|g' \
      "$root/ops/Caddyfile" > /etc/caddy/Caddyfile
}

wait_healthy() {
  local i
  log "Waiting for the API health check (up to 3 minutes)..."
  for ((i = 1; i <= 36; i++)); do
    if curl -fsS --max-time 4 http://127.0.0.1:3003/api/health 2>/dev/null | grep -q 'status'; then
      ok "API is healthy"; return 0
    fi
    sleep 5
  done
  return 1
}

write_systemd_units() {
  local root="$1"
  local NEXT_BIN WEB_START
  NEXT_BIN="$(resolve_next_bin "$root")" || die "Next.js CLI not found after bun install"
  case "$NEXT_BIN" in
    */dist/bin/next) WEB_START="/usr/bin/node $NEXT_BIN start -H 127.0.0.1 -p 3000" ;;
    *)               WEB_START="$NEXT_BIN start -H 127.0.0.1 -p 3000" ;;
  esac

  # ReadWritePaths target must exist or systemd fails the unit
  mkdir -p "$root/apps/api/uploads"

  cat > /etc/systemd/system/blasti-api.service <<EOF
[Unit]
Description=BLASTI API (Bun - Hono + Socket.IO on 127.0.0.1:3003)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=$ENV_FILE
WorkingDirectory=$root/apps/api
ExecStart=/usr/local/bin/bun src/index.ts
Restart=always
RestartSec=3
TimeoutStopSec=15
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=-$root/apps/api/uploads

[Install]
WantedBy=multi-user.target
EOF

  cat > /etc/systemd/system/blasti-web.service <<EOF
[Unit]
Description=BLASTI Web (Next.js on 127.0.0.1:3000)
After=network-online.target blasti-api.service
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=$ENV_FILE
Environment=NODE_ENV=production
Environment=NEXT_TELEMETRY_DISABLED=1
WorkingDirectory=$root/apps/web
ExecStart=$WEB_START
Restart=always
RestartSec=3
TimeoutStopSec=15
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
EOF
}

# GitHub auto-updater: systemd timer → repo's watch-and-deploy.sh →
# deploy-digitalocean.sh server-update (git pull + rebuild + restart).
# Same units the DigitalOcean pipeline uses — fully Oracle-compatible.
install_auto_update_watcher() {
  local root="$1"
  if [ ! -f "$root/scripts/watch-and-deploy.sh" ]; then
    warn "scripts/watch-and-deploy.sh not found — GitHub auto-updater NOT installed"
    return 0
  fi
  log "Arming the GitHub auto-updater (checks for new commits every 2 minutes)..."

  cat > /etc/systemd/system/blasti-watcher.service <<EOF
[Unit]
Description=BLASTI auto-update check (new GitHub commits -> git pull + rebuild + restart)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
Environment=HOME=/root
Environment=BLASTI_WATCH_STATE_DIR=/root/.blasti-watch
EnvironmentFile=$ENV_FILE
WorkingDirectory=$root
ExecStart=$root/scripts/watch-and-deploy.sh watch --on-server --once --dir $root
# a full rebuild can take a while on small instances — never kill it mid-build
TimeoutStartSec=3600
EOF

  cat > /etc/systemd/system/blasti-watcher.timer <<EOF
[Unit]
Description=Run the BLASTI GitHub auto-update check every 2 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=2min
AccuracySec=20s

[Install]
WantedBy=timers.target
EOF

  systemctl daemon-reload
  systemctl enable --now blasti-watcher.timer >/dev/null 2>&1 || true
  ok "auto-updater armed — push to GitHub and this VPS updates itself"
  ok "turn it off with:  systemctl disable --now blasti-watcher.timer"
}

print_summary() { # <site-url> <ip> <domain>
  local url="$1" ip="$2" domain="$3"
  cat <<EOF

  ============================================================
   BLASTI is UP on this Oracle VPS.

   Web app      :  $url
   API health   :  $url/api/health
   Server IP    :  $ip
  ============================================================
EOF
  security_list_notice
  cat <<EOF
   NEXT STEPS:
   1. Open the web app, log in and CHANGE the default passwords:
        admin / admin123        (platform super-admin)
        owner / owner123        (demo agency owner)
   2. Desktop / phone apps point at the bare origin (no /api!):
        BLASTI_CLOUD_URL="$url"
      (desktop: apps/desktop/.env in dev, or
       %LOCALAPPDATA%\\Programs\\BLASTI\\resources\\.env when installed)
   3. With a domain: point the DNS A-record -> $ip, then re-run
      this script with --domain to switch on automatic HTTPS.
   4. Useful commands (on this server):
        systemctl status blasti-api blasti-web caddy
        journalctl -u blasti-api -n 50 --no-pager
        docker logs --tail 50 blasti-db
        cat $ENV_FILE        (all .env configuration lives here)
        bash $0 doctor       (full health report in one paste)
   5. AUTO-UPDATES are ON: pushing to GitHub deploys itself within
      ~2 minutes (blasti-watcher.timer). Turn off with:
        systemctl disable --now blasti-watcher.timer
  ============================================================
EOF
}

# --------------------------------------------------------------------
# MODE: install (default) — runs ON the VPS, as root
# --------------------------------------------------------------------
cmd_install() {
  local DOMAIN="" REPO="$REPO_DEFAULT" BRANCH="$BRANCH_DEFAULT" DIR="$DIR_DEFAULT" TOKEN="" IP_OVERRIDE=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --domain) DOMAIN="$2"; shift 2 ;;
      --ip)     IP_OVERRIDE="$2"; shift 2 ;;
      --repo)   REPO="$2";   shift 2 ;;
      --branch) BRANCH="$2"; shift 2 ;;
      --dir)    DIR="$2";    shift 2 ;;
      --token)  TOKEN="$2";  shift 2 ;;
      --help|-h) usage; exit 0 ;;
      *) die "install: unknown argument: $1 (try --help)" ;;
    esac
  done
  require_root "install"
  export DEBIAN_FRONTEND=noninteractive

  # serialize with the auto-updater — two builds at once would thrash a small instance
  mkdir -p /run/lock
  exec 8>/run/lock/blasti-update.lock
  flock -n 8 || die "another install/update is already running (auto-updater busy?) — try again in a few minutes"

  command -v apt-get >/dev/null 2>&1 \
    || die "this script targets Oracle UBUNTU images (apt-based). Oracle Linux (dnf) is NOT supported — recreate the instance from the Canonical Ubuntu 22.04/24.04 image and re-run."

  local arch cpu mem_mb
  arch="$(uname -m)"
  cpu="$(nproc)"
  mem_mb="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)"
  log "BLASTI Oracle install starting on $(hostname) — arch=$arch, ${cpu} CPU, ${mem_mb} MB RAM"
  case "$arch" in
    aarch64) ok "ARM64 (Ampere) detected — Docker, Bun, Node 22, Caddy and Postgres all ship arm64 builds" ;;
    x86_64)  ok "x86_64 detected" ;;
    *)       warn "unusual arch '$arch' — attempting anyway" ;;
  esac

  # do the console clicks NOW while the install runs (~10 min)
  security_list_notice

  # -- 1. swap on small instances (Next.js build needs headroom) --------
  local swap_lines
  swap_lines="$(swapon --noheadings --show 2>/dev/null | grep -c . || true)"
  if [ "${mem_mb:-0}" -lt 4000 ] && [ "${swap_lines:-0}" -eq 0 ] && [ ! -f /swapfile ]; then
    log "Small instance (${mem_mb} MB RAM) — adding 2 GB swap..."
    fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap -q /swapfile && swapon /swapfile
    grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    ok "swap enabled"
  fi

  # -- 2. base packages --------------------------------------------------
  log "Installing base packages (curl git unzip openssl gnupg iptables)..."
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl git unzip openssl gnupg iptables \
    debian-keyring debian-archive-keyring apt-transport-https >/dev/null
  ok "base packages ready"

  # -- 3. Docker (used ONLY for the PostgreSQL container) ----------------
  if ! command -v docker >/dev/null 2>&1; then
    log "Installing Docker (runs ONLY the PostgreSQL container)..."
    curl -fsSL https://get.docker.com | sh >/dev/null 2>&1
  fi
  docker compose version >/dev/null 2>&1 \
    || die "docker compose plugin missing — run: apt-get install -y docker-compose-plugin"
  ok "Docker $(docker --version | awk '{print $3}' | tr -d ,) ready (postgres-only duty)"

  # -- 4. Bun (API runtime) ------------------------------------------------
  if ! command -v bun >/dev/null 2>&1; then
    log "Installing Bun -> /usr/local/bin/bun ..."
    curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash >/dev/null 2>&1
  fi
  command -v bun >/dev/null 2>&1 || die "bun not found after install — check network and re-run"
  ok "Bun $(bun --version) ready"

  # -- 5. Node 22 (web runtime: next build / next start) -------------------
  if ! command -v node >/dev/null 2>&1 \
     || [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt 20 ]; then
    log "Installing Node.js 22 (NodeSource)..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
    apt-get install -y -qq nodejs >/dev/null
  fi
  command -v node >/dev/null 2>&1 || die "node not found after install"
  ok "Node $(node --version) ready"

  # -- 6. Caddy (HTTPS gateway, official apt repo) --------------------------
  if ! command -v caddy >/dev/null 2>&1; then
    log "Installing Caddy (official repository)..."
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
      | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
      > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq && apt-get install -y -qq caddy >/dev/null
  fi
  command -v caddy >/dev/null 2>&1 || die "caddy not found after install"
  ok "Caddy $(caddy version | awk '{print $1}') ready"

  # -- 7. THE Oracle fix: host iptables (REJECT-all rules ship with OCI) ----
  fix_oracle_firewall

  # -- 8. public IP + /etc/blasti/blasti.env (the ONE .env config) ---------
  local PUB_IP="$IP_OVERRIDE"
  if [ -z "$PUB_IP" ]; then
    PUB_IP="$(detect_public_ip)"
  fi
  [ -n "$PUB_IP" ] || PUB_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"

  mkdir -p /etc/blasti
  if [ ! -f "$ENV_FILE" ]; then
    log "Creating $ENV_FILE with RANDOM secrets..."
    local PG_PW
    PG_PW="$(openssl rand -hex 16)"
    cat > "$ENV_FILE" <<EOF
# ══════════════════════════════════════════════════════════════
# BLASTI VPS environment — generated by deploy-oracle-vps.sh
# Full documentation: DEPLOY-GUIDE.md  ->  ".env configurations"
# Edit with:  nano $ENV_FILE   then:  systemctl restart blasti-api blasti-web
# Secrets below are random — NEVER commit this file, never share it.
# ══════════════════════════════════════════════════════════════

# ── PostgreSQL (the ONLY Docker container) ─────────────────────
POSTGRES_USER=blasti
POSTGRES_PASSWORD=$PG_PW
POSTGRES_DB=blasti

# ── Database URL used by the API + Prisma CLI ──────────────────
DATABASE_URL=postgresql://blasti:$PG_PW@127.0.0.1:5432/blasti?schema=public

# ── Security secrets ───────────────────────────────────────────
NEXTAUTH_SECRET=$(openssl rand -hex 32)
INTERNAL_SECRET=$(openssl rand -hex 32)
CRON_SECRET=$(openssl rand -hex 16)
DEPLOY_TOKEN=$(openssl rand -hex 24)

# ── Networking (all app ports bind to localhost only) ─────────
API_PORT=3003
HOST=127.0.0.1
WEB_PORT=3000
INTERNAL_API_URL=http://127.0.0.1:3003
API_PROXY_URL=http://127.0.0.1:3003
EOF
    chmod 600 "$ENV_FILE"
    ok "$ENV_FILE created (random secrets)"
  else
    warn "$ENV_FILE already exists — keeping your secrets untouched"
  fi

  # public address (CORS + Caddy site). --domain wins on every run.
  local SITE ORIGIN
  if [ -n "$DOMAIN" ]; then
    SITE="https://$DOMAIN"; ORIGIN="https://$DOMAIN"
  else
    [ -n "$PUB_IP" ] || die "could not detect the public IP — pass --ip <PUBLIC_IP> or --domain"
    SITE=":80"; ORIGIN="http://$PUB_IP"
  fi
  env_set "$ENV_FILE" SITE_ADDRESS "$SITE"
  env_set "$ENV_FILE" CORS_ORIGIN "$ORIGIN"
  env_set "$ENV_FILE" ALLOWED_ORIGINS "$ORIGIN"

  # -- 9. DNS sanity check (domain mode, best effort) ------------------------
  if [ -n "$DOMAIN" ] && [ -n "$PUB_IP" ]; then
    local resolved
    resolved="$(getent hosts "$DOMAIN" 2>/dev/null | awk '{print $1; exit}' || true)"
    if [ -z "$resolved" ]; then
      warn "DNS: $DOMAIN does not resolve yet — add an A record -> $PUB_IP"
      warn "     (HTTP on the raw IP keeps working meanwhile; Caddy retries HTTPS)"
    elif [ "$resolved" != "$PUB_IP" ]; then
      warn "DNS: $DOMAIN resolves to $resolved but this server is $PUB_IP"
      warn "     Caddy cannot obtain an HTTPS certificate until it points here."
    else
      ok "DNS check passed: $DOMAIN -> $PUB_IP"
    fi
  fi

  # -- 10. the code: clone (or refresh) from GitHub ---------------------------
  local clone_url="$REPO"
  [ -n "$TOKEN" ] && clone_url="https://${TOKEN}@github.com/${REPO#*github.com/}"
  if [ -d "$DIR/.git" ]; then
    log "Repo already at $DIR — fetching latest $BRANCH from GitHub..."
    git -C "$DIR" remote set-url origin "$clone_url"
    git -C "$DIR" fetch origin "$BRANCH"
    git -C "$DIR" reset --hard FETCH_HEAD
  elif [ -d "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
    die "$DIR exists and is not empty (and not a git repo) — move it away or pass --dir PATH"
  else
    log "Cloning $REPO ($BRANCH) -> $DIR ..."
    mkdir -p "$DIR"
    git clone --depth 1 --branch "$BRANCH" "$clone_url" "$DIR" \
      || die "git clone failed — check the repo URL/branch${TOKEN:+ and token}"
  fi
  [ -n "$TOKEN" ] && warn "note: the GitHub token is stored in $DIR/.git/config (needed for future pulls)"
  ok "code ready at $DIR ($(git -C "$DIR" rev-parse --short HEAD))"

  # -- 11. PostgreSQL container (the ONLY Docker container) -------------------
  log "Starting the PostgreSQL container (127.0.0.1:5432 only)..."
  docker compose -f "$DIR/ops/postgres.compose.yml" --env-file "$ENV_FILE" up -d
  local i state=""
  for ((i = 1; i <= 30; i++)); do
    state="$(docker inspect -f '{{.State.Health.Status}}' blasti-db 2>/dev/null || true)"
    [ "$state" = "healthy" ] && break
    sleep 2
  done
  [ "$state" = "healthy" ] || die "postgres container did not become healthy — run: docker logs blasti-db"
  ok "PostgreSQL healthy (blasti-db on 127.0.0.1:5432)"

  # -- 12. dependencies + database schema --------------------------------------
  log "Installing JS dependencies (bun install — a few minutes on first run)..."
  ( cd "$DIR" && bun install )
  ok "dependencies installed"
  migrate_db "$DIR"

  # -- 13. build the web app -----------------------------------------------------
  build_web "$DIR"

  # -- 14. systemd services (auto-start + auto-restart on boot/crash) ------------
  log "Installing systemd services (blasti-api, blasti-web)..."
  write_systemd_units "$DIR"
  systemctl daemon-reload
  systemctl enable --now blasti-api.service blasti-web.service >/dev/null 2>&1 || true
  systemctl restart blasti-api.service blasti-web.service
  ok "services enabled (start automatically on boot)"

  # -- 15. Caddy gateway ------------------------------------------------------------
  log "Configuring Caddy ($SITE)..."
  render_caddyfile "$DIR" "$SITE"
  caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 \
    || die "generated Caddyfile is invalid — inspect /etc/caddy/Caddyfile"
  systemctl enable --now caddy >/dev/null 2>&1 || true
  systemctl restart caddy
  ok "Caddy running on 80/443"

  # -- 15b. GitHub auto-updater (deploys new commits automatically) ------------
  install_auto_update_watcher "$DIR"

  # -- 16. health check + summary ----------------------------------------------------
  if wait_healthy; then
    local URL
    if [ -n "$DOMAIN" ]; then URL="https://$DOMAIN"; else URL="http://$PUB_IP"; fi
    print_summary "$URL" "${PUB_IP:-?}" "$DOMAIN"
  else
    warn "API did not become healthy within 3 minutes. Diagnose with:"
    warn "  bash $0 doctor"
    warn "  systemctl status blasti-api blasti-web"
    warn "  journalctl -u blasti-api -n 50 --no-pager"
    exit 1
  fi
}

# --------------------------------------------------------------------
# MODE: update — delegates to the repo's proven server-update
# (git pull + bun install + migrate + build + restart + caddy re-render)
# --------------------------------------------------------------------
cmd_update() {
  local DOMAIN="" DIR="$DIR_DEFAULT"
  while [ $# -gt 0 ]; do
    case "$1" in
      --domain) DOMAIN="$2"; shift 2 ;;
      --dir)    DIR="$2";    shift 2 ;;
      --help|-h) usage; exit 0 ;;
      *) die "update: unknown argument: $1 (try --help)" ;;
    esac
  done
  require_root "update"
  [ -f "$DIR/scripts/deploy-digitalocean.sh" ] \
    || die "no repo at $DIR — run install first (or pass --dir)"
  local args=()
  [ -n "$DOMAIN" ] && args+=(--domain "$DOMAIN")
  exec bash "$DIR/scripts/deploy-digitalocean.sh" server-update "${args[@]}"
}

# --------------------------------------------------------------------
# MODE: doctor — delegates to the repo's server-doctor (one-paste report)
# --------------------------------------------------------------------
cmd_doctor() {
  require_root "doctor"
  local DIR="$DIR_DEFAULT"
  [ $# -gt 0 ] && { case "$1" in --dir) DIR="$2" ;; *) die "doctor: unknown argument: $1" ;; esac; }
  if [ -f "$DIR/scripts/deploy-digitalocean.sh" ]; then
    exec bash "$DIR/scripts/deploy-digitalocean.sh" server-doctor
  fi
  # pre-install fallback: basic report
  echo "── services ──────────────────────────────────────────"
  systemctl is-active blasti-api blasti-web caddy docker 2>/dev/null || true
  echo "── blasti-db container ───────────────────────────────"
  docker ps --filter name=blasti-db --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null || true
  echo "── health (loopback) ─────────────────────────────────"
  curl -fsS --max-time 4 http://127.0.0.1:3003/api/health 2>/dev/null || echo "API NOT HEALTHY (or not installed yet)"
  echo
  echo "── disk / memory ─────────────────────────────────────"
  df -h / | tail -1; free -h | head -2
}

# --------------------------------------------------------------------
# MODES: status / logs / firewall
# --------------------------------------------------------------------
cmd_status() {
  echo "── services ──────────────────────────────────────────"
  systemctl is-active blasti-api blasti-web caddy docker 2>/dev/null || true
  echo "── blasti-db container ───────────────────────────────"
  docker ps --filter name=blasti-db --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null || true
  echo "── health (loopback) ─────────────────────────────────"
  curl -fsS --max-time 4 http://127.0.0.1:3003/api/health 2>/dev/null || echo 'API NOT HEALTHY'
  echo
  echo "── disk / memory ─────────────────────────────────────"
  df -h / | tail -1; free -h | head -2
}

cmd_logs() {
  local SVC="" FOLLOW=""
  while [ $# -gt 0 ]; do
    case "$1" in
      -f|--follow)  FOLLOW="1"; shift ;;
      api|web|db|caddy) SVC="$1"; shift ;;
      *) die "logs: unknown argument: $1 (use: api | web | db | caddy  [-f])" ;;
    esac
  done
  SVC="${SVC:-api}"
  case "$SVC" in
    api)   journalctl -u blasti-api -n 100 --no-pager ${FOLLOW:+-f} ;;
    web)   journalctl -u blasti-web -n 100 --no-pager ${FOLLOW:+-f} ;;
    caddy) journalctl -u caddy -n 100 --no-pager ${FOLLOW:+-f} ;;
    db)    docker logs --tail 100 ${FOLLOW:+-f} blasti-db ;;
  esac
}

cmd_firewall() {
  require_root "firewall"
  fix_oracle_firewall
  echo
  echo "── current INPUT rules (top 10) ──────────────────────"
  iptables -L INPUT -n --line-numbers | head -12
  security_list_notice
}

# --------------------------------------------------------------------
# dispatch (install is the default — bare `sudo bash deploy-oracle-vps.sh`
# and `sudo bash deploy-oracle-vps.sh --domain d.tz` both install)
# --------------------------------------------------------------------
if [ $# -eq 0 ]; then
  MODE="install"
else
  case "$1" in
    install|init|update|deploy|doctor|status|logs|firewall|help|-h|--help)
      MODE="$1"; shift ;;
    -*) MODE="install" ;;   # options-only invocation → install
    *) die "unknown mode: $1 (try --help)" ;;
  esac
fi

case "$MODE" in
  install|init)  cmd_install "$@" ;;
  update|deploy) cmd_update "$@" ;;
  doctor)        cmd_doctor "$@" ;;
  status)        cmd_status "$@" ;;
  logs)          cmd_logs "$@" ;;
  firewall)      cmd_firewall "$@" ;;
  help|-h|--help) usage ;;
esac
