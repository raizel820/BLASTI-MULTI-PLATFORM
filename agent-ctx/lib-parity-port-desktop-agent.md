# Task: BLASTI Desktop/Web Parity Port — lib modules

## Summary
Copied and adapted 17 key lib modules from `apps/web/src/lib/` to `apps/desktop/frontend/src/lib/`, following the Desktop adaptation rules.

## Files Created/Modified

### Copied As-Is (platform-agnostic, no Next.js deps)
| File | Notes |
|------|-------|
| `validations.ts` | Adapted `validateBody()` to return plain error object instead of `NextResponse` |
| `enums.ts` | Pure type definitions, no changes needed |
| `enum-i18n.ts` | Removed `'use client'` directive; otherwise identical |
| `rbac.ts` | Pure permission matrix, added missing `getPermission`, `canAccess`, `getAllowedResources` helpers |
| `queue-scheduler.ts` | Pure logic, no changes needed |
| `sounds.ts` | AudioContext works in Electron, no changes needed |
| `turn-alert-sleep.ts` | localStorage works in Electron, no changes needed |
| `date-utils.ts` | Pure date logic, no changes needed |
| `cache.ts` | Pure in-memory cache, no changes needed |

### Adapted Files
| File | Adaptation |
|------|-----------|
| `rate-limit.ts` | Replaced `NextRequest`→`Request`, `NextResponse`→`Response` throughout; `rateLimitErrorResponse()` returns standard `Response` |
| `fetch-with-retry.ts` | `getApiBaseUrl()` returns `http://127.0.0.1:3080`; removed `apiFetch` dependency, uses native `fetch()` directly |
| `utils.ts` | **MERGED**: Kept Desktop's existing `cn()`, `formatTime()`, `formatDate()`, etc.; added `twMerge` import; added Web's `getProxiedUrl()` adapted for Electron (no R2/Vercel env vars) |
| `platform.ts` | `detectPlatform()` always returns `electron`; no Capacitor detection; OS detection from `navigator.userAgent` |
| `platform-capabilities.ts` | Full capability matrix preserved for type compatibility; Android/iOS matrices set to `UNKNOWN_CAPABILITIES`; lookup defaults to `ELECTRON_CAPABILITIES` |
| `native-bridge.ts` | All Capacitor branches removed; only `window.electronAPI` + Web API fallbacks; `shareContent()` uses clipboard fallback on Electron; `scanQR()` returns null |
| `api-client.ts` | Stub re-export wrapping `fetchWithRetry`; provides `ApiClient`, `ApiClientError`, `apiClient` singleton with get/post/put/patch/delete methods |
| `route-map.ts` | Same view→URL mapping as Web; uses `@/store/use-app-store` ViewName type |

### Pre-existing Files (not modified)
- `api-fetch.ts` — Already desktop-adapted, routes to local API at `127.0.0.1:3080`

## Verification
- ✅ No `process.env.NEXT_PUBLIC_*` references
- ✅ No `'use client'` directives
- ✅ No `next/` imports (no NextRequest, NextResponse, next/server)
- ✅ No active Capacitor code paths (only type definitions and `false` values)
- ✅ All `@/` imports preserved (same path alias in Desktop)
- ✅ Desktop `utils.ts` merged (not overwritten)
