'use client';

/**
 * cache-1: realtime → cache invalidation bridge.
 *
 * Socket events used to only update `lastEvent` for page-level listeners,
 * which responded by REFETCHING entire dashboards. This bridge soft-
 * invalidates the affected GET-cache families instead: cached entries stay
 * servable for instant paints but are marked stale and revalidated in the
 * background with If-None-Match — only actually-changed endpoints return a
 * body, everything else answers 304 (~200 bytes). Combined with the ApiClient
 * cache this is what makes live updates land without any page refresh.
 */

/** Event name → cache path prefixes to mark stale + revalidate. */
const EVENT_PREFIXES: Record<string, string[]> = {
  // Queue lifecycle (agency + customer surfaces)
  'queue:created': ['/api/agency', '/api/queue', '/api/customer', '/api/stats'],
  'queue:updated': ['/api/agency', '/api/queue', '/api/customer', '/api/stats'],
  'queue:called': ['/api/agency', '/api/queue', '/api/customer', '/api/stats'],
  'queue:completed': ['/api/agency', '/api/queue', '/api/customer', '/api/stats'],
  'queue:no-show': ['/api/agency', '/api/queue', '/api/customer', '/api/stats'],
  'queue:cancelled': ['/api/agency', '/api/queue', '/api/customer', '/api/stats'],
  'queue:joined': ['/api/agency', '/api/queue', '/api/customer', '/api/stats'],
  'queue:walk-in': ['/api/agency', '/api/queue', '/api/customer', '/api/stats'],
  'queue:paused': ['/api/agency', '/api/queue', '/api/stats'],
  'queue:resumed': ['/api/agency', '/api/queue', '/api/stats'],
  'queue:position-changed': ['/api/agency', '/api/queue', '/api/customer'],
  'queue:settings-updated': ['/api/agency', '/api/queue', '/api/admin'],
  // Agency / staff metadata
  'agency:updated': ['/api/agencies', '/api/agency', '/api/stats'],
  'staff:updated': ['/api/agency', '/api/stats'],
  // Reservations (customer journeys + agency lists)
  'reservation:created': ['/api/reservations', '/api/customer', '/api/agency', '/api/stats'],
  'reservation:updated': ['/api/reservations', '/api/customer', '/api/agency', '/api/stats'],
  'reservation:cancelled': ['/api/reservations', '/api/customer', '/api/agency', '/api/stats'],
  // Notifications
  'notification:new': ['/api/user/notifications', '/api/notifications', '/api/admin/notifications'],
  'notification:turn-approaching': ['/api/user/notifications', '/api/notifications'],
  'notification:your-turn': ['/api/user/notifications', '/api/notifications'],
};

/** A full local/remote sync landed — everything may have changed. */
export function handleSyncDataApplied(): void {
  void (async () => {
    const { apiClient } = await import('./api-client');
    // 0.6.49 NOTE: `apiClient.invalidateAll()` reaches a STATIC method
    // through the singleton — that used to throw "not a function" at
    // runtime (dead bridge). The instance delegates on ApiClient fixed it;
    // this call now actually soft-stales every cached GET + revalidates.
    apiClient.invalidateAll();
  })();
}

/** Map one realtime event to its cache families. Unknown events are no-ops. */
export function handleRealtimeCacheEvent(event: string): void {
  const prefixes = EVENT_PREFIXES[event];
  if (!prefixes || prefixes.length === 0) return;
  void (async () => {
    const { apiClient } = await import('./api-client');
    // Same 0.6.49 static-through-instance fix as above — this bridge now
    // really runs, which is what lets mounted views update in place on
    // live queue/reservation events instead of only on their own refetches.
    apiClient.invalidatePrefixes(prefixes, { hard: false });
  })();
}
