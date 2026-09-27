# Task 51-b — full-stack-developer (frontend maps)

Date: 2026-09-27 (session end)
Scope: apps/web ONLY — lib/map/* rescue + agency-location UI integrations + i18n `maps` namespace.

## What was done (short form — full detail in worklog.md)

1. **Dependency**: `maplibre-gl@5.24.0` added to apps/web/package.json (was only a hoisted transitive; now a direct dep).
2. **Lint rescue**: the 5 `react-hooks/refs` "Cannot update ref during render" errors in `map-location-picker.tsx` (lines 98–106) fixed by moving all 5 ref writes (`onChangeRef/onDetectedRef/onLocationSourceRef/configRef/langRef`) into a single `useEffect` keyed on the source values. All `.current` reads happen in event handlers/timers, so post-commit sync is always in time.
3. **lib/map review fixes** (kept everything else — the dead attempt's abstraction is sound):
   - `geocoding.ts`: Google reverse geocoding REWRITTEN from the REST `maps/api/geocode/json` endpoint (which sends NO CORS headers — it could never work from a browser) to the Maps JS API `Geocoder` via the shared `loadGoogleMaps()` loader. Same never-throw / all-null-on-failure contract, 6s hard timeout, no invented components.
   - `index.ts`: `mapInitOptionsFor` now uses `DEFAULT_MAP_CENTER`/`MARKER_ZOOM`/`COUNTRY_ZOOM` constants (was hardcoded drift).
   - `agency-location-map.tsx`: popup-blocker fallback now routes through the centralized `buildDirectionsUrl` (spec §25 — no second URL builder).
   - `map-location-picker.tsx`: re-exports `type GeocodeComponents` for consumers.
4. **i18n**: flat `maps.*` namespace (16 keys) appended to ar.ts (source of truth) / en.ts / fr.ts with exact parity.
5. **Integrations**: create-agency-form (Location block on Contact step), agency-profile (Location card: picker in edit mode, read-only AgencyLocationMap + verified badge + postal code in view mode), AgencyDetailSheet (map + Get Directions when coords exist), home/types.ts (optional lat/lng on AgencyDetail).
6. **PRE-EXISTING BUG FIXED (required for the deliverable)**: `agency-profile.tsx handleSave` echoed the raw profile object into PATCH /api/agency/profile; GET /profile returns `null` for nameAr/nameFr/address/phone but the update schema requires strings → EVERY profile save 400'd (verified live: `400 Invalid input: expected string, received null`). Fix: build the PATCH body omitting null/undefined fields (omitted keys stay unchanged server-side). After the fix: PATCH → 200 + toast + refetch.
7. **Live E2E proof** (headless browser, real stack): profile edit → OpenFreeMap/MapLibre map rendered (attribution links present) → synthetic map click placed the marker → readout lat 28.0339 / lng 1.6596 → 600ms-debounced Nominatim reverse geocode returned a real Arabic address ("تمقطن, دائرة اولف, أدرار, 01000, الجزائر") and auto-filled the postal code → Save → PATCH 200 → server state: lat/lng/postalCode 01000/locationVerified UNVERIFIED/locationSource OPENFREEMAP-set/locationUpdatedAt re-stamped → view mode rendered the read-only map + amber "الموقع غير موثّق" badge. Test data afterwards RESET via API to the pre-test state (lat/lng/postalCode null, locationVerified/locationSource 'MANUAL' as found). Screenshots: tool-results/t51b-profile-edit-map.png, t51b-profile-view-map.png.

## Exported surface for the settings-UI agent (Task 52 / admin maps settings)

```ts
// apps/web/src/lib/map/types.ts
interface LatLng { lat: number; lng: number }
interface MapInitOptions { center?: LatLng; zoom?: number }
type MapProviderId = 'GOOGLE' | 'OPENFREEMAP';
interface MapsProviderSettings { /* exact GET /api/config/maps data shape (51-a contract) */ }
type MapConfig = MapsProviderSettings;                 // alias
interface MapProviderInstance { provider; init(container, opts?); setCenter; setZoom; placeMarker; moveMarker; onMapClick; onMarkerMove; getCoordinates; showMarkerInfo?; destroy }
const DEFAULT_MAP_CENTER: LatLng; MARKER_ZOOM = 15; COUNTRY_ZOOM = 5;
function isValidLatLng(ll): ll is LatLng;

// apps/web/src/lib/map/index.ts (import everything from '@/lib/map')
createMapProvider(config: MapConfig): MapProviderInstance | null   // honors fallbackProvider
isProviderAvailable(config, provider?): boolean
mapInitOptionsFor(center: LatLng | null): MapInitOptions
// re-exports: createGoogleMapsProvider, loadGoogleMaps, createOpenFreeMapProvider,
// loadMaplibre, reverseGeocode, buildDirectionsUrl, openDirections, types & constants

// apps/web/src/lib/map/geocoding.ts
reverseGeocode(ll: LatLng, config: MapsProviderSettings, language?: string): Promise<ReverseGeocodeResult>
interface ReverseGeocodeResult extends GeocodeComponents { provider }
interface GeocodeComponents { formatted; street; city; wilaya; postalCode; countryCode } // all nullable

// apps/web/src/lib/map/directions.ts
buildDirectionsUrl(lat, lng, addressText, settings: DirectionsSettings): string | null
openDirections(lat, lng, addressText, settings): boolean
GOOGLE_DIRECTIONS_BASE (deprecated export, internal constant)

// apps/web/src/lib/map/use-map-config.ts
useMapConfig(): { config: MapsProviderSettings | null; loading: boolean; error: string | null }  // 60s TTL module cache
normalizeMapsConfigPayload(raw: unknown): MapsProviderSettings | null   // exported envelope-tolerance helper

// apps/web/src/components/shared/map/map-location-picker.tsx
MapLocationPicker({ value: {latitude, longitude}, onChange(lat, lng), addressFields?: { onDetected(GeocodeComponents) }, height?, onLocationSource?('GOOGLE'|'OPENFREEMAP'|'DEVICE_GPS') })
export type { GeocodeComponents }

// apps/web/src/components/shared/map/agency-location-map.tsx
AgencyLocationMap({ agency: { latitude?, longitude?, name, address?, city? }, showDirections?, height? })
```

## Notes / deviations for the record
- `locationVerified` for owner map picks = `'UNVERIFIED'` (VERIFIED reserved for administrative verification; MANUAL unused by this UI since coordinates can only come from map/GPS here).
- `AgencyDetailSheet` is currently export-only (customer-home.tsx renders its own inline detail view) — integration added per task instructions; if the customer inline view in customer-home.tsx should show the map too, that's a one-block follow-up reusing `AgencyLocationMap`.
- Geolocation denial toasts `maps.invalidLocation` (the fixed 16-key list has no dedicated denial key).
- i18n pre-existing duplicate-key TS1117 warnings in ar/en/fr are untouched (pre-date this task).
