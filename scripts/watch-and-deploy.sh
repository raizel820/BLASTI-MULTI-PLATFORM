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
#      deploy-digitalocean.sh server-install / server-update arm this
#      automatically as a systemd timer (blasti-watcher.timer) that
#      checks GitHub every 2 minutes - no cron needed:
#        systemctl status  blasti-watcher.timer
#        journalctl -u blasti-watcher.service -n 50 --no-pager
#        systemctl disable --now blasti-watcher.timer   <- turn it off
#      Manual cron alternative (single check per run):
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
#   - Only successful deploys are remembered: a failed rebuild is retried
#     automatically (after a 30 min backoff, or immediately when a NEW
#     commit lands). Override the backoff with BLASTI_WATCH_RETRY_SEC.
#   - Serializes with manual install/update via /run/lock/blasti-update.lock
#     (never runs two rebuilds at once on the same server).
#   - Single-instance lock per repo+branch (stale locks expire after 1 h).
# ====================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DEFAULT="https://github.com/raizel820/BLASTI-MULTI-PLATFORM.git"
RETRY_AFTER_SEC="${BLASTI_WATCH_RETRY_SEC:-1800}" # wait 30 min after a failed deploy
UPDATE_LOCK="${BLASTI_WATCH_UPDATE_LOCK:-/run/lock/blasti-update.lock}" # shared with deploy-digitalocean.sh

# ----------------------------------------------------------------
# Heartbeat: report every check / deploy to the cloud API so the
# admin panel (Public Apps Settings -> deploy status) can show that
# the watcher is alive and what the last deploy did.
#   - ON THE VPS: nothing to configure — systemd exports
#     INTERNAL_API_URL + DEPLOY_TOKEN from /etc/blasti/blasti.env.
#   - FROM YOUR MACHINE (mode A): export BLASTI_HEARTBEAT_URL and
#     BLASTI_DEPLOY_TOKEN to enable it, otherwise it is skipped.
# A failed heartbeat NEVER breaks the watcher (curl failure ignored).
# ----------------------------------------------------------------
HB_URL="${BLASTI_HEARTBEAT_URL:-}"
HB_TOKEN="${BLASTI_DEPLOY_TOKEN:-${DEPLOY_TOKEN:-}}"
if [ -z "$HB_URL" ] && [ -r /etc/blasti/blasti.env ]; then
  HB_URL="$(grep '^INTERNAL_API_URL=' /etc/blasti/blasti.env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"')"
  HB_URL="${HB_URL:-http://127.0.0.1:3003}"
fi
if [ -z "$HB_TOKEN" ] && [ -r /etc/blasti/blasti.env ]; then
  HB_TOKEN="$(grep '^DEPLOY_TOKEN=' /etc/blasti/blasti.env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"')"
fi
HB_REPO="${BLASTI_WATCH_REPO:-$REPO_DEFAULT}"
HB_BRANCH_DEFAULT="master"

hb_enabled() { [ -n "$HB_URL" ] && [ -n "$HB_TOKEN" ]; }

heartbeat() { # heartbeat <kind> <status> <commit> <message> [extra_json]
  hb_enabled || return 0
  local kind="$1" status="$2" commit="$3" message="$4" extra="${5:-}"
  local payload code
  payload="{\"kind\":\"$kind\",\"status\":\"$status\",\"commit\":\"$commit\",\"branch\":\"$BRANCH_NAME\",\"repo\":\"$HB_REPO\",\"intervalSec\":$INTERVAL_NAME,\"message\":\"$message\"$extra}"
  # A failed heartbeat NEVER breaks the watcher, but a SILENT failure is
  # invisible: the admin panel (Public Apps Settings) shows "no data" with no
  # clue why. Log the rejection reason so `journalctl -u blasti-watcher`
  # answers it (401 = token mismatch, 404 = server API outdated, else network).
  code="$(curl -fsS -m 5 -o /dev/null -w '%{http_code}' -X POST "$HB_URL/api/system/deploy-heartbeat" \
    -H 'Content-Type: application/json' -H "x-deploy-token: $HB_TOKEN" \
    -d "$payload" 2>/dev/null)" || code="unreachable"
  case "$code" in
    200 | 201 | 204) : ;;
    401) log "heartbeat REJECTED (HTTP 401) — the server did not accept this DEPLOY_TOKEN; Public Apps Settings stays 'no data'. Check that DEPLOY_TOKEN in /etc/blasti/blasti.env is the same secret the watcher (and GitHub Actions BLASTI_DEPLOY_TOKEN) use." ;;
    404) log "heartbeat endpoint missing (HTTP 404) — the server API predates deploy heartbeats; run: bash scripts/deploy-digitalocean.sh server-update" ;;
    unreachable) log "heartbeat unreachable at $HB_URL (connection failed) — is blasti-api running?" ;;
    *) log "heartbeat failed (HTTP $code)" ;;
  esac
}

log() { printf '%s [watch] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }
die() { printf '%s [watch] FAIL: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >&2; exit 1; }
usage() { sed -n '2,53p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

state_dir() { printf '%s' "${BLASTI_WATCH_STATE_DIR:-$HOME/.blasti-watch}"; }

state_key() { # stable id for repo+branch
  local raw="$1|$2"
  if command -v md5sum >/dev/null 2>&1; then
    printf '%s' "$raw" | md5sum | cut -c1-16
  else
    printf '%s' "$raw" | md5 -q | cut -c1-16 # BSD/macOS
  fi
}

recent_failure() { # recent_failure <sha> <fail-file> -> 0 if THIS sha failed recently
  local sha="$1" fail_file="$2" line f_sha f_ts now
  [ -f "$fail_file" ] || return 1
  line="$(cat "$fail_file" 2>/dev/null || true)"
  f_sha="${line%% *}"
  f_ts="${line##* }"
  [ "$f_sha" = "$sha" ] || return 1
  case "$f_ts" in '' | *[!0-9]*) return 1 ;; esac
  now="$(date +%s)"
  [ $((now - f_ts)) -lt "$RETRY_AFTER_SEC" ] && return 0 || return 1
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
  BRANCH_NAME="$BRANCH"
  INTERVAL_NAME="$INTERVAL"

  while [ $# -gt 0 ]; do
    case "$1" in
      --repo)       REPO="$2";                           shift 2 ;;
      --branch)     BRANCH="$2";    BRANCH_NAME="$2";    shift 2 ;;
      --interval)   INTERVAL="$2";  INTERVAL_NAME="$2";  shift 2 ;;
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

  local failures=0 last_rc=0
  while :; do
    local sha last
    sha="$(remote_sha "$REPO" "$BRANCH" || true)"
    if [ -z "$sha" ]; then
      log "could not read remote refs (offline? missing credentials?) - will retry"
      failures=$((failures + 1))
      heartbeat "watcher-check" "error" "" "could not read remote refs"
    else
      last=""
      if [ "$ON_SERVER" -eq 1 ]; then
        if [ ! -d "$DIR/.git" ]; then
          die "no git repo at $DIR - clone first:  git clone $REPO $DIR"
        fi
        # remember only SUCCESSFUL deploys (state file) so a failed build
        # is retried on the next check instead of being forgotten
        if [ -f "$base.sha" ]; then
          last="$(cat "$base.sha" 2>/dev/null || true)"
        else
          last="$(git -C "$DIR" rev-parse HEAD 2>/dev/null || true)"
        fi
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
        local skip_deploy=0
        if [ "$ON_SERVER" -eq 1 ] && [ "$DRY_RUN" -eq 0 ] && [ "$FORCE" -eq 0 ] \
          && recent_failure "$sha" "$base.fail"; then
          log "last deploy of $sha FAILED - backing off, next retry in ~$((RETRY_AFTER_SEC / 60)) min"
          skip_deploy=1
        fi
        if [ "$skip_deploy" -eq 0 ]; then
          log "new commit detected: $last -> $sha - deploying"
          heartbeat "deploy-start" "ok" "$sha" "new commit detected - deploying"
          local rc=0 deploy_started
          deploy_started="$(date +%s)"
          deploy_now "$sha" || rc=$?
          if [ "$rc" -eq 0 ]; then
            failures=0
            if [ "$ON_SERVER" -ne 1 ]; then printf '%s' "$sha" > "$base.sha"; fi
            log "deploy finished - now at $sha"
            heartbeat "deploy-result" "success" "$sha" "deploy finished" \
              ",\"durationSec\":$(( $(date +%s) - deploy_started ))"
          elif [ "$rc" -eq 2 ]; then
            log "deploy skipped - another install/update is running; will check again next cycle"
            heartbeat "watcher-check" "ok" "$sha" "deploy skipped - update lock busy"
          else
            failures=$((failures + 1))
            last_rc=1 # --once mode reports the failed deploy to systemd/cron
            log "deploy FAILED (attempt $failures) - will retry (state not updated)"
            heartbeat "deploy-result" "failure" "$sha" "deploy failed (attempt $failures)"
          fi
        fi
      fi
    fi

    if [ -n "$sha" ] && [ "$sha" = "$last" ] && [ "$FORCE" -eq 0 ]; then
      log "up to date ($sha)"
      heartbeat "watcher-check" "ok" "$sha" "up to date"
      # first peaceful run: record the baseline so restarts never re-deploy
      if [ "$ON_SERVER" -eq 1 ] && [ "$DRY_RUN" -eq 0 ] && [ ! -f "$base.sha" ]; then
        printf '%s' "$sha" > "$base.sha" 2>/dev/null || true
      fi
    fi

    if [ "$ONCE" -eq 1 ]; then
      [ "$last_rc" -eq 0 ] && return 0
      return "$last_rc" # systemd marks the check failed -> visible in server-doctor
    fi
    local wait_s="$INTERVAL"
    [ "$failures" -gt 0 ] && wait_s=$((INTERVAL * (failures < 6 ? failures : 6)))
    sleep "$wait_s"
  done
}

deploy_now() { # deploy_now <sha> -> 0 ok | 1 failed | 2 skipped (lock busy)
  local sha="$1"
  if [ "$ON_SERVER" -eq 1 ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
      log "dry-run: would run: git -C $DIR fetch+reset to $sha && deploy-digitalocean.sh server-update"
      return 0
    fi
    # never race a manual install/update (same lock the deploy script holds)
    mkdir -p "$(dirname "$UPDATE_LOCK")" 2>/dev/null || true
    if ! exec 8>"$UPDATE_LOCK" 2>/dev/null; then
      log "cannot open the update lock $UPDATE_LOCK - skipping this cycle"
      return 2
    fi
    if ! flock -n 8; then
      log "another install/update holds the lock - skipping this cycle"
      return 2
    fi
    git -C "$DIR" fetch origin "$BRANCH" || return 1
    git -C "$DIR" reset --hard "FETCH_HEAD" >/dev/null || return 1
    flock -u 8 2>/dev/null || true # release: server-update takes the lock itself
    log "code updated to $sha - rebuilding + restarting services (secrets untouched)"
    if ( cd "$DIR" && bash scripts/deploy-digitalocean.sh server-update ${DOMAIN:+--domain "$DOMAIN"} ); then
      printf '%s' "$sha" > "$base.sha" 2>/dev/null || true
      rm -f "$base.fail" 2>/dev/null || true
      return 0
    fi
    printf '%s %s\n' "$sha" "$(date +%s)" > "$base.fail" 2>/dev/null || true
    return 1
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
