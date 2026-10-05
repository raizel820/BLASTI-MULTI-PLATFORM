'use client';
/**
 * Customer Settings — Task 79-b rebuild (Design System v2).
 * iOS-style grouped rows. ALL logic preserved 1:1:
 *  - GET /api/user/profile (fullName, phoneNumber, notificationPreferences)
 *  - PATCH /api/user/profile (save profile; language; avatarUrl after upload)
 *  - POST /api/upload?type=avatar (FormData: file + userId + type)
 *  - PATCH /api/user/change-password (validation + wrongCurrentPassword mapping)
 *  - PATCH /api/user/preferences (notification prefs)
 *  - DELETE /api/user/delete-account (typed confirmation → logout)
 *  - NotificationPrefs channel component (APP_ONLY / SMS / WHATSAPP / BOTH)
 *  - Logout: store logout() + success toast
 */
import { apiFetch } from '@/lib/api-fetch';
import { useState, useEffect } from 'react';
import { useAppStore } from '@/store/use-app-store';
import { useLanguage } from '@/hooks/use-language';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
import { UserAvatar } from '@/components/shared/user-avatar';
import {
  User,
  Bell,
  BellRing,
  Clock,
  CheckCircle2,
  KeyRound,
  Trash2,
  Globe,
  Info,
  Loader2,
  Camera,
  Check,
  CalendarDays,
  Shield,
  AlertTriangle,
  LogOut,
  Sun,
  Moon,
  Monitor,
} from 'lucide-react';
import { toast } from 'sonner';
import { motion } from 'framer-motion';
import { useTheme } from 'next-themes';
import type { Language } from '@/i18n';
import { updateDocumentDirection } from '@/store/use-app-store';
import { NotificationPrefs } from '@/components/customer/notification-prefs';
import { BiometricSettingsCard } from '@/components/shared/biometric-settings';
import { ProfileSoundSettings } from './profile/profile-sound-settings';

export function CustomerSettings() {
  const { user, setUser, logout } = useAppStore();
  const { t, lang } = useLanguage();
  const { theme, setTheme } = useTheme();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Profile state
  const [fullName, setFullName] = useState(user?.fullName || '');
  const [phoneNumber, setPhoneNumber] = useState(user?.phoneNumber || '');
  const [profileSaved, setProfileSaved] = useState(false);

  // Change password
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordLoading, setPasswordLoading] = useState(false);

  // Notification preferences
  const [notifPrefs, setNotifPrefs] = useState({
    queue_called: true,
    turn_approaching: true,
    completed: true,
  });
  const [notifSaving, setNotifSaving] = useState(false);

  // Language
  const [selectedLang, setSelectedLang] = useState<Language>(lang);

  // Delete account
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleteLoading, setDeleteLoading] = useState(false);

  // Avatar
  const [avatarUploading, setAvatarUploading] = useState(false);

  useEffect(() => {
    fetchProfile();
  }, []);

  const fetchProfile = async () => {
    if (!user?.id) return;
    setLoading(true);
    try {
      const res = await apiFetch(`/api/user/profile?userId=${user.id}`);
      if (res.ok) {
        const data = await res.json();
        if (data.notificationPreferences) {
          setNotifPrefs(
            typeof data.notificationPreferences === 'string'
              ? JSON.parse(data.notificationPreferences)
              : data.notificationPreferences
          );
        }
        if (data.phoneNumber) setPhoneNumber(data.phoneNumber);
        if (data.fullName) setFullName(data.fullName);
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setLoading(false);
    }
  };

  const handleSaveProfile = async () => {
    if (!user?.id || !fullName.trim()) return;
    setSaving(true);
    try {
      const res = await apiFetch('/api/user/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: user.id,
          fullName: fullName.trim(),
          phoneNumber: phoneNumber.trim() || null,
        }),
      });
      if (res.ok) {
        toast.success(t('success'));
        if (user) setUser({ ...user, fullName: fullName.trim(), phoneNumber: phoneNumber.trim() });
        setProfileSaved(true);
        setTimeout(() => setProfileSaved(false), 2000);
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

  const handleChangePassword = async () => {
    if (!user?.id) return;
    if (!currentPassword || !newPassword || !confirmPassword) {
      toast.error(t('requiredField'));
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error(t('passwordMismatch'));
      return;
    }
    if (newPassword.length < 6) {
      toast.error(t('passwordMinLength'));
      return;
    }
    setPasswordLoading(true);
    try {
      const res = await apiFetch('/api/user/change-password', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id, currentPassword, newPassword }),
      });
      if (res.ok) {
        toast.success(t('passwordChanged'));
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
      } else {
        const data = await res.json();
        toast.error(data.error === 'Current password is incorrect' ? t('wrongCurrentPassword') : (data.error || t('error')));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setPasswordLoading(false);
    }
  };

  const handleSaveNotifs = async () => {
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

  const handleLanguageChange = (newLang: string) => {
    const langTyped = newLang as Language;
    setSelectedLang(langTyped);
    updateDocumentDirection(langTyped);
    if (user) {
      setUser({ ...user, language: langTyped });
    }
    // Save to server
    apiFetch('/api/user/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: user?.id, language: langTyped }),
    }).catch(() => { /* silent */ });
  };

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user?.id) return;
    setAvatarUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('userId', user.id);
      // Task 24 FIX: declare the upload type as a form field too — the cloud
      // route reads formData 'type' first and previously only saw 'general'.
      formData.append('type', 'avatar');
      const res = await apiFetch('/api/upload?type=avatar', {
        method: 'POST',
        body: formData,
      });
      if (res.ok) {
        const data = await res.json();
        toast.success(t('success'));
        if (user) setUser({ ...user, avatarUrl: data.url });
        // Persist avatarUrl to the database
        try {
          await apiFetch('/api/user/profile', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: user?.id, avatarUrl: data.url }),
          });
        } catch { /* silent */ }
      } else {
        toast.error(t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setAvatarUploading(false);
      // Allow re-picking the same file later
      e.target.value = '';
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
        setDeleteOpen(false);
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

  const getMemberSince = () => {
    if (!user?.createdAt) return '';
    return new Date(user.createdAt).toLocaleDateString(
      lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US',
      { year: 'numeric', month: 'long', day: 'numeric' }
    );
  };

  const notifCards = [
    { key: 'queue_called' as const, label: t('queueCalledNotif'), desc: t('queueCalledNotifDesc'), icon: BellRing, color: 'emerald' as const },
    { key: 'turn_approaching' as const, label: t('turnApproachingNotif'), desc: t('turnApproachingNotifDesc'), icon: Clock, color: 'amber' as const },
    { key: 'completed' as const, label: t('completedNotif'), desc: t('completedNotifDesc'), icon: CheckCircle2, color: 'teal' as const },
  ];

  const themeOptions = [
    { value: 'light', icon: Sun, label: t('lightMode') },
    { value: 'dark', icon: Moon, label: t('darkMode') },
    { value: 'system', icon: Monitor, label: t('systemTheme') },
  ];

  if (loading) {
    return (
      <div className="px-4 py-3 pb-24 lg:pb-8">
        <div className="max-w-5xl mx-auto space-y-4">
          <Skeleton className="h-8 w-32 rounded-xl" />
          <Skeleton className="h-48 rounded-2xl" />
          <Skeleton className="h-40 rounded-2xl" />
          <Skeleton className="h-32 rounded-2xl" />
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 py-3 pb-24 lg:pb-8">
      <div className="max-w-5xl mx-auto space-y-4">
        {/* Header */}
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
          <h1 className="text-lg font-bold text-foreground">{t('settings')}</h1>
          <p className="text-xs text-muted-foreground mt-0.5">{t('customerSettingsDesc')}</p>
        </motion.div>

        {/* ─── Account group ─── */}
        <motion.section
          initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: 0.05 }}
          aria-label={t('account')}
        >
          <h2 className="text-sm font-semibold text-muted-foreground mb-2 px-1">{t('account')}</h2>
          <div className="rounded-2xl border border-border bg-white dark:bg-gray-900/80 shadow-sm overflow-hidden divide-y divide-border/60">
            {/* Identity row with avatar upload */}
            <div className="p-4 flex items-center gap-3">
              <div className="relative shrink-0">
                <div className="h-14 w-14 rounded-full overflow-hidden bg-emerald-600 flex items-center justify-center text-white text-lg font-bold ring-2 ring-emerald-100 dark:ring-emerald-900">
                  <UserAvatar avatarUrl={user?.avatarUrl} fullName={user?.fullName} />
                </div>
                <label
                  className="absolute bottom-0 end-0 h-7 w-7 rounded-full bg-emerald-600 flex items-center justify-center cursor-pointer ring-2 ring-white dark:ring-gray-900 shadow hover:bg-emerald-700 transition-colors"
                  aria-label={t('edit')}
                >
                  {avatarUploading ? <Loader2 className="h-3.5 w-3.5 text-white animate-spin" /> : <Camera className="h-3.5 w-3.5 text-white" />}
                  <input type="file" accept="image/*" className="hidden" onChange={handleAvatarUpload} disabled={avatarUploading} />
                </label>
              </div>
              <div className="min-w-0">
                <p className="text-sm font-bold text-foreground truncate">{user?.fullName || t('defaultUser')}</p>
                <p className="text-xs text-muted-foreground truncate">@{user?.username}</p>
                <span className="mt-0.5 inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-700 dark:text-emerald-400">
                  <CalendarDays className="h-3 w-3" />
                  {t('memberSince')} {getMemberSince()}
                </span>
              </div>
            </div>
            {/* Editable name */}
            <div className="p-4 space-y-1.5">
              <Label htmlFor="settings-fullname" className="text-xs text-muted-foreground">{t('fullName')}</Label>
              <Input
                id="settings-fullname"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder={t('fullName')}
                className="h-11 rounded-xl"
              />
            </div>
            {/* Editable phone */}
            <div className="p-4 space-y-1.5">
              <Label htmlFor="settings-phone" className="text-xs text-muted-foreground">{t('phoneNumber')}</Label>
              <Input
                id="settings-phone"
                type="tel"
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(e.target.value)}
                placeholder={t('phonePlaceholder')}
                className="h-11 rounded-xl"
                dir="ltr"
              />
            </div>
            {/* Save */}
            <div className="p-4">
              <Button
                className="w-full h-10 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl"
                onClick={handleSaveProfile}
                disabled={saving || !fullName.trim()}
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin me-2" /> : profileSaved ? <Check className="h-4 w-4 me-2" /> : <CheckCircle2 className="h-4 w-4 me-2" />}
                {t('save')}
              </Button>
            </div>
          </div>
        </motion.section>

        {/* ─── Appearance group (theme + language quick setters) ─── */}
        <motion.section
          initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: 0.1 }}
          aria-label={t('appearance')}
        >
          <h2 className="text-sm font-semibold text-muted-foreground mb-2 px-1">{t('appearance')}</h2>
          <div className="rounded-2xl border border-border bg-white dark:bg-gray-900/80 shadow-sm overflow-hidden divide-y divide-border/60">
            {/* Theme quick setter — same keys as theme-selector logic */}
            <div className="p-4">
              <p className="text-xs font-medium text-foreground mb-2">{t('appearanceDesc')}</p>
              <div className="grid grid-cols-3 gap-2">
                {themeOptions.map((opt) => {
                  const Icon = opt.icon;
                  const active = opt.value === 'dark' ? theme === 'dark' : opt.value === 'light' ? theme !== 'dark' : theme === 'system';
                  return (
                    <button
                      key={opt.value}
                      onClick={() => setTheme(opt.value)}
                      aria-pressed={active}
                      className={`h-11 rounded-xl border-2 flex items-center justify-center gap-1.5 text-xs font-semibold transition-colors ${
                        active
                          ? 'border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400'
                          : 'border-border text-muted-foreground hover:border-emerald-200 dark:hover:border-emerald-800'
                      }`}
                    >
                      <Icon className="h-4 w-4" />
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>
            {/* Language quick setter (persists to server) */}
            <div className="p-4 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="h-9 w-9 rounded-xl bg-teal-100 dark:bg-teal-900/40 flex items-center justify-center shrink-0">
                  <Globe className="h-4 w-4 text-teal-600 dark:text-teal-400" />
                </div>
                <p className="text-sm font-medium text-foreground">{t('language')}</p>
              </div>
              <Select value={selectedLang} onValueChange={handleLanguageChange}>
                <SelectTrigger className="h-10 w-36 rounded-xl">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ar">العربية</SelectItem>
                  <SelectItem value="en">{t('languageEnglish')}</SelectItem>
                  <SelectItem value="fr">Français</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </motion.section>

        {/* ─── Notifications group ─── */}
        <motion.section
          initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: 0.15 }}
          aria-label={t('notifications')}
        >
          <h2 className="text-sm font-semibold text-muted-foreground mb-2 px-1">{t('notifications')}</h2>
          <div className="rounded-2xl border border-border bg-white dark:bg-gray-900/80 shadow-sm overflow-hidden divide-y divide-border/60">
            <div className="p-4 space-y-3">
              <div className="flex items-center gap-2">
                <Bell className="h-4 w-4 text-emerald-600" />
                <p className="text-sm font-semibold text-foreground">{t('notifPrefs')}</p>
              </div>
              <p className="text-xs text-muted-foreground -mt-1.5">{t('notifPrefsDesc')}</p>
              {notifCards.map((item) => {
                const isEnabled = notifPrefs[item.key];
                const Icon = item.icon;
                return (
                  <div
                    key={item.key}
                    className={`flex items-center gap-3 p-3 rounded-xl border transition-colors ${
                      isEnabled
                        ? 'border-emerald-200 dark:border-emerald-800 bg-emerald-50/60 dark:bg-emerald-900/20'
                        : 'border-transparent bg-muted/50 dark:bg-gray-800/30'
                    }`}
                  >
                    <div className={`h-9 w-9 rounded-lg flex items-center justify-center shrink-0 ${
                      isEnabled
                        ? 'bg-emerald-100 dark:bg-emerald-800/40 text-emerald-600 dark:text-emerald-400'
                        : 'bg-gray-100 dark:bg-gray-800 text-muted-foreground'
                    }`}>
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className={`text-sm font-medium ${isEnabled ? 'text-foreground' : 'text-muted-foreground'}`}>{item.label}</p>
                      <p className="text-[11px] text-muted-foreground">{item.desc}</p>
                    </div>
                    <Switch
                      checked={isEnabled}
                      onCheckedChange={(checked) => setNotifPrefs(prev => ({ ...prev, [item.key]: checked }))}
                    />
                  </div>
                );
              })}
              <Button
                className="w-full h-10 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl"
                onClick={handleSaveNotifs}
                disabled={notifSaving}
              >
                {notifSaving ? <Loader2 className="h-4 w-4 animate-spin me-2" /> : <Check className="h-4 w-4 me-2" />}
                {t('save')}
              </Button>
            </div>
            {/* Channel preference (APP_ONLY / SMS / WHATSAPP / BOTH) — preserved component */}
            <div className="p-4 border-t border-border/60">
              <NotificationPrefs />
            </div>
          </div>
        </motion.section>

        {/* ─── Notification sound (volume + custom song — Task 82) ─── */}
        <ProfileSoundSettings t={t} />

        {/* ─── Security group (biometric login + password) ─── */}
        <motion.section
          initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: 0.2 }}
          aria-label={t('security')}
        >
          <h2 className="text-sm font-semibold text-muted-foreground mb-2 px-1">{t('security')}</h2>
          <div className="space-y-3">
            {/* Task 80 — biometric quick-unlock (device keystore-backed) */}
            <BiometricSettingsCard />
            {/* Change password (preserved) */}
            <div className="rounded-2xl border border-border bg-white dark:bg-gray-900/80 shadow-sm p-4 space-y-3">
              <div className="flex items-center gap-2">
                <KeyRound className="h-4 w-4 text-emerald-600" />
                <p className="text-sm font-semibold text-foreground">{t('changePassword')}</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="settings-cur-pass" className="text-xs text-muted-foreground">{t('currentPassword')}</Label>
                <Input
                  id="settings-cur-pass"
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  placeholder="••••••"
                  className="h-11 rounded-xl"
                  dir="ltr"
                  autoComplete="current-password"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="settings-new-pass" className="text-xs text-muted-foreground">{t('newPassword')}</Label>
                <Input
                  id="settings-new-pass"
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="••••••"
                  className="h-11 rounded-xl"
                  dir="ltr"
                  autoComplete="new-password"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="settings-conf-pass" className="text-xs text-muted-foreground">{t('confirmNewPassword')}</Label>
                <Input
                  id="settings-conf-pass"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="••••••"
                  className="h-11 rounded-xl"
                  dir="ltr"
                  autoComplete="new-password"
                  onKeyDown={(e) => { if (e.key === 'Enter') handleChangePassword(); }}
                />
              </div>
              <Button
                className="w-full h-10 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl"
                onClick={handleChangePassword}
                disabled={passwordLoading || !currentPassword || !newPassword || !confirmPassword}
              >
                {passwordLoading ? <Loader2 className="h-4 w-4 animate-spin me-2" /> : <KeyRound className="h-4 w-4 me-2" />}
                {t('changePassword')}
              </Button>
            </div>
          </div>
        </motion.section>

        {/* ─── About group ─── */}
        <motion.section
          initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: 0.25 }}
          aria-label={t('about')}
        >
          <h2 className="text-sm font-semibold text-muted-foreground mb-2 px-1">{t('about')}</h2>
          <div className="rounded-2xl border border-border bg-white dark:bg-gray-900/80 shadow-sm overflow-hidden divide-y divide-border/60">
            <div className="p-3.5 flex items-center gap-3">
              <div className="h-9 w-9 rounded-xl bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center shrink-0">
                <User className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              </div>
              <p className="text-xs text-muted-foreground">{t('username')}</p>
              <p className="text-sm font-medium text-foreground ms-auto truncate">@{user?.username}</p>
            </div>
            <div className="p-3.5 flex items-center gap-3">
              <div className="h-9 w-9 rounded-xl bg-teal-100 dark:bg-teal-900/30 flex items-center justify-center shrink-0">
                <Shield className="h-4 w-4 text-teal-600 dark:text-teal-400" />
              </div>
              <p className="text-xs text-muted-foreground">{t('status')}</p>
              <p className="text-sm font-medium text-foreground ms-auto">{t('customerRole')}</p>
            </div>
            <div className="p-3.5 flex items-center gap-3">
              <div className="h-9 w-9 rounded-xl bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center shrink-0">
                <CalendarDays className="h-4 w-4 text-amber-600 dark:text-amber-400" />
              </div>
              <p className="text-xs text-muted-foreground">{t('memberSince')}</p>
              <p className="text-sm font-medium text-foreground ms-auto truncate">{getMemberSince()}</p>
            </div>
            <div className="p-3.5 flex items-center gap-3">
              <div className="h-9 w-9 rounded-xl bg-muted dark:bg-gray-800 flex items-center justify-center shrink-0">
                <Info className="h-4 w-4 text-muted-foreground" />
              </div>
              <p className="text-xs text-muted-foreground">{t('appVersion')}</p>
              <p className="text-sm font-medium text-foreground ms-auto" dir="ltr">1.0.0</p>
            </div>
          </div>
        </motion.section>

        {/* ─── Logout (exact logic preserved) ─── */}
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: 0.3 }}>
          <Button
            variant="outline"
            className="w-full h-11 rounded-xl border-red-200 text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-900/20 font-semibold"
            onClick={() => {
              logout();
              toast.success(t('logout'));
            }}
          >
            <LogOut className="h-4 w-4 me-2" />
            {t('logout')}
          </Button>
        </motion.div>

        {/* ─── Delete account ─── */}
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: 0.35 }}>
          <button
            className="w-full h-11 rounded-xl border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors flex items-center justify-center gap-2 text-sm font-semibold"
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 className="h-4 w-4" />
            {t('deleteAccount')}
          </button>
        </motion.div>

        {/* Delete Account Dialog (preserved confirmation flow) */}
        <AlertDialog open={deleteOpen} onOpenChange={(open) => { setDeleteOpen(open); if (!open) setDeleteConfirmText(''); }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2 text-red-600">
                <AlertTriangle className="h-5 w-5" />
                {t('deleteAccount')}
              </AlertDialogTitle>
              <AlertDialogDescription>{t('deleteUserWarning')}</AlertDialogDescription>
            </AlertDialogHeader>
            <div className="space-y-3 py-2">
              <div className="p-3 rounded-xl bg-red-50 dark:bg-red-900/10 border border-red-200/50 dark:border-red-800/30">
                <p className="text-xs font-medium text-red-700 dark:text-red-400">{t('deleteAccountWarning')}</p>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">{t('typeDeleteToConfirm')}</Label>
                <Input
                  value={deleteConfirmText}
                  onChange={(e) => setDeleteConfirmText(e.target.value)}
                  placeholder="delete"
                  className="h-11 rounded-xl"
                  dir="ltr"
                />
              </div>
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleDeleteAccount}
                disabled={deleteLoading || deleteConfirmText.toLowerCase() !== 'delete'}
                className="bg-red-600 hover:bg-red-700 text-white"
              >
                {deleteLoading ? <Loader2 className="h-4 w-4 animate-spin me-1" /> : null}
                {t('deleteAccount')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}
