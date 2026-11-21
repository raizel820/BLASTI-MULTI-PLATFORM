'use client';

/**
 * DeviceTreeCard — the BRANCH DEVICE TREE (0.6.100).
 * ─────────────────────────────────────────────────────────────────────────────
 * USER REQUIREMENT: "device manager should be able to show the tree of
 * connected devices with role and status". The manager below the tree stays a
 * flat grid — this card is the HIERARCHY view:
 *
 *   Branch
 *   ├── PC — reception        (MASTER · online)        ← lan-topology node
 *   │   ├── printer — HP L3250 (USB · shared)          ← registered peripheral
 *   │   │     attached via USB — print jobs forward to the host PC
 *   │   ├── Tablet 3          (joined · follower)
 *   │   └── ⏳ PC — counter 2  (pairing request → Accept/Reject)
 *   ├── PC — warehouse        (FOLLOWER · online)
 *   ├── Kiosk — entrance      (KIOSK · online)         ← registered device row
 *   └── TV — waiting room     (TV · offline)
 *
 * Data sources (no new endpoints):
 *   GET /api/lan-topology?agencyId=  — PCs + roles + joined devices
 *                                      + kind:'pending-join' entries
 *   (devices prop)                   — registered AgencyDevice rows; printers
 *                                      with printerConfig.attachment==='USB'
 *                                      attach to their host node
 *
 * Remote approval: the Accept/Reject buttons POST
 * /api/lan-topology/join-verdict { agencyId, deviceId, verdict } — the
 * master's reporter pull applies the verdict within ~30s and the device's
 * next join attempt is granted (or refused).
 */

import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Crown, Loader2, Monitor, MonitorSmartphone, Printer, Server,
  Smartphone, Tv, Usb, Wifi, Check, X, Network, Hourglass, ChevronRight,
} from 'lucide-react';
import { toast } from 'sonner';
import { getLocalizedString } from './types';
import type { AgencyDevice } from './types';

interface PendingJoin {
  deviceId: string;
  name?: string;
  platform?: string;
  role?: string;
  username?: string | null;
  requestedAt?: string;
}

interface LanNode {
  id: string;
  instanceId: string;
  name: string;
  hostname?: string | null;
  ipAddress?: string | null;
  lanPort: number;
  role: string;
  online: boolean;
  isPreferredMaster?: boolean;
  joinedDevices?: Array<{ deviceId: string; name?: string; platform?: string; username?: string | null }>;
  pendingJoins?: PendingJoin[];
  peripherals?: Array<Record<string, unknown>>;
}

function parsePrinterConfig(dev: AgencyDevice): Record<string, unknown> {
  if (!dev.printerConfig) return {};
  if (typeof dev.printerConfig === 'object') return dev.printerConfig as Record<string, unknown>;
  try { return JSON.parse(dev.printerConfig) as Record<string, unknown>; } catch { return {}; }
}

function StatusDot({ online, status }: { online: boolean; status?: string }) {
  if (status === 'PAIRING') {
    return <span className="inline-block h-2 w-2 rounded-full bg-amber-500 animate-pulse shrink-0" aria-label="pairing" />;
  }
  if (status === 'DISABLED') {
    return <span className="inline-block h-2 w-2 rounded-full bg-red-400 shrink-0" aria-label="disabled" />;
  }
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full shrink-0 ${online ? 'bg-emerald-500' : 'bg-zinc-400 dark:bg-zinc-600'}`}
      aria-label={online ? 'online' : 'offline'}
    />
  );
}

function RoleBadge({ role, lang }: { role: string; lang: string }) {
  const r = String(role).toUpperCase();
  if (r === 'MASTER') {
    return (
      <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300 text-[9px] gap-1 px-1.5 py-0 h-[18px]">
        <Crown className="h-2.5 w-2.5" />
        {getLocalizedString('ماستر', 'Maître', 'MASTER', lang)}
      </Badge>
    );
  }
  if (r === 'FOLLOWER') {
    return (
      <Badge variant="secondary" className="text-[9px] px-1.5 py-0 h-[18px]">
        {getLocalizedString('تابع', 'Suiveur', 'FOLLOWER', lang)}
      </Badge>
    );
  }
  return null;
}

function TypeIcon({ type }: { type: string }) {
  const t = String(type).toUpperCase();
  const cls = 'h-3.5 w-3.5';
  if (t === 'TV' || t === 'DISPLAY') return <Tv className={cls} />;
  if (t === 'PRINTER') return <Printer className={cls} />;
  if (t === 'KIOSK') return <MonitorSmartphone className={cls} />;
  if (t === 'PHONE' || t === 'APP') return <Smartphone className={cls} />;
  if (t === 'PC') return <Monitor className={cls} />;
  return <Server className={cls} />;
}

export function DeviceTreeCard({
  agencyId,
  lang,
  devices,
}: {
  agencyId: string | undefined;
  lang: string;
  devices: AgencyDevice[];
}) {
  const [nodes, setNodes] = useState<LanNode[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [verdictBusy, setVerdictBusy] = useState<string | null>(null);

  const fetchTopology = useCallback(async () => {
    if (!agencyId) return;
    try {
      const res = await apiFetch(`/api/lan-topology?agencyId=${encodeURIComponent(agencyId)}`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.success) {
        setNodes(data.nodes ?? []);
        setLoaded(true);
      }
    } catch { /* best-effort */ }
  }, [agencyId]);

  useEffect(() => {
    fetchTopology();
    const interval = setInterval(fetchTopology, 15_000);
    return () => clearInterval(interval);
  }, [fetchTopology]);

  /** Accept/Reject a pending LAN join request (remote verdict relay). */
  const sendVerdict = useCallback(async (deviceId: string, verdict: 'ACCEPT' | 'REJECT', deviceName: string) => {
    if (!agencyId) return;
    setVerdictBusy(deviceId + verdict);
    try {
      const res = await apiFetch('/api/lan-topology/join-verdict', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agencyId, deviceId, verdict }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.success) {
        toast.success(getLocalizedString(
          verdict === 'ACCEPT'
            ? `تم قبول "${deviceName}" — سيحصل على صلاحياته عند الاتصال`
            : `تم رفض "${deviceName}"`,
          verdict === 'ACCEPT' ? `"${deviceName}" accepté — accès accordé à la prochaine connexion` : `"${deviceName}" refusé`,
          verdict === 'ACCEPT' ? `"${deviceName}" accepted — it gets its access on the next connect` : `"${deviceName}" rejected`,
          lang,
        ));
        fetchTopology();
      } else {
        toast.error(data?.error || getLocalizedString('فشل إرسال القرار', 'Échec de la décision', 'Verdict failed', lang));
      }
    } catch {
      toast.error(getLocalizedString('تعذّر الاتصال بالخادم', 'Connexion impossible', 'Could not reach the server', lang));
    } finally {
      setVerdictBusy(null);
    }
  }, [agencyId, fetchTopology, lang]);

  if (!agencyId || !loaded) return null;

  // Registered devices attached to a host PC (USB peripherals) keyed by host.
  const hostKey = (dev: AgencyDevice) => {
    const cfg = parsePrinterConfig(dev);
    if (cfg.attachment === 'USB') {
      return String(cfg.hostInstanceId || cfg.hostIp || '');
    }
    return null;
  };

  const attachedTo = (node: LanNode) =>
    devices.filter((d) => {
      const k = hostKey(d);
      return !!k && (k === node.instanceId || k === node.ipAddress);
    });

  const standalone = devices.filter((d) => {
    const cfg = parsePrinterConfig(d);
    const isHosted = cfg.attachment === 'USB' && (cfg.hostInstanceId || cfg.hostIp);
    return !isHosted;
  });

  const totalPending = nodes.reduce((acc, n) => acc + (n.pendingJoins?.length || 0), 0);

  return (
    <Card data-testid="device-tree-card">
      <CardContent className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <div className="p-1.5 rounded-lg bg-violet-100 text-violet-600 dark:bg-violet-950/60 dark:text-violet-400">
            <Network className="h-4 w-4" />
          </div>
          <p className="text-sm font-semibold">
            {getLocalizedString('شجرة أجهزة الفرع', 'Arborescence des appareils', 'Branch device tree', lang)}
          </p>
          {totalPending > 0 && (
            <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300 text-[10px] gap-1">
              <Hourglass className="h-3 w-3" />
              {getLocalizedString(`${totalPending} طلب ربط بانتظار القبول`, `${totalPending} demande(s) en attente`, `${totalPending} pairing request(s) awaiting acceptance`, lang)}
            </Badge>
          )}
        </div>

        <div className="rounded-xl border bg-muted/30 p-3 overflow-x-auto">
          {/* Branch root */}
          <div className="flex items-center gap-1.5 text-sm font-semibold">
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            {getLocalizedString('الفرع (الشبكة المحلية)', 'Succursale (LAN)', 'Branch (LAN)', lang)}
          </div>

          {/* PC nodes from the LAN topology */}
          <div className="mt-2 space-y-1.5 ps-4 border-s-2 border-violet-200 dark:border-violet-900 ms-1.5">
            {nodes.length === 0 && (
              <p className="text-xs text-muted-foreground py-1">
                {getLocalizedString('لا توجد أجهزة كمبيوتر مبلّغة بعد', 'Aucun PC signalé pour le moment', 'No branch PCs have reported yet', lang)}
              </p>
            )}
            {nodes.map((node) => {
              const kids = attachedTo(node);
              return (
                <div key={node.id} className="rounded-lg bg-background border px-2.5 py-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <StatusDot online={node.online} />
                    <Monitor className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <span className="text-xs font-medium truncate max-w-[220px]">{node.name}</span>
                    <RoleBadge role={node.role} lang={lang} />
                    {node.isPreferredMaster && (
                      <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-[18px]">
                        {getLocalizedString('مثبّت يدوياً', 'épinglé', 'pinned', lang)}
                      </Badge>
                    )}
                    {node.ipAddress && (
                      <span className="text-[10px] text-muted-foreground" dir="ltr">{node.ipAddress}:{node.lanPort}</span>
                    )}
                    {!node.online && (
                      <span className="text-[10px] text-muted-foreground">
                        {getLocalizedString('غير متصل', 'hors ligne', 'offline', lang)}
                      </span>
                    )}
                  </div>

                  {/* Pending pairing requests on THIS master */}
                  {(node.pendingJoins || []).map((pj) => (
                    <div key={pj.deviceId} className="mt-1.5 ms-3 rounded-md border border-amber-300/60 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-900/50 px-2 py-1.5 flex items-center gap-2 flex-wrap">
                      <Hourglass className="h-3 w-3 text-amber-600 shrink-0" />
                      <span className="text-[11px] font-medium truncate max-w-[180px]">{pj.name || pj.deviceId.slice(0, 12)}</span>
                      {pj.platform && <span className="text-[9px] uppercase text-muted-foreground">{pj.platform}</span>}
                      <span className="text-[10px] text-muted-foreground">
                        {getLocalizedString('بانتظار القبول…', 'en attente d\u2019acceptation…', 'awaiting acceptance…', lang)}
                      </span>
                      <div className="ms-auto flex items-center gap-1">
                        <Button
                          size="sm"
                          className="h-6 px-2 text-[10px] gap-1 bg-emerald-600 hover:bg-emerald-700 text-white"
                          disabled={verdictBusy === pj.deviceId + 'ACCEPT'}
                          onClick={() => sendVerdict(pj.deviceId, 'ACCEPT', pj.name || pj.deviceId.slice(0, 12))}
                        >
                          {verdictBusy === pj.deviceId + 'ACCEPT' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                          {getLocalizedString('قبول', 'Accepter', 'Accept', lang)}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-[10px] gap-1 border-red-200 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30"
                          disabled={verdictBusy === pj.deviceId + 'REJECT'}
                          onClick={() => sendVerdict(pj.deviceId, 'REJECT', pj.name || pj.deviceId.slice(0, 12))}
                        >
                          {verdictBusy === pj.deviceId + 'REJECT' ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
                          {getLocalizedString('رفض', 'Refuser', 'Reject', lang)}
                        </Button>
                      </div>
                    </div>
                  ))}

                  {/* Joined devices */}
                  {(node.joinedDevices || []).slice(0, 12).map((jd) => (
                    <div key={jd.deviceId} className="mt-1 ms-3 flex items-center gap-2 text-[11px] text-muted-foreground">
                      <ChevronRight className="h-3 w-3" />
                      {jd.platform === 'android' || jd.platform === 'ios' ? <Smartphone className="h-3 w-3" /> : <Monitor className="h-3 w-3" />}
                      <span className="truncate max-w-[200px]">{jd.name || jd.deviceId.slice(0, 12)}</span>
                      {jd.username && <span className="text-[10px] truncate max-w-[120px]">({jd.username})</span>}
                    </div>
                  ))}

                  {/* USB peripherals attached to this PC */}
                  {kids.map((dev) => {
                    const cfg = parsePrinterConfig(dev);
                    const hostLabel = typeof cfg.hostName === 'string' ? cfg.hostName : '';
                    return (
                      <div key={dev.id} className="mt-1.5 ms-3 rounded-md border border-dashed px-2 py-1.5 flex items-center gap-2 flex-wrap bg-background">
                        <StatusDot online={dev.status === 'ONLINE'} status={dev.status} />
                        <Printer className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        <span className="text-[11px] font-medium truncate max-w-[180px]">{dev.name}</span>
                        <Badge variant="secondary" className="text-[9px] gap-1 px-1.5 py-0 h-[18px]">
                          <Usb className="h-2.5 w-2.5" />
                          USB
                        </Badge>
                        <Badge className="bg-sky-100 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300 text-[9px] px-1.5 py-0 h-[18px]">
                          {getLocalizedString('طابعة مشتركة', 'Imprimante partagée', 'SHARED PRINTER', lang)}
                        </Badge>
                        <span className="text-[10px] text-muted-foreground truncate max-w-[200px]" dir="ltr">
                          {getLocalizedString('عبر', 'via', 'via', lang)} {hostLabel || node.name}
                        </span>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>

          {/* Standalone registered devices (not attached to a PC) */}
          {standalone.length > 0 && (
            <div className="mt-3">
              <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Wifi className="h-3 w-3" />
                {getLocalizedString('الأجهزة المسجّلة (شاشات / كيوسكات / تطبيقات / طابعات شبكية)', 'Appareils enregistrés (écrans / kiosques / apps / imprimantes réseau)', 'Registered devices (TVs / kiosks / apps / network printers)', lang)}
              </div>
              <div className="mt-1.5 space-y-1 ps-3">
                {standalone.slice(0, 24).map((dev) => (
                  <div key={dev.id} className="flex items-center gap-2 text-xs">
                    <StatusDot online={dev.status === 'ONLINE'} status={dev.status} />
                    <TypeIcon type={dev.type} />
                    <span className="truncate max-w-[220px] font-medium">{dev.name}</span>
                    <span className="rounded-full bg-muted px-1.5 py-px text-[9px] uppercase">{dev.type}</span>
                    {dev.ipAddress && <span className="text-[10px] text-muted-foreground" dir="ltr">{dev.ipAddress}</span>}
                    {dev.status === 'PAIRING' && (
                      <span className="text-[10px] text-amber-600">
                        {getLocalizedString('بانتظار القبول', 'en attente', 'awaiting acceptance', lang)}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Registered peripherals that no PC node currently claims */}
          {devices.some((d) => {
            const k = hostKey(d);
            return !!k && !nodes.some((n) => n.instanceId === k || n.ipAddress === k);
          }) && (
            <div className="mt-3">
              <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Usb className="h-3 w-3" />
                {getLocalizedString('طابعات USB مرفقة بحواسيب غير متصلة حالياً', 'Imprimantes USB sur PC hors ligne', 'USB printers on PCs currently offline', lang)}
              </div>
              <div className="mt-1.5 space-y-1 ps-3">
                {devices.filter((d) => {
                  const k = hostKey(d);
                  return !!k && !nodes.some((n) => n.instanceId === k || n.ipAddress === k);
                }).slice(0, 12).map((dev) => {
                  const cfg = parsePrinterConfig(dev);
                  return (
                    <div key={dev.id} className="flex items-center gap-2 text-xs">
                      <StatusDot online={false} status={dev.status} />
                      <Printer className="h-3 w-3 text-muted-foreground" />
                      <span className="truncate max-w-[220px] font-medium">{dev.name}</span>
                      <span className="text-[10px] text-muted-foreground truncate max-w-[180px]" dir="ltr">
                        {getLocalizedString('عبر', 'via', 'via', lang)} {typeof cfg.hostName === 'string' ? cfg.hostName : (typeof cfg.hostIp === 'string' ? cfg.hostIp : '')}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {nodes.length === 0 && standalone.length === 0 && (
            <p className="text-xs text-muted-foreground mt-3">
              {getLocalizedString(
                'شغّل الفحص وقم بربط الأجهزة لتظهر هنا في شكل شجرة',
                'Lancez un scan et associez des appareils pour les voir ici',
                'Run a scan and pair devices to see the tree here',
                lang,
              )}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
