'use client';

/**
 * COMPATIBILITY TAB (0.6.31) — the admin view of the API Compatibility Map:
 *   • every feature gate (feature → min app version → severity) with edit/add
 *   • the live evaluation matrix per platform (which client versions can run,
 *     which need an update absolutely, which are fine skipping server-only
 *     releases)
 * Data: GET /api/app-versions/compat/map (admin) + POST/DELETE gates.
 */

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api-fetch';
import { useLanguage } from '@/hooks/use-language';
import { t } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Loader2, Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';

interface Gate {
  id: string;
  feature: string;
  minAppVersion: string;
  severity: 'critical' | 'soft' | 'server';
  apiLevel: number;
  description: string;
  descriptionAr?: string | null;
  descriptionFr?: string | null;
  enabled: boolean;
}

interface MatrixRow {
  version: string;
  apiLevel: number | null;
  serverOnly: boolean;
  compatible: boolean;
  updateRequired: boolean;
  serverOnlyUpdate: boolean;
  blocked: Array<{ feature: string; severity: string }>;
}

interface CompatMap {
  serverApiLevel: number;
  minSupportedApiLevel: number;
  gates: Gate[];
  matrix: Record<string, MatrixRow[]>;
}

const SEVERITY_STYLE: Record<string, string> = {
  critical: 'bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/40',
  soft: 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/40',
  server: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/40',
};

export function CompatTab() {
  const { lang } = useLanguage();
  const [map, setMap] = useState<CompatMap | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ feature: '', minAppVersion: '', severity: 'soft' as Gate['severity'], description: '' });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/app-versions/compat/map');
      const data = await res.json().catch(() => null);
      if (data?.success) setMap(data);
      else toast.error(t('compatLoadFailed', lang));
    } catch {
      toast.error(t('compatLoadFailed', lang));
    } finally {
      setLoading(false);
    }
  }, [lang]);

  useEffect(() => { void load(); }, [load]);

  const saveGate = async () => {
    if (!form.feature.trim() || !form.minAppVersion.trim()) {
      toast.error(t('compatGateFieldsRequired', lang));
      return;
    }
    setSaving(true);
    try {
      const res = await apiFetch('/api/app-versions/compat/gates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          feature: form.feature.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-'),
          minAppVersion: form.minAppVersion.trim(),
          severity: form.severity,
          description: form.description.trim(),
          enabled: true,
        }),
      });
      const data = await res.json().catch(() => null);
      if (data?.success) {
        toast.success(t('compatGateSaved', lang));
        setForm({ feature: '', minAppVersion: '', severity: 'soft', description: '' });
        void load();
      } else {
        toast.error(data?.error || t('compatSaveFailed', lang));
      }
    } catch {
      toast.error(t('compatSaveFailed', lang));
    } finally {
      setSaving(false);
    }
  };

  const deleteGate = async (id: string) => {
    try {
      const res = await apiFetch(`/api/app-versions/compat/gates/${id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => null);
      if (data?.success) { toast.success(t('compatGateDeleted', lang)); void load(); }
      else toast.error(t('compatSaveFailed', lang));
    } catch {
      toast.error(t('compatSaveFailed', lang));
    }
  };

  const severityLabel = (s: string) => s === 'critical' ? t('compatSeverityCritical', lang) : s === 'server' ? t('compatSeverityServer', lang) : t('compatSeveritySoft', lang);

  return (
    <div className="space-y-4" dir={lang === 'ar' ? 'rtl' : 'ltr'}>
      {/* Server level header */}
      <div className="rounded-xl border bg-card p-4 flex flex-wrap items-center gap-3">
        <span className="h-9 w-9 rounded-lg bg-emerald-500/15 flex items-center justify-center">
          <ShieldCheck className="h-5 w-5 text-emerald-600" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{t('compatMapTitle')}</p>
          <p className="text-xs text-muted-foreground">
            {t('compatServerLevel').replace('{level}', String(map?.serverApiLevel ?? '…'))}
            {' · '}
            {t('compatFloorLevel').replace('{level}', String(map?.minSupportedApiLevel ?? '…'))}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading} className="gap-2">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          {t('refresh')}
        </Button>
      </div>

      {/* Evaluation matrix per platform */}
      {map && Object.entries(map.matrix).map(([platform, rows]) => (
        <div key={platform} className="rounded-xl border bg-card p-4">
          <p className="text-sm font-semibold mb-2 capitalize" dir="ltr">{platform}</p>
          {rows.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('compatNoPublished', lang)}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs" dir="ltr">
                <thead>
                  <tr className="text-muted-foreground text-start">
                    <th className="py-1.5 pe-3 text-start font-medium">{t('compatColumnVersion', lang)}</th>
                    <th className="py-1.5 pe-3 text-start font-medium">{t('compatColumnStatus', lang)}</th>
                    <th className="py-1.5 text-start font-medium">{t('compatColumnBlocked', lang)}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.version} className="border-t">
                      <td className="py-1.5 pe-3 font-mono">{r.version}</td>
                      <td className="py-1.5 pe-3">
                        {r.updateRequired ? (
                          <Badge className="bg-red-500/15 text-red-600 border border-red-500/40 hover:bg-red-500/15">{t('compatStatusBlocked', lang)}</Badge>
                        ) : r.serverOnlyUpdate || r.serverOnly ? (
                          <Badge className="bg-emerald-500/15 text-emerald-700 border border-emerald-500/40 hover:bg-emerald-500/15">{t('compatStatusServerOnly', lang)}</Badge>
                        ) : r.compatible ? (
                          <Badge className="bg-sky-500/15 text-sky-700 border border-sky-500/40 hover:bg-sky-500/15">{t('compatStatusRunnable', lang)}</Badge>
                        ) : (
                          <Badge variant="outline">{t('compatStatusUnknown', lang)}</Badge>
                        )}
                      </td>
                      <td className="py-1.5 font-mono text-[10px] text-muted-foreground">
                        {r.blocked.length ? r.blocked.map((b) => b.feature).join(', ') : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}

      {/* Gates management */}
      <div className="rounded-xl border bg-card p-4 space-y-3">
        <p className="text-sm font-semibold">{t('compatGatesTitle')}</p>
        {loading ? (
          <div className="flex items-center justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : (
          <div className="space-y-2 max-h-72 overflow-y-auto pe-1">
            {(map?.gates ?? []).map((g) => (
              <div key={g.id} className="flex items-start gap-2 rounded-lg border p-2.5">
                <Badge className={`shrink-0 border ${SEVERITY_STYLE[g.severity]} hover:bg-transparent`}>{severityLabel(g.severity)}</Badge>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold font-mono" dir="ltr">{g.feature} <span className="text-muted-foreground">≥ {g.minAppVersion}</span></p>
                  <p className="text-xs text-muted-foreground line-clamp-2">{(lang === 'ar' && g.descriptionAr) || (lang === 'fr' && g.descriptionFr) || g.description}</p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => void deleteGate(g.id)} aria-label={`delete ${g.feature}`} className="h-8 w-8 p-0 text-destructive shrink-0">
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
            {(map?.gates ?? []).length === 0 && (
              <p className="text-xs text-muted-foreground">{t('compatNoGates', lang)}</p>
            )}
          </div>
        )}

        {/* Add gate */}
        <div className="rounded-lg border border-dashed p-3 space-y-2">
          <p className="text-xs font-semibold flex items-center gap-1"><Plus className="h-3.5 w-3.5" />{t('compatAddGate', lang)}</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <Input dir="ltr" placeholder={t('compatFeatureKey', lang)} value={form.feature} onChange={(e) => setForm({ ...form, feature: e.target.value })} className="h-9 text-xs font-mono" />
            <Input dir="ltr" placeholder="0.6.30" value={form.minAppVersion} onChange={(e) => setForm({ ...form, minAppVersion: e.target.value })} className="h-9 text-xs font-mono" />
            <select
              value={form.severity}
              onChange={(e) => setForm({ ...form, severity: e.target.value as Gate['severity'] })}
              className="h-9 rounded-md border bg-background px-2 text-xs"
              aria-label={t('compatSeverity', lang)}
            >
              <option value="soft">{t('compatSeveritySoft', lang)}</option>
              <option value="critical">{t('compatSeverityCritical', lang)}</option>
              <option value="server">{t('compatSeverityServer', lang)}</option>
            </select>
          </div>
          <Input placeholder={t('compatDescription', lang)} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className="h-9 text-xs" />
          <Button size="sm" onClick={() => void saveGate()} disabled={saving} className="gap-2">
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            {t('compatSaveGate', lang)}
          </Button>
        </div>
      </div>
    </div>
  );
}
