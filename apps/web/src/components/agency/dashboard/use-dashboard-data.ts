'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useAppStore } from '@/store/use-app-store';
import { useLanguage } from '@/hooks/use-language';
import { toast } from 'sonner';
import QRCode from 'qrcode';
import { apiFetch } from '@/lib/api-fetch';
import { shouldSkipPoll, isCloudDown } from '@/hooks/use-offline-aware-polling';
import type { QueueEntry, DashboardStats, ServiceStat, ActivityEvent } from './types';
import { getLocale } from './helpers';

export function useDashboardData() {
  const { user, setView } = useAppStore();
  const { t, lang } = useLanguage();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [waitingList, setWaitingList] = useState<QueueEntry[]>([]);
  const [serviceStats, setServiceStats] = useState<ServiceStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [activityEvents, setActivityEvents] = useState<ActivityEvent[]>([]);
  const [batchMode, setBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchLoading, setBatchLoading] = useState(false);
  const [announcements, setAnnouncements] = useState<Array<{ id: string; message: string; createdAt: string; type?: string }>>([]);
  const [newAnnouncement, setNewAnnouncement] = useState('');
  const [announcementLoading, setAnnouncementLoading] = useState(false);
  const [exportLoading, setExportLoading] = useState(false);
  const [analyticsOpen, setAnalyticsOpen] = useState(false);
  const [serviceAnalytics, setServiceAnalytics] = useState<Array<{
    serviceId: string; serviceName: string; serviceNameAr?: string; serviceNameFr?: string;
    avgWaitTime: number; totalServed: number; avgRating: number;
  }>>([]);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string>('');
  const [agencyCode, setAgencyCode] = useState<string>('');
  const [showQrModal, setShowQrModal] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());
  const [walkInOpen, setWalkInOpen] = useState(false);
  const [walkInName, setWalkInName] = useState('');
  const [walkInServiceId, setWalkInServiceId] = useState('');
  const [walkInLoading, setWalkInLoading] = useState(false);
  const sectionRef = useRef<HTMLDivElement>(null);
  const agencyId = user?.agencyId || '';

  // Track consecutive poll failures for exponential backoff
  const pollFailuresRef = useRef(0);
  // Track whether we've shown an error toast
  const pollErrorShownRef = useRef(false);

  const fetchAgencyCode = useCallback(async () => {
    if (!agencyId) return;
    try {
      const res = await apiFetch('/api/agency/profile');
      if (res.ok) { const data = await res.json(); setAgencyCode(data.code || ''); }
    } catch { /* silent */ }
  }, [agencyId]);

  useEffect(() => {
    if (!agencyCode) return;
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://blasti.dz';
    QRCode.toDataURL(`${baseUrl}/?code=${agencyCode}`, {
      width: 256, margin: 2, color: { dark: '#047857', light: '#ffffff' }, errorCorrectionLevel: 'M',
    }).then((url) => setQrCodeDataUrl(url)).catch(() => {});
  }, [agencyCode]);

  const fetchData = useCallback(async (isPoll = false) => {
    if (!agencyId) return;
    try {
      const [statsRes, listRes, servicesRes, activityRes] = await Promise.all([
        apiFetch('/api/agency/stats'),
        apiFetch('/api/agency/queue?status=WAITING,CALLED'),
        apiFetch('/api/agency/services'),
        apiFetch('/api/agency/activity'),
      ]);
      let anySuccess = false;
      if (statsRes.ok) { const data = await statsRes.json(); setStats(data); anySuccess = true; }
      if (listRes.ok) { const data = await listRes.json(); setWaitingList(data.entries ?? []); anySuccess = true; }
      if (servicesRes.ok) {
        const data = await servicesRes.json();
        if (data.services) setServiceStats(data.services.map((s: ServiceStat) => ({ ...s, waitingCount: s._count?.waiting ?? 0, completedCount: s._count?.completed ?? 0 })));
        anySuccess = true;
      }
      if (activityRes.ok) { const data = await activityRes.json(); setActivityEvents(data.events ?? []); anySuccess = true; }

      if (anySuccess) {
        setLastUpdated(new Date());
        pollFailuresRef.current = 0;
        pollErrorShownRef.current = false;
      }
    } catch {
      // apiFetch never throws — this is dead code safety net
      if (!isPoll && !pollErrorShownRef.current) {
        toast.error(t('error'));
        pollErrorShownRef.current = true;
      }
    }
    finally { setLoading(false); }
  }, [agencyId, t]);

  const handleCallNext = async () => {
    setActionLoading('call');
    try {
      const res = await apiFetch('/api/agency/queue/call-next', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      if (res.ok) { toast.success(t('statusCalled')); fetchData(); }
      else { const data = await res.json(); toast.error(data.details || data.error || t('noQueue')); }
    } catch { toast.error(t('error')); }
    finally { setActionLoading(null); }
  };

  const handleTogglePause = async () => {
    setActionLoading('pause');
    try {
      const res = await apiFetch('/api/agency/queue/toggle-pause', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      if (res.ok) { toast.success(stats?.isPaused ? t('queueResumed') : t('queuePaused')); fetchData(); }
    } catch { toast.error(t('error')); }
    finally { setActionLoading(null); }
  };

  const handleAction = async (entryId: string, action: 'complete' | 'no_show' | 'cancel') => {
    setActionLoading(`${entryId}-${action}`);
    try {
      const res = await apiFetch(`/api/agency/queue/${entryId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
      if (res.ok) { toast.success(t('success')); fetchData(); }
      else { const data = await res.json(); toast.error(data.error || t('error')); }
    } catch { toast.error(t('error')); }
    finally { setActionLoading(null); }
  };

  const toggleBatchSelection = (id: string) => {
    setSelectedIds(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  };

  const handleBatchComplete = async () => {
    if (selectedIds.size === 0) return;
    setBatchLoading(true);
    try {
      const promises = Array.from(selectedIds).map(id => apiFetch(`/api/agency/queue/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'complete' }) }));
      const results = await Promise.allSettled(promises);
      let failedCount = 0;
      for (const r of results) { if (r.status === 'rejected') failedCount++; else if (r.status === 'fulfilled' && !r.value.ok) failedCount++; }
      if (failedCount === 0) toast.success(t('success'));
      else if (failedCount < results.length) toast.warning(t('batchPartialFail') || `${failedCount}/${results.length} actions failed`);
      else toast.error(t('error'));
      setSelectedIds(new Set()); setBatchMode(false); fetchData();
    } catch { toast.error(t('error')); }
    finally { setBatchLoading(false); }
  };

  const exitBatchMode = () => { setBatchMode(false); setSelectedIds(new Set()); };

  const fetchAnnouncements = useCallback(async () => {
    if (!agencyId) return;
    try { const res = await apiFetch('/api/agency/announcements'); if (res.ok) { const data = await res.json(); setAnnouncements(data.announcements ?? []); } } catch {}
  }, [agencyId]);

  // Offline-aware polling with exponential backoff
  useEffect(() => {
    if (!agencyId) return;

    // Initial fetch
    fetchData(false);
    fetchAnnouncements();
    fetchAgencyCode();

    const NORMAL_INTERVAL = 10_000;
    let intervalMs = NORMAL_INTERVAL;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const scheduleNext = () => {
      if (stopped) return;
      timer = setTimeout(tick, intervalMs);
    };

    const tick = async () => {
      if (stopped) return;

      // FIX #8: Skip polling entirely when fully offline
      if (shouldSkipPoll()) {
        scheduleNext();
        return;
      }

      await fetchData(true);

      // FIX #9: Exponential backoff on consecutive failures
      // apiFetch never throws, so we check isCloudDown() as a proxy for failure
      if (isCloudDown()) {
        pollFailuresRef.current = Math.min(pollFailuresRef.current + 1, 10);
      } else {
        pollFailuresRef.current = 0;
        intervalMs = NORMAL_INTERVAL;
      }

      // Apply backoff: 10s → 30s → 60s → 120s → 300s
      if (pollFailuresRef.current >= 1) intervalMs = 30_000;
      if (pollFailuresRef.current >= 3) intervalMs = 60_000;
      if (pollFailuresRef.current >= 5) intervalMs = 120_000;
      if (pollFailuresRef.current >= 8) intervalMs = 300_000;

      scheduleNext();
    };

    scheduleNext();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [agencyId]);

  const handleCreateAnnouncement = async () => {
    if (!newAnnouncement.trim() || !agencyId) return;
    setAnnouncementLoading(true);
    try {
      const res = await apiFetch(`/api/agency/announcements`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: newAnnouncement.trim() }) });
      if (res.ok) { setNewAnnouncement(''); toast.success(t('announcementCreated') || 'Announcement created'); fetchAnnouncements(); }
      else { const data = await res.json(); toast.error(data.error || t('error')); }
    } catch { toast.error(t('error')); }
    finally { setAnnouncementLoading(false); }
  };

  const handleDeleteAnnouncement = async (id: string) => {
    if (!agencyId) return;
    try { const res = await apiFetch(`/api/agency/announcements?id=${id}`, { method: 'DELETE' }); if (res.ok) { toast.success(t('announcementDeleted') || 'Announcement deleted'); fetchAnnouncements(); } } catch { toast.error(t('error')); }
  };

  const fetchServiceAnalytics = useCallback(async () => {
    if (!agencyId) return;
    setAnalyticsLoading(true);
    try { const res = await apiFetch('/api/agency/analytics'); if (res.ok) { const data = await res.json(); setServiceAnalytics(data.services ?? []); } } catch {}
    finally { setAnalyticsLoading(false); }
  }, [agencyId]);

  const handleExportCsv = async () => {
    if (!agencyId) return;
    setExportLoading(true);
    try {
      const res = await apiFetch('/api/agency/export-csv');
      if (res.ok) { const blob = await res.blob(); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `blasti-reservations-${new Date().toISOString().split('T')[0]}.csv`; a.click(); URL.revokeObjectURL(url); toast.success(t('exportSuccess')); }
      else toast.error(t('exportFailed'));
    } catch { toast.error(t('error')); }
    finally { setExportLoading(false); }
  };

  const handleAddWalkIn = async () => {
    if (!walkInName.trim() || !agencyId) return;
    setWalkInLoading(true);
    try {
      const body: Record<string, string> = { customerName: walkInName.trim() };
      if (walkInServiceId) body.serviceId = walkInServiceId;
      const res = await apiFetch('/api/agency/queue/walk-in', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (res.ok) { toast.success(t('walkInCustomerAdded')); setWalkInOpen(false); setWalkInName(''); setWalkInServiceId(''); fetchData(); }
      else { const data = await res.json(); toast.error(data.error || t('error')); }
    } catch { toast.error(t('error')); }
    finally { setWalkInLoading(false); }
  };

  // ─── Derived State ────────────────────────────
  const served = stats?.servedToday ?? 0;
  const noShows = stats?.noShowCount ?? 0;
  const cancelled = stats?.cancelledCount ?? 0;
  const totalProcessed = served + noShows + cancelled;
  const completionRate = totalProcessed > 0 ? (served / totalProcessed) * 100 : 0;
  const safeCompletionRate = isNaN(completionRate) ? 0 : completionRate;
  const maxWaiting = serviceStats.length > 0 ? Math.max(...serviceStats.map(s => s.waitingCount), 1) : 1;
  const totalToday = stats?.todayReservations ?? 0;
  const queueProgress = totalToday > 0 ? Math.min(((served + noShows + cancelled) / totalToday) * 100, 100) : 0;
  const currentlyServed = useMemo(() => waitingList.find(e => e.status === 'CALLED'), [waitingList]);
  const waitingOnly = useMemo(() => waitingList.filter(e => e.status === 'WAITING'), [waitingList]);
  const avgWait = stats?.avgWaitTime ?? 0;
  const waitLevel = (avgWait <= 10 ? 'low' : avgWait <= 25 ? 'medium' : 'high') as 'low' | 'medium' | 'high';
  const waitLevelConfig = { low: { label: t('lowWait'), dotColor: 'bg-emerald-300' }, medium: { label: t('mediumWait'), dotColor: 'bg-amber-300' }, high: { label: t('highWait'), dotColor: 'bg-rose-300' } };
  const locale = getLocale(lang);
  const lastUpdatedStr = useMemo(() => { try { return lastUpdated.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch { return ''; } }, [lastUpdated, locale]);
  const sparkData1 = stats?.todayReservations ? [Math.round(stats.todayReservations * 0.4), Math.round(stats.todayReservations * 0.6), Math.round(stats.todayReservations * 0.5), stats.todayReservations, Math.round(stats.todayReservations * 0.8), stats.todayReservations, Math.round(stats.todayReservations * 0.7)] : [0, 1, 0, 2, 1, 3, 1];
  const sparkData2 = stats?.currentlyWaiting ? [Math.round(stats.currentlyWaiting * 0.5), Math.round(stats.currentlyWaiting * 0.3), stats.currentlyWaiting, Math.round(stats.currentlyWaiting * 0.8), Math.round(stats.currentlyWaiting * 0.6), stats.currentlyWaiting, Math.round(stats.currentlyWaiting * 0.4)] : [0, 1, 2, 1, 0, 1, 0];
  const sparkData3 = stats?.servedToday ? [Math.round(stats.servedToday * 0.3), Math.round(stats.servedToday * 0.5), stats.todayReservations, Math.round(stats.servedToday * 0.7), Math.round(stats.servedToday * 0.9), stats.servedToday, Math.round(stats.servedToday * 0.8)] : [0, 0, 1, 0, 2, 1, 0];

  return {
    user, setView, t, lang, locale,
    stats, waitingList, serviceStats, loading, actionLoading,
    activityEvents, batchMode, selectedIds, batchLoading,
    announcements, newAnnouncement, announcementLoading, exportLoading,
    analyticsOpen, serviceAnalytics, analyticsLoading,
    qrCodeDataUrl, agencyCode, showQrModal, walkInOpen, walkInName, walkInServiceId, walkInLoading,
    lastUpdatedStr, sectionRef,
    served, noShows, cancelled, totalProcessed,
    safeCompletionRate, maxWaiting, queueProgress,
    currentlyServed, waitingOnly, avgWait,
    waitLevel, waitLevelConfig,
    sparkData1, sparkData2, sparkData3,
    fetchData, handleCallNext, handleTogglePause, handleAction,
    toggleBatchSelection, handleBatchComplete, exitBatchMode,
    setBatchMode, setNewAnnouncement, handleCreateAnnouncement, handleDeleteAnnouncement,
    setAnalyticsOpen, fetchServiceAnalytics,
    handleExportCsv, handleAddWalkIn,
    setShowQrModal, setWalkInOpen, setWalkInName, setWalkInServiceId,
  };
}
