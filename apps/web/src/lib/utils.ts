import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Get a safe URL for accessing uploaded files.
 *
 * All uploads are stored on the API server's local disk
 * (<api>/uploads/<type>/) and served through
 * GET /api/upload/file/:type/:name — no external storage provider
 * (Vercel Blob / Cloudflare R2 / S3) is involved, so URLs are used as-is.
 */
export function getProxiedUrl(url: string | null | undefined): string {
  return url || '';
}
