'use client';
/**
 * Customer Profile — Task 79-b rebuild (Design System v2).
 *
 * ALL business logic is preserved via the `useProfileData` hook
 * (profile/use-profile-data.ts), which keeps the exact endpoints and flows
 * from the previous 1388-line implementation:
 *  - GET  /api/user/profile   (notification prefs, phone, freeSmsCount, reminderMinutes, smsNotifEnabled)
 *  - GET  /api/user/stats     (totalQueues, thisMonth, avgWaitTime, favoriteAgency)
 *  - GET  /api/sms/purchase   (purchase history + totals)
 *  - PATCH /api/user/profile  (phone save, SMS settings)
 *  - PATCH /api/user/preferences (notification prefs)
 *  - PATCH /api/user/change-password
 *  - DELETE /api/user/delete-account (with typed confirmation)
 *  - POST /api/sms/purchase   (SMS packs)
 * Section UI reuses the existing profile/* child components (restyle only).
 */
import { useAppStore } from '@/store/use-app-store';
import { useLanguage } from '@/hooks/use-language';
import { Skeleton } from '@/components/ui/skeleton';
import { UserAvatar } from '@/components/shared/user-avatar';
import { CalendarDays, Pencil, UserRound } from 'lucide-react';
import { motion } from 'framer-motion';
import { useTheme } from 'next-themes';
import { toast } from 'sonner';

import { useProfileData } from './profile/use-profile-data';
import { ProfilePhoneNumber } from './profile/profile-phone-number';
import { ProfileChangePassword } from './profile/profile-change-password';
import { ProfilePreferences } from './profile/profile-preferences';
import { ProfileNotifications } from './profile/profile-notifications';
import { ProfileSmsSettings } from './profile/profile-sms-settings';
import { ProfileSmsWallet } from './profile/profile-sms-wallet';
import { ProfilePurchaseHistory } from './profile/profile-purchase-history';
import { ProfileDangerZone } from './profile/profile-danger-zone';

export function CustomerProfile() {
  const { user, logout } = useAppStore();
  const { t, lang } = useLanguage();
  const { theme, setTheme } = useTheme();

  const profile = useProfileData();

  const getMemberSince = () => {
    if (!user?.createdAt) return '';
    const date = new Date(user.createdAt);
    return date.toLocaleDateString(lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  };

  const scrollToPersonalInfo = () => {
    document.getElementById('profile-personal-info')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  if (profile.notifLoading) {
    return (
      <div className="px-4 py-3 pb-24 lg:pb-8">
        <div className="max-w-5xl mx-auto space-y-4">
          <Skeleton className="h-8 w-32 mb-5" />
          <Skeleton className="h-28 rounded-2xl mb-4" />
          <Skeleton className="h-24 rounded-2xl mb-4" />
          <Skeleton className="h-40 rounded-2xl mb-4" />
          <Skeleton className="h-32 rounded-2xl" />
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 py-3 pb-24 lg:pb-8">
      <div className="max-w-5xl mx-auto space-y-4">
        {/* ─── Compact identity card ─── */}
        <motion.section
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25 }}
          aria-label={t('profile')}
          className="rounded-2xl border border-border bg-white dark:bg-gray-900/80 shadow-sm p-4"
        >
          <div className="flex items-center gap-3 min-w-0">
            <div className="h-14 w-14 rounded-full overflow-hidden bg-emerald-600 flex items-center justify-center text-white text-lg font-bold ring-2 ring-emerald-100 dark:ring-emerald-900 shrink-0">
              <UserAvatar avatarUrl={user?.avatarUrl} fullName={user?.fullName} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-base font-bold text-foreground truncate">
                  {user?.fullName || t('defaultUser')}
                </h2>
                <span className="inline-flex items-center gap-1 rounded-full bg-teal-50 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400 px-2 py-0.5 text-[10px] font-semibold border border-teal-200/60 dark:border-teal-800/60">
                  <UserRound className="h-3 w-3" />
                  {t('customerRole')}
                </span>
              </div>
              <p className="text-xs text-muted-foreground truncate">
                @{user?.username || 'user'}{profile.phoneNumber ? ` • ${profile.phoneNumber}` : ''}
              </p>
              {user?.createdAt && (
                <span className="mt-1 inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-700 dark:text-emerald-400">
                  <CalendarDays className="h-3 w-3" />
                  {t('memberSince')} {getMemberSince()}
                </span>
              )}
            </div>
            <button
              onClick={scrollToPersonalInfo}
              aria-label={t('edit')}
              className="h-9 w-9 rounded-xl border border-border flex items-center justify-center text-muted-foreground hover:text-emerald-600 dark:hover:text-emerald-400 hover:border-emerald-200 dark:hover:border-emerald-800 transition-colors shrink-0"
            >
              <Pencil className="h-4 w-4" />
            </button>
          </div>
        </motion.section>

        {/* ─── Stat chips (My Stats preserved) ─── */}
        <motion.section
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, delay: 0.05 }}
          aria-label={t('myStats')}
        >
          {profile.statsLoading ? (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
              {[1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-16 rounded-2xl" />
              ))}
            </div>
          ) : profile.queueStats ? (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
              <div className="rounded-2xl border border-border bg-white dark:bg-gray-900/80 shadow-sm p-3 min-w-0">
                <p className="text-[10px] text-muted-foreground">{t('totalQueuesJoined')}</p>
                <p className="text-lg font-bold text-emerald-700 dark:text-emerald-400" dir="ltr">
                  {profile.queueStats.totalQueues}
                </p>
              </div>
              <div className="rounded-2xl border border-border bg-white dark:bg-gray-900/80 shadow-sm p-3 min-w-0">
                <p className="text-[10px] text-muted-foreground">{t('avgWaitTimeExperienced')}</p>
                <p className="text-lg font-bold text-teal-700 dark:text-teal-400" dir="ltr">
                  ~{profile.queueStats.avgWaitTime ?? 0}{t('min')}
                </p>
              </div>
              <div className="rounded-2xl border border-border bg-white dark:bg-gray-900/80 shadow-sm p-3 min-w-0">
                <p className="text-[10px] text-muted-foreground">{t('favoriteAgencyStat')}</p>
                <p className="text-sm font-bold text-foreground truncate" title={profile.queueStats.favoriteAgency?.name}>
                  {profile.queueStats.favoriteAgency
                    ? (lang === 'ar' && profile.queueStats.favoriteAgency.nameAr
                        ? profile.queueStats.favoriteAgency.nameAr
                        : lang === 'fr' && profile.queueStats.favoriteAgency.nameFr
                          ? profile.queueStats.favoriteAgency.nameFr
                          : profile.queueStats.favoriteAgency.name)
                    : '—'}
                </p>
              </div>
              <div className="rounded-2xl border border-border bg-white dark:bg-gray-900/80 shadow-sm p-3 min-w-0">
                <p className="text-[10px] text-muted-foreground">{t('thisMonth')}</p>
                <p className="text-lg font-bold text-amber-600 dark:text-amber-400" dir="ltr">
                  {profile.queueStats.thisMonth}
                </p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground text-center py-4">{t('noData')}</p>
          )}
        </motion.section>

        {/* ─── Personal info: phone number ─── */}
        <div id="profile-personal-info" className="scroll-mt-4">
          <ProfilePhoneNumber
            phoneNumber={profile.phoneNumber}
            savingPhone={profile.savingPhone}
            onPhoneNumberChange={profile.setPhoneNumber}
            onSave={profile.handleSavePhone}
            t={t}
          />
        </div>

        {/* ─── Change password ─── */}
        <ProfileChangePassword
          currentPassword={profile.currentPassword}
          newPasswordVal={profile.newPasswordVal}
          confirmPasswordVal={profile.confirmPasswordVal}
          changePasswordLoading={profile.changePasswordLoading}
          onCurrentPasswordChange={profile.setCurrentPassword}
          onNewPasswordChange={profile.setNewPasswordVal}
          onConfirmPasswordChange={profile.setConfirmPasswordVal}
          onChangePassword={profile.handleChangePassword}
          t={t}
        />

        {/* ─── Preferences: language + theme ─── */}
        <ProfilePreferences
          lang={lang}
          theme={theme}
          onLanguageChange={profile.handleLanguageChange}
          onThemeChange={setTheme}
          t={t}
        />

        {/* ─── Notification preferences ─── */}
        <ProfileNotifications
          notifPrefs={profile.notifPrefs}
          notifSaving={profile.notifSaving}
          notifLoading={profile.notifLoading}
          onTogglePref={profile.handleToggleNotifPref}
          onSave={profile.saveNotifPrefs}
          t={t}
        />

        {/* ─── SMS settings ─── */}
        <ProfileSmsSettings
          reminderMinutesVal={profile.reminderMinutesVal}
          smsNotifEnabled={profile.smsNotifEnabled}
          smsSettingsSaving={profile.smsSettingsSaving}
          smsCount={profile.smsCount}
          purchasedSms={profile.purchasedSms}
          onReminderChange={profile.setReminderMinutesVal}
          onSmsNotifToggle={() => profile.setSmsNotifEnabled((prev) => !prev)}
          onSave={profile.handleSaveSmsSettings}
          t={t}
        />

        {/* ─── SMS wallet (top-up packs) ─── */}
        <ProfileSmsWallet
          smsCount={profile.smsCount}
          purchasedSms={profile.purchasedSms}
          totalAvailable={profile.totalAvailable}
          totalPercent={profile.totalPercent}
          smsPurchasing={profile.smsPurchasing}
          smsPurchasingPackId={profile.smsPurchasingPackId}
          onPurchaseSms={profile.handlePurchaseSms}
          t={t}
        />

        {/* ─── Purchase history ─── */}
        <ProfilePurchaseHistory
          purchaseHistory={profile.purchaseHistory}
          purchaseHistoryLoading={profile.purchaseHistoryLoading}
          smsStatsData={profile.smsStatsData}
          lang={lang}
          t={t}
        />

        {/* ─── Danger zone: logout + delete account ─── */}
        <ProfileDangerZone
          deleteDialogOpen={profile.deleteDialogOpen}
          deleteConfirmText={profile.deleteConfirmText}
          deleteLoading={profile.deleteLoading}
          onDeleteDialogOpenChange={profile.setDeleteDialogOpen}
          onDeleteConfirmTextChange={profile.setDeleteConfirmText}
          onDeleteAccount={profile.handleDeleteAccount}
          onLogout={() => {
            logout();
            toast.success(t('logout'));
          }}
          lang={lang}
          t={t}
        />
      </div>
    </div>
  );
}
