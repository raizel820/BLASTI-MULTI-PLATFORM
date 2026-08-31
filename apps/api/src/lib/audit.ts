/**
 * Audit Logging Module for BLASTI
 *
 * Provides structured audit logging for all sensitive actions.
 * Every mutation that modifies data should create an audit log entry.
 *
 * Usage:
 *   import { auditLog } from '@/lib/audit'
 *   await auditLog.userAction(userId, 'AGENCY_CREATE', 'AGENCY', agencyId, { name, customCode })
 */

import { db } from '@blasti/db'

export type AuditAction =
  | 'AGENCY_CREATE' | 'AGENCY_UPDATE' | 'AGENCY_DELETE'
  | 'SERVICE_CREATE' | 'SERVICE_UPDATE' | 'SERVICE_DELETE'
  | 'STAFF_CREATE' | 'STAFF_UPDATE' | 'STAFF_DELETE'
  | 'QUEUE_JOIN' | 'QUEUE_CALL' | 'QUEUE_CANCEL' | 'QUEUE_COMPLETE'
  | 'QUEUE_PAUSE' | 'QUEUE_RESUME' | 'QUEUE_SKIP' | 'QUEUE_RECLAIM'
  | 'RESERVATION_CANCEL' | 'RESERVATION_POSTPONE' | 'RESERVATION_RATE'
  | 'REVIEW_CREATE' | 'REVIEW_REPLY' | 'REVIEW_DELETE'
  | 'USER_CREATE' | 'USER_UPDATE' | 'USER_DELETE' | 'USER_SUSPEND' | 'USER_ACTIVATE'
  | 'PASSWORD_RESET' | 'PASSWORD_CHANGE'
  | 'SETTINGS_UPDATE' | 'SMS_SETTINGS_UPDATE' | 'PAYMENT_SETTINGS_UPDATE'
  | 'SUBSCRIPTION_PAY' | 'SUBSCRIPTION_APPROVE' | 'SUBSCRIPTION_REJECT'
  | 'FAVORITE_ADD' | 'FAVORITE_REMOVE'
  | 'SMS_PURCHASE' | 'SMS_SEND'
  | 'ANNOUNCEMENT_CREATE' | 'ANNOUNCEMENT_DELETE'
  | 'FAQ_CREATE' | 'FAQ_UPDATE' | 'FAQ_DELETE'
  | 'RATING_SUBMITTED' | 'RECLAIM_POSITION'

export type EntityType =
  | 'USER' | 'AGENCY' | 'SERVICE' | 'RESERVATION'
  | 'REVIEW' | 'QUEUE_SETTINGS' | 'SMS_SETTINGS' | 'PAYMENT_SETTINGS'
  | 'TRANSACTION' | 'ANNOUNCEMENT' | 'FAQ' | 'STAFF'

interface AuditLogEntry {
  userId: string
  action: AuditAction | string
  entityType: EntityType | string
  entityId: string
  details?: Record<string, unknown>
  ipAddress?: string
}

/**
 * Centralized audit logging helper.
 * Creates structured audit log entries in the database.
 */
export const auditLog = {
  /**
   * Log a user action with full context.
   */
  async userAction(entry: AuditLogEntry): Promise<void> {
    try {
      await db.auditLog.create({
        data: {
          userId: entry.userId,
          action: entry.action,
          entityType: entry.entityType,
          entityId: entry.entityId,
          details: entry.details ? JSON.stringify(entry.details) : null,
        },
      })
    } catch (error) {
      // Audit logging should never crash the request
      console.error('[AUDIT] Failed to create audit log:', error)
    }
  },

  /**
   * Log a data creation event.
   */
  async created(
    userId: string,
    entityType: EntityType | string,
    entityId: string,
    details?: Record<string, unknown>,
  ): Promise<void> {
    await auditLog.userAction({ userId, action: `${entityType}_CREATE` as AuditAction, entityType, entityId, details })
  },

  /**
   * Log a data update event.
   */
  async updated(
    userId: string,
    entityType: EntityType | string,
    entityId: string,
    details?: Record<string, unknown>,
  ): Promise<void> {
    await auditLog.userAction({ userId, action: `${entityType}_UPDATE` as AuditAction, entityType, entityId, details })
  },

  /**
   * Log a data deletion event.
   */
  async deleted(
    userId: string,
    entityType: EntityType | string,
    entityId: string,
    details?: Record<string, unknown>,
  ): Promise<void> {
    await auditLog.userAction({ userId, action: `${entityType}_DELETE` as AuditAction, entityType, entityId, details })
  },
}
