'use client';

/**
 * LanMasterCard — compact "Branch PCs" card (0.6.74 redesign).
 * Replaces the old 375-line LanTopologyPanel with a single dismissible card:
 * current master PC + node count + inline pin/unpin. Same API contracts:
 *   GET  /api/lan-topology?agencyId=      (polled 15s)
 *   POST /api/lan-topology/preference     { agencyId, instanceId | null }
 */

import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Crown, Loader2, Server, Pin, PinOff } from 'lucide-react';
import { toast } from 'sonner';
import { getLocalizedString } from './types';

interface LanNode {
  id: string;
  instanceId: string;
  name: string;
  ipAddress?: string | null;
  lanPort: number;
  role: string;
  term: number;
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

export function LanMasterCard({ agencyId, lang }: { agencyId: string | undefined; lang: string }) {
  const [nodes, setNodes] = useState<LanNode[]>([]);
  const [currentMaster, setCurrentMaster] = useState<CurrentMaster | null>(null);
  const [preferredInstanceId, setPreferredInstanceId] = useState<string | null>(null);
  const [totalJoined, setTotalJoined] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [pinning, setPinning] = useState(false);

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
    } catch { /* best-effort */ }
  }, [agencyId]);

  useEffect(() => {
    fetchTopology();
    const interval = setInterval(fetchTopology, 15_000);
    return () => clearInterval(interval);
  }, [fetchTopology]);

  const pinMaster = useCallback(async (instanceId: string | null) => {
    if (!agencyId) return;
    setPinning(true);
    try {
      const res = await apiFetch('/api/lan-topology/preference', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agencyId, instanceId }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.success) {
        toast.success(getLocalizedString(
          instanceId ? 'تم تعيين الـ Master — ستطبقه الأجهزة خلال ثوانٍ' : 'أُلغي التعيين — الانتخاب التلقائي يعمل من جديد',
          instanceId ? 'Maître défini — appliqué sous peu' : 'Pin effacé — élection automatique',
          instanceId ? 'Master pinned — devices apply it within seconds' : 'Pin cleared — automatic election resumes',
          lang,
        ));
        await fetchTopology();
      } else {
        toast.error(data?.error || getLocalizedString('فشل التعيين', 'Échec de la définition', 'Failed to set master', lang));
      }
    } catch {
      toast.error(getLocalizedString('تعذّر الاتصال بالخادم', 'Connexion au serveur impossible', 'Could not reach the server', lang));
    } finally {
      setPinning(false);
    }
  }, [agencyId, fetchTopology, lang]);

  if (!agencyId) return null;
  if (!loaded) return null;

  const onlineNodes = nodes.filter((n) => n.online);
  const masterOnline = currentMaster?.online ?? false;

  return (
    <Card className={masterOnline ? 'border-emerald-300 dark:border-emerald-800' : ''}>
      <CardContent className="p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className={`p-2.5 rounded-lg shrink-0 ${masterOnline ? 'bg-emerald-100 text-emerald-600 dark:bg-emerald-950/60 dark:text-emerald-400' : 'bg-muted text-muted-foreground'}`}>
            <Crown className="h-5 w-5" />
          </div>

          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-muted-foreground">{getLocalizedString('أجهزة الفرع (شبكة محلية)', 'PCs de la succursale (LAN)', 'Branch PCs (LAN)', lang)}</p>
            {currentMaster ? (
              <p className="text-sm font-semibold truncate">
                {getLocalizedString('الماستر الحالي:', 'Maître actuel :', 'Current master:', lang)}{' '}
                <span data-testid="current-master-name">{currentMaster.name}</span>
                {currentMaster.ipAddress && (
                  <span className="text-xs font-normal text-muted-foreground ms-2" dir="ltr">{currentMaster.ipAddress}:{currentMaster.lanPort}</span>
                )}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">{getLocalizedString('لا يوجد ماستر حالياً', 'Aucun maître actuellement', 'No master right now', lang)}</p>
            )}
            <p className="text-xs text-muted-foreground mt-0.5">
              {getLocalizedString(
                `${onlineNodes.length} جهاز متصل · ${totalJoined} جهاز تابع مسجّل`,
                `${onlineNodes.length} PC en ligne · ${totalJoined} appareils joints`,
                `${onlineNodes.length} PC online · ${totalJoined} joined devices`,
                lang,
              )}
            </p>
          </div>

          {preferredInstanceId ? (
            <Button variant="outline" size="sm" className="gap-1.5" disabled={pinning} onClick={() => pinMaster(null)}>
              {pinning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PinOff className="h-3.5 w-3.5" />}
              {getLocalizedString('إلغاء التثبيت', 'Effacer le pin', 'Unpin', lang)}
            </Button>
          ) : (
            nodes.filter((n) => n.online).map((n) => (
              <Button key={n.id} variant="outline" size="sm" className="gap-1.5" disabled={pinning} onClick={() => pinMaster(n.instanceId)}>
                {pinning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Pin className="h-3.5 w-3.5" />}
                <Server className="h-3.5 w-3.5" />
                <span className="max-w-32 truncate">{n.name}</span>
              </Button>
            ))
          )}

          {nodes.length > 0 && (
            <Badge variant="secondary" className="text-[10px] shrink-0">{nodes.length}</Badge>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
