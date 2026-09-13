import type { NextConfig } from "next";

// When NEXT_BUILD_MODE=export is set, the build produces a static export
// suitable for Capacitor mobile apps. In this mode, output is set to "export".
const isExportMode = process.env.NEXT_BUILD_MODE === "export";

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

  // Allow cross-origin dev resources from the preview panel
  allowedDevOrigins: [
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
  // - Capacitor: connects to cloud API URL (NEXT_PUBLIC_API_URL or vercel)
  //
  // Socket.IO: handled client-side via the useRealtime hook.
};

export default nextConfig;
