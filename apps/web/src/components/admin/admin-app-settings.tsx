'use client'
import { apiFetch } from '@/lib/api-fetch';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useAppStore } from '@/store/use-app-store';
import { useLanguage } from '@/hooks/use-language';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { Progress } from '@/components/ui/progress';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Smartphone,
  Monitor,
  Apple,
  Laptop,
  Download,
  Upload,
  Plus,
  Trash2,
  Edit3,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Loader2,
  Settings,
  AlertTriangle,
  Send,
  Globe,
  Package,
  Rocket,
  Shield,
} from 'lucide-react';
import { toast } from 'sonner';
import { motion } from 'framer-motion';

// ─── Types ─────────────────────────────────────────────────────────
interface AppVersion {
  id: string;
  platform: string;
  version: string;
  versionCode: number;
  releaseNotes: string;
  releaseNotesAr?: string | null;
  releaseNotesFr?: string | null;
  isMandatory: boolean;
  isPublished: boolean;
  isPatch: boolean;
  downloadUrl: string;
  fileStorageKey?: string | null;
  fileStorageProvider?: string | null;
  fileName?: string | null;
  fileSize?: number | null;
  fileHash?: string | null;
  minAppVersion?: string | null;
  publishedAt?: string | null;
  downloadCount: number;
  createdAt: string;
  updatedAt: string;
}

interface LatestVersions {
  [platform: string]: AppVersion | null;
}

type Platform = 'android' | 'ios' | 'electron' | 'windows' | 'mac' | 'linux';

// ─── Constants ─────────────────────────────────────────────────────

const PLATFORMS: { key: Platform; labelAr: string; labelEn: string; icon: typeof Smartphone }[] = [
  { key: 'android', labelAr: 'أندرويد', labelEn: 'Android', icon: Smartphone },
  { key: 'ios', labelAr: 'آيفون', labelEn: 'iOS', icon: Apple },
  { key: 'electron', labelAr: 'إلكترون', labelEn: 'Electron', icon: Monitor },
  { key: 'windows', labelAr: 'ويندوز', labelEn: 'Windows', icon: Monitor },
  { key: 'mac', labelAr: 'ماك', labelEn: 'macOS', icon: Laptop },
  { key: 'linux', labelAr: 'لينكس', labelEn: 'Linux', icon: Globe },
];

const SEMVER_REGEX = /^\d+\.\d+\.\d+$/;

// ─── Animation variants ───────────────────────────────────────────
const fadeUp = {
  initial: { opacity: 0, y: 15 },
  animate: { opacity: 1, y: 0 },
};

const staggerContainer = {
  animate: { transition: { staggerChildren: 0.06 } },
};

const staggerItem = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
};

// ─── Helper: format file size ─────────────────────────────────────
function formatFileSize(bytes: number | null | undefined): string {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '—';
  try {
    return new Date(dateStr).toLocaleDateString('ar-DZ', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return dateStr;
  }
}

// ─── Component ─────────────────────────────────────────────────────
export function AdminAppSettings() {
  const { setView } = useAppStore();
  const { t, lang } = useLanguage();
  const isRTL = lang === 'ar';

  // ── Data state ──
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [versions, setVersions] = useState<AppVersion[]>([]);
  const [latestVersions, setLatestVersions] = useState<LatestVersions>({});
  const [selectedPlatform, setSelectedPlatform] = useState<string>('all');

  // ── Dialog state ──
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [publishAlertOpen, setPublishAlertOpen] = useState(false);
  const [editingVersion, setEditingVersion] = useState<AppVersion | null>(null);
  const [publishingVersion, setPublishingVersion] = useState<AppVersion | null>(null);

  // ── Form state ──
  const [formPlatform, setFormPlatform] = useState<Platform>('android');
  const [formVersion, setFormVersion] = useState('');
  const [formVersionCode, setFormVersionCode] = useState(0);
  const [formReleaseNotes, setFormReleaseNotes] = useState('');
  const [formReleaseNotesAr, setFormReleaseNotesAr] = useState('');
  const [formReleaseNotesFr, setFormReleaseNotesFr] = useState('');
  const [formIsMandatory, setFormIsMandatory] = useState(false);
  const [formIsPatch, setFormIsPatch] = useState(false);
  const [formDownloadUrl, setFormDownloadUrl] = useState('');
  const [formMinAppVersion, setFormMinAppVersion] = useState('');
  const [formIsPublished, setFormIsPublished] = useState(false);
  const [notesTab, setNotesTab] = useState<'en' | 'ar' | 'fr'>('ar');
  const [saving, setSaving] = useState(false);

  // ── Upload state ──
  const [uploadVersionId, setUploadVersionId] = useState('');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [uploadedHash, setUploadedHash] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Delete state ──
  const [deleteAlertOpen, setDeleteAlertOpen] = useState(false);
  const [deletingVersion, setDeletingVersion] = useState<AppVersion | null>(null);
  const [deleting, setDeleting] = useState(false);

  // ── Fetch data ──
  const fetchVersions = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    try {
      const [versionsRes, latestRes] = await Promise.all([
        apiFetch('/api/app-versions'),
        apiFetch('/api/app-versions/latest'),
      ]);

      if (versionsRes.ok) {
        const data = await versionsRes.json();
        if (data.success) {
          setVersions(data.versions || []);
        }
      }

      if (latestRes.ok) {
        const data = await latestRes.json();
        if (data.success) {
          setLatestVersions(data.latest || {});
        }
      }
    } catch {
      toast.error(isRTL ? 'فشل تحميل البيانات' : 'Failed to load data');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [isRTL]);

  useEffect(() => {
    fetchVersions();
  }, [fetchVersions]);

  // ── Computed values ──
  const filteredVersions =
    selectedPlatform === 'all'
      ? versions
      : versions.filter((v) => v.platform === selectedPlatform);

  const platformCounts = PLATFORMS.reduce(
    (acc, p) => {
      acc[p.key] = versions.filter((v) => v.platform === p.key).length;
      return acc;
    },
    {} as Record<string, number>
  );

  // ── Reset form ──
  const resetForm = useCallback(() => {
    setFormPlatform('android');
    setFormVersion('');
    setFormVersionCode(0);
    setFormReleaseNotes('');
    setFormReleaseNotesAr('');
    setFormReleaseNotesFr('');
    setFormIsMandatory(false);
    setFormIsPatch(false);
    setFormDownloadUrl('');
    setFormMinAppVersion('');
    setFormIsPublished(false);
    setNotesTab('ar');
  }, []);

  // ── Open Add Dialog ──
  const openAddDialog = useCallback(() => {
    resetForm();
    setAddDialogOpen(true);
  }, [resetForm]);

  // ── Open Edit Dialog ──
  const openEditDialog = useCallback((v: AppVersion) => {
    setEditingVersion(v);
    setFormPlatform(v.platform as Platform);
    setFormVersion(v.version);
    setFormVersionCode(v.versionCode);
    setFormReleaseNotes(v.releaseNotes);
    setFormReleaseNotesAr(v.releaseNotesAr || '');
    setFormReleaseNotesFr(v.releaseNotesFr || '');
    setFormIsMandatory(v.isMandatory);
    setFormIsPatch(v.isPatch);
    setFormDownloadUrl(v.downloadUrl);
    setFormMinAppVersion(v.minAppVersion || '');
    setFormIsPublished(v.isPublished);
    setNotesTab('ar');
    setEditDialogOpen(true);
  }, []);

  // ── Create version ──
  const handleCreate = useCallback(async () => {
    if (!SEMVER_REGEX.test(formVersion)) {
      toast.error(isRTL ? 'رقم الإصدار غير صالح (مثال: 1.2.3)' : 'Invalid version number (e.g. 1.2.3)');
      return;
    }
    setSaving(true);
    try {
      const res = await apiFetch('/api/app-versions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform: formPlatform,
          version: formVersion,
          versionCode: formVersionCode,
          releaseNotes: formReleaseNotes,
          releaseNotesAr: formReleaseNotesAr || undefined,
          releaseNotesFr: formReleaseNotesFr || undefined,
          isMandatory: formIsMandatory,
          isPublished: formIsPublished,
          isPatch: formIsPatch,
          downloadUrl: formDownloadUrl,
          minAppVersion: formMinAppVersion || undefined,
        }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        toast.success(isRTL ? 'تم إنشاء الإصدار بنجاح' : 'Version created successfully');
        setAddDialogOpen(false);
        resetForm();
        fetchVersions();
      } else {
        toast.error(data.error || (isRTL ? 'فشل إنشاء الإصدار' : 'Failed to create version'));
      }
    } catch {
      toast.error(isRTL ? 'خطأ في الاتصال' : 'Connection error');
    } finally {
      setSaving(false);
    }
  }, [formPlatform, formVersion, formVersionCode, formReleaseNotes, formReleaseNotesAr, formReleaseNotesFr, formIsMandatory, formIsPublished, formIsPatch, formDownloadUrl, formMinAppVersion, isRTL, resetForm, fetchVersions]);

  // ── Update version ──
  const handleUpdate = useCallback(async () => {
    if (!editingVersion) return;
    if (formVersion && !SEMVER_REGEX.test(formVersion)) {
      toast.error(isRTL ? 'رقم الإصدار غير صالح' : 'Invalid version number');
      return;
    }
    setSaving(true);
    try {
      const res = await apiFetch(`/api/app-versions/${editingVersion.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: formVersion || undefined,
          versionCode: formVersionCode,
          releaseNotes: formReleaseNotes,
          releaseNotesAr: formReleaseNotesAr || null,
          releaseNotesFr: formReleaseNotesFr || null,
          isMandatory: formIsMandatory,
          isPublished: formIsPublished,
          isPatch: formIsPatch,
          downloadUrl: formDownloadUrl,
          minAppVersion: formMinAppVersion || null,
        }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        toast.success(isRTL ? 'تم تحديث الإصدار بنجاح' : 'Version updated successfully');
        setEditDialogOpen(false);
        setEditingVersion(null);
        fetchVersions();
      } else {
        toast.error(data.error || (isRTL ? 'فشل التحديث' : 'Update failed'));
      }
    } catch {
      toast.error(isRTL ? 'خطأ في الاتصال' : 'Connection error');
    } finally {
      setSaving(false);
    }
  }, [editingVersion, formVersion, formVersionCode, formReleaseNotes, formReleaseNotesAr, formReleaseNotesFr, formIsMandatory, formIsPublished, formIsPatch, formDownloadUrl, formMinAppVersion, isRTL, fetchVersions]);

  // ── Publish / Unpublish ──
  const handlePublishToggle = useCallback(
    async (v: AppVersion) => {
      const newPublished = !v.isPublished;
      try {
        const res = await apiFetch(`/api/app-versions/${v.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isPublished: newPublished }),
        });
        const data = await res.json();
        if (res.ok && data.success) {
          toast.success(
            newPublished
              ? isRTL
                ? 'تم نشر الإصدار'
                : 'Version published'
              : isRTL
                ? 'تم إلغاء نشر الإصدار'
                : 'Version unpublished'
          );
          fetchVersions();
        } else {
          toast.error(data.error || (isRTL ? 'فشلت العملية' : 'Operation failed'));
        }
      } catch {
        toast.error(isRTL ? 'خطأ في الاتصال' : 'Connection error');
      } finally {
        setPublishAlertOpen(false);
        setPublishingVersion(null);
      }
    },
    [isRTL, fetchVersions]
  );

  // ── Delete version ──
  const handleDelete = useCallback(async () => {
    if (!deletingVersion) return;
    setDeleting(true);
    try {
      const res = await apiFetch(`/api/app-versions/${deletingVersion.id}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        toast.success(isRTL ? 'تم حذف الإصدار' : 'Version deleted');
        fetchVersions();
      } else {
        const data = await res.json();
        toast.error(data.error || (isRTL ? 'فشل الحذف' : 'Delete failed'));
      }
    } catch {
      toast.error(isRTL ? 'خطأ في الاتصال' : 'Connection error');
    } finally {
      setDeleting(false);
      setDeleteAlertOpen(false);
      setDeletingVersion(null);
    }
  }, [deletingVersion, isRTL, fetchVersions]);

  // ── Upload binary ──
  const handleUpload = useCallback(async () => {
    if (!uploadFile || !uploadVersionId) {
      toast.error(isRTL ? 'اختر ملفًا وإصدارًا' : 'Select a file and version');
      return;
    }
    setUploading(true);
    setUploadProgress(0);
    setUploadedHash('');
    try {
      const selectedVersion = versions.find((v) => v.id === uploadVersionId);
      if (!selectedVersion) {
        toast.error(isRTL ? 'الإصدار غير موجود' : 'Version not found');
        setUploading(false);
        return;
      }

      const formData = new FormData();
      formData.append('file', uploadFile);
      formData.append('platform', selectedVersion.platform);
      formData.append('version', selectedVersion.version);

      // Simulate progress for UX
      const progressInterval = setInterval(() => {
        setUploadProgress((prev) => {
          if (prev >= 90) {
            clearInterval(progressInterval);
            return 90;
          }
          return prev + 10;
        });
      }, 300);

      const res = await apiFetch('/api/app-versions/upload', {
        method: 'POST',
        body: formData,
      });

      clearInterval(progressInterval);
      setUploadProgress(100);

      const data = await res.json();
      if (res.ok && data.success) {
        toast.success(isRTL ? 'تم رفع الملف بنجاح' : 'File uploaded successfully');
        setUploadedHash(data.fileInfo?.hash || '');
        fetchVersions();
      } else {
        toast.error(data.error || (isRTL ? 'فشل رفع الملف' : 'Upload failed'));
      }
    } catch {
      toast.error(isRTL ? 'خطأ في الاتصال' : 'Connection error');
    } finally {
      setUploading(false);
    }
  }, [uploadFile, uploadVersionId, versions, isRTL, fetchVersions]);

  // ── Force update (mark latest as mandatory) ──
  const handleForceUpdate = useCallback(
    async (platform: Platform) => {
      const latest = latestVersions[platform];
      if (!latest) {
        toast.error(isRTL ? 'لا يوجد إصدار منشور لهذه المنصة' : 'No published version for this platform');
        return;
      }
      try {
        const res = await apiFetch(`/api/app-versions/${latest.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isMandatory: true }),
        });
        const data = await res.json();
        if (res.ok && data.success) {
          toast.success(
            isRTL
              ? `تم تعيين إصدار ${platform} كتحديث إلزامي`
              : `${platform} version set as mandatory update`
          );
          fetchVersions();
        } else {
          toast.error(data.error || (isRTL ? 'فشلت العملية' : 'Operation failed'));
        }
      } catch {
        toast.error(isRTL ? 'خطأ في الاتصال' : 'Connection error');
      }
    },
    [latestVersions, isRTL, fetchVersions]
  );

  // ── Download binary ──
  const handleDownload = useCallback((v: AppVersion) => {
    if (v.downloadUrl) {
      window.open(v.downloadUrl, '_blank');
    } else {
      toast.error(isRTL ? 'لا يوجد رابط تحميل' : 'No download URL available');
    }
  }, [isRTL]);

  // ── Platform icon getter ──
  const getPlatformIcon = useCallback((platform: string, className?: string) => {
    const cn = className || 'h-5 w-5';
    switch (platform) {
      case 'android':
        return <Smartphone className={cn} />;
      case 'ios':
        return <Apple className={cn} />;
      case 'electron':
        return <Monitor className={cn} />;
      case 'windows':
        return <Monitor className={cn} />;
      case 'mac':
        return <Laptop className={cn} />;
      case 'linux':
        return <Globe className={cn} />;
      default:
        return <Package className={cn} />;
    }
  }, []);

  const getPlatformName = useCallback(
    (platform: string) => {
      const p = PLATFORMS.find((pl) => pl.key === platform);
      return p ? (isRTL ? p.labelAr : p.labelEn) : platform;
    },
    [isRTL]
  );

  // ─── Loading skeleton ──────────────────────────────────────────────
  if (loading) {
    return (
      <div className="p-4 lg:p-6 space-y-5">
        <Skeleton className="h-28 w-full rounded-2xl" />
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-32 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-10 w-64 rounded-lg" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );
  }

  // ── Render ──
  return (
    <div className="p-4 lg:p-6 space-y-5">
      {/* ─── 1. Header Banner ─── */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="relative rounded-2xl overflow-hidden mb-2"
      >
        <div
          className="p-5 md:p-6 text-white"
          style={{
            background: 'linear-gradient(135deg, #d97706 0%, #ea580c 40%, #f59e0b 70%, #d97706 100%)',
            backgroundSize: '200% 200%',
            animation: 'gradient-flow-bar 6s ease-in-out infinite',
          }}
        >
          <div className="absolute inset-0 overflow-hidden">
            <div className="absolute -top-10 -end-10 w-40 h-40 rounded-full bg-white/10" />
            <div className="absolute -bottom-8 -start-8 w-32 h-32 rounded-full bg-white/5" />
          </div>
          <div className="relative flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-white flex items-center gap-3">
                <div className="h-10 w-10 rounded-xl bg-white/20 backdrop-blur-sm flex items-center justify-center">
                  <Package className="h-5 w-5 text-white" />
                </div>
                {isRTL ? 'إعدادات التطبيقات العامة' : 'Public Apps Settings'}
              </h1>
              <p className="text-sm text-amber-100 mt-1 ms-[52px]">
                {isRTL
                  ? 'إدارة إصدارات تطبيقات الهاتف وسطح المكتب'
                  : 'Manage phone & desktop app versions, publish updates'}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                className="text-white hover:bg-white/20 h-9 w-9"
                onClick={() => fetchVersions(true)}
                disabled={refreshing}
              >
                <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
              </Button>
              <Badge className="bg-white/20 text-white border-white/30 backdrop-blur-sm text-xs px-3 py-1 hidden sm:flex">
                <Shield className="h-3 w-3 me-1" />
                {t('superAdmin')}
              </Badge>
            </div>
          </div>
        </div>
      </motion.div>

      {/* ─── 2. Platform Overview Cards ─── */}
      <motion.div
        variants={staggerContainer}
        initial="initial"
        animate="animate"
        className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3"
      >
        {PLATFORMS.map((p) => {
          const latest = latestVersions[p.key];
          const count = platformCounts[p.key] || 0;
          const hasPublished = !!latest;
          const Icon = p.icon;

          return (
            <motion.div key={p.key} variants={staggerItem}>
              <Card
                className="border-0 shadow-sm bg-white dark:bg-gray-900/80 hover:shadow-md transition-shadow cursor-pointer rounded-xl overflow-hidden"
                onClick={() => setSelectedPlatform(p.key)}
              >
                <CardContent className="p-4 text-center space-y-2">
                  <div
                    className={`mx-auto h-10 w-10 rounded-xl flex items-center justify-center shadow-sm ${
                      hasPublished
                        ? 'bg-gradient-to-br from-amber-200 to-orange-300 dark:from-amber-900/40 dark:to-orange-800/40'
                        : 'bg-gradient-to-br from-gray-200 to-gray-300 dark:from-gray-800/40 dark:to-gray-700/40'
                    }`}
                  >
                    <Icon
                      className={`h-5 w-5 ${
                        hasPublished
                          ? 'text-amber-700 dark:text-amber-400'
                          : 'text-gray-500 dark:text-gray-400'
                      }`}
                    />
                  </div>
                  <p className="text-sm font-semibold">{isRTL ? p.labelAr : p.labelEn}</p>
                  {hasPublished ? (
                    <p className="text-xs text-amber-600 dark:text-amber-400 font-mono">
                      v{latest.version}
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      {isRTL ? 'لا إصدار' : 'No version'}
                    </p>
                  )}
                  <div className="flex items-center justify-center gap-1">
                    <span className="text-[10px] text-muted-foreground">
                      {count} {isRTL ? 'إصدار' : 'ver.'}
                    </span>
                    <span
                      className={`inline-block h-2 w-2 rounded-full ${
                        hasPublished ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'
                      }`}
                    />
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          );
        })}
      </motion.div>

      {/* ─── 3. Version Management Table ─── */}
      <motion.div {...fadeUp} transition={{ delay: 0.15 }}>
        <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 rounded-xl">
          <CardHeader className="pb-3">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
              <CardTitle className="text-base flex items-center gap-2">
                <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-amber-200 to-orange-300 dark:from-amber-900/40 dark:to-orange-800/40 flex items-center justify-center shadow-sm">
                  <Package className="h-4 w-4 text-amber-700 dark:text-amber-400" />
                </div>
                {isRTL ? 'إدارة الإصدارات' : 'Version Management'}
              </CardTitle>
              <div className="flex items-center gap-2 w-full sm:w-auto">
                <Tabs
                  value={selectedPlatform}
                  onValueChange={setSelectedPlatform}
                  className="w-full sm:w-auto"
                >
                  <TabsList className="h-8 flex-wrap">
                    <TabsTrigger value="all" className="text-xs h-6 px-2">
                      {isRTL ? 'الكل' : 'All'}
                    </TabsTrigger>
                    {PLATFORMS.map((p) => (
                      <TabsTrigger key={p.key} value={p.key} className="text-xs h-6 px-2">
                        {isRTL ? p.labelAr : p.labelEn}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>
                <Button
                  size="sm"
                  className="bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white shadow-sm h-8 px-3 shrink-0"
                  onClick={openAddDialog}
                >
                  <Plus className="h-3.5 w-3.5 me-1" />
                  {isRTL ? 'إصدار جديد' : 'New Version'}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 px-3 shrink-0 border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/20"
                  onClick={() => {
                    setUploadVersionId('');
                    setUploadFile(null);
                    setUploadProgress(0);
                    setUploadedHash('');
                    setUploadDialogOpen(true);
                  }}
                >
                  <Upload className="h-3.5 w-3.5 me-1" />
                  {isRTL ? 'رفع ملف' : 'Upload'}
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            {filteredVersions.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <Package className="h-12 w-12 mx-auto mb-3 opacity-30" />
                <p className="text-sm">
                  {isRTL ? 'لا توجد إصدارات' : 'No versions found'}
                </p>
              </div>
            ) : (
              <div className="max-h-[500px] overflow-y-auto custom-scrollbar">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs">{isRTL ? 'المنصة' : 'Platform'}</TableHead>
                      <TableHead className="text-xs">{isRTL ? 'الإصدار' : 'Version'}</TableHead>
                      <TableHead className="text-xs hidden md:table-cell">
                        {isRTL ? 'رمز الإصدار' : 'Code'}
                      </TableHead>
                      <TableHead className="text-xs hidden sm:table-cell">
                        {isRTL ? 'النوع' : 'Type'}
                      </TableHead>
                      <TableHead className="text-xs">{isRTL ? 'إلزامي' : 'Mandatory'}</TableHead>
                      <TableHead className="text-xs">{isRTL ? 'منشور' : 'Published'}</TableHead>
                      <TableHead className="text-xs hidden lg:table-cell">
                        {isRTL ? 'التنزيلات' : 'Downloads'}
                      </TableHead>
                      <TableHead className="text-xs hidden md:table-cell">
                        {isRTL ? 'التاريخ' : 'Date'}
                      </TableHead>
                      <TableHead className="text-xs text-end">
                        {isRTL ? 'الإجراءات' : 'Actions'}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredVersions.map((v) => {
                      const rowBg = v.isMandatory
                        ? 'bg-amber-50/60 dark:bg-amber-900/10'
                        : v.isPublished
                          ? 'bg-green-50/40 dark:bg-green-900/10'
                          : 'bg-gray-50/40 dark:bg-gray-900/10';

                      return (
                        <TableRow key={v.id} className={`${rowBg} hover:bg-muted/50`}>
                          <TableCell>
                            <div className="flex items-center gap-1.5">
                              {getPlatformIcon(v.platform, 'h-4 w-4')}
                              <span className="text-xs font-medium">
                                {getPlatformName(v.platform)}
                              </span>
                            </div>
                          </TableCell>
                          <TableCell>
                            <span className="font-mono text-sm font-semibold">{v.version}</span>
                          </TableCell>
                          <TableCell className="hidden md:table-cell">
                            <span className="text-xs text-muted-foreground">{v.versionCode}</span>
                          </TableCell>
                          <TableCell className="hidden sm:table-cell">
                            {v.isPatch ? (
                              <Badge className="bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400 text-[10px] px-1.5 py-0">
                                {isRTL ? 'تصحيح' : 'Patch'}
                              </Badge>
                            ) : (
                              <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 text-[10px] px-1.5 py-0">
                                {isRTL ? 'كامل' : 'Full'}
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell>
                            {v.isMandatory ? (
                              <CheckCircle2 className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                            ) : (
                              <XCircle className="h-4 w-4 text-gray-300 dark:text-gray-600" />
                            )}
                          </TableCell>
                          <TableCell>
                            {v.isPublished ? (
                              <Badge className="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 text-[10px] px-1.5 py-0">
                                <CheckCircle2 className="h-3 w-3 me-0.5" />
                                {isRTL ? 'منشور' : 'Yes'}
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-muted-foreground">
                                {isRTL ? 'مسودة' : 'Draft'}
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell className="hidden lg:table-cell">
                            <span className="text-xs text-muted-foreground">{v.downloadCount}</span>
                          </TableCell>
                          <TableCell className="hidden md:table-cell">
                            <span className="text-xs text-muted-foreground">
                              {formatDate(v.createdAt)}
                            </span>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center justify-end gap-1">
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 text-muted-foreground hover:text-foreground"
                                onClick={() => openEditDialog(v)}
                                title={isRTL ? 'تعديل' : 'Edit'}
                              >
                                <Edit3 className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className={`h-7 w-7 ${
                                  v.isPublished
                                    ? 'text-orange-500 hover:text-orange-600'
                                    : 'text-green-500 hover:text-green-600'
                                }`}
                                onClick={() => {
                                  setPublishingVersion(v);
                                  setPublishAlertOpen(true);
                                }}
                                title={
                                  v.isPublished
                                    ? isRTL
                                      ? 'إلغاء النشر'
                                      : 'Unpublish'
                                    : isRTL
                                      ? 'نشر'
                                      : 'Publish'
                                }
                              >
                                {v.isPublished ? (
                                  <XCircle className="h-3.5 w-3.5" />
                                ) : (
                                  <Rocket className="h-3.5 w-3.5" />
                                )}
                              </Button>
                              {v.downloadUrl && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 text-muted-foreground hover:text-foreground"
                                  onClick={() => handleDownload(v)}
                                  title={isRTL ? 'تحميل' : 'Download'}
                                >
                                  <Download className="h-3.5 w-3.5" />
                                </Button>
                              )}
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 text-red-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
                                onClick={() => {
                                  setDeletingVersion(v);
                                  setDeleteAlertOpen(true);
                                }}
                                title={isRTL ? 'حذف' : 'Delete'}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </motion.div>

      {/* ─── 8. Update Sender Section ─── */}
      <motion.div {...fadeUp} transition={{ delay: 0.2 }}>
        <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 rounded-xl">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-amber-200 to-orange-300 dark:from-amber-900/40 dark:to-orange-800/40 flex items-center justify-center shadow-sm">
                <Send className="h-4 w-4 text-amber-700 dark:text-amber-400" />
              </div>
              {isRTL ? 'مرسل التحديثات' : 'Update Sender'}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {PLATFORMS.map((p) => {
                const latest = latestVersions[p.key];
                const mandatoryVersions = versions.filter(
                  (v) => v.platform === p.key && v.isMandatory && v.isPublished
                );
                const totalDownloads = versions
                  .filter((v) => v.platform === p.key)
                  .reduce((sum, v) => sum + v.downloadCount, 0);

                return (
                  <div
                    key={p.key}
                    className="rounded-xl border border-border/50 p-4 space-y-3 bg-gradient-to-br from-amber-50/30 to-orange-50/30 dark:from-amber-900/10 dark:to-orange-900/10"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        {getPlatformIcon(p.key, 'h-5 w-5 text-amber-600 dark:text-amber-400')}
                        <span className="text-sm font-semibold">
                          {isRTL ? p.labelAr : p.labelEn}
                        </span>
                      </div>
                      {latest?.isMandatory && (
                        <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 text-[10px] px-1.5 py-0">
                          <AlertTriangle className="h-3 w-3 me-0.5" />
                          {isRTL ? 'إلزامي' : 'Mandatory'}
                        </Badge>
                      )}
                    </div>

                    {latest ? (
                      <>
                        <div className="space-y-1">
                          <div className="flex justify-between text-xs text-muted-foreground">
                            <span>{isRTL ? 'أحدث إصدار' : 'Latest version'}</span>
                            <span className="font-mono font-semibold text-foreground">
                              v{latest.version}
                            </span>
                          </div>
                          <div className="flex justify-between text-xs text-muted-foreground">
                            <span>{isRTL ? 'تحديثات إلزامية' : 'Mandatory updates'}</span>
                            <span className="font-semibold text-amber-600 dark:text-amber-400">
                              {mandatoryVersions.length}
                            </span>
                          </div>
                          <div className="flex justify-between text-xs text-muted-foreground">
                            <span>{isRTL ? 'إجمالي التنزيلات' : 'Total downloads'}</span>
                            <span className="font-semibold">{totalDownloads}</span>
                          </div>
                        </div>
                        <Button
                          size="sm"
                          className="w-full bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white h-8 text-xs"
                          onClick={() => handleForceUpdate(p.key)}
                          disabled={latest.isMandatory}
                        >
                          <Shield className="h-3.5 w-3.5 me-1" />
                          {latest.isMandatory
                            ? isRTL
                              ? 'إلزامي بالفعل'
                              : 'Already Mandatory'
                            : isRTL
                              ? 'فرض التحديث'
                              : 'Force Update'}
                        </Button>
                        <p className="text-[10px] text-muted-foreground text-center">
                          {isRTL
                            ? `${totalDownloads} جهاز سيتلقى التحديث`
                            : `${totalDownloads} devices would receive update`}
                        </p>
                      </>
                    ) : (
                      <div className="text-center py-3">
                        <p className="text-xs text-muted-foreground">
                          {isRTL ? 'لا يوجد إصدار منشور' : 'No published version'}
                        </p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      </motion.div>

      {/* ─── 4. Add New Version Dialog ─── */}
      <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
        <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Plus className="h-5 w-5 text-amber-500" />
              {isRTL ? 'إضافة إصدار جديد' : 'Add New Version'}
            </DialogTitle>
            <DialogDescription>
              {isRTL
                ? 'أنشئ إصدارًا جديدًا من التطبيق لمنصة معينة'
                : 'Create a new app version for a specific platform'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {/* Platform */}
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">
                {isRTL ? 'المنصة' : 'Platform'} *
              </Label>
              <Select value={formPlatform} onValueChange={(v) => setFormPlatform(v as Platform)}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PLATFORMS.map((p) => (
                    <SelectItem key={p.key} value={p.key}>
                      <div className="flex items-center gap-2">
                        {getPlatformIcon(p.key, 'h-4 w-4')}
                        {isRTL ? p.labelAr : p.labelEn}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Version + Version Code */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">
                  {isRTL ? 'رقم الإصدار' : 'Version'} *
                </Label>
                <Input
                  placeholder="1.2.3"
                  value={formVersion}
                  onChange={(e) => setFormVersion(e.target.value)}
                  className="h-9 font-mono"
                />
                {!SEMVER_REGEX.test(formVersion) && formVersion && (
                  <p className="text-[10px] text-red-500">
                    {isRTL ? 'صيغة غير صالحة (مثال: 1.2.3)' : 'Invalid format (e.g. 1.2.3)'}
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">
                  {isRTL ? 'رمز الإصدار' : 'Version Code'}
                </Label>
                <Input
                  type="number"
                  min={0}
                  value={formVersionCode}
                  onChange={(e) => setFormVersionCode(Number(e.target.value))}
                  className="h-9"
                />
              </div>
            </div>

            {/* Release Notes with tabs */}
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">
                {isRTL ? 'ملاحظات الإصدار' : 'Release Notes'}
              </Label>
              <Tabs value={notesTab} onValueChange={(v) => setNotesTab(v as 'en' | 'ar' | 'fr')}>
                <TabsList className="h-7 mb-1">
                  <TabsTrigger value="ar" className="text-[10px] h-5 px-2">
                    العربية
                  </TabsTrigger>
                  <TabsTrigger value="en" className="text-[10px] h-5 px-2">
                    English
                  </TabsTrigger>
                  <TabsTrigger value="fr" className="text-[10px] h-5 px-2">
                    Français
                  </TabsTrigger>
                </TabsList>
                {notesTab === 'ar' && (
                  <Textarea
                    placeholder="ملاحظات الإصدار بالعربية..."
                    value={formReleaseNotesAr}
                    onChange={(e) => setFormReleaseNotesAr(e.target.value)}
                    rows={3}
                    className="text-sm resize-none"
                    dir="rtl"
                  />
                )}
                {notesTab === 'en' && (
                  <Textarea
                    placeholder="Release notes in English..."
                    value={formReleaseNotes}
                    onChange={(e) => setFormReleaseNotes(e.target.value)}
                    rows={3}
                    className="text-sm resize-none"
                    dir="ltr"
                  />
                )}
                {notesTab === 'fr' && (
                  <Textarea
                    placeholder="Notes de version en français..."
                    value={formReleaseNotesFr}
                    onChange={(e) => setFormReleaseNotesFr(e.target.value)}
                    rows={3}
                    className="text-sm resize-none"
                    dir="ltr"
                  />
                )}
              </Tabs>
            </div>

            {/* Toggles */}
            <div className="grid grid-cols-2 gap-4">
              <div className="flex items-center justify-between gap-2">
                <Label className="text-xs font-medium">
                  {isRTL ? 'إلزامي' : 'Mandatory'}
                </Label>
                <Switch checked={formIsMandatory} onCheckedChange={setFormIsMandatory} />
              </div>
              <div className="flex items-center justify-between gap-2">
                <Label className="text-xs font-medium">
                  {isRTL ? 'تصحيح' : 'Patch'}
                </Label>
                <Switch checked={formIsPatch} onCheckedChange={setFormIsPatch} />
              </div>
            </div>

            {/* Download URL */}
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">
                {isRTL ? 'رابط التحميل (اختياري)' : 'Download URL (optional)'}
              </Label>
              <Input
                placeholder="https://..."
                value={formDownloadUrl}
                onChange={(e) => setFormDownloadUrl(e.target.value)}
                className="h-9"
                dir="ltr"
              />
            </div>

            {/* Min App Version */}
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">
                {isRTL ? 'الحد الأدنى لإصدار التطبيق (تحديثات دلتا)' : 'Min App Version (delta updates)'}
              </Label>
              <Input
                placeholder="1.0.0"
                value={formMinAppVersion}
                onChange={(e) => setFormMinAppVersion(e.target.value)}
                className="h-9 font-mono"
                dir="ltr"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddDialogOpen(false)} className="h-9">
              {isRTL ? 'إلغاء' : 'Cancel'}
            </Button>
            <Button
              onClick={handleCreate}
              disabled={saving || !formVersion || !SEMVER_REGEX.test(formVersion)}
              className="bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white h-9"
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin me-1" />
              ) : (
                <Plus className="h-4 w-4 me-1" />
              )}
              {isRTL ? 'إنشاء' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── 6. Edit Version Dialog ─── */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Edit3 className="h-5 w-5 text-amber-500" />
              {isRTL ? 'تعديل الإصدار' : 'Edit Version'}
            </DialogTitle>
            <DialogDescription>
              {editingVersion &&
                `${getPlatformName(editingVersion.platform)} v${editingVersion.version}`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {/* Platform (read-only) */}
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">{isRTL ? 'المنصة' : 'Platform'}</Label>
              <div className="flex items-center gap-2 h-9 px-3 rounded-md border bg-muted/50">
                {getPlatformIcon(formPlatform, 'h-4 w-4')}
                <span className="text-sm">{getPlatformName(formPlatform)}</span>
              </div>
            </div>

            {/* Version + Version Code */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">{isRTL ? 'رقم الإصدار' : 'Version'}</Label>
                <Input
                  value={formVersion}
                  onChange={(e) => setFormVersion(e.target.value)}
                  className="h-9 font-mono"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">
                  {isRTL ? 'رمز الإصدار' : 'Version Code'}
                </Label>
                <Input
                  type="number"
                  min={0}
                  value={formVersionCode}
                  onChange={(e) => setFormVersionCode(Number(e.target.value))}
                  className="h-9"
                />
              </div>
            </div>

            {/* Release Notes with tabs */}
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">
                {isRTL ? 'ملاحظات الإصدار' : 'Release Notes'}
              </Label>
              <Tabs value={notesTab} onValueChange={(v) => setNotesTab(v as 'en' | 'ar' | 'fr')}>
                <TabsList className="h-7 mb-1">
                  <TabsTrigger value="ar" className="text-[10px] h-5 px-2">
                    العربية
                  </TabsTrigger>
                  <TabsTrigger value="en" className="text-[10px] h-5 px-2">
                    English
                  </TabsTrigger>
                  <TabsTrigger value="fr" className="text-[10px] h-5 px-2">
                    Français
                  </TabsTrigger>
                </TabsList>
                {notesTab === 'ar' && (
                  <Textarea
                    value={formReleaseNotesAr}
                    onChange={(e) => setFormReleaseNotesAr(e.target.value)}
                    rows={3}
                    className="text-sm resize-none"
                    dir="rtl"
                  />
                )}
                {notesTab === 'en' && (
                  <Textarea
                    value={formReleaseNotes}
                    onChange={(e) => setFormReleaseNotes(e.target.value)}
                    rows={3}
                    className="text-sm resize-none"
                    dir="ltr"
                  />
                )}
                {notesTab === 'fr' && (
                  <Textarea
                    value={formReleaseNotesFr}
                    onChange={(e) => setFormReleaseNotesFr(e.target.value)}
                    rows={3}
                    className="text-sm resize-none"
                    dir="ltr"
                  />
                )}
              </Tabs>
            </div>

            {/* Toggles */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label className="text-xs font-medium">
                  {isRTL ? 'إلزامي' : 'Mandatory'}
                </Label>
                <Switch checked={formIsMandatory} onCheckedChange={setFormIsMandatory} />
              </div>
              <div className="flex items-center justify-between">
                <Label className="text-xs font-medium">{isRTL ? 'تصحيح' : 'Patch'}</Label>
                <Switch checked={formIsPatch} onCheckedChange={setFormIsPatch} />
              </div>
              <Separator />
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label className="text-xs font-medium">
                    {isRTL ? 'منشور' : 'Published'}
                  </Label>
                  <p className="text-[10px] text-muted-foreground">
                    {formIsPublished
                      ? isRTL
                        ? 'الإصدار متاح للتحميل'
                        : 'Version available for download'
                      : isRTL
                        ? 'الإصدار في وضع المسودة'
                        : 'Version is in draft mode'}
                  </p>
                </div>
                <Switch checked={formIsPublished} onCheckedChange={setFormIsPublished} />
              </div>
            </div>

            {/* Download URL */}
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">
                {isRTL ? 'رابط التحميل' : 'Download URL'}
              </Label>
              <Input
                value={formDownloadUrl}
                onChange={(e) => setFormDownloadUrl(e.target.value)}
                className="h-9"
                dir="ltr"
              />
            </div>

            {/* Min App Version */}
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">
                {isRTL ? 'الحد الأدنى لإصدار التطبيق' : 'Min App Version'}
              </Label>
              <Input
                value={formMinAppVersion}
                onChange={(e) => setFormMinAppVersion(e.target.value)}
                className="h-9 font-mono"
                dir="ltr"
              />
            </div>

            {/* File info (if exists) */}
            {editingVersion?.fileName && (
              <>
                <Separator />
                <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">
                    {isRTL ? 'معلومات الملف' : 'File Info'}
                  </p>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <span className="text-muted-foreground">{isRTL ? 'الاسم:' : 'Name:'}</span>{' '}
                      {editingVersion.fileName}
                    </div>
                    <div>
                      <span className="text-muted-foreground">{isRTL ? 'الحجم:' : 'Size:'}</span>{' '}
                      {formatFileSize(editingVersion.fileSize)}
                    </div>
                    {editingVersion.fileHash && (
                      <div className="col-span-2">
                        <span className="text-muted-foreground">
                          {isRTL ? 'التوقيع:' : 'Hash:'}
                        </span>{' '}
                        <span className="font-mono text-[10px] break-all">
                          {editingVersion.fileHash}
                        </span>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Download className="h-3 w-3" />
                    {isRTL ? 'التنزيلات:' : 'Downloads:'} {editingVersion.downloadCount}
                  </div>
                </div>
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditDialogOpen(false)} className="h-9">
              {isRTL ? 'إلغاء' : 'Cancel'}
            </Button>
            <Button
              onClick={handleUpdate}
              disabled={saving}
              className="bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white h-9"
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin me-1" />
              ) : (
                <CheckCircle2 className="h-4 w-4 me-1" />
              )}
              {isRTL ? 'حفظ' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── 5. Upload Binary Dialog ─── */}
      <Dialog open={uploadDialogOpen} onOpenChange={setUploadDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Upload className="h-5 w-5 text-amber-500" />
              {isRTL ? 'رفع ملف التطبيق' : 'Upload App Binary'}
            </DialogTitle>
            <DialogDescription>
              {isRTL
                ? 'ارفع ملف التطبيق الثنائي لإصدار موجود'
                : 'Upload an app binary file for an existing version'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {/* Select version */}
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">
                {isRTL ? 'اختر الإصدار' : 'Select Version'} *
              </Label>
              <Select value={uploadVersionId} onValueChange={setUploadVersionId}>
                <SelectTrigger className="h-9">
                  <SelectValue placeholder={isRTL ? 'اختر إصدارًا...' : 'Select a version...'} />
                </SelectTrigger>
                <SelectContent>
                  {versions.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      <div className="flex items-center gap-2">
                        {getPlatformIcon(v.platform, 'h-3.5 w-3.5')}
                        <span className="font-mono text-xs">{v.version}</span>
                        {!v.fileStorageKey && (
                          <Badge className="bg-amber-100 text-amber-700 text-[8px] px-1 py-0 ms-1">
                            {isRTL ? 'بدون ملف' : 'No file'}
                          </Badge>
                        )}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* File upload area */}
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">
                {isRTL ? 'الملف' : 'File'} *
              </Label>
              <div
                className="border-2 border-dashed border-amber-300 dark:border-amber-700 rounded-xl p-6 text-center cursor-pointer hover:border-amber-500 dark:hover:border-amber-500 transition-colors bg-amber-50/30 dark:bg-amber-900/10"
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const file = e.dataTransfer.files[0];
                  if (file) setUploadFile(file);
                }}
              >
                <Upload className="h-8 w-8 mx-auto text-amber-400 mb-2" />
                <p className="text-sm text-muted-foreground">
                  {uploadFile
                    ? isRTL
                      ? 'اضغط لتغيير الملف'
                      : 'Click to change file'
                    : isRTL
                      ? 'اضغط أو اسحب الملف هنا'
                      : 'Click or drag file here'}
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) setUploadFile(file);
                  }}
                />
              </div>

              {/* File info */}
              {uploadFile && (
                <div className="rounded-lg border bg-muted/30 p-3 space-y-1 text-xs">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{isRTL ? 'الاسم:' : 'Name:'}</span>
                    <span className="font-medium break-all ms-2">{uploadFile.name}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{isRTL ? 'الحجم:' : 'Size:'}</span>
                    <span className="font-medium">{formatFileSize(uploadFile.size)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{isRTL ? 'النوع:' : 'Type:'}</span>
                    <span className="font-medium">{uploadFile.type || '—'}</span>
                  </div>
                </div>
              )}
            </div>

            {/* Upload progress */}
            {uploading && (
              <div className="space-y-2">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>{isRTL ? 'جارٍ الرفع...' : 'Uploading...'}</span>
                  <span>{uploadProgress}%</span>
                </div>
                <Progress value={uploadProgress} className="h-2" />
              </div>
            )}

            {/* Uploaded hash */}
            {uploadedHash && !uploading && (
              <div className="rounded-lg border bg-green-50 dark:bg-green-900/20 p-3 space-y-1">
                <div className="flex items-center gap-1.5 text-xs font-medium text-green-700 dark:text-green-400">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  {isRTL ? 'تم الرفع بنجاح' : 'Upload successful'}
                </div>
                <div className="text-[10px] text-muted-foreground">
                  <span className="font-medium">{isRTL ? 'التوقيع:' : 'Hash:'}</span>{' '}
                  <span className="font-mono break-all">{uploadedHash}</span>
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUploadDialogOpen(false)} className="h-9">
              {isRTL ? 'إغلاق' : 'Close'}
            </Button>
            <Button
              onClick={handleUpload}
              disabled={uploading || !uploadFile || !uploadVersionId}
              className="bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white h-9"
            >
              {uploading ? (
                <Loader2 className="h-4 w-4 animate-spin me-1" />
              ) : (
                <Upload className="h-4 w-4 me-1" />
              )}
              {isRTL ? 'رفع' : 'Upload'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── 7. Publish/Unpublish Confirmation ─── */}
      <AlertDialog open={publishAlertOpen} onOpenChange={setPublishAlertOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              {publishingVersion?.isPublished
                ? isRTL
                  ? 'إلغاء نشر الإصدار'
                  : 'Unpublish Version'
                : isRTL
                  ? 'نشر الإصدار'
                  : 'Publish Version'}
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              {publishingVersion && (
                <span className="block">
                  {getPlatformName(publishingVersion.platform)} v{publishingVersion.version}
                </span>
              )}
              {publishingVersion?.isPublished ? (
                <span className="block text-sm">
                  {isRTL
                    ? 'سيتم إلغاء نشر هذا الإصدار ولن يكون متاحًا للتحميل للمستخدمين الجدد.'
                    : 'This version will be unpublished and no longer available for new downloads.'}
                </span>
              ) : (
                <span className="block text-sm text-amber-600 dark:text-amber-400">
                  {isRTL
                    ? '⚠️ النشر سيجعل هذا الإصدار متاحًا للتحميل لجميع المستخدمين'
                    : '⚠️ Publishing will make this version available for download by all users'}
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{isRTL ? 'إلغاء' : 'Cancel'}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white"
              onClick={() => publishingVersion && handlePublishToggle(publishingVersion)}
            >
              {publishingVersion?.isPublished
                ? isRTL
                  ? 'إلغاء النشر'
                  : 'Unpublish'
                : isRTL
                  ? 'نشر'
                  : 'Publish'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ─── Delete Confirmation ─── */}
      <AlertDialog open={deleteAlertOpen} onOpenChange={setDeleteAlertOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-red-600">
              <Trash2 className="h-5 w-5" />
              {isRTL ? 'حذف الإصدار' : 'Delete Version'}
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              {deletingVersion && (
                <span className="block">
                  {getPlatformName(deletingVersion.platform)} v{deletingVersion.version}
                </span>
              )}
              <span className="block text-sm">
                {isRTL
                  ? 'هذا الإجراء لا يمكن التراجع عنه. سيتم حذف الإصدار وملفه نهائيًا.'
                  : 'This action cannot be undone. The version and its file will be permanently deleted.'}
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{isRTL ? 'إلغاء' : 'Cancel'}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700 text-white"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting ? (
                <Loader2 className="h-4 w-4 animate-spin me-1" />
              ) : (
                <Trash2 className="h-4 w-4 me-1" />
              )}
              {isRTL ? 'حذف' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
