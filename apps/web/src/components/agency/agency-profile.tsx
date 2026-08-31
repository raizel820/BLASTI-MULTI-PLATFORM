'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
} from 'lucide-react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import type { TranslationKeys } from '@/i18n';
import { getProxiedUrl } from '@/lib/utils';
import { apiFetch } from '@/lib/api-fetch';

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
}

const categoryOptions: { value: string; key: TranslationKeys }[] = [
  { value: 'CLINIC', key: 'catClinic' },
  { value: 'AGENCY', key: 'catAgency' },
  { value: 'LAW_FIRM', key: 'catLawFirm' },
  { value: 'LABORATORY', key: 'catLaboratory' },
  { value: 'GOVERNMENT', key: 'catGovernment' },
  { value: 'OTHER', key: 'catOther' },
];

export function AgencyProfile() {
  const { user } = useAppStore();
  const { t, lang } = useLanguage();
  const [profile, setProfile] = useState<AgencyInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [editMode, setEditMode] = useState(false);
  const [saving, setSaving] = useState(false);
  const [qrSvg, setQrSvg] = useState<string | null>(null);
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
      const res = await apiFetch(`/api/agency/qr-code?code=${encodeURIComponent(code)}`);
      if (res.ok) {
        const svg = await res.text();
        setQrSvg(svg);
      }
    } catch {
      // silent
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
      const res = await apiFetch('/api/agency/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...profile, agencyId: user?.agencyId }),
      });
      if (res.ok) {
        toast.success(t('success'));
        setEditMode(false);
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

  const getCategoryLabel = (cat: string) => {
    const found = categoryOptions.find((c) => c.value === cat.toUpperCase());
    return found ? t(found.key) : cat;
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
    if (!qrSvg) return;
    const svgBlob = new Blob([qrSvg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(svgBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `blasti-${profile?.code || 'qr'}.svg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
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
          {/* Hero Banner with gradient overlay */}
          <div className="h-36 bg-gradient-to-br from-emerald-500 via-teal-500 to-emerald-600 relative overflow-hidden">
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
              {/* Queue Status Badge */}
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
            </div>
            <div className="absolute -bottom-10 start-5">
              {/* Animated agency logo/icon with floating animation */}
              <motion.div
                animate={{ y: [0, -4, 0] }}
                transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
                className="h-20 w-20 rounded-2xl bg-white dark:bg-gray-800 shadow-lg flex items-center justify-center border-4 border-white dark:border-gray-800"
              >
                {profile?.logoUrl ? (
                  <img
                    src={getProxiedUrl(profile.logoUrl)}
                    alt="Logo"
                    className="h-full w-full object-cover rounded-xl"
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

          <CardContent className="pt-14 p-5 space-y-4">
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
                    <Select
                      value={profile?.category ?? 'OTHER'}
                      onValueChange={(v) => updateField('category', v)}
                    >
                      <SelectTrigger className="h-11 rounded-xl">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {categoryOptions.map((opt) => (
                          <SelectItem key={opt.value} value={opt.value}>
                            {t(opt.key)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
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
              {/* QR Code Image */}
              <div className="h-32 w-32 rounded-xl bg-white dark:bg-gray-900 flex items-center justify-center border-2 border-gray-200 dark:border-gray-700 shadow-sm flex-shrink-0 overflow-hidden">
                {qrLoading ? (
                  <Loader2 className="h-8 w-8 text-emerald-600 animate-spin" />
                ) : qrSvg ? (
                  <div
                    className="h-full w-full flex items-center justify-center p-2"
                    dangerouslySetInnerHTML={{ __html: qrSvg }}
                  />
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
                    disabled={!qrSvg}
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
