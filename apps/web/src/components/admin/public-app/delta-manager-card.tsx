'use client';

/**
 * DeltaManagerCard (0.6.33) — Delta Update Manager for Public Apps Settings.
 *
 * ONE screen that answers the admin question "which past versions can still
 * reach the latest release with a small patch instead of the full installer?"
 * per platform:
 *
 *   - lists EVERY AppVersion of the selected platform (GET
 *     /api/app-versions/delta-manager) with artifact availability, device
 *     count, the existing direct hop and the chain /check would serve today,
 *   - marks each row eligible/blocked WITH the reason (missing asar refs,
 *     changed electron runtime, missing APK, …),
 *   - a version SELECTOR (checkboxes) + "generate deltas → latest" button
 *     POSTs /api/app-versions/delta-manager/generate — the server dry-runs
 *     the guards again, builds + self-verifies every patch and reports
 *     per-row results which land as toasts.
 *
 * Nothing here ever touches an installed device directly: generating a hop
 * only adds an edge to the delta graph — devices pick it up on their next
 * /check and still fall back to the full installer on any verification
 * failure.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import { INSTALLER_PLATFORMS, type InstallerPlatform } from '@/lib/admin-upload';
import { useLanguage } from '@/hooks/use-language';
import { toast } from 'sonner';
import {
  GitCompare,
  RefreshCw,
  Loader2,
  ShieldCheck,
  CheckCircle2,
  XCircle,
  Link2,
  Wand2,
  Smartphone,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatFileSize, platformLabel } from './shared';

/** Mirrors the API GET /app-versions/delta-manager row shape. */
interface ManagerRow {
  id: string;
  version: string;
  isPublished: boolean;
  createdAt: string;
  fileName: string | null;
  fileSize: number | null;
  devices: number;
  isTarget: boolean;
  artifacts: { apk: boolean; asar: boolean; outref: boolean };
  delta: { id: string; fileName: string; fileSize: number; createdAt: string } | null;
  chain: { hopCount: number; totalSize: number; via: string[] } | null;
  eligible: boolean;
  reason: string | null;
}

interface ManagerPayload {
  success: boolean;
  platform: string;
  latest: { id: string; version: string; fileName: string | null; fileSize: number | null; fileHash: string | null } | null;
  totalHops: number;
  versions: ManagerRow[];
}

const PLATFORMS: InstallerPlatform[] = INSTALLER_PLATFORMS;

export function DeltaManagerCard() {
  const { t, lang } = useLanguage();

  const [platform, setPlatform] = useState<InstallerPlatform>('windows');
  const [data, setData] = useState<ManagerPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [generating, setGenerating] = useState(false);

  const fetchManager = useCallback(async (pl: InstallerPlatform, isRefresh = false) => {
    if (isRefresh) setLoading(false);
    else setLoading(true);
    try {
      const res = await apiFetch(`/api/app-versions/delta-manager?platform=${encodeURIComponent(pl)}`);
      const payload = await res.json().catch(() => null);
      if (res.ok && payload?.success) {
        setData(payload);
        setError(null);
      } else {
        setError(payload?.error || `HTTP ${res.status}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setSelected(new Set());
    void fetchManager(platform);
  }, [platform, fetchManager]);

  const rows = data?.versions ?? [];
  const eligibleRows = useMemo(() => rows.filter((r) => r.eligible), [rows]);
  const selectedEligible = useMemo(
    () => eligibleRows.filter((r) => selected.has(r.id)),
    [eligibleRows, selected],
  );
  const allEligibleSelected = eligibleRows.length > 0 && selectedEligible.length === eligibleRows.length;

  const toggleRow = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllEligible = () => {
    setSelected((prev) => {
      const allSelected = eligibleRows.length > 0 && eligibleRows.every((r) => prev.has(r.id));
      return allSelected ? new Set<string>() : new Set(eligibleRows.map((r) => r.id));
    });
  };

  const generateDeltas = async () => {
    if (selectedEligible.length === 0) return;
    setGenerating(true);
    try {
      const res = await apiFetch('/api/app-versions/delta-manager/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform,
          fromVersionIds: selectedEligible.map((r) => r.id),
        }),
      });
      const payload = await res.json().catch(() => null);
      if (res.ok && payload?.success) {
        const results: Array<{ from: string; to: string; ok: boolean; size?: number; reason?: string }> =
          payload.results || [];
        const okCount = results.filter((r) => r.ok).length;
        const failRows = results.filter((r) => !r.ok);
        if (okCount > 0) {
          toast.success(
            t('publicAppDeltaMgrGenerated', { count: String(okCount), target: payload.target?.version ?? '' }),
          );
        }
        for (const f of failRows) {
          toast.error(t('publicAppDeltaMgrRowFailed', { from: f.from, reason: reasonLabel(f.reason ?? 'blocked') }));
        }
        setSelected(new Set());
      } else {
        toast.error(payload?.error || `HTTP ${res.status}`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Network error');
    } finally {
      setGenerating(false);
      void fetchManager(platform, true);
    }
  };

  const reasonLabel = (reason: string): string => {
    switch (reason) {
      case 'is-latest': return t('publicAppDeltaMgrStatusLatest');
      case 'no-published-target': return t('publicAppDeltaMgrNoTarget');
      case 'missing-asar-ref': return t('publicAppDeltaMgrReasonMissingAsar');
      case 'missing-outref-ref': return t('publicAppDeltaMgrReasonMissingOutref');
      case 'missing-apk': return t('publicAppDeltaMgrReasonMissingApk');
      case 'missing-apk-hash': return t('publicAppDeltaMgrReasonMissingApk');
      case 'ref-file-missing': return t('publicAppDeltaMgrReasonRefMissing');
      case 'apk-file-missing': return t('publicAppDeltaMgrReasonRefMissing');
      case 'runtime-key-changed': return t('publicAppDeltaMgrReasonRuntime');
      case 'native-bits-changed': return t('publicAppDeltaMgrReasonNative');
      case 'not-forward': return t('publicAppDeltaMgrReasonNotForward');
      default: return reason;
    }
  };

  const StatusCell = ({ row }: { row: ManagerRow }) => {
    if (row.isTarget) {
      return (
        <Badge className="text-[10px] h-5 gap-1 bg-emerald-600/15 text-emerald-700 dark:text-emerald-400 border border-emerald-600/30">
          <ShieldCheck className="h-3 w-3" />
          {t('publicAppDeltaMgrStatusLatest')}
        </Badge>
      );
    }
    if (row.delta) {
      return (
        <Badge className="text-[10px] h-5 gap-1 bg-emerald-600/10 text-emerald-700 dark:text-emerald-400 border border-emerald-600/25">
          <CheckCircle2 className="h-3 w-3" />
          {t('publicAppDeltaMgrStatusDirect')} · {formatFileSize(row.delta.fileSize)}
        </Badge>
      );
    }
    if (row.chain) {
      return (
        <Badge variant="secondary" className="text-[10px] h-5 gap-1">
          <Link2 className="h-3 w-3" />
          {t('publicAppDeltaMgrStatusChain', { count: String(row.chain.hopCount) })} · {formatFileSize(row.chain.totalSize)}
        </Badge>
      );
    }
    if (row.eligible) {
      return (
        <Badge className="text-[10px] h-5 gap-1 bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/30">
          <Wand2 className="h-3 w-3" />
          {t('publicAppDeltaMgrStatusEligible')}
        </Badge>
      );
    }
    return (
      <Badge variant="outline" className="text-[10px] h-5 gap-1 text-muted-foreground">
        <XCircle className="h-3 w-3" />
        {t('publicAppDeltaMgrStatusBlocked')}{row.reason ? ` — ${reasonLabel(row.reason)}` : ''}
      </Badge>
    );
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <GitCompare className="h-4 w-4 text-primary" />
          {t('publicAppDeltaMgrTitle')}
        </CardTitle>
        <CardDescription className="text-xs">{t('publicAppDeltaMgrDesc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Platform selector + actions row */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-2">
          <Select value={platform} onValueChange={(v) => setPlatform(v as InstallerPlatform)}>
            <SelectTrigger className="w-full sm:w-[220px] h-10" aria-label={t('publicAppDeltaMgrPlatform')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PLATFORMS.map((p) => (
                <SelectItem key={p} value={p}>
                  {platformLabel(p, lang)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="flex-1" />

          <Button
            variant="outline"
            size="sm"
            className="h-10"
            onClick={() => void fetchManager(platform, true)}
            disabled={loading}
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            {t('publicAppRefresh')}
          </Button>

          <Button
            size="sm"
            className="h-10"
            onClick={() => void generateDeltas()}
            disabled={generating || selectedEligible.length === 0}
          >
            {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
            {generating
              ? t('publicAppDeltaMgrGenerating')
              : t('publicAppDeltaMgrGenerate', { count: String(selectedEligible.length) })}
          </Button>
        </div>

        {/* Target banner */}
        {data?.latest ? (
          <div className="rounded-lg border bg-muted/30 px-3 py-2 text-xs flex flex-wrap items-center gap-2">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
            <span>{t('publicAppDeltaMgrTarget')}</span>
            <Badge variant="secondary" className="text-[10px] h-4 px-1.5 font-mono" dir="ltr">
              {data.latest.version}
            </Badge>
            {data.latest.fileSize ? (
              <span className="text-muted-foreground font-mono" dir="ltr">{formatFileSize(data.latest.fileSize)}</span>
            ) : null}
          </div>
        ) : data ? (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            {t('publicAppDeltaMgrNoTarget')}
          </div>
        ) : null}

        {/* Error state */}
        {error && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        {/* Loading skeleton */}
        {loading && !data && (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-10 rounded-md bg-muted/50 animate-pulse" />
            ))}
          </div>
        )}

        {/* Empty state */}
        {!loading && !error && data && rows.length === 0 && (
          <div className="py-8 text-center text-xs text-muted-foreground flex flex-col items-center gap-2">
            <Smartphone className="h-6 w-6 opacity-40" />
            {t('publicAppDeltaMgrNoVersions')}
          </div>
        )}

        {/* Versions table */}
        {!loading && !error && rows.length > 0 && (
          <div className="rounded-lg border overflow-hidden">
            <div className="max-h-96 overflow-y-auto custom-scrollbar">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      <Checkbox
                        aria-label={t('publicAppDeltaMgrSelectEligible')}
                        checked={allEligibleSelected}
                        disabled={eligibleRows.length === 0 || generating}
                        onCheckedChange={() => toggleAllEligible()}
                      />
                    </TableHead>
                    <TableHead className="text-xs">{t('publicAppDeltaMgrColVersion')}</TableHead>
                    <TableHead className="text-xs">{t('publicAppDeltaMgrColDevices')}</TableHead>
                    <TableHead className="text-xs">{t('publicAppDeltaMgrColArtifacts')}</TableHead>
                    <TableHead className="text-xs">{t('publicAppDeltaMgrColStatus')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.id} className={row.isTarget ? 'bg-emerald-600/5' : undefined}>
                      <TableCell>
                        <Checkbox
                          aria-label={t('publicAppDeltaMgrSelectVersion', { version: row.version })}
                          checked={selected.has(row.id)}
                          disabled={!row.eligible || generating}
                          onCheckedChange={() => toggleRow(row.id)}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-mono font-medium" dir="ltr">{row.version}</span>
                          {row.isPublished ? (
                            <Badge variant="secondary" className="text-[9px] h-4 px-1">
                              {t('publicAppPublishSwitch')}
                            </Badge>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs font-mono" dir="ltr">
                        {row.devices > 0 ? row.devices : '—'}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {row.artifacts.apk ? (
                            <Badge variant="secondary" className="text-[9px] h-4 px-1 font-mono">APK</Badge>
                          ) : null}
                          {row.artifacts.asar ? (
                            <Badge variant="secondary" className="text-[9px] h-4 px-1 font-mono">ASAR</Badge>
                          ) : null}
                          {row.artifacts.outref ? (
                            <Badge variant="secondary" className="text-[9px] h-4 px-1 font-mono">OUTREF</Badge>
                          ) : null}
                          {!row.artifacts.apk && !row.artifacts.asar && !row.artifacts.outref ? (
                            <span className="text-[10px] text-muted-foreground">—</span>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell>
                        <StatusCell row={row} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}

        {/* Footer hint */}
        <p className="text-[11px] text-muted-foreground">{t('publicAppDeltaMgrHint')}</p>
      </CardContent>
    </Card>
  );
}
