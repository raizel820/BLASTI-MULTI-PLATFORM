# Task ID: reapply-customer-fixes — Work Record

## Summary
Re-applied the customer-side turn-alert sleep-mode wiring and reservation-card UI fixes that were lost when files reverted. The `apps/web/src/lib/turn-alert-sleep.ts` module was already re-created and used as-is.

## Files Modified
1. `apps/web/src/components/customer/customer-queue.tsx`
   - Added sleep-mode import.
   - `handleConfirmTurn`: calls `enterSleepMode(calledRes.id)` + `closeTurnNotifications()`; kept `soundStartedRef.current = true`.
   - `onYourTurn` handler: `shouldShowAlert` early-return guard.
   - New `useEffect` subscribing to sleep module for reactivation (re-shows alert ONCE when 10-min timer expires).
   - `handleLeaveQueue`: prepended `clearSleep()`.
   - Realtime effect: `handleTerminalQueueEvent` (clearSleep + fetch) wired to `onQueueCompleted`/`onQueueNoShow`/`onQueueCancelled`.
   - `fetchReservations`: snapshot previously-CALLED IDs via `prevStatusRef`; clear sleep if none still CALLED.
   - Removed duplicate Emergency Cancel button (kept the AlertDialog).

2. `apps/web/src/hooks/use-realtime.tsx`
   - Imported sleep helpers (renamed `subscribe` → `subscribeSleep` to avoid name clash with realtime `subscribe`).
   - `useTurnAlert`: `turnAlertData` now carries optional `reservationId`.
   - `notification:your-turn` + `queue:called` handlers: extract `reservationId`, early-return if `shouldShowAlert` is false, store `reservationId`.
   - New subscription `useEffect`: re-show overlay ONCE on `isReactivationDue`; hide while sleeping.
   - `dismissTurnAlert`: calls `enterSleepMode` + `closeTurnNotifications`; removed `setTimeout` clearing `turnAlertData`.

3. `apps/web/src/hooks/use-realtime.ts`
   - Same changes as use-realtime.tsx applied to its `useTurnAlert` (duplicate hook).

4. `apps/web/src/components/customer/AggressiveTurnAlert.tsx`
   - Imported `closeTurnNotifications`.
   - `handleDismiss`: calls `closeTurnNotifications()` before `onDismiss()`.

5. `apps/web/src/components/customer/queue/QueueReservationCard.tsx`
   - Replaced 3-button `flex gap-2` row with 2+1 grid (Postpone + Leave in row 1, Cancel Reservation full-width in row 2).
   - Removed duplicate Emergency Cancel button (kept the AlertDialog).
   - Removed duplicate "CALLED — prominent info" bottom banner.

## Verification
- `bun run lint` — exit 0, no errors.
- `tail dev.log` — multiple "✓ Compiled in XXXms" entries after edits (no compile errors). The pre-existing runtime error caught by error boundary is unrelated.

## Notes / Caveats
- `onEmergencyCancel` is now an unused prop on `QueueReservationCard` — kept for backward compatibility (no-unused-vars is OFF).
- `clearSleep` import in `use-realtime.ts(x)` is unused in `useTurnAlert` — kept per task spec (sleep clearing happens in customer-queue.tsx).
- `customer-queue.tsx` still has an orphaned Emergency Cancel `AlertDialog` (trigger removed) per task's "keep the dialog" instruction.

## Constraints Honored
- Did NOT modify `apps/web/src/lib/turn-alert-sleep.ts`.
- Did NOT modify any agency-side files.
- Did NOT add test code.
- Used API (no server actions).
- Read each file fully before editing.
