#!/bin/bash
export DATABASE_URL="file:/home/z/my-project/packages/db/data/custom.db"
export NEXTAUTH_SECRET="blast1-dev-s3cr3t-k3y-f0r-d3v3l0pm3nt-0nly"
export CORS_ORIGIN="*"
export INTERNAL_SECRET="blast1-internal-secret-dev"
export NEXTAUTH_URL="http://localhost:3000/"

cd /home/z/my-project/apps/api
bun src/index.ts > /tmp/api.log 2>&1 &

cd /home/z/my-project/apps/web
bun --bun run node_modules/.bin/next dev -p 3000 -H 0.0.0.0 > /tmp/web.log 2>&1 &

# wait forever to keep the script alive
wait
