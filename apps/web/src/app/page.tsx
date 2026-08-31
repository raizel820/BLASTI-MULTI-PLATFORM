'use client';

import { useEffect, useState, lazy, Suspense, memo, useCallback } from 'react';
import { useAppStore, updateDocumentDirection } from '@/store/use-app-store';
import { useLanguage } from '@/hooks/use-language';
import { isRTL, type Language } from '@/i18n';
import { getProxiedUrl } from '@/lib/utils';
import { apiFetch } from '@/lib/api-fetch';
import { isApiUnreachable } from '@/lib/api-client';

// Auth Views — lazy loaded to reduce initial compilation footprint
const LandingPage = lazy(() => import('@/components/auth/landing-page').then(m => ({ default: m.LandingPage })));
const LoginForm = lazy(() => import('@/components/auth/login-form').then(m => ({ default: m.LoginForm })));
const RegisterForm = lazy(() => import('@/components/auth/register-form').then(m => ({ default: m.RegisterForm })));

// Customer Views
const CustomerHome = lazy(() => import('@/components/customer/customer-home').then(m => ({ default: m.CustomerHome })));
const CustomerQueue = lazy(() => import('@/components/customer/customer-queue').then(m => ({ default: m.CustomerQueue })));
const CustomerHistory = lazy(() => import('@/components/customer/customer-history').then(m => ({ default: m.CustomerHistory })));
const CustomerProfile = lazy(() => import('@/components/customer/customer-profile').then(m => ({ default: m.CustomerProfile })));
const CustomerNotifications = lazy(() => import('@/components/customer/customer-notifications').then(m => ({ default: m.CustomerNotifications })));
const CustomerFavorites = lazy(() => import('@/components/customer/customer-favorites').then(m => ({ default: m.CustomerFavorites })));
const CustomerSettings = lazy(() => import('@/components/customer/customer-settings').then(m => ({ default: m.CustomerSettings })));

// Agency Views
const AgencyDashboard = lazy(() => import('@/components/agency/agency-dashboard').then(m => ({ default: m.AgencyDashboard })));
const AgencySettings = lazy(() => import('@/components/agency/agency-settings').then(m => ({ default: m.AgencySettings })));
const AgencyProfile = lazy(() => import('@/components/agency/agency-profile').then(m => ({ default: m.AgencyProfile })));
const AgencySubscription = lazy(() => import('@/components/agency/agency-subscription').then(m => ({ default: m.AgencySubscription })));
const AgencyReviews = lazy(() => import('@/components/agency/agency-reviews').then(m => ({ default: m.AgencyReviews })));
const AgencyEmployees = lazy(() => import('@/components/agency/agency-employees').then(m => ({ default: m.AgencyEmployees })));
const AgencyBranches = lazy(() => import('@/components/agency/agency-branches').then(m => ({ default: m.AgencyBranches })));
const AgencyDevices = lazy(() => import('@/components/agency/agency-devices').then(m => ({ default: m.AgencyDevices })));
const AgencyFullscreen = lazy(() => import('@/components/agency/agency-fullscreen').then(m => ({ default: m.AgencyFullscreen })));
const AgencyFullscreenHistory = lazy(() => import('@/components/agency/agency-fullscreen-history').then(m => ({ default: m.AgencyFullscreenHistory })));
// Device Views (standalone kiosk, TV board — accessed via ?mode=device&type=KIOSK|TV)
const DeviceKiosk = lazy(() => import('@/components/devices/device-kiosk').then(m => ({ default: m.DeviceKiosk })));
const DeviceTvBoard = lazy(() => import('@/components/devices/device-tv-board').then(m => ({ default: m.DeviceTvBoard })));

// Admin Views
const AdminDashboard = lazy(() => import('@/components/admin/admin-dashboard').then(m => ({ default: m.AdminDashboard })));
const AdminTransactions = lazy(() => import('@/components/admin/admin-transactions').then(m => ({ default: m.AdminTransactions })));
const AdminAgencies = lazy(() => import('@/components/admin/admin-agencies').then(m => ({ default: m.AdminAgencies })));
const AdminAuditLogs = lazy(() => import('@/components/admin/admin-audit-logs').then(m => ({ default: m.AdminAuditLogs })));
const AdminUsers = lazy(() => import('@/components/admin/admin-users').then(m => ({ default: m.AdminUsers })));
const AdminAnalytics = lazy(() => import('@/components/admin/admin-analytics').then(m => ({ default: m.AdminAnalytics })));
const AdminSettings = lazy(() => import('@/components/admin/admin-settings').then(m => ({ default: m.AdminSettings })));
const AdminSubscriptionPlans = lazy(() => import('@/components/admin/admin-subscription-plans').then(m => ({ default: m.AdminSubscriptionPlans })));
const AdminAppSettings = lazy(() => import('@/components/admin/admin-app-settings').then(m => ({ default: m.AdminAppSettings })));
const AdminHardware = lazy(() => import('@/components/admin/admin-hardware').then(m => ({ default: m.AdminHardware })));
const AdminHardwareRequests = lazy(() => import('@/components/admin/admin-hardware-requests').then(m => ({ default: m.AdminHardwareRequests })));
const AdminEnterpriseRequests = lazy(() => import('@/components/admin/admin-enterprise-requests').then(m => ({ default: m.AdminEnterpriseRequests })));

// Shared (eagerly imported — lightweight)
import { ErrorBoundary } from '@/components/shared/error-boundary';
import { LanguageSwitcher } from '@/components/shared/language-switcher';
import { ThemeToggle } from '@/components/shared/theme-toggle';
import { PlatformSwitcher } from '@/components/shared/platform-switcher';
import { PlatformBadge } from '@/components/shared/platform-badge';
import { ConnectionStatus, ConnectionDot, onCloudStatusChange } from '@/components/shared/connection-status';
import { OfflineDiagnosisPanel } from '@/components/shared/offline-diagnosis-panel';
import { NotificationBadge } from '@/components/shared/notification-badge';
import { BlastiSkeleton, BlastiSkeletonCompact } from '@/components/shared/blasti-skeleton';
import { usePlatform } from '@/hooks/use-platform';
import { Button } from '@/components/ui/button';

// Shared (lazy loaded — heavy components that are conditionally rendered)
const OnboardingWizard = lazy(() => import('@/components/shared/onboarding-wizard').then(m => ({ default: m.OnboardingWizard })));
const NotificationCenter = lazy(() => import('@/components/shared/NotificationCenter').then(m => ({ default: m.NotificationCenter })));
// QueueE2ETestPanel removed — test button no longer needed

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

  return (
    <ErrorBoundary>
      <Suspense fallback={<ViewSpinner />}>
        {(() => {
          switch (currentView) {
            case 'landing':
              return <LandingPage />;
            case 'login':
              return <LoginForm />;
            case 'register':
              return <RegisterForm />;
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
            case 'agency-dashboard':
              return <AgencyDashboard />;
            case 'agency-settings':
              return <AgencySettings />;
            case 'agency-profile':
              return <AgencyProfile />;
            case 'agency-subscription':
              return <AgencySubscription />;
            case 'agency-reviews':
              return <AgencyReviews />;
            case 'agency-employees':
              return <AgencyEmployees />;
            case 'agency-branches':
              return <AgencyBranches />;
            case 'agency-devices':
              return <AgencyDevices />;
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
            case 'admin-settings':
              return <AdminSettings />;
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
  // Aggressive turn alert — full-screen overlay when customer's turn is called
  // Hook is always called (rules of hooks) but only activates for customers via userId filtering
  const { showTurnAlert, turnAlertData, dismissTurnAlert } = useTurnAlert(user?.role === 'CUSTOMER' ? user?.id : undefined);

  const [showDiagnosis, setShowDiagnosis] = useState(false);
  const [globalAnnouncements, setGlobalAnnouncements] = useState<Array<{ id: string; message: string; type: string; createdAt: string }>>([]);
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const [showOnboarding, setShowOnboarding] = useState(false);

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
  // they default directly to the login page since they don't need marketing content.
  useEffect(() => {
    if (!mounted) return;
    if (platform.isNative && !isAuthenticated && currentView === 'landing') {
      setView('login');
    }
  }, [mounted, platform.isNative, isAuthenticated, currentView, setView]);

  // Listen for onboarding trigger from register form
  useEffect(() => {
    const handleShowOnboarding = () => setShowOnboarding(true);
    window.addEventListener('blasti:show-onboarding', handleShowOnboarding);
    return () => window.removeEventListener('blasti:show-onboarding', handleShowOnboarding);
  }, []);

  // Show onboarding for first-time logins (check localStorage key: blasti-show-onboarding)
  useEffect(() => {
    if (user?.id && !onboarded) {
      try {
        const dismissed = localStorage.getItem('blasti-show-onboarding');
        if (dismissed !== 'true') {
          // Use setTimeout to avoid synchronous state update during render
          setTimeout(() => setShowOnboarding(true), 800);
        }
      } catch { /* silent */ }
    }
  }, [user?.id, onboarded]);

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
      'agency-dashboard': t('dashboard') + ' - BLASTI',
      'agency-settings': t('settings') + ' - BLASTI',
      'agency-profile': t('profile') + ' - BLASTI',
      'agency-subscription': t('subscription') + ' - BLASTI',
      'agency-devices': t('devicesConnection') + ' - BLASTI',
      'admin-dashboard': t('dashboard') + ' - BLASTI',
      'admin-transactions': t('transactions') + ' - BLASTI',
      'admin-agencies': t('agencies') + ' - BLASTI',
      'admin-audit': t('auditLogs') + ' - BLASTI',
      'admin-users': t('userManagement') + ' - BLASTI',
      'admin-analytics': t('analytics') + ' - BLASTI',
    'admin-settings': t('platformSettings') + ' - BLASTI',
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
  }, [setPendingAgencyCode]);

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
            {fallbackView === 'login' ? <LoginForm /> : <LandingPage />}
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
            <div className="flex items-center gap-2 ms-auto">
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <ConnectionDot />
              </span>
              <NotificationBadge variant="agency" />
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

        {/* Customer navigation — platform-adaptive: Electron gets top tab bar, others get header + bottom nav */}
        {isCustomer && (
          <CustomerNavigation />
        )}

        {/* Language & theme controls for customer — always shown */}
        {isCustomer && (
          <div className="flex items-center justify-end px-4 py-1.5 bg-white/60 dark:bg-gray-950/60">
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <ConnectionDot />
              </span>
              <NotificationBadge variant="customer" />
              <Suspense fallback={<BlastiSkeletonCompact />}>
                <NotificationCenter />
              </Suspense>
              <PlatformSwitcher />
              <LanguageSwitcher />
              <ThemeToggle />
            </div>
          </div>
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

        {/* Page content */}
        <div className={isCustomer ? 'pt-2' : ''}>
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
        </div>

        {/* Customer bottom nav is handled by CustomerNavigation above */}
      </main>

      <Toaster richColors position="top-center" />

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
