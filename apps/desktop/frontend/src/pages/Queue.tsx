import { useCallback, useState } from 'react';
import {
  ArrowRight,
  Check,
  X,
  AlertTriangle,
  RotateCcw,
  Clock,
  Loader2,
  Plus,
} from 'lucide-react';
import api from '@/api/client';
import { usePolling } from '@/hooks/use-api';
import { useKeyboard } from '@/hooks/use-keyboard';
import { formatTime, getStatusBgColor, formatWaitTime } from '@/lib/utils';

interface Reservation {
  id: string;
  ticketNumber: string;
  customerName?: string;
  serviceName?: string;
  status: string;
  position?: number;
  createdAt?: string;
  calledAt?: string;
  estimatedWaitMinutes?: number;
  counterName?: string;
}

export default function QueuePage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showJoinDialog, setShowJoinDialog] = useState(false);
  const [joinName, setJoinName] = useState('');
  const [joinService, setJoinService] = useState('');

  const fetchQueue = useCallback(() => api.getQueue(), []);
  const { data: queueData, isLoading, refetch } = usePolling(
    fetchQueue, 2000
  );

  const reservations = ((queueData?.queue || queueData?.reservations || queueData?.data || []) as Reservation[]) || [];
  const waiting = reservations.filter((r) => r.status === 'WAITING');
  const active = reservations.filter((r) => ['CALLED', 'SERVING'].includes(r.status));
  const completed = reservations.filter((r) => ['COMPLETED', 'CANCELLED', 'NO_SHOW'].includes(r.status));

  // Keyboard shortcuts
  useKeyboard([
    { key: 'n', ctrl: true, handler: () => handleCallNext(), description: 'Call next' },
    { key: 'j', ctrl: true, handler: () => setShowJoinDialog(true), description: 'Join queue' },
  ]);

  const handleCallNext = async () => {
    try {
      await api.callNext();
      refetch();
    } catch { /* */ }
  };

  const handleAction = async (id: string, action: 'call' | 'complete' | 'noshow' | 'cancel' | 'recall') => {
    try {
      switch (action) {
        case 'call': await api.callReservation(id); break;
        case 'complete': await api.completeReservation(id); break;
        case 'noshow': await api.noShowReservation(id); break;
        case 'cancel': await api.cancelReservation(id); break;
        case 'recall': await api.recallReservation(id); break;
      }
      refetch();
    } catch { /* */ }
  };

  const handleJoin = async () => {
    try {
      await api.joinQueue({
        customerName: joinName || undefined,
        serviceName: joinService || undefined,
      });
      setShowJoinDialog(false);
      setJoinName('');
      setJoinService('');
      refetch();
    } catch { /* */ }
  };

  const TicketCard = ({ r, showActions }: { r: Reservation; showActions?: boolean }) => (
    <div
      onClick={() => setSelectedId(r.id)}
      className={`flex items-center gap-3 p-3 rounded-lg border transition-all cursor-pointer ${
        selectedId === r.id
          ? 'border-primary bg-primary/5'
          : 'border-transparent hover:bg-muted/30'
      }`}
    >
      <div className={`w-12 h-12 rounded-lg flex flex-col items-center justify-center font-bold text-sm ${
        r.status === 'WAITING' ? 'bg-amber-500/20 text-amber-400' :
        r.status === 'CALLED' ? 'bg-blue-500/20 text-blue-400' :
        r.status === 'SERVING' ? 'bg-emerald-500/20 text-emerald-400' :
        'bg-muted text-muted-foreground'
      }`}>
        <span className="text-[9px] font-normal opacity-60">
          {r.status === 'WAITING' ? 'WAIT' : r.status.charAt(0)}
        </span>
        {r.ticketNumber || '--'}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground truncate">
          {r.customerName || 'Walk-in'}
        </p>
        <p className="text-xs text-muted-foreground">
          {r.serviceName || 'General'}
          {r.counterName && ` • ${r.counterName}`}
          {' • '}
          {formatTime(r.createdAt)}
        </p>
      </div>
      <span className={`text-xs px-2 py-0.5 rounded-full ${getStatusBgColor(r.status)}`}>
        {r.status.replace('_', ' ')}
      </span>
      {showActions && (
        <div className="flex items-center gap-1">
          {r.status === 'WAITING' && (
            <button onClick={(e) => { e.stopPropagation(); handleAction(r.id, 'call'); }}
              className="p-1.5 rounded-md hover:bg-blue-500/20 text-blue-400 transition-colors" title="Call">
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          )}
          {['CALLED', 'SERVING'].includes(r.status) && (
            <>
              <button onClick={(e) => { e.stopPropagation(); handleAction(r.id, 'complete'); }}
                className="p-1.5 rounded-md hover:bg-emerald-500/20 text-emerald-400 transition-colors" title="Complete">
                <Check className="w-3.5 h-3.5" />
              </button>
              <button onClick={(e) => { e.stopPropagation(); handleAction(r.id, 'recall'); }}
                className="p-1.5 rounded-md hover:bg-blue-500/20 text-blue-400 transition-colors" title="Recall">
                <RotateCcw className="w-3.5 h-3.5" />
              </button>
            </>
          )}
          {r.status === 'WAITING' && (
            <>
              <button onClick={(e) => { e.stopPropagation(); handleAction(r.id, 'noshow'); }}
                className="p-1.5 rounded-md hover:bg-orange-500/20 text-orange-400 transition-colors" title="No Show">
                <AlertTriangle className="w-3.5 h-3.5" />
              </button>
              <button onClick={(e) => { e.stopPropagation(); handleAction(r.id, 'cancel'); }}
                className="p-1.5 rounded-md hover:bg-red-500/20 text-red-400 transition-colors" title="Cancel">
                <X className="w-3.5 h-3.5" />
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Queue</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Manage your queue in real-time
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={() => setShowJoinDialog(true)}
            className="px-3 py-2 rounded-lg border border-border text-sm font-medium text-foreground hover:bg-accent transition-colors flex items-center gap-2">
            <Plus className="w-4 h-4" /> Walk-in
          </button>
          <button onClick={handleCallNext} disabled={waiting.length === 0}
            className="px-4 py-2 rounded-lg bg-emerald-500 text-white text-sm font-medium hover:bg-emerald-600 disabled:opacity-50 transition-all flex items-center gap-2">
            <ArrowRight className="w-4 h-4" /> Call Next
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Active (Called/Serving) */}
        <div className="rounded-xl border border-border bg-card">
          <div className="px-4 py-3 border-b border-border flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <Clock className="w-4 h-4 text-blue-400" /> Active
            </h2>
            <span className="text-xs bg-blue-500/20 text-blue-400 px-2 py-0.5 rounded-full">{active.length}</span>
          </div>
          <div className="p-3 space-y-1 max-h-96 overflow-y-auto">
            {active.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">No active tickets</p>
            ) : active.map((r) => <TicketCard key={r.id} r={r} showActions />)}
          </div>
        </div>

        {/* Waiting */}
        <div className="rounded-xl border border-border bg-card">
          <div className="px-4 py-3 border-b border-border flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <Clock className="w-4 h-4 text-amber-400" /> Waiting
            </h2>
            <span className="text-xs bg-amber-500/20 text-amber-400 px-2 py-0.5 rounded-full">{waiting.length}</span>
          </div>
          <div className="p-3 space-y-1 max-h-96 overflow-y-auto">
            {waiting.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">Queue is empty</p>
            ) : waiting.map((r) => <TicketCard key={r.id} r={r} showActions />)}
          </div>
        </div>

        {/* Completed / Done */}
        <div className="rounded-xl border border-border bg-card">
          <div className="px-4 py-3 border-b border-border flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">Done Today</h2>
            <span className="text-xs text-muted-foreground">{completed.length}</span>
          </div>
          <div className="p-3 space-y-1 max-h-96 overflow-y-auto">
            {completed.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">No completed tickets</p>
            ) : completed.slice(0, 20).map((r) => <TicketCard key={r.id} r={r} />)}
          </div>
        </div>
      </div>

      {/* Join Dialog */}
      {showJoinDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowJoinDialog(false)}>
          <div className="bg-card rounded-xl border border-border p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold text-foreground mb-4">Add Walk-in</h2>
            <div className="space-y-3">
              <input value={joinName} onChange={(e) => setJoinName(e.target.value)}
                placeholder="Customer name (optional)"
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring" />
              <input value={joinService} onChange={(e) => setJoinService(e.target.value)}
                placeholder="Service (optional)"
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring" />
            </div>
            <div className="flex gap-3 mt-5">
              <button onClick={() => setShowJoinDialog(false)}
                className="flex-1 py-2 rounded-lg border border-border text-sm font-medium text-foreground hover:bg-accent transition-colors">
                Cancel
              </button>
              <button onClick={handleJoin}
                className="flex-1 py-2 rounded-lg bg-emerald-500 text-white text-sm font-medium hover:bg-emerald-600 transition-colors">
                Add to Queue
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
