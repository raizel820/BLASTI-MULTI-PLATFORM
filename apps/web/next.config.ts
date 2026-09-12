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
  // Note: In Next.js 16, if the rewrite destination is unreachable the dev
  // server may log proxy errors, but this is acceptable for development.
  // The API client's retry/unreachable logic handles downstream failures.
  async rewrites() {
    const apiProxyUrl = process.env.API_PROXY_URL || 'http://localhost:3003';
    return [
      {
        source: '/api/:path*',
        destination: `${apiProxyUrl}/api/:path*`,
      },
      {
        source: '/socket.io/:path*',
        destination: `${apiProxyUrl}/socket.io/:path*`,
      },
    ];
  },
};

export default nextConfig;
