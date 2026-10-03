#!/usr/bin/env bash
# ====================================================================
# BLASTI - git watcher: auto-deploy the VPS on every new commit
# ====================================================================
# Monitors the BLASTI repo for new commits and applies them to the
# DigitalOcean (or any) VPS automatically.
#
# MODES
#   A) Watch FROM YOUR MACHINE - tell the VPS to pull from GitHub:
#        ./scripts/watch-and-deploy.sh watch root@VPS_IP [--domain d.tld]
#      Every new commit runs scripts/deploy-digitalocean.sh update
#      (one ssh call -> server-update: git pull + rebuild + restart),
#      identical to a manual update. No upload, no GitHub credentials
#      needed on your machine (the repo is public).
#
#   B) Watch ON THE VPS (recommended for always-on auto-deploy):
#      The VPS clone is updated with git, then rebuilt in place.
#        sudo ./scripts/watch-and-deploy.sh watch --on-server --dir /opt/blasti
#      Cron-friendly single check (recommended):
#        */5 * * * * /opt/blasti/scripts/watch-and-deploy.sh watch \
#            --on-server --once >> /var/log/blasti-watch.log 2>&1
#
# OPTIONS
#   --repo URL        Repo to monitor (default: the BLASTI GitHub repo)
#   --branch NAME     Branch to track (default: master)
#   --interval SEC    Poll interval for the long-running loop (default 300)
#   --once            One check and exit (ideal for cron)
#   --dry-run         Print what would happen, change nothing
#   --deploy-now      Deploy immediately on first run instead of just
#                     recording a baseline SHA
#   --force           Deploy even when the SHA did not change
#   --dir PATH        (VPS mode) server-side clone location (default /opt/blasti)
#   --port N          (upload mode) ssh port (default 22)
#   --domain D        (upload mode) passed through to deploy-digitalocean.sh
#
# PRIVATE REPOS: mode B (on the VPS) needs read credentials on the VPS
# (export GITHUB_TOKEN before the first clone, or use a deploy key).
# Mode A needs no credentials when the repo is public.
#
# SAFETY
#   - First run records the current commit as baseline WITHOUT deploying
#     (use --deploy-now to override).
#   - A failed deploy keeps the previous state and retries with backoff.
#   - Single-instance lock per repo+branch (stale locks expire after 1 h).
# ====================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DEFAULT="https://github.com/raizel820/BLASTI-MULTI-PLATFORM.git"

log() { printf '%s [watch] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }
die() { printf '%s [watch] FAIL: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >&2; exit 1; }
usage() { sed -n '2,55p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

state_dir() { printf '%s' "${BLASTI_WATCH_STATE_DIR:-$HOME/.blasti-watch}"; }

state_key() { # stable id for repo+branch
  local raw="$1|$2"
  if command -v md5sum >/dev/null 2>&1; then
    printf '%s' "$raw" | md5sum | cut -c1-16
  else
    printf '%s' "$raw" | md5 -q | cut -c1-16 # BSD/macOS
  fi
}

remote_sha() { # remote_sha <repo> <branch> -> latest commit on the branch
  local sha
  sha="$(git ls-remote "$1" "refs/heads/$2" 2>/dev/null | awk 'NR==1{print $1}')"
  if [ -z "$sha" ]; then
    sha="$(git ls-remote "$1" HEAD 2>/dev/null | awk 'NR==1{print $1}')"
  fi
  printf '%s' "$sha"
}

cmd_watch() {
  local TARGET="" ON_SERVER=0 REPO="$REPO_DEFAULT" BRANCH="master" INTERVAL=300
  local ONCE=0 DRY_RUN=0 DEPLOY_NOW=0 FORCE=0 DIR="/opt/blasti" PORT=22 DOMAIN=""

  while [ $# -gt 0 ]; do
    case "$1" in
      --repo)       REPO="$2";      shift 2 ;;
      --branch)     BRANCH="$2";    shift 2 ;;
      --interval)   INTERVAL="$2";  shift 2 ;;
      --on-server)  ON_SERVER=1;    shift ;;
      --once)       ONCE=1;         shift ;;
      --dry-run)    DRY_RUN=1;      shift ;;
      --deploy-now) DEPLOY_NOW=1;   shift ;;
      --force)      FORCE=1;        shift ;;
      --dir)        DIR="$2";       shift 2 ;;
      --port)       PORT="$2";      shift 2 ;;
      --domain)     DOMAIN="$2";    shift 2 ;;
      --help|-h)    usage; exit 0 ;;
      -*) die "unknown flag: $1 (try --help)" ;;
      *)
        if [ -z "$TARGET" ]; then TARGET="$1"; shift
        else die "only one ssh target allowed (got '$TARGET' and '$1')"; fi
        ;;
    esac
  done

  command -v git >/dev/null 2>&1 || die "git not found on this machine"
  if [ "$ON_SERVER" -ne 1 ] && [ -z "$TARGET" ]; then
    die "give an ssh target (root@VPS_IP) or use --on-server when running on the VPS itself"
  fi

  local sd base
  sd="$(state_dir)"
  base="$sd/$(state_key "$REPO" "$BRANCH")"
  mkdir -p "$sd" 2>/dev/null || die "cannot create state dir $sd"

  WATCH_LOCKDIR="$base.lock" # global: the EXIT trap fires after cmd_watch returns
  # single-instance lock (stale locks older than 1 h are stolen)
  if ! mkdir "$WATCH_LOCKDIR" 2>/dev/null; then
    if [ -z "$(find "$WATCH_LOCKDIR" -maxdepth 0 -mmin -60 2>/dev/null)" ]; then
      log "stealing stale lock"
      rmdir "$WATCH_LOCKDIR" 2>/dev/null || true
      mkdir "$WATCH_LOCKDIR" 2>/dev/null || die "cannot acquire lock"
    else
      die "another watcher is already running for this repo+branch"
    fi
  fi
  trap 'rmdir "$WATCH_LOCKDIR" 2>/dev/null || true' EXIT

  log "watching $REPO (branch $BRANCH) $( [ "$ON_SERVER" -eq 1 ] \
    && echo "on this server ($DIR)" || echo "deploying to $TARGET" )"

  local failures=0
  while :; do
    local sha last
    sha="$(remote_sha "$REPO" "$BRANCH" || true)"
    if [ -z "$sha" ]; then
      log "could not read remote refs (offline? missing credentials?) - will retry"
      failures=$((failures + 1))
    else
      last=""
      if [ "$ON_SERVER" -eq 1 ]; then
        if [ ! -d "$DIR/.git" ]; then
          die "no git repo at $DIR - clone first:  git clone $REPO $DIR"
        fi
        last="$(git -C "$DIR" rev-parse HEAD 2>/dev/null || true)"
      elif [ -f "$base.sha" ]; then
        last="$(cat "$base.sha" 2>/dev/null || true)"
      fi

      if [ "$DRY_RUN" -eq 1 ]; then
        local would="up-to-date"
        if [ "$sha" != "$last" ] || [ "$FORCE" -eq 1 ]; then would="WOULD-DEPLOY"; fi
        log "dry-run: remote=$sha local/last-deployed=${last:-<none>} -> $would"
        return 0
      fi

      if [ -z "$last" ]; then
        # first contact: baseline, deploy only when asked
        if [ "$DEPLOY_NOW" -eq 1 ] || [ "$ON_SERVER" -eq 1 ]; then
          log "no baseline - deploying current commit $sha"
        else
          printf '%s' "$sha" > "$base.sha"
          log "baseline recorded: $sha (next new commit will deploy; use --deploy-now to deploy this one now)"
          if [ "$ONCE" -eq 1 ]; then return 0; fi
          sha=""
        fi
      fi

      if [ -n "$sha" ] && { [ "$sha" != "$last" ] || [ "$FORCE" -eq 1 ]; }; then
        log "new commit detected: $last -> $sha - deploying"
        if deploy_now "$sha"; then
          failures=0
          if [ "$ON_SERVER" -ne 1 ]; then printf '%s' "$sha" > "$base.sha"; fi
          log "deploy finished - now at $sha"
        else
          failures=$((failures + 1))
          log "deploy FAILED (attempt $failures) - will retry (state not updated)"
        fi
      fi
    fi

    if [ -n "$sha" ] && [ "$sha" = "$last" ] && [ "$FORCE" -eq 0 ]; then
      log "up to date ($sha)"
    fi

    [ "$ONCE" -eq 1 ] && return 0
    local wait_s="$INTERVAL"
    [ "$failures" -gt 0 ] && wait_s=$((INTERVAL * (failures < 6 ? failures : 6)))
    sleep "$wait_s"
  done
}

deploy_now() { # deploy_now <sha> -> 0 on success (respects dry-run)
  local sha="$1"
  if [ "$ON_SERVER" -eq 1 ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
      log "dry-run: would run: git -C $DIR fetch+reset to $sha && deploy-digitalocean.sh server-update"
      return 0
    fi
    git -C "$DIR" fetch origin "$BRANCH" || return 1
    git -C "$DIR" reset --hard "FETCH_HEAD" >/dev/null || return 1
    log "code updated to $sha - rebuilding + restarting services (secrets untouched)"
    ( cd "$DIR" && bash scripts/deploy-digitalocean.sh server-update ${DOMAIN:+--domain "$DOMAIN"} ) || return 1
  else
    if [ "$DRY_RUN" -eq 1 ]; then
      log "dry-run: would run: deploy-digitalocean.sh update $TARGET (ssh -> server-update)"
      return 0
    fi
    "$SCRIPT_DIR/deploy-digitalocean.sh" update "$TARGET" --port "$PORT" ${DOMAIN:+--domain "$DOMAIN"} || return 1
  fi
}

# --------------------------------------------------------------------
case "${1:-help}" in
  watch) shift; cmd_watch "$@" ;;
  help|-h|--help) usage ;;
  *) die "unknown mode: ${1:-} (try --help)" ;;
esac
