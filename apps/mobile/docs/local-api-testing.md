# BLASTI Mobile — Testing Against the Local Dev Stack

> Field incident (2026-09-30): the app booted fine but login always failed with
> `POST /api/auth/login → network error: Failed to fetch`. The exported bundle
> was calling `http://localhost:3003` — on a phone/emulator `localhost` is the
> **device itself**, where nothing listens. The API URL must be baked in at
> build time.

## The one rule

`NEXT_PUBLIC_API_URL` is embedded into the web bundle **at build time** by
`build:export`. If it is unset, a Capacitor build falls back to
`http://10.0.2.2:3003` (the emulator's alias for the host machine — the code
no longer defaults to `localhost`, which is the device itself and always
fails with an instant `Failed to fetch`).

The default is **also preconfigured** in `apps/web/.env.production`
(`NEXT_PUBLIC_API_URL=http://10.0.2.2:3003`), so a plain rebuild works —
no env prefix needed:

```bash
bun run build:mobile      # web export + cap sync android
bun run mobile:studio     # then press ▶ Run in Android Studio
```

To switch targets, edit `apps/web/.env.production` (emulator / physical
phone / production server lines are all in there) — or override on the
command line, which always wins over the file:

```bash
# PHYSICAL phone on the same Wi-Fi (use this machine's LAN IP):
NEXT_PUBLIC_API_URL=http://<PC-LAN-IP>:3003 bun run build:mobile   # e.g. http://192.168.1.100:3003
```

Then **press ▶ Run in Android Studio** (or `bun run mobile:apk`).

Running only ▶ Run in Studio recompiles the native Java but does **NOT**
refresh the embedded web bundle or `capacitor.config.json` — always do a full
`bun run build:mobile` (web export + `cap sync android`) after changing
`NEXT_PUBLIC_*` values or `capacitor.config.ts`.

## What the dev stack must satisfy

| Requirement | Status |
|---|---|
| API binds `0.0.0.0` (reachable off-machine) | ✅ default (`HOST=0.0.0.0` in `apps/api/src/index.ts`) |
| CORS accepts the Capacitor origin `https://localhost` | ✅ dev default `CORS_ORIGIN='*'` echoes any origin (see `start.sh`) |
| Debug APK allows cleartext HTTP | ✅ `src/main/res/xml/network_security_config.xml` permits it (incl. user CAs for proxy debugging). Release builds forbid cleartext via the `src/release/` overlay — use HTTPS URLs for release testing. |
| WebView allows http requests from the `https://localhost` page | ✅ `allowMixedContent: true` in `capacitor.config.ts` → `MIXED_CONTENT_ALWAYS_ALLOW` |

## Verifying from the logcat

- ✅ API reachable: `[ApiClient:CLOUD] POST /api/auth/login → OK 200`
- ❌ Wrong host: `POST /api/auth/login → http://localhost:3003/...` + instant `Failed to fetch` (≤20ms)
- ❌ Cleartext blocked: `Failed to fetch` against a LAN IP even though the server is up → check `network_security_config.xml`
- LAN failover noise (`http://…:3080/api/discover` probes) is the desktop-app
  discovery — harmless if no desktop app is running.

## Checklist when login still fails

1. `curl http://<API-URL>/health` **from the dev machine** — server up?
2. `curl http://<API-URL>/health` from the phone's browser — network reachable?
   (Emulator: open `http://10.0.2.2:3003/health` in the emulator's Chrome.)
3. Was the bundle rebuilt **after** setting the env var? (`bun run build:mobile`)
4. Same Wi-Fi (physical phone), emulator networking enabled, VPN/firewall off.
