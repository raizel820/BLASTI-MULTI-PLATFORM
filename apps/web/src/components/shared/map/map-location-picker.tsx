'use client';

/**
 * MapLocationPicker — interactive agency location picker (Task 51-b,
 * spec §27/§28/§29/§30/§40).
 *
 * - Renders the Super-Admin-configured provider via `createMapProvider`.
 * - Click-to-place + draggable marker (spec §28); every movement updates
 *   TEMPORARY form state through `onChange` — persistence is the form's job.
 * - "Use my current location" button (navigator.geolocation; denial is
 *   handled gracefully — the rest of the picker keeps working).
 * - After a marker settles (600ms debounce) the configured geocoder is
 *   queried (spec §29) and `addressFields.onDetected` fires with ONLY the
 *   components the geocoder actually returned (missing parts are null —
 *   never invented).
 * - Offline / provider failure (spec §40): a friendly box replaces the map
 *   while the coordinates stay functional (geolocation button + readout).
 *
 * MANUAL-OVERRIDE CONTRACT (spec §30): `onChange` fires on every EXPLICIT
 * location change (map click / drag settle / geolocation) BEFORE the
 * debounced reverse geocode. Parents keep a `manualTouched` flag — set it
 * when the user types into address fields, reset it inside `onChange` — and
 * apply `onDetected` only while the flag is clear. Textual address and
 * coordinates therefore stay independent.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Crosshair, MapPin, MapPinOff, Loader2, LocateFixed } from 'lucide-react';
import { useLanguage } from '@/hooks/use-language';
import { useOnlineStatus } from '@/hooks/use-online-status';
import { toast } from 'sonner';
import {
  createMapProvider,
  isProviderAvailable,
  DEFAULT_MAP_CENTER,
  MARKER_ZOOM,
  COUNTRY_ZOOM,
  reverseGeocode,
  type GeocodeComponents,
  type LatLng,
  type MapProviderInstance,
  type MapsProviderSettings,
} from '@/lib/map';
import { useMapConfig } from '@/lib/map/use-map-config';
import 'maplibre-gl/dist/maplibre-gl.css';

// Re-export so picker consumers (create-agency-form, agency-profile) can
// import the component AND the detected-address component type together.
export type { GeocodeComponents } from '@/lib/map';

export interface MapLocationPickerValue {
  latitude: number | null;
  longitude: number | null;
}

export interface MapLocationPickerProps {
  value: MapLocationPickerValue;
  /** Explicit location change (click/drag settle/geolocation). */
  onChange: (lat: number | null, lng: number | null) => void;
  /** Reverse-geocode plumbing (spec §29); omit for coordinate-only pickers. */
  addressFields?: {
    onDetected: (components: GeocodeComponents) => void;
  };
  /** Map height in px (default 280). */
  height?: number;
  /**
   * Optional: receives the locationSource of each explicit pick
   * ('GOOGLE' | 'OPENFREEMAP' | 'DEVICE_GPS') so parents can persist it.
   */
  onLocationSource?: (source: 'GOOGLE' | 'OPENFREEMAP' | 'DEVICE_GPS') => void;
}

const GEOSETTLE_DEBOUNCE_MS = 600;

/** Format a coordinate for the readout (fixed 6 decimals, LTR). */
const fmt = (n: number) => n.toFixed(6);

export function MapLocationPicker({
  value,
  onChange,
  addressFields,
  height = 280,
  onLocationSource,
}: MapLocationPickerProps) {
  const { t, lang } = useLanguage();
  const online = useOnlineStatus();
  const { config, loading: configLoading } = useMapConfig();

  const containerRef = useRef<HTMLDivElement | null>(null);
  const providerRef = useRef<MapProviderInstance | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const initSeqRef = useRef(0);
  const lastEmittedRef = useRef<string>('');
  const zoomLiftedRef = useRef(false);
  const [mapState, setMapState] = useState<'loading' | 'ready' | 'failed'>('loading');

  const [locating, setLocating] = useState(false);
  const [detected, setDetected] = useState<GeocodeComponents | null>(null);
  const [geocodingNow, setGeocodingNow] = useState(false);

  // Stable refs for callbacks registered into the provider. Writes happen in
  // an EFFECT, never during render (react-hooks/refs): every consumer reads
  // `.current` from event handlers / timers that only fire after commit, so a
  // post-render sync is always in time.
  const onChangeRef = useRef(onChange);
  const onDetectedRef = useRef(addressFields?.onDetected);
  const onLocationSourceRef = useRef(onLocationSource);
  const configRef = useRef<MapsProviderSettings | null>(config);
  const langRef = useRef(lang);
  // Latest picker value, read by the init effect WITHOUT being a dependency:
  // re-initializing the map when `hasCoords` flips (async profile load, or the
  // user's own first click) destroys a working map just to change the initial
  // center — the value-sync effect below already moves the marker + viewport
  // when coordinates arrive externally.
  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);
  useEffect(() => {
    onChangeRef.current = onChange;
    onDetectedRef.current = addressFields?.onDetected;
    onLocationSourceRef.current = onLocationSource;
    configRef.current = config;
    langRef.current = lang;
  }, [onChange, addressFields, onLocationSource, config, lang]);

  // ── Reverse geocode with settle debounce (spec §29) ────────────────────
  const geocodeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settleAndGeocode = useCallback((ll: LatLng) => {
    if (geocodeTimerRef.current) clearTimeout(geocodeTimerRef.current);
    geocodeTimerRef.current = setTimeout(async () => {
      const cfg = configRef.current;
      if (!cfg) return;
      setGeocodingNow(true);
      try {
        const result = await reverseGeocode(ll, cfg, langRef.current);
        setDetected(result);
        onDetectedRef.current?.(result);
      } finally {
        setGeocodingNow(false);
      }
    }, GEOSETTLE_DEBOUNCE_MS);
  }, []);

  useEffect(() => () => {
    if (geocodeTimerRef.current) clearTimeout(geocodeTimerRef.current);
  }, []);

  // ── Explicit location change from map interactions ─────────────────────
  const emitLocation = useCallback((ll: LatLng, source: 'GOOGLE' | 'OPENFREEMAP' | 'DEVICE_GPS') => {
    lastEmittedRef.current = `${ll.lat},${ll.lng}`;
    onChangeRef.current(ll.lat, ll.lng);
    onLocationSourceRef.current?.(source);
    settleAndGeocode(ll);
  }, [settleAndGeocode]);

  // ── Provider lifecycle ──────────────────────────────────────────────────
  const hasCoords = typeof value.latitude === 'number' && typeof value.longitude === 'number';
  const valueKey = hasCoords ? `${value.latitude},${value.longitude}` : '';

  useEffect(() => {
    // No usable config yet, or maps deliberately disabled — nothing to mount.
    if (!config || !config.mapsEnabled) return;
    if (!isProviderAvailable(config)) {
      setMapState('failed');
      return;
    }

    const container = containerRef.current;
    if (!container) return;

    const seq = ++initSeqRef.current;
    const provider = createMapProvider(config);
    if (!provider) {
      setMapState('failed');
      return;
    }
    providerRef.current = provider;
    setMapState('loading');

    // Read via ref (not dep): coordinates that arrive async are handled by
    // the value-sync effect below — they must NOT tear down a live map.
    const currentValue = valueRef.current;
    const initialHasCoords =
      typeof currentValue.latitude === 'number' && typeof currentValue.longitude === 'number';
    const initialCenter: LatLng = initialHasCoords
      ? { lat: currentValue.latitude as number, lng: currentValue.longitude as number }
      : DEFAULT_MAP_CENTER;
    const initialZoom = initialHasCoords ? MARKER_ZOOM : COUNTRY_ZOOM;

    provider.onMapClick((ll) => {
      provider.placeMarker(ll);
      provider.setCenter(ll);
      emitLocation(ll, provider.provider);
    });
    provider.onMarkerMove((ll) => emitLocation(ll, provider.provider));

    provider
      .init(container, { center: initialCenter, zoom: initialZoom })
      .then(() => {
        if (initSeqRef.current !== seq) return; // superseded by a re-init
        setMapState('ready');
        // Task 2-a (g): containers that were 0-size at init (hidden tab/step,
        // late layout) keep a stale canvas forever — re-measure on change.
        if (typeof ResizeObserver !== 'undefined') {
          resizeObserverRef.current?.disconnect();
          const ro = new ResizeObserver(() => {
            window.requestAnimationFrame(() => provider.resize?.());
          });
          ro.observe(container);
          resizeObserverRef.current = ro;
        }
      })
      .catch((err) => {
        if (initSeqRef.current !== seq) return;
        console.warn('[MapLocationPicker] provider init failed:', err?.message ?? err);
        setMapState('failed');
      });

    return () => {
      initSeqRef.current += 1; // invalidate in-flight init callbacks
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      provider.destroy();
      if (providerRef.current === provider) providerRef.current = null;
    };
  }, [config, emitLocation]);

  // Keep the marker + viewport in sync when the value changes EXTERNALLY
  // (parent restoring a saved agency location). Emits nothing; interaction
  // changes (lastEmittedRef) are already applied to the provider directly.
  useEffect(() => {
    const provider = providerRef.current;
    if (!provider || mapState !== 'ready') return;
    if (value.latitude == null || value.longitude == null) return;
    if (valueKey && valueKey === lastEmittedRef.current) return;

    provider.moveMarker({ lat: value.latitude, lng: value.longitude });
    const current = provider.getCoordinates();
    if (current) {
      provider.setCenter(current);
      // Lift the viewport out of the country overview exactly once per mount
      // when a saved location is restored (never fight user zoom changes).
      if (!zoomLiftedRef.current) {
        zoomLiftedRef.current = true;
        provider.setZoom(MARKER_ZOOM);
      }
    }
  }, [valueKey, mapState, value.latitude, value.longitude]);

  // ── Use my current location (spec §27) ──────────────────────────────────
  const handleUseMyLocation = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      toast.error(t('maps.invalidLocation'));
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        const ll: LatLng = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        const provider = providerRef.current;
        provider?.moveMarker(ll);
        provider?.setCenter(ll);
        provider?.setZoom(MARKER_ZOOM);
        emitLocation(ll, 'DEVICE_GPS');
      },
      (err) => {
        // Denial / unavailable → keep the picker usable (no data lost).
        setLocating(false);
        console.warn('[MapLocationPicker] geolocation failed:', err.message);
        toast.error(t('maps.invalidLocation'));
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 },
    );
  }, [emitLocation, t]);

  // Offline while loading → treat as unavailable (tiles cannot arrive);
  // a ready map keeps rendering with whatever tiles were cached.
  const unavailable = mapState === 'failed' || (!online && mapState === 'loading');
  const showMap = mapState === 'ready' || (mapState === 'loading' && online && !!config?.mapsEnabled);

  const readout = useMemo(() => {
    if (value.latitude == null || value.longitude == null) return null;
    return { lat: fmt(value.latitude), lng: fmt(value.longitude) };
  }, [value.latitude, value.longitude]);

  return (
    <div className="space-y-2.5" data-testid="map-location-picker">
      {/* Map surface / offline box (spec §40) */}
      {showMap && (
        <div
          className="relative w-full rounded-xl overflow-hidden border border-gray-200 dark:border-gray-700 bg-gray-100 dark:bg-gray-800"
          style={{ height }}
        >
          {/* NOTE: h-full w-full instead of `absolute inset-0` — maplibre-gl.css
              sets `.maplibregl-map { position: relative }` UNLAYERED, which beats
              Tailwind 4's layered `absolute` utility → the container collapsed to
              0 height and the map was invisible (same fix as agency-location-map). */}
          <div ref={containerRef} className="h-full w-full" dir="ltr" />
          {mapState === 'loading' && (
            <div className="absolute inset-0 flex items-center justify-center bg-gray-100/80 dark:bg-gray-800/80 z-10">
              <Loader2 className="h-6 w-6 animate-spin text-emerald-600" />
            </div>
          )}
          {/* Hint overlay — click/drag affordance (spec §28) */}
          {mapState === 'ready' && !hasCoords && (
            <div className="absolute top-2 start-2 end-2 z-10 pointer-events-none">
              <span className="inline-block rounded-lg bg-white/90 dark:bg-gray-900/90 border border-gray-200 dark:border-gray-700 px-2.5 py-1 text-[11px] font-medium text-gray-700 dark:text-gray-300 shadow-sm">
                {t('maps.clickToPlaceMarker')}
              </span>
            </div>
          )}
          {mapState === 'ready' && hasCoords && (
            <div className="absolute bottom-2 start-2 end-2 z-10 pointer-events-none">
              <span className="inline-block rounded-lg bg-white/90 dark:bg-gray-900/90 border border-gray-200 dark:border-gray-700 px-2.5 py-1 text-[11px] font-medium text-gray-700 dark:text-gray-300 shadow-sm">
                {t('maps.dragMarkerHint')}
              </span>
            </div>
          )}
        </div>
      )}

      {unavailable && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-200 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-900/20 p-3">
          <MapPinOff className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
          <div className="text-xs space-y-0.5">
            <p className="font-medium text-amber-800 dark:text-amber-200">
              {t('maps.mapUnavailableOffline')}
            </p>
            <p className="text-amber-700/80 dark:text-amber-300/80">
              {t('maps.editAddressInstead')}
            </p>
          </div>
        </div>
      )}

      {/* Action row — geolocation stays functional even when tiles are gone */}
      <div className="flex items-center gap-2 flex-wrap">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-9 rounded-lg text-xs gap-1.5 border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20"
          onClick={handleUseMyLocation}
          disabled={locating || configLoading}
        >
          {locating ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <LocateFixed className="h-3.5 w-3.5" />
          )}
          {locating ? t('maps.locating') : t('maps.useMyLocation')}
        </Button>
        {geocodingNow && (
          <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            {t('maps.detectedAddress')}…
          </span>
        )}
      </div>

      {/* Coordinate readout */}
      {readout && (
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground" dir="ltr">
          <span className="inline-flex items-center gap-1 font-mono">
            <MapPin className="h-3 w-3 text-emerald-600" />
            <span className="text-muted-foreground/80">lat</span> {readout.lat}
          </span>
          <span className="inline-flex items-center gap-1 font-mono">
            <Crosshair className="h-3 w-3 text-emerald-600" />
            <span className="text-muted-foreground/80">lng</span> {readout.lng}
          </span>
        </div>
      )}

      {/* Detected address preview — display only; parents own the text fields */}
      {detected?.formatted && (
        <p className="text-xs text-muted-foreground rounded-lg bg-gray-50 dark:bg-gray-800/60 border border-gray-100 dark:border-gray-800 px-2.5 py-1.5">
          <span className="font-medium text-foreground">{t('maps.detectedAddress')}: </span>
          <span dir="auto">{detected.formatted}</span>
        </p>
      )}
    </div>
  );
}
