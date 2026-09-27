/**
 * OpenFreeMap provider — MapLibre-based (Task 51-b, spec §6).
 *
 * maplibre-gl is imported DYNAMICALLY inside `init()`:
 * - the npm bundle is only paid when OpenFreeMap is actually the active
 *   provider (Google Maps stays script-injected with no dependency);
 * - a static import would evaluate the library during SSR prerender and
 *   crash on `window` — the dynamic import keeps every module here
 *   server-render safe, matching the task's "typeof window guards".
 *
 * OpenFreeMap is the MAP provider only — reverse geocoding is handled by the
 * separate geocoding abstraction (`geocoding.ts`, spec §6).
 */
import type { LatLng, MapInitOptions, MapProviderId, MapProviderInstance } from './types';
import type { Map as MlMap, Marker as MlMarker, Popup as MlPopup } from 'maplibre-gl';

/** The part of maplibre-gl this provider touches (kept minimal on purpose). */
type MapLibreModule = typeof import('maplibre-gl');

let maplibrePromise: Promise<MapLibreModule> | null = null;

/** Lazily load maplibre-gl (browser only). Rejects when offline/blocked. */
export function loadMaplibre(): Promise<MapLibreModule> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('MAPLIBRE_REQUIRES_BROWSER'));
  }
  if (!maplibrePromise) {
    maplibrePromise = import('maplibre-gl').then((mod) => {
      // Task 51: pinned to maplibre-gl 5.x — its standard build embeds the
      // Web Worker as a blob URL, which survives Next.js bundling. (v6 ships
      // a split worker file whose bundled URL breaks in Next dev —
      // "Worker failed to load" — do not upgrade without re-verifying maps.)
      return mod;
    });
  }
  return maplibrePromise;
}

/** Create an OpenFreeMap (MapLibre) backed `MapProviderInstance`. */
export function createOpenFreeMapProvider(opts: { styleUrl: string }): MapProviderInstance {
  let map: MlMap | null = null;
  let marker: MlMarker | null = null;
  let popup: MlPopup | null = null;
  let clickCb: ((ll: LatLng) => void) | null = null;
  let markerMoveCb: ((ll: LatLng) => void) | null = null;
  let destroyed = false;

  const ensureMarker = (mod: MapLibreModule, ll: LatLng): MlMarker => {
    if (marker) return marker;
    marker = new mod.Marker({ draggable: true });
    marker.setLngLat([ll.lng, ll.lat]);
    if (map) marker.addTo(map);
    marker.on('dragend', () => {
      const lngLat = marker?.getLngLat();
      if (lngLat && markerMoveCb) markerMoveCb({ lat: lngLat.lat, lng: lngLat.lng });
    });
    return marker;
  };

  return {
    provider: 'OPENFREEMAP' as MapProviderId,

    async init(container: HTMLElement, initOpts?: MapInitOptions): Promise<void> {
      if (destroyed) throw new Error('OPENFREEMAP_PROVIDER_DESTROYED');
      if (typeof window === 'undefined') throw new Error('MAPLIBRE_REQUIRES_BROWSER');
      const mod = await loadMaplibre();
      if (destroyed) return; // unmounted while the chunk was downloading

      map = new mod.Map({
        container,
        style: opts.styleUrl || 'https://tiles.openfreemap.org/styles/liberty',
        center: [
          initOpts?.center?.lng ?? 1.6596,
          initOpts?.center?.lat ?? 28.0339,
        ],
        zoom: initOpts?.zoom ?? 5,
        // BLASTI renders its own controls; keep attribution (license).
        attributionControl: { compact: true },
      });

      map.on('click', (e) => {
        if (clickCb) clickCb({ lat: e.lngLat.lat, lng: e.lngLat.lng });
      });

      // Resolve when tiles/styles are ready so `placeMarker` right after
      // init never races the style (MapLibre markers need the map to exist,
      // but a loaded map avoids first-render flicker).
      await new Promise<void>((resolve) => {
        if (!map) return resolve();
        if (map.loaded()) return resolve();
        const done = () => resolve();
        map.once('load', done);
        // Hard fallback: some browsers with stale caches never fire `load`.
        setTimeout(done, 6000);
      });
    },

    setCenter(ll: LatLng): void {
      map?.setCenter([ll.lng, ll.lat]);
    },

    setZoom(zoom: number): void {
      map?.setZoom(zoom);
    },

    placeMarker(ll: LatLng): void {
      if (!map || destroyed) return;
      void loadMaplibre().then((mod) => {
        if (destroyed || !map) return;
        ensureMarker(mod, ll); // ensureMarker already addTo(map)
      });
    },

    moveMarker(ll: LatLng): void {
      if (!map || destroyed) return;
      void loadMaplibre().then((mod) => {
        if (destroyed || !map) return;
        ensureMarker(mod, ll).setLngLat([ll.lng, ll.lat]);
      });
    },

    onMapClick(cb: (ll: LatLng) => void): void {
      clickCb = cb;
    },

    onMarkerMove(cb: (ll: LatLng) => void): void {
      markerMoveCb = cb;
    },

    getCoordinates(): LatLng | null {
      const lngLat = marker?.getLngLat();
      return lngLat ? { lat: lngLat.lat, lng: lngLat.lng } : null;
    },

    showMarkerInfo(title: string, description?: string): void {
      if (!map || !marker || destroyed) return;
      void loadMaplibre().then((mod) => {
        if (destroyed || !map || !marker) return;
        if (!popup) popup = new mod.Popup({ closeButton: true, maxWidth: '240px' });
        const safe = (s: string) =>
          s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] ?? c));
        popup
          .setLngLat(marker.getLngLat())
          .setHTML(
            `<div style="font-family:inherit"><div style="font-weight:600">${safe(title)}</div>${description ? `<div style="font-size:12px;color:#4b5563">${safe(description)}</div>` : ''}</div>`,
          )
          .addTo(map);
      });
    },

    destroy(): void {
      destroyed = true;
      clickCb = null;
      markerMoveCb = null;
      popup?.remove();
      popup = null;
      marker?.remove();
      marker = null;
      map?.remove();
      map = null;
    },
  };
}
