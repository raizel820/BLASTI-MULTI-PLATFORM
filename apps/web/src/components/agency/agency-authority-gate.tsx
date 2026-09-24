'use client';

// ─── Task 37-e: agency section authority gate ───────────────────────────────
//
// Wraps the restricted agency views rendered by the SPA ViewRouter
// (src/app/page.tsx). While the authority is loading the children render
// unchanged (previous behavior — no flicker); once loaded, a session that has
// no authority for the section is redirected to the agency dashboard
// ('/agency') with a friendly toast. Dashboard/history/fullscreen are never
// gated. The server still enforces the authoritative 403 on every route —
// this gate is UX, not security.

import { useEffect, useRef, type ReactNode } from 'react';
import { useAppStore, type ViewName } from '@/store/use-app-store';
import { useLanguage } from '@/hooks/use-language';
import {
  useAgencyAuthority,
  canAccessAgencySection,
  type AgencySectionView,
} from '@/hooks/use-agency-authority';
import { toast } from 'sonner';

export function AgencyAuthorityGate({ view, children }: { view: ViewName; children: ReactNode }) {
  const user = useAppStore((s) => s.user);
  const setView = useAppStore((s) => s.setView);
  const { t } = useLanguage();
  const { authority } = useAgencyAuthority();
  const redirectedRef = useRef(false);

  const authorized = canAccessAgencySection(view as AgencySectionView, authority, user?.role);

  useEffect(() => {
    if (authorized || redirectedRef.current) return;
    redirectedRef.current = true;
    toast.error(t('ownerOnlySection'));
    setView('agency-dashboard');
  }, [authorized, setView, t]);

  if (!authorized) return null;
  return <>{children}</>;
}
