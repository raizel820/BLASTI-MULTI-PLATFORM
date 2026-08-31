'use client';
import { apiFetch } from "@/lib/api-fetch";
import { useState, useEffect } from 'react';
import { useAppStore } from '@/store/use-app-store';
import { useLanguage } from '@/hooks/use-language';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { LanguageSwitcher } from '@/components/shared/language-switcher';
import { ThemeToggle } from '@/components/shared/theme-toggle';
import { getProxiedUrl } from '@/lib/utils';
import {
  User,
  Phone,
  MessageSquare,
 CreditCard,
 LogOut,
  Shield,
  Star,
 Check,
  Sun,
  Moon,
  Monitor,
  Palette,
 Bell,
  BellRing,
 CheckCircle2,
  Loader2,
  Trash2,
  AlertTriangle,
  BarChart3,
  Clock,
  Heart,
  CalendarDays,
  KeyRound,
  Smartphone,
  History,
} from 'lucide-react';
import { toast } from 'sonner';
import { motion } from 'framer-motion';
import { useTheme } from 'next-themes';
import type { Language } from '@/i18n';
import { updateDocumentDirection } from '@/store/use-app-store';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';

export function CustomerProfile() {
  const { user, setUser, logout, setView } = useAppStore();
  const { t, lang } = useLanguage();
  const { theme, setTheme } = useTheme();

  const [phoneNumber, setPhoneNumber] = useState(user?.phoneNumber || '');
  const [savingPhone, setSavingPhone] = useState(false);

  // Notification preferences state
  const [notifPrefs, setNotifPrefs] = useState({
    queue_called: true,
    turn_approaching: true,
    completed: true,
  });
  const [notifLoading, setNotifLoading] = useState(false);
  const [notifSaving, setNotifSaving] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  // Change password state
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPasswordVal, setNewPasswordVal] = useState('');
  const [confirmPasswordVal, setConfirmPasswordVal] = useState('');
  const [changePasswordLoading, setChangePasswordLoading] = useState(false);

  // SMS Notification state
  const [reminderMinutesVal, setReminderMinutesVal] = useState(10);
  const [smsNotifEnabled, setSmsNotifEnabled] = useState(true);
  const [purchasedSms, setPurchasedSms] = useState(0);
  const [smsSettingsSaving, setSmsSettingsSaving] = useState(false);

  // SMS Purchase state
  const [smsPurchasing, setSmsPurchasing] = useState(false);
  const [smsPurchasingPackId, setSmsPurchasingPackId] = useState<string | null>(null);

  // Purchase history state
  const [purchaseHistory, setPurchaseHistory] = useState<Array<{ id: string; quantity: number; price: number; createdAt: string }>>([]);
  const [purchaseHistoryLoading, setPurchaseHistoryLoading] = useState(false);
  const [smsStatsData, setSmsStatsData] = useState<{ totalPurchased: number; totalSpent: number }>({ totalPurchased: 0, totalSpent: 0 });

  // Queue stats state
  const [queueStats, setQueueStats] = useState<{
    totalQueues: number;
    thisMonth: number;
    avgWaitTime: number;
    favoriteAgency: { name: string; nameAr?: string; nameFr?: string } | null;
  } | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);

  const handleLanguageChange = (newLang: string) => {
    const langTyped = newLang as Language;
    updateDocumentDirection(langTyped);
    if (user) {
      setUser({ ...user, language: langTyped });
    }
  };

  // Fetch user profile data (notification prefs, phone, SMS count)
  const [smsCount, setSmsCount] = useState(user?.freeSmsCount ?? 10);

  const fetchProfile = async () => {
    if (!user?.id) return;
    setNotifLoading(true);
    try {
      const res = await apiFetch(`/api/user/profile?userId=${user.id}`);
      if (res.ok) {
        const data = await res.json();
        if (data.notificationPreferences) {
          setNotifPrefs(typeof data.notificationPreferences === 'string'
            ? JSON.parse(data.notificationPreferences)
            : data.notificationPreferences);
        }
        if (data.phoneNumber) {
          setPhoneNumber(data.phoneNumber);
        }
        if (data.freeSmsCount !== undefined) {
          setSmsCount(data.freeSmsCount);
        }
        if (data.reminderMinutes !== undefined) {
          setReminderMinutesVal(data.reminderMinutes);
        }
        if (data.smsNotificationsEnabled !== undefined) {
          setSmsNotifEnabled(data.smsNotificationsEnabled);
        }
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setNotifLoading(false);
    }
  };

  useEffect(() => {
    fetchProfile();
    fetchStats();
    fetchPurchaseHistory();
  }, []);

  const fetchStats = async () => {
    if (!user?.id) return;
    setStatsLoading(true);
    try {
      const res = await apiFetch(`/api/user/stats?userId=${user.id}`);
      if (res.ok) {
        const data = await res.json();
        setQueueStats(data);
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setStatsLoading(false);
    }
  };

  const saveNotifPrefs = async () => {
    if (!user?.id) return;
    setNotifSaving(true);
    try {
      const res = await apiFetch('/api/user/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id, preferences: notifPrefs }),
      });
      if (res.ok) {
        toast.success(t('success'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setNotifSaving(false);
    }
  };

  const handleSavePhone = async () => {
    if (!phoneNumber.trim()) return;
    if (!user) return;
    setSavingPhone(true);
    try {
      const res = await apiFetch('/api/user/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id, phoneNumber: phoneNumber.trim() }),
      });
      if (res.ok) {
        toast.success(t('success'));
        // Update local state
        if (user) setUser({ ...user, phoneNumber: phoneNumber.trim() });
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setSavingPhone(false);
    }
  };

  const handleSaveSmsSettings = async () => {
    if (!user?.id) return;
    setSmsSettingsSaving(true);
    try {
      const res = await apiFetch('/api/user/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id, reminderMinutes: reminderMinutesVal, smsNotificationsEnabled: smsNotifEnabled }),
      });
      if (res.ok) {
        toast.success(t('smsSaved'));
      } else {
        toast.error(t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setSmsSettingsSaving(false);
    }
  };

  const handleChangePassword = async () => {
    if (!user?.id) return;
    if (!currentPassword || !newPasswordVal || !confirmPasswordVal) {
      toast.error(t('requiredField'));
      return;
    }
    if (newPasswordVal !== confirmPasswordVal) {
      toast.error(t('passwordMismatch'));
      return;
    }
    if (newPasswordVal.length < 6) {
      toast.error(t('passwordMinLength'));
      return;
    }
    setChangePasswordLoading(true);
    try {
      const res = await apiFetch('/api/user/change-password', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id, currentPassword, newPassword: newPasswordVal }),
      });
      if (res.ok) {
        toast.success(t('passwordChanged'));
        setCurrentPassword('');
        setNewPasswordVal('');
        setConfirmPasswordVal('');
      } else {
        const data = await res.json();
        if (res.status === 401) {
          toast.error(t('wrongCurrentPassword'));
        } else {
          toast.error(data.error || t('error'));
        }
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setChangePasswordLoading(false);
    }
  };

  const handleDeleteAccount = async () => {
    if (!user?.id) return;
    setDeleteLoading(true);
    try {
      const res = await apiFetch('/api/user/delete-account', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id }),
      });
      if (res.ok) {
        toast.success(t('accountDeleted'));
        setDeleteDialogOpen(false);
        logout();
      } else {
        const data = await res.json();
        toast.error(data.error || t('deleteAccountError'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setDeleteLoading(false);
      setDeleteConfirmText('');
    }
  };

  const handlePurchaseSms = async (packId: string) => {
    if (!user?.id) return;
    if (smsPurchasing) {
      toast.error(t('smsAlreadyPurchasing'));
      return;
    }
    setSmsPurchasing(true);
    setSmsPurchasingPackId(packId);
    try {
      const res = await apiFetch('/api/sms/purchase', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packId, userId: user.id }),
      });
      if (res.ok) {
        const data = await res.json();
        toast.success(`${t('smsPurchaseSuccess')} — ${t('newBalance')}: ${data.newBalance}`);
        setPurchasedSms((prev) => prev + parseInt(packId, 10));
        await fetchProfile();
      } else if (res.status === 429) {
        toast.error(t('smsAlreadyPurchasing'));
      } else {
        const data = await res.json();
        toast.error(data.error || t('smsPurchaseFailed'));
      }
    } catch {
      toast.error(t('smsPurchaseFailed'));
    } finally {
      setSmsPurchasing(false);
      setSmsPurchasingPackId(null);
    }
  };

  const smsPacks = [
    { count: 20, price: 200 },
    { count: 50, price: 400 },
    { count: 100, price: 700 },
    { count: 200, price: 1200 },
  ];

  const getInitials = () => {
    if (!user?.fullName) return 'U';
    const parts = user.fullName.trim().split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
    }
    return parts[0].charAt(0).toUpperCase();
  };

  const fetchPurchaseHistory = async () => {
    if (!user?.id) return;
    setPurchaseHistoryLoading(true);
    try {
      const res = await apiFetch(`/api/sms/purchase?userId=${user.id}`);
      if (res.ok) {
        const data = await res.json();
        setPurchaseHistory(data.purchases || []);
        setSmsStatsData({ totalPurchased: data.totalPurchased || 0, totalSpent: data.totalSpent || 0 });
        setPurchasedSms(data.totalPurchased || 0);
      }
    } catch {
      // silent fail
    } finally {
    setPurchaseHistoryLoading(false);
  }
  };

  const smsRemaining = smsCount;
  const totalAvailable = smsCount + purchasedSms;
  const smsMax = Math.max(totalAvailable, 50);
  const smsPercent = Math.min(100, (smsRemaining / smsMax) * 100);
  const totalPercent = totalAvailable > 0 ? Math.min(100, (smsRemaining / totalAvailable) * 100) : 0;

  // Get formatted member since date
  const getMemberSince = () => {
    if (!user?.createdAt) return '';
    const date = new Date(user.createdAt);
    return date.toLocaleDateString(lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  };

  // Notification card data
  const notifCards = [
    {
      key: 'queue_called' as const,
      label: t('queueCalledNotif'),
      icon: BellRing,
      color: 'emerald' as const,
      description: t('queueCalledNotifDesc') || 'Get notified when your turn is called',
    },
    {
      key: 'turn_approaching' as const,
      label: t('turnApproachingNotif'),
      icon: Clock,
      color: 'amber' as const,
      description: t('turnApproachingNotifDesc') || 'Alert when your turn is approaching',
    },
    {
      key: 'completed' as const,
      label: t('completedNotif'),
      icon: CheckCircle2,
      color: 'teal' as const,
      description: t('completedNotifDesc') || 'Notify when service is completed',
    },
  ];

  if (notifLoading) {
    return (
      <div className="px-4 py-4 pb-24">
        <Skeleton className="h-8 w-32 mb-5 animate-pulse" />
        <Skeleton className="h-48 rounded-2xl mb-4 animate-pulse" />
        <Skeleton className="h-64 rounded-2xl mb-4 animate-pulse" />
        <Skeleton className="h-40 rounded-2xl mb-4 animate-pulse" />
        <Skeleton className="h-32 rounded-2xl animate-pulse" />
      </div>
    );
  }

  return (
    <div className="px-4 py-4 pb-24">
      {/* Enhanced Profile Header Card with prominent gradient banner */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: 'easeOut' }}
      >
        <Card className="border-0 shadow-lg mb-6 overflow-hidden">
          {/* Taller gradient banner with user name overlaid */}
          <div className="relative h-44 bg-gradient-to-br from-emerald-500 via-teal-500 to-cyan-600 dark:from-emerald-700 dark:via-teal-700 dark:to-cyan-800">
            {/* Animated decorative circles */}
            <div className="absolute inset-0 overflow-hidden">
              <div className="absolute -top-8 -end-8 w-32 h-32 rounded-full bg-white/10 animate-pulse" />
              <div className="absolute -bottom-12 -start-12 w-40 h-40 rounded-full bg-white/5" />
              <div className="absolute top-4 end-20 w-16 h-16 rounded-full bg-white/5 animate-pulse" style={{ animationDelay: '1s' }} />
              <div className="absolute top-12 start-8 w-20 h-20 rounded-full bg-white/5" />
              <div className="absolute bottom-4 end-12 w-12 h-12 rounded-full bg-white/10 animate-pulse" style={{ animationDelay: '2s' }} />
              {/* Mesh pattern overlay */}
              <div className="absolute inset-0 opacity-10" style={{
                backgroundImage: 'radial-gradient(circle at 25% 25%, white 1px, transparent 1px), radial-gradient(circle at 75% 75%, white 1px, transparent 1px)',
                backgroundSize: '40px 40px'
              }} />
            </div>
            {/* User name overlaid on banner */}
            <div className="absolute bottom-4 start-5 end-5 z-10">
              <motion.h2
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.3, duration: 0.4 }}
                className="text-2xl font-bold text-white drop-shadow-lg truncate"
              >
                {user?.fullName || t('defaultUser')}
              </motion.h2>
              <motion.p
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.4, duration: 0.4 }}
                className="text-sm text-white/80 truncate"
              >
                @{user?.username || 'user'}{phoneNumber ? ` • ${phoneNumber}` : ''}
              </motion.p>
            </div>
          </div>
          <CardContent className="p-5 -mt-10 relative">
            <div className="flex items-end gap-4 mb-5">
              {/* Avatar circle with gradient border ring (emerald → teal) */}
              <motion.div
                initial={{ scale: 0.8, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: 'spring', stiffness: 260, damping: 20, delay: 0.15 }}
                className="relative"
              >
                <div className="p-[3px] rounded-full bg-gradient-to-br from-emerald-400 via-teal-400 to-cyan-500 shadow-xl">
                  <div className="h-[72px] w-[72px] rounded-full bg-gradient-to-br from-emerald-400 via-teal-400 to-emerald-600 flex items-center justify-center text-white text-2xl font-bold ring-[3px] ring-white dark:ring-gray-900 flex-shrink-0 overflow-hidden">
                    {user?.avatarUrl ? (
                      <img src={getProxiedUrl(user.avatarUrl)} alt={user.fullName} width={80} height={80} className="h-full w-full object-cover" />
                    ) : (
                      getInitials()
                    )}
                  </div>
                </div>
                {/* Online indicator dot */}
                <div className="absolute bottom-1 end-1 h-5 w-5 rounded-full bg-emerald-500 border-[3px] border-white dark:border-gray-900 shadow-sm" />
              </motion.div>
              <div className="pb-1 min-w-0 flex-1">
                {/* Member Since Badge */}
                {user?.createdAt && (
                  <motion.div
                    initial={{ opacity: 0, x: 10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.5 }}
                    className="mt-2"
                  >
                    <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold bg-gradient-to-r from-emerald-50 to-teal-50 dark:from-emerald-900/30 dark:to-teal-900/30 text-emerald-700 dark:text-emerald-400 px-2.5 py-1 rounded-full border border-emerald-200/50 dark:border-emerald-700/30 shadow-sm">
                      <CalendarDays className="h-3 w-3" />
                      {t('memberSince') || 'Member since'} {getMemberSince()}
                    </span>
                  </motion.div>
                )}
              </div>
            </div>

            {/* Quick info row with gradient cards */}
            <div className="grid grid-cols-2 gap-2">
              <motion.div
                whileHover={{ scale: 1.02, y: -1 }}
                className="flex items-center gap-2.5 text-sm p-3 rounded-xl bg-gradient-to-br from-emerald-50/80 to-teal-50/80 dark:from-emerald-900/20 dark:to-teal-900/20 border border-emerald-100/50 dark:border-emerald-800/30 transition-shadow hover:shadow-md"
              >
                <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-emerald-100 to-teal-100 dark:from-emerald-900/40 dark:to-teal-900/40 flex items-center justify-center flex-shrink-0">
                  <User className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                </div>
                <div className="min-w-0">
                  <p className="text-[10px] text-muted-foreground">{t('fullName')}</p>
                  <p className="text-xs font-medium text-foreground truncate">{user?.fullName || '-'}</p>
                </div>
              </motion.div>
              <motion.div
                whileHover={{ scale: 1.02, y: -1 }}
                className="flex items-center gap-2.5 text-sm p-3 rounded-xl bg-gradient-to-br from-teal-50/80 to-cyan-50/80 dark:from-teal-900/20 dark:to-cyan-900/20 border border-teal-100/50 dark:border-teal-800/30 transition-shadow hover:shadow-md"
              >
                <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-teal-100 to-cyan-100 dark:from-teal-900/40 dark:to-cyan-900/40 flex items-center justify-center flex-shrink-0">
                  <Shield className="h-4 w-4 text-teal-600 dark:text-teal-400" />
                </div>
                <div className="min-w-0">
                  <p className="text-[10px] text-muted-foreground">{t('username')}</p>
                  <p className="text-xs font-medium text-foreground truncate">{user?.username || '-'}</p>
                </div>
              </motion.div>
            </div>
          </CardContent>
        </Card>
      </motion.div>

      {/* My Queue Stats Card with gradient backgrounds */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1, duration: 0.5 }}
      >
        <Card className="border-0 shadow-md mb-6 overflow-hidden bg-gradient-to-br from-emerald-500/10 via-teal-500/10 to-cyan-500/5 backdrop-blur-xl dark:from-emerald-900/20 dark:via-teal-900/20 dark:to-cyan-800/10 border border-emerald-200/30 dark:border-emerald-700/20">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <div className="h-7 w-7 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-500 flex items-center justify-center shadow-sm">
                <BarChart3 className="h-4 w-4 text-white" />
              </div>
              {t('myStats')}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            {statsLoading ? (
              <div className="grid grid-cols-2 gap-3">
                {[1, 2, 3, 4].map((i) => (
                  <Skeleton key={i} className="h-20 rounded-xl" />
                ))}
              </div>
            ) : queueStats ? (
              <div className="grid grid-cols-2 gap-3">
                <motion.div
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: 0.15 }}
                  whileHover={{ scale: 1.03, y: -2 }}
                  className="bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-emerald-900/30 dark:to-teal-900/30 backdrop-blur-sm rounded-xl p-3 border border-emerald-100/50 dark:border-emerald-800/30 shadow-sm hover:shadow-md transition-shadow"
                >
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <div className="h-5 w-5 rounded-md bg-emerald-200/80 dark:bg-emerald-800/60 flex items-center justify-center">
                      <CalendarDays className="h-3 w-3 text-emerald-700 dark:text-emerald-300" />
                    </div>
                    <span className="text-[10px] text-muted-foreground">{t('totalQueuesJoined')}</span>
                  </div>
                  <motion.p
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.2 }}
                    className="text-xl font-bold bg-gradient-to-r from-emerald-600 to-teal-600 dark:from-emerald-400 dark:to-teal-400 bg-clip-text text-transparent"
                  >
                    {queueStats.totalQueues}
                  </motion.p>
                </motion.div>
                <motion.div
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: 0.2 }}
                  whileHover={{ scale: 1.03, y: -2 }}
                  className="bg-gradient-to-br from-teal-50 to-cyan-50 dark:from-teal-900/30 dark:to-cyan-900/30 backdrop-blur-sm rounded-xl p-3 border border-teal-100/50 dark:border-teal-800/30 shadow-sm hover:shadow-md transition-shadow"
                >
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <div className="h-5 w-5 rounded-md bg-teal-200/80 dark:bg-teal-800/60 flex items-center justify-center">
                      <Clock className="h-3 w-3 text-teal-700 dark:text-teal-300" />
                    </div>
                    <span className="text-[10px] text-muted-foreground">{t('avgWaitTimeExperienced')}</span>
                  </div>
                  <motion.p
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.25 }}
                    className="text-xl font-bold bg-gradient-to-r from-teal-600 to-cyan-600 dark:from-teal-400 dark:to-cyan-400 bg-clip-text text-transparent"
                  >
                    ~{queueStats.avgWaitTime ?? 0} {t('min')}
                  </motion.p>
                </motion.div>
                <motion.div
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: 0.25 }}
                  whileHover={{ scale: 1.03, y: -2 }}
                  className="bg-gradient-to-br from-rose-50 to-pink-50 dark:from-rose-900/20 dark:to-pink-900/20 backdrop-blur-sm rounded-xl p-3 border border-rose-100/50 dark:border-rose-800/30 shadow-sm hover:shadow-md transition-shadow"
                >
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <div className="h-5 w-5 rounded-md bg-rose-200/80 dark:bg-rose-800/60 flex items-center justify-center">
                      <Heart className="h-3 w-3 text-rose-600 dark:text-rose-300" />
                    </div>
                    <span className="text-[10px] text-muted-foreground">{t('favoriteAgencyStat')}</span>
                  </div>
                  <motion.p
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.3 }}
                    className="text-sm font-bold text-foreground truncate"
                  >
                    {queueStats.favoriteAgency
                      ? (lang === 'ar' && queueStats.favoriteAgency.nameAr
                          ? queueStats.favoriteAgency.nameAr
                          : lang === 'fr' && queueStats.favoriteAgency.nameFr
                            ? queueStats.favoriteAgency.nameFr
                            : queueStats.favoriteAgency.name)
                      : '—'}
                  </motion.p>
                </motion.div>
                <motion.div
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: 0.3 }}
                  whileHover={{ scale: 1.03, y: -2 }}
                  className="bg-gradient-to-br from-amber-50 to-orange-50 dark:from-amber-900/20 dark:to-orange-900/20 backdrop-blur-sm rounded-xl p-3 border border-amber-100/50 dark:border-amber-800/30 shadow-sm hover:shadow-md transition-shadow"
                >
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <div className="h-5 w-5 rounded-md bg-amber-200/80 dark:bg-amber-800/60 flex items-center justify-center">
                      <BarChart3 className="h-3 w-3 text-amber-600 dark:text-amber-300" />
                    </div>
                    <span className="text-[10px] text-muted-foreground">{t('thisMonth')}</span>
                  </div>
                  <motion.p
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.35 }}
                    className="text-xl font-bold bg-gradient-to-r from-amber-600 to-orange-600 dark:from-amber-400 dark:to-orange-400 bg-clip-text text-transparent"
                  >
                    {queueStats.thisMonth}
                  </motion.p>
                </motion.div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-4">{t('noData')}</p>
            )}
          </CardContent>
        </Card>
      </motion.div>

      {/* Gradient divider before notifications */}
      <hr className="gradient-divider my-6" />

      {/* Notification Preferences - Visual Toggle Cards */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15, duration: 0.5 }}
      >
        <Card className="border-0 shadow-md mb-6">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Bell className="h-4 w-4 text-emerald-600" />
              {t('notifPrefs')}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <p className="text-xs text-muted-foreground mb-4">{t('notifPrefsDesc')}</p>
            <div className="space-y-3">
              {notifCards.map((item) => {
                const isEnabled = notifPrefs[item.key];
                const Icon = item.icon;
                const colorStyles = {
                  emerald: {
                    active: 'border-emerald-300 dark:border-emerald-700 bg-emerald-50/80 dark:bg-emerald-900/20',
                    iconBg: 'bg-emerald-100 dark:bg-emerald-800/40',
                    iconColor: 'text-emerald-600 dark:text-emerald-400',
                    badge: 'bg-emerald-500',
                  },
                  amber: {
                    active: 'border-amber-300 dark:border-amber-700 bg-amber-50/80 dark:bg-amber-900/20',
                    iconBg: 'bg-amber-100 dark:bg-amber-800/40',
                    iconColor: 'text-amber-600 dark:text-amber-400',
                    badge: 'bg-amber-500',
                  },
                  teal: {
                    active: 'border-teal-300 dark:border-teal-700 bg-teal-50/80 dark:bg-teal-900/20',
                    iconBg: 'bg-teal-100 dark:bg-teal-800/40',
                    iconColor: 'text-teal-600 dark:text-teal-400',
                    badge: 'bg-teal-500',
                  },
                };
                const styles = colorStyles[item.color];
                return (
                  <motion.button
                    key={item.key}
                    whileHover={{ scale: 1.01 }}
                    whileTap={{ scale: 0.99 }}
                    onClick={() => setNotifPrefs((prev) => ({ ...prev, [item.key]: !isEnabled }))}
                    className={`w-full flex items-center gap-3 p-3.5 rounded-xl border-2 transition-all duration-300 text-start toggle-item-hover ${
                      isEnabled
                        ? styles.active
                        : 'border-transparent bg-gray-50 dark:bg-gray-800/30 opacity-70'
                    }`}
                  >
                    <div className={`h-10 w-10 rounded-xl ${styles.iconBg} flex items-center justify-center flex-shrink-0 transition-colors`}>
                      <Icon className={`h-5 w-5 ${styles.iconColor}`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className={`text-sm font-semibold ${isEnabled ? 'text-foreground' : 'text-muted-foreground'}`}>
                          {item.label}
                        </p>
                        {isEnabled && (
                          <motion.span
                            initial={{ scale: 0 }}
                            animate={{ scale: 1 }}
                            className="text-[9px] font-bold text-white px-1.5 py-0.5 rounded-full"
                          >
                            ON
                          </motion.span>
                        )}
                      </div>
                      <p className="text-[11px] text-muted-foreground mt-0.5">{item.description}</p>
                    </div>
                    {/* Toggle indicator */}
                    <motion.div
                      animate={{ backgroundColor: isEnabled ? '#10b981' : '#d1d5db' }}
                      transition={{ duration: 0.2 }}
                      className="relative h-6 w-11 rounded-full flex-shrink-0"
                    >
                      <motion.span
                        layout
                        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                        className="absolute top-0.5 h-5 w-5 bg-white rounded-full shadow-md"
                        style={{
                          left: isEnabled ? '22px' : '2px',
                        }}
                      />
                    </motion.div>
                  </motion.button>
                );
              })}
            </div>
            <motion.div whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}>
              <Button
                size="sm"
                className="mt-4 w-full bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white rounded-xl h-10 shadow-md hover:shadow-lg transition-shadow"
                onClick={saveNotifPrefs}
                disabled={notifSaving || notifLoading}
              >
                {notifSaving ? <Loader2 className="h-4 w-4 animate-spin me-2" /> : <Check className="h-4 w-4 me-2" />}
                {t('save')}
              </Button>
            </motion.div>
          </CardContent>
        </Card>
      </motion.div>

      {/* Notification & SMS Settings */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2, duration: 0.5 }}
      >
        <Card className="border-0 shadow-md mb-6 bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Smartphone className="h-4 w-4 text-emerald-600" />
              {t('smsSettings')}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0 space-y-4">
            {/* Reminder Minutes Selector */}
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5" />
                {t('reminderMinutes')}
              </Label>
              <Select
                value={String(reminderMinutesVal)}
                onValueChange={(val) => setReminderMinutesVal(Number(val))}
              >
                <SelectTrigger className="h-11">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="5">{t('reminder5min')}</SelectItem>
                  <SelectItem value="10">{t('reminder10min')}</SelectItem>
                  <SelectItem value="15">{t('reminder15min')}</SelectItem>
                  <SelectItem value="20">{t('reminder20min')}</SelectItem>
                  <SelectItem value="30">{t('reminder30min')}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground mt-1">{t('reminderMinutesDesc')}</p>
            </div>

            {/* SMS Notifications Toggle */}
            <div className="flex items-center justify-between p-3.5 rounded-xl bg-gray-50 dark:bg-gray-800/30">
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <div className="h-10 w-10 rounded-xl bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center flex-shrink-0">
                  <BellRing className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-foreground">{t('smsNotifToggle')}</p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">{t('smsNotifToggleDesc')}</p>
                </div>
              </div>
              <motion.button
                role="switch"
                aria-checked={smsNotifEnabled}
                onClick={() => setSmsNotifEnabled((prev) => !prev)}
                className="relative h-7 w-12 rounded-full flex-shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2"
              >
                <motion.div
                  animate={{ backgroundColor: smsNotifEnabled ? '#10b981' : '#d1d5db' }}
                  transition={{ duration: 0.2 }}
                  className="absolute inset-0 rounded-full"
                />
                <motion.span
                  layout
                  transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                  className="absolute top-0.5 h-6 w-6 bg-white rounded-full shadow-md pointer-events-none"
                  style={{ left: smsNotifEnabled ? '23px' : '2px' }}
                />
              </motion.button>
            </div>

            {/* SMS Balance Display */}
            <div className="grid grid-cols-2 gap-3">
              <div className="flex items-center gap-2.5 p-3 rounded-xl bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-emerald-900/20 dark:to-teal-900/20">
                <div className="h-9 w-9 rounded-lg bg-emerald-100 dark:bg-emerald-800/40 flex items-center justify-center flex-shrink-0">
                  <MessageSquare className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                </div>
                <div className="min-w-0">
                  <p className="text-[10px] text-muted-foreground">{t('freeSmsCount')}</p>
                  <p className="text-base font-bold text-emerald-700 dark:text-emerald-400">{smsCount}</p>
                </div>
              </div>
              <div className="flex items-center gap-2.5 p-3 rounded-xl bg-gradient-to-br from-amber-50 to-orange-50 dark:from-amber-900/20 dark:to-orange-900/20">
                <div className="h-9 w-9 rounded-lg bg-amber-100 dark:bg-amber-800/40 flex items-center justify-center flex-shrink-0">
                  <CreditCard className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                </div>
                <div className="min-w-0">
                  <p className="text-[10px] text-muted-foreground">{t('purchasedSmsCount')}</p>
                  <p className="text-base font-bold text-amber-700 dark:text-amber-400">{purchasedSms}</p>
                </div>
              </div>
            </div>

            <motion.div whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}>
              <Button
                size="sm"
                className="w-full bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white rounded-xl h-10 shadow-md hover:shadow-lg transition-shadow"
                onClick={handleSaveSmsSettings}
                disabled={smsSettingsSaving}
              >
                {smsSettingsSaving ? <Loader2 className="h-4 w-4 animate-spin me-2" /> : <Check className="h-4 w-4 me-2" />}
                {t('save')}
              </Button>
            </motion.div>
          </CardContent>
        </Card>
      </motion.div>

      {/* Phone Number */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.25, duration: 0.5 }}
      >
        <Card className="border-0 shadow-md mb-6 bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Phone className="h-4 w-4 text-emerald-600" />
              {t('phoneNumber')}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="flex gap-2">
              <Input
                type="tel"
                placeholder={t('phonePlaceholder')}
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(e.target.value)}
                className="h-11"
                dir="ltr"
              />
              <Button
                size="sm"
                className="bg-emerald-600 hover:bg-emerald-700 text-white px-4"
                onClick={handleSavePhone}
                disabled={savingPhone}
              >
                <Check className="h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>
      </motion.div>

      {/* Change Password */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3, duration: 0.5 }}
      >
        <Card className="border-0 shadow-md mb-6 bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-emerald-600" />
              {t('changePassword')}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">{t('currentPassword')}</Label>
                <Input
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  placeholder="••••••"
                  className="h-11"
                  dir="ltr"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">{t('newPassword')}</Label>
                <Input
                  type="password"
                  value={newPasswordVal}
                  onChange={(e) => setNewPasswordVal(e.target.value)}
                  placeholder="••••••"
                  className="h-11"
                  dir="ltr"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">{t('confirmNewPassword')}</Label>
                <Input
                  type="password"
                  value={confirmPasswordVal}
                  onChange={(e) => setConfirmPasswordVal(e.target.value)}
                  placeholder="••••••"
                  className="h-11"
                  dir="ltr"
                />
              </div>
              <motion.div whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}>
                <Button
                  size="sm"
                  className="w-full bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white rounded-xl h-10 shadow-md hover:shadow-lg transition-shadow"
                  onClick={handleChangePassword}
                  disabled={changePasswordLoading || !currentPassword || !newPasswordVal || !confirmPasswordVal}
                >
                  {changePasswordLoading ? <Loader2 className="h-4 w-4 animate-spin me-2" /> : <KeyRound className="h-4 w-4 me-2" />}
                  {t('changePassword')}
                </Button>
              </motion.div>
            </div>
          </CardContent>
        </Card>
      </motion.div>

      {/* SMS Wallet with visual progress indicator */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.35, duration: 0.5 }}
      >
        <Card className="border-0 shadow-md mb-6 bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <MessageSquare className="h-4 w-4 text-emerald-600" />
              {t('smsWallet')}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            {/* SMS Usage Breakdown */}
            <div className="bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-emerald-900/20 dark:to-teal-900/20 rounded-xl p-4 mb-4">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <p className="text-2xl font-bold text-emerald-700 dark:text-emerald-400">{totalAvailable}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{t('totalSmsAvailable')}</p>
                </div>
                {/* Circular progress indicator */}
                <div className="relative h-14 w-14 flex-shrink-0">
                  <svg className="h-14 w-14 -rotate-90" viewBox="0 0 56 56">
                    <circle cx="28" cy="28" r="24" className="fill-none stroke-emerald-100 dark:stroke-emerald-900/30" strokeWidth="4" />
                    <circle
                      cx="28" cy="28" r="24"
                      className="fill-none stroke-emerald-500 stroke-linecap:round"
                      strokeWidth="4"
                      strokeDasharray={`${2 * Math.PI * 24}`}
                      strokeDashoffset={`${2 * Math.PI * 24 * (1 - totalPercent / 100)}`}
                      style={{ transition: 'stroke-dashoffset 1s ease-out' }}
                    />
                  </svg>
                  <div className="absolute inset-0 flex items-center justify-center">
                    <span className="text-[10px] font-bold text-emerald-700 dark:text-emerald-400">{totalPercent}%</span>
                  </div>
                </div>
              </div>
              {/* Usage breakdown rows */}
              <div className="grid grid-cols-3 gap-2">
                <div className="text-center p-2 rounded-lg bg-white/50 dark:bg-gray-900/30">
                  <p className="text-[10px] text-muted-foreground">{t('freeSmsCount')}</p>
                  <p className="text-sm font-bold text-emerald-700 dark:text-emerald-400">{smsCount}</p>
                </div>
                <div className="text-center p-2 rounded-lg bg-white/50 dark:bg-gray-900/30">
                  <p className="text-[10px] text-muted-foreground">{t('smsPurchased')}</p>
                  <p className="text-sm font-bold text-amber-700 dark:text-amber-400">{purchasedSms}</p>
                </div>
                <div className="text-center p-2 rounded-lg bg-white/50 dark:bg-gray-900/30">
                  <p className="text-[10px] text-muted-foreground">{t('noAnalyticsData') || 'Used'}</p>
                  <p className="text-sm font-bold text-rose-600 dark:text-rose-400">{Math.max(0, (smsCount + purchasedSms) - totalAvailable)}</p>
                </div>
              </div>
            </div>
            <p className="text-sm font-medium text-foreground mb-3">{t('smsPacksTitle')}</p>
            <div className="grid grid-cols-2 gap-2">
              {smsPacks.map((pack, idx) => {
                const packId = String(pack.count);
                const isPurchasingThisPack = smsPurchasing && smsPurchasingPackId === packId;
                const isBestValue = pack.count === 200;
                return (
                  <motion.button
                    key={pack.count}
                    whileHover={{ scale: 1.04, y: -2 }}
                    whileTap={{ scale: 0.96 }}
                    onClick={() => handlePurchaseSms(packId)}
                    disabled={smsPurchasing}
                    className={`relative p-4 rounded-xl border text-center transition-all duration-200 hover:shadow-lg ${
                      isBestValue
                        ? 'border-emerald-300 dark:border-emerald-700 bg-gradient-to-br from-emerald-100 to-teal-100 dark:from-emerald-900/20 dark:to-teal-900/20'
                        : 'border-border hover:border-emerald-300 dark:hover:border-emerald-700 bg-gradient-to-br from-emerald-50/50 to-teal-50/50 dark:from-emerald-900/10 dark:to-teal-900/10'
                    }`}
                  >
                    {isBestValue && (
                      <span className="absolute -top-2.5 start-1/2 left-1/2 -translate-x-1/2 px-2.5 py-0.5 rounded-full bg-gradient-to-r from-amber-500 to-orange-500 text-white text-[10px] font-bold shadow-lg z-10 whitespace-nowrap">
                        <Star className="h-3 w-3 fill-white inline me-0.5" />
                        {t('bestValue')}
                      </span>
                    )}
                    <div className="flex items-center justify-center mb-1.5">
                      {isPurchasingThisPack ? (
                        <Loader2 className="h-5 w-5 text-emerald-600 animate-spin" />
                      ) : (
                        <CreditCard className="h-5 w-5 text-emerald-600" />
                      )}
                    </div>
                    <p className={`font-bold text-foreground ${isBestValue ? 'text-base' : 'text-sm'}`}>{pack.count}</p>
                    <p className="text-[10px] text-muted-foreground">{pack.price} {t('currency')}</p>
                    <p className="text-[9px] text-emerald-600 dark:text-emerald-400 mt-0.5">{t('smsPackIncludes')}</p>
                  </motion.button>
                );
              })}
            </div>
          </CardContent>
        </Card>
      </motion.div>

          {/* Purchase History */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4, duration: 0.5 }}
          >
            <Card className="border-0 shadow-md mb-6 bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <History className="h-4 w-4 text-emerald-600" />
                  {t('purchaseHistory')}
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                {purchaseHistoryLoading ? (
                  <div className="space-y-2">
                    {[1, 2, 3].map((i) => (
                      <Skeleton key={i} className="h-14 rounded-xl" />
                    ))}
                  </div>
                ) : purchaseHistory.length > 0 ? (
                  <div className="space-y-2 max-h-48 overflow-y-auto">
                    {purchaseHistory.slice(0, 5).map((item, idx) => (
                      <div
                        key={item.id}
                        className="relative flex items-center justify-between p-3 rounded-xl border border-gradient-to-r from-emerald-100/50 to-teal-100/50 dark:from-emerald-900/10 dark:to-teal-900/10 bg-white/50 dark:bg-gray-900/30"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-emerald-400 to-teal-400 flex items-center justify-center flex-shrink-0">
                            <MessageSquare className="h-4 w-4 text-white" />
                          </div>
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-foreground">{item.quantity} {t('smsPurchased')}</p>
                            <p className="text-[10px] text-muted-foreground">
                              {(() => {
                                try {
                                  const d = new Date(item.createdAt);
                                  const locale = lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US';
                                  return d.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
                                } catch { return item.createdAt; }
                              })()}
                            </p>
                          </div>
                        </div>
                        <div className="text-end">
                          <p className="text-sm font-bold text-foreground">{item.price} {t('currency')}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground text-center py-6">{t('noPurchases')}</p>
                )}
                {smsStatsData.totalPurchased > 0 && (
                  <div className="mt-3 pt-3 border-t border-border/50">
                    <div className="grid grid-cols-2 gap-3">
                      <div className="p-2.5 rounded-lg bg-gradient-to-br from-emerald-50/80 to-teal-50/80 dark:from-emerald-900/10 dark:to-teal-900/10">
                        <p className="text-[10px] text-muted-foreground">{t('totalPurchased')}</p>
                        <p className="text-sm font-bold text-emerald-700 dark:text-emerald-400">{smsStatsData.totalPurchased}</p>
                      </div>
                      <div className="p-2.5 rounded-lg bg-gradient-to-br from-amber-50/80 to-orange-50/80 dark:from-amber-900/10 dark:to-orange-900/10">
                        <p className="text-[10px] text-muted-foreground">{t('totalSpent')}</p>
                        <p className="text-sm font-bold text-amber-700 dark:text-amber-400">{smsStatsData.totalSpent} {t('currency')}</p>
                      </div>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </motion.div>

      {/* Language Preference */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.45, duration: 0.5 }}
      >
        <Card className="border-0 shadow-md mb-6 bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <LanguageSwitcher />
              {t('language')}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <Select value={lang} onValueChange={handleLanguageChange}>
              <SelectTrigger className="h-11">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ar">العربية</SelectItem>
                <SelectItem value="fr">Français</SelectItem>
                <SelectItem value="en">{t('languageEnglish')}</SelectItem>
              </SelectContent>
            </Select>
          </CardContent>
        </Card>
      </motion.div>

      {/* Appearance / Theme Card with visual previews */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.5, duration: 0.5 }}
      >
        <Card className="border-0 shadow-md mb-6 bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Palette className="h-4 w-4 text-emerald-600" />
              {t('appearance')}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <p className="text-xs text-muted-foreground mb-3">{t('appearanceDesc')}</p>
            <div className="grid grid-cols-3 gap-2">
              {/* Light */}
              <motion.button
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.97 }}
                onClick={() => setTheme('light')}
                className={`group relative overflow-hidden rounded-xl border-2 transition-all text-center p-3 ${
                  theme !== 'dark'
                    ? 'border-emerald-500 shadow-md shadow-emerald-500/10'
                    : 'border-border hover:border-emerald-200 dark:hover:border-emerald-700'
                }`}
              >
                {/* Theme preview card */}
                <div className="h-16 rounded-lg bg-white border border-gray-200 mb-2 p-1.5 overflow-hidden">
                  <div className="h-3 w-8 rounded-sm bg-emerald-500 mb-1" />
                  <div className="space-y-0.5">
                    <div className="h-1.5 w-full rounded-sm bg-gray-200" />
                    <div className="h-1.5 w-3/4 rounded-sm bg-gray-200" />
                  </div>
                </div>
                <Sun className="h-4 w-4 mx-auto mb-1 text-amber-500" />
                <span className="text-[10px] font-medium">{t('lightMode')}</span>
                {theme !== 'dark' && (
                  <motion.div
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    className="absolute top-1.5 end-1.5"
                  >
                    <Check className="h-3 w-3 text-emerald-500" />
                  </motion.div>
                )}
              </motion.button>

              {/* Dark */}
              <motion.button
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.97 }}
                onClick={() => setTheme('dark')}
                className={`group relative overflow-hidden rounded-xl border-2 transition-all text-center p-3 ${
                  theme === 'dark'
                    ? 'border-emerald-500 shadow-md shadow-emerald-500/10'
                    : 'border-border hover:border-emerald-200 dark:hover:border-emerald-700'
                }`}
              >
                {/* Theme preview card */}
                <div className="h-16 rounded-lg bg-gray-900 border border-gray-700 mb-2 p-1.5 overflow-hidden">
                  <div className="h-3 w-8 rounded-sm bg-emerald-500 mb-1" />
                  <div className="space-y-0.5">
                    <div className="h-1.5 w-full rounded-sm bg-gray-700" />
                    <div className="h-1.5 w-3/4 rounded-sm bg-gray-700" />
                  </div>
                </div>
                <Moon className="h-4 w-4 mx-auto mb-1 text-slate-400" />
                <span className="text-[10px] font-medium">{t('darkMode')}</span>
                {theme === 'dark' && (
                  <motion.div
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    className="absolute top-1.5 end-1.5"
                  >
                    <Check className="h-3 w-3 text-emerald-500" />
                  </motion.div>
                )}
              </motion.button>

              {/* System */}
              <motion.button
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.97 }}
                onClick={() => setTheme('system')}
                className={`group relative overflow-hidden rounded-xl border-2 transition-all text-center p-3 ${
                  theme === 'system'
                    ? 'border-emerald-500 shadow-md shadow-emerald-500/10'
                    : 'border-border hover:border-emerald-200 dark:hover:border-emerald-700'
                }`}
              >
                {/* Theme preview card - split */}
                <div className="h-16 rounded-lg mb-2 overflow-hidden border border-gray-300 dark:border-gray-600 flex">
                  <div className="w-1/2 bg-white p-1">
                    <div className="h-1.5 w-4 rounded-sm bg-emerald-500 mb-0.5" />
                    <div className="h-1 w-full rounded-sm bg-gray-200" />
                  </div>
                  <div className="w-1/2 bg-gray-900 p-1">
                    <div className="h-1.5 w-4 rounded-sm bg-emerald-500 mb-0.5" />
                    <div className="h-1 w-full rounded-sm bg-gray-700" />
                  </div>
                </div>
                <Monitor className="h-4 w-4 mx-auto mb-1 text-gray-500" />
                <span className="text-[10px] font-medium">{t('systemTheme')}</span>
                {theme === 'system' && (
                  <motion.div
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    className="absolute top-1.5 end-1.5"
                  >
                    <Check className="h-3 w-3 text-emerald-500" />
                  </motion.div>
                )}
              </motion.button>
            </div>
          </CardContent>
        </Card>
      </motion.div>

      {/* Gradient divider before logout */}
      <hr className="gradient-divider my-6" />

      {/* Logout */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.55, duration: 0.5 }}
      >
        <motion.div whileHover={{ scale: 1.01 }} whileTap={{ scale: 0.99 }}>
          <Button
            variant="outline"
            className="w-full h-12 rounded-xl border-red-200 text-red-600 hover:bg-red-50 hover:shadow-md dark:border-red-800 dark:text-red-400 dark:hover:bg-red-900/20 font-semibold transition-all duration-200 mb-3"
            onClick={() => {
              logout();
              toast.success(t('logout'));
            }}
          >
            <LogOut className="h-4 w-4 me-2" />
            {t('logout')}
          </Button>
        </motion.div>
      </motion.div>

      {/* Delete Account - Enhanced Red Gradient Border Warning Card */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.6, duration: 0.5 }}
      >
        <div className="relative p-[2px] rounded-2xl bg-gradient-to-r from-red-500 via-rose-500 to-red-600 dark:from-red-600 dark:via-rose-600 dark:to-red-700 shadow-lg shadow-red-500/10 dark:shadow-red-900/30 danger-gradient-border">
          <div className="bg-white dark:bg-gray-900 rounded-[14px] p-5">
            <div className="flex items-center gap-3 mb-4">
              <div className="h-11 w-11 rounded-xl bg-gradient-to-br from-red-100 to-rose-100 dark:from-red-900/40 dark:to-rose-900/40 flex items-center justify-center">
                <AlertTriangle className="h-5 w-5 text-red-600 dark:text-red-400" />
              </div>
              <div>
                <p className="text-sm font-bold text-red-600 dark:text-red-400">{t('deleteAccount')}</p>
                <p className="text-[11px] text-muted-foreground">{t('deleteAccountDesc')}</p>
              </div>
            </div>
            <AlertDialog open={deleteDialogOpen} onOpenChange={(open) => { setDeleteDialogOpen(open); if (!open) setDeleteConfirmText(''); }}>
              <AlertDialogTrigger asChild>
                <motion.div whileHover={{ scale: 1.01 }} whileTap={{ scale: 0.99 }}>
                  <Button
                    variant="outline"
                    className="w-full h-11 rounded-xl border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 hover:shadow-md transition-all"
                  >
                    <Trash2 className="h-4 w-4 me-2" />
                    {t('deleteAccount')}
                  </Button>
                </motion.div>
              </AlertDialogTrigger>
              <AlertDialogContent className="sm:max-w-md">
                <AlertDialogHeader>
                  <AlertDialogTitle className="flex items-center gap-2 text-red-600">
                    <AlertTriangle className="h-5 w-5" />
                    {t('deleteAccount')}
                  </AlertDialogTitle>
                  <AlertDialogDescription className="space-y-3">
                    <p>{t('deleteAccountDesc')}</p>
                    <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl p-3">
                      <p className="text-xs text-red-600 dark:text-red-400 font-medium">
                        ⚠️ {t('deleteAccountWarning')}
                      </p>
                    </div>
                    <div className="space-y-2">
                      <p className="text-sm text-muted-foreground">{t('typeDeleteToConfirm')}</p>
                      <Input
                        value={deleteConfirmText}
                        onChange={(e) => setDeleteConfirmText(e.target.value)}
                        placeholder={lang === 'ar' ? 'حذف' : lang === 'fr' ? 'supprimer' : 'delete'}
                        className="h-10"
                        dir="ltr"
                      />
                    </div>
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter className="flex-col gap-2 sm:flex-col">
                  <AlertDialogCancel className="w-full rounded-xl h-10">
                    {t('cancel')}
                  </AlertDialogCancel>
                  <Button
                    onClick={handleDeleteAccount}
                    disabled={deleteLoading || deleteConfirmText !== (lang === 'ar' ? 'حذف' : lang === 'fr' ? 'supprimer' : 'delete')}
                    className="w-full bg-red-600 hover:bg-red-700 text-white rounded-xl h-10"
                  >
                    {deleteLoading ? <Loader2 className="h-4 w-4 animate-spin me-2" /> : <Trash2 className="h-4 w-4 me-2" />}
                    {t('deleteAccount')}
                  </Button>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
