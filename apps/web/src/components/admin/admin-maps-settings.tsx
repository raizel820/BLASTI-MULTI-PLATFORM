'use client';

/**
 * Admin → Settings → Maps & Location (Task 51-c, spec §7-§24, §44, §53).
 *
 * Super Admin control panel for the whole location/map system. One card per
 * spec §44 section:
 *
 *   General     — main provider radios, fallback provider, enable maps /
 *                 enable customer directions switches
 *   Google Maps — masked API key (Replace / Remove, never round-trips the
 *                 mask — the API rejects "••••" placeholders), geocoding
 *                 toggle, Validate Configuration, Test Map
 *   OpenFreeMap — style URL input, Validate Configuration, Test Map
 *   Geocoding   — provider radios (Google / OSM-compatible), API key only
 *                 when Google, Validate
 *   Directions  — destination mode, origin, open behavior, button label
 *   Monitoring  — per-provider status chips (Configured ✓ / Not configured ⚠ /
 *                 Invalid ✕), last configuration change, last validation
 *
 * SAVE FLOW (spec §43): everything is edited in LOCAL form state and pushed
 * with one PUT /api/admin/settings/maps (validate-all-then-write server-side,
 * atomic). Validation is EXPLICIT via the per-section Validate buttons
 * (POST /api/admin/settings/maps/validate). Masked placeholders are never
 * sent back: secrets only travel as a fresh value (Replace) or null (Remove).
 *
 * TEST MAP: reuses 51-b's provider abstraction (createMapProvider via
 * @/lib/map) against the SAVED config — useMapConfig() is the baseline
 * source, but the fresh admin snapshot returned by GET/PUT takes precedence
 * because the hook's module cache can be up to 60s stale right after a save.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import { useLanguage } from '@/hooks/use-language';
import { useOnlineStatus } from '@/hooks/use-online-status';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Database,
  ExternalLink,
  Loader2,
  Map as MapIcon,
  MapPin,
  Navigation,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  Trash2,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { motion } from 'framer-motion';
import {
  createMapProvider,
  isProviderAvailable,
  COUNTRY_ZOOM,
  DEFAULT_MAP_CENTER,
  type MapProviderId,
  type MapProviderInstance,
  type MapsProviderSettings,
} from '@/lib/map';
import { useMapConfig } from '@/lib/map/use-map-config';
// Task 2-b — offline Algeria administrative dataset (already in the main
// bundle via the wilaya/commune selectors, so a direct import adds no extra
// admin-only chunk).
import {
  ALGERIA_WILAYAS,
  type AlgeriaCommune,
  type AlgeriaWilaya,
} from '@/lib/algeria-locations';
import 'maplibre-gl/dist/maplibre-gl.css';

// ─── Backend snapshot types (GET /api/admin/settings/maps, Task 51-a) ──────

interface MapsSecretStatus {
  key: string;
  label: string;
  configured: boolean;
  /** "••••" + last 4 — the full value NEVER leaves the server (spec §45). */
  masked: string | null;
  source: 'DB' | 'ENV' | 'DEFAULT';
  lastUpdatedAt: string | null;
}

interface MapsAdminSnapshot {
  config: MapsProviderSettings;
  secrets: MapsSecretStatus[];
  lastUpdatedAt: Record<string, string | null>;
  source: Record<string, string>;
}

interface MapsValidationCheck {
  id: string;
  label: string;
  passed: boolean;
  inconclusive?: boolean;
  detail?: string;
}

type ValidationTarget = 'google' | 'openfreemap' | 'geocoding';

const GOOGLE_KEY = 'maps.google.apiKey';
const GEOCODING_KEY = 'maps.geocoding.apiKey';

// ─── Local form state ───────────────────────────────────────────────────────

interface MapsFormState {
  provider: MapProviderId;
  fallbackProvider: 'NONE' | MapProviderId;
  mapsEnabled: boolean;
  directionsEnabled: boolean;
  styleUrl: string;
  googleGeocodingEnabled: boolean;
  geocodingProvider: 'GOOGLE' | 'OSM';
  destinationMode: 'COORDINATES' | 'COORDINATES_AND_ADDRESS';
  origin: 'CURRENT_LOCATION' | 'NONE';
  openBehavior: 'AUTO' | 'APP' | 'WEB';
  buttonLabel: string;
}

type SecretAction =
  | { mode: 'idle' }
  | { mode: 'replace'; value: string }
  | { mode: 'remove' };

interface ValidationState {
  running: boolean;
  valid: boolean | null;
  checks: MapsValidationCheck[];
  error?: string;
  at: string | null;
}

const EMPTY_VALIDATION: ValidationState = { running: false, valid: null, checks: [], at: null };

function formFromConfig(c: MapsProviderSettings): MapsFormState {
  return {
    provider: c.provider,
    fallbackProvider: c.fallbackProvider,
    mapsEnabled: c.mapsEnabled,
    directionsEnabled: c.directionsEnabled,
    styleUrl: c.openfreemap?.styleUrl ?? '',
    googleGeocodingEnabled: c.google?.geocodingEnabled ?? true,
    geocodingProvider: c.geocoding?.provider ?? 'OSM',
    destinationMode: c.directions?.destinationMode ?? 'COORDINATES',
    origin: c.directions?.origin ?? 'CURRENT_LOCATION',
    openBehavior: c.directions?.openBehavior ?? 'AUTO',
    buttonLabel: c.directions?.buttonLabel ?? '',
  };
}

/**
 * Envelope tolerance for the admin endpoints (same philosophy as
 * normalizeMapsConfigPayload): api-client auto-unwraps `{ success, data }`
 * when ≤3 top-level keys, but the readers accept BOTH the unwrapped
 * snapshot and the raw envelope.
 */
function extractSnapshot(raw: unknown): MapsAdminSnapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const candidate = 'config' in obj ? obj : 'data' in obj && obj.data && typeof obj.data === 'object' ? (obj.data as Record<string, unknown>) : null;
  if (!candidate || !('config' in candidate)) return null;
  const config = candidate.config as MapsProviderSettings | null;
  if (!config || typeof config !== 'object' || !('provider' in config)) return null;
  return {
    config,
    secrets: Array.isArray(candidate.secrets) ? (candidate.secrets as MapsSecretStatus[]) : [],
    lastUpdatedAt: (candidate.lastUpdatedAt && typeof candidate.lastUpdatedAt === 'object'
      ? candidate.lastUpdatedAt
      : {}) as Record<string, string | null>,
    source: (candidate.source && typeof candidate.source === 'object'
      ? candidate.source
      : {}) as Record<string, string>,
  };
}

function isValidStyleUrl(url: string): boolean {
  if (!/^https?:\/\/.+/i.test(url)) return false;
  try {
    return new URL(url).hostname.includes('.');
  } catch {
    return false;
  }
}

function formatDateTime(iso: string | null | undefined, lang: string): string {
  if (!iso) return '—';
  try {
    const locale = lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-FR' : 'en-GB';
    return new Date(iso).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

// ─── Animation variants (same pattern as admin-settings.tsx) ───────────────
const fadeUp = {
  initial: { opacity: 0, y: 15 },
  animate: { opacity: 1, y: 0 },
};

// ─── Location Editor (Task 2-b) — offline Algeria dataset totals ───────────
// Computed from the data itself, never hardcoded.
const WILAYA_TOTAL = ALGERIA_WILAYAS.length;
const COMMUNE_TOTAL = ALGERIA_WILAYAS.reduce((sum, w) => sum + w.communes.length, 0);

/** Case- and diacritics-insensitive Latin folding (Arabic needs no folding). */
function normalizeSearchText(value: string): string {
  return value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// ─── Component ─────────────────────────────────────────────────────────────
export function AdminMapsSettings() {
  const { t, lang } = useLanguage();

  // ── Snapshot / loading ──
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [snapshot, setSnapshot] = useState<MapsAdminSnapshot | null>(null);

  // ── Form state (local until Save — spec §43) ──
  const [form, setForm] = useState<MapsFormState | null>(null);
  const [saving, setSaving] = useState(false);

  // ── Pending secret edits (never round-trip the mask) ──
  const [googleKeyAction, setGoogleKeyAction] = useState<SecretAction>({ mode: 'idle' });
  const [geocodingKeyAction, setGeocodingKeyAction] = useState<SecretAction>({ mode: 'idle' });

  // ── Per-target validation results ──
  const [validations, setValidations] = useState<Record<ValidationTarget, ValidationState>>({
    google: EMPTY_VALIDATION,
    openfreemap: EMPTY_VALIDATION,
    geocoding: EMPTY_VALIDATION,
  });

  // ── Test map (spec §19) ──
  const [testOpen, setTestOpen] = useState(false);
  const [testRunId, setTestRunId] = useState(0);
  const testAnchorRef = useRef<HTMLDivElement | null>(null);

  // SAVED config for the test map. useMapConfig() is the baseline (60s TTL
  // module cache shared with every other map surface); the fresh admin
  // snapshot wins right after GET/PUT so a Test Map click always renders the
  // just-saved configuration.
  const { config: hookConfig } = useMapConfig();
  const [savedConfig, setSavedConfig] = useState<MapsProviderSettings | null>(null);
  const testConfig = savedConfig ?? hookConfig;

  const applySnapshot = useCallback((snap: MapsAdminSnapshot) => {
    setSnapshot(snap);
    setForm(formFromConfig(snap.config));
    setSavedConfig(snap.config);
  }, []);

  const fetchSnapshot = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      const res = await apiFetch('/api/admin/settings/maps');
      const data = res.ok ? await res.json().catch(() => null) : null;
      const snap = extractSnapshot(data);
      if (snap) {
        applySnapshot(snap);
      } else {
        setLoadFailed(true);
      }
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [applySnapshot]);

  useEffect(() => {
    fetchSnapshot();
  }, [fetchSnapshot]);

  // ── Save body: ONLY actually-changed keys (server re-validates + audits) ──
  const buildSaveBody = useCallback((): Record<string, unknown> | null => {
    if (!snapshot || !form) return null;
    const c = snapshot.config;
    const body: Record<string, unknown> = {};

    if (form.provider !== c.provider) body.provider = form.provider;
    if (form.fallbackProvider !== c.fallbackProvider) body.fallbackProvider = form.fallbackProvider;
    if (form.mapsEnabled !== c.mapsEnabled) body.mapsEnabled = form.mapsEnabled;
    if (form.directionsEnabled !== c.directionsEnabled) body.directionsEnabled = form.directionsEnabled;

    const styleUrl = form.styleUrl.trim();
    if (styleUrl !== (c.openfreemap?.styleUrl ?? '')) {
      body.openfreemap = { styleUrl };
    }
    if (form.googleGeocodingEnabled !== (c.google?.geocodingEnabled ?? true)) {
      body.google = { ...(body.google as object | undefined), geocodingEnabled: form.googleGeocodingEnabled };
    }
    if (googleKeyAction.mode === 'replace' && googleKeyAction.value.trim()) {
      body.google = { ...(body.google as object | undefined), apiKey: googleKeyAction.value.trim() };
    } else if (googleKeyAction.mode === 'remove') {
      body.google = { ...(body.google as object | undefined), apiKey: null };
    }

    if (form.geocodingProvider !== (c.geocoding?.provider ?? 'OSM')) {
      body.geocoding = { ...(body.geocoding as object | undefined), provider: form.geocodingProvider };
    }
    if (geocodingKeyAction.mode === 'replace' && geocodingKeyAction.value.trim()) {
      body.geocoding = { ...(body.geocoding as object | undefined), apiKey: geocodingKeyAction.value.trim() };
    } else if (geocodingKeyAction.mode === 'remove') {
      body.geocoding = { ...(body.geocoding as object | undefined), apiKey: null };
    }

    const label = form.buttonLabel.trim();
    if (form.destinationMode !== (c.directions?.destinationMode ?? 'COORDINATES')) {
      body.directions = { ...(body.directions as object | undefined), destinationMode: form.destinationMode };
    }
    if (form.origin !== (c.directions?.origin ?? 'CURRENT_LOCATION')) {
      body.directions = { ...(body.directions as object | undefined), origin: form.origin };
    }
    if (form.openBehavior !== (c.directions?.openBehavior ?? 'AUTO')) {
      body.directions = { ...(body.directions as object | undefined), openBehavior: form.openBehavior };
    }
    if (label !== (c.directions?.buttonLabel ?? '')) {
      body.directions = { ...(body.directions as object | undefined), buttonLabel: label === '' ? null : label };
    }

    return Object.keys(body).length > 0 ? body : null;
  }, [snapshot, form, googleKeyAction, geocodingKeyAction]);

  const isDirty = useMemo(() => buildSaveBody() !== null, [buildSaveBody]);
  const styleUrlInvalid = !!form && !!form.styleUrl.trim() && !isValidStyleUrl(form.styleUrl.trim());

  const handleSave = async () => {
    const body = buildSaveBody();
    if (!body || !form) return;

    // Client-side style URL sanity — the API re-validates everything and is
    // atomic (validate-all-then-write), so a bad value never half-applies.
    const ofm = body.openfreemap as { styleUrl?: string } | undefined;
    if (ofm?.styleUrl && !isValidStyleUrl(ofm.styleUrl)) {
      toast.error(t('adminMapsSettings.invalidStyleUrl'));
      return;
    }

    setSaving(true);
    try {
      const res = await apiFetch('/api/admin/settings/maps', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = res.ok ? await res.json().catch(() => null) : null;
      if (res.ok && data) {
        // The PUT responds with a FRESH snapshot (api-client unwraps the
        // envelope) — adopt it directly instead of a second round-trip.
        const snap = extractSnapshot(data);
        if (snap) applySnapshot(snap);
        setGoogleKeyAction({ mode: 'idle' });
        setGeocodingKeyAction({ mode: 'idle' });
        toast.success(t('adminMapsSettings.saved'));
      } else {
        const errBody = await res.json().catch(() => null);
        const msg =
          errBody && typeof errBody === 'object' && 'error' in errBody && typeof errBody.error === 'string'
            ? errBody.error
            : t('error');
        toast.error(msg);
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setSaving(false);
    }
  };

  // ── Explicit validation (spec §18) ──
  const runValidate = async (target: ValidationTarget) => {
    setValidations((v) => ({ ...v, [target]: { ...v[target], running: true } }));
    try {
      const res = await apiFetch('/api/admin/settings/maps/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target }),
      });
      const data = res.ok ? await res.json().catch(() => null) : null;
      if (res.ok && data && typeof data === 'object' && 'valid' in (data as Record<string, unknown>)) {
        const d = data as { valid: boolean; checks?: MapsValidationCheck[]; error?: string };
        setValidations((v) => ({
          ...v,
          [target]: {
            running: false,
            valid: !!d.valid,
            checks: Array.isArray(d.checks) ? d.checks : [],
            error: typeof d.error === 'string' ? d.error : undefined,
            at: new Date().toISOString(),
          },
        }));
      } else {
        setValidations((v) => ({ ...v, [target]: { ...v[target], running: false } }));
        const errBody = await res.json().catch(() => null);
        const msg =
          errBody && typeof errBody === 'object' && 'error' in errBody && typeof errBody.error === 'string'
            ? errBody.error
            : t('error');
        toast.error(msg);
      }
    } catch {
      setValidations((v) => ({ ...v, [target]: { ...v[target], running: false } }));
      toast.error(t('error'));
    }
  };

  const openTestMap = () => {
    setTestOpen(true);
    setTestRunId((n) => n + 1);
    // Let the card mount, then bring it into view.
    setTimeout(() => testAnchorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
  };

  // ── Loading skeleton ──
  if (loading && !snapshot) {
    return (
      <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50">
        <CardHeader className="pb-3">
          <Skeleton className="h-5 w-56" />
          <Skeleton className="h-3 w-80" />
        </CardHeader>
        <CardContent className="space-y-4">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-24 w-full" />
        </CardContent>
      </Card>
    );
  }

  // ── Load failure ──
  if (loadFailed || !snapshot || !form) {
    return (
      <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50">
        <CardContent className="py-8 text-center space-y-3">
          <AlertTriangle className="h-8 w-8 text-amber-500 mx-auto" />
          <p className="text-sm text-muted-foreground">{t('adminMapsSettings.loadError')}</p>
          <Button variant="outline" size="sm" onClick={fetchSnapshot} className="gap-2">
            <RefreshCw className="h-3.5 w-3.5" />
            {t('refresh')}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const googleSecret = snapshot.secrets.find((s) => s.key === GOOGLE_KEY);
  const geocodingSecret = snapshot.secrets.find((s) => s.key === GEOCODING_KEY);
  const lastChangeAt = Object.values(snapshot.lastUpdatedAt)
    .filter((v): v is string => typeof v === 'string')
    .sort()
    .pop() ?? null;

  return (
    <div className="space-y-5" data-testid="admin-maps-settings">
      {/* ─── Section header ─── */}
      <div>
        <h2 className="text-base font-semibold flex items-center gap-2">
          <MapPin className="h-4 w-4 text-emerald-600" />
          {t('adminMapsSettings.title')}
        </h2>
        <p className="text-xs text-muted-foreground mt-0.5">{t('adminMapsSettings.subtitle')}</p>
      </div>

      {/* ─── Location Editor (Task 2-b — offline Algeria wilaya/commune
           browser) — pinned to the TOP so it is the first thing admins see ─── */}
      <motion.div {...fadeUp} transition={{ delay: 0.05 }}>
        <LocationEditor onShowTestMap={openTestMap} />
      </motion.div>

      {/* ─── General (spec §8/§33 + feature flags) ─── */}
      <motion.div {...fadeUp} transition={{ delay: 0.1 }}>
      <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <MapIcon className="h-4 w-4 text-emerald-600" />
            {t('adminMapsSettings.general')}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0 space-y-5">
          {/* Main provider */}
          <div className="space-y-2">
            <Label className="text-xs font-medium">{t('adminMapsSettings.mainProvider')}</Label>
            <p className="text-[11px] text-muted-foreground">{t('adminMapsSettings.mainProviderDesc')}</p>
            <RadioGroup
              value={form.provider}
              onValueChange={(v) => {
                const provider = v as MapProviderId;
                // Spec §33 — the fallback is the OTHER provider; auto-heal so
                // the fallback never mirrors the main provider.
                const fallback =
                  form.fallbackProvider !== 'NONE' && form.fallbackProvider === provider
                    ? provider === 'GOOGLE'
                      ? 'OPENFREEMAP'
                      : 'GOOGLE'
                    : form.fallbackProvider;
                setForm({ ...form, provider, fallbackProvider: fallback });
              }}
              className="flex flex-wrap gap-4 sm:gap-6"
            >
              <label className="flex items-center gap-2 cursor-pointer" htmlFor="maps-provider-google">
                <RadioGroupItem value="GOOGLE" id="maps-provider-google" />
                <span className="text-xs">{t('adminMapsSettings.providerGoogle')}</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer" htmlFor="maps-provider-openfreemap">
                <RadioGroupItem value="OPENFREEMAP" id="maps-provider-openfreemap" />
                <span className="text-xs">{t('adminMapsSettings.providerOpenFreeMap')}</span>
              </label>
            </RadioGroup>
          </div>

          <Separator />

          {/* Fallback provider */}
          <div className="space-y-2">
            <Label className="text-xs font-medium">{t('adminMapsSettings.fallbackProvider')}</Label>
            <p className="text-[11px] text-muted-foreground">{t('adminMapsSettings.fallbackProviderDesc')}</p>
            <RadioGroup
              value={form.fallbackProvider}
              onValueChange={(v) => setForm({ ...form, fallbackProvider: v as MapsFormState['fallbackProvider'] })}
              className="flex flex-wrap gap-4 sm:gap-6"
            >
              <label className="flex items-center gap-2 cursor-pointer" htmlFor="maps-fallback-none">
                <RadioGroupItem value="NONE" id="maps-fallback-none" />
                <span className="text-xs">{t('adminMapsSettings.fallbackDisabled')}</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer" htmlFor="maps-fallback-secondary">
                <RadioGroupItem
                  value={form.provider === 'GOOGLE' ? 'OPENFREEMAP' : 'GOOGLE'}
                  id="maps-fallback-secondary"
                />
                <span className="text-xs">
                  {t('adminMapsSettings.fallbackSecondary')} (
                  {form.provider === 'GOOGLE'
                    ? t('adminMapsSettings.providerOpenFreeMap')
                    : t('adminMapsSettings.providerGoogle')}
                  )
                </span>
              </label>
            </RadioGroup>
          </div>

          <Separator />

          {/* Feature flags */}
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5 min-w-0">
                <Label className="text-xs font-medium">{t('adminMapsSettings.enableMaps')}</Label>
                <p className="text-[11px] text-muted-foreground">{t('adminMapsSettings.enableMapsDesc')}</p>
              </div>
              <Switch
                checked={form.mapsEnabled}
                onCheckedChange={(v) => setForm({ ...form, mapsEnabled: v })}
                aria-label={t('adminMapsSettings.enableMaps')}
              />
            </div>
            {!form.mapsEnabled && (
              <div className="flex items-start gap-2 rounded-xl border border-amber-200 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-900/20 p-2.5">
                <AlertTriangle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
                <p className="text-[11px] text-amber-800 dark:text-amber-200">
                  {t('adminMapsSettings.mapsDisabledWarning')}
                </p>
              </div>
            )}
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5 min-w-0">
                <Label className="text-xs font-medium">{t('adminMapsSettings.enableDirections')}</Label>
                <p className="text-[11px] text-muted-foreground">{t('adminMapsSettings.enableDirectionsDesc')}</p>
              </div>
              <Switch
                checked={form.directionsEnabled}
                onCheckedChange={(v) => setForm({ ...form, directionsEnabled: v })}
                aria-label={t('adminMapsSettings.enableDirections')}
              />
            </div>
          </div>
        </CardContent>
      </Card>
      </motion.div>

      {/* ─── Google Maps (spec §10/§11/§45) ─── */}
      <motion.div {...fadeUp} transition={{ delay: 0.15 }}>
      <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-emerald-600" />
            {t('adminMapsSettings.googleSection')}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0 space-y-4">
          <MaskedKeyField
            label={t('adminMapsSettings.googleApiKey')}
            description={t('adminMapsSettings.googleApiKeyDesc')}
            secret={googleSecret}
            action={googleKeyAction}
            onAction={setGoogleKeyAction}
          />

          {/* Google Geocoding service toggle (spec §11 — only services actually used) */}
          <div className="space-y-3 p-3 rounded-xl bg-gray-50 dark:bg-gray-800/40 border border-gray-100 dark:border-gray-800">
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5 min-w-0">
                <Label className="text-xs font-medium">{t('adminMapsSettings.googleGeocodingEnabled')}</Label>
                <p className="text-[11px] text-muted-foreground">{t('adminMapsSettings.googleGeocodingDesc')}</p>
              </div>
              <Switch
                checked={form.googleGeocodingEnabled}
                onCheckedChange={(v) => setForm({ ...form, googleGeocodingEnabled: v })}
                aria-label={t('adminMapsSettings.googleGeocodingEnabled')}
              />
            </div>
          </div>

          <p className="text-[11px] text-muted-foreground flex items-start gap-1.5">
            <ExternalLink className="h-3 w-3 mt-0.5 shrink-0" />
            {t('adminMapsSettings.googleJsKeyNote')}
          </p>

          <SectionActions
            validating={validations.google.running}
            onValidate={() => runValidate('google')}
            onTestMap={openTestMap}
          />
          <ValidationResults state={validations.google} validText={t('adminMapsSettings.validationValid')} invalidText={t('adminMapsSettings.validationInvalid')} />
        </CardContent>
      </Card>
      </motion.div>

      {/* ─── OpenFreeMap (spec §12) ─── */}
      <motion.div {...fadeUp} transition={{ delay: 0.2 }}>
      <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <MapIcon className="h-4 w-4 text-emerald-600" />
            {t('adminMapsSettings.openfreemapSection')}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0 space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">{t('adminMapsSettings.openfreemapStyleUrl')}</Label>
            <p className="text-[11px] text-muted-foreground">{t('adminMapsSettings.openfreemapStyleUrlDesc')}</p>
            <Input
              value={form.styleUrl}
              onChange={(e) => setForm({ ...form, styleUrl: e.target.value })}
              placeholder="https://tiles.openfreemap.org/styles/liberty"
              className="h-9 text-xs font-mono"
              dir="ltr"
              aria-invalid={styleUrlInvalid}
            />
            {styleUrlInvalid && (
              <p className="text-[11px] text-red-600 dark:text-red-400">{t('adminMapsSettings.invalidStyleUrl')}</p>
            )}
          </div>

          <SectionActions
            validating={validations.openfreemap.running}
            onValidate={() => runValidate('openfreemap')}
            onTestMap={openTestMap}
          />
          <ValidationResults
            state={validations.openfreemap}
            validText={t('adminMapsSettings.validationValid')}
            invalidText={t('adminMapsSettings.validationInvalid')}
          />
        </CardContent>
      </Card>
      </motion.div>

      {/* ─── Geocoding (spec §14/§15) ─── */}
      <motion.div {...fadeUp} transition={{ delay: 0.25 }}>
      <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <MapPin className="h-4 w-4 text-emerald-600" />
            {t('adminMapsSettings.geocodingSection')}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0 space-y-4">
          <div className="space-y-2">
            <Label className="text-xs font-medium">{t('adminMapsSettings.geocodingProvider')}</Label>
            <p className="text-[11px] text-muted-foreground">{t('adminMapsSettings.geocodingProviderDesc')}</p>
            <RadioGroup
              value={form.geocodingProvider}
              onValueChange={(v) => setForm({ ...form, geocodingProvider: v as MapsFormState['geocodingProvider'] })}
              className="flex flex-wrap gap-4 sm:gap-6"
            >
              <label className="flex items-center gap-2 cursor-pointer" htmlFor="maps-geocoding-google">
                <RadioGroupItem value="GOOGLE" id="maps-geocoding-google" />
                <span className="text-xs">{t('adminMapsSettings.geocodingGoogle')}</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer" htmlFor="maps-geocoding-osm">
                <RadioGroupItem value="OSM" id="maps-geocoding-osm" />
                <span className="text-xs">{t('adminMapsSettings.geocodingOsm')}</span>
              </label>
            </RadioGroup>
          </div>

          {form.geocodingProvider === 'GOOGLE' ? (
            <MaskedKeyField
              label={t('adminMapsSettings.geocodingApiKey')}
              description={t('adminMapsSettings.googleApiKeyDesc')}
              secret={geocodingSecret}
              action={geocodingKeyAction}
              onAction={setGeocodingKeyAction}
            />
          ) : (
            <p className="text-[11px] text-emerald-700 dark:text-emerald-400 flex items-start gap-1.5">
              <CheckCircle2 className="h-3 w-3 mt-0.5 shrink-0" />
              {t('adminMapsSettings.geocodingNoKeyNeeded')}
            </p>
          )}

          <SectionActions
            validating={validations.geocoding.running}
            onValidate={() => runValidate('geocoding')}
            showTestMap={false}
          />
          <ValidationResults
            state={validations.geocoding}
            validText={t('adminMapsSettings.validationValid')}
            invalidText={t('adminMapsSettings.validationInvalid')}
          />
        </CardContent>
      </Card>
      </motion.div>

      {/* ─── Directions (spec §20-§24) ─── */}
      <motion.div {...fadeUp} transition={{ delay: 0.3 }}>
      <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Navigation className="h-4 w-4 text-emerald-600" />
            {t('adminMapsSettings.directionsSection')}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0 space-y-5">
          {/* Destination mode */}
          <div className="space-y-2">
            <Label className="text-xs font-medium">{t('adminMapsSettings.destinationMode')}</Label>
            <RadioGroup
              value={form.destinationMode}
              onValueChange={(v) => setForm({ ...form, destinationMode: v as MapsFormState['destinationMode'] })}
              className="flex flex-col gap-2"
            >
              <label className="flex items-center gap-2 cursor-pointer" htmlFor="maps-dest-coords">
                <RadioGroupItem value="COORDINATES" id="maps-dest-coords" />
                <span className="text-xs">{t('adminMapsSettings.coordinatesMode')}</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer" htmlFor="maps-dest-coords-address">
                <RadioGroupItem value="COORDINATES_AND_ADDRESS" id="maps-dest-coords-address" />
                <span className="text-xs">{t('adminMapsSettings.coordinatesAddressMode')}</span>
              </label>
            </RadioGroup>
          </div>

          <Separator />

          {/* Origin */}
          <div className="space-y-2">
            <Label className="text-xs font-medium">{t('adminMapsSettings.originMode')}</Label>
            <RadioGroup
              value={form.origin}
              onValueChange={(v) => setForm({ ...form, origin: v as MapsFormState['origin'] })}
              className="flex flex-col gap-2"
            >
              <label className="flex items-start gap-2 cursor-pointer" htmlFor="maps-origin-current">
                <RadioGroupItem value="CURRENT_LOCATION" id="maps-origin-current" className="mt-0.5" />
                <span className="text-xs">{t('adminMapsSettings.currentLocationOrigin')}</span>
              </label>
              <label className="flex items-start gap-2 cursor-pointer" htmlFor="maps-origin-none">
                <RadioGroupItem value="NONE" id="maps-origin-none" className="mt-0.5" />
                <span className="text-xs">{t('adminMapsSettings.noOrigin')}</span>
              </label>
            </RadioGroup>
          </div>

          <Separator />

          {/* Open behavior */}
          <div className="space-y-2">
            <Label className="text-xs font-medium">{t('adminMapsSettings.openBehavior')}</Label>
            <RadioGroup
              value={form.openBehavior}
              onValueChange={(v) => setForm({ ...form, openBehavior: v as MapsFormState['openBehavior'] })}
              className="flex flex-col gap-2"
            >
              <label className="flex items-start gap-2 cursor-pointer" htmlFor="maps-behavior-app">
                <RadioGroupItem value="APP" id="maps-behavior-app" className="mt-0.5" />
                <span className="text-xs">{t('adminMapsSettings.appBehavior')}</span>
              </label>
              <label className="flex items-start gap-2 cursor-pointer" htmlFor="maps-behavior-auto">
                <RadioGroupItem value="AUTO" id="maps-behavior-auto" className="mt-0.5" />
                <span className="text-xs">{t('adminMapsSettings.autoBehavior')}</span>
              </label>
              <label className="flex items-start gap-2 cursor-pointer" htmlFor="maps-behavior-web">
                <RadioGroupItem value="WEB" id="maps-behavior-web" className="mt-0.5" />
                <span className="text-xs">{t('adminMapsSettings.webBehavior')}</span>
              </label>
            </RadioGroup>
          </div>

          <Separator />

          {/* Custom button label (spec §24) */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">{t('adminMapsSettings.buttonLabel')}</Label>
            <p className="text-[11px] text-muted-foreground">{t('adminMapsSettings.buttonLabelDesc')}</p>
            <Input
              value={form.buttonLabel}
              onChange={(e) => setForm({ ...form, buttonLabel: e.target.value })}
              placeholder={t('adminMapsSettings.buttonLabelPlaceholder')}
              maxLength={60}
              className="h-9 text-xs"
            />
          </div>
        </CardContent>
      </Card>
      </motion.div>

      {/* ─── Monitoring / status (spec §9/§34/§44) ─── */}
      <motion.div {...fadeUp} transition={{ delay: 0.35 }}>
      <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            {t('adminMapsSettings.monitoringSection')}
          </CardTitle>
          <p className="text-[11px] text-muted-foreground">
            {t('adminMapsSettings.lastUpdated')}: {formatDateTime(lastChangeAt, lang)}
          </p>
        </CardHeader>
        <CardContent className="pt-0 space-y-1">
          <StatusRow
            name={t('adminMapsSettings.providerGoogle')}
            status={googleStatus(googleSecret, validations.google.valid)}
            updated={snapshot.lastUpdatedAt[GOOGLE_KEY]}
            validation={validations.google}
            lang={lang}
          />
          <StatusRow
            name={t('adminMapsSettings.providerOpenFreeMap')}
            status={openfreemapStatus(validations.openfreemap.valid)}
            updated={snapshot.lastUpdatedAt['maps.openfreemap.styleUrl']}
            validation={validations.openfreemap}
            lang={lang}
          />
          <StatusRow
            name={t('adminMapsSettings.geocodingSection')}
            status={geocodingStatus(form.geocodingProvider, googleSecret, geocodingSecret, validations.geocoding.valid)}
            updated={snapshot.lastUpdatedAt['maps.geocoding.provider']}
            validation={validations.geocoding}
            lang={lang}
          />
          <StatusRow
            name={t('adminMapsSettings.directionsSection')}
            status={form.directionsEnabled ? { kind: 'available' } : { kind: 'disabled' }}
            updated={snapshot.lastUpdatedAt['maps.directions.openBehavior']}
            validation={EMPTY_VALIDATION}
            lang={lang}
          />
        </CardContent>
      </Card>
      </motion.div>

      {/* ─── Save (spec §43 — atomic PUT, explicit validation only) ─── */}
      <motion.div {...fadeUp} transition={{ delay: 0.4 }} className="space-y-2">
        <Button
          onClick={handleSave}
          disabled={saving || !isDirty || styleUrlInvalid}
          className="w-full h-10 text-xs bg-emerald-600 hover:bg-emerald-700"
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin me-2" /> : <Save className="h-3.5 w-3.5 me-2" />}
          {saving ? t('adminMapsSettings.saving') : t('adminMapsSettings.save')}
        </Button>
        {isDirty && (
          <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[11px] text-amber-700 dark:text-amber-400">
            <span className="flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" />
              {t('adminMapsSettings.unsavedChanges')}
            </span>
            {(googleKeyAction.mode !== 'idle' || geocodingKeyAction.mode !== 'idle') && (
              <span>{t('adminMapsSettings.dirtySecretHint')}</span>
            )}
          </div>
        )}
      </motion.div>

      {/* ─── Test map (spec §19) — rendered with the SAVED config ─── */}
      <div ref={testAnchorRef}>
        {testOpen && <MapsTestMapCard key={testRunId} config={testConfig} />}
      </div>
    </div>
  );
}

// ─── Location Editor (Task 2-b) — searchable read-only browser of the
// ── offline Algeria wilaya/commune dataset used by address selectors.

interface WilayaSearchMatch {
  wilaya: AlgeriaWilaya;
  /** null → the wilaya itself matched (expanded list shows ALL its communes);
   *  array → only these communes matched (parent wilaya shown as carrier). */
  matchedCommunes: AlgeriaCommune[] | null;
}

function matchWilayas(rawQuery: string): WilayaSearchMatch[] {
  const trimmed = rawQuery.trim();
  const q = normalizeSearchText(trimmed);
  if (!q) {
    return ALGERIA_WILAYAS.map((wilaya) => ({ wilaya, matchedCommunes: null }));
  }
  const codeQuery = /^[0-9]+$/.test(q);
  const matches: WilayaSearchMatch[] = [];
  for (const wilaya of ALGERIA_WILAYAS) {
    // '19' → code '19'; '9' → code '09'; '1' → codes '01'..'19'
    const codeHit =
      codeQuery && (wilaya.code.startsWith(q) || wilaya.code === q.padStart(2, '0'));
    const wilayaHit =
      !!codeHit ||
      normalizeSearchText(wilaya.name).includes(q) ||
      wilaya.nameAr.includes(trimmed);
    if (wilayaHit) {
      matches.push({ wilaya, matchedCommunes: null });
      continue;
    }
    const communeHits = wilaya.communes.filter(
      (c) => normalizeSearchText(c.name).includes(q) || c.nameAr.includes(trimmed)
    );
    if (communeHits.length > 0) {
      matches.push({ wilaya, matchedCommunes: communeHits });
    }
  }
  return matches;
}

function LocationEditor({ onShowTestMap }: { onShowTestMap?: () => void }) {
  const { t } = useLanguage();
  const [query, setQuery] = useState('');
  const [expandedCode, setExpandedCode] = useState<string | null>(null);

  const results = useMemo(() => matchWilayas(query), [query]);

  return (
    <Card
      className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50"
      data-testid="admin-location-editor"
    >
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base flex items-center gap-2">
            <MapPin className="h-4 w-4 text-emerald-600" />
            {t('adminMapsSettings.locationEditor')}
          </CardTitle>
          {onShowTestMap && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 text-[11px] gap-1.5"
              onClick={onShowTestMap}
            >
              <MapIcon className="h-3 w-3 text-emerald-600" />
              {t('adminMapsSettings.testMap')}
            </Button>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground">
          {t('adminMapsSettings.locationEditorDesc')}
        </p>
      </CardHeader>
      <CardContent className="pt-0 space-y-4">
        {/* Search — wilaya code / Latin name (diacritics-insensitive) / Arabic name, plus communes */}
        <div className="space-y-1.5">
          <div className="relative">
            <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('adminMapsSettings.locationSearchPlaceholder')}
              className="h-9 text-xs ps-9"
            />
          </div>
          <p className="text-[10px] text-muted-foreground">{t('adminMapsSettings.expandHint')}</p>
        </div>

        {/* Wilaya list — capped height, rows expand into a scrollable commune sub-list */}
        <div
          className="max-h-96 overflow-y-auto rounded-xl border border-gray-100 dark:border-gray-800 divide-y divide-gray-100 dark:divide-gray-800/60"
          data-testid="admin-location-editor-list"
        >
          {results.length === 0 && (
            <p className="p-4 text-xs text-muted-foreground text-center">
              {t('adminMapsSettings.locationNoResults')}
            </p>
          )}
          {results.map(({ wilaya, matchedCommunes }) => {
            const expanded = expandedCode === wilaya.code;
            const communes = matchedCommunes ?? wilaya.communes;
            return (
              <div key={wilaya.code}>
                <button
                  type="button"
                  onClick={() => setExpandedCode(expanded ? null : wilaya.code)}
                  aria-expanded={expanded}
                  className="w-full flex items-center gap-2.5 px-3 py-2.5 text-start hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors"
                >
                  <Badge
                    variant="outline"
                    className="shrink-0 text-[10px] px-1.5 bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800/60"
                  >
                    {wilaya.code}
                  </Badge>
                  <span className="text-xs font-medium truncate">{wilaya.name}</span>
                  <span className="text-xs text-muted-foreground truncate">{wilaya.nameAr}</span>
                  <span className="ms-auto flex items-center gap-1.5 shrink-0 text-[10px] text-muted-foreground">
                    {t('adminMapsSettings.communeCount', { count: String(communes.length) })}
                    <ChevronDown
                      className={`h-3.5 w-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`}
                    />
                  </span>
                </button>
                {expanded && (
                  <div className="max-h-48 overflow-y-auto bg-gray-50/60 dark:bg-gray-800/20">
                    {communes.map((commune) => (
                      <div
                        key={`${wilaya.code}-${commune.name}`}
                        className="flex items-center justify-between gap-3 px-3 ps-9 py-1.5 border-t border-gray-100 dark:border-gray-800/40"
                      >
                        <span className="text-[11px] truncate">{commune.name}</span>
                        <span className="text-[11px] text-muted-foreground truncate">
                          {commune.nameAr}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Offline static dataset note — counts computed from the data above */}
        <p className="text-[10px] text-muted-foreground flex items-start gap-1.5">
          <Database className="h-3 w-3 mt-0.5 shrink-0 text-emerald-600" />
          {t('adminMapsSettings.datasetNote', {
            wilayas: String(WILAYA_TOTAL),
            communes: String(COMMUNE_TOTAL),
          })}
        </p>
      </CardContent>
    </Card>
  );
}

// ─── Status derivation (spec §9) ────────────────────────────────────────────

type StatusKind = 'configured' | 'not_configured' | 'invalid' | 'available' | 'disabled';
interface StatusInfo {
  kind: StatusKind;
}

function googleStatus(secret: MapsSecretStatus | undefined, lastValid: boolean | null): StatusInfo {
  if (lastValid === false) return { kind: 'invalid' };
  return { kind: secret?.configured ? 'configured' : 'not_configured' };
}

function openfreemapStatus(lastValid: boolean | null): StatusInfo {
  if (lastValid === false) return { kind: 'invalid' };
  return { kind: 'configured' };
}

function geocodingStatus(
  provider: 'GOOGLE' | 'OSM',
  googleSecret: MapsSecretStatus | undefined,
  geocodingSecret: MapsSecretStatus | undefined,
  lastValid: boolean | null,
): StatusInfo {
  if (lastValid === false) return { kind: 'invalid' };
  if (provider === 'OSM') return { kind: 'available' };
  return { kind: googleSecret?.configured || geocodingSecret?.configured ? 'configured' : 'not_configured' };
}

type StatusLabelKey =
  | 'adminMapsSettings.statusConfigured'
  | 'adminMapsSettings.statusAvailable'
  | 'adminMapsSettings.statusNotConfigured'
  | 'adminMapsSettings.statusInvalid'
  | 'adminMapsSettings.fallbackDisabled';

function StatusChip({ status }: { status: StatusInfo }) {
  const { t } = useLanguage();
  const map: Record<StatusKind, { cls: string; icon: LucideIcon; key: StatusLabelKey }> = {
    configured: {
      cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800/60',
      icon: CheckCircle2,
      key: 'adminMapsSettings.statusConfigured',
    },
    available: {
      cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800/60',
      icon: CheckCircle2,
      key: 'adminMapsSettings.statusAvailable',
    },
    not_configured: {
      cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 border-amber-200 dark:border-amber-800/60',
      icon: AlertTriangle,
      key: 'adminMapsSettings.statusNotConfigured',
    },
    invalid: {
      cls: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300 border-red-200 dark:border-red-800/60',
      icon: XCircle,
      key: 'adminMapsSettings.statusInvalid',
    },
    disabled: {
      cls: 'bg-gray-100 text-gray-600 dark:bg-gray-800/60 dark:text-gray-400 border-gray-200 dark:border-gray-700',
      icon: XCircle,
      key: 'adminMapsSettings.fallbackDisabled',
    },
  };
  const entry = map[status.kind];
  const Icon = entry.icon;
  return (
    <Badge variant="outline" className={`gap-1 text-[10px] px-2 py-0.5 ${entry.cls}`}>
      <Icon className="h-3 w-3" />
      {t(entry.key)}
    </Badge>
  );
}

function StatusRow({
  name,
  status,
  updated,
  validation,
  lang,
}: {
  name: string;
  status: StatusInfo;
  updated: string | null;
  validation: ValidationState;
  lang: string;
}) {
  const { t } = useLanguage();
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 py-2 border-b border-gray-100 dark:border-gray-800/60 last:border-b-0">
      <span className="text-xs font-medium">{name}</span>
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip status={status} />
        <span className="text-[10px] text-muted-foreground">
          {t('adminMapsSettings.lastUpdated')}: {formatDateTime(updated, lang)}
        </span>
        {validation.at && validation.valid !== null && (
          <span
            className={`text-[10px] flex items-center gap-1 ${
              validation.valid ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
            }`}
          >
            {t('adminMapsSettings.lastValidation')}:{' '}
            {validation.valid ? t('adminMapsSettings.validationValid') : t('adminMapsSettings.validationInvalid')}
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Masked key field (spec §10/§45) ────────────────────────────────────────

function MaskedKeyField({
  label,
  description,
  secret,
  action,
  onAction,
}: {
  label: string;
  description: string;
  secret: MapsSecretStatus | undefined;
  action: SecretAction;
  onAction: (a: SecretAction) => void;
}) {
  const { t, lang } = useLanguage();
  const configured = !!secret?.configured;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label className="text-xs font-medium">{label}</Label>
        {configured ? (
          <Badge variant="outline" className="gap-1 text-[10px] bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800/60">
            <CheckCircle2 className="h-3 w-3" />
            {t('adminMapsSettings.keyConfigured')}
            {secret?.masked ? ` · ${secret.masked}` : ''}
          </Badge>
        ) : (
          <Badge variant="outline" className="gap-1 text-[10px] bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 border-amber-200 dark:border-amber-800/60">
            <AlertTriangle className="h-3 w-3" />
            {t('adminMapsSettings.keyNotConfigured')}
          </Badge>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground">{description}</p>
      {configured && secret?.source && action.mode === 'idle' && (
        <p className="text-[10px] text-muted-foreground">
          {secret.source === 'DB' ? t('adminMapsSettings.keySourceDb') : secret.source === 'ENV' ? t('adminMapsSettings.keySourceEnv') : ''}
          {secret.lastUpdatedAt ? ` · ${formatDateTime(secret.lastUpdatedAt, lang)}` : ''}
        </p>
      )}

      {action.mode === 'replace' && (
        <div className="space-y-1.5">
          <Input
            type="password"
            value={action.value}
            onChange={(e) => onAction({ mode: 'replace', value: e.target.value })}
            placeholder={t('adminMapsSettings.enterKeyPlaceholder')}
            className="h-9 text-xs font-mono"
            dir="ltr"
            autoComplete="off"
          />
          <Button variant="ghost" size="sm" className="h-7 text-[11px] gap-1" onClick={() => onAction({ mode: 'idle' })}>
            {t('cancel')}
          </Button>
        </div>
      )}

      {action.mode === 'remove' && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-200 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-900/20 p-2.5">
          <Trash2 className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
          <span className="text-[11px] text-amber-800 dark:text-amber-200">{t('adminMapsSettings.dirtySecretHint')}</span>
          <Button variant="ghost" size="sm" className="h-7 text-[11px] ms-auto" onClick={() => onAction({ mode: 'idle' })}>
            {t('cancel')}
          </Button>
        </div>
      )}

      {action.mode === 'idle' && (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 text-[11px] gap-1.5"
            onClick={() => onAction({ mode: 'replace', value: '' })}
          >
            {configured ? t('adminMapsSettings.replaceKey') : t('adminMapsSettings.setKey')}
          </Button>
          {configured && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 text-[11px] gap-1.5 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 border-red-200 dark:border-red-800/60"
              onClick={() => onAction({ mode: 'remove' })}
            >
              <Trash2 className="h-3 w-3" />
              {t('adminMapsSettings.removeKey')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Shared per-section action row ──────────────────────────────────────────

function SectionActions({
  validating,
  onValidate,
  onTestMap,
  showTestMap = true,
}: {
  validating: boolean;
  onValidate: () => void;
  onTestMap?: () => void;
  showTestMap?: boolean;
}) {
  const { t } = useLanguage();
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8 text-[11px] gap-1.5"
        onClick={onValidate}
        disabled={validating}
      >
        {validating ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <ShieldCheck className="h-3 w-3 text-emerald-600" />
        )}
        {validating ? t('adminMapsSettings.validating') : t('adminMapsSettings.validateConfig')}
      </Button>
      {showTestMap && onTestMap && (
        <Button type="button" variant="outline" size="sm" className="h-8 text-[11px] gap-1.5" onClick={onTestMap}>
          <MapIcon className="h-3 w-3 text-emerald-600" />
          {t('adminMapsSettings.testMap')}
        </Button>
      )}
    </div>
  );
}

// ─── Per-check validation results (spec §18) ───────────────────────────────

function ValidationResults({
  state,
  validText,
  invalidText,
}: {
  state: ValidationState;
  validText: string;
  invalidText: string;
}) {
  const { t } = useLanguage();
  if (state.running || (!state.checks.length && state.valid === null)) return null;

  return (
    <div className="space-y-1.5">
      <div
        className={`flex items-center gap-1.5 text-[11px] font-medium ${
          state.valid ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400'
        }`}
      >
        {state.valid ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
        {state.valid ? validText : invalidText}
      </div>
      {state.checks.map((check) => (
        <div key={check.id} className="flex items-start gap-1.5 ps-2">
          {check.inconclusive ? (
            <AlertTriangle className="h-3 w-3 text-amber-500 mt-0.5 shrink-0" />
          ) : check.passed ? (
            <CheckCircle2 className="h-3 w-3 text-emerald-600 mt-0.5 shrink-0" />
          ) : (
            <XCircle className="h-3 w-3 text-red-600 mt-0.5 shrink-0" />
          )}
          <div className="min-w-0">
            <p className="text-[11px] leading-snug">
              {check.label}
              <span className="text-muted-foreground ms-1">
                (
                {check.inconclusive
                  ? t('adminMapsSettings.checkInconclusive')
                  : check.passed
                    ? t('adminMapsSettings.checkPassed')
                    : t('adminMapsSettings.checkFailed')}
                )
              </span>
            </p>
            {check.detail && (
              <p className="text-[10px] text-muted-foreground break-words" dir="ltr">
                {check.detail}
              </p>
            )}
          </div>
        </div>
      ))}
      {state.error && (
        <p className="text-[10px] text-red-600 dark:text-red-400 break-words" dir="ltr">
          {state.error}
        </p>
      )}
    </div>
  );
}

// ─── Live test map (spec §19) — reuses 51-b's provider abstraction ──────────

function MapsTestMapCard({ config }: { config: MapsProviderSettings | null }) {
  const { t } = useLanguage();
  return (
    <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50" data-testid="maps-test-map-card">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <MapIcon className="h-4 w-4 text-emerald-600" />
          {t('adminMapsSettings.testMap')}
        </CardTitle>
        <p className="text-[11px] text-muted-foreground">{t('adminMapsSettings.testMapHint')}</p>
      </CardHeader>
      <CardContent className="pt-0">
        <MapsTestMap config={config} />
      </CardContent>
    </Card>
  );
}

function MapsTestMap({ config, height = 260 }: { config: MapsProviderSettings | null; height?: number }) {
  const { t } = useLanguage();
  const online = useOnlineStatus();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const providerRef = useRef<MapProviderInstance | null>(null);
  const seqRef = useRef(0);
  const [mapState, setMapState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [activeProvider, setActiveProvider] = useState<MapProviderId | null>(null);

  useEffect(() => {
    if (!config || !config.mapsEnabled) return;
    if (!isProviderAvailable(config)) {
      setMapState('failed');
      return;
    }
    const container = containerRef.current;
    if (!container) return;

    const seq = ++seqRef.current;
    const provider = createMapProvider(config);
    if (!provider) {
      setMapState('failed');
      return;
    }
    providerRef.current = provider;
    setActiveProvider(provider.provider);
    setMapState('loading');

    // Basic interaction (spec §19): clicking the map moves the marker.
    provider.onMapClick((ll) => provider.moveMarker(ll));

    provider
      .init(container, { center: DEFAULT_MAP_CENTER, zoom: COUNTRY_ZOOM })
      .then(() => {
        if (seqRef.current !== seq) return;
        setMapState('ready');
        provider.placeMarker(DEFAULT_MAP_CENTER);
      })
      .catch((err) => {
        if (seqRef.current !== seq) return;
        console.warn('[AdminMapsSettings] test map init failed:', err?.message ?? err);
        setMapState('failed');
      });

    return () => {
      seqRef.current += 1;
      provider.destroy();
      if (providerRef.current === provider) providerRef.current = null;
    };
  }, [config, online]);

  // No saved config yet → cannot render a meaningful test.
  if (!config) {
    return (
      <div className="flex items-start gap-3 rounded-xl border border-amber-200 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-900/20 p-3">
        <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
        <p className="text-xs text-amber-800 dark:text-amber-200">{t('adminMapsSettings.testMapFailed')}</p>
      </div>
    );
  }

  // Maps deliberately disabled → the customer surfaces show addresses only.
  if (!config.mapsEnabled) {
    return (
      <div className="flex items-start gap-3 rounded-xl border border-amber-200 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-900/20 p-3">
        <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
        <p className="text-xs text-amber-800 dark:text-amber-200">{t('adminMapsSettings.mapsDisabledWarning')}</p>
      </div>
    );
  }

  const unavailable = mapState === 'failed' || (!online && mapState === 'loading');
  if (unavailable) {
    return (
      <div className="space-y-2">
        <div className="flex items-start gap-3 rounded-xl border border-amber-200 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-900/20 p-3">
          <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
          <p className="text-xs text-amber-800 dark:text-amber-200">{t('adminMapsSettings.testMapFailed')}</p>
        </div>
        <p className="text-[11px] text-muted-foreground">
          {t('adminMapsSettings.testMapProvider', { provider: activeProvider ?? config.provider })}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div
        className="relative w-full rounded-xl overflow-hidden border border-gray-200 dark:border-gray-700 bg-gray-100 dark:bg-gray-800"
        style={{ height }}
      >
        {/* Explicit inline sizing — maplibre-gl.css ships `.maplibregl-map
            {position:relative;overflow:hidden}` which can out-cascade
            Tailwind's `absolute inset-0` depending on chunk order and clip
            the map to zero height. Inline styles are immune to that. */}
        <div ref={containerRef} dir="ltr" style={{ height: '100%', width: '100%' }} />
        {mapState === 'loading' && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-100/80 dark:bg-gray-800/80 z-10">
            <Loader2 className="h-6 w-6 animate-spin text-emerald-600" />
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] text-muted-foreground">
          {t('adminMapsSettings.testMapProvider', {
            provider: activeProvider ?? config.provider,
          })}
        </p>
        <p className="text-[11px] text-muted-foreground" dir="ltr">
          {DEFAULT_MAP_CENTER.lat.toFixed(4)}, {DEFAULT_MAP_CENTER.lng.toFixed(4)}
        </p>
      </div>
    </div>
  );
}
