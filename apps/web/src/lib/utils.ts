import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

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

/**
 * Get a safe URL for accessing uploaded files.
 *
 * All uploads are stored on the API server's local disk
 * (<api>/uploads/<type>/) and served through
 * GET /api/upload/file/:type/:name — no external storage provider
 * (external object-storage services) is involved.
 *
 * Round 17 — the API normalizes intake URLs to ABSOLUTE addresses based on
 * the origin it was reached through (usually http://localhost:3003). When a
 * DIFFERENT device on the LAN — e.g. a phone browser that opened the webapp
 * via http://<pc-ip>:3000 — renders such a stored URL, "localhost" points at
 * the phone itself and every avatar/logo 404s. When the page itself is on a
 * host that can reach the API directly (loopback or same private LAN), the
 * stored host is rebased onto the page's own host, keeping the port. Pages
 * behind a gateway (public domains) are left untouched.
 */
export function getProxiedUrl(url: string | null | undefined): string {
  const raw = url || '';
  if (typeof window === 'undefined' || !raw) return raw;
  try {
    const pageHost = window.location.hostname;
    if (!isDirectReachablePageHost(pageHost)) return raw;
    const parsed = new URL(raw, window.location.origin);
    if (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
    ) {
      parsed.hostname = pageHost === '0.0.0.0' ? 'localhost' : pageHost;
      return parsed.toString();
    }
  } catch {
    // Not a parseable URL (data: URI, blob:, relative path…) — return as-is.
  }
  return raw;
}
