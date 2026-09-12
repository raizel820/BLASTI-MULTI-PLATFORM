import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatTime(date: Date | string | null | undefined): string {
  if (!date) return '--:--';
  const d = typeof date === 'string' ? new Date(date) : date;
  if (isNaN(d.getTime())) return '--:--';
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
}

export function formatDate(date: Date | string | null | undefined): string {
  if (!date) return '';
  const d = typeof date === 'string' ? new Date(date) : date;
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatRelativeTime(date: Date | string | null | undefined): string {
  if (!date) return '';
  const d = typeof date === 'string' ? new Date(date) : date;
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

export function formatWaitTime(minutes: number | null): string {
  if (minutes === null || minutes === undefined) return '--';
  if (minutes < 1) return '<1 min';
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);
  return `${hours}h ${mins}m`;
}

export function getStatusColor(status: string): string {
  switch (status.toUpperCase()) {
    case 'WAITING': return 'text-amber-400';
    case 'CALLED': return 'text-blue-400';
    case 'SERVING': return 'text-emerald-400';
    case 'COMPLETED': return 'text-slate-400';
    case 'CANCELLED': return 'text-red-400';
    case 'NO_SHOW': case 'NOSHOW': return 'text-orange-400';
    case 'POSTPONED': return 'text-purple-400';
    default: return 'text-slate-400';
  }
}

export function getStatusBgColor(status: string): string {
  switch (status.toUpperCase()) {
    case 'WAITING': return 'bg-amber-400/10 text-amber-400';
    case 'CALLED': return 'bg-blue-400/10 text-blue-400';
    case 'SERVING': return 'bg-emerald-400/10 text-emerald-400';
    case 'COMPLETED': return 'bg-slate-400/10 text-slate-400';
    case 'CANCELLED': return 'bg-red-400/10 text-red-400';
    case 'NO_SHOW': case 'NOSHOW': return 'bg-orange-400/10 text-orange-400';
    case 'POSTPONED': return 'bg-purple-400/10 text-purple-400';
    default: return 'bg-slate-400/10 text-slate-400';
  }
}

export function generateTicketNumber(position: number): string {
  return `A-${String(position).padStart(3, '0')}`;
}

// ─── Merged from Web utils.ts ────────────────────────────────────────────────

/**
 * Get a proxied URL for accessing private storage files.
 *
 * Desktop adaptation: In Electron, local files are served directly from the
 * local API server at http://127.0.0.1:3080. No Vercel/R2 proxy is needed.
 *
 * @param url - The original URL to potentially proxy
 * @returns The URL to use for accessing the file
 */
export function getProxiedUrl(url: string | null | undefined): string {
  if (!url) return '';

  // Vercel Blob URLs — route through local API proxy
  if (url.includes('.blob.vercel-storage.com')) {
    return `/api/upload/proxy?url=${encodeURIComponent(url)}`;
  }

  // R2 URLs — route through local API proxy (no public R2 URL in desktop)
  if (url.includes('.r2.cloudflarestorage.com')) {
    return `/api/upload/proxy?url=${encodeURIComponent(url)}`;
  }

  // Local paths and other URLs — return as-is
  return url;
}
