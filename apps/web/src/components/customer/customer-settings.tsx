'use client';
import { apiFetch } from '@/lib/api-fetch';
import { useState, useEffect } from 'react';
import { useAppStore } from '@/store/use-app-store';
import { useLanguage } from '@/hooks/use-language';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
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
import { getProxiedUrl } from '@/lib/utils';
import {
  User,
  Phone,
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
} from 'lucide-react';
import { toast } from 'sonner';
import { motion } from 'framer-motion';
import type { Language } from '@/i18n';
import { updateDocumentDirection } from '@/store/use-app-store';
import { NotificationPrefs } from '@/components/customer/notification-prefs';

export function CustomerSettings() {
  const { user, setUser, logout } = useAppStore();
  const { t, lang } = useLanguage();

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

  const getInitials = () => {
    if (!user?.fullName) return 'U';
    const parts = user.fullName.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
    return parts[0].charAt(0).toUpperCase();
  };

  const getMemberSince = () => {
    if (!user?.createdAt) return '';
    return new Date(user.createdAt).toLocaleDateString(
      lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US',
      { year: 'numeric', month: 'long', day: 'numeric' }
    );
  };

  const notifCards = [
    { key: 'queue_called' as const, label: t('queueCalledNotif'), desc: t('queueCalledNotifDesc'), icon: BellRing, color: 'emerald' },
    { key: 'turn_approaching' as const, label: t('turnApproachingNotif'), desc: t('turnApproachingNotifDesc'), icon: Clock, color: 'amber' },
    { key: 'completed' as const, label: t('completedNotif'), desc: t('completedNotifDesc'), icon: CheckCircle2, color: 'teal' },
  ];

  if (loading) {
    return (
      <div className="px-4 py-4 pb-24 space-y-4">
        <Skeleton className="h-8 w-32 rounded-lg" />
        <Skeleton className="h-48 rounded-2xl" />
        <Skeleton className="h-40 rounded-2xl" />
        <Skeleton className="h-32 rounded-2xl" />
      </div>
    );
  }

  return (
    <div className="px-4 py-4 pb-24 space-y-4">
      {/* Header */}
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
        <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
          <Settings2 className="h-5 w-5 text-emerald-600" />
          {t('settings')}
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">{t('customerSettingsDesc' as any)}</p>
      </motion.div>

      {/* Profile Section */}
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}>
        <Card className="border-0 shadow-sm overflow-hidden">
          <div className="relative h-28 bg-gradient-to-br from-emerald-500 via-teal-500 to-emerald-600">
            <div className="absolute inset-0 overflow-hidden">
              <div className="absolute -top-8 -end-8 w-32 h-32 rounded-full bg-white/10" />
              <div className="absolute -bottom-12 -start-12 w-40 h-40 rounded-full bg-white/5" />
            </div>
          </div>
          <CardContent className="p-5 -mt-12 relative">
            <div className="flex items-end gap-4 mb-4">
              {/* Avatar */}
              <div className="relative">
                <div className="h-20 w-20 rounded-full bg-gradient-to-br from-emerald-400 via-teal-400 to-emerald-600 flex items-center justify-center text-white text-2xl font-bold ring-4 ring-white dark:ring-gray-900 shadow-xl flex-shrink-0 overflow-hidden">
                  {user?.avatarUrl ? (
                    <img src={getProxiedUrl(user.avatarUrl)} alt={user.fullName} width={36} height={36} className="h-full w-full object-cover" />
                  ) : (
                    getInitials()
                  )}
                </div>
                <label className="absolute bottom-0 end-0 h-7 w-7 rounded-full bg-emerald-600 flex items-center justify-center cursor-pointer ring-2 ring-white dark:ring-gray-900 shadow-lg hover:bg-emerald-700 transition-colors">
                  {avatarUploading ? <Loader2 className="h-3.5 w-3.5 text-white animate-spin" /> : <Camera className="h-3.5 w-3.5 text-white" />}
                  <input type="file" accept="image/*" className="hidden" onChange={handleAvatarUpload} disabled={avatarUploading} />
                </label>
              </div>
              <div className="pb-1 min-w-0 flex-1">
                <h2 className="text-lg font-bold text-foreground truncate">{user?.fullName || t('defaultUser')}</h2>
                <p className="text-sm text-muted-foreground truncate">@{user?.username}</p>
              </div>
            </div>

            {/* Edit Fields */}
            <div className="space-y-3 mt-2">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">{t('fullName')}</Label>
                <Input
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder={t('fullName')}
                  className="h-11"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">{t('phoneNumber')}</Label>
                <div className="flex gap-2">
                  <Input
                    type="tel"
                    value={phoneNumber}
                    onChange={(e) => setPhoneNumber(e.target.value)}
                    placeholder={t('phonePlaceholder')}
                    className="h-11"
                    dir="ltr"
                  />
                </div>
              </div>
              <Button
                className="w-full bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl h-10 gap-2"
                onClick={handleSaveProfile}
                disabled={saving || !fullName.trim()}
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : profileSaved ? <Check className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
                {t('save')}
              </Button>
            </div>
          </CardContent>
        </Card>
      </motion.div>

      {/* About Section */}
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
        <Card className="border-0 shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Info className="h-4 w-4 text-emerald-600" />
              {t('about' as any)}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="grid grid-cols-1 gap-2">
              <div className="flex items-center gap-3 p-3 rounded-xl bg-gray-50 dark:bg-gray-800/30">
                <div className="h-9 w-9 rounded-lg bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center flex-shrink-0">
                  <User className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                </div>
                <div className="min-w-0">
                  <p className="text-[10px] text-muted-foreground">{t('username')}</p>
                  <p className="text-sm font-medium text-foreground">@{user?.username}</p>
                </div>
              </div>
              <div className="flex items-center gap-3 p-3 rounded-xl bg-gray-50 dark:bg-gray-800/30">
                <div className="h-9 w-9 rounded-lg bg-teal-100 dark:bg-teal-900/30 flex items-center justify-center flex-shrink-0">
                  <Shield className="h-4 w-4 text-teal-600 dark:text-teal-400" />
                </div>
                <div className="min-w-0">
                  <p className="text-[10px] text-muted-foreground">{t('status')}</p>
                  <p className="text-sm font-medium text-foreground">{t('customerRole')}</p>
                </div>
              </div>
              <div className="flex items-center gap-3 p-3 rounded-xl bg-gray-50 dark:bg-gray-800/30">
                <div className="h-9 w-9 rounded-lg bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center flex-shrink-0">
                  <CalendarDays className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                </div>
                <div className="min-w-0">
                  <p className="text-[10px] text-muted-foreground">{t('memberSince')}</p>
                  <p className="text-sm font-medium text-foreground">{getMemberSince()}</p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </motion.div>

      {/* Change Password */}
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}>
        <Card className="border-0 shadow-sm">
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
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="••••••"
                  className="h-11"
                  dir="ltr"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">{t('confirmNewPassword')}</Label>
                <Input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="••••••"
                  className="h-11"
                  dir="ltr"
                  onKeyDown={(e) => { if (e.key === 'Enter') handleChangePassword(); }}
                />
              </div>
              <Button
                className="w-full bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl h-10 gap-2"
                onClick={handleChangePassword}
                disabled={passwordLoading || !currentPassword || !newPassword || !confirmPassword}
              >
                {passwordLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                {t('changePassword')}
              </Button>
            </div>
          </CardContent>
        </Card>
      </motion.div>

      {/* Notification Preferences */}
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
        <Card className="border-0 shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Bell className="h-4 w-4 text-emerald-600" />
              {t('notifPrefs')}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <p className="text-xs text-muted-foreground mb-3">{t('notifPrefsDesc')}</p>
            <div className="space-y-3">
              {notifCards.map((item) => {
                const isEnabled = notifPrefs[item.key];
                const Icon = item.icon;
                const colorMap: Record<string, string> = {
                  emerald: isEnabled ? 'border-emerald-300 dark:border-emerald-700 bg-emerald-50/80 dark:bg-emerald-900/20' : '',
                  amber: isEnabled ? 'border-amber-300 dark:border-amber-700 bg-amber-50/80 dark:bg-amber-900/20' : '',
                  teal: isEnabled ? 'border-teal-300 dark:border-teal-700 bg-teal-50/80 dark:bg-teal-900/20' : '',
                };
                const iconColorMap: Record<string, string> = {
                  emerald: 'bg-emerald-100 dark:bg-emerald-800/40 text-emerald-600 dark:text-emerald-400',
                  amber: 'bg-amber-100 dark:bg-amber-800/40 text-amber-600 dark:text-amber-400',
                  teal: 'bg-teal-100 dark:bg-teal-800/40 text-teal-600 dark:text-teal-400',
                };
                return (
                  <div
                    key={item.key}
                    className={`flex items-center gap-3 p-3 rounded-xl border-2 transition-all ${isEnabled ? colorMap[item.color] : 'border-transparent bg-gray-50 dark:bg-gray-800/30 opacity-70'}`}
                  >
                    <div className={`h-9 w-9 rounded-lg ${iconColorMap[item.color]} flex items-center justify-center flex-shrink-0`}>
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className={`text-sm font-medium ${isEnabled ? 'text-foreground' : 'text-muted-foreground'}`}>{item.label}</p>
                      <p className="text-[11px] text-muted-foreground mt-0.5">{item.desc}</p>
                    </div>
                    <Switch
                      checked={isEnabled}
                      onCheckedChange={(checked) => setNotifPrefs(prev => ({ ...prev, [item.key]: checked }))}
                    />
                  </div>
                );
              })}
            </div>
            <Button
              className="w-full mt-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl h-10 gap-2"
              onClick={handleSaveNotifs}
              disabled={notifSaving}
            >
              {notifSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              {t('save')}
            </Button>
          </CardContent>
        </Card>
      </motion.div>

      {/* Notification Channel Preference (APP_ONLY / SMS / WHATSAPP / BOTH) */}
      <NotificationPrefs />

      {/* Language Preference */}
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.25 }}>
        <Card className="border-0 shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Globe className="h-4 w-4 text-emerald-600" />
              {t('language')}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <Select value={selectedLang} onValueChange={handleLanguageChange}>
              <SelectTrigger className="h-11 rounded-xl">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ar">العربية</SelectItem>
                <SelectItem value="en">{t('languageEnglish')}</SelectItem>
                <SelectItem value="fr">Français</SelectItem>
              </SelectContent>
            </Select>
          </CardContent>
        </Card>
      </motion.div>

      {/* Delete Account */}
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}>
        <Card className="border-0 shadow-sm border-t-2 border-t-red-200 dark:border-t-red-800">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2 text-red-600 dark:text-red-400">
              <AlertTriangle className="h-4 w-4" />
              {t('deleteAccount')}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <p className="text-xs text-muted-foreground mb-3">{t('deleteAccountDesc')}</p>
            <Button
              variant="outline"
              className="w-full text-red-600 border-red-200 dark:border-red-800 hover:bg-red-50 dark:hover:bg-red-900/10 rounded-xl h-10 gap-2"
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 className="h-4 w-4" />
              {t('deleteAccount')}
            </Button>
          </CardContent>
        </Card>
      </motion.div>

      {/* Delete Account Dialog */}
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
                className="h-11"
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
  );
}

// Need to import Settings2
import { Settings2 } from 'lucide-react';
