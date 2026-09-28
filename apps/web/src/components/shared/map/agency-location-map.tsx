'use client';

/**
 * AgencyLocationMap — read-only agency location display (Task 51-b,
 * spec §26/§31).
 *
 * - Shows the saved location with a marker + a provider-native popup holding
 *   the agency name and address (spec §31).
 * - Optional `showDirections` renders the customer "Get Directions" button:
 *   label = config.directions.buttonLabel (Super-Admin override, spec §24)
 *   falling back to `maps.getDirections`; hidden when the agency has no
 *   coordinates or config.directionsEnabled is false (spec §26).
 * - Clicking the button opens the ONE centralized directions URL
 *   (`openDirections` in lib/map/directions.ts — spec §25).
 * - Offline / failed provider → friendly box, coordinates untouched
 *   (spec §40). The customer is never asked to select the location
 *   (spec §31).
 */
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { MapPinOff, Loader2, Navigation } from 'lucide-react';
import { useLanguage } from '@/hooks/use-language';
import { useOnlineStatus } from '@/hooks/use-online-status';
import {
  createMapProvider,
  isProviderAvailable,
  buildDirectionsUrl,
  MARKER_ZOOM,
  openDirections,
  type MapProviderInstance,
} from '@/lib/map';
import { useMapConfig } from '@/lib/map/use-map-config';
import 'maplibre-gl/dist/maplibre-gl.css';

export interface AgencyLocationMapAgency {
  latitude?: number | null;
  longitude?: number | null;
  name: string;
  address?: string | null;
  city?: string | null;
}

export interface AgencyLocationMapProps {
  agency: AgencyLocationMapAgency;
  /** Render the Get Directions button (still gated by config.directionsEnabled). */
  showDirections?: boolean;
  /** Map height in px (default 220). */
  height?: number;
}

export function AgencyLocationMap({
  agency,
  showDirections = false,
  height = 220,
}: AgencyLocationMapProps) {
  const { t } = useLanguage();
  const online = useOnlineStatus();
  const { config, loading: configLoading } = useMapConfig();

  const containerRef = useRef<HTMLDivElement | null>(null);
  const providerRef = useRef<MapProviderInstance | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const initSeqRef = useRef(0);
  const [mapState, setMapState] = useState<'loading' | 'ready' | 'failed'>('loading');

  const lat = typeof agency.latitude === 'number' ? agency.latitude : null;
  const lng = typeof agency.longitude === 'number' ? agency.longitude : null;
  const hasCoords = lat != null && lng != null;

  // Compose the plain-text address once for the popup + directions service.
  const addressText = [agency.address, agency.city].filter(Boolean).join(', ') || null;

  useEffect(() => {
    if (!hasCoords || !config || !config.mapsEnabled) return;
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

    provider
      .init(container, { center: { lat: lat!, lng: lng! }, zoom: MARKER_ZOOM })
      .then(() => {
        if (initSeqRef.current !== seq) return;
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
        if (lat != null && lng != null) {
          provider.placeMarker({ lat, lng });
          provider.showMarkerInfo?.(
            agency.name,
            addressText ?? undefined,
          );
        }
      })
      .catch((err) => {
        if (initSeqRef.current !== seq) return;
        console.warn('[AgencyLocationMap] provider init failed:', err?.message ?? err);
        setMapState('failed');
      });

    return () => {
      initSeqRef.current += 1;
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      provider.destroy();
      if (providerRef.current === provider) providerRef.current = null;
    };
  }, [config, hasCoords, lat, lng, agency.name, addressText]);

  // Directions visibility: coords + feature flag + provider config present
  // (spec §26 — hidden when no coordinates or directionsEnabled is false).
  const directionsVisible =
    showDirections && hasCoords && config != null && config.directionsEnabled;
  const directionsLabel = config?.directions?.buttonLabel || t('maps.getDirections');

  const handleDirections = () => {
    if (!config) return;
    const ok = openDirections(lat, lng, addressText, config.directions);
    if (!ok) navigateFallback();
  };

  // window.open blocked (popup blocker) → last-resort same-tab navigation.
  // The URL comes from the SAME centralized builder (spec §25 — never build
  // Google Maps URLs independently in UI components).
  const navigateFallback = () => {
    if (typeof window === 'undefined' || !config) return;
    const url = buildDirectionsUrl(lat, lng, addressText, config.directions);
    if (url) window.location.href = url;
  };

  if (!hasCoords) return null; // nothing to show — address block carries the info
  // Maps deliberately disabled by the Super Admin → no map surface at all.
  if (config && !config.mapsEnabled) return null;

  // Offline/loading-failed → friendly box (spec §40). Coordinates stay in
  // the payload; the directions URL keeps working through the browser.
  const unavailable =
    mapState === 'failed' ||
    (!online && mapState === 'loading') ||
    (!config && !configLoading);
  if (unavailable) {
    return (
      <div className="space-y-2" data-testid="agency-location-map">
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
        {directionsVisible && (
          <DirectionsButton label={directionsLabel} onClick={handleDirections} full />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2" data-testid="agency-location-map">
      <div
        className="relative w-full rounded-xl overflow-hidden border border-gray-200 dark:border-gray-700 bg-gray-100 dark:bg-gray-800"
        style={{ height }}
      >
        {/* NOTE: h-full w-full instead of `absolute inset-0` — maplibre-gl.css
            sets `.maplibregl-map { position: relative }` UNLAYERED, which beats
            Tailwind 4's layered `absolute` utility → the container collapsed to
            0 height and the map was invisible. The parent already carries the
            explicit height; maplibre's own relative positioning provides the
            anchor for its absolutely-positioned children. */}
        <div ref={containerRef} className="h-full w-full" dir="ltr" />
        {mapState === 'loading' && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-100/80 dark:bg-gray-800/80 z-10">
            <Loader2 className="h-6 w-6 animate-spin text-emerald-600" />
          </div>
        )}
      </div>
      {directionsVisible && (
        <DirectionsButton label={directionsLabel} onClick={handleDirections} full />
      )}
    </div>
  );
}

/** Shared directions button (label per spec §24; not hard-coded). */
function DirectionsButton({
  label,
  onClick,
  full,
}: {
  label: string;
  onClick: () => void;
  full?: boolean;
}) {
  return (
    <Button
      type="button"
      size="sm"
      className={`h-10 rounded-xl text-sm font-semibold gap-2 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white ${full ? 'w-full' : ''}`}
      onClick={onClick}
    >
      <Navigation className="h-4 w-4" />
      {label}
    </Button>
  );
}
