'use client';

// ─── Task 4: Super-Admin Analytics & Statistics — entry re-export ───────────
// The full section lives in ./analytics/admin-analytics-dashboard.tsx (rebuilt
// on the agency analytics building blocks + new admin-only panels). This thin
// re-export keeps the established import path
// '@/components/admin/admin-analytics' working for the lazy import in
// src/app/page.tsx (view 'admin-analytics').

export { AdminAnalytics } from './analytics/admin-analytics-dashboard';
