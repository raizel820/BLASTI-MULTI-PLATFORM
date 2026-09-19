#!/bin/bash
# Task 22-c browser verification — runs the dev server + agent-browser checks in ONE session
set -u
cd /home/z/my-project
LOG=dev.log
V=.tmp-verify

echo "=== [1] start dev server ==="
setsid nohup bash -c 'cd apps/web && exec bun --bun run node_modules/.bin/next dev -p 3000 -H 0.0.0.0' >> $LOG 2>&1 < /dev/null &
disown
up=0
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -m 5 -w "%{http_code}" http://127.0.0.1:3000/ || true)
  if [ "$code" = "200" ]; then up=1; echo "server UP after ${i}x2s"; break; fi
  sleep 2
done
if [ "$up" != "1" ]; then echo "SERVER FAILED TO START"; exit 1; fi

echo "=== [2] open landing page ==="
agent-browser open http://localhost:3000 2>&1 | tail -1
agent-browser wait --load networkidle 2>&1 | tail -1

echo "=== [3] install network mocks ==="
agent-browser network route "**/api/admin/providers/templates**" --body "$(cat $V/fixture-templates.json)" 2>&1 | tail -1
agent-browser network route "**/api/admin/providers/logs**" --body "$(cat $V/fixture-logs.json)" 2>&1 | tail -1
agent-browser network route "**/api/admin/payment-settings**" --body '{"success":true,"settings":{"ccpEnabled":false,"bankEnabled":false,"electronicEnabled":false,"ccpAccount":"","ccpKey":"","bankName":"","bankAccount":"","bankRib":"","ewalletNumber":""}}' 2>&1 | tail -1
# NOTE: templates/logs routes MUST be registered before the generic providers route
agent-browser network route "**/api/admin/providers**" --body "$(cat $V/fixture-providers.json)" 2>&1 | tail -1

echo "=== [4] inject SUPER_ADMIN session + ar language ==="
agent-browser eval "localStorage.setItem('blasti-lang','ar'); localStorage.setItem('blasti-app', JSON.stringify({state:{user:{id:'verify-admin-1',username:'verify_admin',fullName:'Admin Verifier',role:'SUPER_ADMIN',language:'ar'},isAuthenticated:true,sessionToken:'verify-token-22c',currentView:'admin-settings',pendingAgencyCode:null,onboarded:true},version:3})); 'injected'" 2>&1 | tail -2

echo "=== [5] reload into admin settings ==="
agent-browser reload 2>&1 | tail -1
sleep 6
agent-browser wait --load networkidle 2>&1 | tail -1
agent-browser get url 2>&1 | tail -1
agent-browser get title 2>&1 | tail -1

echo "=== [6] snapshot (RTL overview) ==="
agent-browser snapshot -i 2>&1 | rg -i "نظرة عامة|رسائل|واتساب|القوالب|السجلات|eSMS|Resend|Meta WhatsApp|مُهيأ|غير مُهيأ|وضع التطوير|12345678" | head -40
agent-browser screenshot $V/01-overview-ar.png 2>&1 | tail -1

echo "=== [7] console errors so far ==="
agent-browser errors 2>&1 | tail -10
