'use client';

// ─── Task 37-e: agency authority hook ────────────────────────────────────────
//
// Single client-side source of truth for "what is this account allowed to do
// inside its agency?" — backed by GET /api/agency/my-authority (Task 37-c
// contract):
//
//   { success, isOwner, role: 'OWNER'|'MANAGER'|'STAFF'|null, staffId,
//     permissions: { canManageQueue, canManageServices, canManageStaff,
//       canViewAnalytics, canManageBranches, canManageWorkingHours,
//       canExportData, canManageProfile, canCreateBranches, canDeleteBranches,
//       canPurchaseSubscription, canManageSubscription } }
//
// The result is cached in the zustand store (agencyAuthority slice) so every
// consumer — sidebar filtering, page guards, employees page, dashboards —
// shares ONE fetch per session. The cache is cleared by the store itself on
// setSessionToken / logout, so it can never leak across accounts.
//
// FAILURE POLICY (fail open minimally — the server still enforces everything):
//   - AGENCY_OWNER session → OWNER defaults (all permissions true). Owners
//     bypass server-side anyway, so a transient error must not blank their
//     console.
//   - AGENCY_STAFF session → STAFF tier defaults (canManageQueue +
//     canViewAnalytics). A manager's extra sections disappear until the next
//     successful refresh, but the console itself stays usable.
//   - CUSTOMER / SUPER_ADMIN / other roles → no fetch is made at all
//     (SUPER_ADMIN passes every guard by session role).

import { useCallback, useEffect, useRef } from 'react';
import { useAppStore, type AgencyAuthorityRole } from '@/store/use-app-store';
import { apiFetch } from '@/lib/api-fetch';

// ─── Types ──────────────────────────────────────────────────────────────────

export type { AgencyAuthorityRole };

/** All 12 permission keys the my-authority endpoint can report. */
export const STAFF_PERMISSION_KEYS = [
  'canManageQueue',
  'canManageServices',
  'canManageStaff',
  'canViewAnalytics',
  'canManageBranches',
  'canManageWorkingHours',
  'canExportData',
  'canManageProfile',
  'canCreateBranches',
  'canDeleteBranches',
  'canPurchaseSubscription',
  'canManageSubscription',
] as const;

export type StaffPermissionKey = (typeof STAFF_PERMISSION_KEYS)[number];

export type AgencyAuthorityPermissions = Record<StaffPermissionKey, boolean>;

export interface AgencyAuthority {
  isOwner: boolean;
  role: AgencyAuthorityRole;
  staffId: string | null;
  permissions: AgencyAuthorityPermissions;
  loadedAt: number;
}

interface MyAuthorityResponse {
  success?: boolean;
  isOwner?: boolean;
  role?: AgencyAuthorityRole;
  staffId?: string | null;
  permissions?: Record<string, boolean>;
}

// ─── Defaults ───────────────────────────────────────────────────────────────

function allPermissions(value: boolean): AgencyAuthorityPermissions {
  const out = {} as AgencyAuthorityPermissions;
  for (const key of STAFF_PERMISSION_KEYS) out[key] = value;
  return out;
}

/** STAFF tier defaults — queue + analytics only (mirrors tierDefaultsForRole). */
export const STAFF_TIER_DEFAULTS: AgencyAuthorityPermissions = {
  ...allPermissions(false),
  canManageQueue: true,
  canViewAnalytics: true,
};

/** MANAGER tier grants — STAFF tier + the 5 business-management authorities. */
export const MANAGER_TIER_DEFAULTS: AgencyAuthorityPermissions = {
  ...STAFF_TIER_DEFAULTS,
  canCreateBranches: true,
  canDeleteBranches: true,
  canPurchaseSubscription: true,
  canManageSubscription: true,
  canManageProfile: true,
};

/** Fail-open fallback for a session role when my-authority cannot be fetched. */
export function fallbackAuthorityForRole(role: string | null | undefined): AgencyAuthority {
  if (role === 'AGENCY_OWNER' || role === 'SUPER_ADMIN') {
    return {
      isOwner: true,
      role: 'OWNER',
      staffId: null,
      permissions: allPermissions(true),
      loadedAt: Date.now(),
    };
  }
  return {
    isOwner: false,
    role: 'STAFF',
    staffId: null,
    permissions: { ...STAFF_TIER_DEFAULTS },
    loadedAt: Date.now(),
  };
}

function normalizePermissions(raw: unknown): AgencyAuthorityPermissions {
  const out = {} as AgencyAuthorityPermissions;
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  for (const key of STAFF_PERMISSION_KEYS) out[key] = source[key] === true;
  return out;
}

// ─── Hook ───────────────────────────────────────────────────────────────────

export interface UseAgencyAuthorityResult {
  /** Cached authority (null until the first fetch lands). */
  authority: AgencyAuthority | null;
  /** True while the first fetch for this session is in flight. */
  loading: boolean;
  /** Force a refetch (also clears the fail-open fallback). */
  refresh: () => Promise<void>;
  /** Permission check — owners always true; unknown/false otherwise. */
  has: (permission: StaffPermissionKey) => boolean;
}

export function useAgencyAuthority(): UseAgencyAuthorityResult {
  const user = useAppStore((s) => s.user);
  const cached = useAppStore((s) => s.agencyAuthority);
  const setAgencyAuthority = useAppStore((s) => s.setAgencyAuthority);
  const inFlightRef = useRef(false);

  const role = user?.role ?? null;

  // Adapt the store slice (loose Record<string, boolean> permissions) into the
  // hook's typed shape. Cheap per-render mapping, no effect on consumers.
  const authority: AgencyAuthority | null = cached
    ? {
        isOwner: cached.isOwner,
        role: cached.role,
        staffId: cached.staffId,
        permissions: normalizePermissions(cached.permissions),
        loadedAt: cached.loadedAt,
      }
    : null;

  const fetchAuthority = useCallback(async () => {
    // Only agency members carry an agency authority. Customers / admins never
    // fetch (their sidebars and guards don't consume this matrix).
    if (role !== 'AGENCY_OWNER' && role !== 'AGENCY_STAFF') return;
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const res = await apiFetch('/api/agency/my-authority', { method: 'GET' });
      if (res.ok) {
        const data = (await res.json()) as MyAuthorityResponse;
        setAgencyAuthority({
          isOwner: data.isOwner === true,
          role: (data.role ?? null) as AgencyAuthorityRole,
          staffId: typeof data.staffId === 'string' ? data.staffId : null,
          permissions: normalizePermissions(data.permissions),
          loadedAt: Date.now(),
        });
      } else {
        // Non-2xx (offline / 401 / 500) → fail open minimally by session role.
        setAgencyAuthority(fallbackAuthorityForRole(role));
      }
    } catch {
      setAgencyAuthority(fallbackAuthorityForRole(role));
    } finally {
      inFlightRef.current = false;
    }
  }, [role, setAgencyAuthority]);

  const refresh = useCallback(async () => {
    await fetchAuthority();
  }, [fetchAuthority]);

  // Lazily fetch once per session: only when the cache is empty. Cleared by
  // setSessionToken/logout, so a fresh session refetches automatically.
  useEffect(() => {
    if (!cached && (role === 'AGENCY_OWNER' || role === 'AGENCY_STAFF')) {
      fetchAuthority();
    }
  }, [cached, role, fetchAuthority]);

  const has = useCallback(
    (permission: StaffPermissionKey): boolean => {
      if (role === 'SUPER_ADMIN') return true;
      if (!cached) return false;
      if (cached.isOwner) return true;
      return cached.permissions?.[permission] === true;
    },
    [role, cached]
  );

  return { authority, loading: !cached && (role === 'AGENCY_OWNER' || role === 'AGENCY_STAFF'), refresh, has };
}

// ─── Shared access matrix (sidebar + page guards) ───────────────────────────
//
//   AGENCY_OWNER / SUPER_ADMIN → everything (unchanged).
//   MANAGER  → dashboard + history always; branches when ANY branch authority;
//              subscription when a purchase/subscription authority; profile +
//              settings when canManageProfile; devices/reviews/employees never.
//   STAFF    → dashboard + history only.
//   CUSTOMER / other roles → unrestricted here (they never reach agency views
//              through the normal flow; existing role checks still apply).
//
// `authority === null` (still loading / fetch failed before fallback lands)
// returns TRUE so the pre-authority UI stays on screen — no flicker, no blank
// console. The server still enforces the authoritative gate on every route.

export type AgencySectionView =
  | 'agency-dashboard'
  | 'agency-history'
  | 'agency-employees'
  | 'agency-branches'
  | 'agency-devices'
  | 'agency-reviews'
  | 'agency-settings'
  | 'agency-profile'
  | 'agency-subscription';

export function canAccessAgencySection(
  view: AgencySectionView,
  authority: AgencyAuthority | null,
  sessionRole: string | null | undefined
): boolean {
  // Owner-tier sessions (and everything non-agency) pass — unchanged behavior.
  if (sessionRole !== 'AGENCY_STAFF') return true;
  if (!authority) return true; // loading / transient — keep previous behavior
  if (authority.isOwner || authority.role === 'OWNER') return true;

  const has = (key: StaffPermissionKey) => authority.permissions?.[key] === true;

  if (authority.role === 'MANAGER') {
    switch (view) {
      case 'agency-dashboard':
      case 'agency-history':
        return true;
      case 'agency-branches':
        return has('canCreateBranches') || has('canDeleteBranches') || has('canManageBranches');
      case 'agency-subscription':
        return has('canPurchaseSubscription') || has('canManageSubscription');
      case 'agency-profile':
      case 'agency-settings':
        return has('canManageProfile');
      default:
        return false; // devices / reviews / employees are owner-only
    }
  }

  // Plain STAFF (or unknown role) → dashboard + history only.
  return view === 'agency-dashboard' || view === 'agency-history';
}
