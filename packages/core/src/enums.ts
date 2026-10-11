/**
 * @blasti/core — Centralized type definitions for all enum-like string fields.
 *
 * Re-exported from apps/api/src/lib/enums.ts for shared use across
 * cloud and local modes.
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

// ─── Payment Method ────────────────────────────────────────────────────────
export const PaymentMethod = {
  CCP: 'CCP',
  BANK_TRANSFER: 'BANK_TRANSFER',
  E_WALLET: 'E_WALLET',
  CASH: 'CASH',
} as const
export type PaymentMethod = (typeof PaymentMethod)[keyof typeof PaymentMethod]

// ─── Subscription Tier ───────────────────────────────────────────────────────
export const SubscriptionTier = {
  BASIC: 'BASIC',
  PREMIUM: 'PREMIUM',
  ENTERPRISE: 'ENTERPRISE',
} as const
export type SubscriptionTier = (typeof SubscriptionTier)[keyof typeof SubscriptionTier]

// ─── Subscription Status ────────────────────────────────────────────────────
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

// ─── Announcement Type ──────────────────────────────────────────────────────
export const AnnouncementType = {
  INFO: 'INFO',
  WARNING: 'WARNING',
  URGENT: 'URGENT',
} as const
export type AnnouncementType = (typeof AnnouncementType)[keyof typeof AnnouncementType]

// ─── FAQ Category ──────────────────────────────────────────────────────────
export const FaqCategory = {
  SUBSCRIPTION: 'SUBSCRIPTION',
  QUEUE: 'QUEUE',
  SMS: 'SMS',
  PAYMENT: 'PAYMENT',
  GENERAL: 'GENERAL',
} as const
export type FaqCategory = (typeof FaqCategory)[keyof typeof FaqCategory]

// ─── Notification Type ───────────────────────────────────────────────────────
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

// ─── Sync Record Status ────────────────────────────────────────────────────
export const SyncRecordStatus = {
  CREATED: 'created',
  UPDATED: 'updated',
  DELETED: 'deleted',
} as const
