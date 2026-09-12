/**
 * Centralized type definitions for all enum-like string fields in the database.
 *
 * Since SQLite doesn't support native ENUM types, these string fields use
 * these constants for documentation and runtime validation via Zod.
 *
 * Prisma schema fields reference these as comments.
 */

// ─── User Roles ──────────────────────────────────────────────────────────────
export const UserRole = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  AGENCY_OWNER: 'AGENCY_OWNER',
  AGENCY_STAFF: 'AGENCY_STAFF',
  CUSTOMER: 'CUSTOMER',
} as const
export type UserRole = (typeof UserRole)[keyof typeof UserRole]

// ─── Reservation Status ──────────────────────────────────────────────────────
export const ReservationStatus = {
  WAITING: 'WAITING',
  CALLED: 'CALLED',
  SERVING: 'SERVING',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  NO_SHOW: 'NO_SHOW',
  DEFERRED_OFFLINE: 'DEFERRED_OFFLINE',
} as const
export type ReservationStatus = (typeof ReservationStatus)[keyof typeof ReservationStatus]

// ─── Transaction Status ──────────────────────────────────────────────────────
export const TransactionStatus = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
} as const
export type TransactionStatus = (typeof TransactionStatus)[keyof typeof TransactionStatus]

// ─── Transaction Plan ────────────────────────────────────────────────────────
export const TransactionPlan = {
  BASIC: 'BASIC',
  PREMIUM: 'PREMIUM',
  ENTERPRISE: 'ENTERPRISE',
} as const
export type TransactionPlan = (typeof TransactionPlan)[keyof typeof TransactionPlan]

// ─── Transaction Payment Method ──────────────────────────────────────────────
export const PaymentMethod = {
  CCP: 'CCP',
  BANK_TRANSFER: 'BANK_TRANSFER',
  E_WALLET: 'E_WALLET',
  CASH: 'CASH',
} as const
export type PaymentMethod = (typeof PaymentMethod)[keyof typeof PaymentMethod]

// ─── Agency Subscription Tier ────────────────────────────────────────────────
export const SubscriptionTier = {
  BASIC: 'BASIC',
  PREMIUM: 'PREMIUM',
  ENTERPRISE: 'ENTERPRISE',
} as const
export type SubscriptionTier = (typeof SubscriptionTier)[keyof typeof SubscriptionTier]

// ─── Agency Subscription Status ──────────────────────────────────────────────
export const SubscriptionStatus = {
  ACTIVE: 'ACTIVE',
  INACTIVE: 'INACTIVE',
  TRIAL: 'TRIAL',
  EXPIRED: 'EXPIRED',
  PENDING: 'PENDING',
} as const
export type SubscriptionStatus = (typeof SubscriptionStatus)[keyof typeof SubscriptionStatus]

// ─── Staff Role ──────────────────────────────────────────────────────────────
export const StaffRole = {
  STAFF: 'STAFF',
  MANAGER: 'MANAGER',
  OWNER: 'OWNER',
} as const
export type StaffRole = (typeof StaffRole)[keyof typeof StaffRole]

// ─── Announcement Type ───────────────────────────────────────────────────────
export const AnnouncementType = {
  INFO: 'INFO',
  WARNING: 'WARNING',
  URGENT: 'URGENT',
} as const
export type AnnouncementType = (typeof AnnouncementType)[keyof typeof AnnouncementType]

// ─── FAQ Category ────────────────────────────────────────────────────────────
export const FaqCategory = {
  SUBSCRIPTION: 'SUBSCRIPTION',
  QUEUE: 'QUEUE',
  SMS: 'SMS',
  PAYMENT: 'PAYMENT',
  GENERAL: 'GENERAL',
} as const
export type FaqCategory = (typeof FaqCategory)[keyof typeof FaqCategory]

// ─── Sms Purchase Status ─────────────────────────────────────────────────────
export const SmsPurchaseStatus = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
} as const
export type SmsPurchaseStatus = (typeof SmsPurchaseStatus)[keyof typeof SmsPurchaseStatus]

// ─── Sms Log Status ──────────────────────────────────────────────────────────
export const SmsLogStatus = {
  PENDING: 'PENDING',
  SENT: 'SENT',
  FAILED: 'FAILED',
  DELIVERED: 'DELIVERED',
} as const
export type SmsLogStatus = (typeof SmsLogStatus)[keyof typeof SmsLogStatus]

// ─── User Language ────────────────────────────────────────────────────────────
export const UserLanguage = {
  AR: 'ar',
  EN: 'en',
  FR: 'fr',
} as const
export type UserLanguage = (typeof UserLanguage)[keyof typeof UserLanguage]

// ─── Agency Category ──────────────────────────────────────────────────────────
export const AgencyCategory = {
  CLINIC: 'CLINIC',
  AGENCY: 'AGENCY',
  LAW_FIRM: 'LAW_FIRM',
  LABORATORY: 'LABORATORY',
  GOVERNMENT: 'GOVERNMENT',
  OTHER: 'OTHER',
} as const
export type AgencyCategory = (typeof AgencyCategory)[keyof typeof AgencyCategory]

// ─── Notification Type ────────────────────────────────────────────────────────
export const NotificationType = {
  QUEUE_CALLED: 'QUEUE_CALLED',
  QUEUE_JOINED: 'QUEUE_JOINED',
  QUEUE_COMPLETED: 'QUEUE_COMPLETED',
  QUEUE_CANCELLED: 'QUEUE_CANCELLED',
  QUEUE_POSTPONED: 'QUEUE_POSTPONED',
  QUEUE_TIME_TOGGLE: 'QUEUE_TIME_TOGGLE',
  QUEUE_WAITING: 'QUEUE_WAITING',
  QUEUE_SERVING: 'QUEUE_SERVING',
  QUEUE_NO_SHOW: 'QUEUE_NO_SHOW',
  TURN_APPROACHING: 'TURN_APPROACHING',
  NO_SHOW_WARNING: 'NO_SHOW_WARNING',
  RESERVATION_CANCELLED: 'RESERVATION_CANCELLED',
  RECLAIM_SUCCESS: 'RECLAIM_SUCCESS',
  CANCELLED: 'CANCELLED',
  SMS_PURCHASED: 'SMS_PURCHASED',
  RATING_SUBMITTED: 'RATING_SUBMITTED',
} as const
export type NotificationType = (typeof NotificationType)[keyof typeof NotificationType]

// ─── Audit Log Action ─────────────────────────────────────────────────────────
export const AuditLogAction = {
  LOGIN: 'LOGIN',
  AGENCY_CREATE: 'AGENCY_CREATE',
  AGENCY_DELETE: 'AGENCY_DELETE',
  USER_SUSPEND: 'USER_SUSPEND',
  USER_ACTIVATE: 'USER_ACTIVATE',
  USER_DELETE: 'USER_DELETE',
  SETTINGS_UPDATE: 'SETTINGS_UPDATE',
  QUEUE_CALL: 'QUEUE_CALL',
  QUEUE_JOIN: 'QUEUE_JOIN',
  QUEUE_POSTPONE: 'QUEUE_POSTPONE',
  RESERVATION_CANCEL: 'RESERVATION_CANCEL',
  AUTO_SKIP_NO_SHOW: 'AUTO_SKIP_NO_SHOW',
  RECLAIM_POSITION: 'RECLAIM_POSITION',
  WALK_IN_ADDED: 'WALK_IN_ADDED',
  RATING_SUBMITTED: 'RATING_SUBMITTED',
  PAYMENT_APPROVE: 'PAYMENT_APPROVE',
  PAYMENT_REJECT: 'PAYMENT_REJECT',
} as const
export type AuditLogAction = (typeof AuditLogAction)[keyof typeof AuditLogAction]

// ─── Audit Log Entity Type ────────────────────────────────────────────────────
export const AuditLogEntityType = {
  USER: 'USER',
  AGENCY: 'AGENCY',
  RESERVATION: 'RESERVATION',
  TRANSACTION: 'TRANSACTION',
} as const
export type AuditLogEntityType = (typeof AuditLogEntityType)[keyof typeof AuditLogEntityType]

// ─── SMS Provider ─────────────────────────────────────────────────────────────
export const SmsProvider = {
  ALGERIA_SMS: 'algeria_sms',
  ALGERIA_SMS_HYPHEN: 'algeria-sms',
  GENERIC: 'generic',
} as const
export type SmsProvider = (typeof SmsProvider)[keyof typeof SmsProvider]
