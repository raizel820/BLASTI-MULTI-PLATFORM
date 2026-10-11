/**
 * RBAC Permission Matrix for BLASTI
 *
 * Defines the complete permission model for the application.
 * Every mutation route MUST check against this matrix before executing.
 *
 * Roles:
 * - SUPER_ADMIN: Full platform administration
 * - AGENCY_OWNER: Owns and manages an agency
 * - AGENCY_STAFF: Staff member of an agency (limited agency access)
 * - CUSTOMER: End user who joins queues
 *
 * Permission levels:
 * - own: Can only affect own resources
 * - agency: Can affect resources within own agency
 * - all: Can affect any resource of this type
 * - none: No access
 */

export type Role = 'SUPER_ADMIN' | 'AGENCY_OWNER' | 'AGENCY_STAFF' | 'CUSTOMER'
export type PermissionLevel = 'own' | 'agency' | 'all' | 'none'

export interface Permission {
  read: PermissionLevel
  write: PermissionLevel
  delete: PermissionLevel
}

/**
 * Complete permission matrix.
 * Each resource maps to a permission per role.
 */
export const PERMISSION_MATRIX: Record<string, Record<Role, Permission>> = {
  // ─── Platform Administration ──────────────────────────────────────────────
  platform: {
    SUPER_ADMIN: { read: 'all', write: 'all', delete: 'all' },
    AGENCY_OWNER: { read: 'none', write: 'none', delete: 'none' },
    AGENCY_STAFF: { read: 'none', write: 'none', delete: 'none' },
    CUSTOMER: { read: 'none', write: 'none', delete: 'none' },
  },

  // ─── User Management ──────────────────────────────────────────────────────
  users: {
    SUPER_ADMIN: { read: 'all', write: 'all', delete: 'all' },
    AGENCY_OWNER: { read: 'own', write: 'own', delete: 'own' },
    AGENCY_STAFF: { read: 'own', write: 'own', delete: 'none' },
    CUSTOMER: { read: 'own', write: 'own', delete: 'own' },
  },

  // ─── Agency Resources ─────────────────────────────────────────────────────
  agencies: {
    SUPER_ADMIN: { read: 'all', write: 'all', delete: 'all' },
    AGENCY_OWNER: { read: 'agency', write: 'agency', delete: 'none' },
    AGENCY_STAFF: { read: 'agency', write: 'none', delete: 'none' },
    CUSTOMER: { read: 'all', write: 'none', delete: 'none' },
  },

  agencyProfile: {
    SUPER_ADMIN: { read: 'all', write: 'all', delete: 'all' },
    AGENCY_OWNER: { read: 'agency', write: 'agency', delete: 'none' },
    AGENCY_STAFF: { read: 'agency', write: 'agency', delete: 'none' },
    CUSTOMER: { read: 'all', write: 'none', delete: 'none' },
  },

  services: {
    SUPER_ADMIN: { read: 'all', write: 'all', delete: 'all' },
    AGENCY_OWNER: { read: 'agency', write: 'agency', delete: 'agency' },
    AGENCY_STAFF: { read: 'agency', write: 'agency', delete: 'agency' },
    CUSTOMER: { read: 'all', write: 'none', delete: 'none' },
  },

  queue: {
    SUPER_ADMIN: { read: 'all', write: 'all', delete: 'all' },
    AGENCY_OWNER: { read: 'agency', write: 'agency', delete: 'agency' },
    AGENCY_STAFF: { read: 'agency', write: 'agency', delete: 'agency' },
    CUSTOMER: { read: 'all', write: 'none', delete: 'none' },
  },

  queueSettings: {
    SUPER_ADMIN: { read: 'all', write: 'all', delete: 'all' },
    AGENCY_OWNER: { read: 'agency', write: 'agency', delete: 'none' },
    AGENCY_STAFF: { read: 'agency', write: 'none', delete: 'none' },
    CUSTOMER: { read: 'none', write: 'none', delete: 'none' },
  },

  staff: {
    SUPER_ADMIN: { read: 'all', write: 'all', delete: 'all' },
    AGENCY_OWNER: { read: 'agency', write: 'agency', delete: 'agency' },
    AGENCY_STAFF: { read: 'agency', write: 'none', delete: 'none' },
    CUSTOMER: { read: 'none', write: 'none', delete: 'none' },
  },

  // ─── Customer Resources ───────────────────────────────────────────────────
  reservations: {
    SUPER_ADMIN: { read: 'all', write: 'all', delete: 'all' },
    AGENCY_OWNER: { read: 'agency', write: 'agency', delete: 'agency' },
    AGENCY_STAFF: { read: 'agency', write: 'agency', delete: 'agency' },
    CUSTOMER: { read: 'own', write: 'own', delete: 'own' },
  },

  reviews: {
    SUPER_ADMIN: { read: 'all', write: 'all', delete: 'all' },
    AGENCY_OWNER: { read: 'agency', write: 'agency', delete: 'none' },
    AGENCY_STAFF: { read: 'agency', write: 'none', delete: 'none' },
    CUSTOMER: { read: 'all', write: 'own', delete: 'own' },
  },

  favorites: {
    SUPER_ADMIN: { read: 'all', write: 'all', delete: 'all' },
    AGENCY_OWNER: { read: 'own', write: 'own', delete: 'own' },
    AGENCY_STAFF: { read: 'own', write: 'own', delete: 'own' },
    CUSTOMER: { read: 'own', write: 'own', delete: 'own' },
  },

  // ─── Notifications ────────────────────────────────────────────────────────
  notifications: {
    SUPER_ADMIN: { read: 'all', write: 'all', delete: 'all' },
    AGENCY_OWNER: { read: 'own', write: 'own', delete: 'own' },
    AGENCY_STAFF: { read: 'own', write: 'own', delete: 'own' },
    CUSTOMER: { read: 'own', write: 'own', delete: 'own' },
  },

  // ─── Admin Resources ──────────────────────────────────────────────────────
  smsSettings: {
    SUPER_ADMIN: { read: 'all', write: 'all', delete: 'all' },
    AGENCY_OWNER: { read: 'none', write: 'none', delete: 'none' },
    AGENCY_STAFF: { read: 'none', write: 'none', delete: 'none' },
    CUSTOMER: { read: 'none', write: 'none', delete: 'none' },
  },

  paymentSettings: {
    SUPER_ADMIN: { read: 'all', write: 'all', delete: 'all' },
    AGENCY_OWNER: { read: 'none', write: 'none', delete: 'none' },
    AGENCY_STAFF: { read: 'none', write: 'none', delete: 'none' },
    CUSTOMER: { read: 'all', write: 'none', delete: 'none' },
  },

  analytics: {
    SUPER_ADMIN: { read: 'all', write: 'none', delete: 'none' },
    AGENCY_OWNER: { read: 'agency', write: 'none', delete: 'none' },
    AGENCY_STAFF: { read: 'agency', write: 'none', delete: 'none' },
    CUSTOMER: { read: 'none', write: 'none', delete: 'none' },
  },

  auditLogs: {
    SUPER_ADMIN: { read: 'all', write: 'none', delete: 'all' },
    AGENCY_OWNER: { read: 'none', write: 'none', delete: 'none' },
    AGENCY_STAFF: { read: 'none', write: 'none', delete: 'none' },
    CUSTOMER: { read: 'none', write: 'none', delete: 'none' },
  },

  transactions: {
    SUPER_ADMIN: { read: 'all', write: 'all', delete: 'all' },
    AGENCY_OWNER: { read: 'agency', write: 'agency', delete: 'none' },
    AGENCY_STAFF: { read: 'none', write: 'none', delete: 'none' },
    CUSTOMER: { read: 'none', write: 'none', delete: 'none' },
  },

  faqs: {
    SUPER_ADMIN: { read: 'all', write: 'all', delete: 'all' },
    AGENCY_OWNER: { read: 'all', write: 'none', delete: 'none' },
    AGENCY_STAFF: { read: 'all', write: 'none', delete: 'none' },
    CUSTOMER: { read: 'all', write: 'none', delete: 'none' },
  },

  announcements: {
    SUPER_ADMIN: { read: 'all', write: 'all', delete: 'all' },
    AGENCY_OWNER: { read: 'all', write: 'none', delete: 'none' },
    AGENCY_STAFF: { read: 'all', write: 'none', delete: 'none' },
    CUSTOMER: { read: 'all', write: 'none', delete: 'none' },
  },
}

/**
 * Check if a role has a specific permission on a resource.
 *
 * @param role - The user's role
 * @param resource - The resource type (e.g., 'agencies', 'reservations')
 * @param action - The action type ('read', 'write', 'delete')
 * @returns The permission level for this role/resource/action combination
 */
export function getPermission(
  role: string,
  resource: string,
  action: 'read' | 'write' | 'delete',
): PermissionLevel {
  const resourcePerms = PERMISSION_MATRIX[resource]
  if (!resourcePerms) return 'none'

  const rolePerms = resourcePerms[role as Role]
  if (!rolePerms) return 'none'

  return rolePerms[action]
}

/**
 * Check if a role can perform a specific action on a resource.
 * Returns true only if the permission level is not 'none'.
 */
export function canAccess(
  role: string,
  resource: string,
  action: 'read' | 'write' | 'delete',
): boolean {
  return getPermission(role, resource, action) !== 'none'
}

/**
 * Get all resources a role can perform a specific action on.
 */
export function getAllowedResources(
  role: string,
  action: 'read' | 'write' | 'delete',
): string[] {
  return Object.entries(PERMISSION_MATRIX)
    .filter(([_, rolePerms]) => {
      const perm = rolePerms[role as Role]
      return perm && perm[action] !== 'none'
    })
    .map(([resource]) => resource)
}
