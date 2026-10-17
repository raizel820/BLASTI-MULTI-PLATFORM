'use client';
import { apiFetch } from "@/lib/api-fetch";
import { useState, useEffect, useCallback } from 'react';
import { useAppStore } from '@/store/use-app-store';
import { useLanguage } from '@/hooks/use-language';
import { toast } from 'sonner';
import type { Language } from '@/i18n';
import { updateDocumentDirection } from '@/store/use-app-store';
import { mergeSessionUser, markLocalAvatarMutation } from '@/lib/user-store-refresh';
import { mirrorNotifPrefs } from '@/lib/notification-channel';
import { useCachedResource, resourceKey } from '@/lib/use-cached-data';
import type {
  NotifPrefs,
  QueueStats,
  PurchaseHistoryItem,
  SmsStatsData,
} from '@/components/customer/profile/profile-types';

/** Shape of GET /api/user/profile (subset the profile view consumes). */
interface ProfileResponse {
  notificationPreferences?: string | NotifPrefs;
  phoneNumber?: string;
  fullName?: string;
  email?: string | null;
  avatarUrl?: string | null;
  freeSmsCount?: number;
  reminderMinutes?: number;
  smsNotificationsEnabled?: boolean;
  [key: string]: unknown;
}

/** Shape of GET /api/sms/purchase. */
interface PurchaseResponse {
  purchases?: PurchaseHistoryItem[];
  totalPurchased?: number;
  totalSpent?: number;
  pendingCount?: number;
}

/** TTL for profile/stats/purchases revalidation — short enough to stay
 *  correct on multi-device accounts, long enough that tab-flipping never
 *  refetches (Task 85 navigation-smoothness requirement). */
const PROFILE_TTL_MS = 15_000;

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
  const [smsStatsData, setSmsStatsData] = useState<SmsStatsData>({ totalPurchased: 0, totalSpent: 0, pendingCount: 0 });

  const [smsCount, setSmsCount] = useState(user?.freeSmsCount ?? 10);

  const userId = user?.id;

  // ─── Task 85: cached SWR resources — views re-mount on every tab switch;
  // these seed their state from the previous visit's data (memory layer =
  // zero-latency same-session remounts) and revalidate in the background. ──

  const profileResource = useCachedResource<ProfileResponse>({
    key: userId ? resourceKey('/api/user/profile', { userId }) : null,
    enabled: !!userId,
    ttlMs: PROFILE_TTL_MS,
    fetcher: useCallback(async () => {
      if (!userId) return null;
      try {
        const res = await apiFetch(`/api/user/profile?userId=${userId}`);
        if (!res.ok) return null;
        const data = (await res.json()) as ProfileResponse;
        // Cross-device heal: merge the authoritative identity fields so the
        // header/sidebar/identity-card avatars update on THIS device too.
        // (Network-only — the cache-seed path must not touch the store.)
        mergeSessionUser({
          fullName: typeof data.fullName === 'string' && data.fullName ? data.fullName : undefined,
          email: typeof data.email === 'string' && data.email ? data.email : undefined,
          phoneNumber: typeof data.phoneNumber === 'string' && data.phoneNumber ? data.phoneNumber : undefined,
          avatarUrl: typeof data.avatarUrl === 'string' && data.avatarUrl ? data.avatarUrl : undefined,
          freeSmsCount: typeof data.freeSmsCount === 'number' && Number.isFinite(data.freeSmsCount)
            ? data.freeSmsCount
            : undefined,
        });
        return data;
      } catch {
        return null;
      }
    }, [userId]),
  });

  const statsResource = useCachedResource<QueueStats>({
    key: userId ? resourceKey('/api/user/stats', { userId }) : null,
    enabled: !!userId,
    ttlMs: PROFILE_TTL_MS,
    fetcher: useCallback(async () => {
      if (!userId) return null;
      try {
        const res = await apiFetch(`/api/user/stats?userId=${userId}`);
        if (!res.ok) return null;
        return (await res.json()) as QueueStats;
      } catch {
        return null;
      }
    }, [userId]),
  });

  const purchaseResource = useCachedResource<PurchaseResponse>({
    key: userId ? resourceKey('/api/sms/purchase', { userId }) : null,
    enabled: !!userId,
    ttlMs: PROFILE_TTL_MS,
    fetcher: useCallback(async () => {
      if (!userId) return null;
      try {
        const res = await apiFetch(`/api/sms/purchase?userId=${userId}`);
        if (!res.ok) return null;
        return (await res.json()) as PurchaseResponse;
      } catch {
        return null;
      }
    }, [userId]),
  });

  const fetchProfile = profileResource.refresh;
  const fetchStats = statsResource.refresh;
  const fetchPurchaseHistory = purchaseResource.refresh;

  const notifLoading = profileResource.loading;
  const statsLoading = statsResource.loading;
  const purchaseHistoryLoading = purchaseResource.loading;

  // Apply cached-or-fresh profile payloads to local view state.
  useEffect(() => {
    const data = profileResource.data;
    if (!data) return;
    if (data.notificationPreferences) {
      const prefs = typeof data.notificationPreferences === 'string'
        ? JSON.parse(data.notificationPreferences)
        : data.notificationPreferences;
      setNotifPrefs(prefs);
      // Mirror for the realtime alert paths (outside React) — keeps the
      // lock-screen alert mute/takeover prefs in effect app-wide.
      mirrorNotifPrefs(prefs);
    }
    if (data.phoneNumber) setPhoneNumber(data.phoneNumber);
    if (data.fullName) setFullName(data.fullName);
    if (data.email !== undefined && data.email !== null) setEmail(data.email);
    if (data.avatarUrl !== undefined && data.avatarUrl !== null) setAvatarUrl(data.avatarUrl);
    if (data.freeSmsCount !== undefined) setSmsCount(data.freeSmsCount);
    if (data.reminderMinutes !== undefined) setReminderMinutesVal(data.reminderMinutes);
    if (data.smsNotificationsEnabled !== undefined) setSmsNotifEnabled(data.smsNotificationsEnabled);
  }, [profileResource.data]);

  // Apply cached-or-fresh purchase payloads.
  useEffect(() => {
    const data = purchaseResource.data;
    if (!data) return;
    if (data.purchases) setPurchaseHistory(data.purchases);
    setSmsStatsData({
      totalPurchased: data.totalPurchased || 0,
      totalSpent: data.totalSpent || 0,
      pendingCount: data.pendingCount || 0,
    });
    setPurchasedSms(data.totalPurchased || 0);
  }, [purchaseResource.data]);

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
        void profileResource.invalidate(); // the cached profile is now stale
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
        void profileResource.invalidate();
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

  /**
   * Task 2-d parity — persist a freshly-uploaded avatar IMMEDIATELY (same
   * contract as the Settings page card): the preview confirm uploads, this
   * PATCH points the DB at the new blob, and ONLY THEN may the replaced
   * upload be deleted. Deferring to the card's Save button would leave the
   * stored avatarUrl pointing at a deleted file whenever the customer skips
   * Save. Returns true when the API accepted the new URL.
   */
  const activateAvatar = async (url: string): Promise<boolean> => {
    if (!user) return false;
    try {
      const res = await apiFetch('/api/user/profile', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id, avatarUrl: url }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data) {
        markLocalAvatarMutation(); // shield the fresh avatar from the refresher
        setAvatarUrl(data.avatarUrl ?? url);
        // Refresh the session user so the header/avatar reflect the change.
        setUser({ ...user, avatarUrl: data.avatarUrl ?? url });
        void profileResource.invalidate();
        return true;
      }
      return false;
    } catch {
      return false;
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
        // Manual purchase creates a PENDING record — credits are granted only
        // after admin approval / webhook confirmation. Never optimistically
        // inflate the balance here (the old code double-counted: the approved
        // amount is ALREADY merged into freeSmsCount by the server, and this
        // hook added it a second time on top).
        toast.success(t('smsPurchaseSubmitted'));
        // Force a network refresh of both the balance and the purchase list
        // (bypasses the TTL) so the pending row appears immediately.
        await Promise.all([profileResource.refresh(), purchaseResource.refresh()]);
      } else if (res.status === 429) { toast.error(t('smsAlreadyPurchasing')); }
      else { const data = await res.json(); toast.error(data.error || t('smsPurchaseFailed')); }
    } catch { toast.error(t('smsPurchaseFailed')); } finally { setSmsPurchasing(false); setSmsPurchasingPackId(null); }
  };

  // freeSmsCount from the server IS the total spendable balance — purchased
  // credits are merged into it on approval (sms.ts / chargily-fulfill.ts).
  // Adding the lifetime purchase total again double-counted (10 free + 200
  // bought showed "total 410").
  const totalAvailable = smsCount;

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
    activateAvatar,
    // Notif prefs
    notifPrefs, notifLoading, notifSaving, handleToggleNotifPref, saveNotifPrefs,
    // Delete account
    deleteDialogOpen, setDeleteDialogOpen, deleteConfirmText, setDeleteConfirmText, deleteLoading, handleDeleteAccount,
    // Change password
    currentPassword, setCurrentPassword, newPasswordVal, setNewPasswordVal, confirmPasswordVal, setConfirmPasswordVal, changePasswordLoading, handleChangePassword,
    // SMS settings
    reminderMinutesVal, setReminderMinutesVal, smsNotifEnabled, setSmsNotifEnabled, smsSettingsSaving, handleSaveSmsSettings, smsCount,
    // SMS wallet
    purchasedSms, totalAvailable, smsPurchasing, smsPurchasingPackId, handlePurchaseSms,
    // Purchase history
    purchaseHistory, purchaseHistoryLoading, smsStatsData,
    // Stats
    queueStats: statsResource.data, statsLoading,
    // Language & theme
    handleLanguageChange,
  };
}
