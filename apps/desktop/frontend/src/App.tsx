import { useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from '@/stores/auth';
import AppLayout from '@/components/layout/AppLayout';
import Login from '@/pages/Login';
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

export default function App() {
  const { isAuthenticated, restoreSession } = useAuth();

  // Restore session from localStorage on mount
  useEffect(() => {
    restoreSession();
  }, [restoreSession]);

  return (
    <Routes>
      {/* Login - accessible when not authenticated */}
      <Route
        path="/login"
        element={isAuthenticated ? <Navigate to="/" replace /> : <Login />}
      />

      {/* Authenticated routes - wrapped in AppLayout with sidebar */}
      <Route element={<AppLayout />}>
        <Route path="/" element={<Dashboard />} />
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
      </Route>

      {/* Catch-all */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
