#!/bin/bash
# BLASTI API watchdog — health-gated, backoff, bounded restarts.
#
# SAFE BY DESIGN (resource-exhaustion fix, see WEB_DEV_CRASH_AUDIT.md):
#   - NEVER starts a second API while :3003 is already healthy → running this
#     alongside `bun run dev` cannot create duplicate instances.
#   - Exponential backoff (3s → 30s) between restart attempts.
#   - Hard cap: 5 consecutive failed restarts → gives up loudly instead of
#     restart-spamming the CPU/RAM to 100% forever.
#
# Usage: ./keep-api-alive.sh           (or with API_PORT=3004 ./keep-api-alive.sh)

PORT="${API_PORT:-3003}"
HEALTH_URL="http://127.0.0.1:${PORT}/health"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAX_CONSECUTIVE_RESTARTS=5
BACKOFF_BASE=3
BACKOFF_CAP=30

export DATABASE_URL="${DATABASE_URL:-file:${REPO_ROOT}/packages/db/data/custom.db}"
export NEXTAUTH_SECRET="${NEXTAUTH_SECRET:-blast1-dev-s3cr3t-k3y-f0r-d3v3l0pm3nt-0nly}"
export CORS_ORIGIN="${CORS_ORIGIN:-*}"
export INTERNAL_SECRET="${INTERNAL_SECRET:-blast1-internal-secret-dev}"

echo "[$(date)] BLASTI API watchdog on :${PORT} (health-gated, max ${MAX_CONSECUTIVE_RESTARTS} consecutive restarts)"

consecutive=0
while true; do
  if curl -sf -m 2 "$HEALTH_URL" >/dev/null 2>&1; then
    consecutive=0
    sleep 10
    continue
  fi

  if [ "$consecutive" -ge "$MAX_CONSECUTIVE_RESTARTS" ]; then
    echo "[$(date)] ❌ API failed ${consecutive} consecutive restarts — giving up so this machine survives." >&2
    echo "    Read the log above, fix the root cause (port conflict? bad env? schema?), then re-run this watchdog." >&2
    exit 1
  fi

  backoff=$(( BACKOFF_BASE * (2 ** consecutive) ))
  [ "$backoff" -gt "$BACKOFF_CAP" ] && backoff=$BACKOFF_CAP
  echo "[$(date)] API unhealthy — starting in ${backoff}s (attempt $((consecutive + 1))/${MAX_CONSECUTIVE_RESTARTS})…"
  sleep "$backoff"

  cd "${REPO_ROOT}/apps/api" || { echo "[$(date)] cannot cd apps/api" >&2; exit 1; }
  bun run src/index.ts
  code=$?
  echo "[$(date)] API exited with code ${code}"
  consecutive=$((consecutive + 1))
done
