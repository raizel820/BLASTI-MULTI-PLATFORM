import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Get a proxied URL for accessing private storage files.
 *
 * This function handles all storage providers:
 * - Vercel Blob private URLs → proxied through /api/upload/proxy
 * - Cloudflare R2 URLs → proxied or direct depending on R2_PUBLIC_URL
 * - Local paths (/uploads/...) → returned as-is (served statically)
 * - Other URLs → returned as-is
 *
 * For the full storage-aware URL resolution (including provider-neutral
 * file records), use `getFileUrl()` from `@/lib/storage` instead.
 *
 * @deprecated Use `getProxiedUrl` from `@/lib/storage` for full provider support.
 *             This function is kept for backward compatibility with existing components.
 */
export function getProxiedUrl(url: string | null | undefined): string {
  if (!url) return '';

  // Vercel Blob URLs need proxying
  if (url.includes('.blob.vercel-storage.com')) {
    return `/api/upload/proxy?url=${encodeURIComponent(url)}`;
  }

  // R2 URLs without a public domain need proxying
  const r2PublicUrl = process.env.NEXT_PUBLIC_R2_PUBLIC_URL;
  if (url.includes('.r2.cloudflarestorage.com') || (r2PublicUrl && url.startsWith(r2PublicUrl))) {
    // If R2_PUBLIC_URL is configured and the URL matches, it's directly accessible
    if (r2PublicUrl && url.startsWith(r2PublicUrl)) {
      return url;
    }
    return `/api/upload/proxy?url=${encodeURIComponent(url)}`;
  }

  // Local paths are served statically, no proxy needed
  return url;
}
