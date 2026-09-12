# Hooks Parity Port — Web → Desktop

## Task
Copy and adapt 11 hooks from `apps/web/src/hooks/` to `apps/desktop/frontend/src/hooks/`.

## Files Written

| # | Source | Target | Adaptation |
|---|--------|--------|------------|
| 1 | use-offline-aware-polling.ts | use-offline-aware-polling.ts | `isCloudDown()` / `shouldSkipPoll()` now check `useSync` store instead of Web's `apiClient` |
| 2 | use-debounce.ts | use-debounce.ts | Copied as-is (removed `'use client'`) |
| 3 | use-local-storage.ts | use-local-storage.ts | Copied as-is (removed `'use client'`) |
| 4 | use-online-status.ts | use-online-status.ts | Copied as-is (removed `'use client'`) |
| 5 | use-notifications.ts | use-notifications.ts | Uses Desktop `api` client from `@/api/client`; offline checks via `useSync`; removed Web's `useRealtime` event listeners (polling only) |
| 6 | use-upload.ts | use-upload.ts | Upload URL targets `localhost:3080` (or Vite proxy); uses Desktop `api` for auth token and delete |
| 7 | use-mobile.ts | use-mobile.ts | Stub: `useIsMobile()` always returns `false` |
| 8 | use-language.ts | use-language.ts | Stub: `useLanguage()` always returns English |
| 9 | use-platform.tsx | use-platform.tsx | Stub: `usePlatform()` returns `{ platform: 'electron', category: 'desktop' }`; `PlatformProvider` is passthrough |
| 10 | use-realtime.ts | use-realtime.ts | Polling-only stub: all methods are no-ops, `isConnected` is always `false` |
| 11 | use-realtime.tsx | use-realtime.tsx | Polling-only stub: `useAgencyRealtime()`, `useCustomerRealtime()`, `useTurnAlert()` are all no-ops |

## Key Transformations Applied
- **Removed all `'use client'` directives** (Desktop uses Vite, not Next.js)
- **Replaced all `process.env.NEXT_PUBLIC_*`** with `import.meta.env.VITE_*` or hardcoded values
- **Kept all `@/` imports** as-is
- **Offline tracking**: Switched from `isApiUnreachable()` / `isBothUnreachable()` → `useSync.getState().isOnline`
- **API calls**: Switched from Web's `apiClient` → Desktop's `api` from `@/api/client`
- **Upload base URL**: Set to `localhost:3080` (or empty for Vite dev proxy)
- **Real-time**: All Socket.IO hooks replaced with polling-only no-op stubs
