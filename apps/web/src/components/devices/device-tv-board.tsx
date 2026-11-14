'use client';

/**
 * DeviceTvBoard — TV screen shell (0.6.74).
 * ─────────────────────────────────────────
 * Chooses WHICH simple design renders, then delegates:
 *
 *   1. URL override        ?layout=classic|counters|focus|minimal|board
 *   2. Device config       AgencyDevice.screenLayout (TV_CLASSIC | TV_COUNTERS | …)
 *                          — fetched once with the stored device token
 *   3. Local persistence   localStorage.blasti_tv_layout (fast re-boots)
 *   4. Default             QUEUE_BOARD → the historic rich board
 *
 * The four new designs share one data hook (use-tv-board-data). The rich
 * board stays fully self-contained in ./tv/tv-detailed.tsx.
 */

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import type { Language } from '@/i18n';
import { useLanguage } from '@/hooks/use-language';
import { DeviceTvBoardDetailed } from './tv/tv-detailed';
import { TvClassic } from './tv/layouts/tv-classic';
import { TvCounters } from './tv/layouts/tv-counters';
import { TvFocus } from './tv/layouts/tv-focus';
import { TvMinimal } from './tv/layouts/tv-minimal';
import { useTvBoardData, type TvScreenLayout } from './tv/use-tv-board-data';

const TV_LAYOUTS: TvScreenLayout[] = ['TV_CLASSIC', 'TV_COUNTERS', 'TV_FOCUS', 'TV_MINIMAL'];

const URL_LAYOUT_MAP: Record<string, TvScreenLayout | 'QUEUE_BOARD'> = {
  classic: 'TV_CLASSIC',
  counters: 'TV_COUNTERS',
  focus: 'TV_FOCUS',
  minimal: 'TV_MINIMAL',
  board: 'QUEUE_BOARD',
  detailed: 'QUEUE_BOARD',
  queue: 'QUEUE_BOARD',
  tv_classic: 'TV_CLASSIC',
  tv_counters: 'TV_COUNTERS',
  tv_focus: 'TV_FOCUS',
  tv_minimal: 'TV_MINIMAL',
  queue_board: 'QUEUE_BOARD',
};

function layoutFromUrl(): TvScreenLayout | 'QUEUE_BOARD' | null {
  if (typeof window === 'undefined') return null;
  const raw = new URLSearchParams(window.location.search).get('layout');
  if (!raw) return null;
  return URL_LAYOUT_MAP[raw.toLowerCase()] ?? null;
}

interface DeviceTvBoardProps {
  agencyId?: string;
  onBack?: () => void;
  currentLang?: Language;
}

export function DeviceTvBoard({ agencyId, onBack, currentLang }: DeviceTvBoardProps) {
  const { lang: appLang } = useLanguage();
  // ── Layout resolution ────────────────────────────────────────────────────
  const [configLayout, setConfigLayout] = useState<TvScreenLayout | null>(null);
  const [layoutResolved, setLayoutResolved] = useState(false);

  const urlLayout = useMemo(() => layoutFromUrl(), []);

  // URL override wins over the device config / persisted choice.
  const effectiveLayout: TvScreenLayout | null =
    urlLayout && urlLayout !== 'QUEUE_BOARD' ? urlLayout : configLayout;

  useEffect(() => {
    if (urlLayout) {
      // Persist an explicit URL choice so the next boot (without params) keeps
      // showing the same design.
      if (urlLayout !== 'QUEUE_BOARD') {
        try { localStorage.setItem('blasti_tv_layout', urlLayout); } catch { /* private mode */ }
      }
      setLayoutResolved(true);
      return;
    }
    // Persisted choice → instant.
    try {
      const saved = localStorage.getItem('blasti_tv_layout');
      if (saved && (TV_LAYOUTS as string[]).includes(saved)) {
        setConfigLayout(saved as TvScreenLayout);
        setLayoutResolved(true);
        return;
      }
    } catch { /* private mode */ }

    // Ask the device config once (stored token) which screen this TV shows.
    (async () => {
      try {
        const token = localStorage.getItem('blasti_tv_device_token');
        if (!token) {
          setLayoutResolved(true);
          return;
        }
        const res = await apiFetch('/api/agency-devices/device/config', {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        if (res.ok) {
          const data = await res.json();
          const layout = data?.config?.screenLayout;
          if (typeof layout === 'string' && (TV_LAYOUTS as string[]).includes(layout)) {
            setConfigLayout(layout as TvScreenLayout);
            try { localStorage.setItem('blasti_tv_layout', layout); } catch { /* ignore */ }
          }
        }
      } catch { /* offline / unregistered → default board */ }
      setLayoutResolved(true);
    })();
  }, [urlLayout]);

  // ── Simple screens: one shared data pipeline ─────────────────────────────
  // Registration is gated: while the rich board is the active renderer it
  // performs its own registration — the hook must NOT register in parallel
  // (that race created duplicate devices). While the layout resolution is
  // still pending, registration stays off too.
  const richBoardActive = layoutResolved && !urlLayout && !configLayout;
  const registerEnabled =
    urlLayout !== null
      ? urlLayout !== 'QUEUE_BOARD'
      : layoutResolved
        ? !richBoardActive
        : false;
  const tvData = useTvBoardData({ agencyId, registerEnabled });

  // First-boot layout discovery: a freshly provisioned TV has no stored token
  // when the shell probes, so we re-probe the device config as soon as the
  // data hook registers (or restores) a token — the manager-configured design
  // (screenLayout) then applies without a manual reload.
  const [tokenProbeDone, setTokenProbeDone] = useState(false);
  useEffect(() => {
    if (urlLayout || configLayout || tokenProbeDone || !tvData.deviceToken) return;
    setTokenProbeDone(true);
    (async () => {
      try {
        const res = await apiFetch('/api/agency-devices/device/config', {
          headers: { 'Authorization': `Bearer ${tvData.deviceToken}` },
        });
        if (res.ok) {
          const data = await res.json();
          const layout = data?.config?.screenLayout;
          if (typeof layout === 'string' && (TV_LAYOUTS as string[]).includes(layout)) {
            setConfigLayout(layout as TvScreenLayout);
            try { localStorage.setItem('blasti_tv_layout', layout); } catch { /* ignore */ }
          }
        }
      } catch { /* offline → keep the rich board */ }
    })();
  }, [tvData.deviceToken, urlLayout, configLayout, tokenProbeDone]);

  // First-boot fallback: when the rich board registered the device itself the
  // hook stays passive, so poll briefly for the token appearing in storage
  // and re-probe the config once (fresh TV + manager-configured design).
  useEffect(() => {
    if (urlLayout || configLayout || tokenProbeDone || !layoutResolved) return;
    let attempts = 0;
    const interval = setInterval(async () => {
      attempts += 1;
      try {
        const token = localStorage.getItem('blasti_tv_device_token');
        if (!token) {
          if (attempts >= 8) clearInterval(interval);
          return;
        }
        clearInterval(interval);
        const res = await apiFetch('/api/agency-devices/device/config', {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        if (res.ok) {
          const data = await res.json();
          const layout = data?.config?.screenLayout;
          if (typeof layout === 'string' && (TV_LAYOUTS as string[]).includes(layout)) {
            setConfigLayout(layout as TvScreenLayout);
            try { localStorage.setItem('blasti_tv_layout', layout); } catch { /* ignore */ }
          }
        }
      } catch {
        if (attempts >= 8) clearInterval(interval);
      }
    }, 2500);
    return () => clearInterval(interval);
  }, [urlLayout, configLayout, tokenProbeDone, layoutResolved]);

  // ── Fullscreen (owned here — the data hook stays ref-free) ─────────────
  const shellRef = useRef<HTMLDivElement>(null);
  const toggleFullscreen = useCallback(async () => {
    try {
      if (!document.fullscreenElement) {
        await shellRef.current?.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch { /* user gesture required */ }
  }, []);

  useEffect(() => {
    if (!tvData.isDeviceMode) return;
    const timer = setTimeout(async () => {
      try {
        if (!document.fullscreenElement && shellRef.current) {
          await shellRef.current.requestFullscreen();
        }
      } catch { /* denied — needs a gesture */ }
    }, 1500);
    return () => clearTimeout(timer);
  }, [tvData.isDeviceMode]);

  const lang: string = tvData.displaySettings.language || currentLang || appLang || 'en';
  const rtl = lang === 'ar';

  // ── Render ───────────────────────────────────────────────────────────────
  if (urlLayout === 'QUEUE_BOARD' || (layoutResolved && !urlLayout && !configLayout)) {
    // Explicit board URL override, or resolution finished with no simple
    // layout configured → the historic rich board.
    return <DeviceTvBoardDetailed agencyId={agencyId} onBack={onBack} currentLang={currentLang} />;
  }

  if (!layoutResolved) {
    // Brief splash while the device config is probed (avoids flashing the
    // wrong design on boot).
    return (
      <div className="grid min-h-screen place-items-center bg-gray-950" dir={rtl ? 'rtl' : 'ltr'}>
        <div className="flex flex-col items-center gap-4">
          <div className="h-14 w-14 animate-pulse rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600" />
          <div className="h-2 w-28 animate-pulse rounded-full bg-white/10" />
        </div>
      </div>
    );
  }

  const layoutProps = {
    status: tvData.status,
    loading: tvData.loading,
    currentTime: tvData.currentTime,
    displaySettings: tvData.displaySettings,
    dataIsFresh: tvData.dataIsFresh,
    fetchFailed: tvData.fetchFailed,
    flashIds: tvData.flashIds,
    lang,
  };

  const simpleScreen = (
    <div ref={shellRef} className="h-screen w-screen overflow-hidden">
      {effectiveLayout === 'TV_COUNTERS' ? (
        <TvCounters {...layoutProps} />
      ) : effectiveLayout === 'TV_FOCUS' ? (
        <TvFocus {...layoutProps} />
      ) : effectiveLayout === 'TV_MINIMAL' ? (
        <TvMinimal {...layoutProps} />
      ) : (
        <TvClassic {...layoutProps} />
      )}
    </div>
  );

  // Fullscreen hotkey (F) for the simple screens — parity with the rich board.
  return <TvFullscreenShell onKeyF={() => toggleFullscreen()}>{simpleScreen}</TvFullscreenShell>;
}

function TvFullscreenShell({ children, onKeyF }: { children: React.ReactNode; onKeyF: () => void }) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'f' || e.key === 'F') {
        if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA') return;
        e.preventDefault();
        onKeyF();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onKeyF]);
  return <>{children}</>;
}
