/**
 * Zod validation schemas for API write endpoints.
 *
 * Every POST/PUT/PATCH/DELETE endpoint should validate its input
 * against these schemas before processing.
 */
import { z } from 'zod'

// ─── Auth ────────────────────────────────────────────────────────────────────

export const loginSchema = z.object({
  username: z.string().min(1, 'Username is required'),
  password: z.string().min(1, 'Password is required'),
  expectedRole: z.enum(['CUSTOMER', 'AGENCY_OWNER', 'AGENCY_STAFF', 'SUPER_ADMIN']).optional(),
})

export const registerSchema = z.object({
  username: z.string().min(3, 'Username must be at least 3 characters').max(30),
  fullName: z.string().min(1, 'Full name is required').max(100),
  password: z.string().min(6, 'Password must be at least 6 characters').max(128),
  phoneNumber: z.string().optional(),
  role: z.enum(['CUSTOMER', 'AGENCY_OWNER']).optional().default('CUSTOMER'),
  agencyCode: z.string().optional(),
  avatarUrl: z.string().url().optional().or(z.literal('')),
})

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z.string().min(6, 'New password must be at least 6 characters').max(128),
})

// ─── User Profile ────────────────────────────────────────────────────────────

export const updateProfileSchema = z.object({
  fullName: z.string().min(1).max(100).optional(),
  phoneNumber: z.string().optional(),
  language: z.enum(['en', 'ar', 'fr']).optional(),
  avatarUrl: z.string().url().optional().or(z.literal('')),
  notificationPreferences: z.record(z.string(), z.boolean()).optional(),
  reminderMinutes: z.number().int().min(1).max(1440).optional(),
  smsNotificationsEnabled: z.boolean().optional(),
})

export const updatePreferencesSchema = z.object({
  language: z.enum(['en', 'ar', 'fr']).optional(),
  notificationsEnabled: z.boolean().optional(),
  smsNotificationsEnabled: z.boolean().optional(),
  emailNotificationsEnabled: z.boolean().optional(),
})

// ─── Reservations ────────────────────────────────────────────────────────────

export const createReservationSchema = z.object({
  agencyId: z.string().min(1, 'Agency ID is required'),
  serviceId: z.string().optional(),
  preferredTime: z.string().optional(),
  reservedDate: z.string().optional(),
  fixedTimeEnabled: z.boolean().optional(),
  userId: z.string().optional(),
})

export const updateReservationStatusSchema = z.object({
  status: z.enum(['WAITING', 'CALLED', 'SERVING', 'COMPLETED', 'CANCELLED', 'NO_SHOW']),
})

export const postponeReservationSchema = z.object({
  reason: z.string().optional(),
})

export const rateReservationSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(500).optional(),
})

// ─── Agency ──────────────────────────────────────────────────────────────────

export const updateAgencyProfileSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  nameAr: z.string().optional(),
  nameFr: z.string().optional(),
  description: z.string().max(500).optional(),
  descriptionAr: z.string().max(500).optional(),
  descriptionFr: z.string().max(500).optional(),
  address: z.string().max(200).optional(),
  phone: z.string().max(20).optional(),
  category: z.string().optional(),
  website: z.string().url().optional().or(z.literal('')),
})

export const updateAgencySettingsSchema = z.object({
  maxQueueSize: z.number().int().min(1).max(1000).optional(),
  avgServiceTime: z.number().int().min(1).max(480).optional(),
})

export const createServiceSchema = z.object({
  name: z.string().min(1, 'Service name is required').max(100),
  nameAr: z.string().optional(),
  nameFr: z.string().optional(),
  description: z.string().max(300).optional(),
  isActive: z.boolean().optional().default(true),
})

export const updateServiceSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  nameAr: z.string().optional(),
  nameFr: z.string().optional(),
  description: z.string().max(300).optional(),
  isActive: z.boolean().optional(),
})

// ─── Staff ───────────────────────────────────────────────────────────────────

export const createStaffSchema = z.object({
  username: z.string().min(3).max(30),
  fullName: z.string().min(1).max(100),
  password: z.string().min(6).max(128),
  phoneNumber: z.string().optional(),
  role: z.enum(['STAFF', 'MANAGER']).optional().default('STAFF'),
})

export const updateStaffSchema = z.object({
  fullName: z.string().min(1).max(100).optional(),
  phoneNumber: z.string().optional(),
  role: z.enum(['STAFF', 'MANAGER']).optional(),
  isActive: z.boolean().optional(),
})

// ─── Admin ───────────────────────────────────────────────────────────────────

export const adminUserActionSchema = z.object({
  userId: z.string().min(1, 'User ID is required'),
  action: z.enum(['suspend', 'activate', 'delete']),
})

export const adminResetPasswordSchema = z.object({
  newPassword: z.string().min(6, 'Password must be at least 6 characters').max(128),
})

export const adminCreateAgencySchema = z.object({
  name: z.string().min(1).max(100),
  nameAr: z.string().optional(),
  nameFr: z.string().optional(),
  description: z.string().max(500).optional(),
  address: z.string().max(200).optional(),
  phone: z.string().max(20).optional(),
  email: z.string().optional(),
  category: z.string().default('OTHER'),
  ownerId: z.string().optional(), // Optional: derived from session for non-SUPER_ADMIN
  customCode: z.string().min(2).max(10).optional(),
})

export const adminUpdateAgencySchema = z.object({
  name: z.string().min(1).max(100).optional(),
  nameAr: z.string().optional(),
  nameFr: z.string().optional(),
  description: z.string().max(500).optional(),
  address: z.string().max(200).optional(),
  phone: z.string().max(20).optional(),
  category: z.string().optional(),
  isActive: z.boolean().optional(),
  ownerId: z.string().optional(),
  customCode: z.string().min(2).max(10).optional(),
})

// ─── SMS Settings ────────────────────────────────────────────────────────────

export const smsSettingsSchema = z.object({
  provider: z.enum(['winsms', 'notifsend', 'algeria_sms', 'green_send', 'mtarget', 'twilio', 'vonage', 'generic']).optional(),
  apiUrl: z.string().url().optional().or(z.literal('')),
  apiKey: z.string().optional(),
  senderName: z.string().max(11).optional(),
  enabled: z.boolean().optional(),
  templateTurnApproaching: z.string().max(500).optional(),
  templateYourTurn: z.string().max(500).optional(),
  templateNoShow: z.string().max(500).optional(),
  templateCustom: z.string().max(500).optional(),
})

// ─── Payment Settings ────────────────────────────────────────────────────────

export const paymentSettingsSchema = z.object({
  ccpEnabled: z.boolean().optional(),
  bankEnabled: z.boolean().optional(),
  electronicEnabled: z.boolean().optional(),
  ccpAccount: z.string().max(30).optional(),
  ccpKey: z.string().max(10).optional(),
  bankName: z.string().max(100).optional(),
  bankAccount: z.string().max(30).optional(),
  bankRib: z.string().max(30).optional(),
  ewalletNumber: z.string().max(30).optional(),
})

// ─── Notifications ───────────────────────────────────────────────────────────

export const markReadSchema = z.object({
  notificationIds: z.array(z.string()).min(1).optional(),
})

// ─── Reviews ─────────────────────────────────────────────────────────────────

export const createReviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(500).optional(),
})

export const replyToReviewSchema = z.object({
  reply: z.string().min(1, 'Reply is required').max(500),
})

// ─── FAQ ─────────────────────────────────────────────────────────────────────

export const faqSchema = z.object({
  question: z.string().min(1, 'Question is required').max(300),
  answer: z.string().min(1, 'Answer is required').max(1000),
  questionAr: z.string().optional(),
  answerAr: z.string().optional(),
  questionFr: z.string().optional(),
  answerFr: z.string().optional(),
  category: z.string().optional(),
  isActive: z.boolean().optional().default(true),
  order: z.number().int().min(0).optional(),
})

// ─── Branch ──────────────────────────────────────────────────────────────────

export const createBranchSchema = z.object({
  name: z.string().min(1, 'Branch name is required').max(100),
  nameAr: z.string().optional(),
  nameFr: z.string().optional(),
  address: z.string().max(200).optional(),
  phone: z.string().max(20).optional(),
  isMain: z.boolean().optional().default(false),
})

export const updateBranchSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  nameAr: z.string().optional(),
  nameFr: z.string().optional(),
  address: z.string().max(200).optional(),
  phone: z.string().max(20).optional(),
  isActive: z.boolean().optional(),
  isMain: z.boolean().optional(),
})

// ─── Counter ─────────────────────────────────────────────────────────────────

export const createCounterSchema = z.object({
  number: z.number().int().min(1),
  name: z.string().min(1, 'Counter name is required').max(50),
  nameAr: z.string().optional(),
  nameFr: z.string().optional(),
})

export const updateCounterSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  nameAr: z.string().optional(),
  nameFr: z.string().optional(),
  isActive: z.boolean().optional(),
  staffId: z.string().nullable().optional(),
})

// ─── Kiosk ──────────────────────────────────────────────────────────────────

export const kioskJoinSchema = z.object({
  agencyId: z.string().min(1, 'Agency ID is required'),
  serviceId: z.string().min(1, 'Service ID is required'),
  customerName: z.string().max(100).optional(),
})

// ─── Announcements ───────────────────────────────────────────────────────────

export const createAnnouncementSchema = z.object({
  agencyId: z.string().min(1, 'Agency ID is required'),
  message: z.string().min(1, 'Message is required').max(500),
  type: z.enum(['INFO', 'WARNING', 'URGENT']).optional().default('INFO'),
  expiresAt: z.string().optional(), // ISO date string
})

// ─── Subscription ────────────────────────────────────────────────────────────

export const subscriptionPaySchema = z.object({
  plan: z.enum(['PREMIUM', 'PRO'], { message: 'Plan must be PREMIUM or PRO' }),
  method: z.enum(['CCP', 'BANK', 'ELECTRONIC'], { message: 'Payment method must be CCP, BANK, or ELECTRONIC' }),
  receiptUrl: z.string().max(500).optional(),
})

export const subscriptionUnsubscribeSchema = z.object({
  agencyId: z.string().optional(),
})

// ─── Working Hours ───────────────────────────────────────────────────────────

const timeFormatRegex = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/

export const updateWorkingHoursSchema = z.object({
  agencyId: z.string().min(1, 'Agency ID is required'),
  workingHoursStart: z.string().regex(timeFormatRegex, 'Invalid time format. Use HH:MM').optional(),
  workingHoursEnd: z.string().regex(timeFormatRegex, 'Invalid time format. Use HH:MM').optional(),
})

// ─── Device Registration ────────────────────────────────────────────────────

export const deviceRegistrationSchema = z.object({
  platform: z.enum(['web', 'electron', 'android', 'ios'], {
    message: 'Invalid platform. Must be one of: web, electron, android, ios',
  }),
  deviceId: z.string().min(1, 'Device ID is required').max(200),
  deviceToken: z.string().max(500).optional(),
  appVersion: z.string().max(50).optional(),
  deviceFingerprint: z.string().max(200).optional(),
})

// ─── Helpers ─────────────────────────────────────────────────────────────────

import { NextResponse } from 'next/server'

/**
 * Validates request body against a Zod schema.
 * Returns parsed data or a 400 error response.
 */
export function validateBody<T extends z.ZodType>(
  schema: T,
  body: unknown
): { data: z.infer<T>; error: null } | { data: null; error: NextResponse } {
  const result = schema.safeParse(body)
  if (result.success) {
    return { data: result.data as z.infer<T>, error: null }
  }
  const zodErr = result.error
  const firstError = zodErr.issues[0]
  return {
    data: null,
    error: NextResponse.json(
      {
        success: false,
        error: firstError?.message || 'Validation error',
        details: zodErr.issues.map((e: z.ZodIssue) => ({
          field: e.path.join('.'),
          message: e.message,
        })),
      },
      { status: 400 }
    ),
  }
}
