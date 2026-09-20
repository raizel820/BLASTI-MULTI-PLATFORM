# 📱 BLASTI MULTI — Phone / Tablet Access Guide (PC dev mode)

Use the **full BLASTI webapp on your phone's browser** while the app runs on
your PC in development mode. The phone becomes a complete second client —
login, registration, agency wizard, dashboard, realtime queue updates,
uploads — everything works.

---

## 1. How the pieces talk (what "dev mode" means here)

```
PHONE (browser)                         YOUR PC
┌──────────────────────────┐            ┌─────────────────────────────────────┐
│  http://<PC-IP>:3000     │ ──TCP 3000──▶  Next.js webapp  (bun run dev:web) │
│                          │            │                                     │
│  API calls, WebSocket    │ ──TCP 3003──▶  Cloud API      (bun run dev:api)  │
│  go DIRECT to :3003      │            │        · REST  /api/*               │
│  (auto-detected)         │            │        · Socket.IO realtime         │
│                          │            │        · /uploads files             │
└──────────────────────────┘            └─────────────────────────────────────┘
```

- The webapp is served to your phone by Next.js on port **3000**.
- The browser on your phone detects it is on the same network and calls the
  API **directly** on port **3003** (same as your PC's browser already does).
- No gateway, no tunnel, no extra software on the phone.

> ⚠️ **Requirement:** you must have the latest code from this round.
> Previously the API listened on `127.0.0.1` only (the phone could never
> reach it) and LAN browser origins were rejected at the realtime handshake.
> Both are fixed — see §6 "What changed under the hood".

---

## 2. One-time setup (per PC)

### 2.1 Put the PC and the phone on the SAME Wi-Fi / network

- Same router, same subnet (e.g. PC `192.168.1.20`, phone `192.168.1.31`).
- On Windows, the active network profile should be **Private**
  (Settings → Network & Internet → Wi‑Fi → your network → Private).
  Public profile = Windows blocks inbound connections much harder.

### 2.2 Open Windows Firewall for ports 3000 and 3003

Open **PowerShell or CMD as Administrator** and run:

```powershell
netsh advfirewall firewall add rule name="BLASTI Web Dev (TCP 3000)" dir=in action=allow protocol=TCP localport=3000
netsh advfirewall firewall add rule name="BLASTI API Dev (TCP 3003)" dir=in action=allow protocol=TCP localport=3003
```

(Alternative: Windows Security → Firewall & network protection →
"Allow an app through firewall" → tick **Node.js** and **Bun** for
**Private** networks.)

To remove the rules later:

```powershell
netsh advfirewall firewall delete rule name="BLASTI Web Dev (TCP 3000)"
netsh advfirewall firewall delete rule name="BLASTI API Dev (TCP 3003)"
```

### 2.3 Find your PC's LAN IP

```powershell
ipconfig
```

Look for **IPv4 Address** under your active Wi‑Fi / Ethernet adapter,
e.g. `192.168.1.20`. That is your `<PC-IP>` everywhere below.

> Tip: the API now prints its LAN addresses at startup:
> `📱 LAN:  http://192.168.1.20:3003/`

> Tip: home routers give out IPs by DHCP — the PC's IP can change after a
> reboot. Reserve the PC's IP in your router ("DHCP reservation") or just
> re-run `ipconfig` when in doubt.

---

## 3. Start the app (on the PC)

```powershell
# Terminal 1 — cloud API (serves REST + realtime + uploads on :3003)
bun run dev:api

# Terminal 2 — webapp (serves the UI on :3000, all network interfaces)
bun run dev:web
```

Expected output confirms phone-readiness:

```
# dev:web
[dev-web] next dev starting on port 3000 ...
- Network:  http://0.0.0.0:3000        ← 0.0.0.0 = reachable from the phone ✓

# dev:api
🚀 @blasti/api server running on port 3003 ...
   API:    http://localhost:3003/ (bound to 0.0.0.0)   ← LAN-reachable ✓
   📱 LAN:  http://192.168.1.20:3003/                  ← use THIS IP
```

> If `API:` still says `bound to 127.0.0.1`, you are running an old build —
> pull/restart `dev:api`.

You can also use `bun run dev` / `bun run dev:all` (starts both at once) and
`bun run electron:dev` as usual — the desktop app is unaffected and keeps its
local-first embedded API on :3080.

---

## 4. Open it on the phone

1. Connect the phone to the **same Wi‑Fi**.
2. Open the browser (Chrome / Safari) and go to:

   ```
   http://<PC-IP>:3000
   ```

   e.g. `http://192.168.1.20:3000`

3. You get the full webapp — register, log in, run the agency wizard,
   manage the queue, upload images, receive realtime updates. The session
   lives in the phone's browser (localStorage), so the phone and the PC can
   be logged in as the same or different users independently.

### Quick health check (optional)

| Check | From the phone open | Expected |
|---|---|---|
| Webapp | `http://<PC-IP>:3000` | BLASTI landing page |
| API health | `http://<PC-IP>:3003/health` | JSON `{"status":"ok",...}` |
| Realtime | Login → dashboard | green "connected" indicator |

---

## 5. Troubleshooting

| Symptom | Cause → Fix |
|---|---|
| Page won't load at all (`ERR_CONNECTION_REFUSED` / timeout) | Firewall blocking 3000, or network is "Public", or PC/phone on different subnets (guest Wi‑Fi). → §2.1, §2.2. |
| Page loads but "offline" banner / data fails to load | Firewall blocking **3003** (API). Test `http://<PC-IP>:3003/health` on the phone: JSON = OK, timeout = firewall rule missing. → §2.2. |
| Page loads, data loads, but realtime indicator stays red | 3003 reachable but WebSocket blocked. Same fix as above (allow TCP 3003). The app degrades to polling meanwhile. |
| Worked yesterday, dead today | PC's DHCP IP changed. → re-run `ipconfig`, use the new IP (or reserve it in the router). |
| Old data / blank screen after an update | Service-worker cache on the phone. Pull-to-refresh once, or clear site data (Chrome: ⓘ → Site settings → Clear & reset). |
| `allowedDevOrigins` warning in the PC console | Harmless for phone use (the phone is same-origin). Only cross-origin dev tooling needs that list. |
| Phone on mobile data (4G/5G) | Won't work — that's outside your LAN. Use the same Wi‑Fi (or set up a VPN/Tailscale for remote access — out of scope here). |
| Company/hotel Wi‑Fi with "AP isolation" | Devices can't see each other. Use a personal hotspot: connect **both** the PC and the phone to the phone's hotspot, then use the PC's hotspot IP. |

### Debugging from the phone

Append `?debug=1` to the URL (e.g. `http://192.168.1.20:3000/?debug=1`) to
show the built-in diagnostics HUD (API reachability, socket status, request
counter).

---

## 6. What changed under the hood (this round)

These changes are what make phone access possible — no manual config needed
beyond the firewall:

| File | Change |
|---|---|
| `apps/api/src/index.ts` | API now binds `0.0.0.0` (was `127.0.0.1`) so LAN devices can reach REST + WebSocket on :3003. `HOST` env can override. Startup logs the LAN URLs. Private-LAN origins are accepted at the Socket.IO handshake (dev / `CORS_ORIGIN='*'`), keeping JWT auth for every join. |
| `apps/web/src/lib/api-client.ts` | Browser on a private-LAN host (phone) now targets the API directly at `http://<PC-IP>:3003` — same path the PC browser already used on loopback. Public/gateway origins keep the existing relative + `XTransformPort` behavior, so the sandbox/production setups are untouched. |
| `apps/web/src/hooks/use-realtime.tsx` | Socket.IO connects directly to `http://<PC-IP>:3003` from LAN origins (real WebSocket, no polling downgrade). |
| `apps/web/src/lib/utils.ts` | `getProxiedUrl()` rebases stored absolute `http://localhost:3003/...` upload URLs onto the page's own host, so avatars/logos uploaded earlier from the PC render correctly on the phone. |

Security notes:

- This is a **development / LAN** posture. Don't port-forward 3000/3003 to
  the internet; on a public VPS keep `HOST=127.0.0.1` (or a firewall) and let
  the reverse proxy own TLS.
- The realtime handshake still requires a valid JWT for authenticated rooms —
  opening LAN origins only allows the connection, not the data.

---

## 7. FAQ

**Do I need to change anything on the phone?** No app, no install. Just a
browser and the URL.

**Can several phones connect at once?** Yes — each browser is an independent
client.

**Does the desktop (Electron) app change?** No. It stays local-first on
`127.0.0.1:3080` and syncs to the cloud API exactly as before.

**Where do uploaded images from the phone go?** Same place as PC uploads —
the API's `apps/api/uploads/` folder on the PC.

**Agency codes?** Codes are chosen only in the create-agency wizard (they are
no longer part of account registration), with a live "already used?" check —
on every device, including the phone.
