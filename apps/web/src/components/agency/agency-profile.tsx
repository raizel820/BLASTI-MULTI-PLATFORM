'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useAppStore } from '@/store/use-app-store';
import { useLanguage } from '@/hooks/use-language';
import { useUpload } from '@/hooks/use-upload';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import {
  Building2,
  MapPin,
  Phone,
  Mail,
  QrCode,
  Camera,
  Save,
  Loader2,
  Pencil,
  Check,
  X,
  Copy,
  Download,
  Clock,
  Share2,
  MessageCircle,
  Send,
  BadgeCheck,
  Radio,
  Zap,
  Volume2,
  CalendarDays,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import QRCode from 'qrcode';
import type { TranslationKeys } from '@/i18n';
import { getProxiedUrl } from '@/lib/utils';
import { apiFetch } from '@/lib/api-fetch';
import { formatWorkingDaysList } from '@/lib/enum-i18n';
import { AgencyCategorySelect } from '@/components/agency/agency-category-select';
import { BUILT_IN_CATEGORY_OPTIONS } from '@/hooks/use-agency-categories';
// Task 5 — Algeria address selectors (58 wilayas + their communes).
import {
  WilayaSelect,
  CommuneSelect,
  composeLocationLabel,
} from '@/components/shared/algeria-location-selects';
import { findWilayaByCode } from '@/lib/algeria-locations';

interface AgencyInfo {
  id: string;
  name: string;
  nameAr?: string;
  nameFr?: string;
  address: string;
  addressAr?: string;
  category: string;
  phone: string;
  email?: string;
  code: string;
  logoUrl?: string;
  workingHoursStart?: string;
  workingHoursEnd?: string;
  workingDays?: string;
  // Task 37: real queue state from GET /api/agency/profile. Optional so the
  // component still renders against older payloads (desktop local API).
  isQueueOpen?: boolean;
  queuePaused?: boolean;
  // Task 5: Algeria address (wilaya = two-digit official code, city =
  // commune/baladiya Latin name). Optional — older payloads omit them.
  wilaya?: string;
  city?: string;
}

/** Round 15 — localized weekday list for the workingDays CSV (0=Sunday).
 *  Task 31-A: delegated to the shared formatWorkingDaysList and driven by the
 *  app language (was navigator.language, which ignored the in-app ar/fr
 *  selection on English-locale machines). Falls back to the raw CSV when the
 *  list cannot be formatted. */
function formatWorkingDays(csv: string, lang: 'en' | 'ar' | 'fr'): string {
  return formatWorkingDaysList(csv, lang, { short: true }) || csv;
}

export function AgencyProfile() {
  const { user } = useAppStore();
  const { t, lang } = useLanguage();
  const [profile, setProfile] = useState<AgencyInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [editMode, setEditMode] = useState(false);
  const [saving, setSaving] = useState(false);
  // Client-side generated QR (PNG data URL) — works OFFLINE on the desktop
  // (the old flow fetched an SVG from /api/agency/qr-code, which the local
  // API answered with a JSON placeholder → the QR section never rendered).
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrLoading, setQrLoading] = useState(false);
  const logoInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchProfile();
  }, []);

  const fetchProfile = async () => {
    setLoading(true);
    try {
    const params = user?.agencyId ? `?agencyId=${user.agencyId}` : '';
    const res = await apiFetch(`/api/agency/profile${params}`);
    if (res.ok) {
        const data = await res.json();
        setProfile(data);
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setLoading(false);
    }
  };

  const fetchQrCode = useCallback(async (code: string) => {
    if (!code) return;
    setQrLoading(true);
    try {
      // Same payload the cloud endpoint encodes (<app-url>/?code=<code>),
      // generated locally with the bundled `qrcode` package — no server
      // round-trip, works offline on the desktop shell.
      const base = typeof window !== 'undefined' ? window.location.origin : '';
      const dataUrl = await QRCode.toDataURL(`${base}/?code=${encodeURIComponent(code)}`, {
        margin: 1,
        width: 240,
        color: { dark: '#065f46', light: '#ffffff' },
      });
      setQrDataUrl(dataUrl);
    } catch {
      // silent — placeholder icon renders instead
    } finally {
      setQrLoading(false);
    }
  }, []);

  useEffect(() => {
    if (profile?.code) {
      fetchQrCode(profile.code);
    }
  }, [profile?.code, fetchQrCode]);

  const handleSave = async () => {
    setSaving(true);
    try {
      // Task 5 — wilaya/city are sent as a coherent PAIR only: the stored
      // city counts as selected when it belongs to the selected wilaya's
      // commune list (case-insensitive). Empty strings are never sent (they
      // would fail the API's min(1) validation); absent keys leave the
      // currently stored values untouched, so the UI cannot crash against a
      // cloud that does not accept the fields yet either.
      const { wilaya: _saveWilaya, city: _saveCity, ...restProfile } = profile ?? {};
      const payload: Record<string, unknown> = { ...restProfile, agencyId: user?.agencyId };
      const pairWilaya = profile?.wilaya ?? '';
      const pairCity = selectedCommune;
      if (pairWilaya && pairCity) {
        payload.wilaya = pairWilaya;
        payload.city = pairCity;
      }
      const res = await apiFetch('/api/agency/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        toast.success(t('success'));
        setEditMode(false);
        // Task 5 — re-sync local state with the server truth: location pairs
        // that were omitted from the payload (no coherent wilaya+commune)
        // keep their stored values, so the read view must reflect the
        // server, not the half-edited local draft.
        fetchProfile();
      } else {
        const data = await res.json();
        toast.error(data.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setSaving(false);
    }
  };

  const updateField = (field: keyof AgencyInfo, value: string) => {
    setProfile((prev) => (prev ? { ...prev, [field]: value } : prev));
  };

  // Task 5 — effective commune selection: the stored city only counts as
  // selected when it belongs to the currently-selected wilaya (case-
  // insensitive match against that wilaya's commune list). A city that does
  // not match (legacy default "M'Sila" under a different wilaya, an older
  // payload, …) leaves the commune selector unselected instead of showing a
  // bogus value. Recomputed on profile changes so a wilaya switch resets it.
  const selectedCommune = useMemo(() => {
    const city = profile?.city ?? '';
    const wilayaCodeValue = profile?.wilaya ?? '';
    if (!city || !wilayaCodeValue) return '';
    const wilaya = findWilayaByCode(wilayaCodeValue);
    if (!wilaya) return '';
    return wilaya.communes.some((c) => c.name.toLowerCase() === city.toLowerCase()) ? city : '';
  }, [profile?.city, profile?.wilaya]);

  const getCategoryLabel = (cat: string) => {
    // Built-ins resolve through the shared 25-option list; custom categories
    // (user-entered names) display as-is.
    const found = BUILT_IN_CATEGORY_OPTIONS.find((c) => c.value === cat.toUpperCase());
    return found ? t(found.labelKey as TranslationKeys) : cat;
  };

  const agencyLink = profile?.code ? `${typeof window !== 'undefined' ? window.location.origin : ''}/?code=${profile.code}` : '';

  const handleCopyLink = async () => {
    if (!agencyLink) return;
    try {
      await navigator.clipboard.writeText(agencyLink);
      toast.success(t('linkCopied'));
    } catch {
      // Fallback
      const textArea = document.createElement('textarea');
      textArea.value = agencyLink;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      toast.success(t('linkCopied'));
    }
  };

  const handleDownloadQr = () => {
    if (!qrDataUrl) return;
    const a = document.createElement('a');
    a.href = qrDataUrl;
    a.download = `blasti-${profile?.code || 'qr'}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    toast.success(t('downloaded'));
  };

  const getAgencyNameForShare = () => {
    if (lang === 'ar' && profile?.nameAr) return profile.nameAr;
    if (lang === 'fr' && profile?.nameFr) return profile.nameFr;
    return profile?.name || t('appName');
  };

  const shareText = `Join the queue at ${getAgencyNameForShare()}`;
  const currentUrl = typeof window !== 'undefined' ? window.location.origin : '';
  const agencyShareUrl = profile?.code ? `${currentUrl}/?code=${profile.code}` : currentUrl;

  const handleShareWhatsApp = () => {
    window.open(`https://wa.me/?text=${encodeURIComponent(shareText)}%20${encodeURIComponent(agencyShareUrl)}`, '_blank');
  };

  const handleShareTelegram = () => {
    window.open(`https://t.me/share/url?url=${encodeURIComponent(agencyShareUrl)}&text=${encodeURIComponent(shareText)}`, '_blank');
  };

  const handleShareFacebook = () => {
    window.open(`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(agencyShareUrl)}&quote=${encodeURIComponent(shareText)}`, '_blank');
  };

  if (loading) {
    return (
      <div className="p-4 lg:p-6 space-y-4">
        <Skeleton className="h-8 w-40" />
        <div className="rounded-2xl overflow-hidden shimmer-loading">
          <Skeleton className="h-32 skeleton-shimmer-enhanced" />
          <Skeleton className="h-48 skeleton-shimmer-enhanced" />
        </div>
        <Skeleton className="h-40 rounded-2xl skeleton-shimmer-enhanced" />
      </div>
    );
  }

  // Check if agency is currently open
  const isCurrentlyOpen = (() => {
    if (!profile?.workingHoursStart || !profile?.workingHoursEnd) return null;
    const now = new Date();
    const [sh, sm] = profile.workingHoursStart.split(':').map(Number);
    const [eh, em] = profile.workingHoursEnd.split(':').map(Number);
    const cur = now.getHours() * 60 + now.getMinutes();
    const startMin = sh * 60 + sm;
    const endMin = eh * 60 + em;
    if (startMin > endMin) return cur >= startMin || cur < endMin;
    return cur >= startMin && cur < endMin;
  })();

  return (
    <div className="p-4 lg:p-6 space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-foreground">{t('agencyProfile')}</h1>
        {editMode ? (
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="rounded-lg h-9"
              onClick={() => {
                setEditMode(false);
                fetchProfile();
              }}
            >
              <X className="h-4 w-4 me-1.5" />
              {t('cancel')}
            </Button>
            <Button
              size="sm"
              className="bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg h-9"
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              {t('save')}
            </Button>
          </div>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="rounded-lg h-9"
            onClick={() => setEditMode(true)}
          >
            <Pencil className="h-4 w-4 me-1.5" />
            {t('edit')}
          </Button>
        )}
      </div>

      {/* Agency Info Card with Hero Banner */}
      <motion.div
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
      >
        <Card className="border-0 shadow-sm overflow-hidden bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50">
          {/* Hero Banner with gradient overlay — Task 31-A: overflow-hidden
              removed so the logo overhang (-bottom-12) is not clipped in
              half; the parent Card's overflow-hidden still clips the
              decorative circles. */}
          <div className="h-36 bg-gradient-to-br from-emerald-500 via-teal-500 to-emerald-600 relative">
            {/* Gradient overlay */}
            <div className="absolute inset-0 hero-gradient-overlay" />
            {/* Decorative elements */}
            <div className="absolute -top-8 -end-8 h-32 w-32 rounded-full bg-white/10 blur-sm" />
            <div className="absolute bottom-0 -start-6 h-24 w-24 rounded-full bg-white/5" />
            <div className="absolute top-4 end-6 flex items-center gap-2">
              {/* Open/Closed status indicator with animated dot */}
              {isCurrentlyOpen !== null && (
                <Badge className={`text-xs px-2.5 py-1 ${
                  isCurrentlyOpen
                    ? 'bg-emerald-400/20 text-white border-emerald-400/30'
                    : 'bg-red-400/20 text-white border-red-400/30'
                }`}>
                  <span className={`h-2 w-2 rounded-full me-1.5 inline-block ${isCurrentlyOpen ? 'bg-emerald-300 status-dot-blink' : 'bg-red-300'}`} />
                  {isCurrentlyOpen ? t('openNow') : t('closed')}
                </Badge>
              )}
              {/* Queue Status Badge — Task 37: renders the REAL queue state
                  (paused / closed / active) instead of a hardcoded
                  "Queue Active". When the payload carries no isQueueOpen
                  (older desktop builds), the legacy always-active badge is
                  preserved. */}
              {profile?.queuePaused === true ? (
                <Badge className="bg-amber-400/20 text-white border-amber-400/30 text-xs px-2.5 py-1">
                  <motion.span
                    animate={{ scale: [1, 1.2, 1] }}
                    transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
                    className="inline-flex items-center gap-1"
                  >
                    <Radio className="h-3 w-3" />
                    {t('queuePaused')}
                  </motion.span>
                </Badge>
              ) : profile?.isQueueOpen === false ? (
                <Badge className="bg-red-400/20 text-white border-red-400/30 text-xs px-2.5 py-1">
                  <motion.span
                    animate={{ scale: [1, 1.2, 1] }}
                    transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
                    className="inline-flex items-center gap-1"
                  >
                    <Radio className="h-3 w-3" />
                    {t('queueClosed')}
                  </motion.span>
                </Badge>
              ) : (
                <Badge className="bg-white/20 text-white border-white/30 text-xs px-2.5 py-1">
                  <motion.span
                    animate={{ scale: [1, 1.2, 1] }}
                    transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
                    className="inline-flex items-center gap-1"
                  >
                    <Radio className="h-3 w-3" />
                    {t('queueActive') || 'Queue Active'}
                  </motion.span>
                </Badge>
              )}
            </div>
            <div className="absolute -bottom-12 start-5">
              {/* Animated agency logo/icon with floating animation */}
              <motion.div
                animate={{ y: [0, -4, 0] }}
                transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
                className="h-24 w-24 rounded-2xl bg-white dark:bg-gray-800 shadow-lg flex items-center justify-center border-4 border-white dark:border-gray-800"
              >
                {profile?.logoUrl ? (
                  <img
                    src={getProxiedUrl(profile.logoUrl)}
                    alt="Logo"
                    className="h-full w-full object-contain"
                  />
                ) : (
                  <Building2 className="h-8 w-8 text-emerald-600" />
                )}
              </motion.div>
            </div>
            {editMode && (
              <>
                <input
                  ref={logoInputRef}
                  type="file"
                  accept=".jpg,.jpeg,.png,.svg,.webp"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    if (file.size > 5 * 1024 * 1024) {
                      toast.error(t('fileTooLarge'));
                      return;
                    }
                    const form = new FormData();
                    form.append('file', file);
                    // Task 24 FIX: declare the upload type as a form field too —
                    // the cloud route reads formData 'type' first and previously
                    // only saw 'general'.
                    form.append('type', 'logo');
                    try {
                      const uploadRes = await apiFetch('/api/upload?type=logo', { method: 'POST', body: form });
                      if (uploadRes.ok) {
                        const uploadData = await uploadRes.json();
                        updateField('logoUrl', uploadData.url);
                        toast.success(t('success'));
                      } else {
                        toast.error(t('error'));
                      }
                    } catch {
                      toast.error(t('error'));
                    }
                  }}
                  className="hidden"
                />
                <Button
                  size="sm"
                  className="absolute bottom-3 end-3 bg-white/20 text-white border-white/30 hover:bg-white/30 rounded-lg"
                  onClick={() => logoInputRef.current?.click()}
                >
                  <Camera className="h-4 w-4 me-1.5" />
                  {t('uploadLogo')}
                </Button>
              </>
            )}
          </div>

          <CardContent className="pt-16 p-5 space-y-4">
            {editMode ? (
              <div className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>{t('agencyName')} (EN)</Label>
                    <Input
                      value={profile?.name ?? ''}
                      onChange={(e) => updateField('name', e.target.value)}
                      className="h-11 rounded-xl border-gray-200 dark:border-gray-700 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-500/20"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>{t('agencyName')} (AR)</Label>
                    <Input
                      value={profile?.nameAr ?? ''}
                      onChange={(e) => updateField('nameAr', e.target.value)}
                      className="h-11 rounded-xl border-gray-200 dark:border-gray-700 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-500/20"
                      dir="rtl"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>{t('agencyName')} (FR)</Label>
                    <Input
                      value={profile?.nameFr ?? ''}
                      onChange={(e) => updateField('nameFr', e.target.value)}
                      className="h-11 rounded-xl border-gray-200 dark:border-gray-700 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-500/20"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>{t('agencyCategory')}</Label>
                    {/* Task 42 — shared picker (compact trigger opens the searchable
                        25-built-in + custom-fields dialog); value shape unchanged. */}
                    <AgencyCategorySelect
                      variant="compact"
                      value={profile?.category ?? 'OTHER'}
                      onChange={(v) => updateField('category', v)}
                      disabled={saving}
                    />
                  </div>
                  {/* Task 5 — Algeria location selectors. Initialized from the
                      agency's stored wilaya/city; a stored city that does not
                      belong to the selected wilaya starts unselected. */}
                  <div className="space-y-2">
                    <Label>{t('location.wilaya' as any)}</Label>
                    <WilayaSelect
                      value={profile?.wilaya ?? ''}
                      onValueChange={(code) => {
                        if (code === profile?.wilaya) return;
                        updateField('wilaya', code);
                        // Dependent list — the commune must belong to the
                        // newly selected wilaya, so reset it.
                        updateField('city', '');
                      }}
                      lang={lang}
                      placeholder={t('location.selectWilaya' as any)}
                      id="profile-wilaya"
                      aria-label={t('location.wilaya' as any)}
                      disabled={saving}
                      triggerClassName="h-11 rounded-xl border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 data-[state=open]:border-emerald-400 focus-visible:border-emerald-400 focus-visible:ring-emerald-500/20"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>{t('location.commune' as any)}</Label>
                    <CommuneSelect
                      wilayaCode={profile?.wilaya ?? ''}
                      value={selectedCommune}
                      onValueChange={(name) => updateField('city', name)}
                      lang={lang}
                      placeholder={t('location.selectCommune' as any)}
                      id="profile-commune"
                      aria-label={t('location.commune' as any)}
                      disabled={saving}
                      triggerClassName="h-11 rounded-xl border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 data-[state=open]:border-emerald-400 focus-visible:border-emerald-400 focus-visible:ring-emerald-500/20"
                    />
                  </div>
                  <div className="space-y-2 sm:col-span-2">
                    <Label>{t('agencyAddress')}</Label>
                    <Input
                      value={profile?.address ?? ''}
                      onChange={(e) => updateField('address', e.target.value)}
                      className="h-11 rounded-xl border-gray-200 dark:border-gray-700 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-500/20"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>{t('agencyPhone')}</Label>
                    <Input
                      value={profile?.phone ?? ''}
                      onChange={(e) => updateField('phone', e.target.value)}
                      className="h-11 rounded-xl border-gray-200 dark:border-gray-700 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-500/20"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>{t('agencyEmail')}</Label>
                    <Input
                      type="email"
                      value={profile?.email ?? ''}
                      onChange={(e) => updateField('email', e.target.value)}
                      className="h-11 rounded-xl border-gray-200 dark:border-gray-700 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-500/20"
                    />
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <h2 className="text-xl font-bold text-foreground">{profile?.name}</h2>
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400">
                    {getCategoryLabel(profile?.category ?? 'OTHER')}
                  </span>
                </div>
                <Separator />
                <div className="space-y-2.5">
                  <div className="flex items-center gap-3 text-sm">
                    <MapPin className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                    <span className="text-muted-foreground">{profile?.address}</span>
                  </div>
                  {/* Task 5 — composed Algeria location (wilaya · commune) */}
                  {composeLocationLabel(profile?.wilaya ?? '', selectedCommune, lang) && (
                    <div className="flex items-center gap-3 text-sm">
                      <MapPin className="h-4 w-4 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
                      <span className="text-muted-foreground">
                        {composeLocationLabel(profile?.wilaya ?? '', selectedCommune, lang)}
                      </span>
                    </div>
                  )}
                  <div className="flex items-center gap-3 text-sm">
                    <Phone className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                    <span className="text-muted-foreground">{profile?.phone}</span>
                  </div>
                  {profile?.email && (
                    <div className="flex items-center gap-3 text-sm">
                      <Mail className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                      <span className="text-muted-foreground">{profile.email}</span>
                    </div>
                  )}
                  <div className="flex items-center gap-3 text-sm">
                    <Clock className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                    <span className="text-muted-foreground">{t('workingHours')}: {profile?.workingHoursStart || '08:00'} - {profile?.workingHoursEnd || '17:00'}</span>
                  </div>
                  {profile?.workingDays && (
                    <div className="flex items-center gap-3 text-sm">
                      <CalendarDays className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                      <span className="text-muted-foreground">{t('workingDays')}: {formatWorkingDays(profile.workingDays, lang)}</span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </motion.div>

      {/* QR Code / Agency Code */}
      <motion.div
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.05 }}
      >
        <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <QrCode className="h-4 w-4 text-emerald-600" />
              {t('generateQR')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col sm:flex-row items-center gap-5">
              {/* QR Code Image — generated client-side (offline-safe) */}
              <div className="h-32 w-32 rounded-xl bg-white dark:bg-gray-900 flex items-center justify-center border-2 border-gray-200 dark:border-gray-700 shadow-sm flex-shrink-0 overflow-hidden">
                {qrLoading ? (
                  <Loader2 className="h-8 w-8 text-emerald-600 animate-spin" />
                ) : qrDataUrl ? (
                  <img src={qrDataUrl} alt={`QR code — agency ${profile?.code || ''}`} className="h-full w-full object-contain p-2" />
                ) : (
                  <QrCode className="h-10 w-10 text-muted-foreground" />
                )}
              </div>

              <div className="flex-1 text-center sm:text-start">
                <p className="text-sm font-medium text-foreground mb-1">{t('agencyCode')}</p>
                <p className="text-2xl font-mono font-bold text-emerald-700 dark:text-emerald-400 mb-1" dir="ltr">
                  {profile?.code || t('notAvailable')}
                </p>
                <p className="text-xs text-muted-foreground mb-3">
                  {t('shareCodeText')}
                </p>
                <div className="flex items-center gap-2 justify-center sm:justify-start">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-9 rounded-lg text-xs"
                    onClick={handleCopyLink}
                  >
                    <Copy className="h-3.5 w-3.5 me-1.5" />
                    {t('copyLink')}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-9 rounded-lg text-xs"
                    onClick={handleDownloadQr}
                    disabled={!qrDataUrl}
                  >
                    <Download className="h-3.5 w-3.5 me-1.5" />
                    {t('downloadQr')}
                  </Button>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </motion.div>

      {/* Share & Social Section */}
      <motion.div
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
      >
        <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Share2 className="h-4 w-4 text-emerald-600" />
              {t('shareAgency')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-center gap-4">
              {/* WhatsApp */}
              <motion.button
                whileHover={{ scale: 1.1, y: -2 }}
                whileTap={{ scale: 0.95 }}
                onClick={handleShareWhatsApp}
                className="h-12 w-12 rounded-full bg-green-500 hover:bg-green-600 text-white flex items-center justify-center shadow-md shadow-green-500/25 transition-colors"
                title={t('shareOnWhatsApp')}
              >
                <MessageCircle className="h-5 w-5" />
              </motion.button>
              {/* Telegram */}
              <motion.button
                whileHover={{ scale: 1.1, y: -2 }}
                whileTap={{ scale: 0.95 }}
                onClick={handleShareTelegram}
                className="h-12 w-12 rounded-full bg-blue-500 hover:bg-blue-600 text-white flex items-center justify-center shadow-md shadow-blue-500/25 transition-colors"
                title={t('shareOnTelegram')}
              >
                <Send className="h-5 w-5" />
              </motion.button>
              {/* Facebook */}
              <motion.button
                whileHover={{ scale: 1.1, y: -2 }}
                whileTap={{ scale: 0.95 }}
                onClick={handleShareFacebook}
                className="h-12 w-12 rounded-full bg-blue-700 hover:bg-blue-800 text-white flex items-center justify-center shadow-md shadow-blue-700/25 transition-colors"
                title={t('shareOnFacebook')}
              >
                <BadgeCheck className="h-5 w-5" />
              </motion.button>
            </div>
            {/* Copy Link Button */}
            <div className="mt-4 flex items-center justify-center gap-3">
              <Button
                variant="outline"
                className="h-10 rounded-xl text-sm font-medium border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 gap-2"
                onClick={handleCopyLink}
              >
                <Copy className="h-4 w-4" />
                {t('copyLink')}
              </Button>
            </div>
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}
