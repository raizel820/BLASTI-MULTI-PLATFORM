import type { MetadataRoute } from "next";

/**
 * P2-12 — real PWA manifest (roadmap: "real PWA manifest or delete sw.js" —
 * BOTH halves land: the dead public/sw.js is deleted (boot hardening still
 * unregisters stale installs) and the app ships a proper installable
 * manifest instead of nothing).
 *
 * Served at /manifest.webmanifest by the Next.js app router. Icons reuse the
 * existing public/logo-192.png / logo-512.png (same assets the Capacitor
 * shells use), marked purpose "any maskable" so Android adaptive icons don't
 * letterbox. Theme color matches the app's emerald brand (emerald-600).
 *
 * STATIC EXPORT (CI build:export → NEXT_BUILD_MODE=export → output: "export"):
 * the generated /manifest.webmanifest route module re-exports this file's
 * route configs, and Next.js refuses to export any GET route unless
 * `dynamic = "force-static"` (or a revalidate config) is present — without
 * it the build dies at "Collecting page data" with error E301. The handler
 * is a pure function (no request/cookies access) so force-static is both
 * required and semantically correct.
 */
export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "BLASTI - بلاصتي - إدارة الطوابير الذكية",
    short_name: "BLASTI",
    description:
      "بلاصتي - منصة إدارة الطوابير الذكية للمؤسسات في الجزائر. انضم للطوابير عن بعد وتتبع موقعك في الوقت الحقيقي.",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    lang: "ar",
    dir: "rtl",
    background_color: "#ffffff",
    theme_color: "#059669",
    categories: ["business", "productivity", "utilities"],
    icons: [
      {
        src: "/logo-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/logo-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/logo-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/logo-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
