import { useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from '@/stores/auth';
import AppLayout from '@/components/layout/AppLayout';
import Login from '@/pages/Login';
import InitialSync from '@/pages/InitialSync';
import Dashboard from '@/pages/Dashboard';
import Queue from '@/pages/Queue';
import Services from '@/pages/Services';
import Branches from '@/pages/Branches';
import Staff from '@/pages/Staff';
import History from '@/pages/History';
import Settings from '@/pages/Settings';
import Reviews from '@/pages/Reviews';
import Notifications from '@/pages/Notifications';
import Analytics from '@/pages/Analytics';
import QrCode from '@/pages/QrCode';
import Subscription from '@/pages/Subscription';
import Profile from '@/pages/Profile';
import { AgencyFullscreen } from '@/components/agency/agency-fullscreen';
import { AgencyFullscreenHistory } from '@/components/agency/agency-fullscreen-history';

export default function App() {
  const { isAuthenticated, needsInitialSync, initialSyncChecked, restoreSession, checkInitialSync } = useAuth();

  // Restore session from localStorage on mount
  useEffect(() => {
    restoreSession();
  }, [restoreSession]);

  // After session is restored and authenticated, check for initial sync
  useEffect(() => {
    if (isAuthenticated && !initialSyncChecked) {
      checkInitialSync();
    }
  }, [isAuthenticated, initialSyncChecked, checkInitialSync]);

  // If authenticated but needs initial sync, redirect to /initial-sync
  // This is handled via routing below

  return (
    <Routes>
      {/* Login - accessible when not authenticated */}
      <Route
        path="/login"
        element={isAuthenticated ? <Navigate to="/" replace /> : <Login />}
      />

      {/* Initial Sync - shown when authenticated but first-time on this machine */}
      <Route
        path="/initial-sync"
        element={
          isAuthenticated
            ? (needsInitialSync ? <InitialSync /> : <Navigate to="/" replace />)
            : <Navigate to="/login" replace />
        }
      />

      {/* Fullscreen routes - no sidebar */}
      <Route path="/fullscreen" element={<AgencyFullscreen />} />
      <Route path="/fullscreen/history" element={<AgencyFullscreenHistory />} />

      {/* Authenticated routes - wrapped in AppLayout with sidebar */}
      <Route element={<AppLayout />}>
        <Route
          path="/"
          element={
            isAuthenticated && needsInitialSync
              ? <Navigate to="/initial-sync" replace />
              : <Dashboard />
          }
        />
        <Route path="/queue" element={<Queue />} />
        <Route path="/services" element={<Services />} />
        <Route path="/branches" element={<Branches />} />
        <Route path="/staff" element={<Staff />} />
        <Route path="/history" element={<History />} />
        <Route path="/analytics" element={<Analytics />} />
        <Route path="/qr-code" element={<QrCode />} />
        <Route path="/subscription" element={<Subscription />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/reviews" element={<Reviews />} />
        <Route path="/notifications" element={<Notifications />} />
        <Route path="/profile" element={<Profile />} />
      </Route>

      {/* Catch-all */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
