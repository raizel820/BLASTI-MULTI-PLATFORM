#!/bin/bash
export DATABASE_URL="file:/home/z/my-project/packages/db/data/custom.db"
export NEXTAUTH_SECRET="blast1-dev-s3cr3t-k3y-f0r-d3v3l0pm3nt-0nly"
export CORS_ORIGIN="*"
export INTERNAL_SECRET="blast1-internal-secret-dev"
export NEXTAUTH_URL="http://localhost:3000/"

cd /home/z/my-project/apps/api
bun src/index.ts > /tmp/api.log 2>&1 &

cd /home/z/my-project/apps/web
# Web dev server runs on the Node.js runtime (Next.js 16 + Turbopack is not
# supported under `bun --bun` — see WEB_DEV_CRASH_AUDIT.md).
node node_modules/next/dist/bin/next dev -p 3000 -H 127.0.0.1 > /tmp/web.log 2>&1 &

# wait forever to keep the script alive
wait
