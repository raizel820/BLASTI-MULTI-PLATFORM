'use client';
import { apiFetch } from "@/lib/api-fetch";
import { useState, useEffect, useCallback } from 'react';
import { useAppStore } from '@/store/use-app-store';
import { useLanguage } from '@/hooks/use-language';
import { toast } from 'sonner';
import type { Language } from '@/i18n';
import { updateDocumentDirection } from '@/store/use-app-store';
import type {
  NotifPrefs,
  QueueStats,
  PurchaseHistoryItem,
  SmsStatsData,
} from '@/components/customer/profile/profile-types';

export function useProfileData() {
  const { user, setUser, logout } = useAppStore();
  const { t, lang } = useLanguage();

  const [phoneNumber, setPhoneNumber] = useState(user?.phoneNumber || '');
  const [savingPhone, setSavingPhone] = useState(false);

  // Personal info (Task 82) — name, email and avatar are now editable.
  const [fullName, setFullName] = useState(user?.fullName || '');
  const [email, setEmail] = useState(user?.email || '');
  const [avatarUrl, setAvatarUrl] = useState(user?.avatarUrl || '');
  const [savingPersonalInfo, setSavingPersonalInfo] = useState(false);

  const [notifPrefs, setNotifPrefs] = useState<NotifPrefs>({
    queue_called: true,
    turn_approaching: true,
    completed: true,
  });
  const [notifLoading, setNotifLoading] = useState(false);
  const [notifSaving, setNotifSaving] = useState(false);

  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPasswordVal, setNewPasswordVal] = useState('');
  const [confirmPasswordVal, setConfirmPasswordVal] = useState('');
  const [changePasswordLoading, setChangePasswordLoading] = useState(false);

  const [reminderMinutesVal, setReminderMinutesVal] = useState(10);
  const [smsNotifEnabled, setSmsNotifEnabled] = useState(true);
  const [purchasedSms, setPurchasedSms] = useState(0);
  const [smsSettingsSaving, setSmsSettingsSaving] = useState(false);

  const [smsPurchasing, setSmsPurchasing] = useState(false);
  const [smsPurchasingPackId, setSmsPurchasingPackId] = useState<string | null>(null);

  const [purchaseHistory, setPurchaseHistory] = useState<PurchaseHistoryItem[]>([]);
  const [purchaseHistoryLoading, setPurchaseHistoryLoading] = useState(false);
  const [smsStatsData, setSmsStatsData] = useState<SmsStatsData>({ totalPurchased: 0, totalSpent: 0 });

  const [queueStats, setQueueStats] = useState<QueueStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);

  const [smsCount, setSmsCount] = useState(user?.freeSmsCount ?? 10);

  const fetchProfile = useCallback(async () => {
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
        if (data.phoneNumber) setPhoneNumber(data.phoneNumber);
        if (data.fullName) setFullName(data.fullName);
        if (data.email !== undefined && data.email !== null) setEmail(data.email);
        if (data.avatarUrl !== undefined && data.avatarUrl !== null) setAvatarUrl(data.avatarUrl);
        if (data.freeSmsCount !== undefined) setSmsCount(data.freeSmsCount);
        if (data.reminderMinutes !== undefined) setReminderMinutesVal(data.reminderMinutes);
        if (data.smsNotificationsEnabled !== undefined) setSmsNotifEnabled(data.smsNotificationsEnabled);
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setNotifLoading(false);
    }
  }, [user?.id, t]);

  const fetchStats = useCallback(async () => {
    if (!user?.id) return;
    setStatsLoading(true);
    try {
      const res = await apiFetch(`/api/user/stats?userId=${user.id}`);
      if (res.ok) { const data = await res.json(); setQueueStats(data); }
    } catch {
      toast.error(t('error'));
    } finally {
      setStatsLoading(false);
    }
  }, [user?.id, t]);

  const fetchPurchaseHistory = useCallback(async () => {
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
    } catch { /* silent */ } finally {
      setPurchaseHistoryLoading(false);
    }
  }, [user?.id]);

  useEffect(() => { fetchProfile(); fetchStats(); fetchPurchaseHistory(); }, []);

  const handleLanguageChange = (newLang: string) => {
    const langTyped = newLang as Language;
    updateDocumentDirection(langTyped);
    if (user) setUser({ ...user, language: langTyped });
  };

  const saveNotifPrefs = async () => {
    if (!user?.id) return;
    setNotifSaving(true);
    try {
      const res = await apiFetch('/api/user/preferences', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id, preferences: notifPrefs }),
      });
      if (res.ok) toast.success(t('success'));
    } catch { toast.error(t('error')); } finally { setNotifSaving(false); }
  };

  const handleSavePhone = async () => {
    if (!phoneNumber.trim() || !user) return;
    setSavingPhone(true);
    try {
      const res = await apiFetch('/api/user/profile', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id, phoneNumber: phoneNumber.trim() }),
      });
      if (res.ok) {
        toast.success(t('success'));
        setUser({ ...user, phoneNumber: phoneNumber.trim() });
      } else {
        const data = await res.json().catch(() => null);
        if (res.status === 409) toast.error(t('phoneNumberTaken'));
        else toast.error(data?.error || t('error'));
      }
    } catch { toast.error(t('error')); } finally { setSavingPhone(false); }
  };

  /**
   * Task 82 — save the editable personal info (name, email, phone, avatar).
   * Only changed fields are sent so untouched sections never fail validation.
   * The store user is refreshed from the authoritative API response.
   */
  const handleSavePersonalInfo = async (next: {
    fullName: string;
    email: string;
    phoneNumber: string;
    avatarUrl?: string;
  }): Promise<boolean> => {
    if (!user) return false;
    const trimmedName = next.fullName.trim();
    if (!trimmedName) { toast.error(t('requiredField')); return false; }
    const trimmedEmail = next.email.trim();
    if (trimmedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      toast.error(t('invalidEmail'));
      return false;
    }
    setSavingPersonalInfo(true);
    try {
      const body: Record<string, unknown> = {
        userId: user.id,
        fullName: trimmedName,
        // '' clears the email server-side (nullable column)
        email: trimmedEmail,
        phoneNumber: next.phoneNumber.trim(),
      };
      // Only send the avatar when it actually changed — sending '' would
      // wipe an existing avatar the customer never touched.
      if (next.avatarUrl !== undefined && next.avatarUrl !== (user.avatarUrl ?? '')) {
        body.avatarUrl = next.avatarUrl;
      }

      const res = await apiFetch('/api/user/profile', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data) {
        setFullName(data.fullName ?? trimmedName);
        setEmail(data.email ?? '');
        if (data.phoneNumber) setPhoneNumber(data.phoneNumber);
        if (data.avatarUrl !== undefined && data.avatarUrl !== null) setAvatarUrl(data.avatarUrl);
        // Refresh the session user so the header/avatar reflect the change.
        setUser({
          ...user,
          fullName: data.fullName ?? user.fullName,
          email: data.email ?? undefined,
          phoneNumber: data.phoneNumber ?? user.phoneNumber,
          avatarUrl: data.avatarUrl ?? user.avatarUrl,
        });
        toast.success(t('success'));
        return true;
      }
      if (res.status === 409) {
        const msg = String(data?.error || '');
        toast.error(msg.includes('email') ? t('emailTaken') : t('phoneNumberTaken'));
      } else {
        toast.error(data?.error || t('error'));
      }
      return false;
    } catch {
      toast.error(t('error'));
      return false;
    } finally {
      setSavingPersonalInfo(false);
    }
  };

  const handleSaveSmsSettings = async () => {
    if (!user?.id) return;
    setSmsSettingsSaving(true);
    try {
      const res = await apiFetch('/api/user/profile', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id, reminderMinutes: reminderMinutesVal, smsNotificationsEnabled: smsNotifEnabled }),
      });
      if (res.ok) toast.success(t('smsSaved')); else toast.error(t('error'));
    } catch { toast.error(t('error')); } finally { setSmsSettingsSaving(false); }
  };

  const handleChangePassword = async () => {
    if (!user?.id) return;
    if (!currentPassword || !newPasswordVal || !confirmPasswordVal) { toast.error(t('requiredField')); return; }
    if (newPasswordVal !== confirmPasswordVal) { toast.error(t('passwordMismatch')); return; }
    if (newPasswordVal.length < 6) { toast.error(t('passwordMinLength')); return; }
    setChangePasswordLoading(true);
    try {
      const res = await apiFetch('/api/user/change-password', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id, currentPassword, newPassword: newPasswordVal }),
      });
      if (res.ok) { toast.success(t('passwordChanged')); setCurrentPassword(''); setNewPasswordVal(''); setConfirmPasswordVal(''); }
      else {
        const data = await res.json();
        toast.error(res.status === 401 ? t('wrongCurrentPassword') : (data.error || t('error')));
      }
    } catch { toast.error(t('error')); } finally { setChangePasswordLoading(false); }
  };

  const handleDeleteAccount = async () => {
    if (!user?.id) return;
    setDeleteLoading(true);
    try {
      const res = await apiFetch('/api/user/delete-account', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id }),
      });
      if (res.ok) { toast.success(t('accountDeleted')); setDeleteDialogOpen(false); logout(); }
      else { const data = await res.json(); toast.error(data.error || t('deleteAccountError')); }
    } catch { toast.error(t('error')); } finally { setDeleteLoading(false); setDeleteConfirmText(''); }
  };

  const handlePurchaseSms = async (packId: string) => {
    if (!user?.id) return;
    if (smsPurchasing) { toast.error(t('smsAlreadyPurchasing')); return; }
    setSmsPurchasing(true);
    setSmsPurchasingPackId(packId);
    try {
      const res = await apiFetch('/api/sms/purchase', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packId, userId: user.id }),
      });
      if (res.ok) {
        const data = await res.json();
        toast.success(`${t('smsPurchaseSuccess')} — ${t('newBalance')}: ${data.newBalance}`);
        setPurchasedSms((prev) => prev + parseInt(packId, 10));
        await fetchProfile();
      } else if (res.status === 429) { toast.error(t('smsAlreadyPurchasing')); }
      else { const data = await res.json(); toast.error(data.error || t('smsPurchaseFailed')); }
    } catch { toast.error(t('smsPurchaseFailed')); } finally { setSmsPurchasing(false); setSmsPurchasingPackId(null); }
  };

  const totalAvailable = smsCount + purchasedSms;
  const totalPercent = totalAvailable > 0 ? Math.min(100, (smsCount / totalAvailable) * 100) : 0;

  const handleToggleNotifPref = (key: keyof NotifPrefs) => {
    setNotifPrefs((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  return {
    // Store
    user, setUser, logout, t, lang,
    // Phone
    phoneNumber, savingPhone, setPhoneNumber, handleSavePhone,
    // Personal info (name/email/avatar — Task 82)
    fullName, setFullName, email, setEmail, avatarUrl, setAvatarUrl,
    savingPersonalInfo, handleSavePersonalInfo,
    // Notif prefs
    notifPrefs, notifLoading, notifSaving, handleToggleNotifPref, saveNotifPrefs,
    // Delete account
    deleteDialogOpen, setDeleteDialogOpen, deleteConfirmText, setDeleteConfirmText, deleteLoading, handleDeleteAccount,
    // Change password
    currentPassword, setCurrentPassword, newPasswordVal, setNewPasswordVal, confirmPasswordVal, setConfirmPasswordVal, changePasswordLoading, handleChangePassword,
    // SMS settings
    reminderMinutesVal, setReminderMinutesVal, smsNotifEnabled, setSmsNotifEnabled, smsSettingsSaving, handleSaveSmsSettings, smsCount,
    // SMS wallet
    purchasedSms, totalAvailable, totalPercent, smsPurchasing, smsPurchasingPackId, handlePurchaseSms,
    // Purchase history
    purchaseHistory, purchaseHistoryLoading, smsStatsData,
    // Stats
    queueStats, statsLoading,
    // Language & theme
    handleLanguageChange,
  };
}
