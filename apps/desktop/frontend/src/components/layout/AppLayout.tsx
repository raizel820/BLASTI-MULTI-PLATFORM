import { Outlet, Navigate } from 'react-router-dom';
import { useAuth } from '@/stores/auth';
import Sidebar from './Sidebar';
import { Toaster } from 'sonner';

export default function AppLayout() {
  const { isAuthenticated } = useAuth();

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return (
    <div className="flex h-screen bg-background">
      <Sidebar />
      <main className="flex-1 overflow-y-auto">
        <div className="p-6">
          <Outlet />
        </div>
      </main>
      <Toaster position="top-center" richColors closeButton />
    </div>
  );
}
