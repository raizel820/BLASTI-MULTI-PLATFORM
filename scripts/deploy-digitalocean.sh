#!/usr/bin/env bash
# ====================================================================
# BLASTI - DigitalOcean one-command deployment
# ====================================================================
# Deploys the SAME production stack documented in DEPLOYMENT.md
# (PostgreSQL 16 + API + Web + Caddy HTTPS, all via docker compose),
# but automates every server-side step into a single command.
#
# RUNS ON : Linux, macOS, WSL, or Git Bash (Windows 10/11).
# NEEDS   : ssh + tar (both are built into Windows 10+ / Git Bash).
#           `doctl` is ONLY needed for the `create` mode (making a
#           new droplet). Everything else is plain ssh.
#
# MODES
#   create     Make a NEW DigitalOcean droplet, then deploy to it:
#                ./scripts/deploy-digitalocean.sh create \
#                    --ssh-key <id|name> [--region ams3] [--size s-2vcpu-4gb] \
#                    [--name blasti] [--domain blasti.example.com] [--yes]
#
#   deploy     Upload code + (re)build + start on an EXISTING droplet.
#              Safe to re-run any time you want to ship an update:
#                ./scripts/deploy-digitalocean.sh deploy root@203.0.113.10 \
#                    [--domain blasti.example.com] [--port 22] [--dir /opt/blasti]
#
#   bootstrap  (Runs ON the server; `deploy` calls it for you):
#                sudo bash scripts/deploy-digitalocean.sh bootstrap [--domain d.tld]
#
#   status     Show container status:   ./scripts/deploy-digitalocean.sh status root@IP
#   logs       Follow logs:             ./scripts/deploy-digitalocean.sh logs root@IP [api|web|db|caddy]
#
# WHAT bootstrap DOES ON THE SERVER
#   - installs Docker + git + ufw              (skipped when already present)
#   - opens ports 22/80/443 and enables ufw
#   - creates ops/.env with RANDOM secrets     (never overwrites an existing one)
#   - adds 2 GB swap on small droplets         (headroom for the Next.js build)
#   - docker compose up -d --build             (db -> migrate -> api -> web -> caddy)
#   - waits until GET /api/health is OK, then prints your URLs
#
# DOMAIN DEPLOYS (HTTPS)
#   Point the DNS A-record at the droplet IP BEFORE the first start -
#   Caddy fetches and renews the Let's Encrypt certificate automatically.
#   Without a domain the script runs plain HTTP on the raw IP (testing).
#
# TIP: pair with scripts/watch-and-deploy.sh to auto-deploy on every
#      new commit to the GitHub repo.
# ====================================================================
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_REMOTE_DIR="/opt/blasti"

log()  { printf '\033[1;34m[deploy]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[  ok  ]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[ warn ]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[FAIL  ]\033[0m %s\n' "$*" >&2; exit 1; }

usage() { sed -n '2,60p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

# Files/dirs never shipped to the server (mirrors .dockerignore).
# tar patterns without "/" match the basename at any depth.
TAR_EXCLUDES=(
  --exclude=.git
  --exclude=node_modules
  --exclude=.next
  --exclude=out
  --exclude=dist
  --exclude=build
  --exclude=.gradle
  --exclude=.turbo
  --exclude=coverage
  '--exclude=*.log'
  '--exclude=*.db'
  '--exclude=*.sqlite'
  '--exclude=*.apk'
  --exclude=./db
  --exclude=./packages/db/data
  --exclude=./agent-ctx
  --exclude=./tool-results
  --exclude=./download
  --exclude=./.env
  --exclude=./.env.local
  --exclude=./ops/.env
  --exclude=./apps/mobile/android/local.properties
)

ssh_run() { # ssh_run <port> <target> <command...>
  local port="$1" target="$2"; shift 2
  ssh -p "$port" -o StrictHostKeyChecking=accept-new -o BatchMode=yes "$target" "$*"
}

wait_ssh() { # wait_ssh <ip> <port> <tries>
  local ip="$1" port="$2" tries="$3" i
  for ((i = 1; i <= tries; i++)); do
    if ssh_run "$port" "root@$ip" true 2>/dev/null; then return 0; fi
    sleep 5
  done
  return 1
}

# --------------------------------------------------------------------
# MODE: create (needs doctl)
# --------------------------------------------------------------------
cmd_create() {
  local REGION="ams3" SIZE="s-2vcpu-4gb" NAME="blasti" SSH_KEY="" DOMAIN="" ASSUME_YES=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --region)   REGION="$2";   shift 2 ;;
      --size)     SIZE="$2";     shift 2 ;;
      --name)     NAME="$2";     shift 2 ;;
      --ssh-key)  SSH_KEY="$2";  shift 2 ;;
      --domain)   DOMAIN="$2";   shift 2 ;;
      --yes)      ASSUME_YES=1;  shift ;;
      --help|-h)  usage; exit 0 ;;
      *) die "create: unknown argument: $1 (try --help)" ;;
    esac
  done

  command -v doctl >/dev/null 2>&1 || die "doctl is not installed.
Install it:  https://docs.digitalocean.com/reference/doctl/how-to/install/
  brew install doctl            |  snap install doctl
  (Windows: choco install doctl or download the .zip from GitHub releases)
Then run:  doctl auth init
Or skip doctl: create a droplet manually (image: Ubuntu 24.04, add your SSH
key), then deploy with:  $0 deploy root@DROPLET_IP"

  doctl auth list >/dev/null 2>&1 || die "doctl is not authenticated - run: doctl auth init"

  if [ -z "$SSH_KEY" ]; then
    local key_count
    key_count="$(doctl compute ssh-key list --no-header --format ID 2>/dev/null | grep -c . || true)"
    if [ "$key_count" = "1" ]; then
      SSH_KEY="$(doctl compute ssh-key list --no-header --format ID | head -n1 | tr -d ' ')"
      ok "using your only DO SSH key (id $SSH_KEY)"
    else
      doctl compute ssh-key list
      die "pass --ssh-key <id|name> (see the list above). Add a key at:
https://cloud.digitalocean.com/account/security"
    fi
  else
    case "$SSH_KEY" in
      ''|*[!0-9]*)
        local resolved
        resolved="$(doctl compute ssh-key list --no-header --format ID,Name \
                    | awk -v n="$SSH_KEY" '$2==n{print $1; exit}')"
        [ -n "$resolved" ] || die "SSH key named '$SSH_KEY' not found (doctl compute ssh-key list)"
        SSH_KEY="$resolved"
        ;;
    esac
  fi

  if [ "$ASSUME_YES" -ne 1 ]; then
    printf "Create droplet '%s' (%s, %s) and deploy BLASTI to it? [y/N] " "$NAME" "$SIZE" "$REGION"
    read -r REPLY
    case "$REPLY" in y|Y|yes|Yes) ;; *) die "aborted" ;; esac
  fi

  log "Creating droplet '$NAME' ($SIZE, $REGION) - this waits until it is active..."
  doctl compute droplet create "$NAME" \
    --image ubuntu-24-04-x64 \
    --size "$SIZE" \
    --region "$REGION" \
    --ssh-keys "$SSH_KEY" \
    --enable-monitoring \
    --wait >/dev/null

  local IP
  IP="$(doctl compute droplet get "$NAME" --format PublicIPv4 --no-header | tr -d ' ' | head -n1)"
  [ -n "$IP" ] || die "droplet created but IP could not be read - check: doctl compute droplet list"
  ok "droplet '$NAME' is active at $IP"

  log "Waiting for SSH (root@$IP)..."
  wait_ssh "$IP" 22 36 || die "SSH not reachable yet. Give it a minute, then run:
  $0 deploy root@$IP ${DOMAIN:+--domain $DOMAIN}"

  if [ -n "$DOMAIN" ]; then
    warn "remember the DNS A-record:  $DOMAIN  ->  $IP  (required for HTTPS)"
  fi

  exec "$PROJECT_ROOT/scripts/deploy-digitalocean.sh" deploy "root@$IP" --port 22 ${DOMAIN:+--domain "$DOMAIN"}
}

# --------------------------------------------------------------------
# MODE: deploy (upload + remote bootstrap)
# --------------------------------------------------------------------
cmd_deploy() {
  local TARGET="" DOMAIN="" PORT=22 REMOTE_DIR="$DEFAULT_REMOTE_DIR"
  while [ $# -gt 0 ]; do
    case "$1" in
      --domain) DOMAIN="$2";   shift 2 ;;
      --port)   PORT="$2";     shift 2 ;;
      --dir)    REMOTE_DIR="$2"; shift 2 ;;
      --help|-h) usage; exit 0 ;;
      -*) die "deploy: unknown argument: $1 (try --help)" ;;
      *)
        [ -z "$TARGET" ] || die "deploy: only one target allowed (got '$TARGET' and '$1')"
        TARGET="$1"; shift ;;
    esac
  done
  [ -n "$TARGET" ] || die "deploy: missing target - use:  $0 deploy root@DROPLET_IP"
  case "$TARGET" in *@*) ;; *) TARGET="root@$TARGET" ;; esac

  command -v ssh >/dev/null 2>&1 || die "ssh not found (on Windows: use WSL or Git Bash)"
  command -v tar >/dev/null 2>&1 || die "tar not found (on Windows: use WSL or Git Bash)"

  log "Uploading project to $TARGET:$REMOTE_DIR"
  log "(first upload includes no node_modules - typically 20-60 MB, a few minutes)"
  ssh_run "$PORT" "$TARGET" "mkdir -p '$REMOTE_DIR'"
  tar -czf - "${TAR_EXCLUDES[@]}" -C "$PROJECT_ROOT" . \
    | ssh -p "$PORT" -o StrictHostKeyChecking=accept-new "$TARGET" "tar -xzf - -C '$REMOTE_DIR'"
  ok "code uploaded"

  log "Running server bootstrap (Docker, firewall, secrets, build, start)..."
  # shellcheck disable=SC2029
  ssh -p "$PORT" -o StrictHostKeyChecking=accept-new "$TARGET" \
    "cd '$REMOTE_DIR' && bash scripts/deploy-digitalocean.sh bootstrap ${DOMAIN:+--domain '$DOMAIN'}"

  cat <<EOF

  ============================================================
   BLASTI deployment to $TARGET finished.
   Re-run this exact command any time to ship a code update
   (your secrets in ops/.env on the server are never touched).
  ============================================================
EOF
}

# --------------------------------------------------------------------
# MODE: bootstrap (runs ON the server, as root)
# --------------------------------------------------------------------
cmd_bootstrap() {
  local DOMAIN=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --domain)  DOMAIN="$2"; shift 2 ;;
      --help|-h) usage; exit 0 ;;
      *) die "bootstrap: unknown argument: $1 (try --help)" ;;
    esac
  done

  if [ "$(id -u)" -ne 0 ]; then
    die "bootstrap must run as root. ssh in and run:
  sudo bash scripts/deploy-digitalocean.sh bootstrap"
  fi
  export DEBIAN_FRONTEND=noninteractive

  [ -f "$PROJECT_ROOT/ops/docker-compose.yml" ] \
    || die "BLASTI project not found at $PROJECT_ROOT (ops/docker-compose.yml missing)"

  log "BLASTI bootstrap starting on $(hostname)..."

  # -- 1. swap on small droplets (Next.js build needs headroom) ---------
  local mem_mb swap_lines
  mem_mb="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)"
  swap_lines="$(swapon --noheadings --show 2>/dev/null | grep -c . || true)"
  if [ "${mem_mb:-0}" -lt 4000 ] && [ "${swap_lines:-0}" -eq 0 ] && [ ! -f /swapfile ]; then
    log "Small droplet (${mem_mb} MB RAM) - adding 2 GB swap..."
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap -q /swapfile
    swapon /swapfile
    grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    ok "swap enabled"
  fi

  # -- 2. base packages + Docker ----------------------------------------
  log "Installing base packages..."
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl git openssl ufw >/dev/null

  if ! command -v docker >/dev/null 2>&1; then
    log "Installing Docker..."
    curl -fsSL https://get.docker.com | sh
  fi
  docker compose version >/dev/null 2>&1 \
    || die "docker compose plugin missing - run: apt-get install -y docker-compose-plugin"
  ok "Docker $(docker --version | awk '{print $3}' | tr -d ,) ready"

  # -- 3. firewall -------------------------------------------------------
  log "Configuring firewall (open 22/80/443, deny the rest)..."
  ufw allow OpenSSH  >/dev/null 2>&1 || true
  ufw allow 80/tcp   >/dev/null 2>&1 || true
  ufw allow 443/tcp  >/dev/null 2>&1 || true
  ufw --force enable >/dev/null 2>&1 || true
  ok "firewall active"

  # -- 4. public IP + ops/.env ------------------------------------------
  local PUB_IP=""
  PUB_IP="$(curl -4 -s --max-time 6 https://ifconfig.me || true)"
  [ -n "$PUB_IP" ] || PUB_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"

  if [ ! -f "$PROJECT_ROOT/ops/.env" ]; then
    [ -n "$PUB_IP" ] || die "could not detect the public IP - create ops/.env manually (DEPLOYMENT.md section 5)"
    local SITE ORIGIN
    if [ -n "$DOMAIN" ]; then
      SITE="https://$DOMAIN"; ORIGIN="https://$DOMAIN"
    else
      SITE=":80"; ORIGIN="http://$PUB_IP"
    fi
    log "Creating ops/.env with fresh random secrets..."
    cat > "$PROJECT_ROOT/ops/.env" <<EOF
# Generated by scripts/deploy-digitalocean.sh on $(date -u +%F)
# Contains secrets - never commit, never share.
POSTGRES_USER=blasti
POSTGRES_PASSWORD=$(openssl rand -hex 16)
POSTGRES_DB=blasti
NEXTAUTH_SECRET=$(openssl rand -base64 32)
INTERNAL_SECRET=$(openssl rand -base64 32)
CRON_SECRET=$(openssl rand -hex 16)
SITE_ADDRESS=$SITE
CORS_ORIGIN=$ORIGIN
ALLOWED_ORIGINS=$ORIGIN
EOF
    chmod 600 "$PROJECT_ROOT/ops/.env"
    ok "ops/.env created"
  else
    warn "ops/.env already exists - keeping your secrets untouched"
    if [ -n "$DOMAIN" ]; then
      warn "make sure SITE_ADDRESS=https://$DOMAIN and CORS_ORIGIN/ALLOWED_ORIGINS match, then re-run bootstrap"
    fi
  fi

  # -- 5. DNS sanity check (domain mode, best effort) --------------------
  if [ -n "$DOMAIN" ] && [ -n "$PUB_IP" ]; then
    local resolved
    resolved="$(getent hosts "$DOMAIN" 2>/dev/null | awk '{print $1; exit}' || true)"
    if [ -z "$resolved" ]; then
      warn "DNS: $DOMAIN does not resolve yet - add an A record -> $PUB_IP"
      warn "     (plain HTTP will still work on the IP until DNS is ready)"
    elif [ "$resolved" != "$PUB_IP" ]; then
      warn "DNS: $DOMAIN resolves to $resolved but this server is $PUB_IP"
      warn "     Caddy cannot obtain an HTTPS certificate until it points here."
    else
      ok "DNS check passed: $DOMAIN -> $PUB_IP"
    fi
  fi

  # -- 6. build & start ---------------------------------------------------
  log "Building and starting the stack (first build ~5-10 minutes)..."
  ( cd "$PROJECT_ROOT/ops" && docker compose up -d --build )

  # -- 7. health wait ------------------------------------------------------
  log "Waiting for the API health check..."
  local healthy=0 i
  for ((i = 1; i <= 60; i++)); do
    if ( cd "$PROJECT_ROOT/ops" \
         && docker compose exec -T caddy wget -qO- "http://api:3003/api/health" 2>/dev/null \
         | grep -q 'status' ); then
      healthy=1; break
    fi
    sleep 5
  done

  local URL
  if [ -n "$DOMAIN" ]; then URL="https://$DOMAIN"; else URL="http://$PUB_IP"; fi

  if [ "$healthy" -eq 1 ]; then
    ok "API is healthy"
    cat <<EOF

  ============================================================
   BLASTI is UP:   $URL
   Health check:   $URL/api/health

   NEXT STEPS (important):
   1. Sign in and change the default passwords NOW:
        admin / admin123   (platform super-admin)
        owner / owner123   (demo agency owner)
   2. Phone/desktop apps point at:  $URL
      (rebuild the APK with NEXT_PUBLIC_API_URL - DEPLOYMENT.md section 8)
   3. Logs:   cd $PROJECT_ROOT/ops && docker compose logs -f
      Status: cd $PROJECT_ROOT/ops && docker compose ps
  ============================================================
EOF
  else
    warn "API did not become healthy within 5 minutes. Diagnose with:"
    warn "  cd $PROJECT_ROOT/ops && docker compose ps && docker compose logs -f"
    exit 1
  fi
}

# --------------------------------------------------------------------
# MODES: status / logs
# --------------------------------------------------------------------
cmd_status() {
  local TARGET="" PORT=22 REMOTE_DIR="$DEFAULT_REMOTE_DIR"
  while [ $# -gt 0 ]; do
    case "$1" in
      --port) PORT="$2"; shift 2 ;;
      --dir)  REMOTE_DIR="$2"; shift 2 ;;
      --help|-h) usage; exit 0 ;;
      -*) die "status: unknown argument: $1" ;;
      *)  TARGET="$1"; shift ;;
    esac
  done
  [ -n "$TARGET" ] || die "status: use:  $0 status root@DROPLET_IP"
  case "$TARGET" in *@*) ;; *) TARGET="root@$TARGET" ;; esac
  ssh -p "$PORT" -o StrictHostKeyChecking=accept-new "$TARGET" \
    "cd '$REMOTE_DIR' && docker compose ps && docker compose logs --tail=20"
}

cmd_logs() {
  local TARGET="" PORT=22 REMOTE_DIR="$DEFAULT_REMOTE_DIR" SVC=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --port) PORT="$2"; shift 2 ;;
      --dir)  REMOTE_DIR="$2"; shift 2 ;;
      --help|-h) usage; exit 0 ;;
      -*) die "logs: unknown argument: $1" ;;
      *)
        if [ -z "$TARGET" ]; then TARGET="$1"; else SVC="$1"; fi
        shift ;;
    esac
  done
  [ -n "$TARGET" ] || die "logs: use:  $0 logs root@DROPLET_IP [api|web|db|caddy]"
  case "$TARGET" in *@*) ;; *) TARGET="root@$TARGET" ;; esac
  ssh -p "$PORT" -o StrictHostKeyChecking=accept-new "$TARGET" \
    "cd '$REMOTE_DIR' && docker compose logs -f --tail=100 ${SVC:+$SVC}"
}

# --------------------------------------------------------------------
# dispatch
# --------------------------------------------------------------------
MODE="${1:-help}"
shift || true
case "$MODE" in
  create)        cmd_create "$@" ;;
  deploy|update) cmd_deploy "$@" ;;
  bootstrap)     cmd_bootstrap "$@" ;;
  status)        cmd_status "$@" ;;
  logs)          cmd_logs "$@" ;;
  help|-h|--help) usage ;;
  *) die "unknown mode: $MODE (try --help)" ;;
esac
