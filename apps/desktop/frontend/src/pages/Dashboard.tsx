import { useCallback } from 'react';
import {
  Users,
  Clock,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ArrowRight,
  Loader2,
} from 'lucide-react';
import api from '@/api/client';
import { usePolling } from '@/hooks/use-api';
import StatsCard from '@/components/shared/stats-card';
import SyncIndicator from '@/components/shared/sync-indicator';
import { formatTime, getStatusBgColor } from '@/lib/utils';

interface QueueEntry {
  id: string;
  ticketNumber: string;
  customerName?: string;
  serviceName?: string;
  status: string;
  position?: number;
  createdAt?: string;
  calledAt?: string;
  estimatedWaitMinutes?: number;
}

interface Stats {
  totalToday?: number;
  waiting?: number;
  serving?: number;
  completed?: number;
  cancelled?: number;
  noShows?: number;
  avgWaitMinutes?: number;
}

export default function Dashboard() {
  const fetchStats = useCallback(() => api.getStats(), []);
  const fetchQueue = useCallback(() => api.getQueue(), []);

  const { data: statsData, isLoading: statsLoading } = usePolling(
    fetchStats, 10000
  );
  const { data: queueData, isLoading: queueLoading } = usePolling(
    fetchQueue, 3000
  );

  const stats = (statsData?.stats || statsData?.data || statsData || {}) as Stats;
  const queue = ((queueData?.queue || queueData?.reservations || queueData?.data || []) as QueueEntry[]) || [];
  const waiting = queue.filter((r) => r.status === 'WAITING');
  const called = queue.filter((r) => r.status === 'CALLED' || r.status === 'SERVING');

  const handleCallNext = async () => {
    try {
      await api.callNext();
    } catch {
      // Failed to call next
    }
  };

  const handleComplete = async (id: string) => {
    try {
      await api.completeReservation(id);
    } catch {
      // Failed to complete
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Dashboard</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <SyncIndicator />
          <button
            onClick={handleCallNext}
            disabled={waiting.length === 0}
            className="px-4 py-2 rounded-lg bg-emerald-500 text-white text-sm font-medium hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center gap-2"
          >
            <ArrowRight className="w-4 h-4" />
            Call Next
          </button>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatsCard
          label="Waiting"
          value={stats.waiting ?? waiting.length}
          icon={Clock}
          className="border-amber-500/20"
        />
        <StatsCard
          label="Serving"
          value={stats.serving ?? called.length}
          icon={Users}
          className="border-blue-500/20"
        />
        <StatsCard
          label="Completed"
          value={stats.completed ?? 0}
          icon={CheckCircle2}
          className="border-emerald-500/20"
        />
        <StatsCard
          label="No Shows"
          value={stats.noShows ?? 0}
          icon={AlertTriangle}
          className="border-orange-500/20"
        />
      </div>

      {/* Queue Sections */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Currently Serving */}
        <div className="rounded-xl border border-border bg-card">
          <div className="px-4 py-3 border-b border-border">
            <h2 className="text-sm font-semibold text-foreground">Currently Serving</h2>
          </div>
          <div className="p-4 space-y-2 max-h-80 overflow-y-auto">
            {(queueLoading && !queueData) ? (
              <div className="flex items-center justify-center py-8 text-muted-foreground">
                <Loader2 className="w-5 h-5 animate-spin" />
              </div>
            ) : called.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">
                No one being served
              </p>
            ) : (
              called.map((entry) => (
                <div
                  key={entry.id}
                  className="flex items-center gap-3 p-3 rounded-lg bg-muted/50"
                >
                  <div className="w-10 h-10 rounded-lg bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold text-sm">
                    {entry.ticketNumber || '--'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">
                      {entry.customerName || 'Walk-in'}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {entry.serviceName || 'General'} • Since {formatTime(entry.calledAt)}
                    </p>
                  </div>
                  <button
                    onClick={() => handleComplete(entry.id)}
                    className="px-3 py-1.5 rounded-md bg-emerald-500/20 text-emerald-400 text-xs font-medium hover:bg-emerald-500/30 transition-colors"
                  >
                    Complete
                  </button>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Waiting Queue */}
        <div className="rounded-xl border border-border bg-card">
          <div className="px-4 py-3 border-b border-border flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">Waiting Queue</h2>
            <span className="text-xs text-muted-foreground">{waiting.length} waiting</span>
          </div>
          <div className="p-4 space-y-2 max-h-80 overflow-y-auto">
            {(queueLoading && !queueData) ? (
              <div className="flex items-center justify-center py-8 text-muted-foreground">
                <Loader2 className="w-5 h-5 animate-spin" />
              </div>
            ) : waiting.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">
                Queue is empty
              </p>
            ) : (
              waiting.map((entry, i) => (
                <div
                  key={entry.id}
                  className="flex items-center gap-3 p-3 rounded-lg hover:bg-muted/30 transition-colors"
                >
                  <div className="w-8 h-8 rounded-lg bg-amber-500/20 text-amber-400 flex items-center justify-center font-bold text-xs">
                    #{i + 1}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">
                      {entry.customerName || entry.ticketNumber || 'Walk-in'}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {entry.serviceName || 'General'} • {formatTime(entry.createdAt)}
                    </p>
                  </div>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${getStatusBgColor(entry.status)}`}>
                    {entry.status}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
