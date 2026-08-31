# @blasti/web — Next.js 16 Web Application

> The main web interface for BLASTI (بلاصتي), a smart queue management platform.
> Built with Next.js 16, React 19, TypeScript, Tailwind CSS 4, and shadcn/ui.

---

## Quick Start

```bash
# From repo root (starts both API + Web)
bun run dev

# Web only
bun run dev:web
```

The app starts on **port 3000** with `-H ::` (dual IPv4/IPv6 stack).

---

## Page Structure

The app uses a **hash-based view router** powered by Zustand state (not Next.js file-based routing). The main `page.tsx` renders a `ViewRouter` component that switches between lazy-loaded views.

### Auth Pages

| View Name | Hash Route | Component | Description |
|---|---|---|---|
| `landing` | `#/` | `LandingPage` | Public landing page with login/register tabs |
| `login` | `#/login` | `LoginForm` | Login form (customer/agency tabs) |
| `register` | `#/register` | `RegisterForm` | Registration form |

### Customer Pages

| View Name | Hash Route | Component | Description |
|---|---|---|---|
| `customer-home` | `#/customer` | `CustomerHome` | Agency browser, active queue status |
| `customer-queue` | `#/customer/queue` | `CustomerQueue` | Live queue position, ETA, real-time updates |
| `customer-history` | `#/customer/history` | `CustomerHistory` | Past reservations and ratings |
| `customer-notifications` | `#/customer/notifications` | `CustomerNotifications` | Notification center |
| `customer-profile` | `#/customer/profile` | `CustomerProfile` | Profile editor, preferences |
| `customer-favorites` | `#/customer/favorites` | `CustomerFavorites` | Saved agencies |
| `customer-settings` | `#/customer/settings` | `CustomerSettings` | App settings (language, notifications) |

### Agency Pages

| View Name | Hash Route | Component | Description |
|---|---|---|---|
| `agency-dashboard` | `#/agency` | `AgencyDashboard` | Queue overview, live stats |
| `agency-settings` | `#/agency/settings` | `AgencySettings` | Queue config, working hours |
| `agency-profile` | `#/agency/profile` | `AgencyProfile` | Agency info editor |
| `agency-employees` | `#/agency/employees` | `AgencyEmployees` | Staff management |
| `agency-subscription` | `#/agency/subscription` | `AgencySubscription` | Plan management, payments |
| `agency-reviews` | `#/agency/reviews` | `AgencyReviews` | Customer reviews |
| `agency-branches` | `#/agency/branches` | `AgencyBranches` | Branch and counter management |

### Admin Pages

| View Name | Hash Route | Component | Description |
|---|---|---|---|
| `admin-dashboard` | `#/admin` | `AdminDashboard` | Platform overview |
| `admin-transactions` | `#/admin/transactions` | `AdminTransactions` | Payment review |
| `admin-agencies` | `#/admin/agencies` | `AdminAgencies` | Agency management |
| `admin-audit` | `#/admin/audit` | `AdminAuditLogs` | Audit trail |
| `admin-users` | `#/admin/users` | `AdminUsers` | User management |
| `admin-analytics` | `#/admin/analytics` | `AdminAnalytics` | Platform analytics |
| `admin-settings` | `#/admin/settings` | `AdminSettings` | Platform config |
| `admin-subscription-plans` | `#/admin/subscription-plans` | `AdminSubscriptionPlans` | Plan management |

### Kiosk Pages

| View Name | Hash Route | Component | Description |
|---|---|---|---|
| `kiosk` | `#/kiosk` | `KioskLanding` / `KioskMode` | Self-service kiosk terminal |

**Deep link support:** `?mode=kiosk&code=AGENCY_CODE` or `#/kiosk/CODE`

---

## Component Organization

```
apps/web/src/
├── app/
│   ├── layout.tsx          → Root layout (providers, fonts, theme)
│   ├── page.tsx            → Main SPA page (ViewRouter, navigation shell)
│   ├── globals.css         → Global styles + Tailwind
│   ├── auth/               → Next.js auth pages (login, register)
│   ├── customer/           → Customer Next.js pages (queue, history, etc.)
│   ├── agency/             → Agency Next.js pages
│   └── admin/              → Admin Next.js pages
├── components/
│   ├── auth/               → LandingPage, LoginForm, RegisterForm
│   ├── customer/           → CustomerHome, CustomerQueue, CustomerHistory, etc.
│   ├── agency/             → AgencyDashboard, AgencySettings, AgencyProfile, etc.
│   ├── admin/              → AdminDashboard, AdminUsers, AdminAgencies, etc.
│   ├── kiosk/              → KioskLanding, KioskMode
│   ├── platform/           → PlatformFrame, CustomerNavigation, AdaptiveAgencySidebar, AdaptiveAdminSidebar
│   ├── shared/             → OnboardingWizard, ErrorBoundary, LanguageSwitcher, ThemeToggle, ConnectionStatus, NotificationBadge
│   ├── providers/          → AuthProvider, PlatformProvider
│   └── ui/                 → shadcn/ui components (Button, Card, Dialog, etc.)
├── hooks/
│   ├── use-realtime.ts     → Socket.IO connection hook
│   ├── use-language.ts     → i18n language hook
│   ├── use-platform.ts     → Platform detection (web/electron/capacitor)
│   ├── use-online-status.ts → Online/offline detection
│   ├── use-upload.ts       → File upload hook
│   ├── use-toast.ts        → Toast notification hook
│   ├── use-debounce.ts     → Debounce utility hook
│   ├── use-local-storage.ts → localStorage hook
│   └── use-mobile.ts       → Mobile detection hook
├── lib/
│   ├── api-client.ts       → Cross-platform HTTP client
│   ├── realtime.ts         → Deprecated realtime wrapper (use realtime-emit)
│   ├── realtime-emit.ts    → Socket.IO event emission helpers
│   ├── platform.ts         → Platform detection utilities
│   ├── platform-capabilities.ts → Platform feature detection
│   ├── native-bridge.ts    → Capacitor/Electron bridge
│   ├── rbac.ts             → Role-based access control
│   ├── enums.ts            → String enum constants
│   ├── validations.ts      → Zod validation schemas
│   ├── cache.ts            → Client-side caching
│   ├── sounds.ts           → Audio notification sounds
│   ├── utils.ts            → Shared utilities
│   ├── route-map.ts        → Route/view mapping
│   ├── date-utils.ts       → Date formatting
│   ├── fetch-with-retry.ts → Fetch with retry logic
│   ├── password.ts         → Password validation
│   ├── queue-scheduler.ts  → Client-side queue logic
│   ├── rate-limit.ts       → Client-side rate limiting
│   └── adapters/           → Platform adapter pattern
│       ├── notification-adapter.ts
│       ├── storage-adapter.ts
│       ├── qr-adapter.ts
│       ├── deeplink-adapter.ts
│       └── share-adapter.ts
├── store/
│   └── use-app-store.ts    → Zustand global state
├── i18n/
│   ├── index.ts            → i18n setup, t() function, Language type
│   ├── ar.ts               → Arabic translations (primary, RTL)
│   ├── fr.ts               → French translations
│   └── en.ts               → English translations
└── types/
    └── css.d.ts            → CSS module type declarations
```

---

## State Management (Zustand Store)

The global app state is managed by a single Zustand store with `persist` middleware.

### Store Shape

```ts
interface AppState {
  // Auth
  user: UserState | null;        // Current user (id, username, fullName, role, language, agencyId)
  isAuthenticated: boolean;

  // Navigation
  currentView: ViewName;         // Active view (e.g., 'customer-queue')
  previousView: ViewName | null; // For back navigation

  // UI
  sidebarOpen: boolean;          // Agency/admin sidebar state

  // Deep links
  pendingAgencyCode: string | null; // QR code join pending

  // Onboarding
  onboarded: boolean;            // First-time user onboarding completed

  // Actions
  setUser: (user: UserState | null) => void;
  setView: (view: ViewName) => void;
  goBack: () => void;
  toggleSidebar: () => void;
  logout: () => void;
  setPendingAgencyCode: (code: string | null) => void;
  setOnboarded: (v: boolean) => void;
}
```

### Persistence

- **Storage key:** `blasti-app` in localStorage
- **Persist version:** 3 (with migration from v0/1/2)
- **Sanitization:** All persisted state is sanitized on merge/migrate to prevent:
  - NaN number fields
  - Null/undefined in required fields
  - Invalid ViewName values
  - Inconsistent `isAuthenticated: true` with `user: null`

### Hash-Based Navigation

The store synchronizes with `window.location.hash`:
- `setView()` updates both the Zustand state and the URL hash
- `parseHashToView()` converts hash to ViewName (supports deep links)
- `#/join/CODE` → auto-navigates to customer queue
- `#/kiosk/CODE` → opens kiosk mode

### Logout

On logout, the store:
1. Resets all state to defaults
2. Clears `localStorage` keys (`blasti-app`, `blasti-lang`)
3. Calls `POST /api/auth/logout` to clear the JWT cookie server-side
4. Redirects to `/`

---

## API Client Architecture

### Cross-Platform Design

The `ApiClient` class automatically resolves the correct base URL based on the runtime:

| Runtime | Base URL | Auth Method |
|---|---|---|
| **Web (browser)** | `""` (relative/same-origin) | Session cookie (automatic) |
| **Electron** | `NEXT_PUBLIC_API_URL` or `https://blasti.vercel.app` | `Authorization: Bearer <token>` |
| **Capacitor** | `NEXT_PUBLIC_API_URL` or `https://blasti.vercel.app` | `Authorization: Bearer <token>` |
| **SSR (server)** | `INTERNAL_API_URL` or `http://localhost:3000` | Cookie forwarding |

### Features

- **Timeout**: 30s default, configurable per-request
- **Retries**: 3 attempts with exponential backoff (1s base)
- **429 handling**: Respects `Retry-After` header
- **Error normalization**: `ApiClientError` with `status`, `body`, `isNetworkError`
- **204 handling**: Returns `null` data for empty responses (Capacitor crash fix)
- **JSON unwrapping**: Auto-unwraps `{ data: ... }` envelopes

### Usage

```ts
import { apiClient } from '@/lib/api-client';

// GET request
const res = await apiClient.get<Agency[]>('/api/agencies', {
  params: { city: 'M\'Sila' }
});

// POST request
const created = await apiClient.post<Reservation>('/api/reservations', {
  agencyId, serviceId
});
```

### Native Session Token

For Electron/Capacitor, the JWT is stored in `localStorage` under `blasti-session-token` after login. The API client reads this and injects it as a `Bearer` token.

---

## Real-Time Integration

### Socket.IO Connection

The `useRealtime` hook manages a singleton Socket.IO connection:

```ts
const { isConnected, joinAgency, onQueueCalled, onYourTurn } = useRealtime();

// Join an agency room
useEffect(() => {
  joinAgency(agencyId);
  return () => leaveAgency(agencyId);
}, [agencyId]);

// Subscribe to events
useEffect(() => {
  const unsub = onQueueCalled((data) => {
    // Update UI with new queue state
  });
  return unsub;
}, []);
```

### Connection Features

- **Auto-reconnect**: Infinite attempts, 1s initial delay, 30s max
- **Transport**: WebSocket first, polling fallback
- **Path**: `/socket.io` (proxied to API via Next.js rewrites in dev)
- **Port transform**: `XTransformPort: "3003"` query param for proxy routing
- **Connection status**: `'connected' | 'disconnected' | 'connecting'`
- **Global socket**: Shared across all hook instances, auto-disconnects when last consumer unmounts

### Server-Side Emit (API Routes)

API routes emit events via internal HTTP calls to the `/emit` endpoint:

```ts
// From any API route
import { emitQueueEvent, emitNotificationEvent } from '@/lib/realtime-emit';

await emitQueueEvent('queue:called', agencyId, { displayNumber, counterId });
await emitNotificationEvent('notification:your-turn', userId, { ticketNumber });
```

---

## i18n Support

### Supported Languages

| Code | Language | Direction | Status |
|---|---|---|---|
| `ar` | العربية (Arabic) | RTL | Primary / Default |
| `fr` | Français (French) | LTR | Full support |
| `en` | English | LTR | Full support |

### Architecture

- **Translation files:** `src/i18n/{ar,fr,en}.ts` — flat key-value maps
- **Type safety:** `TranslationKeys` type derived from Arabic (primary) translations
- **Hook:** `useLanguage()` returns `{ t, lang, setLang }`
- **t() function:** `t(key, lang, params?)` — supports `{param}` interpolation
- **RTL detection:** `isRTL(lang)` — used for `dir` attribute and layout adjustments
- **Dynamic direction:** `updateDocumentDirection()` updates `<html dir="" lang="">` on language change
- **Persistence:** Language preference stored in `localStorage` as `blasti-lang`

### Usage in Components

```tsx
const { t, lang } = useLanguage();

return (
  <div dir={isRTL(lang) ? 'rtl' : 'ltr'}>
    <h1>{t('myQueue')}</h1>
    <p>{t('estimatedWait', lang, { minutes: '15' })}</p>
  </div>
);
```

---

## Layout Architecture

### Root Layout (`layout.tsx`)

```
<html lang="ar">
  <body>
    <ThemeProvider>       → Dark/light theme (next-themes)
      <PlatformProvider>  → Platform detection context
        <AuthProvider>    → Session validation, auto-redirect
          <ErrorBoundary> → Crash recovery
            {children}
          </ErrorBoundary>
        </AuthProvider>
      </PlatformProvider>
    </ThemeProvider>
  </body>
</html>
```

### Main Page (`page.tsx`)

The page component acts as the SPA shell:

1. **Hydration guard**: Shows loading spinner until client mounts (prevents SSR mismatch)
2. **Auth gate**: Unauthenticated users see `landing`/`login`/`register` only
3. **ViewRouter**: Lazy-loaded view components switched by `currentView`
4. **Navigation chrome**:
   - **Customer**: `CustomerNavigation` (bottom tabs on mobile, header on Electron)
   - **Agency**: `AdaptiveAgencySidebar` (sidebar + top bar)
   - **Admin**: `AdaptiveAdminSidebar` (sidebar + top bar)
   - **Kiosk**: Full-screen, no chrome
5. **Global UI**: Connection status banner, language switcher, theme toggle, notification badge
6. **Onboarding wizard**: First-time user preferences

---

## Key Libraries

| Library | Purpose |
|---|---|
| `next` 16 | React framework (App Router, rewrites) |
| `react` 19 | UI library |
| `zustand` | Global state management |
| `socket.io-client` | Real-time WebSocket connection |
| `framer-motion` | Page transitions and animations |
| `sonner` | Toast notifications |
| `next-themes` | Dark/light theme |
| `lucide-react` | Icon library |
| `qrcode` | QR code generation |
| `zod` | Runtime validation |
