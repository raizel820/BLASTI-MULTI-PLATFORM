import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
// Native (Capacitor) cloud-API runtime resolution — used to rebase stored
// localhost file URLs onto the LAN/cloud base the phone actually reached.
// This module only imports get-local-ip (no cycle with utils).
import { getNativeCloudUrl } from './native-cloud-resolver';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * True for private-network hosts (LAN IPs, mDNS .local names, bare Windows
 * machine hostnames) — the same rule api-client.ts uses to decide whether
 * the cloud API is directly reachable without a gateway.
 */
function isDirectReachablePageHost(pageHost: string): boolean {
  if (
    pageHost === 'localhost' ||
    pageHost === '127.0.0.1' ||
    pageHost === '0.0.0.0'
  ) return true;
  if (/^10\./.test(pageHost)) return true;
  if (/^192\.168\./.test(pageHost)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(pageHost)) return true;
  if (pageHost.endsWith('.local')) return true;
  if (pageHost && !pageHost.includes('.') && pageHost !== 'localhost') return true;
  return false;
}

/** True inside a Capacitor native shell (mobile app WebView). */
function isCapacitorShell(): boolean {
  return typeof window !== 'undefined' &&
    !!(window as unknown as { Capacitor?: unknown }).Capacitor;
}

/** True inside the Electron desktop shell (exposes electronAPI on window). */
function isElectronShell(): boolean {
  return typeof window !== 'undefined' &&
    !!(window as unknown as { electronAPI?: unknown }).electronAPI;
}

/** Cloud base URL the Electron shell was launched with (null on the web). */
function electronCloudBaseUrl(): string | null {
  if (!isElectronShell()) return null;
  return (window as unknown as { electronAPI?: { cloudBaseUrl?: string } })
    .electronAPI?.cloudBaseUrl?.trim() || null;
}

/**
 * API-served binary paths that must always resolve against the API server,
 * never against the Next.js page origin (which has no /api routes):
 * uploaded files and app installers (Public Apps Settings downloads).
 */
function isBinaryApiPath(pathname: string): boolean {
  return pathname.includes('/api/upload/file/') || pathname.includes('/api/app-versions/');
}

/**
 * Get a safe URL for accessing uploaded files.
 *
 * All uploads are stored on the API server's local disk
 * (<api>/uploads/<type>/) and served through
 * GET /api/upload/file/:type/:name — no external storage provider
 * (external object-storage services) is involved.
 *
 * Round 17 — the API normalizes intake URLs to ABSOLUTE addresses based on
 * the origin it was reached through (usually http://localhost:3003). Those
 * stored hosts are meaningless to every OTHER viewer, so this helper rebases
 * them per platform:
 *
 *   • Loopback / LAN pages (the dev laptop, a phone on the same Wi-Fi) —
 *     a stored localhost/127.0.0.1 host is rebased onto the page's own host,
 *     keeping the port (the API listens on every interface in these setups).
 *
 *   • Capacitor (mobile app) — a localhost/127.0.0.1 host points INSIDE the
 *     phone itself, so it is rebased onto the LAN/cloud base the native
 *     resolver actually reached the API through.
 *
 *   • Gateway-hosted pages (public preview domains, single exposed port) —
 *     no other port is reachable at all, so ANY stored http(s) file URL is
 *     rewritten to a same-origin relative path plus the `XTransformPort`
 *     routing hint the gateway needs (profile avatars were stuck on the
 *     initials placeholder exactly because this case used to be skipped:
 *     "save success" but the <img> could never load the stored
 *     http://localhost:3003/... URL).
 */
export function getProxiedUrl(url: string | null | undefined): string {
  const raw = url || '';
  if (typeof window === 'undefined' || !raw) return raw;
  // Relative file/installer paths (legacy rows) are handled on the gateway
  // branch below.
  const isRelativeFileApiPath =
    raw.startsWith('/api/upload/file/') || raw.startsWith('/api/app-versions/');
  try {
    const pageHost = window.location.hostname;
    const parsed = new URL(raw, window.location.origin);
    const isHttp = parsed.protocol === 'http:' || parsed.protocol === 'https:';
    const isFileApiPath = isRelativeFileApiPath || isBinaryApiPath(parsed.pathname);

    if (isDirectReachablePageHost(pageHost)) {
      // Capacitor: the WebView origin is the device itself — a stored
      // localhost/127.0.0.1 URL can never resolve there. Rebase onto the
      // LAN/cloud base the native resolver actually reached.
      if (isCapacitorShell() && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')) {
        const nativeBase = getNativeCloudUrl();
        if (nativeBase) {
          return `${nativeBase.replace(/\/+$/, '')}${parsed.pathname}${parsed.search}`;
        }
      }
      // Legacy RELATIVE file/installer path on a page that can reach the API
      // directly: aim it at the cloud API port explicitly (the Next.js server
      // on the page origin has no /api routes — a bare relative path would
      // 404). MUST run before the localhost rebase below, which would
      // otherwise resolve the relative path against the PAGE origin (port
      // 3000). In the Electron shell the user's machine has no :3003 — the
      // installer lives on the CLOUD API the shell was pointed at.
      if (isRelativeFileApiPath) {
        const electronBase = electronCloudBaseUrl();
        if (electronBase) {
          return `${electronBase.replace(/\/+$/, '')}${raw}`;
        }
        return `http://${pageHost === '0.0.0.0' ? 'localhost' : pageHost}:3003${raw}`;
      }
      if (
        isHttp &&
        (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
      ) {
        parsed.hostname = pageHost === '0.0.0.0' ? 'localhost' : pageHost;
        return parsed.toString();
      }
      return raw;
    }

    // Gateway-hosted page (public domain — only the gateway port exists).
    // Rewrite reachable-looking absolute/relative file URLs to same-origin
    // paths carrying the routing hint; anything else (external CDNs, data:)
    // passes through untouched.
    if (isFileApiPath && (isHttp || isRelativeFileApiPath)) {
      // The file lives on the cloud API (:3003). Trust the URL's EXPLICIT
      // port only for absolute URLs (3003 cloud / 3080 desktop-local shapes);
      // relative paths and port-less URLs always target :3003. Resolving a
      // relative path against window.location.origin would leak the PAGE port
      // (e.g. the gateway's) into the routing hint — never the API's.
      const port = (isHttp && !isRelativeFileApiPath && parsed.port) || '3003';
      const search = new URLSearchParams(parsed.search);
      search.set('XTransformPort', port);
      const qs = search.toString();
      return `${parsed.pathname}${qs ? `?${qs}` : ''}`;
    }
  } catch {
    // Not a parseable URL (data: URI, blob:, …) — return as-is.
  }
  return raw;
}
