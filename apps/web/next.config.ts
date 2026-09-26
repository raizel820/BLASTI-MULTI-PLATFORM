import type { NextConfig } from "next";
import { networkInterfaces } from "os";

// When NEXT_BUILD_MODE=export is set, the build produces a static export
// suitable for Capacitor mobile apps. In this mode, output is set to "export".
const isExportMode = process.env.NEXT_BUILD_MODE === "export";

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
  allowedDevOrigins: [
    ...privateLanOrigins(),
    'preview-chat-2e8b7d42-6f74-44df-9f2e-5f3c396ddc2e.space-z.ai',
    'preview-chat-4b670b32-18b3-4e14-a814-00deda25e06f.space-z.ai',
    'preview-chat-*.space-z.ai',
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
