#!/bin/bash
# Temporary sandbox keeper (R-12): the host OOM reaper kills BLASTI dev
# processes under external memory pressure. This loop restarts whatever
# died every KEEP_INTERVAL seconds. Bounded lifetime via KEEP_MAX_MINUTES.
LOG=/home/z/my-project/dev.log
KEEP_INTERVAL="${KEEP_INTERVAL:-20}"
KEEP_MAX_MINUTES="${KEEP_MAX_MINUTES:-120}"
END=$(( $(date +%s) + KEEP_MAX_MINUTES * 60 ))

ensure_api() {
  curl -s -o /dev/null --max-time 5 http://localhost:3003/api/health && return 0
  echo "$(date +%T) [keeper] restarting api" >> /home/z/my-project/keeper.log
  pkill -f "bun --hot src/index.ts" 2>/dev/null; sleep 1
  ( cd /home/z/my-project/apps/api && DATABASE_URL="postgresql://blasti:blasti@127.0.0.1:5432/blasti?schema=public" nohup bun --hot src/index.ts >> $LOG 2>&1 & )
  return 0
}

ensure_web() {
  curl -s -o /dev/null --max-time 8 http://localhost:3000 && return 0
  echo "$(date +%T) [keeper] restarting web" >> /home/z/my-project/keeper.log
  pkill -f "dev-web.cjs" 2>/dev/null; pkill -f "next-server" 2>/dev/null; sleep 1
  ( cd /home/z/my-project/apps/web && BLASTI_WEB_MAX_HEAP_MB=900 nohup node ../../scripts/dev-web.cjs -p 3000 >> $LOG 2>&1 & )
  return 0
}

ensure_pg() {
  ss -tln 2>/dev/null | grep -q ':5432' && return 0
  echo "$(date +%T) [keeper] restarting pg" >> /home/z/my-project/keeper.log
  ( cd /home/z/pg-embedded && nohup bun boot-pg.mjs >> /home/z/pg-embedded/boot.log 2>&1 & )
  return 0
}

echo "$(date +%T) [keeper] started (interval=${KEEP_INTERVAL}s, max=${KEEP_MAX_MINUTES}min)" >> /home/z/my-project/keeper.log
while [ $(date +%s) -lt $END ]; do
  ensure_pg; sleep 1; ensure_api; sleep 1; ensure_web
  sleep "$KEEP_INTERVAL"
done
echo "$(date +%T) [keeper] lifetime expired" >> /home/z/my-project/keeper.log
