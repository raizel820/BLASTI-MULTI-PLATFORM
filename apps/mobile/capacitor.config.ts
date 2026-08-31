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
      launchShowDuration: 2000,
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
      smallIcon: 'ic_stat_blasti',
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
    // Allow mixed content so the WebView can load from localhost during dev
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
