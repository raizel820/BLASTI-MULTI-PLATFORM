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

  // ── API proxy rewrites ──────────────────────────────────────────────────────
  //
  // Proxy /api/* and /socket.io/* requests to the cloud API server.
  // This ensures API calls work both:
  //   - Through the Caddy gateway (port 81) — XTransformPort=3003 query param
  //   - Directly to Next.js dev server (port 3000) — rewrites handle the routing
  //
  // The destination is configurable via API_PROXY_URL (defaults to
  // http://localhost:3003) so different environments can override it.
  //
  // NOTE: Static export mode (NEXT_BUILD_MODE=export, used for Electron/Capacitor
  // builds) does NOT support rewrites — they must be omitted or `next build`
  // fails. In export mode the app talks to the API via absolute URLs instead.
  //
  // NOTE: When the API is down (web-only `dev:web` mode), the proxy simply
  // returns 500/ECONNREFUSED for /api/* requests. The client's central retry
  // policy (api-client.ts) marks the API unreachable for 30s and pollers honor
  // that cooldown, so the browser stays stable without the API.
  async rewrites() {
    if (process.env.NEXT_BUILD_MODE === "export") {
      return [];
    }
    const apiProxyUrl = process.env.API_PROXY_URL || 'http://localhost:3003';
    return [
      {
        source: '/api/:path*',
        destination: `${apiProxyUrl}/api/:path*`,
      },
      {
        // NOTE the trailing slash on the destination: the browser normalizes
        // "/socket.io/" → "/socket.io" (308) BEFORE rewrites run, so the
        // destination must re-append "/" — engine.io only answers on
        // "/socket.io/". Without this, realtime works through the gateway
        // but NEVER connects on direct dev-server access (ChunkLoadError-era
        // "stuck Reconnecting" bug on http://127.0.0.1:3000).
        source: '/socket.io',
        destination: `${apiProxyUrl}/socket.io/`,
      },
      {
        source: '/socket.io/:path*',
        destination: `${apiProxyUrl}/socket.io/:path*`,
      },
      {
        source: '/health',
        destination: `${apiProxyUrl}/health`,
      },
    ];
  },
};

export default nextConfig;
