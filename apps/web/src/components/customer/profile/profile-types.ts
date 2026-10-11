import type { Language, TranslationKeys } from '@/i18n';

export interface UserData {
  id: string;
  username: string;
  fullName: string;
  role: string;
  language: Language;
  avatarUrl?: string;
  agencyId?: string;
  agencyName?: string;
  agencyNameAr?: string;
  agencyNameFr?: string;
  phoneNumber?: string;
  freeSmsCount?: number;
  createdAt?: string;
}

export interface QueueStats {
  totalQueues: number;
  thisMonth: number;
  avgWaitTime: number;
  favoriteAgency: { name: string; nameAr?: string; nameFr?: string } | null;
}

export interface NotifPrefs {
  queue_called: boolean;
  turn_approaching: boolean;
  completed: boolean;
}

export interface PurchaseHistoryItem {
  id: string;
  quantity: number;
  price: number;
  createdAt: string;
}

export interface SmsStatsData {
  totalPurchased: number;
  totalSpent: number;
}

export type ProfileTranslate = (key: TranslationKeys, params?: Record<string, string>) => string;

export interface ProfileHeaderProps {
  user: UserData | null;
  phoneNumber: string;
  lang: Language;
  t: ProfileTranslate;
}

export interface ProfileStatsProps {
  queueStats: QueueStats | null;
  statsLoading: boolean;
  lang: Language;
  t: ProfileTranslate;
}

export interface ProfileNotificationsProps {
  notifPrefs: NotifPrefs;
  notifSaving: boolean;
  notifLoading: boolean;
  onTogglePref: (key: keyof NotifPrefs) => void;
  onSave: () => void;
  t: ProfileTranslate;
}

export interface ProfileSmsSettingsProps {
  reminderMinutesVal: number;
  smsNotifEnabled: boolean;
  smsSettingsSaving: boolean;
  smsCount: number;
  purchasedSms: number;
  onReminderChange: (val: number) => void;
  onSmsNotifToggle: () => void;
  onSave: () => void;
  t: ProfileTranslate;
}

export interface ProfilePhoneNumberProps {
  phoneNumber: string;
  savingPhone: boolean;
  onPhoneNumberChange: (value: string) => void;
  onSave: () => void;
  t: ProfileTranslate;
}

export interface ProfileChangePasswordProps {
  currentPassword: string;
  newPasswordVal: string;
  confirmPasswordVal: string;
  changePasswordLoading: boolean;
  onCurrentPasswordChange: (value: string) => void;
  onNewPasswordChange: (value: string) => void;
  onConfirmPasswordChange: (value: string) => void;
  onChangePassword: () => void;
  t: ProfileTranslate;
}

export interface ProfileSmsWalletProps {
  smsCount: number;
  purchasedSms: number;
  totalAvailable: number;
  totalPercent: number;
  smsPurchasing: boolean;
  smsPurchasingPackId: string | null;
  onPurchaseSms: (packId: string) => void;
  t: ProfileTranslate;
}

export interface ProfilePurchaseHistoryProps {
  purchaseHistory: PurchaseHistoryItem[];
  purchaseHistoryLoading: boolean;
  smsStatsData: SmsStatsData;
  lang: Language;
  t: ProfileTranslate;
}

export interface ProfilePreferencesProps {
  lang: Language;
  theme: string | undefined;
  onLanguageChange: (lang: string) => void;
  onThemeChange: (theme: string) => void;
  t: ProfileTranslate;
}

export interface ProfileDangerZoneProps {
  deleteDialogOpen: boolean;
  deleteConfirmText: string;
  deleteLoading: boolean;
  onDeleteDialogOpenChange: (open: boolean) => void;
  onDeleteConfirmTextChange: (text: string) => void;
  onDeleteAccount: () => void;
  onLogout: () => void;
  lang: Language;
  t: ProfileTranslate;
}
