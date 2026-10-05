'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { useAppStore } from '@/store/use-app-store';
import { unwrapListPayload } from '@/lib/list-payload';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import {
  MapPin,
  Plus,
  Monitor,
  Edit3,
  Trash2,
  ChevronDown,
  UserCheck,
  Loader2,
  Building2,
  Star,
  Phone,
  UserX,
  Users,
  Power,
  Crown,
  Lock,
  RefreshCw,
  AlertTriangle,
  QrCode,
  Copy,
  Download,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api-fetch';
import { getApiBaseUrl, isElectronRuntime } from '@/lib/api-client';
import { useSubscriptionActive } from '@/hooks/use-subscription';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import QRCode from 'qrcode';
// Task 83-b — branch location picker + Algeria address selectors (same
// shared components the create-agency wizard and agency profile use).
import { MapLocationPicker, type GeocodeComponents } from '@/components/shared/map/map-location-picker';
import { WilayaSelect, CommuneSelect } from '@/components/shared/algeria-location-selects';
import { ALGERIA_WILAYAS, findWilayaByCode } from '@/lib/algeria-locations';

// Types
interface Branch {
  id: string;
  name: string;
  nameAr?: string | null;
  nameFr?: string | null;
  // Task 83-b — customer-facing display name + generated sub code
  // ("<AGYCODE>-M1" / "<AGYCODE>-B<n>", backend Task 83-a).
  specialName?: string | null;
  subCode?: string | null;
  address?: string | null;
  phone?: string | null;
  isActive: boolean;
  isMain: boolean;
  agencyId: string;
  createdAt: string;
  // Task 83-b — canonical location fields (backend Task 83-a). Optional so
  // rows from older local-API builds keep rendering.
  latitude?: number | null;
  longitude?: number | null;
  city?: string | null;
  wilaya?: string | null;
  postalCode?: string | null;
  locationVerified?: string | null;
  locationSource?: string | null;
  _count?: { counters: number; staff: number };
}

// ─── Task 83-b — tolerant wilaya helpers (client-side copies of the proven
// create-agency-form.tsx logic; server code is NOT imported on purpose) ─────

/** Official two-digit ANI wilaya codes 01-58. */
const BRANCH_WILAYA_CODE_REGEX = /^(0[1-9]|[1-4][0-9]|5[0-8])$/;

/** Fold a Latin name for comparison: strip diacritics (NFD + combining
 * marks), lowercase, keep [a-z0-9] only — "Sétif" ≍ "Setif". */
const foldLatinName = (v: string): string =>
  v
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/** Match a geocoded wilaya name (Latin OR Arabic — the geocoder answers in
 * the UI language) to the official dataset. Digit input ("19", "١٩") maps to
 * the canonical two-digit code. No match → null: never invent a wilaya. */
const branchWilayaCodeFromGeocodeName = (name: string | null): string | null => {
  if (!name) return null;
  const raw = name.trim();
  if (!raw) return null;
  const mapped = raw
    .replace(/[\u0660-\u0669]/g, (ch) => String(ch.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (ch) => String(ch.charCodeAt(0) - 0x06F0));
  const digits = mapped.replace(/\D/g, '');
  if (digits.length >= 1 && digits.length <= 2) {
    const code = digits.padStart(2, '0');
    return BRANCH_WILAYA_CODE_REGEX.test(code) ? code : null;
  }
  const qLatin = foldLatinName(mapped.replace(/wilaya/gi, '').replace(/\bde\b\s*/i, ''));
  const qArabic = mapped.replace(/ولاية/g, '').replace(/\s/g, '');
  if (!qLatin && !qArabic) return null;
  const hit = ALGERIA_WILAYAS.find((w) => {
    const latin = foldLatinName(w.name);
    const arabic = w.nameAr.replace(/ولاية/g, '').replace(/\s/g, '');
    return (qLatin !== '' && latin === qLatin) || (qArabic !== '' && arabic === qArabic);
  });
  return hit ? hit.code : null;
};

// Task 40 (round 4): the recurring "branches created but the desktop shows
// none" report traced every time to the renderer talking to a STALE embedded
// local API (an old installed bundle, or an old tray-resident instance that
// still owns :3080). The current local API answers /api/health with a build
// identity (service + version — Task 42). Probe it once on Electron and warn
// inline when the running server predates the first build carrying every
// branch-list fix, so the exact screen with the symptom self-identifies the
// stale server instead of showing a misleading "no branches yet".
//
// Task 45: raised to 0.3.0 — the first build carrying the Task 44 batch
// (READY-workspace empty-core self-heal, explicit cloud sync-capture,
// deterministic agency resolvers). Every fix before this shipped while the
// package version stayed 0.2.1, which made a pre-fix :3080 INDISTINGUISHABLE
// from a current one — the exact reason "restart the app" kept failing to
// verify. A 0.2.1 server is now flagged stale by name.
const MIN_LOCAL_API_VERSION = '0.3.0';

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

interface CounterWithStaff {
  id: string;
  number: number;
  name: string;
  nameAr?: string | null;
  nameFr?: string | null;
  isActive: boolean;
  branchId: string;
  staffId?: string | null;
  staff?: { id: string; user: { fullName: string; username: string } } | null;
  currentReservation?: { id: string; displayNumber: string; status: string } | null;
  currentReservationId?: string | null;
}

interface StaffMember {
  id: string;
  role: string;
  user: { fullName: string; username: string; isActive: boolean };
  branchId?: string | null;
}

export function AgencyBranches() {
  const { user } = useAppStore();
  const { t, lang } = useLanguage();
  const agencyId = user?.agencyId;

  // Task 31 bug 5: branch/counter creation is a paid feature. isActive stays
  // true until a concrete INACTIVE/TRIAL-less status arrives (offline-first),
  // and the server enforces the authoritative gate.
  const { isActive: subscriptionActive } = useSubscriptionActive(agencyId);

  // State
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(true);
  // Task 37-a: list-load failures used to be swallowed (non-ok responses left
  // an empty list that looked like "no branches"). Track the error and offer
  // a retry instead.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expandedBranch, setExpandedBranch] = useState<string | null>(null);
  const [counters, setCounters] = useState<CounterWithStaff[]>([]);
  const [countersLoading, setCountersLoading] = useState(false);
  const [staffList, setStaffList] = useState<StaffMember[]>([]);

  // Branch dialog
  const [branchDialogOpen, setBranchDialogOpen] = useState(false);
  const [editingBranch, setEditingBranch] = useState<Branch | null>(null);
  const [branchName, setBranchName] = useState('');
  const [branchNameAr, setBranchNameAr] = useState('');
  const [branchNameFr, setBranchNameFr] = useState('');
  const [branchAddress, setBranchAddress] = useState('');
  const [branchPhone, setBranchPhone] = useState('');
  const [branchIsMain, setBranchIsMain] = useState(false);
  // Task 83-b — special name + location form state. Location is REQUIRED at
  // creation (backend 83-a 400s without lat+lng); in edit mode lat/lng are
  // sent together only when either changed (server pair rule).
  const [branchSpecialName, setBranchSpecialName] = useState('');
  const [branchLatitude, setBranchLatitude] = useState<number | null>(null);
  const [branchLongitude, setBranchLongitude] = useState<number | null>(null);
  const [branchWilayaCode, setBranchWilayaCode] = useState('');
  const [branchCity, setBranchCity] = useState('');
  const [branchPostalCode, setBranchPostalCode] = useState('');
  const [branchLocationSource, setBranchLocationSource] = useState<'GOOGLE' | 'OPENFREEMAP' | 'MANUAL' | 'DEVICE_GPS' | null>(null);
  const [branchSaving, setBranchSaving] = useState(false);

  // Counter dialog
  const [counterDialogOpen, setCounterDialogOpen] = useState(false);
  const [editingCounter, setEditingCounter] = useState<CounterWithStaff | null>(null);
  const [counterNumber, setCounterNumber] = useState(1);
  const [counterName, setCounterName] = useState('');
  const [counterNameAr, setCounterNameAr] = useState('');
  const [counterNameFr, setCounterNameFr] = useState('');
  const [counterSaving, setCounterSaving] = useState(false);

  // Delete dialog
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletingItem, setDeletingItem] = useState<{ type: 'branch' | 'counter'; id: string; name: string } | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  // Staff assignment
  const [assigningCounterId, setAssigningCounterId] = useState<string | null>(null);

  // Toggle loading states
  const [togglingBranchId, setTogglingBranchId] = useState<string | null>(null);
  const [togglingCounterId, setTogglingCounterId] = useState<string | null>(null);

  // Task 83-b — per-branch QR dialog (client-side generated SVG).
  const [qrBranch, setQrBranch] = useState<Branch | null>(null);
  const [qrSvg, setQrSvg] = useState<string | null>(null);
  const [qrLoading, setQrLoading] = useState(false);

  // Stale-local-API awareness (see MIN_LOCAL_API_VERSION note). null = probe
  // still running / not Electron / probe failed — never blocks the UI, and a
  // server that is simply DOWN is surfaced by the load error path instead.
  const [localApiStale, setLocalApiStale] = useState<{ version: string | null } | null>(null);

  // Task 45: post-create consistency verification. When a create returns 201
  // the row MUST appear in the very next list fetch of the SAME server (the
  // local write + outbox row commit atomically — proven by the Task 45 HTTP
  // harness). If it does NOT, the renderer is talking to a server whose
  // behavior diverges from its own create — an old/mismatched :3080 instance.
  // Instead of the historical silent "no branches yet", say exactly that,
  // enriched with the server's workspace identity (Task 45 /api/health).
  const pendingVerifyIdRef = useRef<string | null>(null);
  const divergenceNameRef = useRef<string>('');
  const [createDivergence, setCreateDivergence] = useState<{
    createdName: string;
    serverBranchCount: number | null;
    serverAgencyId: string | null;
    serverStatus: string | null;
  } | null>(null);

  // Task 45: enrich the divergence alert with the server's own view of the
  // workspace (/api/health workspace identity — Task 45). Server simply old
  // (no workspace field) → nulls; the alert text degrades gracefully.
  const probeWorkspaceForDivergence = useCallback(async () => {
    if (!isElectronRuntime()) return;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3500);
      const res = await fetch(`${getApiBaseUrl()}/api/health`, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) return; // keep the alert with unknown server detail
      const data = await res.json().catch(() => null);
      const ws = data && typeof data === 'object'
        ? (data as { workspace?: { agencyId?: string; status?: string; branchCount?: number } }).workspace
        : undefined;
      if (!ws || typeof ws !== 'object') return;
      setCreateDivergence((prev) => prev
        ? {
            ...prev,
            serverBranchCount: typeof ws.branchCount === 'number' ? ws.branchCount : null,
            serverAgencyId: typeof ws.agencyId === 'string' ? ws.agencyId : null,
            serverStatus: typeof ws.status === 'string' ? ws.status : null,
          }
        : prev);
    } catch { /* keep the alert with unknown server detail */ }
  }, []);

  useEffect(() => {
    if (!isElectronRuntime()) return;
    let cancelled = false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    fetch(`${getApiBaseUrl()}/api/health`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) return null;
        return res.json().catch(() => null);
      })
      .then((data: { service?: string; version?: string | null } | null) => {
        if (cancelled || !data || typeof data !== 'object') return;
        const version = typeof data.version === 'string' ? data.version : null;
        // A server that answers but carries NO version identity predates the
        // Task 42 build stamp — stale. A version older than the first build
        // with every branch-list fix is stale too. Anything else is current.
        if (data.service === 'blasti-local-api' && version && compareSemver(version, MIN_LOCAL_API_VERSION) >= 0) {
          return;
        }
        setLocalApiStale({ version });
      })
      .catch(() => {
        /* server unreachable / aborted — other flows already surface that */
      })
      .finally(() => clearTimeout(timer));
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  const fetchBranches = useCallback(async (): Promise<Branch[]> => {
    if (!agencyId) {
      // Task 40: a user object without agencyId (stale session snapshot from
      // an older build, or a cloud login whose response predates the local
      // agency hydration) used to leave `loading` true forever — an endless
      // skeleton — or, after other state churn, an unexplained "no branches
      // yet". Surface an actionable error with a retry instead.
      setBranches([]);
      setLoadError(t('agencyNotLinked'));
      setLoading(false);
      return [];
    }
    setLoading(true);
    try {
      const res = await apiFetch(`/api/agency/branches?agencyId=${agencyId}`);
      if (res.ok) {
        const data = await res.json();
        // Task 35 (bug A): accept BOTH envelopes — cloud returns { branches },
        // older local-API builds returned the legacy { data } key. Reading
        // only data.branches structurally emptied the desktop branch list
        // (and with it the staff dialog's branch selector) against stale builds.
        // Task 45 root cause: apiClient's parseResponse auto-unwrap collapses
        // the local dual envelope { success, branches, data } to the RAW ARRAY
        // before this reader runs — `data.branches ?? data.data` on an array
        // was ALWAYS [] (the desktop's permanent "no branches yet"). Accept
        // every observable envelope outcome instead.
        const rows: Branch[] = unwrapListPayload<Branch>(data, ['branches']);
        setBranches(rows);
        setLoadError(null);

        // Task 45: verify a just-created branch actually landed in the list
        // served by this server. The ref stays set until the row shows up, so
        // manual retries re-verify and the alert auto-clears when healed.
        const verifyId = pendingVerifyIdRef.current;
        if (verifyId) {
          if (rows.some((b) => b.id === verifyId)) {
            pendingVerifyIdRef.current = null;
            setCreateDivergence(null);
          } else {
            setCreateDivergence((prev) =>
              prev ?? { createdName: divergenceNameRef.current, serverBranchCount: null, serverAgencyId: null, serverStatus: null },
            );
            void probeWorkspaceForDivergence();
          }
        }
        return rows;
      } else {
        // Task 37-a: a non-ok response used to be swallowed silently — the
        // page rendered an EMPTY list (the exact "branch created on the
        // desktop is invisible in the desktop app" symptom). Surface the
        // server's message and offer a retry.
        const data = await res.json().catch(() => null);
        const message = (data && (data.error || data.message)) || t('branchesLoadFailed');
        setBranches([]);
        setLoadError(message);
        toast.error(message);
        return [];
      }
    } catch {
      setBranches([]);
      setLoadError(t('branchesLoadFailed'));
      toast.error(t('error'));
      return [];
    } finally {
      setLoading(false);
    }
  }, [agencyId, t]);

  const fetchStaff = useCallback(async () => {
    if (!agencyId) return;
    try {
      const res = await apiFetch(`/api/agency/staff?agencyId=${agencyId}`);
      if (res.ok) {
        const data = await res.json();
        // Task 45 root cause: same unwrap collapse as the branch list — the
        // local dual envelope arrives here as a raw array.
        setStaffList(unwrapListPayload<StaffMember>(data, ['staff']));
      }
    } catch {
      // silent
    }
  }, [agencyId]);

  useEffect(() => {
    fetchBranches();
    fetchStaff();
  }, [fetchBranches, fetchStaff]);

  const fetchCounters = useCallback(async (branchId: string) => {
    setCountersLoading(true);
    try {
      const res = await apiFetch(`/api/agency/branches/${branchId}/counters`);
      if (res.ok) {
        const data = await res.json();
        // Task 45 root cause: same unwrap collapse as the branch list.
        setCounters(unwrapListPayload<CounterWithStaff>(data, ['counters']));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setCountersLoading(false);
    }
  }, [t]);

  const toggleBranchExpand = (branchId: string) => {
    if (expandedBranch === branchId) {
      setExpandedBranch(null);
      setCounters([]);
    } else {
      setExpandedBranch(branchId);
      fetchCounters(branchId);
    }
  };

  // Branch CRUD
  const openCreateBranchDialog = () => {
    setEditingBranch(null);
    setBranchName('');
    setBranchNameAr('');
    setBranchNameFr('');
    setBranchSpecialName('');
    setBranchAddress('');
    setBranchPhone('');
    setBranchIsMain(false);
    setBranchLatitude(null);
    setBranchLongitude(null);
    setBranchWilayaCode('');
    setBranchCity('');
    setBranchPostalCode('');
    setBranchLocationSource(null);
    setBranchDialogOpen(true);
  };

  const openEditBranchDialog = (branch: Branch) => {
    setEditingBranch(branch);
    setBranchName(branch.name);
    setBranchNameAr(branch.nameAr || '');
    setBranchNameFr(branch.nameFr || '');
    setBranchSpecialName(branch.specialName || '');
    setBranchAddress(branch.address || '');
    setBranchPhone(branch.phone || '');
    setBranchIsMain(branch.isMain);
    setBranchLatitude(branch.latitude ?? null);
    setBranchLongitude(branch.longitude ?? null);
    setBranchWilayaCode(branch.wilaya || '');
    setBranchCity(branch.city || '');
    setBranchPostalCode(branch.postalCode || '');
    // null = no FRESH pick this session — the save payload must not touch
    // the stored provenance pair unless the owner re-picked the pin.
    setBranchLocationSource(null);
    setBranchDialogOpen(true);
  };

  // Task 83-b — picker → branch form state; persistence happens through the
  // Save button. onLocationSource marks a fresh pick this session so the
  // payload can refresh the provenance pair (spec §35 semantics).
  const handleBranchPickerChange = (lat: number | null, lng: number | null) => {
    setBranchLatitude(lat);
    setBranchLongitude(lng);
  };
  const handleBranchLocationSource = (source: 'GOOGLE' | 'OPENFREEMAP' | 'DEVICE_GPS') => {
    setBranchLocationSource(source);
  };

  // Task 83-b — reverse-geocode auto-fill (map pick → fields). Simplified
  // branch rule: fill ONLY EMPTY fields so a manually typed value is never
  // overwritten (no manualTouched machinery — the compact branch dialog
  // keeps it predictable; the create-agency wizard keeps the full guard).
  const handleBranchDetectedAddress = (components: GeocodeComponents) => {
    if (components.street && !branchAddress.trim()) setBranchAddress(components.street);
    if (components.wilaya && !branchWilayaCode) {
      const code = branchWilayaCodeFromGeocodeName(components.wilaya);
      if (code) setBranchWilayaCode(code);
    }
    if (components.city && !branchCity) {
      // The commune must belong to the just-detected (or current) wilaya;
      // only a commune that exists in the dataset is applied.
      const code = branchWilayaCode || branchWilayaCodeFromGeocodeName(components.wilaya);
      const wilaya = code ? findWilayaByCode(code) : undefined;
      if (wilaya) {
        const qLatin = foldLatinName(components.city);
        const qArabic = components.city.replace(/\s/g, '');
        const match = wilaya.communes.find(
          (c) =>
            (qLatin !== '' && foldLatinName(c.name) === qLatin) ||
            (qArabic !== '' && c.nameAr.replace(/\s/g, '') === qArabic),
        );
        if (match) setBranchCity(match.name);
      }
    }
    if (components.postalCode && !branchPostalCode.trim()) setBranchPostalCode(components.postalCode);
  };

  const handleSaveBranch = async () => {
    if (!agencyId || !branchName.trim()) return;
    // Task 31 bug 5: creating branches requires an active subscription
    // (editing an existing one stays allowed — server only gates POST).
    if (!editingBranch && !subscriptionActive) {
      toast.error(t('subscriptionRequiredBranches'));
      return;
    }
    // Task 83-b — a branch MUST carry its location at creation (backend 83-a
    // answers 400 without lat+lng). Block here; the inline hint in the
    // location block explains what is missing.
    if (!editingBranch && (branchLatitude === null || branchLongitude === null)) return;
    setBranchSaving(true);
    try {
      if (editingBranch) {
        // Task 83-b — location pair rule: lat/lng go out TOGETHER only when
        // either actually changed vs the branch as opened for edit (an
        // unchanged pair must never re-stamp locationUpdatedAt); both null =
        // explicit clear. Address fields are sent only when changed (null
        // clears); the provenance pair rides along only on a fresh pick.
        const origLat = editingBranch.latitude ?? null;
        const origLng = editingBranch.longitude ?? null;
        const latChanged = (branchLatitude ?? null) !== origLat;
        const lngChanged = (branchLongitude ?? null) !== origLng;
        const res = await apiFetch(`/api/agency/branches/${editingBranch.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: branchName.trim(),
            nameAr: branchNameAr.trim() || undefined,
            nameFr: branchNameFr.trim() || undefined,
            specialName: branchSpecialName.trim() || null,
            address: branchAddress.trim() || undefined,
            phone: branchPhone.trim() || undefined,
            isMain: branchIsMain,
            ...((latChanged || lngChanged) && {
              latitude: branchLatitude,
              longitude: branchLongitude,
              ...(branchLocationSource && {
                locationSource: branchLocationSource,
                locationVerified: branchLocationSource === 'DEVICE_GPS' ? 'VERIFIED' : 'UNVERIFIED',
              }),
            }),
            ...(branchWilayaCode !== (editingBranch.wilaya || '') && { wilaya: branchWilayaCode || null }),
            ...(branchCity !== (editingBranch.city || '') && { city: branchCity || null }),
            ...(branchPostalCode !== (editingBranch.postalCode || '') && { postalCode: branchPostalCode.trim() || null }),
          }),
        });
        if (res.ok) {
          toast.success(t('branchUpdated'));
          setBranchDialogOpen(false);
          fetchBranches();
        } else {
          const data = await res.json();
          toast.error(data.error || t('error'));
        }
      } else {
        // Task 37-a: send agencyId as a QUERY param too (kept in the body for
        // the cloud contract) so the local resolver and the cloud resolver
        // both see the SAME target agency on create.
        const res = await apiFetch(`/api/agency/branches?agencyId=${encodeURIComponent(agencyId)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agencyId,
            name: branchName.trim(),
            nameAr: branchNameAr.trim() || undefined,
            nameFr: branchNameFr.trim() || undefined,
            specialName: branchSpecialName.trim() || undefined,
            address: branchAddress.trim() || undefined,
            phone: branchPhone.trim() || undefined,
            isMain: branchIsMain,
            // Task 83-b — REQUIRED location block (the server 400s without
            // lat+lng); the guarded submit above guarantees both are set.
            latitude: branchLatitude,
            longitude: branchLongitude,
            wilaya: branchWilayaCode || undefined,
            city: branchCity.trim() || undefined,
            postalCode: branchPostalCode.trim() || undefined,
            locationSource: branchLocationSource ?? 'MANUAL',
            locationVerified: branchLocationSource === 'DEVICE_GPS' ? 'VERIFIED' : 'UNVERIFIED',
          }),
        });
        if (res.ok) {
          const body = await res.json().catch(() => ({}));
          // Task 45 root cause: against the local API the response envelope
          // { success, branch, data } is auto-unwrapped by apiClient to the
          // branch ROW itself — `body.branch ?? body.data` was undefined and
          // the consistency verification never armed. Fall back to the row.
          const created: Branch | undefined =
            body.branch ?? body.data ?? (body && typeof body === 'object' && !Array.isArray(body) && typeof body.id === 'string' ? (body as Branch) : undefined);
          toast.success(t('branchCreated'));
          setBranchDialogOpen(false);
          // Task 45: arm the consistency verification BEFORE refetching — the
          // freshly created row MUST be in the very next list of the same
          // server. If it is not, the divergence alert renders with the
          // server's workspace identity instead of a silent "no branches yet".
          if (created?.id) {
            divergenceNameRef.current = created.name || branchName.trim();
            pendingVerifyIdRef.current = created.id;
          }
          await fetchBranches();
        } else {
          const data = await res.json();
          toast.error(data.error || t('error'));
        }
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setBranchSaving(false);
    }
  };

  // Toggle branch active/inactive
  const handleToggleBranchActive = async (branch: Branch) => {
    setTogglingBranchId(branch.id);
    try {
      const res = await apiFetch(`/api/agency/branches/${branch.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !branch.isActive }),
      });
      if (res.ok) {
        toast.success(branch.isActive ? t('inactive') : t('active'));
        fetchBranches();
      } else {
        const data = await res.json();
        toast.error(data.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setTogglingBranchId(null);
    }
  };

  // Set branch as main
  const handleSetAsMain = async (branch: Branch) => {
    setTogglingBranchId(branch.id);
    try {
      const res = await apiFetch(`/api/agency/branches/${branch.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isMain: true }),
      });
      if (res.ok) {
        toast.success(t('mainBranch'));
        fetchBranches();
      } else {
        const data = await res.json();
        toast.error(data.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setTogglingBranchId(null);
    }
  };

  // Toggle counter active/inactive
  const handleToggleCounterActive = async (counter: CounterWithStaff) => {
    setTogglingCounterId(counter.id);
    try {
      const res = await apiFetch(`/api/agency/branches/${counter.branchId}/counters/${counter.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !counter.isActive }),
      });
      if (res.ok) {
        toast.success(counter.isActive ? t('inactive') : t('active'));
        fetchCounters(counter.branchId);
      } else {
        const data = await res.json();
        toast.error(data.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setTogglingCounterId(null);
    }
  };

  // Counter CRUD
  const openCreateCounterDialog = (_branchId: string) => {
    setEditingCounter(null);
    setCounterNumber(counters.length + 1);
    setCounterName('');
    setCounterNameAr('');
    setCounterNameFr('');
    setCounterDialogOpen(true);
  };

  const openEditCounterDialog = (counter: CounterWithStaff) => {
    setEditingCounter(counter);
    setCounterNumber(counter.number);
    setCounterName(counter.name);
    setCounterNameAr(counter.nameAr || '');
    setCounterNameFr(counter.nameFr || '');
    setCounterDialogOpen(true);
  };

  const handleSaveCounter = async () => {
    if (!expandedBranch || !counterName.trim()) return;
    // Task 31 bug 5: creating counters requires an active subscription
    // (editing an existing one stays allowed — server only gates POST).
    if (!editingCounter && !subscriptionActive) {
      toast.error(t('subscriptionRequiredBranches'));
      return;
    }
    setCounterSaving(true);
    try {
      if (editingCounter) {
        const res = await apiFetch(`/api/agency/branches/${expandedBranch}/counters/${editingCounter.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: counterName.trim(),
            nameAr: counterNameAr.trim() || undefined,
            nameFr: counterNameFr.trim() || undefined,
          }),
        });
        if (res.ok) {
          toast.success(t('counterUpdated'));
          setCounterDialogOpen(false);
          fetchCounters(expandedBranch);
        } else {
          const data = await res.json();
          toast.error(data.error || t('error'));
        }
      } else {
        const res = await apiFetch(`/api/agency/branches/${expandedBranch}/counters`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            number: counterNumber,
            name: counterName.trim(),
            nameAr: counterNameAr.trim() || undefined,
            nameFr: counterNameFr.trim() || undefined,
          }),
        });
        if (res.ok) {
          toast.success(t('counterCreated'));
          setCounterDialogOpen(false);
          fetchCounters(expandedBranch);
          fetchBranches(); // Refresh counter counts
        } else {
          const data = await res.json();
          toast.error(data.error || t('error'));
        }
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setCounterSaving(false);
    }
  };

  // Delete
  const openDeleteDialog = (type: 'branch' | 'counter', id: string, name: string) => {
    setDeletingItem({ type, id, name });
    setDeleteDialogOpen(true);
  };

  const handleDelete = async () => {
    if (!deletingItem) return;
    setDeleteLoading(true);
    try {
      if (deletingItem.type === 'branch') {
        const res = await apiFetch(`/api/agency/branches/${deletingItem.id}`, { method: 'DELETE' });
        if (res.ok) {
          toast.success(t('branchDeleted'));
          fetchBranches();
          if (expandedBranch === deletingItem.id) {
            setExpandedBranch(null);
            setCounters([]);
          }
        } else {
          const data = await res.json();
          toast.error(data.error || t('error'));
        }
      } else {
        const res = await apiFetch(`/api/agency/branches/${expandedBranch}/counters/${deletingItem.id}`, { method: 'DELETE' });
        if (res.ok) {
          toast.success(t('counterDeleted'));
          fetchCounters(expandedBranch!);
          fetchBranches();
        } else {
          const data = await res.json();
          toast.error(data.error || t('error'));
        }
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setDeleteLoading(false);
      setDeleteDialogOpen(false);
      setDeletingItem(null);
    }
  };

  // Staff assignment
  const handleAssignStaff = async (counterId: string, staffId: string | null) => {
    if (!expandedBranch) return;
    setAssigningCounterId(counterId);
    try {
      const res = await apiFetch(`/api/agency/branches/${expandedBranch}/counters/${counterId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ staffId }),
      });
      if (res.ok) {
        toast.success(staffId ? t('assignStaff') : t('unassignStaff'));
        fetchCounters(expandedBranch);
      } else {
        const data = await res.json();
        toast.error(data.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setAssigningCounterId(null);
    }
  };

  // ─── Task 83-b — per-branch QR (client-side SVG, offline-safe) ───────────

  // Regenerate whenever a branch is opened in the QR dialog. Encodes the
  // SAME deep-link shape the agency QR uses — <origin>/?branch=<subCode>
  // (the agency-wide QR encodes ?code=<customCode>; the branch param lets
  // the customer side open that specific branch, Task 83-c).
  useEffect(() => {
    if (!qrBranch) {
      setQrSvg(null);
      return;
    }
    let cancelled = false;
    setQrLoading(true);
    const origin = typeof window !== 'undefined' ? window.location.origin : 'https://blasti.dz';
    const payload = qrBranch.subCode
      ? `${origin}/?branch=${encodeURIComponent(qrBranch.subCode)}`
      : 'https://blasti.dz';
    QRCode.toString(payload, {
      type: 'svg',
      width: 256,
      margin: 2,
      color: { dark: '#047857', light: '#ffffff' },
      errorCorrectionLevel: 'M',
    })
      .then((svg) => { if (!cancelled) setQrSvg(svg); })
      .catch(() => { if (!cancelled) setQrSvg(null); })
      .finally(() => { if (!cancelled) setQrLoading(false); });
    return () => { cancelled = true; };
  }, [qrBranch]);

  const handleCopySubCode = async (subCode: string) => {
    try {
      await navigator.clipboard.writeText(subCode);
      toast.success(t('branchSubCodeCopied'));
    } catch {
      // Fallback (non-secure contexts / older webviews) — agency-profile pattern
      const textArea = document.createElement('textarea');
      textArea.value = subCode;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      toast.success(t('branchSubCodeCopied'));
    }
  };

  const handleDownloadBranchQr = () => {
    if (!qrSvg || !qrBranch) return;
    // image/svg+xml Blob download — the vector stays crisp on printed signage.
    const blob = new Blob([qrSvg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `blasti-branch-${qrBranch.subCode || qrBranch.id}.svg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success(t('downloaded'));
  };

  // Get localized name
  const getBranchDisplayName = (branch: Branch) => {
    if (lang === 'ar' && branch.nameAr) return branch.nameAr;
    if (lang === 'fr' && branch.nameFr) return branch.nameFr;
    return branch.name;
  };

  const getCounterDisplayName = (counter: CounterWithStaff) => {
    if (lang === 'ar' && counter.nameAr) return counter.nameAr;
    if (lang === 'fr' && counter.nameFr) return counter.nameFr;
    return counter.name;
  };

  // Loading state
  if (loading) {
    return (
      <div className="p-4 lg:p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div className="space-y-2">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-4 w-64" />
          </div>
          <Skeleton className="h-10 w-36 rounded-lg" />
        </div>
        <Skeleton className="h-32 rounded-2xl" />
        <Skeleton className="h-32 rounded-2xl" />
        <Skeleton className="h-24 rounded-2xl" />
      </div>
    );
  }

  return (
    <div className="p-4 lg:p-6 space-y-4 pb-28">
      {/* Gradient top border */}
      <div className="absolute top-0 start-0 end-0 h-[3px] bg-gradient-to-r from-emerald-500 via-teal-400 to-emerald-500 rounded-full" />

      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex items-center justify-between gap-4"
      >
        <div className="min-w-0">
          <h2 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Building2 className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
            {t('branches')}
          </h2>
          <p className="text-sm text-muted-foreground mt-1">{t('branchesDesc')}</p>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <Button
                className="bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl shadow-lg shadow-emerald-500/20 gap-2 h-10 px-4 disabled:opacity-50"
                onClick={openCreateBranchDialog}
                disabled={!subscriptionActive}
              >
                {!subscriptionActive ? <Lock className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                <span className="hidden sm:inline">{t('addBranch')}</span>
                <span className="sm:hidden">{t('addBranch')}</span>
              </Button>
            </span>
          </TooltipTrigger>
          {!subscriptionActive && (
            <TooltipContent>{t('subscriptionRequiredBranches')}</TooltipContent>
          )}
        </Tooltip>
      </motion.div>

      {/* Task 40 round 4: the embedded local API predates the branch-list
          fixes (old install / old tray instance still owning :3080) — say so
          HERE instead of letting the list render a misleading empty state. */}
      {localApiStale && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex items-start gap-3 rounded-2xl border border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-950/30 p-4"
          role="alert"
        >
          <div className="h-9 w-9 rounded-xl bg-amber-100 dark:bg-amber-900/40 flex items-center justify-center flex-shrink-0">
            <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">{t('desktopApiStaleTitle')}</p>
            <p className="text-xs text-amber-700/80 dark:text-amber-400/80 mt-0.5">
              {t('desktopApiStaleDesc')}{' '}
              <span className="font-mono font-semibold">{localApiStale.version ?? 'unknown'}</span>
            </p>
          </div>
        </motion.div>
      )}

      {/* Task 45: a create returned 201 but the very next list of the SAME
          server did not contain the row — historically the silent "created a
          branch and the desktop keeps showing no branches yet". Name the
          divergence, show the server's workspace identity (Task 45
          /api/health), and give the exact remediation. Auto-clears once a
          refetch returns the row (e.g. after restart + sync). */}
      {createDivergence && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex items-start gap-3 rounded-2xl border border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-950/30 p-4"
          role="alert"
        >
          <div className="h-9 w-9 rounded-xl bg-amber-100 dark:bg-amber-900/40 flex items-center justify-center flex-shrink-0">
            <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">
              {t('branchDivergenceTitle')}
              {createDivergence.createdName ? ` — ${createDivergence.createdName}` : ''}
            </p>
            <p className="text-xs text-amber-700/80 dark:text-amber-400/80 mt-0.5">{t('branchDivergenceDesc')}</p>
            {(createDivergence.serverBranchCount !== null || createDivergence.serverAgencyId || createDivergence.serverStatus) && (
              <p className="text-xs font-mono text-amber-700/80 dark:text-amber-400/80 mt-1 break-all">
                {t('branchDivergenceServerDetail')}:{' '}
                {createDivergence.serverBranchCount ?? '—'} · {createDivergence.serverAgencyId ?? '—'} ·{' '}
                {createDivergence.serverStatus ?? '—'}
              </p>
            )}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={fetchBranches}
            className="gap-2 border-amber-300 dark:border-amber-800 text-amber-800 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/40 rounded-xl flex-shrink-0"
          >
            <RefreshCw className="h-4 w-4" />
            {t('retry')}
          </Button>
        </motion.div>
      )}

      {/* Task 37-a: load failure surfaced with a retry (previously a silent
          empty list indistinguishable from "no branches yet") */}
      {loadError && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 rounded-2xl border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-950/30 p-4"
          role="alert"
        >
          <div className="flex items-center gap-3 min-w-0">
            <div className="h-9 w-9 rounded-xl bg-red-100 dark:bg-red-900/40 flex items-center justify-center flex-shrink-0">
              <Building2 className="h-4 w-4 text-red-600 dark:text-red-400" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-red-700 dark:text-red-300">{t('branchesLoadFailed')}</p>
              <p className="text-xs text-red-600/80 dark:text-red-400/80 truncate">{loadError}</p>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={fetchBranches}
            className="gap-2 border-red-300 dark:border-red-800 text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/40 rounded-xl flex-shrink-0"
          >
            <RefreshCw className="h-4 w-4" />
            {t('retry')}
          </Button>
        </motion.div>
      )}

      {/* Summary stats */}
      {branches.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05 }}
          className="grid grid-cols-3 gap-3"
        >
          <div className="rounded-2xl bg-gradient-to-br from-emerald-500 to-emerald-700 p-3 text-white shadow-lg shadow-emerald-500/15">
            <div className="flex items-center gap-1.5 mb-1">
              <Building2 className="h-3.5 w-3.5 text-emerald-200" />
              <span className="text-[10px] text-emerald-200 font-medium">{t('branches')}</span>
            </div>
            <p className="text-2xl font-black">{branches.length}</p>
          </div>
          <div className="rounded-2xl bg-gradient-to-br from-teal-500 to-teal-700 p-3 text-white shadow-lg shadow-teal-500/15">
            <div className="flex items-center gap-1.5 mb-1">
              <Monitor className="h-3.5 w-3.5 text-teal-200" />
              <span className="text-[10px] text-teal-200 font-medium">{t('counters')}</span>
            </div>
            <p className="text-2xl font-black">
              {branches.reduce((sum, b) => sum + (b._count?.counters || 0), 0)}
            </p>
          </div>
          <div className="rounded-2xl bg-gradient-to-br from-amber-500 to-amber-700 p-3 text-white shadow-lg shadow-amber-500/15">
            <div className="flex items-center gap-1.5 mb-1">
              <Star className="h-3.5 w-3.5 text-amber-200" />
              <span className="text-[10px] text-amber-200 font-medium">{t('mainBranch')}</span>
            </div>
            <p className="text-2xl font-black">
              {branches.filter(b => b.isMain).length}
            </p>
          </div>
        </motion.div>
      )}

      {/* Branches List */}
      {branches.length === 0 ? (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col items-center justify-center py-16 text-center"
        >
          <div className="h-20 w-20 rounded-2xl bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center mb-4">
            <MapPin className="h-10 w-10 text-emerald-600 dark:text-emerald-400" />
          </div>
          <p className="text-lg font-semibold text-foreground">{t('noBranches')}</p>
          <p className="text-sm text-muted-foreground mt-1 max-w-sm">{t('noBranchesDesc')}</p>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <Button
                  className="mt-4 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl gap-2 disabled:opacity-50"
                  onClick={openCreateBranchDialog}
                  disabled={!subscriptionActive}
                >
                  {!subscriptionActive ? <Lock className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                  {t('addBranch')}
                </Button>
              </span>
            </TooltipTrigger>
            {!subscriptionActive && (
              <TooltipContent>{t('subscriptionRequiredBranches')}</TooltipContent>
            )}
          </Tooltip>
        </motion.div>
      ) : (
        <div className="space-y-3">
          {branches.map((branch, idx) => {
            const isExpanded = expandedBranch === branch.id;
            return (
              <motion.div
                key={branch.id}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: idx * 0.05 }}
              >
                <Card className={`border-0 shadow-sm overflow-hidden transition-all duration-300 ${
                  !branch.isActive
                    ? 'bg-gray-50 dark:bg-gray-900/40 opacity-80 ring-1 ring-gray-200 dark:ring-gray-800'
                    : 'bg-white dark:bg-gray-900/80'
                }`}>
                  {/* Branch Header */}
                  <button
                    onClick={() => toggleBranchExpand(branch.id)}
                    className="w-full flex items-center justify-between p-4 hover:bg-gray-50 dark:hover:bg-gray-800/30 transition-colors text-start"
                  >
                    <div className="flex items-center gap-3">
                      <div className={`h-10 w-10 rounded-xl flex items-center justify-center flex-shrink-0 ${
                        branch.isMain
                          ? 'bg-amber-100 dark:bg-amber-900/30'
                          : branch.isActive
                          ? 'bg-emerald-100 dark:bg-emerald-900/30'
                          : 'bg-gray-100 dark:bg-gray-800/50'
                      }`}>
                        {branch.isMain ? (
                          <Crown className="h-5 w-5 text-amber-600 dark:text-amber-400" />
                        ) : (
                          <Building2 className={`h-5 w-5 ${branch.isActive ? 'text-emerald-600 dark:text-emerald-400' : 'text-gray-400 dark:text-gray-500'}`} />
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          {/* Task 83-b — specialName is the display title when present */}
                          <p className="text-sm font-semibold text-foreground truncate">
                            {branch.specialName?.trim() || getBranchDisplayName(branch)}
                          </p>
                          {branch.subCode && (
                            <span
                              className="font-mono text-[10px] px-1.5 py-0.5 rounded-md bg-teal-50 dark:bg-teal-900/30 text-teal-700 dark:text-teal-400 border border-teal-200/70 dark:border-teal-800/60 flex-shrink-0"
                              dir="ltr"
                            >
                              {branch.subCode}
                            </span>
                          )}
                          {branch.isMain && (
                            <Badge className="bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 border-0 text-[10px] px-1.5 py-0.5 gap-0.5">
                              <Star className="h-3 w-3" />
                              {t('mainBranch')}
                            </Badge>
                          )}
                          {!branch.isActive && (
                            <Badge variant="secondary" className="text-[10px] px-1.5 py-0.5 bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400">
                              <Power className="h-3 w-3 me-0.5" />
                              {t('inactive')}
                            </Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                          {branch.address && (
                            <span className="text-xs text-muted-foreground truncate max-w-48 flex items-center gap-1">
                              <MapPin className="h-3 w-3 flex-shrink-0" />
                              {branch.address}
                            </span>
                          )}
                          <span className="text-xs text-muted-foreground">
                            {branch._count?.counters || 0} {t('counters')}
                          </span>
                          {branch.phone && (
                            <span className="text-xs text-muted-foreground flex items-center gap-1">
                              <Phone className="h-3 w-3" />
                              {branch.phone}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    <motion.div
                      animate={{ rotate: isExpanded ? 180 : 0 }}
                      transition={{ duration: 0.25 }}
                      className="flex-shrink-0"
                    >
                      <ChevronDown className="h-5 w-5 text-muted-foreground" />
                    </motion.div>
                  </button>

                  {/* Expanded Content */}
                  <AnimatePresence initial={false}>
                    {isExpanded && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.3, ease: 'easeInOut' }}
                        className="overflow-hidden"
                      >
                        <div className="px-4 pb-4">
                          <Separator className="mb-4" />

                          {/* Branch Actions Row */}
                          <div className="flex items-center gap-2 mb-4 flex-wrap">
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-8 text-xs rounded-lg gap-1.5"
                              onClick={(e) => { e.stopPropagation(); openEditBranchDialog(branch); }}
                            >
                              <Edit3 className="h-3.5 w-3.5" />
                              {t('editBranch')}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-8 text-xs text-red-600 hover:text-red-700 border-red-200 dark:border-red-800 rounded-lg gap-1.5"
                              onClick={(e) => { e.stopPropagation(); openDeleteDialog('branch', branch.id, branch.name); }}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              {t('deleteBranch')}
                            </Button>
                            {/* Task 83-b — per-branch QR (hidden until a subCode
                                exists — nothing meaningful to encode before that) */}
                            {branch.subCode && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-8 w-8 p-0 rounded-lg"
                                onClick={(e) => { e.stopPropagation(); setQrBranch(branch); }}
                                aria-label={t('branchQrTitle')}
                              >
                                <QrCode className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                              </Button>
                            )}
                            {!branch.isMain && branch.isActive && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-8 text-xs text-amber-700 hover:text-amber-800 border-amber-200 dark:border-amber-800 rounded-lg gap-1.5"
                                onClick={(e) => { e.stopPropagation(); handleSetAsMain(branch); }}
                                disabled={togglingBranchId === branch.id}
                              >
                                {togglingBranchId === branch.id ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Crown className="h-3.5 w-3.5" />
                                )}
                                {t('setAsMain')}
                              </Button>
                            )}
                            <div className="flex-1" />

                            {/* Active/Inactive Toggle */}
                            <div className="flex items-center gap-2 me-2">
                              <Label className="text-xs text-muted-foreground">{t('active')}</Label>
                              <Switch
                                checked={branch.isActive}
                                onCheckedChange={() => handleToggleBranchActive(branch)}
                                disabled={togglingBranchId === branch.id}
                                className="data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-gray-300 dark:data-[state=unchecked]:bg-gray-600"
                              />
                              {togglingBranchId === branch.id && (
                                <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                              )}
                            </div>

                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="inline-flex">
                                  <Button
                                    size="sm"
                                    className="bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg h-8 text-xs gap-1.5 disabled:opacity-50"
                                    onClick={() => openCreateCounterDialog(branch.id)}
                                    disabled={!subscriptionActive}
                                  >
                                    {!subscriptionActive ? <Lock className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
                                    {t('addCounter')}
                                  </Button>
                                </span>
                              </TooltipTrigger>
                              {!subscriptionActive && (
                                <TooltipContent>{t('subscriptionRequiredBranches')}</TooltipContent>
                              )}
                            </Tooltip>
                          </div>

                          {/* Branch Info Grid */}
                          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
                            {branch.phone && (
                              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                <Phone className="h-3.5 w-3.5" />
                                {branch.phone}
                              </div>
                            )}
                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                              <Monitor className="h-3.5 w-3.5" />
                              {branch._count?.counters || 0} {t('counters')}
                            </div>
                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                              <Users className="h-3.5 w-3.5" />
                              {branch._count?.staff || 0} {t('staffCount')}
                            </div>
                          </div>

                          {/* Counters */}
                          {countersLoading ? (
                            <div className="space-y-2">
                              {[...Array(2)].map((_, i) => (
                                <Skeleton key={i} className="h-14 rounded-xl" />
                              ))}
                            </div>
                          ) : counters.length === 0 ? (
                            <div className="flex flex-col items-center py-8 text-center">
                              <Monitor className="h-8 w-8 text-muted-foreground/50 mb-2" />
                              <p className="text-sm text-muted-foreground">{t('noCounters')}</p>
                              <p className="text-xs text-muted-foreground/70 mt-0.5">{t('noCountersDesc')}</p>
                            </div>
                          ) : (
                            <div className="space-y-2 max-h-96 overflow-y-auto">
                              {counters.map((counter) => (
                                <motion.div
                                  key={counter.id}
                                  layout
                                  initial={{ opacity: 0.95 }}
                                  animate={{ opacity: 1 }}
                                  className={`flex items-center justify-between p-3 rounded-xl transition-colors gap-2 ${
                                    !counter.isActive
                                      ? 'bg-gray-50/50 dark:bg-gray-900/30 opacity-70 ring-1 ring-gray-100 dark:ring-gray-800/50'
                                      : 'bg-gray-50 dark:bg-gray-900/50'
                                  }`}
                                >
                                  <div className="flex items-center gap-3 min-w-0">
                                    <div className={`h-9 w-9 rounded-lg flex items-center justify-center flex-shrink-0 ${
                                      counter.isActive
                                        ? 'bg-teal-100 dark:bg-teal-900/30'
                                        : 'bg-gray-100 dark:bg-gray-800/50'
                                    }`}>
                                      <span className={`text-xs font-bold ${
                                        counter.isActive
                                          ? 'text-teal-700 dark:text-teal-400'
                                          : 'text-gray-400 dark:text-gray-500'
                                      }`}>
                                        #{counter.number}
                                      </span>
                                    </div>
                                    <div className="min-w-0">
                                      <div className="flex items-center gap-2">
                                        <p className="text-sm font-medium text-foreground truncate">{getCounterDisplayName(counter)}</p>
                                        {!counter.isActive && (
                                          <Badge variant="secondary" className="text-[9px] px-1 py-0 h-4 bg-gray-200 dark:bg-gray-700 text-gray-500 dark:text-gray-400">
                                            {t('inactive')}
                                          </Badge>
                                        )}
                                      </div>
                                      <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                                        {counter.staff ? (
                                          <span className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                                            <UserCheck className="h-3 w-3" />
                                            {counter.staff.user.fullName}
                                          </span>
                                        ) : (
                                          <span className="text-xs text-muted-foreground flex items-center gap-1">
                                            <UserX className="h-3 w-3" />
                                            {t('noStaffAssigned')}
                                          </span>
                                        )}
                                        {counter.currentReservation && (
                                          <span className="text-xs text-amber-600 dark:text-amber-400">
                                            · {t('currentlyServing')}: {counter.currentReservation.displayNumber}
                                          </span>
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                  <div className="flex items-center gap-1.5 flex-shrink-0">
                                    {/* Active/Inactive Toggle for Counter */}
                                    <div className="flex items-center gap-1.5">
                                      <Switch
                                        checked={counter.isActive}
                                        onCheckedChange={() => handleToggleCounterActive(counter)}
                                        disabled={togglingCounterId === counter.id}
                                        className="data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-gray-300 dark:data-[state=unchecked]:bg-gray-600 scale-75 origin-center"
                                      />
                                      {togglingCounterId === counter.id && (
                                        <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                                      )}
                                    </div>
                                    {/* Staff assignment */}
                                    <Select
                                      value={counter.staffId || '__none__'}
                                      onValueChange={(val) => handleAssignStaff(counter.id, val === '__none__' ? null : val)}
                                      disabled={assigningCounterId === counter.id}
                                    >
                                      <SelectTrigger className="h-8 w-8 p-0 border-0 bg-transparent">
                                        <SelectValue>
                                          <UserCheck className="h-4 w-4 text-muted-foreground" />
                                        </SelectValue>
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="__none__">{t('unassignStaff')}</SelectItem>
                                        {staffList.filter(s => s.user.isActive).map((s) => (
                                          <SelectItem key={s.id} value={s.id}>
                                            {s.user.fullName}
                                          </SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
                                      onClick={() => openEditCounterDialog(counter)}
                                    >
                                      <Edit3 className="h-3.5 w-3.5" />
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="h-8 w-8 p-0 text-red-500 hover:text-red-600"
                                      onClick={() => openDeleteDialog('counter', counter.id, counter.name)}
                                    >
                                      <Trash2 className="h-3.5 w-3.5" />
                                    </Button>
                                  </div>
                                </motion.div>
                              ))}
                            </div>
                          )}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </Card>
              </motion.div>
            );
          })}
        </div>
      )}

      {/* Create/Edit Branch Dialog */}
      <Dialog open={branchDialogOpen} onOpenChange={setBranchDialogOpen}>
        {/* Task 83-b — the dialog now carries the location block; make it
            scrollable and slightly wider (same pattern as history sheets). */}
        <DialogContent className="sm:max-w-md max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Building2 className="h-5 w-5 text-emerald-500" />
              {editingBranch ? t('editBranch') : t('addBranch')}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {editingBranch ? t('editBranch') : t('addBranch')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>{t('branchName')}</Label>
              <Input
                value={branchName}
                onChange={(e) => setBranchName(e.target.value)}
                placeholder={t('branchName')}
                className="h-11"
              />
            </div>
            <div className="space-y-2">
              <Label>{t('branchNameAr')}</Label>
              <Input
                value={branchNameAr}
                onChange={(e) => setBranchNameAr(e.target.value)}
                placeholder={t('branchNameAr')}
                className="h-11"
                dir="rtl"
              />
            </div>
            <div className="space-y-2">
              <Label>{t('branchNameFr')}</Label>
              <Input
                value={branchNameFr}
                onChange={(e) => setBranchNameFr(e.target.value)}
                placeholder={t('branchNameFr')}
                className="h-11"
                dir="ltr"
              />
            </div>
            {/* Task 83-b — optional customer-facing display name ("Downtown
                Branch", "Mall Kiosk"…). Distinct from the internal name. */}
            <div className="space-y-2">
              <Label className="flex items-center gap-1.5">
                {t('branchSpecialName')}
                <span className="text-xs text-muted-foreground">({t('optional')})</span>
              </Label>
              <Input
                value={branchSpecialName}
                onChange={(e) => setBranchSpecialName(e.target.value)}
                className="h-11"
              />
              <p className="text-xs text-muted-foreground">{t('branchSpecialNameDesc')}</p>
            </div>
            {/* Task 83-b — REQUIRED location block (backend 83-a): map picker
                + address fields beneath it. Creation 400s without lat+lng;
                edit sends the pair only when either changed. */}
            <div className="space-y-3 rounded-xl border border-gray-100 dark:border-gray-800 bg-muted/50 p-3">
              <Label className="text-sm font-medium flex items-center gap-1.5">
                <MapPin className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                {t('branchLocation')}
              </Label>
              <p className="text-xs text-muted-foreground">{t('branchLocationDesc')}</p>
              <MapLocationPicker
                value={{ latitude: branchLatitude, longitude: branchLongitude }}
                onChange={handleBranchPickerChange}
                onLocationSource={handleBranchLocationSource}
                addressFields={{ onDetected: handleBranchDetectedAddress }}
                height={260}
              />
              {!editingBranch && (branchLatitude === null || branchLongitude === null) && (
                <p className="text-xs flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
                  {t('branchLocationRequired')}
                </p>
              )}
              <div className="space-y-2">
                <Label>{t('location.streetAddress')}</Label>
                <Input
                  value={branchAddress}
                  onChange={(e) => setBranchAddress(e.target.value)}
                  placeholder={t('branchAddress')}
                  className="h-11"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>{t('location.wilaya')}</Label>
                  <WilayaSelect
                    value={branchWilayaCode}
                    onValueChange={(code) => {
                      if (code === branchWilayaCode) return;
                      setBranchWilayaCode(code);
                      // Dependent list — the commune must belong to the
                      // newly selected wilaya, so reset it.
                      setBranchCity('');
                    }}
                    lang={lang}
                    placeholder={t('location.selectWilaya')}
                    aria-label={t('location.wilaya')}
                    triggerClassName="h-11 rounded-xl border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 data-[state=open]:border-emerald-400 focus-visible:border-emerald-400 focus-visible:ring-emerald-500/20"
                  />
                </div>
                <div className="space-y-2">
                  <Label>{t('location.commune')}</Label>
                  <CommuneSelect
                    wilayaCode={branchWilayaCode}
                    value={branchCity}
                    onValueChange={setBranchCity}
                    lang={lang}
                    placeholder={t('location.selectCommune')}
                    aria-label={t('location.commune')}
                    triggerClassName="h-11 rounded-xl border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 data-[state=open]:border-emerald-400 focus-visible:border-emerald-400 focus-visible:ring-emerald-500/20"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label>{t('maps.postalCode')}</Label>
                <Input
                  value={branchPostalCode}
                  onChange={(e) => setBranchPostalCode(e.target.value)}
                  className="h-11"
                  dir="ltr"
                  maxLength={10}
                  placeholder="28019"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>{t('branchPhone')}</Label>
              <Input
                value={branchPhone}
                onChange={(e) => setBranchPhone(e.target.value)}
                placeholder={t('branchPhone')}
                className="h-11"
                dir="ltr"
              />
            </div>
            <div className="flex items-center justify-between p-3 rounded-xl bg-muted/50">
              <div className="flex items-center gap-2">
                <Crown className="h-4 w-4 text-amber-500" />
                <Label className="cursor-pointer">{t('setAsMain')}</Label>
              </div>
              <Switch
                checked={branchIsMain}
                onCheckedChange={setBranchIsMain}
                className="data-[state=checked]:bg-amber-500 data-[state=unchecked]:bg-gray-300 dark:data-[state=unchecked]:bg-gray-600"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBranchDialogOpen(false)}>
              {t('cancel')}
            </Button>
            <Button
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
              onClick={handleSaveBranch}
              disabled={
                branchSaving ||
                !branchName.trim() ||
                // Task 83-b — location is REQUIRED at creation; block until
                // the pin is placed (inline hint explains it).
                (!editingBranch && (branchLatitude === null || branchLongitude === null)) ||
                (!editingBranch && !subscriptionActive)
              }
            >
              {branchSaving ? <Loader2 className="h-4 w-4 animate-spin me-1" /> : null}
              {t('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Task 83-b — Branch QR dialog: client-side SVG QR encoding the branch
          deep-link (?branch=<subCode>), subCode display + copy + SVG
          download. Rendered only for branches that already carry a subCode
          (the QR button is hidden otherwise). */}
      <Dialog open={!!qrBranch} onOpenChange={(open) => { if (!open) setQrBranch(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <QrCode className="h-5 w-5 text-emerald-500" />
              {t('branchQrTitle')}
              {qrBranch?.specialName?.trim() ? (
                <span className="text-sm font-normal text-muted-foreground truncate">
                  — {qrBranch.specialName}
                </span>
              ) : null}
            </DialogTitle>
            <DialogDescription className="sr-only">{t('branchQrDesc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-xs text-muted-foreground">{t('branchQrDesc')}</p>
            {qrLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-8 w-8 animate-spin text-emerald-600" />
              </div>
            ) : qrSvg ? (
              <div className="flex justify-center">
                {/* QRCode.toString('svg') output is trusted, locally generated
                    markup — rendered into a white rounded box for scannability. */}
                <div
                  className="w-fit rounded-2xl bg-white p-3 border border-gray-100 dark:border-gray-800 shadow-sm"
                  dangerouslySetInnerHTML={{ __html: qrSvg }}
                />
              </div>
            ) : null}
            {qrBranch?.subCode && (
              <div className="flex items-center justify-between gap-3 p-3 rounded-xl bg-muted/50 dark:bg-gray-800/50">
                <div className="min-w-0">
                  <p className="text-[10px] text-muted-foreground">{t('branchSubCode')}</p>
                  <p className="text-sm font-mono font-bold text-emerald-700 dark:text-emerald-400 truncate" dir="ltr">
                    {qrBranch.subCode}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-9 rounded-lg text-xs gap-1.5 flex-shrink-0"
                  onClick={() => handleCopySubCode(qrBranch.subCode!)}
                >
                  <Copy className="h-3.5 w-3.5" />
                  {t('copy')}
                </Button>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={handleDownloadBranchQr} disabled={!qrSvg}>
              <Download className="h-4 w-4 me-1.5" />
              {t('downloadQr')}
            </Button>
            <Button variant="outline" onClick={() => setQrBranch(null)}>
              {t('cancel')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create/Edit Counter Dialog */}
      <Dialog open={counterDialogOpen} onOpenChange={setCounterDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Monitor className="h-5 w-5 text-teal-500" />
              {editingCounter ? t('editCounter') : t('addCounter')}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {editingCounter ? t('editCounter') : t('addCounter')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>{t('counterNumber')}</Label>
              <Input
                type="number"
                min={1}
                value={counterNumber}
                onChange={(e) => setCounterNumber(parseInt(e.target.value) || 1)}
                className="h-11 w-28"
                dir="ltr"
                disabled={!!editingCounter}
              />
            </div>
            <div className="space-y-2">
              <Label>{t('counterName')}</Label>
              <Input
                value={counterName}
                onChange={(e) => setCounterName(e.target.value)}
                placeholder={t('counterName')}
                className="h-11"
              />
            </div>
            <div className="space-y-2">
              <Label>{t('counterNameAr')}</Label>
              <Input
                value={counterNameAr}
                onChange={(e) => setCounterNameAr(e.target.value)}
                placeholder={t('counterNameAr')}
                className="h-11"
                dir="rtl"
              />
            </div>
            <div className="space-y-2">
              <Label>{t('counterNameFr')}</Label>
              <Input
                value={counterNameFr}
                onChange={(e) => setCounterNameFr(e.target.value)}
                placeholder={t('counterNameFr')}
                className="h-11"
                dir="ltr"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCounterDialogOpen(false)}>
              {t('cancel')}
            </Button>
            <Button
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
              onClick={handleSaveCounter}
              disabled={counterSaving || !counterName.trim() || (!editingCounter && !subscriptionActive)}
            >
              {counterSaving ? <Loader2 className="h-4 w-4 animate-spin me-1" /> : null}
              {t('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deletingItem?.type === 'branch' ? t('deleteBranch') : t('deleteCounter')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deletingItem?.type === 'branch'
                ? t('confirmDeleteBranch')
                : t('confirmDeleteCounter')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDeletingItem(null)}>
              {t('cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-red-600 hover:bg-red-700 text-white"
              disabled={deleteLoading}
            >
              {deleteLoading ? <Loader2 className="h-4 w-4 animate-spin me-1" /> : null}
              {t('delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
