'use client';

/**
 * usePublicAppVersions — shared loader for the PUBLIC installer catalog.
 *
 * Fetches GET /api/app-versions/public/active once (no auth) and exposes the
 * ACTIVE (admin-activated) version per platform:
 *
 *   windows | mac | linux | electron   → desktop installers
 *   android | android-debug | ios      → mobile packages
 *
 * `android` is the RELEASE channel (Play-style signed build) and
 * `android-debug` is the DEBUG channel (debug-keystore APK the CI produces) —
 * the landing page offers both choices for mobile.
 *
 * Consumers: components/platform/download-app-button.tsx (header/hero CTA)
 * and components/platform/download-section.tsx ("BLASTI on Every Device").
 */

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import { getProxiedUrl } from '@/lib/utils';

export interface PublicAppVersion {
  platform: string;
  version: string;
  versionCode: number;
  releaseNotes: string;
  fileName: string | null;
  fileSize: number | null;
  downloadUrl: string;
  downloadCount?: number;
  publishedAt?: string | null;
}

/** Desktop platforms the public download UI offers, in display order. */
export const DESKTOP_PLATFORMS = ['windows', 'mac', 'linux'] as const;
/** Mobile channels the public download UI offers, in display order. */
export const MOBILE_PLATFORMS = ['android', 'android-debug', 'ios'] as const;

export type PublicPlatform = (typeof DESKTOP_PLATFORMS)[number] | (typeof MOBILE_PLATFORMS)[number];

/** "155.1 MB" / "640 KB" — language-neutral unit formatting. */
export function formatSize(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** "v0.3.4 · 155.1 MB" — version + size subtitle for buttons and menu rows. */
export function formatVersionLabel(v: PublicAppVersion | null | undefined): string {
  if (!v) return '';
  const size = formatSize(v.fileSize);
  return size ? `v${v.version} · ${size}` : `v${v.version}`;
}

/**
 * Best desktop platform key for the visitor's OS ('' when undetectable).
 * Reused by the section + the dropdown to pre-select the recommendation.
 */
export function detectDesktopPlatform(ua?: string): 'windows' | 'mac' | 'linux' | '' {
  if (typeof navigator === 'undefined' && !ua) return '';
  const agent = ua ?? navigator.userAgent;
  if (/Mac OS X|Macintosh/.test(agent)) return 'mac';
  if (/Windows/.test(agent)) return 'windows';
  if (/Linux/.test(agent)) return 'linux';
  return '';
}

export function usePublicAppVersions() {
  const [versions, setVersions] = useState<Record<string, PublicAppVersion>>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/app-versions/public/active');
        if (!cancelled && res.ok) {
          const data = await res.json();
          if (data?.success && Array.isArray(data.versions)) {
            const map: Record<string, PublicAppVersion> = {};
            for (const v of data.versions) map[v.platform] = v;
            setVersions(map);
          }
        }
      } catch {
        // Offline / API down — the UI degrades to "coming soon" states.
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const getVersion = useCallback(
    (platform: string): PublicAppVersion | null => versions[platform] ?? null,
    [versions],
  );

  /** True when at least one installer exists for the given group. */
  const hasAny = useCallback(
    (platforms: readonly string[]): boolean => platforms.some((p) => !!versions[p]),
    [versions],
  );

  /**
   * Trigger the download of the stored installer. The stored path is
   * relative (/api/app-versions/<id>/download) — getProxiedUrl rebases it
   * onto the API origin per platform (gateway XTransformPort / loopback
   * :3003 / Electron cloud base). Returns false when nothing is published.
   *
   * Uses a synthetic <a download> click instead of window.open: the server
   * answers with Content-Disposition: attachment, the anchor method works
   * from any gesture context (Radix onSelect, dropdown close races) and is
   * never treated as a popup blocker case.
   */
  const download = useCallback(
    (platform: string): boolean => {
      const v = versions[platform];
      if (!v?.downloadUrl || typeof document === 'undefined') return false;
      const a = document.createElement('a');
      a.href = getProxiedUrl(v.downloadUrl);
      a.rel = 'noopener';
      if (v.fileName) a.download = v.fileName;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
      return true;
    },
    [versions],
  );

  return { versions, loaded, getVersion, hasAny, download };
}
