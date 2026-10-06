'use client';

import { useEffect, useState, Suspense, memo, useCallback, useRef } from 'react';
// Task 84 — resilient lazy views: every chunk import gets a timeout + retry
// (a failed/hanging chunk can no longer black-screen a view), plus idle-time
// warming of the chunks the current role is most likely to open next.
import { lazyNamed, warmViews } from '@/lib/lazy-view';
import { useAppStore, updateDocumentDirection } from '@/store/use-app-store';
import { useLanguage } from '@/hooks/use-language';
import { isRTL, type Language } from '@/i18n';
import { getProxiedUrl } from '@/lib/utils';
import { apiFetch } from '@/lib/api-fetch';
import { isApiUnreachable } from '@/lib/api-client';

// Auth Views — lazy loaded to reduce initial compilation footprint
const LandingPage = lazyNamed(() => import('@/components/auth/landing-page'), 'LandingPage');
const LoginForm = lazyNamed(() => import('@/components/auth/login-form'), 'LoginForm');
const DesktopAgencyLogin = lazyNamed(() => import('@/components/auth/desktop-agency-login'), 'DesktopAgencyLogin');
const RegisterForm = lazyNamed(() => import('@/components/auth/register-form'), 'RegisterForm');
// Task 78 — dedicated MOBILE (Capacitor) auth screens: customer-first,
// touch-first, safe-area aware replacements for the desktop-oriented forms.
const MobileLoginForm = lazyNamed(() => import('@/components/auth/mobile-login'), 'MobileLoginForm');
const MobileRegisterForm = lazyNamed(() => import('@/components/auth/mobile-register'), 'MobileRegisterForm');

// Customer Views
const CustomerHome = lazyNamed(() => import('@/components/customer/customer-home'), 'CustomerHome');
const CustomerQueue = lazyNamed(() => import('@/components/customer/customer-queue'), 'CustomerQueue');
const CustomerHistory = lazyNamed(() => import('@/components/customer/customer-history'), 'CustomerHistory');
const CustomerProfile = lazyNamed(() => import('@/components/customer/customer-profile'), 'CustomerProfile');
const CustomerNotifications = lazyNamed(() => import('@/components/customer/customer-notifications'), 'CustomerNotifications');
const CustomerFavorites = lazyNamed(() => import('@/components/customer/customer-favorites'), 'CustomerFavorites');
const CustomerSettings = lazyNamed(() => import('@/components/customer/customer-settings'), 'CustomerSettings');
// Task 54-d: personal "My Analytics" module (doc-2 §38-44) over the frozen
// 54-a customer endpoints (GET /api/customer/analytics/*).
const CustomerAnalytics = lazyNamed(() => import('@/components/customer/customer-analytics'), 'CustomerAnalytics');
// Support desk — customer side: file complaints/suggestions/questions/notes
// to the super admin and track replies.
const CustomerSupport = lazyNamed(() => import('@/components/customer/customer-support'), 'CustomerSupport');
// Task 81-b: public customer-facing agency profile (info/location/rating/comments).
const CustomerAgencyProfile = lazyNamed(() => import('@/components/customer/customer-agency-profile'), 'CustomerAgencyProfile');
// Task 83-c: customer-facing BRANCH profile (independent per-branch entity).
const CustomerBranchProfile = lazyNamed(() => import('@/components/customer/customer-branch-profile'), 'CustomerBranchProfile');

// Agency Views
const AgencyDashboard = lazyNamed(() => import('@/components/agency/agency-dashboard'), 'AgencyDashboard');
const AgencySettings = lazyNamed(() => import('@/components/agency/agency-settings'), 'AgencySettings');
const AgencyProfile = lazyNamed(() => import('@/components/agency/agency-profile'), 'AgencyProfile');
const AgencySubscription = lazyNamed(() => import('@/components/agency/agency-subscription'), 'AgencySubscription');
const AgencyReviews = lazyNamed(() => import('@/components/agency/agency-reviews'), 'AgencyReviews');
const AgencyEmployees = lazyNamed(() => import('@/components/agency/agency-employees'), 'AgencyEmployees');
const AgencyBranches = lazyNamed(() => import('@/components/agency/agency-branches'), 'AgencyBranches');
const AgencyDevices = lazyNamed(() => import('@/components/agency/agency-devices'), 'AgencyDevices');
// Task 42-e: dedicated Analytics & Statistics section (self-handles authority
// empty/error states — no AuthorityGate wrapper, like admin-analytics).
const AgencyAnalytics = lazyNamed(() => import('@/components/agency/analytics/analytics-dashboard'), 'AgencyAnalytics');
// Support desk — agency side: file tickets on behalf of the agency and track
// the super admin's replies.
const AgencySupport = lazyNamed(() => import('@/components/agency/agency-support'), 'AgencySupport');
const AgencyFullscreen = lazyNamed(() => import('@/components/agency/agency-fullscreen'), 'AgencyFullscreen');
const AgencyFullscreenHistory = lazyNamed(() => import('@/components/agency/agency-fullscreen-history'), 'AgencyFullscreenHistory');
// Device Views (standalone kiosk, TV board — accessed via ?mode=device&type=KIOSK|TV)
const DeviceKiosk = lazyNamed(() => import('@/components/devices/device-kiosk'), 'DeviceKiosk');
const DeviceTvBoard = lazyNamed(() => import('@/components/devices/device-tv-board'), 'DeviceTvBoard');

// Admin Views
const AdminDashboard = lazyNamed(() => import('@/components/admin/admin-dashboard'), 'AdminDashboard');
const AdminTransactions = lazyNamed(() => import('@/components/admin/admin-transactions'), 'AdminTransactions');
const AdminAgencies = lazyNamed(() => import('@/components/admin/admin-agencies'), 'AdminAgencies');
const AdminAuditLogs = lazyNamed(() => import('@/components/admin/admin-audit-logs'), 'AdminAuditLogs');
const AdminUsers = lazyNamed(() => import('@/components/admin/admin-users'), 'AdminUsers');
const AdminAnalytics = lazyNamed(() => import('@/components/admin/admin-analytics'), 'AdminAnalytics');
const AdminSettings = lazyNamed(() => import('@/components/admin/admin-settings'), 'AdminSettings');
// Task 2-b: standalone super-admin Maps & Location page (same component that
// is embedded mid-page inside admin-settings — promoted to its own view).
const AdminMaps = lazyNamed(() => import('@/components/admin/admin-maps-settings'), 'AdminMapsSettings');
const AdminSubscriptionPlans = lazyNamed(() => import('@/components/admin/admin-subscription-plans'), 'AdminSubscriptionPlans');
const AdminAppSettings = lazyNamed(() => import('@/components/admin/admin-app-settings'), 'AdminAppSettings');
const AdminHardware = lazyNamed(() => import('@/components/admin/admin-hardware'), 'AdminHardware');
const AdminHardwareRequests = lazyNamed(() => import('@/components/admin/admin-hardware-requests'), 'AdminHardwareRequests');
const AdminEnterpriseRequests = lazyNamed(() => import('@/components/admin/admin-enterprise-requests'), 'AdminEnterpriseRequests');
// Support desk — super-admin triage: reply to and resolve incoming tickets.
const AdminTickets = lazyNamed(() => import('@/components/admin/admin-tickets'), 'AdminTickets');

// Shared (eagerly imported — lightweight)
import { AgencyAuthorityGate } from '@/components/agency/agency-authority-gate';
import { ErrorBoundary } from '@/components/shared/error-boundary';
import { LanguageSwitcher } from '@/components/shared/language-switcher';
import { ThemeToggle } from '@/components/shared/theme-toggle';
import { PlatformSwitcher } from '@/components/shared/platform-switcher';
import { PlatformBadge } from '@/components/shared/platform-badge';
import { ConnectionStatus, ConnectionDot, onCloudStatusChange } from '@/components/shared/connection-status';
import { OfflineDiagnosisPanel } from '@/components/shared/offline-diagnosis-panel';
import { BlastiSkeleton, BlastiSkeletonCompact } from '@/components/shared/blasti-skeleton';
import { BootGate } from '@/components/shared/boot-gate';
import { PostLoginSyncGate } from '@/components/shared/post-login-sync-gate';
// Task 81 — biometric app-open lock + remember-me session keeper.
import { BiometricAppLock } from '@/components/shared/biometric-app-lock';
import { startSessionKeeper, SESSION_EXPIRED_EVENT } from '@/lib/session-keeper';
import { usePlatform } from '@/hooks/use-platform';
import { Button } from '@/components/ui/button';

// Shared (lazy loaded — heavy components that are conditionally rendered)
const OnboardingWizard = lazyNamed(() => import('@/components/shared/onboarding-wizard'), 'OnboardingWizard');
const NotificationCenter = lazyNamed(() => import('@/components/shared/NotificationCenter'), 'NotificationCenter');
// QueueE2ETestPanel removed — test button no longer needed

// ─── Task 84: idle-time view warming ─────────────────────────────────────────
// After the authenticated shell has painted, preload the view chunks the
// current role is most likely to open next (sequential, idle-scheduled —
// never competes with first paint). Dynamic imports of the same module share
// one chunk, so warming here makes the later lazyNamed(...) navigation
// resolve instantly — no chunk download on first tap, no black skeleton.
const WARMED_ROLES = new Set<string>();
function warmRoleViews(role: string): void {
  if (WARMED_ROLES.has(role)) return;
  WARMED_ROLES.add(role);
  const shared: Array<() => Promise<unknown>> = [
    () => import('@/components/shared/NotificationCenter'),
    () => import('@/components/shared/onboarding-wizard'),
  ];
  let roleViews: Array<() => Promise<unknown>> = [];
  if (role === 'CUSTOMER') {
    roleViews = [
      () => import('@/components/customer/customer-queue'),
      () => import('@/components/customer/customer-settings'),
      () => import('@/components/customer/customer-profile'),
      () => import('@/components/customer/customer-history'),
      () => import('@/components/customer/customer-favorites'),
      () => import('@/components/customer/customer-notifications'),
      () => import('@/components/customer/customer-agency-profile'),
      () => import('@/components/customer/customer-branch-profile'),
      () => import('@/components/customer/customer-support'),
      () => import('@/components/customer/customer-analytics'),
    ];
  } else if (role === 'AGENCY_OWNER' || role === 'AGENCY_STAFF') {
    roleViews = [
      () => import('@/components/agency/agency-settings'),
      () => import('@/components/agency/agency-profile'),
      () => import('@/components/agency/agency-branches'),
      () => import('@/components/agency/agency-employees'),
      () => import('@/components/agency/agency-reviews'),
      () => import('@/components/agency/analytics/analytics-dashboard'),
      () => import('@/components/agency/agency-subscription'),
      () => import('@/components/agency/agency-devices'),
      () => import('@/components/agency/agency-support'),
    ];
  } else if (role === 'SUPER_ADMIN') {
    roleViews = [
      () => import('@/components/admin/admin-agencies'),
      () => import('@/components/admin/admin-users'),
      () => import('@/components/admin/admin-transactions'),
      () => import('@/components/admin/admin-audit-logs'),
      () => import('@/components/admin/admin-analytics'),
      () => import('@/components/admin/admin-tickets'),
      () => import('@/components/admin/admin-settings'),
      () => import('@/components/admin/admin-maps-settings'),
      () => import('@/components/admin/admin-subscription-plans'),
      () => import('@/components/admin/admin-app-settings'),
    ];
  }
  warmViews([...roleViews, ...shared]);
}

// Platform-specific navigation components
import { PlatformFrame } from '@/components/platform/platform-frame';
import { CustomerNavigation, useCustomerNavPosition } from '@/components/platform/customer-navigation';
import { AdaptiveAgencySidebar, AdaptiveAdminSidebar } from '@/components/platform/adaptive-sidebar';

import {
  Menu,
  X,
  AlertTriangle,
} from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { Toaster } from 'sonner';
import { toast } from 'sonner';
import { useTurnAlert } from '@/hooks/use-realtime';
import { AggressiveTurnAlert } from '@/components/customer/AggressiveTurnAlert';

// Suspense fallback for lazy-loaded views — branded BLASTI skeleton
function ViewSpinner() {
  return <BlastiSkeleton />;
}

const ViewRouter = memo(function ViewRouter() {
  const currentView = useAppStore((s) => s.currentView);
  const { platform } = usePlatform();

  return (
    <ErrorBoundary>
      <Suspense fallback={<ViewSpinner />}>
        {(() => {
          switch (currentView) {
            case 'landing':
              return <LandingPage />;
            case 'login':
              // The DESKTOP app is agency-only and opens its dedicated console
              // login. The MOBILE shell (Capacitor, or a phone browser) gets
              // its own dedicated customer-first sign-in screen (Task 78).
              // Desktop/laptop web browsers keep the shared form.
              return platform.isElectron ? (
                <DesktopAgencyLogin />
              ) : platform.isCapacitor || platform.isMobile ? (
                <MobileLoginForm />
              ) : (
                <LoginForm />
              );
            case 'register':
              // Task 78 — the phone registers through the dedicated 3-step
              // mobile wizard (native camera/gallery avatar, customer-first).
              return platform.isCapacitor || platform.isMobile ? <MobileRegisterForm /> : <RegisterForm />;
            case 'customer-home':
              return <CustomerHome />;
            case 'customer-queue':
              return <CustomerQueue />;
            case 'customer-history':
              return <CustomerHistory />;
            case 'customer-profile':
              return <CustomerProfile />;
            case 'customer-notifications':
              return <CustomerNotifications />;
            case 'customer-favorites':
              return <CustomerFavorites />;
            case 'customer-settings':
              return <CustomerSettings />;
            case 'customer-analytics':
              // Task 54-d: personal analytics — scope is server-locked to the
              // caller (userId); 403/404 handled inside the module.
              return <CustomerAnalytics />;
            case 'customer-support':
              return <CustomerSupport />;
            // Task 81-b: reads agencyProfileId from the store (set by the
            // entry point); self-handles null id / 404 as a friendly state.
            case 'customer-agency-profile':
              return <CustomerAgencyProfile />;
            // Task 83-c: reads branchProfileId from the store (set by the
            // entry points: branch cards, QR deep link ?branch=<subCode>);
            // self-handles null id / 404 as a friendly state.
            case 'customer-branch-profile':
              return <CustomerBranchProfile />;
            case 'agency-dashboard':
              return <AgencyDashboard />;
            // Task 37-e: restricted agency sections pass through the authority
            // gate (owners/managers/staff matrix) — dashboard + history are
            // never gated.
            case 'agency-settings':
              return <AgencyAuthorityGate view="agency-settings"><AgencySettings /></AgencyAuthorityGate>;
            case 'agency-profile':
              return <AgencyAuthorityGate view="agency-profile"><AgencyProfile /></AgencyAuthorityGate>;
            case 'agency-subscription':
              return <AgencyAuthorityGate view="agency-subscription"><AgencySubscription /></AgencyAuthorityGate>;
            case 'agency-reviews':
              return <AgencyAuthorityGate view="agency-reviews"><AgencyReviews /></AgencyAuthorityGate>;
            case 'agency-employees':
              return <AgencyAuthorityGate view="agency-employees"><AgencyEmployees /></AgencyAuthorityGate>;
            case 'agency-branches':
              return <AgencyAuthorityGate view="agency-branches"><AgencyBranches /></AgencyAuthorityGate>;
            case 'agency-devices':
              return <AgencyAuthorityGate view="agency-devices"><AgencyDevices /></AgencyAuthorityGate>;
            case 'agency-analytics':
              // Task 42-e: the section self-handles empty/error/unauthorized
              // states — no AuthorityGate (mirrors admin-analytics wiring).
              return <AgencyAnalytics />;
            case 'agency-support':
              return <AgencySupport />;
            case 'agency-fullscreen':
              return <AgencyFullscreen />;
            case 'agency-fullscreen-history':
              return <AgencyFullscreenHistory />;
            case 'admin-dashboard':
              return <AdminDashboard />;
            case 'admin-transactions':
              return <AdminTransactions />;
            case 'admin-agencies':
              return <AdminAgencies />;
            case 'admin-audit':
              return <AdminAuditLogs />;
            case 'admin-users':
              return <AdminUsers />;
            case 'admin-analytics':
              return <AdminAnalytics />;
            case 'admin-tickets':
              return <AdminTickets />;
            case 'admin-settings':
              return <AdminSettings />;
            case 'admin-maps':
              // Task 2-b: standalone Maps & Location — AdminMapsSettings owns
              // no page padding (it is embedded in admin-settings), so the
              // view root provides the standard admin padding here.
              return <div className="p-4 lg:p-6"><AdminMaps /></div>;
            case 'admin-subscription-plans':
              return <AdminSubscriptionPlans />;
            case 'admin-app-settings':
              return <AdminAppSettings />;
            case 'admin-hardware':
              return <AdminHardware />;
            case 'admin-hardware-requests':
              return <AdminHardwareRequests />;
            case 'admin-enterprise-requests':
              return <AdminEnterpriseRequests />;
            default:
              return <LandingPage />;
          }
        })()}
      </Suspense>
    </ErrorBoundary>
  );
});

// Customer Navigation is now handled by <CustomerNavigation /> from @/components/platform/customer-navigation

// Agency & Admin Sidebars are now handled by <AdaptiveAgencySidebar /> and <AdaptiveAdminSidebar />
// from @/components/platform/adaptive-sidebar

export default function Home() {
  const user = useAppStore((s) => s.user);
  const currentView = useAppStore((s) => s.currentView);
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const setView = useAppStore((s) => s.setView);
  const setPendingAgencyCode = useAppStore((s) => s.setPendingAgencyCode);
  const pendingAgencyCode = useAppStore((s) => s.pendingAgencyCode);
  const onboarded = useAppStore((s) => s.onboarded);
  const setOnboarded = useAppStore((s) => s.setOnboarded);
  const logout = useAppStore((s) => s.logout);
  const isAuthenticated = useAppStore((s) => s.isAuthenticated);
  // Device mode: standalone kiosk/TV accessed via ?mode=device&type=KIOSK|TV
  const [deviceMode, setDeviceMode] = useState<string | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const mode = params.get('mode');
    const type = params.get('type');
    if (mode === 'device' && (type === 'KIOSK' || type === 'TV' || type === 'DISPLAY')) {
      setDeviceMode(type);
    }
  }, []);

  // L17: Reset device mode on URL change (popstate)
  useEffect(() => {
    const onUrlChange = () => {
      const params = new URLSearchParams(window.location.search);
      const mode = params.get('mode');
      const type = params.get('type');
      setDeviceMode(
        mode === 'device' && (type === 'KIOSK' || type === 'TV' || type === 'DISPLAY')
          ? type
          : null
      );
    };
    window.addEventListener('popstate', onUrlChange);
    return () => window.removeEventListener('popstate', onUrlChange);
  }, []);
 const { t, lang } = useLanguage();
  const { platform } = usePlatform();

  // Task 81 — remember-me session policy: while a remember-me session is
  // active the keeper refreshes the token during use and enforces the 3-day
  // hard wall. On expiry it dispatches blasti:session-expired; the listener
  // below tells the customer and returns them to the login screen (where
  // biometric quick-unlock auto-fires when enrolled).
  useEffect(() => {
    startSessionKeeper();
    const onExpired = () => {
      toast.error(t('sessionExpiredTitle'), {
        description: t('sessionExpiredBody'),
        duration: 8000,
      });
      setTimeout(() => { useAppStore.getState().logout(); }, 1500);
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
     
  }, []);
  // Aggressive turn alert — full-screen overlay when customer's turn is called
  // Hook is always called (rules of hooks) but only activates for customers via userId filtering
  const { showTurnAlert, turnAlertData, dismissTurnAlert } = useTurnAlert(user?.role === 'CUSTOMER' ? user?.id : undefined);

  const [showDiagnosis, setShowDiagnosis] = useState(false);
  const [globalAnnouncements, setGlobalAnnouncements] = useState<Array<{ id: string; message: string; type: string; createdAt: string }>>([]);
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const [showOnboarding, setShowOnboarding] = useState(false);
  // Task 41 — boot splash gate: true once the post-login/reload data sync
  // settled and the authenticated shell may mount. Rearmed on logout.
  const [bootReady, setBootReady] = useState(false);

  // Auto-show diagnosis panel when cloud goes down (desktop app offline transition)
  useEffect(() => {
    const unsub = onCloudStatusChange((isDown) => {
      if (isDown && platform.isElectron) {
 setShowDiagnosis(true);
      }
    });
    return unsub;
  }, [platform.isElectron]);

  // Listen for custom event from ConnectionStatus "Diagnose" button
  useEffect(() => {
    const handler = () => setShowDiagnosis(true);
    window.addEventListener("blasti:show-diagnosis", handler);
    return () => window.removeEventListener("blasti:show-diagnosis", handler);
  }, []);

  // Phase 6c: Hydration mismatch guard — useAppStore reads from localStorage on
  // the client but returns defaults on the server, causing React hydration mismatches.
  // We defer rendering store-dependent content until the client has mounted, so the
  // server-rendered HTML and the initial client render are identical (both showing
  // a loading skeleton). The AuthProvider also guards this, but the Home component
  // itself reads the store directly, so we need our own guard here.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    // Use queueMicrotask to satisfy the lint rule about synchronous setState in effects,
    // while still setting mounted=true before the next paint.
    queueMicrotask(() => setMounted(true));
  }, []);

  // Native apps (Electron desktop / Capacitor mobile) skip the landing page —
  // they default directly to the login page since they don't need marketing
  // content. On mobile that is the customer-first shared sign-in (agency tab
  // available); on desktop it is the dedicated agency console login.
  useEffect(() => {
    if (!mounted) return;
    if (platform.isNative && !isAuthenticated && currentView === 'landing') {
      setView('login');
    }
  }, [mounted, platform.isNative, isAuthenticated, currentView, setView]);

  // Task 41 — rearm the boot gate whenever the session ends, so the next
  // login (or reload) shows the splash again. Login flips isAuthenticated
  // to true without touching bootReady — it starts false and the gate
  // releases it once the first sync settles.
  useEffect(() => {
    if (isAuthenticated) return;
    queueMicrotask(() => setBootReady(false));
  }, [isAuthenticated]);

  // Task 84 — once the shell is up and we know the role, warm the likely-next
  // view chunks during idle time (once per role per session). Warming is
  // deferred until bootReady so it never competes with the boot sync.
  const warmedBootRef = useRef(false);
  useEffect(() => {
    if (!bootReady || !user?.role) return;
    if (warmedBootRef.current) return;
    warmedBootRef.current = true;
    warmRoleViews(user.role);
  }, [bootReady, user?.role]);

  // Listen for onboarding trigger from register form
  useEffect(() => {
    const handleShowOnboarding = () => setShowOnboarding(true);
    window.addEventListener('blasti:show-onboarding', handleShowOnboarding);
    return () => window.removeEventListener('blasti:show-onboarding', handleShowOnboarding);
  }, []);

  // Show onboarding when the user enters the dashboard for the FIRST time.
  //  - Agency users: right after the agency-creation wizard completes (or on a
  //    later visit while the flag is still unset). It must NOT appear over the
  //    create-agency form itself, so the trigger is gated on user.agencyId
  //    being set.
  //  - Customers (Task 31-A): the wizard supports them (per-role welcome +
  //    customer tips) and they have no agency-creation step, so it fires on
  //    first entry as soon as they are logged in (no agencyId gate).
  // Both paths share the same `blasti-show-onboarding` localStorage flag and
  // the store's `onboarded` marker.
  useEffect(() => {
    if (!user?.id || onboarded) return;
    const isCustomer = user?.role === 'CUSTOMER';
    if (!isCustomer && !user?.agencyId) return;
    try {
      const dismissed = localStorage.getItem('blasti-show-onboarding');
      if (dismissed !== 'true') {
        // Use setTimeout to avoid synchronous state update during render
        setTimeout(() => setShowOnboarding(true), 800);
      }
    } catch { /* silent */ }
  }, [user?.id, user?.agencyId, user?.role, onboarded]);

  // Handle ?claim=TOKEN — auto-import walk-in reservation when QR is scanned externally
  useEffect(() => {
    if (!mounted) return;
    const params = new URLSearchParams(window.location.search);
    const claimToken = params.get('claim');
    if (!claimToken) return;

    const importWalkIn = async () => {
      try {
        const res = await apiFetch('/api/reservations/import-walk-in', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: claimToken }),
        });
        if (res.ok) {
          const data = await res.json();
          toast.success(t('walkInImported') || 'Reservation imported to your queue!');
          setView('customer-queue');
        } else {
          const data = await res.json();
          if (res.status === 401) {
            // Not logged in — store token for after login
            localStorage.setItem('blasti-pending-claim', claimToken);
            toast.info(t('loginToImport') || 'Please login to import this reservation.');
            setView('login');
          } else {
            toast.error(data.error || t('invalidTicket') || 'Invalid or expired ticket.');
          }
        }
      } catch {
        toast.error(t('error') || 'Something went wrong.');
      }
      // Clean URL
      window.history.replaceState({}, '', window.location.pathname);
    };

    if (isAuthenticated && user?.role === 'CUSTOMER') {
      importWalkIn();
    } else if (!isAuthenticated) {
      localStorage.setItem('blasti-pending-claim', claimToken);
      toast.info(t('loginToImport') || 'Please login to import this reservation.');
      setView('login');
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, [mounted, isAuthenticated, user?.role]);

  // After login, check for pending claim
  useEffect(() => {
    if (!isAuthenticated || user?.role !== 'CUSTOMER') return;
    const pending = localStorage.getItem('blasti-pending-claim');
    if (!pending) return;
    localStorage.removeItem('blasti-pending-claim');

    apiFetch('/api/reservations/import-walk-in', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: pending }),
    }).then(res => {
      if (res.ok) {
        toast.success(t('walkInImported') || 'Reservation imported to your queue!');
        setView('customer-queue');
      } else {
        toast.error(t('invalidTicket') || 'Invalid or expired ticket.');
      }
    }).catch(() => {});
  }, [isAuthenticated, user?.role]);

  // Fetch global announcements (cloud-only endpoint — skip when cloud is known-down)
  useEffect(() => {
    if (!user?.id) return;
    const fetchAnnouncements = async () => {
      // /api/admin/* is cloud-only. When cloud is unreachable, skip to avoid
      // ERR_CONNECTION_REFUSED noise. The announcements will load when cloud returns.
      if (typeof window !== 'undefined' && isApiUnreachable()) return;
      try {
        const res = await apiFetch('/api/admin/announcements');
        if (res.ok) {
          const data = await res.json();
          setGlobalAnnouncements(data.announcements ?? []);
        }
      } catch { /* silent */ }
    };
    fetchAnnouncements();
    const interval = setInterval(fetchAnnouncements, 60000);
    return () => clearInterval(interval);
  }, [user?.id]);

  // Load dismissed announcements from localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem('blasti-dismissed-announcements');
      if (stored) {
        const parsed = JSON.parse(stored);
        // Use setTimeout to avoid setState-in-effect lint warning
        setTimeout(() => setDismissedIds(new Set(parsed)), 0);
      }
    } catch { /* silent */ }
  }, []);

  const dismissAnnouncement = useCallback((id: string) => {
    setDismissedIds(prev => {
      const next = new Set(prev);
      next.add(id);
      localStorage.setItem('blasti-dismissed-announcements', JSON.stringify([...next]));
      return next;
    });
  }, []);

  // Dynamic document title based on current view
  useEffect(() => {
    const titles: Record<string, string> = {
      'landing': 'BLASTI - Smart Queue Management',
      'login': t('login') + ' - BLASTI',
      'register': t('register') + ' - BLASTI',
      'customer-home': t('home') + ' - BLASTI',
      'customer-queue': t('myQueue') + ' - BLASTI',
      'customer-history': t('history') + ' - BLASTI',
      'customer-profile': t('profile') + ' - BLASTI',
      'customer-notifications': t('notifications') + ' - BLASTI',
      'customer-favorites': t('favorites') + ' - BLASTI',
      'customer-analytics': t('myAnalytics.nav.title') + ' - BLASTI',
      'customer-support': t('supportDesk') + ' - BLASTI',
      'agency-dashboard': t('dashboard') + ' - BLASTI',
      'agency-settings': t('settings') + ' - BLASTI',
      'agency-profile': t('profile') + ' - BLASTI',
      'agency-subscription': t('subscription') + ' - BLASTI',
      'agency-devices': t('devicesConnection') + ' - BLASTI',
      'agency-analytics': t('analytics') + ' - BLASTI',
      'admin-dashboard': t('dashboard') + ' - BLASTI',
      'admin-transactions': t('transactions') + ' - BLASTI',
      'admin-agencies': t('agencies') + ' - BLASTI',
      'admin-audit': t('auditLogs') + ' - BLASTI',
      'admin-users': t('userManagement') + ' - BLASTI',
      'admin-analytics': t('analytics') + ' - BLASTI',
      'admin-tickets': t('supportTickets') + ' - BLASTI',
      'agency-support': t('supportDesk') + ' - BLASTI',
    'admin-settings': t('platformSettings') + ' - BLASTI',
    'admin-maps': t('adminMaps') + ' - BLASTI',
    'admin-subscription-plans': t('subscriptionPlans') + ' - BLASTI',
    'admin-app-settings': t('publicAppsSettings') + ' - BLASTI',
    };
    document.title = titles[currentView] || 'BLASTI';
  }, [currentView, t]);

  // Scroll to top on view change
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [currentView]);

  // Update document direction on language change
  useEffect(() => {
    updateDocumentDirection(lang);
  }, [lang]);

  // Initialize direction from localStorage on mount
  useEffect(() => {
    const stored = localStorage.getItem('blasti-lang') as Language | null;
    if (stored) {
      updateDocumentDirection(stored);
    } else {
      updateDocumentDirection('ar');
    }
    // Session validation is handled by AuthProvider — no need to duplicate here
  }, []);

  // Handle deep links: ?code=CLINIC01
  // Skip when device mode is active (URL has ?mode=device) — device mode handles its own params
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    // Don't interfere with device mode URLs
    if (params.get('mode') === 'device') return;
    const code = params.get('code');
    if (code) {
      setPendingAgencyCode(code);
      window.history.replaceState({}, '', window.location.pathname);
    }
    // Task 83-c — branch QR deep link: ?branch=<subCode> (encoded in every
    // branch QR code). Parked in sessionStorage until the user is
    // authenticated (QR scans land on logged-out browsers too); the effect
    // below resolves it into the branch profile view.
    const branchSubCode = params.get('branch');
    if (branchSubCode) {
      sessionStorage.setItem('blasti:pending-branch', branchSubCode);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, [setPendingAgencyCode]);

  // Task 83-c — resolve a parked ?branch=<subCode> deep link once the
  // customer is authenticated: sub-code → branch id → branch profile view.
  // Resolution failure (unknown/retired code) clears the park silently —
  // the user just lands on home.
  useEffect(() => {
    if (user?.role !== 'CUSTOMER') return;
    const pendingBranch = sessionStorage.getItem('blasti:pending-branch');
    if (!pendingBranch) return;
    sessionStorage.removeItem('blasti:pending-branch');
    let cancelled = false;
    apiFetch(`/api/agencies/branches/by-code/${encodeURIComponent(pendingBranch)}`)
      .then(async (res) => {
        if (!res.ok) return;
        const data = await res.json().catch(() => null);
        const branchId: string | undefined = data?.branch?.id;
        if (!branchId || cancelled) return;
        useAppStore.getState().setBranchProfileId(branchId);
        useAppStore.getState().setView('customer-branch-profile');
      })
      .catch(() => { /* deep-link best effort */ });
    return () => { cancelled = true; };
  }, [user?.role]);

  // When user is authenticated as customer and has pending agency code, navigate to customer-home
  // The customer-home component will pick up the code and auto-fetch agency detail
  useEffect(() => {
    if (user?.role === 'CUSTOMER' && pendingAgencyCode && currentView !== 'customer-home') {
      setView('customer-home');
    }
  }, [user?.role, pendingAgencyCode, currentView, setView]);

  const isUserAuthenticated = !!user;
  const isCustomer = user?.role === 'CUSTOMER';
  const isAgency = user?.role === 'AGENCY_STAFF' || user?.role === 'AGENCY_OWNER';
  const isAdmin = user?.role === 'SUPER_ADMIN';

  // Device mode: render fullscreen kiosk/TV without any chrome (no sidebar, no header)
  if (deviceMode) {
    return (
      <ErrorBoundary>
        <Suspense fallback={<BlastiSkeleton />}>
          {deviceMode === 'KIOSK' ? <DeviceKiosk /> : <DeviceTvBoard />}
        </Suspense>
      </ErrorBoundary>
    );
  }

  // Phase 6c: Hydration mismatch guard — render a loading skeleton until the
  // client has mounted and the store is hydrated. This ensures the server-rendered
  // output and the initial client render are identical (both showing a loading state),
  // preventing React hydration warnings. The AuthProvider also guards rehydration,
  // but the Home component itself reads the store directly.
  if (!mounted) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <BlastiSkeleton />
      </div>
    );
  }

  // Auth pages render full-screen with their own layouts
  const isAuthPage = currentView === 'landing' || currentView === 'login' || currentView === 'register';

  // Agency fullscreen mode bypasses sidebar + header
  if (currentView === 'agency-fullscreen' || currentView === 'agency-fullscreen-history') {
    return (
      <>
        <AnimatePresence mode="wait">
          <motion.div
            key={currentView}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
          >
            {currentView === 'agency-fullscreen' ? <AgencyFullscreen /> : <AgencyFullscreenHistory />}
          </motion.div>
        </AnimatePresence>
        <Toaster richColors position="top-center" />
      </>
    );
  }

  // Safety: if not authenticated but on a protected view, redirect to landing (web)
  // or login (native apps). This handles stale Zustand persisted state after page reload.
  if (!isAuthenticated && !isAuthPage) {
    const fallbackView = platform.isNative ? 'login' : 'landing';
    // Use setTimeout to avoid setState during render
    setTimeout(() => setView(fallbackView), 0);
    return (
      <>
        <AnimatePresence mode="wait">
          <motion.div
            key={fallbackView}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
          >
            {/* Desktop gets the dedicated agency login; the mobile shell gets
                the dedicated mobile sign-in (Task 78); web falls back to the
                landing page */}
            {fallbackView === 'login' ? (
              platform.isElectron ? <DesktopAgencyLogin /> : <MobileLoginForm />
            ) : <LandingPage />}
          </motion.div>
        </AnimatePresence>
        <Toaster richColors position="top-center" />
        <OfflineDiagnosisPanel
          open={showDiagnosis}
          onClose={() => setShowDiagnosis(false)}
          autoRun={showDiagnosis}
        />
      </>
    );
  }

  if (isAuthPage || !isAuthenticated) {
    return (
      <>
        <AnimatePresence mode="wait">
          <motion.div
            key={currentView}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
          >
            <ViewRouter />
          </motion.div>
        </AnimatePresence>
        <Toaster richColors position="top-center" />
        <OfflineDiagnosisPanel
          open={showDiagnosis}
          onClose={() => setShowDiagnosis(false)}
          autoRun={showDiagnosis}
        />
      </>
    );
  }

  // Task 41 — Boot splash: wait for the offline DB + the first real sync of
  // this session before mounting the authenticated shell. Replaces (not
  // overlays) the shell so dashboard screens cannot fire their fetches
  // mid-sync and flash "Failed to load data". Bounded — see boot-gate.tsx.
  if (!bootReady) {
    return <BootGate onDone={() => setBootReady(true)} />;
  }

  return (
    <PlatformFrame>
    <div className="min-h-screen flex bg-gray-50 dark:bg-gray-950" dir={isRTL(lang) ? 'rtl' : 'ltr'}>
      {/* Sidebar for agency/admin — adaptive to platform */}
      {isAgency && <AdaptiveAgencySidebar open={sidebarOpen} onClose={toggleSidebar} />}
      {isAdmin && <AdaptiveAdminSidebar open={sidebarOpen} onClose={toggleSidebar} />}

      {/* Main Content */}
      <main className={`flex-1 min-w-0 ${isAgency || isAdmin ? 'lg:ms-64' : ''}`}>
        {/* Connection status banner — shows when offline */}
        <ConnectionStatus />

        {/* Top bar for agency/admin */}
        {(isAgency || isAdmin) && (
          <header className="sticky top-0 z-30 h-16 bg-white/80 dark:bg-gray-950/80 backdrop-blur-xl border-b border-border flex items-center justify-between px-4">
            <Button variant="ghost" size="icon" className="lg:hidden h-10 w-10" onClick={toggleSidebar}>
              <Menu className="h-5 w-5" />
            </Button>
            {/* max-w + overflow-x: on narrow phones the 7 icon controls exceed the
                viewport and used to force page-wide horizontal overflow (Task 54-b
                mobile audit). They now shrink into a swipeable strip instead. */}
            <div className="flex items-center gap-2 ms-auto min-w-0 max-w-[calc(100vw-5.5rem)] overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <ConnectionDot />
              </span>
              {/* One-bell rule (field report): agency/admin get exactly ONE bell —
                  the rich NotificationCenter panel. The small NotificationBadge
                  popover was a duplicate bell next to it. */}
              <Suspense fallback={<BlastiSkeletonCompact />}>
                <NotificationCenter />
              </Suspense>
              <PlatformSwitcher />
              <PlatformBadge />
              <LanguageSwitcher />
              <ThemeToggle />
            </div>
          </header>
        )}

        {/* Customer navigation — platform-adaptive: Electron gets top tab bar, others get slim top strip + bottom nav.
            Task 79-a: the old chrome strip (NotificationBadge + NotificationCenter + PlatformSwitcher + LanguageSwitcher +
            ThemeToggle) that rendered here was REMOVED — the single bell + all controls now live inside CustomerNavigation. */}
        {isCustomer && (
          <CustomerNavigation />
        )}

        {/* Global Announcements Banner */}
        {isAuthenticated && globalAnnouncements.length > 0 && (
          <div className="px-4 pt-3">
            <AnimatePresence>
              {globalAnnouncements
                .filter(a => !dismissedIds.has(a.id))
                .slice(0, 3)
                .map((announcement) => (
                  <motion.div
                    key={announcement.id}
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{ duration: 0.3 }}
                    className="mb-2 last:mb-0"
                  >
                    <div className={`flex items-start gap-3 p-3 rounded-xl border backdrop-blur-sm ${
                      announcement.type === 'URGENT'
                        ? 'bg-rose-50 dark:bg-rose-900/10 border-rose-200/50 dark:border-rose-800/30'
                        : announcement.type === 'WARNING'
                        ? 'bg-amber-50 dark:bg-amber-900/10 border-amber-200/50 dark:border-amber-800/30'
                        : 'bg-emerald-50 dark:bg-emerald-900/10 border-emerald-200/50 dark:border-emerald-800/30'
                    }`}>
                      <div className={`h-9 w-9 rounded-lg flex items-center justify-center flex-shrink-0 ${
                        announcement.type === 'URGENT'
                          ? 'bg-rose-200 dark:bg-rose-900/30'
                          : announcement.type === 'WARNING'
                          ? 'bg-amber-200 dark:bg-amber-900/30'
                          : 'bg-emerald-200 dark:bg-emerald-900/30'
                      }`}>
                        <AlertTriangle className={`h-4 w-4 ${
                          announcement.type === 'URGENT'
                            ? 'text-rose-600 dark:text-rose-400'
                            : announcement.type === 'WARNING'
                            ? 'text-amber-600 dark:text-amber-400'
                            : 'text-emerald-600 dark:text-emerald-400'
                        }`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-foreground line-clamp-2">{announcement.message}</p>
                        <p className="text-[10px] text-muted-foreground mt-0.5">
                          {announcement.type === 'URGENT' ? t('announcementTypeUrgent') : announcement.type === 'WARNING' ? t('announcementTypeWarning') : t('announcementTypeInfo')}
                          {' · '}{new Date(announcement.createdAt).toLocaleDateString(lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US', { month: 'short', day: 'numeric' })}
                        </p>
                      </div>
                      <button
                        onClick={() => dismissAnnouncement(announcement.id)}
                        className="flex-shrink-0 h-7 w-7 flex items-center justify-center text-muted-foreground hover:text-foreground rounded-md hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
                        aria-label={t('dismiss')}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </motion.div>
                ))}
            </AnimatePresence>
          </div>
        )}

        {/* Page content — keyed CSS enter animation instead of
            AnimatePresence mode="wait": a lazy view suspending on FIRST
            navigation could leave the framer-motion enter animation stuck at
            opacity 0 (blank view until the next navigation). A plain CSS
            animation cannot get stuck — it always plays to completion. */}
        <div className={isCustomer ? 'pt-2' : ''}>
          <div key={currentView} className="blasti-view-enter">
            <ViewRouter />
          </div>
        </div>

        {/* Customer bottom nav is handled by CustomerNavigation above */}
      </main>

      <Toaster richColors position="top-center" />

      {/* Task 46: Post-login initial-sync loading gate — holds the UI on a
          branded progress screen until the desktop workspace import is done
          (Electron only, only when the workspace is not READY yet). */}
      <PostLoginSyncGate />

      {/* Task 81 — biometric app lock: when "ask for biometrics every time
          the app opens" is enabled and the account is active, this full-
          screen gate challenges biometrics on launch/background-return. */}
      <BiometricAppLock />

      {/* Aggressive Turn Alert — full-screen overlay for customers */}
      <AggressiveTurnAlert
        visible={showTurnAlert}
        ticketNumber={turnAlertData?.ticketNumber || ''}
        agencyName={turnAlertData?.agencyName || ''}
        onDismiss={dismissTurnAlert}
      />

      {/* Offline Diagnosis Panel — auto-shown when cloud goes down in Electron */}
      <OfflineDiagnosisPanel
        open={showDiagnosis}
        onClose={() => setShowDiagnosis(false)}
        autoRun={showDiagnosis}
      />

      {/* Onboarding Wizard — lazy loaded */}
      {showOnboarding && user && (
        <Suspense fallback={null}>
          <OnboardingWizard
          open={showOnboarding}
          user={user}
          onComplete={async (prefs) => {
            try {
              const res = await apiFetch('/api/user/profile', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  ...(prefs.language ? { language: prefs.language } : {}),
                  ...(prefs.reminderMinutes != null ? { reminderMinutes: prefs.reminderMinutes } : {}),
                  ...(prefs.smsNotificationsEnabled != null ? { smsNotificationsEnabled: prefs.smsNotificationsEnabled } : {}),
                }),
              });
              if (res.ok) {
                toast.success(t('preferencesSaved'));
              }
            } catch {
              // silent
            }
            setOnboarded(true);
            try { localStorage.setItem('blasti-show-onboarding', 'true'); } catch { /* silent */ }
            setShowOnboarding(false);
          }}
          onSkip={() => {
            setShowOnboarding(false);
            setOnboarded(true);
            try { localStorage.setItem('blasti-show-onboarding', 'true'); } catch { /* silent */ }
            toast.info(t('onboardingSkipped'));
          }}
        />
        </Suspense>
      )}

      {/* Dark mode toggle is available in the header (ThemeToggle) — removed the extra floating button. */}

      {/* E2E Queue Test Panel removed */}
    </div>
    </PlatformFrame>
  );
}
