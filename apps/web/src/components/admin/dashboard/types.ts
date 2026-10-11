export interface SmsSettingsData {
  id: string;
  provider: string;
  apiUrl: string;
  apiKey: string;
  senderName: string;
  enabled: boolean;
  smsPerReminder: number;
  maxSmsPerDay: number;
  testPhoneNumber: string | null;
  updatedAt: string;
  createdAt: string;
}

export interface SmsProviderInfo {
  id: string;
  name: string;
  description: string;
  defaultApiUrl: string;
  senderIdSupport: boolean;
  docsUrl: string;
}

export interface SmsUsageStats {
  sentToday: number;
  sentThisWeek: number;
  sentThisMonth: number;
  totalSent: number;
  failedToday: number;
}

export interface SmsLogItem {
  id: string;
  phoneNumber: string;
  message: string;
  status: string;
  provider: string;
  errorMessage: string | null;
  createdAt: string;
}

export interface AdminStats {
  totalAgencies: number;
  activeQueues: number;
  dailyReservations: number;
  totalRevenue: number;
  pendingTransactions: number;
  totalUsers?: number;
}

export interface ActivityItem {
  id: string;
  action: string;
  entity: string;
  details: string;
  createdAt: string;
}

export interface AnnouncementItem {
  id: string;
  message: string;
  type: string;
  createdAt: string;
}
