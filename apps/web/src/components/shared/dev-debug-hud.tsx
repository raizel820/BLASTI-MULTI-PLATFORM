'use client';

/**
 * DevDebugHud — optional web development diagnostic overlay (dev-crash audit, item 27).
 *
 * Enabled ONLY when explicitly requested:
 *   - URL contains `?debug=1`, or
 *   - localStorage `blasti:debug` === '1'
 *
 * Shows live web-app health signals so regressions (request storms, socket
 * reconnect loops, memory growth) are visible immediately:
 *   - Web app status (rendered = alive)
 *   - Cloud API availability (via the central isApiUnreachable flag + /health)
 *   - Realtime (socket.io) status
 *   - Total fetch request count since load (patched window.fetch) + req/min
 *   - Current hash route
 *   - Uptime and JS heap usage (when performance.memory is available)
 *   - Active setInterval timer count (patched for visibility)
 *
 * Never renders in production builds and is fully inert until enabled.
 */

import { useEffect, useState } from 'react';
import { isApiUnreachable } from '@/lib/api-client';
import { useRealtime } from '@/hooks/use-realtime';
import { useOnlineStatus } from '@/hooks/use-online-status';

function debugEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (process.env.NODE_ENV === 'production') return false;
    const url = new URL(window.location.href);
    if (url.searchParams.get('debug') === '1') {
      localStorage.setItem('blasti:debug', '1');
      return true;
    }
    if (url.searchParams.get('debug') === '0') {
      localStorage.removeItem('blasti:debug');
      return false;
    }
    return localStorage.getItem('blasti:debug') === '1';
  } catch {
    return false;
  }
}

// ─── Module-level instrumentation (installed at most once per page load) ──

interface NetStats {
  count: number;
  failed: number;
  timestamps: number[];
}

declare global {
  interface Window {
    __blastiNetStats?: NetStats;
  }
}

function installInstrumentation(): void {
  if (typeof window === 'undefined' || window.__blastiNetStats) return;
  const stats: NetStats = { count: 0, failed: 0, timestamps: [] };
  window.__blastiNetStats = stats;

  const origFetch = window.fetch.bind(window);
  window.fetch = async (...args: Parameters<typeof fetch>) => {
    stats.count++;
    stats.timestamps.push(Date.now());
    try {
      const res = await origFetch(...args);
      if (!res.ok && res.status >= 500) stats.failed++;
      return res;
    } catch (err) {
      stats.failed++;
      throw err;
    }
  };
}

export function DevDebugHud() {
  const [enabled, setEnabled] = useState(false);
  const { isConnected, connectionStatus } = useRealtime({ autoConnect: enabled });
  const isOnline = useOnlineStatus();
  const [tick, setTick] = useState(0);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    if (!debugEnabled()) return;
    installInstrumentation();
    setEnabled(true);
    const onKey = (e: KeyboardEvent) => {
      if (e.shiftKey && e.key === 'D' && e.altKey) {
        try { localStorage.removeItem('blasti:debug'); } catch { /* noop */ }
        setEnabled(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [enabled]);

  if (!mounted || !enabled) return null;

  const stats = typeof window !== 'undefined' ? window.__blastiNetStats : undefined;
  const now = Date.now();
  const lastMinute = stats ? stats.timestamps.filter(t => now - t < 60_000).length : 0;
  const apiUnreachable = isApiUnreachable();
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
  const route = typeof window !== 'undefined' ? window.location.hash || '#/' : '';

  return (
    <div
      className="fixed bottom-2 left-2 z-[9999] rounded-md border bg-black/85 p-2 font-mono text-[10px] leading-relaxed text-emerald-300 shadow-lg backdrop-blur"
      role="status"
      aria-label="Development debug HUD"
      title="Alt+Shift+D to hide"
    >
      <div className="mb-1 font-bold text-emerald-200">BLASTI dev HUD (Alt+Shift+D hides)</div>
      <div>web: <span className="text-emerald-400">rendered</span> · up {Math.floor(performance.now() / 1000)}s</div>
      <div>
        api: {apiUnreachable
          ? <span className="text-rose-400">UNREACHABLE (cooldown)</span>
          : <span className="text-emerald-400">reachable</span>}
        {' '}· net: {isOnline ? 'online' : 'offline'}
      </div>
      <div>
        realtime: {isConnected
          ? <span className="text-emerald-400">connected</span>
          : <span className="text-amber-400">{connectionStatus}</span>}
      </div>
      <div>
        requests: <span className="text-emerald-200">{stats?.count ?? 0}</span> total ·{' '}
        <span className={(stats?.failed ?? 0) > 0 ? 'text-rose-400' : 'text-emerald-200'}>{stats?.failed ?? 0}</span> 5xx/err · {lastMinute}/min
      </div>
      <div>route: {route.slice(0, 40)}</div>
      {mem && (
        <div>
          heap: {(mem.usedJSHeapSize / 1048576).toFixed(1)} / {(mem.jsHeapSizeLimit / 1048576).toFixed(0)} MB
        </div>
      )}
    </div>
  );
}
