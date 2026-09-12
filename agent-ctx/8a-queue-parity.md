# Task 8a: Local API Queue Business Logic Parity

## Summary
Fixed all Local API queue routes to match Cloud API business logic. 9 route handlers enhanced across `apps/desktop/local-api/index.js`.

## Routes Modified

| Route | Key Additions |
|-------|--------------|
| POST /api/queue/call-next | Auto-complete, queueNumber sort, preferred time, optimistic concurrency, counter assignment, notification, audit log |
| POST /api/agency/queue/walk-in | Queue open/paused check, capacity check, ETA calculation, import token, audit log, userId=null, prefix-NNN format |
| POST /api/agency/queue/toggle-pause | Audit log (QUEUE_PAUSE/QUEUE_RESUME) |
| PATCH /api/agency/queue/:id | State transition validation, counter clearing, notification, audit log |
| POST /api/queue/complete/:id | Counter clearing, notification, audit log |
| POST /api/queue/no-show/:id | Counter clearing, notification, audit log |
| POST /api/queue/cancel/:id | Counter clearing, notification, audit log |
| POST/PUT /api/queue/pause | Audit log (SETTINGS_UPDATE/PAUSE_QUEUE) |
| POST/PUT /api/queue/resume | Audit log (SETTINGS_UPDATE/RESUME_QUEUE) |

## Business Rules Achieved
1. Auto-complete: CALLED reservations auto-completed when counter calls next
2. Position: queueNumber ASC sorting + preferred time skip logic
3. ETA: Historical data (7-day trimmed mean) + active counter parallelism + variance
4. Capacity: maxActiveReservations check on walk-in
5. State transitions: Validated before update
6. Counter clearing: currentReservationId nulled on complete/no_show/cancel

## Files Modified
- `apps/desktop/local-api/index.js` (7149→7601 lines, +452)
- `worklog.md` (appended task 8a entry)

## Verification
- `node -c apps/desktop/local-api/index.js` passed
