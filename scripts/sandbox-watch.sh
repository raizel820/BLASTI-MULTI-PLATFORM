#!/usr/bin/env bash
# ====================================================================
# BLASTI — sandbox auto-pull watcher
# ====================================================================
# Keeps THIS dev sandbox in sync with the GitHub repo (master branch):
# polls origin every POLL_SEC, fast-forwards to new commits when the
# working tree is clean, and lets the hot-reloading dev servers pick
# the changes up (API runs `bun --hot`, web runs `next dev` — both
# reload on file change; neither is restarted here).
#
# SAFETY
#   - NEVER resets, stashes or touches a dirty working tree — local
#     uncommitted work always wins; the pull is simply skipped.
#   - Fast-forward only (git pull --ff-only): diverged history needs
#     a human merge, never a forced sync.
#   - Single instance via flock.
#
# Run:   nohup bun scripts/sandbox-watch.sh >> /tmp/blasti-sandbox-watch.log 2>&1 &
# ====================================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH="master"
POLL_SEC="${POLL_SEC:-60}"
LOCK_FILE="/tmp/blasti-sandbox-watch.lock"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') [sandbox-watch] another instance holds the lock — exiting"
  exit 0
fi

log() { printf '%s [sandbox-watch] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }

cd "$REPO_DIR"
log "watching origin/$BRANCH every ${POLL_SEC}s (clean-tree fast-forward only)"

while :; do
  if git fetch origin "$BRANCH" 2>/dev/null; then
    local_sha="$(git rev-parse HEAD 2>/dev/null || echo '')"
    remote_sha="$(git rev-parse "origin/$BRANCH" 2>/dev/null || echo '')"

    # Pull ONLY when local is strictly BEHIND remote (HEAD is an ancestor
    # of origin/master). When local is ahead (unpushed commits) or diverged,
    # a pull is a no-op or impossible — never touch anything.
    if [ -n "$remote_sha" ] && [ "$remote_sha" != "$local_sha" ] \
      && git merge-base --is-ancestor HEAD "origin/$BRANCH" 2>/dev/null; then
      if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
        log "new commit $remote_sha waiting — working tree is DIRTY, skipping (local work wins)"
      elif git merge --ff-only "origin/$BRANCH" >/dev/null 2>&1; then
        log "pulled $local_sha -> $remote_sha (hot-reload picks it up)"
      else
        log "cannot fast-forward to $remote_sha (diverged?) — manual merge needed"
      fi
    fi
  else
    log "git fetch failed (offline?) — will retry"
  fi

  sleep "$POLL_SEC"
done
