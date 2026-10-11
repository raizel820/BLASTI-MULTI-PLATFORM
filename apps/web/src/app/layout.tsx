import type { Metadata } from "next";
import Script from "next/script";
import { Geist, Geist_Mono } from "next/font/google";
import { ThemeProvider } from "next-themes";
import { AuthProvider } from "@/components/providers/auth-provider";
import { ErrorBoundary } from "@/components/shared/error-boundary";
import { ClientBootHardening } from "@/components/shared/client-boot-hardening";
import { AppIntroAnimation } from "@/components/shared/app-intro-animation";
import { PlatformProvider } from "@/hooks/use-platform";
import { DatabaseProvider } from "@/db/provider";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "BLASTI - بلاصتي - إدارة الطوابير الذكية",
  description: "بلاصتي - منصة إدارة الطوابير الذكية للمؤسسات في الجزائر. انضم للطوابير عن بعد وتتبع موقعك في الوقت الحقيقي. Available on Web, Desktop (Electron), and Mobile (Capacitor).",
  icons: {
    icon: [
      { url: "/logo.png", type: "image/png" },
      { url: "/favicon.png", sizes: "64x64", type: "image/png" },
      { url: "/logo-192.png", sizes: "192x192", type: "image/png" },
      { url: "/logo-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    // Phase 4: Dynamic RTL/LTR — removed hardcoded dir="rtl" and lang="ar"
    // Direction is now managed dynamically by useAppStore based on the active language
    // The DirectionManager component in AuthProvider handles document direction updates
    <html lang="ar" data-scroll-behavior="smooth" suppressHydrationWarning>
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground font-[family-name:var(--font-geist-sans)]`}>
        {/* ResizeObserver loop fix (Task 53) — must run before any Next.js
            code, hydration, or recharts observers are created. Wraps
            window.ResizeObserver with a rAF-deferred version (source fix for
            "ResizeObserver loop completed with undelivered notifications" on
            chart-heavy screens like #/admin/analytics) and swallows that one
            benign error message as a backstop. */}
        <Script src="/resize-observer-fix.js" strategy="beforeInteractive" />
        <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false} disableTransitionOnChange>
          {/* Launch intro — Capacitor shells only (web/desktop skip; ?intro=1 previews) */}
          <AppIntroAnimation />
          {/* Task 41 — legacy SW unregister + chunk-error auto-recovery (phone flicker fix) */}
          <ClientBootHardening />
          <PlatformProvider>
            <DatabaseProvider>
              <AuthProvider>
                <ErrorBoundary>
                  {children}
                </ErrorBoundary>
              </AuthProvider>
            </DatabaseProvider>
          </PlatformProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
