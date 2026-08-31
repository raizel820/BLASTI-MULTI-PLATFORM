/**
 * ============================================================================
 * BLASTI Service Worker — v1.0.0
 * ============================================================================
 *
 * Production-ready service worker for the BLASTI queue management app.
 * Provides offline support, intelligent caching, and background sync.
 *
 * Cache Strategy Overview:
 *   • Static assets (JS/CSS/images/fonts) → Cache-First (30-day TTL)
 *   • HTML / navigation requests          → Network-First with SPA fallback
 *   • API GET requests                    → Stale-While-Revalidate (5-min TTL)
 *   • API mutations (POST/PUT/DELETE)     → Network-Only + Background Sync queue
 *
 * ============================================================================
 */

// ---------- Configuration ----------

const CONFIG = {
  /** Current version — bump to invalidate all caches on update */
  version: 'v1',

  cacheNames: {
    static: `blasti-static-v1`,
    api: `blasti-api-v1`,
  },

  /** Maximum age for cached static assets (30 days in ms) */
  staticMaxAge: 30 * 24 * 60 * 60 * 1000,

  /** Maximum age for cached HTML (1 day in ms) */
  htmlMaxAge: 24 * 60 * 60 * 1000,

  /** Maximum age for cached API responses (5 minutes in ms) */
  apiMaxAge: 5 * 60 * 1000,

  /** Maximum number of entries in the API cache before LRU eviction */
  apiCacheMaxEntries: 100,

  /** Background Sync tag used for queuing failed mutations */
  syncTag: 'blasti-sync',

  /** IndexedDB store name for offline mutation queue fallback */
  queueStoreName: 'blasti-mutation-queue',

  /** IndexedDB database name */
  dbName: 'blasti-sw-db',

  /** DB version */
  dbVersion: 1,

  /**
   * API path prefixes that should NEVER be cached.
   * Auth and sync endpoints must always hit the network.
   */
  noCacheApiPrefixes: ['/api/auth', '/api/sync'],

  /**
   * File extensions that qualify as static assets for cache-first strategy.
   */
  staticExtensions: [
    '.js', '.css', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp',
    '.ico', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.json', '.map',
  ],

  /**
   * Assets to precache during the install phase.
   * These are the shell resources needed for the initial app load.
   */
  precacheUrls: [
    '/',
    '/index.html',
    '/logo.svg',
    '/favicon.png',
    '/logo-192.png',
    '/logo-512.png',
    '/apple-touch-icon.png',
    '/blasti-icon.png',
    '/manifest.json',
  ],
};

// ---------- Utility Helpers ----------

/**
 * Check if a URL's pathname ends with one of the configured static extensions.
 * @param {string} pathname
 * @returns {boolean}
 */
function isStaticAsset(pathname) {
  return CONFIG.staticExtensions.some((ext) => pathname.endsWith(ext));
}

/**
 * Check if a request URL matches an API path that should NOT be cached.
 * @param {URL} url
 * @returns {boolean}
 */
function isNoCacheApi(url) {
  return CONFIG.noCacheApiPrefixes.some(
    (prefix) => url.pathname.startsWith(prefix)
  );
}

/**
 * Check if a request is a navigation (HTML page) request.
 * @param {Request} request
 * @returns {boolean}
 */
function isNavigationRequest(request) {
  return (
    request.mode === 'navigate' ||
    (request.method === 'GET' &&
      (request.headers.get('accept') || '').includes('text/html'))
  );
}

/**
 * Check if a request is a GET request to the /api/ namespace.
 * @param {URL} url
 * @param {Request} request
 * @returns {boolean}
 */
function isApiGetRequest(url, request) {
  return (
    request.method === 'GET' &&
    url.pathname.startsWith('/api/') &&
    !isNoCacheApi(url)
  );
}

/**
 * Check if a request is an API mutation (POST, PUT, PATCH, DELETE).
 * @param {URL} url
 * @param {Request} request
 * @returns {boolean}
 */
function isApiMutation(url, request) {
  const mutationMethods = ['POST', 'PUT', 'PATCH', 'DELETE'];
  return (
    mutationMethods.includes(request.method) &&
    url.pathname.startsWith('/api/')
  );
}

/**
 * Check if a request is for an image resource.
 * @param {URL} url
 * @param {Request} request
 * @returns {boolean}
 */
function isImageRequest(url, request) {
  const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.avif'];
  return (
    request.method === 'GET' &&
    (imageExtensions.some((ext) => url.pathname.endsWith(ext)) ||
      (request.headers.get('accept') || '').includes('image/'))
  );
}

/**
 * Get a timestamp header value for cache age tracking.
 * @returns {string}
 */
function getTimestampHeader() {
  return Date.now().toString();
}

/**
 * Read the cached timestamp from a response to determine its age.
 * @param {Response} response
 * @returns {number|null}
 */
function getCachedTimestamp(response) {
  return response.headers.get('sw-cache-timestamp');
}

// ---------- IndexedDB Queue (Background Sync Fallback) ----------

/**
 * Open (or create) the BLASTI service worker IndexedDB database.
 * Used as a fallback persistence layer for mutations when
 * the Background Sync API is not available.
 *
 * @returns {Promise<IDBDatabase>}
 */
function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(CONFIG.dbName, CONFIG.dbVersion);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(CONFIG.queueStoreName)) {
        db.createObjectStore(CONFIG.queueStoreName, { keyPath: 'id', autoIncrement: true });
      }
    };

    request.onsuccess = (event) => resolve(event.target.result);
    request.onerror = (event) => reject(event.target.error);
  });
}

/**
 * Add a failed mutation request to the IndexedDB queue.
 * @param {object} entry - { url, method, headers, body, timestamp }
 * @returns {Promise<void>}
 */
async function queueMutation(entry) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CONFIG.queueStoreName, 'readwrite');
    const store = tx.objectStore(CONFIG.queueStoreName);
    const request = store.add(entry);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/**
 * Read all pending mutations from the IndexedDB queue.
 * @returns {Promise<object[]>}
 */
async function getAllQueuedMutations() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CONFIG.queueStoreName, 'readonly');
    const store = tx.objectStore(CONFIG.queueStoreName);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Remove a specific mutation entry from the queue by its ID.
 * @param {number} id
 * @returns {Promise<void>}
 */
async function removeQueuedMutation(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CONFIG.queueStoreName, 'readwrite');
    const store = tx.objectStore(CONFIG.queueStoreName);
    const request = store.delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/**
 * Clear the entire mutation queue.
 * @returns {Promise<void>}
 */
async function clearMutationQueue() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CONFIG.queueStoreName, 'readwrite');
    const store = tx.objectStore(CONFIG.queueStoreName);
    const request = store.clear();
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/**
 * Attempt to replay all queued mutations against the server.
 * Successfully replayed entries are removed from the queue.
 */
async function replayQueuedMutations() {
  const entries = await getAllQueuedMutations();

  if (entries.length === 0) return;

  console.log(`[BLASTI SW] Replaying ${entries.length} queued mutation(s)...`);

  for (const entry of entries) {
    try {
      const response = await fetch(entry.url, {
        method: entry.method,
        headers: entry.headers,
        body: entry.body,
      });

      if (response.ok || response.status === 409 || response.status === 422) {
        // Remove successfully processed or validation-error entries
        await removeQueuedMutation(entry.id);
        console.log(`[BLASTI SW] ✓ Replayed ${entry.method} ${entry.url}`);
      } else {
        // Server returned an error — keep in queue for next attempt
        console.warn(
          `[BLASTI SW] ✗ Mutation ${entry.method} ${entry.url} returned ${response.status}, keeping in queue`
        );
      }
    } catch (error) {
      // Network failure — still offline, keep in queue
      console.warn(
        `[BLASTI SW] ✗ Mutation ${entry.method} ${entry.url} failed (offline?), keeping in queue`
      );
    }
  }
}

// ---------- Cache Lifecycle Helpers ----------

/**
 * Enforce LRU eviction on the API cache to keep it within
 * CONFIG.apiCacheMaxEntries. Deletes the oldest entries first.
 * @returns {Promise<void>}
 */
async function enforceApiCacheLimit() {
  const cache = await caches.open(CONFIG.cacheNames.api);
  const keys = await cache.keys();

  if (keys.length > CONFIG.apiCacheMaxEntries) {
    const excessCount = keys.length - CONFIG.apiCacheMaxEntries;
    // Delete the oldest entries (first in the keys array)
    const toDelete = keys.slice(0, excessCount);
    await Promise.all(toDelete.map((key) => cache.delete(key)));
    console.log(`[BLASTI SW] Evicted ${toDelete.length} old API cache entries (LRU)`);
  }
}

/**
 * Clone a response and stamp it with a cache timestamp header.
 * This allows us to determine the age of a cached response later.
 * @param {Response} response
 * @returns {Response}
 */
function stampResponse(response) {
  const headers = new Headers(response.headers);
  headers.set('sw-cache-timestamp', getTimestampHeader());

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Check whether a cached response has exceeded its maximum allowed age.
 * @param {Response} cachedResponse
 * @param {number} maxAge - Maximum age in milliseconds
 * @returns {boolean} true if the response is stale
 */
function isStale(cachedResponse, maxAge) {
  const timestamp = getCachedTimestamp(cachedResponse);
  if (!timestamp) return true;
  return Date.now() - parseInt(timestamp, 10) > maxAge;
}

// ---------- Install Event ----------

/**
 * INSTALL: Precache essential app shell assets so the app can load
 * immediately on subsequent visits, even while offline.
 */
self.addEventListener('install', (event) => {
  console.log('[BLASTI SW] Install — precaching app shell assets...');

  event.waitUntil(
    caches.open(CONFIG.cacheNames.static).then(async (cache) => {
      const results = await Promise.allSettled(
        CONFIG.precacheUrls.map((url) =>
          cache.add(url).catch((err) => {
            // Individual precache failures are non-fatal; the app can still
            // function via network fallback or runtime caching.
            console.warn(`[BLASTI SW] Precache failed for ${url}:`, err.message);
          })
        )
      );

      const succeeded = results.filter((r) => r.status === 'fulfilled').length;
      console.log(`[BLASTI SW] Precached ${succeeded}/${CONFIG.precacheUrls.length} assets`);
    })
  );

  // Activate immediately without waiting for existing clients to close
  self.skipWaiting();
});

// ---------- Activate Event ----------

/**
 * ACTIVATE: Clean up old caches from previous versions and
 * claim all open clients so the new SW controls them immediately.
 */
self.addEventListener('activate', (event) => {
  console.log('[BLASTI SW] Activate — cleaning up old caches...');

  const currentCaches = new Set(Object.values(CONFIG.cacheNames));

  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames
            .filter((name) => !currentCaches.has(name))
            .map((name) => {
              console.log(`[BLASTI SW] Deleting old cache: ${name}`);
              return caches.delete(name);
            })
        )
      )
      .then(() => self.clients.claim())
  );
});

// ---------- Fetch Event ----------

/**
 * FETCH: Main request routing logic. Determines the appropriate
 * caching strategy based on the request type and URL.
 */
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // ---- Skip non-GET requests that aren't mutations ----
  // (e.g. cross-origin non-API requests)
  if (request.method !== 'GET' && !isApiMutation(url, request)) {
    return;
  }

  // ---- Strategy 1: Navigation Requests (SPA Fallback) ----
  if (isNavigationRequest(request)) {
    event.respondWith(handleNavigationRequest(request));
    return;
  }

  // ---- Strategy 2: API Mutations (POST/PUT/PATCH/DELETE) ----
  if (isApiMutation(url, request)) {
    event.respondWith(handleMutationRequest(request, url));
    return;
  }

  // ---- Strategy 3: API GET Requests (Stale-While-Revalidate) ----
  if (isApiGetRequest(url, request)) {
    event.respondWith(handleApiGetRequest(request, url));
    return;
  }

  // ---- Strategy 4: Static Assets (Cache-First) ----
  if (isStaticAsset(url.pathname)) {
    event.respondWith(handleStaticAssetRequest(request));
    return;
  }

  // ---- Strategy 5: Image Requests (Cache with Offline Placeholder) ----
  if (isImageRequest(url, request)) {
    event.respondWith(handleImageRequest(request));
    return;
  }

  // ---- Default: Network-First with cache fallback ----
  event.respondWith(handleDefaultRequest(request));
});

// ---------- Request Handlers ----------

/**
 * Handle navigation requests with network-first strategy.
 * Falls back to the cached /index.html for offline SPA support.
 *
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function handleNavigationRequest(request) {
  try {
    // Try the network first
    const networkResponse = await fetch(request);

    // Cache successful HTML responses for offline fallback
    if (networkResponse.ok) {
      const cache = await caches.open(CONFIG.cacheNames.static);
      const stamped = stampResponse(networkResponse);
      cache.put(request, stamped.clone());
      return stamped;
    }

    return networkResponse;
  } catch (error) {
    // Network failed — serve the cached SPA shell
    const cache = await caches.open(CONFIG.cacheNames.static);
    const cachedResponse = await cache.match('/index.html');

    if (cachedResponse) {
      return cachedResponse;
    }

    // Ultimate fallback: return a minimal offline page
    return new Response(
      `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>BLASTI — Offline</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh; background: #f8fafc; color: #334155;
    }
    .container { text-align: center; padding: 2rem; max-width: 420px; }
    h1 { font-size: 2rem; margin-bottom: 0.5rem; color: #0f172a; }
    p { font-size: 1rem; color: #64748b; margin-bottom: 1.5rem; line-height: 1.6; }
    button {
      padding: 0.75rem 1.5rem; font-size: 1rem; font-weight: 600;
      color: #fff; background: #0f172a; border: none; border-radius: 0.5rem;
      cursor: pointer; transition: background 0.2s;
    }
    button:hover { background: #1e293b; }
  </style>
</head>
<body>
  <div class="container">
    <h1> BLASTI</h1>
    <p>You're currently offline. Please check your internet connection and try again.</p>
    <button onclick="window.location.reload()">Retry</button>
  </div>
</body>
</html>`,
      {
        status: 503,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      }
    );
  }
}

/**
 * Handle API GET requests using Stale-While-Revalidate strategy.
 * Serves the cached response immediately (if available), then
 * fetches a fresh copy in the background and updates the cache.
 *
 * Only caches 200 responses. Honours the 5-minute TTL for staleness.
 *
 * @param {Request} request
 * @param {URL} url
 * @returns {Promise<Response>}
 */
async function handleApiGetRequest(request, url) {
  const cache = await caches.open(CONFIG.cacheNames.api);
  const cachedResponse = await cache.match(request);

  // Background revalidation — always attempt to refresh
  const fetchPromise = fetch(request)
    .then((networkResponse) => {
      // Only cache successful responses
      if (networkResponse.ok) {
        const stamped = stampResponse(networkResponse);
        cache.put(request, stamped.clone());
        // Enforce LRU limit after each cache write
        enforceApiCacheLimit();
      }
      return networkResponse;
    })
    .catch(() => {
      // Network failed; the cached response (if any) will be used
      console.warn(`[BLASTI SW] API fetch failed for ${url.pathname}, using cache`);
    });

  // If we have a cached response, serve it immediately
  if (cachedResponse) {
    // Fire-and-forget the background fetch
    event.waitUntil(fetchPromise);
    return cachedResponse;
  }

  // No cache — wait for the network
  return fetchPromise;
}

/**
 * Handle static asset requests using Cache-First strategy.
 * Serves from cache if available and not stale (30-day TTL).
 * Falls back to network and caches successful responses.
 *
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function handleStaticAssetRequest(request) {
  const cache = await caches.open(CONFIG.cacheNames.static);
  const cachedResponse = await cache.match(request);

  // Return cached response if it exists and hasn't exceeded the max age
  if (cachedResponse && !isStale(cachedResponse, CONFIG.staticMaxAge)) {
    return cachedResponse;
  }

  try {
    const networkResponse = await fetch(request);

    if (networkResponse.ok) {
      const stamped = stampResponse(networkResponse);
      cache.put(request, stamped.clone());
      return stamped;
    }

    // Non-OK network response — return it as-is (don't cache errors)
    return networkResponse;
  } catch (error) {
    // Network failed — return cached version even if stale (better than nothing)
    if (cachedResponse) {
      return cachedResponse;
    }

    // For images, return a transparent 1x1 placeholder
    if (isImageRequest(new URL(request.url), request)) {
      return createImagePlaceholder();
    }

    // No cache, no network — return a basic error
    return new Response('Offline', { status: 503 });
  }
}

/**
 * Handle image requests with cache-first strategy and offline placeholder.
 * Attempts cache, then network, then a generated SVG placeholder.
 *
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function handleImageRequest(request) {
  const cache = await caches.open(CONFIG.cacheNames.static);
  const cachedResponse = await cache.match(request);

  if (cachedResponse) {
    return cachedResponse;
  }

  try {
    const networkResponse = await fetch(request);

    if (networkResponse.ok) {
      const stamped = stampResponse(networkResponse);
      cache.put(request, stamped.clone());
      return stamped;
    }

    return createImagePlaceholder();
  } catch (error) {
    return createImagePlaceholder();
  }
}

/**
 * Create a minimal SVG placeholder image for offline image requests.
 * @returns {Response}
 */
function createImagePlaceholder() {
  const svg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">
    <rect width="200" height="200" fill="#f1f5f9"/>
    <text x="100" y="108" text-anchor="middle" font-family="sans-serif" font-size="14" fill="#94a3b8">
      Image unavailable
    </text>
  </svg>`;

  return new Response(svg.trim(), {
    status: 200,
    headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * Handle API mutation requests (POST, PUT, PATCH, DELETE).
 * Attempts the network request. If it fails (offline), the request
 * is queued for background sync replay.
 *
 * @param {Request} request
 * @param {URL} url
 * @returns {Promise<Response>}
 */
async function handleMutationRequest(request, url) {
  try {
    const response = await fetch(request);

    // If the mutation succeeds, invalidate related API cache entries
    // to ensure fresh data on next read
    if (response.ok) {
      await invalidateApiCacheForUrl(url);
    }

    return response;
  } catch (error) {
    // Network failure — queue for background sync
    console.log(`[BLASTI SW] Mutation ${request.method} ${url.pathname} failed (offline), queuing for sync...`);

    // Clone the request body for queueing
    let body = null;
    if (request.method !== 'GET') {
      body = await request.clone().arrayBuffer();
    }

    // Serialize headers
    const headers = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });

    const queueEntry = {
      url: request.url,
      method: request.method,
      headers,
      body,
      timestamp: Date.now(),
    };

    // Attempt to register a Background Sync event
    if ('sync' in self.registration) {
      try {
        await self.registration.sync.register(CONFIG.syncTag);
        console.log('[BLASTI SW] Background Sync registered');
      } catch (syncError) {
        // If sync registration fails (e.g. in dev), fall back to
        // replaying on the next 'sync' event or online detection
        console.warn('[BLASTI SW] Background Sync registration failed, using fallback queue');
      }
    }

    // Always persist to IndexedDB as the durable queue
    await queueMutation(queueEntry);

    // Return an offline response to the client so it doesn't throw
    return new Response(
      JSON.stringify({
        offline: true,
        queued: true,
        message: 'Request queued for sync — will be replayed when online.',
      }),
      {
        status: 202,
        statusText: 'Accepted (Queued)',
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

/**
 * Default request handler: network-first with cache fallback.
 * Used for any request that doesn't match a specific strategy.
 *
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function handleDefaultRequest(request) {
  try {
    const networkResponse = await fetch(request);

    if (networkResponse.ok) {
      const cache = await caches.open(CONFIG.cacheNames.static);
      const stamped = stampResponse(networkResponse);
      cache.put(request, stamped.clone());
      return stamped;
    }

    return networkResponse;
  } catch (error) {
    const cache = await caches.open(CONFIG.cacheNames.static);
    const cachedResponse = await cache.match(request);

    if (cachedResponse) {
      return cachedResponse;
    }

    return new Response('Offline', { status: 503 });
  }
}

// ---------- Cache Invalidation ----------

/**
 * Invalidate API cache entries that may be affected by a mutation.
 * Uses a simple prefix-matching strategy: a mutation to `/api/tickets/123`
 * will invalidate all cached entries under `/api/tickets`.
 *
 * @param {URL} mutationUrl
 * @returns {Promise<void>}
 */
async function invalidateApiCacheForUrl(mutationUrl) {
  const cache = await caches.open(CONFIG.cacheNames.api);
  const keys = await cache.keys();

  // Derive the collection path (e.g. /api/tickets from /api/tickets/123)
  const pathParts = mutationUrl.pathname.split('/').filter(Boolean);
  // pathParts: ['api', 'tickets', '123'] -> collection prefix: '/api/tickets'
  const collectionPrefix = '/' + pathParts.slice(0, 2).join('/');

  const deletePromises = keys
    .filter((key) => {
      const keyUrl = new URL(key.url);
      return keyUrl.pathname.startsWith(collectionPrefix);
    })
    .map((key) => cache.delete(key));

  const deleted = await Promise.all(deletePromises);
  const deletedCount = deleted.filter(Boolean).length;

  if (deletedCount > 0) {
    console.log(`[BLASTI SW] Invalidated ${deletedCount} API cache entry(s) for ${collectionPrefix}`);
  }
}

// ---------- Background Sync Event ----------

/**
 * SYNC: Replay queued mutations when the browser signals connectivity.
 * This fires when the Background Sync API triggers, or we manually
 * dispatch it as a fallback.
 */
self.addEventListener('sync', (event) => {
  if (event.tag === CONFIG.syncTag) {
    console.log('[BLASTI SW] Sync event fired — replaying queued mutations...');
    event.waitUntil(replayQueuedMutations());
  }
});

// ---------- Push Event (Placeholder) ----------

/**
 * PUSH: Handle incoming push notifications from the BLASTI server.
 * This is a placeholder for future real-time notification support.
 * When a push message arrives, we show a notification to the user.
 */
self.addEventListener('push', (event) => {
  let data = { title: 'BLASTI', body: 'You have a new update.' };

  if (event.data) {
    try {
      data = event.data.json();
    } catch {
      data.body = event.data.text();
    }
  }

  const options = {
    body: data.body,
    icon: '/logo-192.png',
    badge: '/blasti-icon.png',
    vibrate: [100, 50, 100],
    data: {
      url: data.url || '/',
    },
    actions: data.actions || [],
  };

  event.waitUntil(self.registration.showNotification(data.title, options));
});

/**
 * NOTIFICATION CLICK: Open the app when a notification is tapped.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const targetUrl = event.notification.data?.url || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Focus an existing window if one exists
      for (const client of clientList) {
        if (client.url.includes(targetUrl) && 'focus' in client) {
          return client.focus();
        }
      }
      // Otherwise open a new window
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});

// ---------- Message Event (Client Communication) ----------

/**
 * MESSAGE: Handle messages from the main thread.
 * Supports:
 *   - 'SKIP_WAITING': Force the SW to activate immediately
 *   - 'GET_CACHE_SIZE': Return the size of all caches
 *   - 'CLEAR_ALL_CACHES': Delete all caches
 */
self.addEventListener('message', (event) => {
  const { type, payload } = event.data || {};

  switch (type) {
    case 'SKIP_WAITING':
      self.skipWaiting();
      break;

    case 'GET_CACHE_SIZE':
      getCacheSize().then((size) => {
        event.ports[0]?.postMessage({ type: 'CACHE_SIZE', size });
      });
      break;

    case 'CLEAR_ALL_CACHES':
      clearAllCaches().then(() => {
        event.ports[0]?.postMessage({ type: 'CACHES_CLEARED' });
      });
      break;

    case 'REPLAY_MUTATIONS':
      // Manual trigger to replay queued mutations
      replayQueuedMutations();
      break;

    default:
      break;
  }
});

/**
 * Calculate the total number of cached entries across all caches.
 * @returns {Promise<{static: number, api: number, total: number}>}
 */
async function getCacheSize() {
  const [staticKeys, apiKeys] = await Promise.all([
    caches.open(CONFIG.cacheNames.static).then((c) => c.keys()),
    caches.open(CONFIG.cacheNames.api).then((c) => c.keys()),
  ]);

  return {
    static: staticKeys.length,
    api: apiKeys.length,
    total: staticKeys.length + apiKeys.length,
  };
}

/**
 * Delete all BLASTI caches.
 * @returns {Promise<void>}
 */
async function clearAllCaches() {
  const names = Object.values(CONFIG.cacheNames);
  await Promise.all(names.map((name) => caches.delete(name)));
  console.log('[BLASTI SW] All caches cleared');
}

// ---------- Online/Offline Detection ----------

/**
 * ONLINE: When connectivity is restored, attempt to replay any
 * queued mutations that were stored in IndexedDB.
 */
self.addEventListener('online', () => {
  console.log('[BLASTI SW] Back online — checking for queued mutations...');
  replayQueuedMutations();
});

/**
 * OFFLINE: Log the transition for debugging.
 */
self.addEventListener('offline', () => {
  console.log('[BLASTI SW] Went offline — mutations will be queued');
});

console.log(`[BLASTI SW] Service Worker loaded — version ${CONFIG.version}`);
