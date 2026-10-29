'use client';

import { useEffect, useState } from 'react';
import { Cloud, HardDrive, RefreshCw } from 'lucide-react';
import { apiFetch } from '@/lib/api-fetch';

/**
 * Task UQ (Unified Queue Management / Enhanced Online Operational Mode) —
 * status badge for the agency dashboard.
 *
 * Reads `onlineMode` from the desktop's local /api/db-status (polled):
 *   ONLINE  → the branch operates in unified-queue mode: every reception
 *             workstation shares ONE queue through the central API
 *             (PostgreSQL = source of truth, atomic ticket claims).
 *   OFFLINE → local-first queue (outbox syncs when the connection returns).
 *
 * The endpoint only exists inside the desktop shell — on web/mobile the poll
 * fails and the badge renders null (gracefully hidden). Desktops rebuilt
 * before Task UQ answer without `onlineMode` → also hidden (unknown).
 */
export function UnifiedQueueBadge() {
  const [mode, setMode] = useState<'ONLINE' | 'OFFLINE' | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const res = await apiFetch('/api/db-status');
        if (!res || !res.ok) throw new Error('db-status unavailable');
        const data = await res.json();
        if (!alive) return;
        const m = data?.onlineMode?.mode;
        setMode(m === 'ONLINE' || m === 'OFFLINE' ? m : null);
      } catch {
        if (alive) setMode(null); // not the desktop shell → hide
      }
    };
    poll();
    const iv = setInterval(poll, 10_000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, []);

  if (!mode) return null;

  const online = mode === 'ONLINE';
  return (
    <div
      role="status"
      aria-label={online ? 'Unified queue online' : 'Unified queue offline'}
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium border ${
        online
          ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800'
          : 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800'
      }`}
      title={
        online
          ? 'Unified queue active — all reception workstations share one queue through the central server (PostgreSQL source of truth, atomic ticket claims).'
          : 'Offline mode — this workstation operates on its local queue; changes sync to the central server when the connection returns.'
      }
    >
      {online ? (
        <Cloud className="h-3 w-3" aria-hidden="true" />
      ) : (
        <HardDrive className="h-3 w-3" aria-hidden="true" />
      )}
      <span>{online ? 'Unified queue · Central server' : 'Local queue · Offline'}</span>
      {!online && <RefreshCw className="h-2.5 w-2.5 opacity-60" aria-hidden="true" />}
    </div>
  );
}
