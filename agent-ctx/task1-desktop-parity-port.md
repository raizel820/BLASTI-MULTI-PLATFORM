# Task: Copy shared components, i6n stubs, and adapters from Web to Desktop

## Summary

Successfully copied and adapted all shared components, i18n translations, and lib adapters from the Web app (`apps/web/src`) to the Desktop frontend (`apps/desktop/frontend/src`). All new files compile without TypeScript errors.

## What was done

### 1. Shared Components (27 files)
- **Source**: `apps/web/src/components/shared/`
- **Target**: `apps/desktop/frontend/src/components/shared/`
- Copied all files, keeping the existing `stats-card.tsx` (desktop-specific) and placing the web version as `stats-card.web.tsx`
- **Transformations applied to all files**:
  - Removed `'use client'` directives
  - Replaced `process.env.NODE_ENV === 'production'` → `import.meta.env.PROD`
  - Replaced `process.env.NODE_ENV === 'development'` → `import.meta.env.DEV`
  - Replaced `process.env.NEXT_PUBLIC_*` → `import.meta.env.VITE_*`
- **File-specific adaptations**:
  - `notification-badge.tsx`: Replaced `@/lib/api-client` import with inline desktop shims for `isApiUnreachable()`/`isBothUnreachable()` (always return `false` — Desktop talks to local API)
  - `connection-status.tsx`: Simplified health check URL to `/health` (Desktop connects to local API, no XTransformPort needed)
  - `rating-dialog.tsx`: Fixed double semicolon in import
  - `QueueE2ETestPanel.tsx`: Created `@/lib/e2e-queue-test.ts` stub so the component compiles (returns a single "skipped" step)

### 2. i18n Stubs (4 files)
- **Source**: `apps/web/src/i18n/`
- **Target**: `apps/desktop/frontend/src/i18n/`
- Copied `index.ts`, `en.ts`, `ar.ts`, `fr.ts` as-is
- Fixed duplicate object keys in all 3 language files (Next.js tolerated these but strict TS doesn't)

### 3. Lib Adapters (6 files)
- **Source**: `apps/web/src/lib/adapters/`
- **Target**: `apps/desktop/frontend/src/lib/adapters/`
- Copied all 6 adapter files as-is:
  - `storage-adapter.ts` — works with localStorage (Electron has full support)
  - `notification-adapter.ts` — Electron path uses `window.electronAPI.sendNotification()`
  - `share-adapter.ts` — Electron path uses clipboard + notification
  - `qr-adapter.ts` — file upload + canvas generation
  - `deeplink-adapter.ts` — Electron path uses `window.electronAPI.onDeepLink()`
  - `index.ts` — barrel export

### 4. Supporting Changes
- **`vite-env.d.ts`**: Created with `Window.Capacitor` type declaration (referenced by adapter code, even though Desktop never uses Capacitor)
- **`@/lib/e2e-queue-test.ts`**: Created stub with types and no-op `runE2EQueueTest()`
- **`@/hooks/use-language.ts&`**: Upgraded from stub to full i18n-backed implementation (reads from `@/i.18n`, uses `useSyncExternalStore` for reactivity, persists language to localStorage)
- **`@/hooks/use-platform.tsx`**: Upgraded from simple stub to context-based implementation matching Web's API (supports `setOverride` for dev platform preview, `capabilities`, `override`)
- **`@/hooks/use-realtime.tsx`**: Added `isConnected` alias (returns `false` like `connected`) for Web component compatibility
- **`@/store/use-app-store.ts`**: Updated comment about i18n availability

## Files NOT modified (pre-existing)
- `apps/desktop/frontend/src/components/shared/stats-card.tsx` — kept existing desktop-specific version
- `apps/desktop/frontend/src/components/shared/sync-indicator.tsx` — kept existing desktop-specific version

## Build verification
- All new/modified files compile without TypeScript errors
- 37 pre-existing TS errors remain (unrelated to this task): shadcn/ui chart/calendar, resizable-panels, toaster, use-realtime.ts, enum-i18n, route-map
