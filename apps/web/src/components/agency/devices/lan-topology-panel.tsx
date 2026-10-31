'use client'
/**
 * lan-topology-panel.tsx — "Branch LAN & Master PC" section (r21-9).
 * ─────────────────────────────────────────────────────────────────────────────
 * The Owner Device Manager's live map of the branch LAN:
 *   • every BLASTI desktop PC connected to the branch (reported by the
 *     desktop's lan-authority every 30s → cloud /api/lan-topology);
 *   • the CURRENT MASTER PC highlighted (the offline election winner);
 *   • one-press MANUAL master selection — pin a PC (or return to auto);
 *   • per-PC joined device registry (kiosks / TVs / web sessions that joined
 *     that master) with the freshest one marked ACTIVE.
 * Polls every 15s and re-polls immediately after a pin change.
 */
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Monitor,
  MonitorSmartphone,
  Crown,
  Pin,
  PinOff,
  Wifi,
  WifiOff,
  ChevronDown,
  ChevronUp,
  Loader2,
  Server,
  RefreshCw,
} from 'lucide-react';
import { toast } from 'sonner';
import { getLocalizedString } from './types';

type Lang = string;

interface JoinedDevice {
  deviceId: string;
  name?: string | null;
  platform?: string | null;
  username?: string | null;
  lastSeenAt?: string | null;
}

interface LanNode {
  id: string;
  instanceId: string;
  name: string;
  hostname?: string | null;
  ipAddress?: string | null;
  lanPort: number;
  role: 'CANDIDATE' | 'FOLLOWER' | 'MASTER' | string;
  term: number;
  specScore: number;
  uptimeSec: number;
  branchId?: string | null;
  isPreferredMaster: boolean;
  online: boolean;
  lastReportAt: string;
  joinedDevices: JoinedDevice[];
}

interface CurrentMaster {
  instanceId: string;
  name: string;
  ipAddress?: string | null;
  lanPort: number;
  role: string;
  term: number;
  specScore: number;
  online: boolean;
  lastReportAt: string;
}

/** Relative "last seen" in the UI language (ar / fr / en). */
function relativeTime(iso: string | null | undefined, lang: Lang): string {
  if (!iso) return getLocalizedString('غير معروف', 'Inconnu', 'Unknown', lang);
  const delta = Math.max(0, Date.now() - new Date(iso).getTime());
  const sec = Math.floor(delta / 1000);
  if (sec < 10) return getLocalizedString('الآن', "à l'instant", 'just now', lang);
  if (sec < 60) return getLocalizedString(`قبل ${sec} ث`, `il y a ${sec} s`, `${sec}s ago`, lang);
  const min = Math.floor(sec / 60);
  if (min < 60) return getLocalizedString(`قبل ${min} د`, `il y a ${min} min`, `${min}m ago`, lang);
  const hr = Math.floor(min / 60);
  return getLocalizedString(`قبل ${hr} س`, `il y a ${hr} h`, `${hr}h ago`, lang);
}

function uptimeLabel(sec: number, lang: Lang): string {
  if (sec < 60) return getLocalizedString(`${sec} ث`, `${sec} s`, `${sec}s`, lang);
  const min = Math.floor(sec / 60);
  if (min < 60) return getLocalizedString(`${min} د`, `${min} min`, `${min}m`, lang);
  const hr = Math.floor(min / 60);
  const rem = min % 60;
  return getLocalizedString(`${hr} س ${rem} د`, `${hr} h ${rem} min`, `${hr}h ${rem}m`, lang);
}

export function LanTopologyPanel({ agencyId, lang }: { agencyId: string | undefined; lang: Lang }) {
  const [nodes, setNodes] = useState<LanNode[]>([]);
  const [currentMaster, setCurrentMaster] = useState<CurrentMaster | null>(null);
  const [preferredInstanceId, setPreferredInstanceId] = useState<string | null>(null);
  const [totalJoined, setTotalJoined] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [pinningId, setPinningId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const fetchTopology = useCallback(async () => {
    if (!agencyId) return;
    try {
      const res = await apiFetch(`/api/lan-topology?agencyId=${encodeURIComponent(agencyId)}`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.success) {
        setNodes(data.nodes ?? []);
        setCurrentMaster(data.currentMaster ?? null);
        setPreferredInstanceId(data.preferredInstanceId ?? null);
        setTotalJoined(data.totalJoinedDevices ?? 0);
        setLoaded(true);
      }
    } catch {
      // Silent — the panel is best-effort (desktops may simply not be running)
    }
  }, [agencyId]);

  useEffect(() => {
    fetchTopology();
    const interval = setInterval(fetchTopology, 15_000);
    return () => clearInterval(interval);
  }, [fetchTopology]);

  const pinMaster = useCallback(async (instanceId: string | null) => {
    if (!agencyId) return;
    setPinningId(instanceId ?? '__auto__');
    try {
      const res = await apiFetch('/api/lan-topology/preference', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agencyId, instanceId }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.success) {
        toast.success(
          instanceId
            ? getLocalizedString('تم تعيين الـ Master — ستطبقه الأجهزة خلال ثوانٍ', 'Maître défini — appliqué sous peu', 'Master pinned — devices apply it within seconds', lang)
            : getLocalizedString('أُلغي التعيين — الانتخاب التلقائي يعمل من جديد', 'Pin effacé — élection automatique', 'Pin cleared — automatic election resumes', lang),
        );
        await fetchTopology();
      } else {
        toast.error(data?.error || getLocalizedString('فشل التعيين', 'Échec de la définition', 'Failed to set master', lang));
      }
    } catch {
      toast.error(getLocalizedString('تعذّر الاتصال بالخادم', 'Connexion au serveur impossible', 'Could not reach the server', lang));
    } finally {
      setPinningId(null);
    }
  }, [agencyId, fetchTopology, lang]);

  const toggleExpanded = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const onlineNodes = nodes.filter((n) => n.online);
  const offlineNodes = nodes.filter((n) => !n.online);
  const roleBadge = (node: LanNode) => {
    if (node.role === 'MASTER') {
      return <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300 border-emerald-200 dark:border-emerald-900 text-[10px]">{getLocalizedString('ماستر', 'Maître', 'MASTER', lang)}</Badge>;
    }
    if (node.role === 'FOLLOWER') {
      return <Badge variant="secondary" className="text-[10px]">{getLocalizedString('تابع', 'Suiveur', 'FOLLOWER', lang)}</Badge>;
    }
    return <Badge variant="outline" className="text-[10px] text-amber-600 dark:text-amber-400 border-amber-300 dark:border-amber-800">{getLocalizedString('مرشح', 'Candidat', 'CANDIDATE', lang)}</Badge>;
  };

  if (!agencyId) return null;

  return (
    <div className="space-y-3" data-testid="lan-topology-panel">
      {/* ── Current Master PC card ── */}
      <Card className={currentMaster?.online ? 'border-emerald-300 dark:border-emerald-800 bg-emerald-50/40 dark:bg-emerald-950/20' : ''}>
        <CardContent className="p-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className={`p-2.5 rounded-lg shrink-0 ${currentMaster?.online ? 'bg-emerald-100 text-emerald-600 dark:bg-emerald-950/60 dark:text-emerald-400' : 'bg-muted text-muted-foreground'}`}>
              <Crown className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-muted-foreground">
                {getLocalizedString('الـ Master PC الحالي', 'PC Maître actuel', 'Current Master PC', lang)}
              </p>
              {currentMaster ? (
                <p className="text-sm font-semibold truncate" data-testid="current-master-name">
                  {currentMaster.name}
                  <span className="text-xs font-normal text-muted-foreground ms-2">
                    {currentMaster.ipAddress ? `${currentMaster.ipAddress}:${currentMaster.lanPort}` : currentMaster.instanceId.slice(0, 12)}
                    {' · '}term {currentMaster.term}
                  </span>
                </p>
              ) : (
                <p className="text-sm font-semibold" data-testid="current-master-none">
                  {getLocalizedString('لا يوجد ماستر — لا توجد أجهزة PC تابعة للفرع تعمل الآن', 'Aucun maître — aucun PC de branche en ligne', 'No master — no branch PCs online', lang)}
                </p>
              )}
            </div>
            {currentMaster && (
              <div className="flex items-center gap-2 shrink-0">
                <span className={`h-2.5 w-2.5 rounded-full ${currentMaster.online ? 'bg-emerald-500' : 'bg-gray-400'}`} aria-hidden />
                <span className="text-xs text-muted-foreground">{relativeTime(currentMaster.lastReportAt, lang)}</span>
              </div>
            )}
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5 shrink-0"
              disabled={pinningId !== null || preferredInstanceId === null}
              onClick={() => pinMaster(null)}
              data-testid="clear-master-pin"
            >
              {pinningId === '__auto__' ? <Loader2 className="h-4 w-4 animate-spin" /> : <PinOff className="h-4 w-4" />}
              {getLocalizedString('انتخاب تلقائي', 'Automatique', 'Automatic', lang)}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground mt-2">
            {getLocalizedString(
              'الماستر هو حاسوب الفرع الذي يملك قاعدة الحقيقة أثناء العمل دون إنترنت؛ اختر جهازًا أدناه لتثبيته يدويًا أو اترك الانتخاب التلقائي.',
              'Le maître détient la source de vérité hors ligne ; épinglez un PC ci-dessous ou laissez l’élection automatique.',
              'The master owns the offline source of truth; pin a PC below or leave the election automatic.',
              lang,
            )}
          </p>
        </CardContent>
      </Card>

      {/* ── Node list ── */}
      {!loaded ? (
        <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          {getLocalizedString('جارٍ استطلاع أجهزة الفرع…', 'Recherche des PC de la branche…', 'Scanning branch PCs…', lang)}
        </div>
      ) : nodes.length === 0 ? (
        <div className="rounded-lg border border-dashed p-6 text-center space-y-1">
          <Server className="h-8 w-8 mx-auto text-muted-foreground/50" />
          <p className="text-sm font-medium">{getLocalizedString('لم تتصل أي أجهزة PC بالفرع بعد', 'Aucun PC connecté à la branche', 'No PCs have connected to the branch yet', lang)}</p>
          <p className="text-xs text-muted-foreground max-w-md mx-auto">
            {getLocalizedString(
              'افتح تطبيق Blasti Desktop على حاسوب الفرع — سيظهر هنا خلال ~30 ثانية مع دوره في الشبكة وأجهزته المتصلة.',
              'Ouvrez Blasti Desktop sur le PC de la branche — il apparaîtra ici sous ~30 s.',
              'Open the Blasti Desktop app on a branch PC — it appears here within ~30 seconds.',
              lang,
            )}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <MonitorSmartphone className="h-3.5 w-3.5" />
            <span>
              {getLocalizedString(
                `${onlineNodes.length} جهاز متصل · ${totalJoined} جهاز تابع متسجل`,
                `${onlineNodes.length} PC en ligne · ${totalJoined} appareils joints`,
                `${onlineNodes.length} PC online · ${totalJoined} joined devices`,
                lang,
              )}
            </span>
            <Button size="sm" variant="ghost" className="ms-auto h-7 w-7 p-0" onClick={fetchTopology} aria-label="refresh topology">
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </div>

          {[...onlineNodes, ...offlineNodes].map((node) => {
            const joinedSorted = [...node.joinedDevices].sort((a, b) => (b.lastSeenAt ?? '').localeCompare(a.lastSeenAt ?? ''));
            const activeDevice = node.online ? joinedSorted[0] : undefined;
            const isPinned = node.isPreferredMaster;
            const isOpen = expanded.has(node.id);
            return (
              <Card key={node.id} className={`${!node.online ? 'opacity-60' : ''} ${isPinned ? 'ring-1 ring-primary/40' : ''}`}>
                <CardContent className="p-3">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <span className={`h-2.5 w-2.5 rounded-full shrink-0 ${node.online ? 'bg-emerald-500' : 'bg-gray-400'}`} aria-hidden />
                    <div className="p-1.5 rounded bg-muted text-muted-foreground shrink-0">
                      <Monitor className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold truncate flex items-center gap-2 flex-wrap">
                        {node.name}
                        {roleBadge(node)}
                        {isPinned && (
                          <Badge variant="outline" className="text-[10px] border-primary/50 text-primary">
                            <Pin className="h-3 w-3 me-1" />
                            {getLocalizedString('مثبّت', 'Épinglé', 'Pinned', lang)}
                          </Badge>
                        )}
                      </p>
                      <p className="text-[11px] text-muted-foreground truncate">
                        {node.hostname || node.instanceId.slice(0, 16)}
                        {node.ipAddress ? ` · ${node.ipAddress}:${node.lanPort}` : ''}
                        {` · spec ${node.specScore}`}
                        {` · ${node.online ? uptimeLabel(node.uptimeSec, lang) : relativeTime(node.lastReportAt, lang)}`}
                      </p>
                    </div>
                    {node.joinedDevices.length > 0 && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 gap-1 text-xs"
                        onClick={() => toggleExpanded(node.id)}
                        aria-expanded={isOpen}
                      >
                        <MonitorSmartphone className="h-3.5 w-3.5" />
                        {node.joinedDevices.length}
                        {isOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                      </Button>
                    )}
                    {node.role === 'MASTER' ? (
                      <span className="flex items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400 shrink-0">
                        <Crown className="h-3.5 w-3.5" />
                        {getLocalizedString('يعمل الآن', 'Actif', 'Active now', lang)}
                      </span>
                    ) : (
                      <Button
                        size="sm"
                        variant={isPinned ? 'secondary' : 'outline'}
                        className="gap-1.5 shrink-0"
                        disabled={!node.online || pinningId !== null}
                        onClick={() => pinMaster(node.instanceId)}
                        data-testid={`pin-master-${node.instanceId}`}
                      >
                        {pinningId === node.instanceId ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Pin className="h-3.5 w-3.5" />}
                        {isPinned
                          ? getLocalizedString('معيّن', 'Épinglé', 'Pinned', lang)
                          : getLocalizedString('اجعله الـ Master', 'Définir comme maître', 'Make Master', lang)}
                      </Button>
                    )}
                  </div>

                  {isOpen && node.joinedDevices.length > 0 && (
                    <div className="mt-2 border-t pt-2 space-y-1 max-h-48 overflow-y-auto" data-testid={`joined-devices-${node.instanceId}`}>
                      {joinedSorted.map((d) => {
                        const fresh = d.lastSeenAt ? Date.now() - new Date(d.lastSeenAt).getTime() < 65_000 : false;
                        return (
                          <div key={d.deviceId} className="flex items-center gap-2 text-xs px-1 py-0.5">
                            <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${fresh ? 'bg-emerald-500' : 'bg-gray-300 dark:bg-gray-600'}`} aria-hidden />
                            <span className="font-medium truncate">{d.name || d.deviceId.slice(0, 12)}</span>
                            {d.platform && <Badge variant="secondary" className="text-[9px] px-1 py-0">{d.platform}</Badge>}
                            {d === activeDevice && fresh && (
                              <Badge className="text-[9px] px-1 py-0 bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">
                                {getLocalizedString('النشط الآن', 'Actif', 'Active', lang)}
                              </Badge>
                            )}
                            {d.username && <span className="text-muted-foreground truncate">· {d.username}</span>}
                            <span className="text-muted-foreground ms-auto shrink-0">{relativeTime(d.lastSeenAt, lang)}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {!node.online && (
                    <p className="mt-1.5 flex items-center gap-1 text-[11px] text-muted-foreground">
                      <WifiOff className="h-3 w-3" />
                      {getLocalizedString('آخر بلاغ', 'Dernier rapport', 'Last report', lang)}: {relativeTime(node.lastReportAt, lang)}
                    </p>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
