import type { NextConfig } from "next";
import { readFileSync } from "fs";
import { resolve } from "path";
import { networkInterfaces } from "os";

// When NEXT_BUILD_MODE=export is set, the build produces a static export
// suitable for Capacitor mobile apps. In this mode, output is set to "export".
const isExportMode = process.env.NEXT_BUILD_MODE === "export";

// ─── Mobile RELEASE env (apps/mobile/.env.production) ──────────────
// `bun run build:android:release` (apps/mobile) and root `mobile:apk:release`
// set BLASTI_MOBILE_BUILD=1. When that marker is present — and ONLY then —
// every key defined in apps/mobile/.env.production is applied to this build
// with the HIGHEST precedence: it overrides apps/web/.env.production (the
// emulator/dev defaults). This is what bakes the VPS URL into the release
// APK and ships NEXT_PUBLIC_SERVER_DISCOVERY=0 (no LAN scan, no manual
// address UI — the app talks ONLY to the baked server).
// Dev builds (build:mobile / build:android / build:android:debug / Android
// Studio ▶ Run) do NOT set the marker → full discovery behaviour,
// emulator defaults. NEXT_BUILD_MODE is filtered out: build scripts own it.
const RESERVED_MOBILE_ENV_KEYS = new Set(["NEXT_BUILD_MODE"]);

function parseEnvFileText(text: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    let body = line;
    if (body.startsWith("export ")) body = body.slice(7).trim();
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (RESERVED_MOBILE_ENV_KEYS.has(key) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = body.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value[0] === '"' && value.endsWith('"')) || (value[0] === "'" && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

function readMobileReleaseEnv(): Record<string, string> {
  if (!isExportMode || process.env.BLASTI_MOBILE_BUILD !== "1") return {};
  try {
    // __dirname = apps/web → the phone app lives one level up.
    return parseEnvFileText(readFileSync(resolve(__dirname, "../mobile/.env.production"), "utf8"));
  } catch {
    // Missing/unreadable file → a plain dev-default release build.
    return {};
  }
}

const mobileReleaseEnv = readMobileReleaseEnv();
// Belt & suspenders: Next.js has ALREADY loaded apps/web/.env.production by
// the time this config is evaluated, so this assignment is what gives the
// mobile file precedence; the `env:` key below re-asserts it for inlining.
Object.assign(process.env, mobileReleaseEnv);

// Task 41-b — phones/tablets on the same Wi-Fi open the dev server via this
// machine's LAN IP (http://<pc-ip>:3000). Next.js 16 blocks cross-origin
// requests to dev assets (/_next/*) for any origin not listed in
// allowedDevOrigins: module scripts send an Origin header, so Turbopack
// chunks fail to load on the phone → ChunkLoadError → the bounded
// auto-recovery reload in client-boot-hardening.tsx fires every cooldown →
// "the UI keeps flickering and components appear/disappear" on real phones.
// Fix: allow every private IPv4 address of THIS machine so LAN devices can
// fetch dev chunks. Recomputed at server start — survives IP changes.
function privateLanOrigins(): string[] {
  try {
    const nets = networkInterfaces();
    const origins: string[] = [];
    for (const list of Object.values(nets)) {
      for (const net of list ?? []) {
        if (net.family !== "IPv4" || net.internal) continue;
        if (!origins.includes(net.address)) origins.push(net.address);
      }
    }
    return origins;
  } catch {
    return [];
  }
}

const nextConfig: NextConfig = {
  // Static export for Capacitor mobile builds (NEXT_BUILD_MODE=export).
  ...(isExportMode ? { output: "export" as const } : {}),

  // Mobile release overrides from apps/mobile/.env.production (see above).
  ...(Object.keys(mobileReleaseEnv).length > 0 ? { env: mobileReleaseEnv } : {}),

  reactStrictMode: true,

  // Skip type-checking during build — type errors are caught by IDE/lint CI.
  typescript: {
    ignoreBuildErrors: true,
  },

  images: {
    unoptimized: true,
  },

  // Allow cross-origin dev resources from the preview panel, local loopback,
  // and this machine's private LAN IPs (phones/tablets on the same Wi-Fi).
  // NOTE: `*` only matches ONE full DNS label — `preview-chat-*.space-z.ai`
  // never matched the real hosts (preview-chat-<uuid>.space-z.ai) and dev
  // kept blocking /_next fonts/chunks. `*.space-z.ai` covers every preview
  // session regardless of chat id.
  allowedDevOrigins: [
    ...privateLanOrigins(),
    '*.space-z.ai',
    'localhost',
    '127.0.0.1',
  ],

  // NOTE: API proxy rewrites have been REMOVED.
  //
  // Previously, /api/* requests were proxied to the cloud API (localhost:3003).
  // In Next.js 16, when the rewrite destination is unreachable, the proxy can
  // crash the entire dev server. This was causing the Electron desktop app
  // to "stop working" when the cloud API was shut down.
  //
  // The API client (api-client.ts) now handles routing directly:
  // - Web browser: connects to cloud API URL (NEXT_PUBLIC_API_URL or localhost:3003)
  // - Electron: connects to cloud API, with automatic LAN failover to localhost:3080
  // - Capacitor: connects to cloud API URL (NEXT_PUBLIC_API_URL)
  //
  // Socket.IO: handled client-side via the useRealtime hook.
};

export default nextConfig;
