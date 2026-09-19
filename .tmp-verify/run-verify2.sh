#!/bin/bash
# Task 22-c browser verification — phase 2 (stable session via mocked /api/auth/session)
set -u
cd /home/z/my-project
V=.tmp-verify

echo "=== [1] ensure dev server ==="
setsid nohup bash -c 'cd apps/web && exec bun --bun run node_modules/.bin/next dev -p 3000 -H 0.0.0.0' >> dev.log 2>&1 < /dev/null &
disown
up=0
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -m 5 -w "%{http_code}" http://127.0.0.1:3000/ || true)
  if [ "$code" = "200" ]; then up=1; echo "server UP"; break; fi
  sleep 2
done
[ "$up" = "1" ] || { echo "SERVER FAILED"; exit 1; }

echo "=== [2] clear old routes + re-register in precedence order ==="
agent-browser network unroute 2>&1 | tail -1 || true
agent-browser network route "**/api/settings**" --body '{"success":true,"settings":[],"groups":[],"categories":[]}' 2>&1 | tail -1
agent-browser network route "**/api/admin/faqs**" --body '{"success":true,"faqs":[]}' 2>&1 | tail -1
agent-browser network route "**/api/reconciliation/unreconciled**" --body '{"success":true,"items":[]}' 2>&1 | tail -1
agent-browser network route "**/api/settings/category/payment**" --body '{"success":true,"settings":[]}' 2>&1 | tail -1
agent-browser network route "**/api/admin/payment-settings**" --body '{"success":true,"settings":{"ccpEnabled":false,"bankEnabled":false,"electronicEnabled":false,"ccpAccount":"","ccpKey":"","bankName":"","bankAccount":"","bankRib":"","ewalletNumber":""}}' 2>&1 | tail -1
agent-browser network route "**/api/auth/session**" --body '{"success":true,"user":{"id":"verify-admin-1","username":"verify_admin","fullName":"Admin Verifier","role":"SUPER_ADMIN","language":"ar"},"expires":"2099-01-01T00:00:00.000Z"}' 2>&1 | tail -1
agent-browser network route "**/api/admin/providers**" --body "$(cat $V/fixture-providers.json)" 2>&1 | tail -1
agent-browser network route "**/api/admin/providers/logs**" --body "$(cat $V/fixture-logs.json)" 2>&1 | tail -1
agent-browser network route "**/api/admin/providers/templates**" --body "$(cat $V/fixture-templates.json)" 2>&1 | tail -1

echo "=== [3] inject session (ar) ==="
agent-browser eval "localStorage.setItem('blasti-lang','ar'); localStorage.setItem('blasti-app', JSON.stringify({state:{user:{id:'verify-admin-1',username:'verify_admin',fullName:'Admin Verifier',role:'SUPER_ADMIN',language:'ar'},isAuthenticated:true,sessionToken:'verify-token-22c',currentView:'admin-settings',pendingAgencyCode:null,onboarded:true},version:3})); 'injected'" 2>&1 | tail -1

echo "=== [4] reload + settle ==="
agent-browser open http://localhost:3000/#/admin/settings 2>&1 | tail -1
sleep 3
agent-browser eval "JSON.stringify({view: document.body.innerText.slice(0,80).replace(/\n/g,'|'), hubTitle: document.body.innerText.includes('الإشعارات والمزودون'), tabs: document.body.innerText.includes('نظرة عامة'), dev: document.body.innerText.includes('وضع التطوير'), esms: document.body.innerText.includes('eSMS Africa'), resend: document.body.innerText.includes('Resend'), meta: document.body.innerText.includes('Meta WhatsApp')})" 2>&1 | tail -2
sleep 5
echo "=== [5] DOM assertions after settle ==="
agent-browser eval "JSON.stringify({url: location.hash, hubTitle: document.body.innerText.includes('الإشعارات والمزودون'), tabs: document.body.innerText.includes('نظرة عامة'), dev: document.body.innerText.includes('وضع التطوير'), esms: document.body.innerText.includes('eSMS Africa'), resend: document.body.innerText.includes('Resend'), meta: document.body.innerText.includes('Meta WhatsApp'), configuredAr: document.body.innerText.includes('مُهيأ'), lastTest: document.body.innerText.includes('آخر اختبار'), smsCode: document.body.innerText.includes('1234'), emailCode: document.body.innerText.includes('12345678')})" 2>&1 | tail -2

echo "=== [6] console errors ==="
agent-browser errors 2>&1 | tail -8
agent-browser screenshot 2>&1 | tail -1
