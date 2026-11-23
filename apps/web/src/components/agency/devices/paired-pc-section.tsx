'use client';

/**
 * PairedPCSection — dedicated "Paired PC devices" surface (0.6.105).
 * ────────────────────────────────────────────────────────────────────────
 * One card that answers, in REALTIME, for the branch computers:
 *
 *   • CURRENT MASTER PC  — who leads the shared-queue election right now
 *     (GET /api/lan-topology, polled 15s; offline Electron fallback: the
 *     local node's own /api/lan/status snapshot so the role is visible
 *     even with zero internet).
 *   • EVERY QUEUE-LIST COUNTER — per-branch counter chips with live state:
 *     SERVING #ticket / OCCUPIED by staff / IDLE + control-heartbeat freshness
 *     (GET /api/agency/counters, polled 10s + realtime queue events).
 *   • REGISTERED + PAIRED PC DEVICES — the locally saved AgencyDevice rows of
 *     type PC for the branch (staff scope) / per branch (owner scope).
 *   • LIVE ON LAN — the BLASTI desktop instances currently reporting to the
 *     topology (role/term/ip), so an unregistered-but-running PC is visible.
 *
 * SCOPING (requirement): staff accounts see THEIR branch only (branchId from
 * /api/agency/my-authority); the agency owner sees every branch grouped,
 * optionally narrowed by the device manager's branch filter.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { isRTL, type Language } from '@/i18n';
import { useRealtime } from '@/hooks/use-realtime';
import { apiFetch } from '@/lib/api-fetch';
import { unwrapListPayload } from '@/lib/list-payload';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Laptop, Crown, Building2, MonitorSpeaker, Radio, Pin, Wifi, Loader2,
} from 'lucide-react';
import {
  type AgencyDevice, type Branch, getLocalizedString, getLocalizedName,
  PulseDot, isRecentlyAlive, timeSince, useHeartbeatTick,
} from './types';

// ─── Types ───────────────────────────────────────────────────────────────────

interface TopologyNode {
  instanceId: string;
  name: string;
  ipAddress?: string | null;
  lanPort: number;
  role: string;
  term: number;
  branchId?: string | null;
  isPreferredMaster?: boolean;
  online: boolean;
  lastReportAt: string;
}

interface CurrentMaster {
  instanceId: string;
  name: string;
  ipAddress?: string | null;
  lanPort: number;
  term: number;
  online: boolean;
}

/** The local desktop's own election snapshot (/api/lan/status fallback). */
interface LanStatusSnapshot {
  role?: string;
  name?: string;
  lanIp?: string | null;
  lanPort?: number;
  term?: number;
  branchId?: string | null;
  master?: { name?: string; ipAddress?: string | null } | null;
  uptimeSec?: number;
}

interface PcCounterView {
  id: string;
  number: number;
  name: string;
  branchId?: string | null;
  branchName?: string | null;
  controllerName?: string | null;
  staffName?: string | null;
  currentTicket?: string | null;
  currentTicketStatus?: string | null;
  hasCurrentReservation?: boolean;
  controlHeartbeatAt?: string | null;
  occupiedAt?: string | null;
}

type CounterState = 'SERVING' | 'OCCUPIED' | 'IDLE';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function controllerFresh(iso?: string | null): boolean {
  if (!iso) return false;
  return Date.now() - new Date(iso).getTime() < 45_000;
}

function counterState(c: PcCounterView): CounterState {
  if (c.currentTicket || c.hasCurrentReservation) return 'SERVING';
  if (c.controllerName || c.occupiedAt) return 'OCCUPIED';
  return 'IDLE';
}

function localizedState(state: CounterState, lang: string): string {
  if (state === 'SERVING') return getLocalizedString('يخدم', 'Sert', 'Serving', lang);
  if (state === 'OCCUPIED') return getLocalizedString('مشغول', 'Occupé', 'Occupied', lang);
  return getLocalizedString('متاح', 'Libre', 'Idle', lang);
}

function stateChipClass(state: CounterState): string {
  if (state === 'SERVING') return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400';
  if (state === 'OCCUPIED') return 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400';
  return 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400';
}

function roleChipClass(role: string): string {
  if (role === 'MASTER') return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400';
  if (role === 'FOLLOWER') return 'bg-sky-100 text-sky-700 dark:bg-sky-950/40 dark:text-sky-400';
  return 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400';
}

function localizedRole(role: string, lang: string): string {
  if (role === 'MASTER') return getLocalizedString('ماستر', 'Maître', 'Master', lang);
  if (role === 'FOLLOWER') return getLocalizedString('تابع', 'Suiveur', 'Follower', lang);
  return getLocalizedString('مرشّح', 'Candidat', 'Candidate', lang);
}

/** Normalize the cloud (enriched) and local (raw row) counter shapes into one view. */
function normalizeCounter(raw: Record<string, unknown>): PcCounterView {
  const branch = raw.branch as { id?: string; name?: string; nameAr?: string | null; nameFr?: string | null } | null | undefined;
  const staff = raw.staff as { user?: { fullName?: string | null; username?: string | null } } | null | undefined;
  const reservation = raw.currentReservation as { displayNumber?: string | null; status?: string | null } | null | undefined;
  const controllerName = typeof raw.controlledByName === 'string' ? raw.controlledByName : null;
  const controllerId = typeof raw.controlledByUserId === 'string' ? raw.controlledByUserId : null;
  const staffName = staff?.user?.fullName || staff?.user?.username || null;
  return {
    id: String(raw.id ?? ''),
    number: typeof raw.number === 'number' ? raw.number : 0,
    name: String(raw.name ?? ''),
    branchId: (typeof raw.branchId === 'string' ? raw.branchId : null) ?? branch?.id ?? null,
    branchName: branch?.name ?? null,
    controllerName: controllerName || (controllerId ? controllerId : null),
    staffName,
    currentTicket: reservation?.displayNumber ?? null,
    currentTicketStatus: reservation?.status ?? null,
    hasCurrentReservation: Boolean(raw.currentReservationId),
    controlHeartbeatAt: typeof raw.controlHeartbeatAt === 'string' ? raw.controlHeartbeatAt : null,
    occupiedAt: typeof raw.occupiedAt === 'string' ? raw.occupiedAt : null,
  };
}

// ─── Component ───────────────────────────────────────────────────────────────

export function PairedPCSection({
  agencyId,
  lang,
  devices,
  branches,
  branchFilter,
  isOwner,
}: {
  agencyId: string;
  lang: Language;
  devices: AgencyDevice[];
  branches: Branch[];
  /** Device-manager branch filter (owner, multi-branch agencies only). */
  branchFilter: string;
  isOwner: boolean;
}) {
  const rtl = isRTL(lang);
  const realtime = useRealtime();
  useHeartbeatTick(10000);

  const [nodes, setNodes] = useState<TopologyNode[]>([]);
  const [currentMaster, setCurrentMaster] = useState<CurrentMaster | null>(null);
  const [lanStatus, setLanStatus] = useState<LanStatusSnapshot | null>(null);
  const [counters, setCounters] = useState<PcCounterView[]>([]);
  const [staffBranchId, setStaffBranchId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // ── Staff branch scope (from my-authority — 0.6.105 branchId) ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/agency/my-authority');
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (!cancelled && data?.branchId) setStaffBranchId(String(data.branchId));
      } catch { /* best-effort */ }
    })();
    return () => { cancelled = true; };
  }, [agencyId]);

  const fetchTopology = useCallback(async () => {
    if (!agencyId) return;
    try {
      const res = await apiFetch(`/api/lan-topology?agencyId=${encodeURIComponent(agencyId)}`);
      if (res.ok) {
        const data = await res.json();
        if (data?.success) {
          setNodes(Array.isArray(data.nodes) ? data.nodes : []);
          setCurrentMaster(data.currentMaster ?? null);
          setLanStatus(null);
          setLoaded(true);
          return;
        }
      }
    } catch { /* fall through to the local snapshot */ }
    // Electron / LAN-only fallback: the desktop's own election snapshot.
    try {
      const res = await apiFetch('/api/lan/status');
      if (res.ok) {
        const data = await res.json();
        const snap = (data?.data ?? data) as LanStatusSnapshot | undefined;
        if (snap && typeof snap === 'object') {
          setLanStatus(snap);
          setNodes([]);
          setCurrentMaster(null);
        }
      }
    } catch { /* offline with no local API — stay empty */ }
    setLoaded(true);
  }, [agencyId]);

  const fetchCounters = useCallback(async (silent = true) => {
    if (!agencyId) return;
    if (!silent) setRefreshing(true);
    try {
      const res = await apiFetch(`/api/agency/counters?agencyId=${encodeURIComponent(agencyId)}`);
      if (res.ok) {
        const data = await res.json();
        const rows = unwrapListPayload<Record<string, unknown>>(data, ['counters']);
        setCounters(rows.map(normalizeCounter));
      }
    } catch { /* keep the previous snapshot */ }
    finally { if (!silent) setRefreshing(false); }
  }, [agencyId]);

  useEffect(() => {
    fetchTopology();
    fetchCounters(false);
    const topologyTimer = setInterval(fetchTopology, 15_000);
    const counterTimer = setInterval(() => fetchCounters(true), 10_000);
    return () => { clearInterval(topologyTimer); clearInterval(counterTimer); };
  }, [fetchTopology, fetchCounters]);

  // ── Realtime nudges: queue + device events refresh the counter chips fast ──
  useEffect(() => {
    if (!agencyId) return;
    const debounced = () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => fetchCounters(true), 600);
    };
    const unsubs = [
      realtime.subscribe('queue:called', debounced),
      realtime.subscribe('queue:completed', debounced),
      realtime.subscribe('queue:no-show', debounced),
      realtime.subscribe('queue:cancelled', debounced),
      realtime.subscribe('device:status-changed', fetchTopology),
      realtime.subscribe('device:registered', fetchTopology),
    ];
    return () => unsubs.forEach((u) => u());
  }, [agencyId, fetchCounters, fetchTopology, realtime]);

  // ── Scope resolution ────────────────────────────────────────────────────────
  const visibleBranches = useMemo(() => {
    if (!isOwner) {
      // STAFF: their assigned branch only (fall back to nothing when unassigned).
      if (!staffBranchId) return [];
      return branches.filter((b) => b.id === staffBranchId);
    }
    if (branchFilter && branchFilter !== 'ALL') {
      return branches.filter((b) => b.id === branchFilter);
    }
    return branches;
  }, [branches, branchFilter, isOwner, staffBranchId]);

  const registeredPCs = useMemo(() => devices.filter((d) => d.type === 'PC'), [devices]);
  const pcsForBranch = useCallback(
    (branchId: string) => registeredPCs.filter((d) => d.branchId === branchId),
    [registeredPCs],
  );
  const nodesForBranch = useCallback(
    (branchId: string) => nodes.filter((n) => (n.branchId ?? null) === branchId),
    [nodes],
  );
  const countersForBranch = useCallback(
    (branchId: string) => counters.filter((c) => (c.branchId ?? null) === branchId),
    [counters],
  );

  /** Master PC display for ONE branch: branch-local live master → global → local snapshot. */
  const masterForBranch = useCallback((branchId: string): CurrentMaster | null => {
    const local = nodes.find((n) => n.role === 'MASTER' && n.online && (n.branchId ?? null) === branchId);
    if (local) {
      return { instanceId: local.instanceId, name: local.name, ipAddress: local.ipAddress, lanPort: local.lanPort, term: local.term, online: true };
    }
    if (currentMaster && !currentMaster.online) return null;
    return currentMaster;
  }, [nodes, currentMaster]);

  const hasAnyContent =
    registeredPCs.length > 0 || nodes.length > 0 || counters.length > 0 || lanStatus !== null;

  if (!agencyId) return null;

  // ─── Sub-renderers ──────────────────────────────────────────────────────────

  const renderMasterLine = (branchId: string) => {
    const master = masterForBranch(branchId);
    if (master) {
      return (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-200/70 bg-emerald-50/60 dark:border-emerald-900/40 dark:bg-emerald-950/20 px-2.5 py-1.5">
          <PulseDot color={master.online ? 'bg-emerald-500' : 'bg-gray-400'} pulse={master.online} />
          <Crown className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
          <span className="text-xs font-semibold truncate max-w-40">{master.name}</span>
          {master.ipAddress && (
            <span className="text-[10px] text-muted-foreground shrink-0" dir="ltr">{master.ipAddress}:{master.lanPort}</span>
          )}
          <Badge variant="secondary" className="text-[9px] h-4 px-1 shrink-0">
            {getLocalizedString('المصدر الأساسي للقائمة', 'Source de vérité', 'Source of truth', lang)}
          </Badge>
        </div>
      );
    }
    // Offline Electron fallback — this desktop's own snapshot.
    if (lanStatus) {
      const role = lanStatus.role || 'CANDIDATE';
      return (
        <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/40 px-2.5 py-1.5">
          <PulseDot color={role === 'MASTER' ? 'bg-emerald-500' : 'bg-sky-500'} pulse={role === 'MASTER'} />
          <Crown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="text-xs font-semibold truncate max-w-40">{lanStatus.name || getLocalizedString('هذا الكمبيوتر', 'Ce PC', 'This PC', lang)}</span>
          {lanStatus.lanIp && (
            <span className="text-[10px] text-muted-foreground shrink-0" dir="ltr">{lanStatus.lanIp}:{lanStatus.lanPort ?? 3080}</span>
          )}
          <Badge variant="secondary" className={`text-[9px] h-4 px-1 shrink-0 ${roleChipClass(role)}`}>{localizedRole(role, lang)}</Badge>
          {role !== 'MASTER' && lanStatus.master?.name && (
            <span className="text-[10px] text-muted-foreground truncate max-w-32">
              {getLocalizedString('الماستر:', 'Maître :', 'Master:', lang)} {lanStatus.master.name}
            </span>
          )}
        </div>
      );
    }
    return (
      <div className="flex items-center gap-2 rounded-lg border border-dashed border-border/60 px-2.5 py-1.5">
        <Crown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <span className="text-xs text-muted-foreground">
          {getLocalizedString('لا يوجد ماستر منتخب حالياً', 'Aucun maître élu actuellement', 'No master elected right now', lang)}
        </span>
      </div>
    );
  };

  const renderCounterChips = (branchId: string) => {
    const rows = countersForBranch(branchId);
    if (rows.length === 0) {
      return (
        <p className="text-[11px] text-muted-foreground">
          {getLocalizedString('لا توجد عدّادات في هذا الفرع', 'Aucun guichet dans cette succursale', 'No counters in this branch', lang)}
        </p>
      );
    }
    return (
      <div className="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
        {rows.map((c) => {
          const state = counterState(c);
          const live = controllerFresh(c.controlHeartbeatAt);
          const who = c.controllerName && c.controllerName.length < 60 ? c.controllerName : (c.staffName ?? null);
          return (
            <div key={c.id} className="flex items-center gap-2 rounded-lg border border-border/60 bg-white dark:bg-gray-900/60 px-2.5 py-1.5">
              <MonitorSpeaker className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold truncate">
                  {c.name || `#${c.number}`}
                  {c.currentTicket && (
                    <span className="ms-1.5 text-[10px] font-bold text-emerald-600 dark:text-emerald-400" dir="ltr">#{c.currentTicket}</span>
                  )}
                </p>
                {who && state !== 'IDLE' && (
                  <p className="text-[10px] text-muted-foreground truncate max-w-36">{who}</p>
                )}
              </div>
              <Badge variant="secondary" className={`text-[9px] h-4 px-1 shrink-0 ${stateChipClass(state)}`}>
                {localizedState(state, lang)}
              </Badge>
              <PulseDot color={live ? 'bg-emerald-500' : 'bg-gray-300 dark:bg-gray-700'} pulse={live} />
            </div>
          );
        })}
      </div>
    );
  };

  const renderPairedPCs = (branchId: string) => {
    const rows = pcsForBranch(branchId);
    if (rows.length === 0) return null;
    return (
      <div className="flex flex-wrap gap-1.5">
        {rows.map((d) => (
          <div key={d.id} className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-2.5 py-1.5">
            <PulseDot color={d.status === 'ONLINE' ? 'bg-emerald-500' : 'bg-gray-400'} pulse={d.status === 'ONLINE'} />
            <Laptop className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-xs font-medium truncate max-w-36">{getLocalizedName(d, lang)}</span>
            {d.ipAddress && <span className="text-[10px] text-muted-foreground" dir="ltr">{d.ipAddress}</span>}
            {d.status === 'ONLINE' ? (
              <span className="text-[10px] text-emerald-600 dark:text-emerald-400">{getLocalizedString('متصل', 'En ligne', 'Online', lang)}</span>
            ) : (
              <span className="text-[10px] text-muted-foreground">{timeSince(d.lastHeartbeatAt)}</span>
            )}
          </div>
        ))}
      </div>
    );
  };

  const renderLiveNodes = (branchId: string) => {
    const rows = nodesForBranch(branchId);
    if (rows.length === 0) return null;
    return (
      <div className="flex flex-wrap gap-1.5">
        {rows.map((n) => (
          <div key={n.instanceId} className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-2.5 py-1.5">
            <PulseDot color={n.online ? 'bg-emerald-500' : 'bg-gray-400'} pulse={n.online} />
            <Wifi className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-xs font-medium truncate max-w-36">{n.name}</span>
            <Badge variant="secondary" className={`text-[9px] h-4 px-1 shrink-0 ${roleChipClass(n.role)}`}>
              {localizedRole(n.role, lang)}
            </Badge>
            {n.isPreferredMaster && <Pin className="h-3 w-3 text-amber-500 shrink-0" />}
            {n.ipAddress && <span className="text-[10px] text-muted-foreground" dir="ltr">{n.ipAddress}:{n.lanPort}</span>}
          </div>
        ))}
      </div>
    );
  };

  // ─── Render ─────────────────────────────────────────────────────────────────
  return (
    <Card>
      <CardContent className="p-4 space-y-4" dir={rtl ? 'rtl' : 'ltr'}>
        {/* Header */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="p-2.5 rounded-lg bg-gradient-to-br from-sky-500 to-cyan-600 text-white shadow-sm shrink-0">
            <Laptop className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold leading-tight">
              {getLocalizedString('أجهزة الكمبيوتر المقترنة', 'PCs appairés', 'Paired PC devices', lang)}
            </p>
            <p className="text-xs text-muted-foreground">
              {getLocalizedString(
                'الماستر الحالي + عدّادات قائمة الانتظار — تحديث مباشر',
                'Maître actuel + guichets de la file — temps réel',
                'Current master PC + queue-list counters — live',
                lang,
              )}
            </p>
          </div>
          {refreshing && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground shrink-0" />}
          <Badge variant="outline" className="gap-1.5 py-1 shrink-0">
            <PulseDot color="bg-emerald-500" pulse />
            {getLocalizedString('مباشر', 'Direct', 'Live', lang)}
          </Badge>
        </div>

        {!loaded ? (
          <div className="flex items-center justify-center py-6 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : !hasAnyContent ? (
          <p className="text-xs text-muted-foreground py-3">
            {getLocalizedString(
              'لا توجد أجهزة كمبيوتر مقترنة بعد — افتح تطبيق بلاصتي المكتبي على أي كمبيوتر في الفرع وسيتظهر هنا تلقائياً.',
              'Aucun PC appairé — ouvrez l\'app BLASTI Desktop sur un PC de la succursale.',
              'No paired PCs yet — open the BLASTI desktop app on any branch PC and it appears here automatically.',
              lang,
            )}
          </p>
        ) : (
          <div className="space-y-4 max-h-96 overflow-y-auto custom-scrollbar pe-1">
            {visibleBranches.map((branch) => {
              const branchCounters = countersForBranch(branch.id);
              const branchPCs = pcsForBranch(branch.id);
              const branchNodes = nodesForBranch(branch.id);
              return (
                <div key={branch.id} className="rounded-xl border border-border/60 p-3 space-y-2.5">
                  {/* Branch header + master line */}
                  <div className="flex flex-wrap items-center gap-2">
                    <Building2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                    <span className="text-sm font-bold truncate max-w-48">{getLocalizedName(branch, lang)}</span>
                    <div className="flex-1 min-w-[200px]">{renderMasterLine(branch.id)}</div>
                  </div>

                  {/* Counters */}
                  <div className="space-y-1.5">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {getLocalizedString('عدّادات قائمة الانتظار', 'Guichets de la file', 'Queue-list counters', lang)}
                      {branchCounters.length > 0 && ` (${branchCounters.length})`}
                    </p>
                    {renderCounterChips(branch.id)}
                  </div>

                  {/* Paired + registered PC devices */}
                  {branchPCs.length > 0 && (
                    <div className="space-y-1.5">
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        {getLocalizedString('أجهزة مسجّلة ومقترنة', 'PCs enregistrés et appairés', 'Registered + paired PCs', lang)}
                        {` (${branchPCs.length})`}
                      </p>
                      {renderPairedPCs(branch.id)}
                    </div>
                  )}

                  {/* Live BLASTI desktop instances on the LAN */}
                  {branchNodes.length > 0 && (
                    <div className="space-y-1.5">
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        <Radio className="inline h-3 w-3 me-1" />
                        {getLocalizedString('نشط على الشبكة المحلية (تطبيق بلاصتي)', 'Actifs sur le LAN (app BLASTI)', 'Live on LAN (BLASTI app)', lang)}
                        {` (${branchNodes.length})`}
                      </p>
                      {renderLiveNodes(branch.id)}
                    </div>
                  )}
                </div>
              );
            })}

            {/* Staff with no assigned branch — honest empty state */}
            {visibleBranches.length === 0 && (
              <p className="text-xs text-muted-foreground py-3">
                {getLocalizedString(
                  'لا يوجد فرع معيّن لحسابك — اطلب من المالك تعيين فرعك.',
                  'Aucune succursale assignée à votre compte.',
                  'No branch assigned to your account — ask the owner to assign your branch.',
                  lang,
                )}
              </p>
            )}
          </div>
        )}

        {/* Owner sees a hint about the branch filter when multi-branch */}
        {isOwner && branches.length > 1 && (
          <p className="text-[10px] text-muted-foreground">
            {getLocalizedString(
              'استخدم مرشّح "الفرع" بالأسفل لتضييق هذا القسم وأجهزتك المقترنة إلى فرع واحد.',
              'Utilisez le filtre « Succursale » ci-dessous pour restreindre cette section.',
              'Use the "Branch" filter below to narrow this section and your paired devices to one branch.',
              lang,
            )}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
// (end of PairedPCSection)
