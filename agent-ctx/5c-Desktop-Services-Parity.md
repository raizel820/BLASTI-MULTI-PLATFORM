# Task 5c - Desktop Services Parity

## Task: Enhance Desktop Services page to match Web functionality

## Work Summary

Enhanced the Desktop's Services.tsx page (148 lines → 823 lines) to match the Web's service management functionality from agency-settings.tsx.

## Files Modified

1. **apps/desktop/frontend/src/pages/Services.tsx** - Complete rewrite with all service management features
2. **apps/desktop/frontend/src/i18n/en.ts** - Added 22 new i18n keys
3. **apps/desktop/frontend/src/i18n/fr.ts** - Added 22 new i18n keys (French translations)
4. **apps/desktop/frontend/src/i18n/ar.ts** - Added 22 new i18n keys (Arabic translations)

## Features Added

1. Multilingual service names (English, Arabic with RTL, French)
2. Service prefix (uppercase, maxLength 3)
3. Estimated duration/wait time with range validation (1-999 min)
4. Active/Inactive toggle via Switch component (inline in list + in edit dialog)
5. Service capacity (max concurrent reservations, 1-500 range)
6. Service ordering/sorting (move up/down arrows on hover, reorder API call)
7. Service description (Textarea field)
8. Service settings (allow walk-in, auto-complete toggles)
9. Proper validation (validateServiceForm function)
10. Proper error handling with toast notifications (sonner)
11. Confirmation dialog (AlertDialog) for delete with service name
12. Search/filter services (by name/nameAr/nameFr/prefix)
13. Service count display (stats cards: total, active, inactive)

## Architecture Decisions

- Uses `apiFetch` from `@/lib/api-fetch` (consistent with other Desktop pages)
- Uses `useAppStore()` for `agencyId`
- All shadcn/ui components (Card, Dialog, AlertDialog, Button, Input, Switch, Badge, etc.)
- Framer Motion animations for entrance and list transitions
- Full i18n support via `useLanguage()` hook with fallback defaults
- No `WalkIn` icon from lucide-react (doesn't exist); uses `Zap` for auto-complete badge

## Verification

- TypeScript compilation: only pre-existing module resolution errors (sonner, framer-motion, lucide-react), no code errors in our files
- No i18n errors
