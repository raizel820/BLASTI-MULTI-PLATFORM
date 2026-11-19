/**
 * BLASTI Mobile — Capacitor Configuration
 *
 * Configures Capacitor for building native mobile apps (Android/iOS)
 * from the BLASTI web app hosted in the monorepo at apps/web/.
 *
 * Key details:
 *   - webDir points to the Next.js static export output (requires `output: 'export'` in next.config.ts)
 *   - In development, the server.url overrides webDir to load from the dev server
 *   - appId follows reverse-DNS convention: com.blasti.mobile
 *   - Plugins are configured to match the native-bridge.ts expectations on the web side
 *
 * Usage:
 *   Production: Build web app with `next build` (output: 'export'), then `cap sync`
 *   Development: Set CAPACITOR_SERVER_URL=http://<your-ip>:3000 to live-reload from dev server
 */

import type { CapacitorConfig } from '@capacitor/cli';

const isDev = !!process.env.CAPACITOR_SERVER_URL;

const config: CapacitorConfig = {
  appId: 'com.blasti.mobile',
  appName: 'BLASTI',

  // ─── Web Directory ───────────────────────────────────────────────────────────
  // Relative path from this file to the Next.js static export directory.
  // When `output: 'export'` is set in next.config.ts, Next.js outputs to `out/`.
  webDir: '../../apps/web/out',

  // ─── Server Configuration ────────────────────────────────────────────────────
  // In development, point to the local Next.js dev server for live reload.
  // In production, this is omitted and the app loads from webDir.
  //
  // Phase 6a: The Capacitor HTTP plugin can crash on empty response bodies (e.g. 204).
  // This is handled in the web app's native-bridge.ts (safeJsonParse) and api-client.ts
  // (parseResponse) rather than in this config, since the crash occurs at the JS layer
  // when JSON.parse('') is called on an empty body.
  server: {
    url: isDev ? process.env.CAPACITOR_SERVER_URL : undefined,
    // Allow cleartext HTTP (needed for localhost dev server)
    cleartext: isDev,
    // Phase 8b: Use http scheme in dev to prevent mixed-content blocks
    // In production, use https for secure context APIs (Payment Request, Geolocation)
    androidScheme: isDev ? 'http' : 'https',
  },

  // ─── Plugins ─────────────────────────────────────────────────────────────────
  plugins: {
    SplashScreen: {
      // Brief static splash only — the animated intro (AppIntroAnimation in the
      // web bundle) takes over as soon as the WebView paints.
      launchShowDuration: 400,
      launchAutoHide: true,
      backgroundColor: '#10b981',
      showSpinner: true,
      spinnerColor: '#ffffff',
      // Use the BLASTI logo as splash screen image
      splashFullScreen: true,
      splashImmersive: true,
    },

    StatusBar: {
      // Light status bar (dark text) for the emerald-themed splash
      style: 'LIGHT',
      backgroundColor: '#10b981',
    },

    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },

    LocalNotifications: {
      // 'ic_launcher' is guaranteed to exist; a dedicated monochrome
      // ic_stat_blasti drawable can replace it later
      smallIcon: 'ic_launcher',
      iconColor: '#10b981',
      sound: 'default',
    },

    Camera: {
      presentationStyle: 'fullscreen',
    },

    App: {
      // Deep link scheme for blasti:// URLs
      launchUrl: 'blasti://',
    },
  },

  // ─── Android Configuration ───────────────────────────────────────────────────
  android: {
    // 0.6.92 — MIXED CONTENT MUST STAY ENABLED (root fix for "LAN discovery
    // finished with NO desktop box found after 0s"). The production shell
    // page is https://localhost (androidScheme below), and EVERY LAN probe —
    // quickDiscover()'s http://<ip>:3080/api/discover sweep, the kiosk
    // register/pair/heartbeat calls, LAN ticket printing via
    // /api/agency-devices/discovery/print — is plain HTTP. With mixed
    // content blocked the WebView rejects those fetches SYNCHRONOUSLY (no
    // network wait): the whole 2x254-probe sweep drained in ~80ms and the
    // log showed "0s (2 subnet(s) swept)". The Android cleartext gate is
    // separately scoped by network_security_config.xml (release permits
    // cleartext since 0.6.86 precisely for these LAN calls) — this flag is
    // the WebView-layer gate that sits above it. NEVER flip this back to
    // false: apps/mobile/docs/local-api-testing.md documents the same
    // requirement, and the checked-in built assets config already carried
    // `true` (cap sync kept regressing it from this source value).
    allowMixedContent: true,
    backgroundColor: '#FFFFFF',
    buildOptions: {
      keystorePath: undefined,
      keystoreAlias: undefined,
    },
  },

  // ─── iOS Configuration ───────────────────────────────────────────────────────
  ios: {
    contentInset: 'automatic',
    backgroundColor: '#FFFFFF',
  },
};

export default config;
