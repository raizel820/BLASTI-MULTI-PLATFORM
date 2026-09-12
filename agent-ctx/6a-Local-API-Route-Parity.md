# Task 6a: Local API Route Parity

## Summary
Added 23 missing Cloud API routes to the local API (`apps/desktop/local-api/index.js`) for feature parity between Desktop and Web frontends.

## Routes Added (23)

### Notification Routes (3)
1. `POST /api/notifications` — Create notification
2. `PATCH /api/notifications` — Bulk mark as read (markAll or notificationIds)
3. `PATCH /api/notifications/mark-read` — Mark all as read

### Reservation Routes (13)
4. `GET /api/reservations/agency` — Agency reservations with user/service includes
5. `POST /api/reservations/batch-complete` — Batch complete (max 100)
6. `POST /api/reservations/reclaim` — Reclaim no-show reservation
7. `DELETE /api/reservations/cancel-active` — Cancel active reservation
8. `POST /api/reservations/import-walk-in` — Import walk-in from QR token
9. `PATCH /api/reservations/:id/status` — Update status with transition validation
10. `POST /api/reservations/:id/rate` — Rate completed reservation
11. `GET /api/reservations/:id/eta` — Get ETA
12. `POST /api/reservations/:id/toggle-fixed-time` — Toggle fixed-time
13. `GET /api/reservations/:id/position-history` — Position history timeline
14. `GET /api/reservations/:id/share` — Get shareable link
15. `POST /api/reservations/:id/share` — Create shareable link

### Queue Routes (2)
16. `PUT /api/queue/settings` — Update queue settings
17. `GET /api/queue/track` — Customer queue tracking

### User Routes (3)
18. `GET /api/user/stats` — User stats
19. `GET /api/user/customer/service-stats` — Service duration stats
20. `DELETE /api/user/delete-account` — Delete account with cascade

### Review Routes (2)
21. `PATCH /api/reviews/:id` — Update review
22. `DELETE /api/reviews/:id` — Delete review (customer-side)

## Method Mismatches (6) — Already Existed
- `PATCH /api/agency/profile` ✓
- `PUT /api/queue/pause` ✓
- `PUT /api/queue/resume` ✓
- `PATCH /api/user/profile` ✓
- `PATCH /api/agency/services/:id` ✓
- `PATCH /api/agency/branches/:id` ✓

## Key Details
- File: `apps/desktop/local-api/index.js` (5819→7148 lines)
- All routes follow existing patterns: authMiddleware, sessionUser, db, emitEvent, logPendingMutation
- Business logic matches Cloud API reference implementations
- Syntax verified: `node -c` passed
- Total route registrations: 155
