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
import type {
  Map as MlMap,
  Marker as MlMarker,
  Popup as MlPopup,
  ErrorEvent as MlErrorEvent,
} from 'maplibre-gl';

/**
 * The part of maplibre-gl this provider touches (kept minimal on purpose).
 * `supported` exists in some maplibre builds (removed in v5) — declared
 * optional so the WebGL probe degrades to a manual canvas check.
 */
type MapLibreModule = typeof import('maplibre-gl') & {
  supported?: (opts?: { failIfMajorPerformanceCaveat?: boolean }) => boolean;
};

/**
 * True when the browser can provide a usable WebGL context. maplibre-gl v5
 * removed the `supported()` export, so: call it when present, otherwise probe
 * for a live context the same way maplibre does internally. Without this
 * check a WebGL-blocked browser (disabled / GPU blacklisted) still constructs
 * the Map — and then paints a dead grey canvas forever (Task 2-a).
 */
function webGLSupported(mod: MapLibreModule): boolean {
  if (typeof mod.supported === 'function') {
    try {
      return Boolean(mod.supported({ failIfMajorPerformanceCaveat: false }));
    } catch {
      // Probe below.
    }
  }
  try {
    if (typeof window === 'undefined' || typeof window.document === 'undefined') return false;
    const canvas = window.document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    return gl != null;
  } catch {
    return false;
  }
}

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
  let errorHandler: ((event: MlErrorEvent) => void) | null = null;
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

      // Task 2-a (a): WebGL capability check BEFORE constructing the Map —
      // a WebGL-blocked browser otherwise constructs the Map and paints a
      // dead grey canvas forever. Throwing routes the component into its
      // existing 'failed' ("map unavailable") state instead.
      if (!webGLSupported(mod)) {
        throw new Error('WebGL not supported');
      }

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

      // Task 2-a (b): style-load errors used to be completely silent (the
      // 6s timeout resolved regardless → 'ready' → grey canvas). Listen for
      // maplibre `error` events: fatal-looking ones BEFORE `load` reject
      // init; everything after `load` is non-fatal (warn once, never reject).
      let loadFired = false;
      let fatal: Error | null = null;
      let warnedError = false;
      let onFatal: ((err: Error) => void) | null = null;

      errorHandler = (event: MlErrorEvent) => {
        const err = event?.error;
        const message = err?.message ?? '';
        const name = (err as { name?: string } | null)?.name ?? '';
        const status = (err as { status?: number } | null)?.status;
        const looksFatal =
          status === 0 ||
          /webgl|context (lost|created)|failed to fetch|style/i.test(message) ||
          /WebGL|SecurityError/.test(name);
        if (!loadFired) {
          if (looksFatal) {
            fatal ??= new Error(
              `OPENFREEMAP_INIT_FAILED: ${name || 'Error'}: ${message || 'map failed before load'}`,
            );
            onFatal?.(fatal);
          }
          return;
        }
        // After `load`: tile hiccups etc. must NOT reject — warn once.
        if (!warnedError) {
          warnedError = true;
          console.warn(
            '[OpenFreeMapProvider] non-fatal map error (after load):',
            message || name || 'unknown',
          );
        }
      };
      map.on('error', errorHandler);

      // Task 2-a (d): recover canvases whose container was laid out AFTER
      // construction (hidden tab/step → 0-size canvas kept forever).
      const scheduleResize = () => {
        if (!map || destroyed) return;
        window.requestAnimationFrame(() => {
          if (!destroyed) map?.resize();
        });
      };

      map.on('click', (e) => {
        if (clickCb) clickCb({ lat: e.lngLat.lat, lng: e.lngLat.lng });
      });

      // Resolve when tiles/styles are ready so `placeMarker` right after
      // init never races the style (MapLibre markers need the map to exist,
      // but a loaded map avoids first-render flicker).
      // Task 2-a (c): genuine settle — a fatal pre-load error rejects
      // immediately; the legacy 6s hard fallback stays ONLY for browsers
      // that never fire `load` and never reported a fatal error.
      await new Promise<void>((resolve, reject) => {
        if (!map) return resolve();
        if (map.loaded()) {
          loadFired = true;
          return resolve();
        }
        let timer: ReturnType<typeof setTimeout> | null = null;
        onFatal = (err) => {
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
          reject(err);
        };
        map.once('load', () => {
          loadFired = true;
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
          resolve();
          scheduleResize();
        });
        timer = setTimeout(() => {
          timer = null;
          if (fatal) {
            reject(fatal); // fatal error seen before `load` — never fake-ready
            return;
          }
          resolve();
          scheduleResize();
        }, 6000);
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

    // Task 2-a (e): recompute the canvas size from the current container
    // size (called by the components' ResizeObserver on layout changes).
    resize(): void {
      map?.resize();
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
      // Task 2-a (f): the error listener must not outlive the map instance.
      if (map && errorHandler) map.off('error', errorHandler);
      errorHandler = null;
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
