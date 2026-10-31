'use client';

/**
 * TAB 3 — Update Pusher.
 *
 * NEW push form (platform → target version among PUBLISHED versions, optional
 * vs mandatory radio, EN/AR/FR message) + pushes list with REAL delivery
 * stats: deliveredCount = distinct devices that checked in after the push was
 * created; updatedCount = devices confirmed running the target version.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import { useLanguage } from '@/hooks/use-language';
import { toast } from 'sonner';
import { motion } from 'framer-motion';
import {
  Send,
  BellRing,
  Loader2,
  Trash2,
  Ban,
  RotateCcw,
  AlertTriangle,
  BellOff,
  Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  formatDateTime,
  formatFileSize,
  platformIcon,
  platformLabel,
  type AppVersion,
  type PushRow,
} from './shared';
import { NotesInput, type NotesValue } from './notes-input';
import { INSTALLER_PLATFORMS, type InstallerPlatform } from '@/lib/admin-upload';

const EMPTY_NOTES: NotesValue = { en: '', ar: '', fr: '' };

export function PusherTab() {
  const { t, lang } = useLanguage();

  const [pushes, setPushes] = useState<PushRow[]>([]);
  /** ALL installer rows (published AND drafts) — last 10 uploads are offered. */
  const [allVersions, setAllVersions] = useState<AppVersion[]>([]);
  /** platform → version string of the CURRENTLY ACTIVE published installer. */
  const [activeByPlatform, setActiveByPlatform] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [platform, setPlatform] = useState<InstallerPlatform>('windows');
  const [appVersionId, setAppVersionId] = useState<string>('');
  const [pushType, setPushType] = useState<'optional' | 'mandatory'>('optional');
  const [notes, setNotes] = useState<NotesValue>(EMPTY_NOTES);
  const [sending, setSending] = useState(false);

  const [deleting, setDeleting] = useState<PushRow | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const fetchAll = useCallback(async (isRefresh = false) => {
    if (!isRefresh) setLoading(true);
    try {
      const [pushesRes, versionsRes, activeRes] = await Promise.all([
        apiFetch('/api/app-installs/pushes'),
        // NO published filter — the admin picks among the LAST TEN UPLOADED
        // INSTALLERS, including drafts and versions older than the active one
        // (devices still running old builds must be reachable).
        apiFetch('/api/app-versions'),
        apiFetch('/api/app-versions/public/active'),
      ]);
      const pushesData = await pushesRes.json().catch(() => null);
      const versionsData = await versionsRes.json().catch(() => null);
      const activeData = await activeRes.json().catch(() => null);

      if (pushesRes.ok && pushesData?.success) {
        setPushes(pushesData.pushes || []);
        setError(null);
      } else {
        setError(pushesData?.error || `HTTP ${pushesRes.status}`);
      }
      if (versionsRes.ok && versionsData?.success) {
        setAllVersions(versionsData.versions || []);
      }
      if (activeRes.ok && activeData?.success) {
        const map: Record<string, string> = {};
        for (const v of activeData.versions || []) {
          if (v?.platform && v?.version) map[v.platform as string] = v.version as string;
        }
        setActiveByPlatform(map);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  /** Installer rows of the selected platform — the LAST TEN UPLOADED first
   * (API orders createdAt desc). Includes the active one and older versions:
   * devices still on old builds must be pushable. */
  const targetVersions = useMemo(
    () => allVersions.filter((v) => v.platform === platform).slice(0, 10),
    [allVersions, platform],
  );

  // Reset the pick when the platform changes and the pick no longer belongs,
  // then DEFAULT-PICK the most recently uploaded installer (selecting the
  // FILE, not just a version number — same version can be rebuilt often).
  useEffect(() => {
    if (appVersionId && !targetVersions.some((v) => v.id === appVersionId)) {
      setAppVersionId(targetVersions[0]?.id ?? '');
    }
    if (!appVersionId && targetVersions.length > 0) {
      setAppVersionId(targetVersions[0].id);
    }
  }, [targetVersions, appVersionId]);

  const sendPush = useCallback(async () => {
    if (!appVersionId) {
      toast.error(t('publicAppPushNoVersions'));
      return;
    }
    if (!notes.en.trim() && !notes.ar.trim() && !notes.fr.trim()) {
      toast.error(t('publicAppPushMessageRequired'));
      return;
    }
    setSending(true);
    try {
      const res = await apiFetch('/api/app-installs/pushes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform,
          appVersionId,
          isMandatory: pushType === 'mandatory',
          message: notes.en,
          messageAr: notes.ar || undefined,
          messageFr: notes.fr || undefined,
        }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && (data?.success || res.status === 201)) {
        toast.success(t('publicAppPushSent'));
        // Delta backfill report (the push path generates the delta hops for a
        // draft it publishes): surface the outcome right where the admin acts.
        const dg = data?.deltaGeneration;
        if (Array.isArray(dg) && dg.length > 0) {
          const okHop = dg.find((h: { ok?: boolean }) => h?.ok);
          if (okHop) {
            toast.success(t('publicAppPushDeltaReady', { size: formatFileSize(okHop.size) }), {
              description: `${okHop.from} → ${okHop.to}`,
            });
          } else {
            toast.info(t('publicAppPushDeltaUnavailable', { reason: dg[0]?.reason || '—' }));
          }
        } else if (dg && typeof dg === 'object' && 'error' in dg) {
          toast.info(t('publicAppPushDeltaUnavailable', { reason: String(dg.error).slice(0, 120) }));
        }
        setNotes(EMPTY_NOTES);
        setPushType('optional');
        await fetchAll(true);
      } else {
        toast.error(t('publicAppPushFailed'), {
          description: data?.error || `HTTP ${res.status}`,
        });
      }
    } catch (err) {
      toast.error(t('publicAppPushFailed'), {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setSending(false);
    }
  }, [appVersionId, notes, platform, pushType, fetchAll, t]);

  const cancelPush = useCallback(
    async (push: PushRow) => {
      setBusyId(push.id);
      try {
        const res = await apiFetch(`/api/app-installs/pushes/${push.id}/cancel`, { method: 'POST' });
        const data = await res.json().catch(() => null);
        if (res.ok && data?.success) {
          toast.success(t('publicAppPushCancelDone'));
          await fetchAll(true);
        } else {
          toast.error(t('publicAppPushCancelFailed'), {
            description: data?.error || `HTTP ${res.status}`,
          });
        }
      } catch (err) {
        toast.error(t('publicAppPushCancelFailed'), {
          description: err instanceof Error ? err.message : undefined,
        });
      } finally {
        setBusyId(null);
      }
    },
    [fetchAll, t],
  );

  const reactivatePush = useCallback(
    async (push: PushRow) => {
      setBusyId(push.id);
      try {
        const res = await apiFetch(`/api/app-installs/pushes/${push.id}/reactivate`, { method: 'POST' });
        const data = await res.json().catch(() => null);
        if (res.ok && data?.success) {
          toast.success(t('publicAppPushReactivateDone'));
          await fetchAll(true);
        } else {
          toast.error(t('publicAppPushReactivateFailed'), {
            description: data?.error || `HTTP ${res.status}`,
          });
        }
      } catch (err) {
        toast.error(t('publicAppPushReactivateFailed'), {
          description: err instanceof Error ? err.message : undefined,
        });
      } finally {
        setBusyId(null);
      }
    },
    [fetchAll, t],
  );

  const deletePush = useCallback(
    async (push: PushRow) => {
      setBusyId(push.id);
      try {
        const res = await apiFetch(`/api/app-installs/pushes/${push.id}`, { method: 'DELETE' });
        const data = await res.json().catch(() => null);
        if (res.ok && data?.success) {
          toast.success(t('publicAppDeleteDone'));
          await fetchAll(true);
        } else {
          toast.error(t('publicAppDeleteFailed'), {
            description: data?.error || `HTTP ${res.status}`,
          });
        }
      } catch (err) {
        toast.error(t('publicAppDeleteFailed'), {
          description: err instanceof Error ? err.message : undefined,
        });
      } finally {
        setBusyId(null);
        setDeleting(null);
      }
    },
    [fetchAll, t],
  );

  return (
    <div className="space-y-4">
      {/* ─── New push form ─── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Send className="h-4 w-4 text-primary" />
            {t('publicAppPusherTitle')}
          </CardTitle>
          <CardDescription className="text-xs">{t('publicAppPusherDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">{t('publicAppUploadPlatform')}</Label>
              <Select
                value={platform}
                onValueChange={(v) => setPlatform(v as InstallerPlatform)}
                disabled={sending}
              >
                <SelectTrigger className="h-10 text-sm" aria-label={t('publicAppUploadPlatform')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {INSTALLER_PLATFORMS.map((p) => {
                    const Icon = platformIcon(p);
                    return (
                      <SelectItem key={p} value={p}>
                        <span className="flex items-center gap-2">
                          <Icon className="h-3.5 w-3.5" />
                          {platformLabel(p, lang)}
                        </span>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t('publicAppPushTargetInstaller')}</Label>
              <Select value={appVersionId} onValueChange={setAppVersionId} disabled={sending || targetVersions.length === 0}>
                <SelectTrigger className="h-10 text-sm" aria-label={t('publicAppPushTargetInstaller')}>
                  <SelectValue
                    placeholder={
                      targetVersions.length === 0 && !loading
                        ? t('publicAppPushNoVersions')
                        : t('publicAppPushPickInstaller')
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {targetVersions.map((v) => {
                    const isActive = activeByPlatform[v.platform] === v.version;
                    return (
                      <SelectItem key={v.id} value={v.id} className="py-2">
                        <span className="flex flex-col items-start gap-0.5 max-w-full" dir="ltr">
                          <span className="flex items-center gap-1.5 font-medium">
                            {`v${v.version}`}
                            <span className="text-[10px] text-muted-foreground font-normal truncate max-w-[220px]">
                              {v.fileName || 'installer'}
                            </span>
                          </span>
                          <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground font-normal">
                            <span>{formatFileSize(v.fileSize)}</span>
                            <span>·</span>
                            <span>{formatDateTime(v.createdAt, lang)}</span>
                            {isActive && (
                              <Badge className="h-4 px-1.5 text-[9px] bg-emerald-100 text-emerald-700 border-emerald-200">
                                {t('publicAppPushActiveBadge')}
                              </Badge>
                            )}
                            {!v.isPublished && (
                              <Badge className="h-4 px-1.5 text-[9px] bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800">
                                {t('publicAppPushDraftBadge')}
                              </Badge>
                            )}
                          </span>
                        </span>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
              {targetVersions.length === 0 && !loading && (
                <p className="text-[11px] text-muted-foreground">{t('publicAppPushNoVersionsHint')}</p>
              )}
              {targetVersions.length > 0 && (
                <p className="text-[11px] text-muted-foreground">{t('publicAppPushInstallerHint')}</p>
              )}
            </div>
          </div>

          {/* Update type */}
          <div className="space-y-1.5">
            <Label className="text-xs">{t('publicAppPushType')}</Label>
            <RadioGroup
              value={pushType}
              onValueChange={(v) => setPushType(v as 'optional' | 'mandatory')}
              className="grid grid-cols-1 sm:grid-cols-2 gap-2"
              disabled={sending}
            >
              <Label
                htmlFor="push-type-optional"
                className={`flex items-start gap-2.5 rounded-lg border p-3 cursor-pointer transition-colors min-h-[44px] ${
                  pushType === 'optional' ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'
                }`}
              >
                <RadioGroupItem value="optional" id="push-type-optional" className="mt-0.5" />
                <span className="space-y-0.5">
                  <span className="block text-xs font-medium">{t('publicAppPushTypeOptional')}</span>
                  <span className="block text-[11px] text-muted-foreground font-normal">
                    {t('publicAppPushTypeOptionalHint')}
                  </span>
                </span>
              </Label>
              <Label
                htmlFor="push-type-mandatory"
                className={`flex items-start gap-2.5 rounded-lg border p-3 cursor-pointer transition-colors min-h-[44px] ${
                  pushType === 'mandatory' ? 'border-destructive bg-destructive/5' : 'hover:bg-muted/50'
                }`}
              >
                <RadioGroupItem value="mandatory" id="push-type-mandatory" className="mt-0.5" />
                <span className="space-y-0.5">
                  <span className="block text-xs font-medium text-destructive">
                    {t('publicAppPushTypeMandatory')}
                  </span>
                  <span className="block text-[11px] text-muted-foreground font-normal">
                    {t('publicAppPushTypeMandatoryHint')}
                  </span>
                </span>
              </Label>
            </RadioGroup>
          </div>

          <NotesInput
            label={t('publicAppPushMessage')}
            value={notes}
            onChange={setNotes}
            disabled={sending}
          />

          <div className="flex justify-end">
            <Button className="h-10" onClick={() => void sendPush()} disabled={sending || !appVersionId}>
              {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              {t('publicAppSendPush')}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ─── Pushes list ─── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <BellRing className="h-4 w-4 text-primary" />
            {t('publicAppPushesTitle')}
          </CardTitle>
          <CardDescription className="text-xs">{t('publicAppPushesDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading && (
            <div className="space-y-3" aria-busy="true">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-5/6" />
            </div>
          )}

          {!loading && error && (
            <div className="flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-center">
              <AlertTriangle className="h-8 w-8 text-destructive" />
              <p className="text-sm text-destructive font-medium">{t('publicAppLoadFailed')}</p>
              <p className="text-xs text-muted-foreground" dir="ltr">{error}</p>
              <Button variant="outline" size="sm" onClick={() => fetchAll(true)}>
                {t('publicAppRetry')}
              </Button>
            </div>
          )}

          {!loading && !error && pushes.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center">
                <BellOff className="h-6 w-6 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium">{t('publicAppNoPushes')}</p>
              <p className="text-xs text-muted-foreground max-w-sm">{t('publicAppNoPushesHint')}</p>
            </div>
          )}

          {!loading &&
            !error &&
            pushes.map((push, idx) => {
              const Icon = platformIcon(push.platform);
              const delivered = push.deliveredCount ?? 0;
              const updated = push.updatedCount ?? 0;
              const pct = delivered > 0 ? Math.min(100, Math.round((updated / delivered) * 100)) : 0;
              const isActive = push.status === 'ACTIVE';
              const busy = busyId === push.id;

              return (
                <motion.div
                  key={push.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min(idx * 0.04, 0.2) }}
                  className="rounded-lg border p-3 space-y-3"
                >
                  <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:justify-between">
                    <div className="flex flex-wrap items-center gap-2 min-w-0">
                      <Icon className="h-4 w-4 text-primary shrink-0" />
                      <span className="text-xs font-medium">{platformLabel(push.platform, lang)}</span>
                      <span className="text-xs font-mono text-muted-foreground" dir="ltr">
                        → v{push.appVersion?.version ?? '?'}
                      </span>
                      {push.isMandatory ? (
                        <Badge variant="destructive" className="text-[10px] h-5 px-1.5">
                          <Zap className="h-3 w-3 me-1" />
                          {t('publicAppPushTypeMandatory')}
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="text-[10px] h-5 px-1.5">
                          {t('publicAppPushTypeOptional')}
                        </Badge>
                      )}
                      <Badge
                        variant={isActive ? 'default' : 'outline'}
                        className={`text-[10px] h-5 px-1.5 ${isActive ? 'bg-emerald-600 hover:bg-emerald-600' : 'text-muted-foreground'}`}
                      >
                        {isActive ? t('publicAppPushStatusActive') : t('publicAppPushStatusCancelled')}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {isActive ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 text-xs"
                          disabled={busy || !!busyId}
                          onClick={() => void cancelPush(push)}
                        >
                          <Ban className="h-3.5 w-3.5" />
                          {t('publicAppPushCancel')}
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 text-xs"
                          disabled={busy || !!busyId}
                          onClick={() => void reactivatePush(push)}
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                          {t('publicAppPushReactivate')}
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                        aria-label={t('publicAppPushDelete')}
                        disabled={busy || !!busyId}
                        onClick={() => setDeleting(push)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>

                  {(push.messageAr || push.message || push.messageFr) && (
                    <p className="text-xs text-muted-foreground line-clamp-2" dir={lang === 'ar' ? 'rtl' : 'ltr'}>
                      {(lang === 'ar' ? push.messageAr : lang === 'fr' ? push.messageFr : push.message)
                        || push.messageAr || push.message || push.messageFr}
                    </p>
                  )}

                  <div className="flex flex-col gap-2">
                    <div className="flex flex-wrap items-center gap-3 text-xs">
                      <span className="flex items-center gap-1.5">
                        <BellRing className="h-3.5 w-3.5 text-emerald-600" />
                        {t('publicAppDeliveredCount', { count: String(delivered) })}
                      </span>
                      <span className="flex items-center gap-1.5">
                        <Zap className="h-3.5 w-3.5 text-amber-600" />
                        {t('publicAppUpdatedCount', { count: String(updated) })}
                      </span>
                      <span className="text-[11px] text-muted-foreground ms-auto">
                        {formatDateTime(push.createdAt, lang)}
                      </span>
                    </div>
                    <Progress value={pct} className="h-1.5" />
                  </div>
                </motion.div>
              );
            })}
        </CardContent>
      </Card>

      {/* ─── Delete push confirmation ─── */}
      <AlertDialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              {t('publicAppPushDeleteConfirmTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleting
                ? t('publicAppPushDeleteConfirmBody').replace(
                    '{version}',
                    deleting.appVersion?.version ?? '?',
                  )
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-10">{t('publicAppCancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="h-10 bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={!!busyId}
              onClick={(e) => {
                e.preventDefault();
                if (deleting) void deletePush(deleting);
              }}
            >
              {busyId ? <Loader2 className="h-4 w-4 animate-spin" /> : t('publicAppDelete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
