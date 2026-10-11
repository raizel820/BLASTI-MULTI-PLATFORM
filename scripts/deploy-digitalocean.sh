#!/usr/bin/env bash
# ====================================================================
# BLASTI - DigitalOcean (or any Ubuntu/Debian VPS) one-command deploy
# ====================================================================
# ARCHITECTURE (v2 - "Docker = PostgreSQL only"):
#
#     Internet ──▶ Caddy  :80/:443   (native apt package, auto-HTTPS)
#                    │
#                    ├─ /api/*       ──▶ 127.0.0.1:3003  blasti-api (systemd)
#                    ├─ /socket.io/* ──▶ 127.0.0.1:3003  blasti-api (systemd)
#                    └─ everything   ──▶ 127.0.0.1:3000  blasti-web (systemd)
#
#     Docker runs EXACTLY ONE container:
#         blasti-db  →  PostgreSQL 16   (published on 127.0.0.1:5432 ONLY)
#
#     Code comes from GITHUB: the VPS clones/pulls the repo itself, so a
#     fresh droplet needs nothing except this script.
#
# RUNS ON   : any Ubuntu 22.04+/Debian 12+ droplet (fresh - no node, no bun,
#             no docker needed: the installer adds everything).
# NEEDS     : ssh (built into Windows 10/11, macOS, Linux).
#             `doctl` is ONLY needed for the optional `create` mode.
#
# MODES (run from your own machine unless marked ON-VPS)
#   install      First-time install on a FRESH droplet (clones from GitHub):
#                  ./scripts/deploy-digitalocean.sh install root@203.0.113.10 \
#                      [--domain blasti.example.com] [--branch master]
#   create       Optional: create the droplet with doctl, then install.
#   update       Pull latest code from GitHub + rebuild + restart:
#                  ./scripts/deploy-digitalocean.sh update root@203.0.113.10 \
#                      [--domain blasti.example.com]
#   status       Services overview:      ./scripts/deploy-digitalocean.sh status root@IP
#   logs         Follow one service:     ./scripts/deploy-digitalocean.sh logs root@IP [api|web|db|caddy]
#   backup       Dump Postgres to a local file:
#                  ./scripts/deploy-digitalocean.sh backup root@IP [blasti-2026-01-01.sql]
#   restore      Restore a dump made by `backup`:
#                  ./scripts/deploy-digitalocean.sh restore root@IP blasti-2026-01-01.sql
#
#   server-install / server-update   (ON-VPS helpers - install/update call
#                                     them for you over ssh)
#   server-doctor (ON-VPS) One-command health report. When anything does
#                  not work, run this on the droplet and send the output:
#                    bash blasti-deploy.sh server-doctor
#
#   server-watch-install (ON-VPS) arm the GITHUB AUTO-UPDATER: a systemd
#                  timer (blasti-watcher.timer) checks GitHub every 2 minutes
#                  and deploys any new commit by itself (git pull + rebuild +
#                  restart = server-update). Also armed automatically by
#                  server-install and server-update.
#                    bash blasti-deploy.sh server-watch-install
#   server-watch-disable (ON-VPS) turn the auto-updater off again:
#                    bash blasti-deploy.sh server-watch-disable
#   server-watch-status (ON-VPS) is the auto-updater alive, and did the
#                  droplet already pull + rebuild the latest commit? One
#                  command answers both (timer state + journal + git +
#                  last watcher/deploy heartbeats):
#                    bash blasti-deploy.sh server-watch-status
#
# WHAT server-install DOES ON THE VPS
#   1. apt installs: curl git unzip openssl ufw ca-certificates
#   2. Docker (official installer)  → used ONLY for the PostgreSQL container
#   3. Bun   (bun.sh installer → /usr/local/bin/bun)  → runs the API
#   4. Node 22 (NodeSource → /usr/bin/node)           → runs the Next.js web
#   5. Caddy  (official cloudsmith apt repo)          → HTTPS gateway
#   6. ufw firewall: only 22 (ssh) + 80 + 443 open
#   7. /etc/blasti/blasti.env with RANDOM secrets (never overwritten once it
#      exists) - see the ".env configurations" section of DEPLOY-GUIDE.md
#   8. git clone (or git pull) of the repo into /opt/blasti
#   9. ONE Postgres container (ops/postgres.compose.yml, 127.0.0.1:5432)
#  10. bun install + prisma generate + db push + seed-if-empty
#  11. next build (Node runtime) for the web app
#  12. systemd units blasti-api.service + blasti-web.service (auto-restart)
#  13. /etc/caddy/Caddyfile rendered from ops/Caddyfile (localhost upstreams)
#  14. systemd timer blasti-watcher: auto-deploys new GitHub commits
#  15. waits until GET /api/health is OK, then prints your URLs
#
# DOMAIN + HTTPS
#   Point the DNS A-record at the droplet IP, then run install/update with
#   --domain. Caddy obtains and RENEWS the Let's Encrypt certificate alone.
#   Without a domain everything runs on plain HTTP at the raw IP (testing).
#
# TIP: the GitHub auto-updater is BUILT-IN (blasti-watcher.timer, armed by
#      server-install/server-update) - push to GitHub and the droplet
#      updates itself. See scripts/watch-and-deploy.sh for details.
# ====================================================================
set -euo pipefail

SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
REPO_DEFAULT="https://github.com/raizel820/BLASTI-MULTI-PLATFORM.git"
BRANCH_DEFAULT="master"
DIR_DEFAULT="/opt/blasti"
ENV_FILE="/etc/blasti/blasti.env"

log()  { printf '\033[1;34m[deploy]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[  ok  ]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[ warn ]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[FAIL  ]\033[0m %s\n' "$*" >&2; exit 1; }

usage() { sed -n '2,80p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

ssh_run() { # ssh_run <port> <target> <command...>
  local port="$1" target="$2"; shift 2
  # BatchMode is deliberately OFF: droplets created with password auth must
  # still work (you will be asked for the password once per command).
  ssh -p "$port" -o StrictHostKeyChecking=accept-new "$target" "$*"
}

wait_ssh() { # wait_ssh <ip> <port> <tries>
  local ip="$1" port="$2" tries="$3" i
  for ((i = 1; i <= tries; i++)); do
    if ssh -p "$port" -o StrictHostKeyChecking=accept-new \
         -o ConnectTimeout=8 -o BatchMode=yes "root@$ip" true 2>/dev/null; then
      return 0
    fi
    sleep 5
  done
  return 1
}

# --------------------------------------------------------------------
# Shared argument parsing for install/update (runs on YOUR machine).
# Set PARSE_ALLOW_SECOND=1 to accept one extra positional -> EXTRA
# (used by logs/backup/restore which take a service/file after the target).
# --------------------------------------------------------------------
parse_target_args() { # sets TARGET PORT DOMAIN REPO BRANCH DIR TOKEN [EXTRA]
  TARGET=""; EXTRA=""; PORT=22; DOMAIN=""; REPO="$REPO_DEFAULT"; BRANCH="$BRANCH_DEFAULT"
  DIR="$DIR_DEFAULT"; TOKEN="${GITHUB_TOKEN:-}"
  local allow_second="${PARSE_ALLOW_SECOND:-0}"
  while [ $# -gt 0 ]; do
    case "$1" in
      --port)    PORT="$2";    shift 2 ;;
      --domain)  DOMAIN="$2";  shift 2 ;;
      --repo)    REPO="$2";    shift 2 ;;
      --branch)  BRANCH="$2";  shift 2 ;;
      --dir)     DIR="$2";     shift 2 ;;
      --token)   TOKEN="$2";   shift 2 ;;
      --help|-h) usage; exit 0 ;;
      -*) die "unknown argument: $1 (try --help)" ;;
      *)
        if [ -z "$TARGET" ]; then TARGET="$1"; shift
        elif [ "$allow_second" = "1" ] && [ -z "$EXTRA" ]; then EXTRA="$1"; shift
        else die "only one ssh target allowed (got '$TARGET' and '$1')"; fi
        ;;
    esac
  done
  [ -n "$TARGET" ] || die "missing ssh target - use:  $0 $MODE root@DROPLET_IP"
  case "$TARGET" in *@*) ;; *) TARGET="root@$TARGET" ;; esac
}

# --------------------------------------------------------------------
# MODE: create (optional - needs doctl; then runs `install`)
# --------------------------------------------------------------------
cmd_create() {
  local REGION="ams3" SIZE="s-2vcpu-4gb" NAME="blasti" SSH_KEY="" DOMAIN="" ASSUME_YES=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --region)  REGION="$2";  shift 2 ;;
      --size)    SIZE="$2";    shift 2 ;;
      --name)    NAME="$2";    shift 2 ;;
      --ssh-key) SSH_KEY="$2"; shift 2 ;;
      --domain)  DOMAIN="$2";  shift 2 ;;
      --yes)     ASSUME_YES=1; shift ;;
      --help|-h) usage; exit 0 ;;
      *) die "create: unknown argument: $1 (try --help)" ;;
    esac
  done

  command -v doctl >/dev/null 2>&1 || die "doctl is not installed.
Install it:  https://docs.digitalocean.com/reference/doctl/how-to/install/
  brew install doctl | snap install doctl | choco install doctl
Then run:  doctl auth init
Or skip doctl: create the droplet on the DO website (DEPLOY-GUIDE.md Part 2),
then run:  $0 install root@DROPLET_IP"

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
https://cloud.digitalocean.com/account/security
(or create the droplet with a root PASSWORD on the website and use:  $0 install root@IP)"
    fi
  else
    case "$SSH_KEY" in
      ''|*[!0-9]*)
        local resolved
        resolved="$(doctl compute ssh-key list --no-header --format ID,Name \
                    | awk -v n="$SSH_KEY" '$2==n{print $1; exit}')"
        [ -n "$resolved" ] || die "SSH key named '$SSH_KEY' not found (doctl compute ssh-key list)"
        SSH_KEY="$resolved" ;;
    esac
  fi

  if [ "$ASSUME_YES" -ne 1 ]; then
    printf "Create droplet '%s' (%s, %s) and install BLASTI on it? [y/N] " "$NAME" "$SIZE" "$REGION"
    read -r REPLY
    case "$REPLY" in y|Y|yes|Yes) ;; *) die "aborted" ;; esac
  fi

  log "Creating droplet '$NAME' ($SIZE, $REGION) - waiting until active..."
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
  ok "droplet '$NAME' is active at $IP  <-- WRITE THIS DOWN"

  log "Waiting for SSH (root@$IP)..."
  wait_ssh "$IP" 22 36 \
    || die "SSH not reachable yet - wait a minute, then run:  $0 install root@$IP ${DOMAIN:+--domain $DOMAIN}"

  if [ -n "$DOMAIN" ]; then
    warn "remember the DNS A-record:  $DOMAIN  ->  $IP  (required for HTTPS)"
  fi

  exec "$SELF" install "root@$IP" --port 22 ${DOMAIN:+--domain "$DOMAIN"}
}

# --------------------------------------------------------------------
# MODE: install (from YOUR machine; streams this script over ssh)
# --------------------------------------------------------------------
cmd_install() {
  parse_target_args "$@"
  command -v ssh >/dev/null 2>&1 || die "ssh not found (Windows: use PowerShell or Git Bash - both ship ssh)"

  log "Installing BLASTI on $TARGET (code will be pulled from GitHub)"
  log "If the droplet uses a PASSWORD, type it when ssh asks (once)."
  local remote="bash -s -- server-install --repo '$REPO' --branch '$BRANCH' --dir '$DIR'"
  [ -n "$DOMAIN" ] && remote+=" --domain '$DOMAIN'"
  [ -n "$TOKEN" ]  && remote+=" --token '$TOKEN'"

  # shellcheck disable=SC2029
  ssh -p "$PORT" -o StrictHostKeyChecking=accept-new "$TARGET" "$remote" < "$SELF"
  # server-install prints the final summary itself
}

# --------------------------------------------------------------------
# MODE: update (from YOUR machine; one ssh call, runs server-update)
# --------------------------------------------------------------------
cmd_update() {
  parse_target_args "$@"
  log "Updating BLASTI on $TARGET (git pull from GitHub + rebuild + restart)"
  local remote="cd '$DIR' && bash scripts/deploy-digitalocean.sh server-update"
  [ -n "$DOMAIN" ] && remote+=" --domain '$DOMAIN'"
  ssh_run "$PORT" "$TARGET" "$remote"
}

# --------------------------------------------------------------------
# ON-VPS helper: where is the project? (stdin-runs default to /opt/blasti)
# --------------------------------------------------------------------
resolve_project_root() {
  if [ -n "${PROJECT_ROOT:-}" ] && [ -f "$PROJECT_ROOT/ops/postgres.compose.yml" ]; then
    return 0
  fi
  local script_dir=""
  script_dir="$(cd "$(dirname "${BASH_SOURCE[1]:-.}")" 2>/dev/null && pwd || true)"
  if [ -n "$script_dir" ] && [ -f "$script_dir/../ops/postgres.compose.yml" ]; then
    PROJECT_ROOT="$(cd "$script_dir/.." && pwd)"
  else
    PROJECT_ROOT="$DIR_DEFAULT"
  fi
}

require_root() {
  [ "$(id -u)" -eq 0 ] || die "must run as root. ssh in and run:
  sudo bash scripts/deploy-digitalocean.sh $1"
}

# --------------------------------------------------------------------
# ON-VPS: write/update one KEY=VALUE line in the env file
# --------------------------------------------------------------------
env_set() { # env_set <file> <KEY> <value>
  local file="$1" key="$2" value="$3"
  if grep -q "^${key}=" "$file" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

# --------------------------------------------------------------------
# ON-VPS: locate the Next.js CLI inside bun's node_modules layout
# --------------------------------------------------------------------
resolve_next_bin() { # prints absolute path; callers decide how to exec it
  local root="$1"
  local p
  for p in \
    "$root/apps/web/node_modules/next/dist/bin/next" \
    "$root/node_modules/next/dist/bin/next"; do
    [ -f "$p" ] && { printf '%s' "$p"; return 0; }
  done
  for p in \
    "$root/apps/web/node_modules/.bin/next" \
    "$root/node_modules/.bin/next"; do
    [ -e "$p" ] && { printf '%s' "$p"; return 0; }
  done
  return 1
}

run_next() { # run_next <bin> <args...>  (node for the JS entry, direct for shims)
  local bin="$1"; shift
  case "$bin" in
    */dist/bin/next) node "$bin" "$@" ;;
 *) "$bin" "$@" ;;
  esac
}

# --------------------------------------------------------------------
# ON-VPS: build the web app exactly like the production Docker image
# (empty NEXT_PUBLIC_API_URL = same-origin calls through Caddy)
# --------------------------------------------------------------------
build_web() {
  local root="$1" next_bin
  next_bin="$(resolve_next_bin "$root")" || die "Next.js CLI not found under $root (did bun install run?)"
  log "Building the web app (next build on Node - takes a few minutes)..."
  ( cd "$root/apps/web" \
      && NEXT_PUBLIC_API_URL="" NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 \
         run_next "$next_bin" build )
  ok "web app built"
}

# --------------------------------------------------------------------
# ON-VPS: prisma generate + db push + seed-if-empty (safe: seed skips when
# users already exist - data is never wiped)
# --------------------------------------------------------------------
migrate_db() {
  local root="$1"
  log "Applying database schema (prisma generate + db push + seed-if-empty)..."
  set -a; . "$ENV_FILE"; set +a
  ( cd "$root/packages/db" \
      && bun run db:generate \
      && bun run db:push \
      && bun run db:seed-if-empty )
  ok "database ready"
}

# --------------------------------------------------------------------
# ON-VPS: render /etc/caddy/Caddyfile from the repo template
# (docker service names -> 127.0.0.1 upstreams)
# --------------------------------------------------------------------
render_caddyfile() {
  local root="$1" site="$2"
  [ -f "$root/ops/Caddyfile" ] || die "ops/Caddyfile missing in $root"
  mkdir -p /etc/caddy
  sed -e "s|{\$SITE_ADDRESS}|${site}|g" \
      -e 's|reverse_proxy api:3003|reverse_proxy 127.0.0.1:3003|g' \
      -e 's|reverse_proxy web:3000|reverse_proxy 127.0.0.1:3000|g' \
      "$root/ops/Caddyfile" > /etc/caddy/Caddyfile
}

# --------------------------------------------------------------------
# ON-VPS: wait for the API to answer on the loopback
# --------------------------------------------------------------------
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

# --------------------------------------------------------------------
# ON-VPS: make sure a DEPLOY_TOKEN exists in the env file (shared
# secret used by the GitHub watcher + CI to authenticate heartbeats
# and installer uploads against the API). Older droplets get it
# automatically on the next server-update - never overwrites.
# --------------------------------------------------------------------
ensure_deploy_token() {
  [ -f "$ENV_FILE" ] || return 0
  if ! grep -q '^DEPLOY_TOKEN=' "$ENV_FILE" 2>/dev/null; then
    printf '\n# Shared token: GitHub auto-updater heartbeats + CI installer uploads\nDEPLOY_TOKEN=%s\n' "$(openssl rand -hex 24)" >> "$ENV_FILE"
    ok "DEPLOY_TOKEN added to $ENV_FILE (watcher/CI auth)"
  fi
}

# --------------------------------------------------------------------
# ON-VPS: report a deploy result to the API (deploy-status card in the
# admin panel). Best-effort: if the API is down (failed deploy) the
# POST is silently skipped.
# --------------------------------------------------------------------
post_deploy_heartbeat() { # <status:success|failure> <commit> <duration_sec> <message>
  local status="$1" commit="$2" duration="$3" message="$4"
  local api_url token
  case "$duration" in '' | *[!0-9]*) duration=0 ;; esac
  api_url="$(grep '^INTERNAL_API_URL=' "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"')"
  api_url="${api_url:-http://127.0.0.1:3003}"
  token="$(grep '^DEPLOY_TOKEN=' "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"')"
  [ -n "$token" ] || return 0
  curl -fsS -m 5 -X POST "$api_url/api/system/deploy-heartbeat" \
    -H 'Content-Type: application/json' -H "x-deploy-token: $token" \
    -d "{\"kind\":\"deploy-result\",\"status\":\"$status\",\"commit\":\"$commit\",\"durationSec\":$duration,\"message\":\"$message\"}" \
    >/dev/null 2>&1 || true
}

print_summary() { # print_summary <site-url> <ip> <domain>
  local url="$1" ip="$2" domain="$3"
  cat <<EOF

  ============================================================
   BLASTI is UP on this droplet.

   Web app      :  $url
   API health   :  $url/api/health
   Server IP    :  $ip

   NEXT STEPS:
   1. Open the web app, log in and CHANGE the default passwords:
        admin / admin123        (platform super-admin)
        owner / owner123        (demo agency owner)
   2. Desktop / phone apps point at the bare origin (no /api!):
        BLASTI_CLOUD_URL="$url"
      (desktop: apps/desktop/.env in dev, or
       %LOCALAPPDATA%\\Programs\\BLASTI\\resources\\.env when installed)
   3. With a domain: make sure the DNS A-record -> $ip, then re-run
      install/update with --domain to switch on automatic HTTPS.
   4. Useful commands (on this server):
        systemctl status blasti-api blasti-web caddy
        journalctl -u blasti-api -n 50 --no-pager
        docker logs --tail 50 blasti-db
        cat $ENV_FILE        (all .env configuration lives here)
   5. AUTO-UPDATES are ON: pushing to GitHub deploys itself within
      ~2 minutes (blasti-watcher.timer). Turn off with:
        systemctl disable --now blasti-watcher.timer
  ============================================================
EOF
}

# --------------------------------------------------------------------
# ON-VPS: (re)write the blasti-api / blasti-web systemd units.
# Called by server-install AND server-update, so unit changes ship to
# existing droplets with a plain `git pull` + server-update.
# --------------------------------------------------------------------
write_systemd_units() {
  local root="$1"
  local NEXT_BIN WEB_START
  NEXT_BIN="$(resolve_next_bin "$root")" || die "Next.js CLI not found after bun install"
  case "$NEXT_BIN" in
    */dist/bin/next) WEB_START="/usr/bin/node $NEXT_BIN start -H 127.0.0.1 -p 3000" ;;
    *)               WEB_START="$NEXT_BIN start -H 127.0.0.1 -p 3000" ;;
  esac

  # The API unit declares ReadWritePaths on this directory: it MUST exist,
  # otherwise systemd fails the unit with a mount-namespacing error.
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

# --------------------------------------------------------------------
# ON-VPS: GitHub auto-updater - a systemd timer that checks GitHub for
# new commits every 2 minutes and runs server-update when one lands.
# Idempotent: safe to call from server-install AND server-update.
# --------------------------------------------------------------------
install_auto_update_watcher() {
  local root="$1"
  if [ ! -f "$root/scripts/watch-and-deploy.sh" ]; then
    warn "scripts/watch-and-deploy.sh not found - GitHub auto-updater NOT installed"
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
# a full rebuild can take a while on small droplets - never kill it mid-build
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
  ok "auto-updater armed (blasti-watcher.timer) - push to GitHub and the droplet updates itself"
  ok "turn it off anytime with:  bash $SELF server-watch-disable"
  ok "check it anytime with:     bash $SELF server-watch-status"
}

# --------------------------------------------------------------------
# MODE: server-install (runs ON the VPS, as root)
# --------------------------------------------------------------------
cmd_server_install() {
  local DOMAIN="" REPO="$REPO_DEFAULT" BRANCH="$BRANCH_DEFAULT" DIR="$DIR_DEFAULT" TOKEN="${GITHUB_TOKEN:-}"
  while [ $# -gt 0 ]; do
    case "$1" in
      --domain) DOMAIN="$2";  shift 2 ;;
      --repo)   REPO="$2";    shift 2 ;;
      --branch) BRANCH="$2";  shift 2 ;;
      --dir)    DIR="$2";     shift 2 ;;
      --token)  TOKEN="$2";   shift 2 ;;
      --help|-h) usage; exit 0 ;;
      *) die "server-install: unknown argument: $1 (try --help)" ;;
    esac
  done
  require_root "server-install"
  # serialize with the auto-updater / other manual runs - two builds at once
  # would OOM a small droplet
  mkdir -p /run/lock
  exec 8>/run/lock/blasti-update.lock
  flock -n 8 || die "another install/update is already running (auto-updater busy?) - try again in a few minutes"
  export DEBIAN_FRONTEND=noninteractive

  log "BLASTI server-install starting on $(hostname)..."

  # -- 1. swap on small droplets (the Next.js build needs headroom) ------
  local mem_mb swap_lines
  mem_mb="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)"
  swap_lines="$(swapon --noheadings --show 2>/dev/null | grep -c . || true)"
  if [ "${mem_mb:-0}" -lt 4000 ] && [ "${swap_lines:-0}" -eq 0 ] && [ ! -f /swapfile ]; then
    log "Small droplet (${mem_mb} MB RAM) - adding 2 GB swap..."
    fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap -q /swapfile && swapon /swapfile
    grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    ok "swap enabled"
  fi

  # -- 2. base packages ---------------------------------------------------
  log "Installing base packages (curl git unzip openssl ufw gnupg)..."
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl git unzip openssl ufw gnupg debian-keyring \
    debian-archive-keyring apt-transport-https >/dev/null
  ok "base packages ready"

  # -- 3. Docker (used ONLY for the PostgreSQL container) -----------------
  if ! command -v docker >/dev/null 2>&1; then
    log "Installing Docker (this runs ONLY the PostgreSQL container)..."
    curl -fsSL https://get.docker.com | sh >/dev/null 2>&1
  fi
  docker compose version >/dev/null 2>&1 \
    || die "docker compose plugin missing - run: apt-get install -y docker-compose-plugin"
  ok "Docker $(docker --version | awk '{print $3}' | tr -d ,) ready (postgres-only duty)"

  # -- 4. Bun (API runtime) ------------------------------------------------
  if ! command -v bun >/dev/null 2>&1; then
    log "Installing Bun -> /usr/local/bin/bun ..."
    curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash >/dev/null 2>&1
  fi
  command -v bun >/dev/null 2>&1 || die "bun not found after install - check network and re-run"
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

  # -- 7. firewall: only ssh + http + https ---------------------------------
  log "Configuring firewall (open 22/80/443, deny the rest)..."
  ufw allow OpenSSH >/dev/null 2>&1 || true
  ufw allow 80/tcp  >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
  ufw --force enable >/dev/null 2>&1 || true
  ok "firewall active"

  # -- 8. public IP + /etc/blasti/blasti.env (the ONE .env configuration) ---
  local PUB_IP=""
  PUB_IP="$(curl -4 -s --max-time 6 https://ifconfig.me || true)"
  [ -n "$PUB_IP" ] || PUB_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"

  mkdir -p /etc/blasti
  if [ ! -f "$ENV_FILE" ]; then
    log "Creating $ENV_FILE with RANDOM secrets..."
    local PG_PW
    PG_PW="$(openssl rand -hex 16)"
    cat > "$ENV_FILE" <<EOF
# ══════════════════════════════════════════════════════════════
# BLASTI VPS environment - generated by deploy-digitalocean.sh
# Full documentation: DEPLOY-GUIDE.md  ->  ".env configurations"
# Edit with:  nano $ENV_FILE   then:  systemctl restart blasti-api blasti-web
# Secrets below are random - NEVER commit this file, never share it.
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
    warn "$ENV_FILE already exists - keeping your secrets untouched"
  fi

  # public address (CORS + Caddy site). --domain wins on every run.
  local SITE ORIGIN
  if [ -n "$DOMAIN" ]; then
    SITE="https://$DOMAIN"; ORIGIN="https://$DOMAIN"
  else
    [ -n "$PUB_IP" ] || die "could not detect the public IP - pass --domain or set SITE_ADDRESS manually in $ENV_FILE"
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
      warn "DNS: $DOMAIN does not resolve yet - add an A record -> $PUB_IP"
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
    log "Repo already at $DIR - fetching latest $BRANCH from GitHub..."
    git -C "$DIR" remote set-url origin "$clone_url"
    git -C "$DIR" fetch origin "$BRANCH"
    git -C "$DIR" reset --hard FETCH_HEAD
  else
    log "Cloning $REPO ($BRANCH) -> $DIR ..."
    mkdir -p "$DIR"
    git clone --depth 1 --branch "$BRANCH" "$clone_url" "$DIR" \
      || die "git clone failed - check the repo URL/branch${TOKEN:+ and token}"
  fi
  [ -n "$TOKEN" ] && warn "note: the GitHub token is stored in $DIR/.git/config (needed for future pulls)"
  ok "code ready at $DIR"

  # -- 11. PostgreSQL container (the ONLY Docker container) -------------------
  log "Starting the PostgreSQL container (127.0.0.1:5432 only)..."
  docker compose -f "$DIR/ops/postgres.compose.yml" --env-file "$ENV_FILE" up -d
  local i state=""
  for ((i = 1; i <= 30; i++)); do
    state="$(docker inspect -f '{{.State.Health.Status}}' blasti-db 2>/dev/null || true)"
    [ "$state" = "healthy" ] && break
    sleep 2
  done
  [ "$state" = "healthy" ] || die "postgres container did not become healthy - run: docker logs blasti-db"
  ok "PostgreSQL healthy (blasti-db on 127.0.0.1:5432)"

  # -- 12. dependencies + database schema --------------------------------------
  log "Installing JS dependencies (bun install - a few minutes on first run)..."
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
    || die "generated Caddyfile is invalid - inspect /etc/caddy/Caddyfile"
  systemctl enable --now caddy >/dev/null 2>&1 || true
  systemctl restart caddy
  ok "Caddy running on 80/443"

  # -- 15b. GitHub auto-updater (deploy new commits automatically) ------------
  install_auto_update_watcher "$DIR"

  # -- 16. health check ---------------------------------------------------------------
  if wait_healthy; then
    local URL
    if [ -n "$DOMAIN" ]; then URL="https://$DOMAIN"; else URL="http://$PUB_IP"; fi
    print_summary "$URL" "${PUB_IP:-?}" "$DOMAIN"
  else
    warn "API did not become healthy within 3 minutes. Diagnose with:"
    warn "  systemctl status blasti-api blasti-web"
    warn "  journalctl -u blasti-api -n 50 --no-pager"
    exit 1
  fi
}

# --------------------------------------------------------------------
# MODE: server-update (runs ON the VPS, as root)
# --------------------------------------------------------------------
cmd_server_update() {
  local DOMAIN="" deploy_started deployed_commit
  deploy_started="$(date +%s)"
  while [ $# -gt 0 ]; do
    case "$1" in
      --domain) DOMAIN="$2"; shift 2 ;;
      --help|-h) usage; exit 0 ;;
      *) die "server-update: unknown argument: $1 (try --help)" ;;
    esac
  done
  require_root "server-update"
  # serialize with the auto-updater / other manual runs - two builds at once
  # would OOM a small droplet
  mkdir -p /run/lock
  exec 8>/run/lock/blasti-update.lock
  flock -n 8 || die "another install/update is already running (auto-updater busy?) - try again in a few minutes"
  resolve_project_root
  local root="$PROJECT_ROOT"
  [ -d "$root/.git" ] || die "no git repo at $root - run server-install first"
  [ -f "$ENV_FILE" ] || die "$ENV_FILE missing - run server-install first"

  log "BLASTI server-update starting (branch: $(git -C "$root" rev-parse --abbrev-ref HEAD 2>/dev/null || echo master))..."

  # -- 1. latest code from GitHub (untracked files like uploads survive) ------
  local branch
  branch="$(git -C "$root" rev-parse --abbrev-ref HEAD 2>/dev/null || echo master)"
  [ "$branch" = "HEAD" ] && branch="master"
  git -C "$root" fetch origin "$branch"
  git -C "$root" reset --hard FETCH_HEAD
  ok "code updated to $(git -C "$root" rev-parse --short HEAD)"
  deployed_commit="$(git -C "$root" rev-parse HEAD 2>/dev/null || echo "")"

  # -- 2. dependencies + schema + build ----------------------------------------
  ( cd "$root" && bun install )
  migrate_db "$root"
  build_web "$root"

  # -- 3. optional domain switch (updates CORS + Caddy site) --------------------
  if [ -n "$DOMAIN" ]; then
    env_set "$ENV_FILE" SITE_ADDRESS "https://$DOMAIN"
    env_set "$ENV_FILE" CORS_ORIGIN "https://$DOMAIN"
    env_set "$ENV_FILE" ALLOWED_ORIGINS "https://$DOMAIN"
    warn "domain set to $DOMAIN - make sure the DNS A-record points at this server"
  fi

  # -- 4. refresh systemd units (ships unit changes to existing droplets) --------
  write_systemd_units "$root"
  systemctl daemon-reload

  # -- 4b. keep the GitHub auto-updater armed + its unit fresh (idempotent) -------
  install_auto_update_watcher "$root"

  # -- 4c. watcher/CI shared token (idempotent; must exist BEFORE restart so
  #        the API can authenticate heartbeats and CI installer uploads) ------
  ensure_deploy_token

  # -- 5. restart services + re-render Caddy (ships ops/Caddyfile changes) ------
  local SITE
  SITE="$(grep '^SITE_ADDRESS=' "$ENV_FILE" | cut -d= -f2- || true)"
  [ -n "$SITE" ] || SITE=":80"
  render_caddyfile "$root" "$SITE"
  systemctl restart blasti-api.service blasti-web.service caddy
  ok "services restarted (api, web, caddy)"

  if wait_healthy; then
    local PUB_IP ORIGIN_URL
    PUB_IP="$(curl -4 -s --max-time 6 https://ifconfig.me || hostname -I 2>/dev/null | awk '{print $1}')"
    case "$SITE" in
      https://*) ORIGIN_URL="$SITE" ;;
      *)         ORIGIN_URL="http://${PUB_IP:-<server-ip>}" ;;
    esac
    print_summary "$ORIGIN_URL" "${PUB_IP:-?}" "$DOMAIN"
    post_deploy_heartbeat success "$deployed_commit" "$(( $(date +%s) - deploy_started ))" \
      "server-update ok (git pull + rebuild + restart)"
  else
    warn "API not healthy after update. Diagnose with:"
    warn "  journalctl -u blasti-api -n 50 --no-pager && systemctl status blasti-api"
    post_deploy_heartbeat failure "$deployed_commit" "$(( $(date +%s) - deploy_started ))" \
      "server-update finished but API health check failed"
    exit 1
  fi
}

# --------------------------------------------------------------------
# MODES: status / logs / backup / restore
# --------------------------------------------------------------------
cmd_status() {
  parse_target_args "$@"
  ssh_run "$PORT" "$TARGET" "
    echo '── services ──────────────────────────────────────────'
    systemctl is-active blasti-api blasti-web caddy docker 2>/dev/null
    echo '── blasti-db container ───────────────────────────────'
    docker ps --filter name=blasti-db --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null
    echo '── health ────────────────────────────────────────────'
    curl -fsS --max-time 4 http://127.0.0.1:3003/api/health 2>/dev/null || echo 'API NOT HEALTHY'
    echo
    echo '── disk / memory ─────────────────────────────────────'
    df -h / | tail -1; free -h | head -2
  "
}

cmd_logs() {
  PARSE_ALLOW_SECOND=1 parse_target_args "$@"
  local SVC="${EXTRA:-api}"
  case "$SVC" in
    api)   ssh_run "$PORT" "$TARGET" "journalctl -u blasti-api -n 100 --no-pager" ;;
    web)   ssh_run "$PORT" "$TARGET" "journalctl -u blasti-web -n 100 --no-pager" ;;
    caddy) ssh_run "$PORT" "$TARGET" "journalctl -u caddy -n 100 --no-pager" ;;
    db)    ssh_run "$PORT" "$TARGET" "docker logs --tail 100 blasti-db" ;;
    *)     die "unknown service '$SVC' (use: api | web | db | caddy)" ;;
  esac
}

cmd_backup() {
  PARSE_ALLOW_SECOND=1 parse_target_args "$@"
  local OUT="${EXTRA:-blasti-$(date +%F).sql}"
  log "Dumping the database to $OUT (local file on YOUR machine)..."
  ssh_run "$PORT" "$TARGET" "docker exec blasti-db pg_dump -U \$(grep '^POSTGRES_USER=' $ENV_FILE | cut -d= -f2) \$(grep '^POSTGRES_DB=' $ENV_FILE | cut -d= -f2)" > "$OUT"
  ok "backup written: $OUT ($(du -h "$OUT" | cut -f1))"
}

cmd_restore() {
  PARSE_ALLOW_SECOND=1 parse_target_args "$@"
  local FILE="${EXTRA:-}"
  [ -n "$FILE" ] && [ -f "$FILE" ] || die "restore: give a dump file -  $0 restore root@IP blasti-2026-01-01.sql"
  log "Restoring $FILE into the VPS database (overwrites current data!)..."
  printf 'Type YES to continue: '
  read -r REPLY
  case "$REPLY" in YES|yes) ;; *) die "aborted" ;; esac
  ssh_run "$PORT" "$TARGET" "docker exec -i blasti-db psql -U \$(grep '^POSTGRES_USER=' $ENV_FILE | cut -d= -f2) -d \$(grep '^POSTGRES_DB=' $ENV_FILE | cut -d= -f2)" < "$FILE"
  ssh_run "$PORT" "$TARGET" "systemctl restart blasti-api blasti-web"
  ok "restore finished - services restarted"
}

# --------------------------------------------------------------------
# MODE: server-doctor (runs ON the VPS, as root) - full health report.
# Prints everything needed to diagnose a stuck deployment in one paste.
# NEVER prints secret values from the env file - key names only.
# --------------------------------------------------------------------
cmd_server_doctor() {
  local DIR="${DIR_DEFAULT:-/opt/blasti}"
  echo "════════════════════════════════════════════════════════════"
  echo " BLASTI server-doctor report - $(date '+%F %T %Z')"
  echo "════════════════════════════════════════════════════════════"

  echo; echo "── 1. code version ($DIR) ──────────────────────────"
  if [ -d "$DIR/.git" ]; then
    git -C "$DIR" fetch origin master >/dev/null 2>&1 || true
    echo "local : $(git -C "$DIR" rev-parse --short HEAD 2>/dev/null) $(git -C "$DIR" log -1 --format=%s 2>/dev/null)"
    echo "github: $(git -C "$DIR" rev-parse --short origin/master 2>/dev/null)"
  else
    echo "MISSING: no git repo at $DIR"
  fi

  echo; echo "── 2. services ────────────────────────────────────────"
  for svc in blasti-api blasti-web caddy docker; do
    printf '%-12s %s\n' "$svc" "$(systemctl is-active "$svc" 2>/dev/null)"
  done
  systemctl show blasti-api -p ExecMainStatus -p ExecMainStartTimestamp -p NRestarts 2>/dev/null
  printf '%-12s %s/%s\n' "auto-update" \
    "$(systemctl is-active blasti-watcher.timer 2>/dev/null || echo '?')" \
    "$(systemctl is-enabled blasti-watcher.timer 2>/dev/null || echo '?')"
  systemctl show blasti-watcher.service -p ExecMainStatus -p ExecMainExitTimestamp 2>/dev/null || true

  echo; echo "── 3. blasti-api unit (key lines) ─────────────────────"
  grep -E 'ExecStart|WorkingDirectory|ReadWritePaths|EnvironmentFile' /etc/systemd/system/blasti-api.service 2>/dev/null || echo "unit file missing!"

  echo; echo "── 4. uploads directory ───────────────────────────────"
  ls -ld "$DIR/apps/api/uploads" 2>&1 || true

  echo; echo "── 5. ports listening ─────────────────────────────────"
  ss -tlnp 2>/dev/null | grep -E ':(80|443|3000|3003|5432)\b' || netstat -tlnp 2>/dev/null | grep -E ':(80|443|3000|3003|5432)\b' || echo "could not list ports"

  echo; echo "── 6. PostgreSQL container ────────────────────────────"
  docker ps --filter name=blasti-db --format '{{.Names}}  {{.Status}}  {{.Ports}}' 2>/dev/null || true
  docker logs --tail 5 blasti-db 2>&1 | tail -5 || true

  echo; echo "── 7. direct health checks (loopback) ─────────────────"
  printf 'api  :3003 -> '; curl -fsS -m 4 http://127.0.0.1:3003/api/health 2>/dev/null | head -c 200 || echo 'FAILED / no answer'
  echo
  printf 'web  :3000 -> '; curl -fsS -m 4 -o /dev/null -w 'HTTP %{http_code}' http://127.0.0.1:3000/ 2>/dev/null || echo 'FAILED / no answer'
  echo
  printf 'caddy:80   -> '; curl -fsS -m 4 http://127.0.0.1/api/health 2>/dev/null | head -c 200 || echo 'FAILED / no answer'
  echo

  echo; echo "── 8. blasti-api logs (last 30 lines) ─────────────────"
  journalctl -u blasti-api -n 30 --no-pager 2>/dev/null | tail -30 || true

  echo; echo "── 9. blasti-web logs (last 8 lines) ──────────────────"
  journalctl -u blasti-web -n 8 --no-pager 2>/dev/null | tail -8 || true

  echo; echo "── 10. memory / disk ──────────────────────────────────"
  free -m | head -2
  df -h / | tail -1

  echo; echo "── 11. env file keys (values hidden) ──────────────────"
  [ -f "$ENV_FILE" ] && grep -oE '^[A-Z_]+' "$ENV_FILE" | sort | tr '\n' ' ' || echo "$ENV_FILE missing!"
  echo
  echo "════════════════════════════ end of report ═════════════════════"
}

# --------------------------------------------------------------------
# MODES: server-watch-install / server-watch-disable (ON-VPS, as root)
# Arm / disarm the GitHub auto-updater (blasti-watcher.timer).
# --------------------------------------------------------------------
cmd_server_watch_install() {
  require_root "server-watch-install"
  resolve_project_root
  local root="$PROJECT_ROOT"
  [ -d "$root/.git" ] || die "no git repo at $root - run server-install first"
  install_auto_update_watcher "$root"
  echo
  systemctl --no-pager --full status blasti-watcher.timer 2>/dev/null | head -8 || true
  echo
  ok "from now on: every 'git push' to the repo deploys itself within ~2 minutes."
  ok "watch it live:   journalctl -u blasti-watcher.service -f"
  ok "turn it off:     bash $SELF server-watch-disable"
}

cmd_server_watch_disable() {
  require_root "server-watch-disable"
  systemctl disable --now blasti-watcher.timer 2>/dev/null || true
  systemctl daemon-reload
  ok "GitHub auto-updater is OFF (blasti-watcher.timer disabled)."
  ok "updates are manual again:  bash blasti-deploy.sh server-update"
  ok "re-enable with:            bash blasti-deploy.sh server-watch-install"
}

# --------------------------------------------------------------------
# MODE: server-watch-status (runs ON the VPS) - answer in one command:
#   1. is the GitHub auto-updater timer alive + when did it last fire?
#   2. is the local checkout behind GitHub (new commit pending)?
#   3. what did the last deploy do (from the watcher/deploy heartbeats
#      stored by the API in its SystemSetting table)?
# --------------------------------------------------------------------
cmd_server_watch_status() {
  local DIR="${DIR_DEFAULT:-/opt/blasti}"
  echo "════════════════════════════════════════════════════════════"
  echo " BLASTI auto-update status - $(date '+%F %T %Z')"
  echo "════════════════════════════════════════════════════════════"

  echo; echo "── 1. systemd timer (blasti-watcher) ──────────────"
  printf 'timer state    : %s / %s\n' \
    "$(systemctl is-active blasti-watcher.timer 2>/dev/null || echo '?')" \
    "$(systemctl is-enabled blasti-watcher.timer 2>/dev/null || echo '?')"
  systemctl show blasti-watcher.timer -p LastTriggerUSec -p NextElapseUSecRealtime 2>/dev/null
  printf 'last check     : exit=%s at %s\n' \
    "$(systemctl show blasti-watcher.service -p ExecMainStatus --value 2>/dev/null || echo '?')" \
    "$(systemctl show blasti-watcher.service -p ExecMainExitTimestamp --value 2>/dev/null || echo '?')"

  echo; echo "── 2. watcher journal (last 12 lines) ───────────────"
  journalctl -u blasti-watcher.service -n 12 --no-pager 2>/dev/null | tail -12 || echo "no journal yet"

  echo; echo "── 3. code version ($DIR) vs GitHub ──────────"
  if [ -d "$DIR/.git" ]; then
    git -C "$DIR" fetch origin master >/dev/null 2>&1 || true
    local local_sha remote_sha
    local_sha="$(git -C "$DIR" rev-parse --short HEAD 2>/dev/null || echo '?')"
    remote_sha="$(git -C "$DIR" rev-parse --short origin/master 2>/dev/null || echo '?')"
    echo "deployed : $local_sha $(git -C "$DIR" log -1 --format=%s 2>/dev/null)"
    echo "github   : $remote_sha"
    if [ "$local_sha" = "$remote_sha" ]; then
      ok "up to date - the droplet already has the latest master"
    else
      warn "BEHIND - a new commit exists; the watcher will deploy it on its next check (or run: bash $SELF server-update)"
    fi
  else
    warn "no git repo at $DIR"
  fi

  echo; echo "── 4. last heartbeats stored by the API ─────────────"
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -q blasti-db; then
    local pg_user pg_db
    pg_user="$(grep '^POSTGRES_USER=' "$ENV_FILE" 2>/dev/null | cut -d= -f2-)"
    pg_db="$(grep '^POSTGRES_DB=' "$ENV_FILE" 2>/dev/null | cut -d= -f2-)"
    pg_user="${pg_user:-blasti}"; pg_db="${pg_db:-blasti}"
    for key in deploy.watcher.lastCheck deploy.last; do
      printf '%s:\n  ' "$key"
      docker exec blasti-db psql -U "$pg_user" -d "$pg_db" -Atc \
        "select value from \"SystemSetting\" where key='$key'" 2>/dev/null \
        || echo '(unavailable)'
      echo
    done
    echo 'recent events:'
    docker exec blasti-db psql -U "$pg_user" -d "$pg_db" -Atc \
      "select value from \"SystemSetting\" where key='deploy.events'" 2>/dev/null \
      | head -c 2000 || true
    echo
  else
    warn "blasti-db container not running - cannot read heartbeats (API still starting?)"
  fi
  echo
  echo "hint: the same status is visible in the web admin panel:"
  echo "      Public Apps Settings -> Auto-Deploy & Watcher Status"
}

# --------------------------------------------------------------------
# dispatch
# --------------------------------------------------------------------
MODE="${1:-help}"
shift || true
case "$MODE" in
  create)              cmd_create "$@" ;;
  install|init)        cmd_install "$@" ;;
  update|deploy)       cmd_update "$@" ;;
  server-install)      cmd_server_install "$@" ;;
  server-update)       cmd_server_update "$@" ;;
  server-doctor)       cmd_server_doctor "$@" ;;
  server-watch-install) cmd_server_watch_install "$@" ;;
  server-watch-disable) cmd_server_watch_disable "$@" ;;
  server-watch-status)  cmd_server_watch_status "$@" ;;
  status)              cmd_status "$@" ;;
  logs)                cmd_logs "$@" ;;
  backup)              cmd_backup "$@" ;;
  restore)             cmd_restore "$@" ;;
  help|-h|--help)      usage ;;
  *) die "unknown mode: $MODE (try --help)" ;;
esac
