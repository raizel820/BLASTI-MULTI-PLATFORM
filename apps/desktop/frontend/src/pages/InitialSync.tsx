import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/stores/auth';
import { Progress } from '@/components/ui/progress';
import {
  CheckCircle2,
  Circle,
  Loader2,
  Wifi,
  WifiOff,
  AlertCircle,
  RefreshCw,
  Database,
  ArrowRight,
} from 'lucide-react';

// ─── Types ───────────────────────────────────────────────────────────────────

interface StageInfo {
  id: string;
  label: string;
  status: 'pending' | 'in_progress' | 'completed' | 'error';
  current?: number;
  total?: number;
  percentage?: number;
  count?: number;
  error?: string;
  mandatory?: boolean;
}

interface SyncEvent {
  type: string;
  stage?: string;
  stageLabel?: string;
  stageIndex?: number;
  totalStages?: number;
  current?: number;
  total?: number;
  percentage?: number;
  count?: number;
  error?: string;
  retryable?: boolean;
  skipped?: boolean;
  agencyId?: string;
  syncId?: string;
  totalRecords?: number;
  duration?: number;
  alreadyInitialized?: boolean;
}

// Stage definitions matching the backend
const STAGE_DEFINITIONS = [
  { id: 'agency',        label: 'Agency Profile' },
  { id: 'users',         label: 'Users & Staff' },
  { id: 'services',      label: 'Services' },
  { id: 'branches',      label: 'Branches' },
  { id: 'counters',      label: 'Counters' },
  { id: 'agencyStaff',   label: 'Staff Assignments' },
  { id: 'queueSettings', label: 'Queue Settings' },
  { id: 'reservations',  label: 'Reservations' },
  { id: 'reviews',       label: 'Reviews' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'announcements', label: 'Announcements' },
  { id: 'transactions',  label: 'Transactions' },
  { id: 'other',         label: 'Other Data' },
];

// ─── API helpers ─────────────────────────────────────────────────────────────

const isDevServer =
  typeof window !== 'undefined' &&
  (window.location.port === '5173' || window.location.port === '3000');
const LOCAL_API_BASE = isDevServer ? '' : 'http://127.0.0.1:3080';

async function apiFetch(path: string, options: RequestInit = {}) {
  const token = localStorage.getItem('blasti-local-api-token');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.headers as Record<string, string> || {}),
  };
  const res = await fetch(`${LOCAL_API_BASE}${path}`, { ...options, headers });
  return res;
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function InitialSync() {
  const navigate = useNavigate();
  const { user, token } = useAuth();
  const [stages, setStages] = useState<StageInfo[]>(
    STAGE_DEFINITIONS.map(s => ({ id: s.id, label: s.label, status: 'pending', mandatory: ['agency', 'users', 'services', 'branches', 'counters', 'agencyStaff', 'queueSettings', 'reservations'].includes(s.id) }))
  );
  const [overallProgress, setOverallProgress] = useState(0);
  const [currentStageLabel, setCurrentStageLabel] = useState('Preparing...');
  const [isOnline, setIsOnline] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncCompleted, setSyncCompleted] = useState(false);
  const [totalRecords, setTotalRecords] = useState(0);
  const [duration, setDuration] = useState(0);
  const socketRef = useRef<any>(null); // eslint-disable-line @typescript-eslint/no-explicit-any

  // Check connectivity
  useEffect(() => {
    const checkOnline = async () => {
      try {
        const res = await fetch(`${LOCAL_API_BASE}/api/health`, {
          signal: AbortSignal.timeout(3000),
        });
        setIsOnline(res.ok);
      } catch {
        setIsOnline(false);
      }
    };
    checkOnline();
    const interval = setInterval(checkOnline, 10000);
    return () => clearInterval(interval);
  }, []);

  // Handle sync events (via polling or Socket.IO)
  const handleSyncEvent = useCallback((event: SyncEvent) => {
    switch (event.type) {
      case 'SYNC_STARTED':
        setIsSyncing(true);
        setError(null);
        setCurrentStageLabel('Starting data import...');
        break;

      case 'SYNC_STAGE_STARTED':
        setCurrentStageLabel(`Downloading ${event.stageLabel || event.stage}...`);
        setStages(prev =>
          prev.map(s =>
            s.id === event.stage
              ? { ...s, status: 'in_progress', current: 0, total: 0, percentage: 0 }
              : s
          )
        );
        break;

      case 'SYNC_STAGE_PROGRESS':
        setStages(prev =>
          prev.map(s =>
            s.id === event.stage
              ? {
                  ...s,
                  status: 'in_progress',
                  current: event.current,
                  total: event.total,
                  percentage: event.percentage,
                }
              : s
          )
        );
        // Update overall progress
        if (event.percentage !== undefined) {
          setStages(prev => {
            const stageIndex = prev.findIndex(s => s.id === event.stage);
            const completedStages = prev.filter(s => s.status === 'completed').length;
            const inProgressStageProgress = (event.percentage || 0) / 100;
            const totalStages = prev.length;
            const overall = ((completedStages + inProgressStageProgress) / totalStages) * 100;
            setOverallProgress(Math.min(100, Math.round(overall)));
            return prev;
          });
        }
        break;

      case 'SYNC_STAGE_COMPLETED':
        setStages(prev =>
          prev.map(s =>
            s.id === event.stage
              ? { ...s, status: 'completed', count: event.count, percentage: 100 }
              : s
          )
        );
        setCurrentStageLabel(`${event.stageLabel || event.stage} ✓`);
        // Recalculate overall progress
        setStages(prev => {
          const completed = prev.filter(s => s.status === 'completed').length;
          setOverallProgress(Math.round((completed / prev.length) * 100));
          return prev;
        });
        break;

      case 'SYNC_COMPLETED':
        setIsSyncing(false);
        setSyncCompleted(true);
        setTotalRecords(event.totalRecords || 0);
        setDuration(event.duration || 0);
        setOverallProgress(100);
        setCurrentStageLabel('Import complete!');
        // Navigate to dashboard after a brief delay
        setTimeout(() => {
          navigate('/', { replace: true });
        }, 2000);
        break;

      case 'SYNC_ERROR':
        if (event.skipped) {
          // Non-mandatory stage error — mark as skipped
          setStages(prev =>
            prev.map(s =>
              s.id === event.stage
                ? { ...s, status: 'error', error: event.error }
                : s
            )
          );
        } else {
          setError(event.error || 'Sync failed');
          setIsSyncing(false);
          setStages(prev =>
            prev.map(s =>
              s.id === event.stage
                ? { ...s, status: 'error', error: event.error }
                : s
            )
          );
        }
        break;
    }
  }, [navigate]);

  // Set up Socket.IO listener for sync events
  useEffect(() => {
    let io: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      io = require('socket.io-client');
    } catch {
      // Socket.io client not available — will use polling
    }

    if (io) {
      const token = localStorage.getItem('blasti-local-api-token');
      const socket = io(LOCAL_API_BASE || 'http://127.0.0.1:3080', {
        auth: { token },
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: 10,
        reconnectionDelay: 2000,
      });

      socket.on('sync:initial', (event: SyncEvent) => {
        handleSyncEvent(event);
      });

      socket.on('connect', () => {
        setIsOnline(true);
      });

      socket.on('disconnect', () => {
        setIsOnline(false);
      });

      socketRef.current = socket;

      return () => {
        socket.disconnect();
      };
    }

    // Fallback: polling for sync status
    const pollInterval = setInterval(async () => {
      if (!isSyncing && !syncCompleted) return;
      try {
        const res = await apiFetch('/api/sync/initial-status');
        const data = await res.json();
        if (data.needsInitialSync === false && data.stages) {
          // All done — transform to our stage format
          setStages(prev =>
            prev.map(s => {
              const serverStage = data.stages.find((ss: any) => ss.id === s.id); // eslint-disable-line @typescript-eslint/no-explicit-any
              if (serverStage?.completed) {
                return { ...s, status: 'completed', count: serverStage.count };
              }
              return s;
            })
          );
          setOverallProgress(100);
          setSyncCompleted(true);
        }
      } catch {
        // Polling error — ignore
      }
    }, 3000);

    return () => clearInterval(pollInterval);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Start the initial sync
  const startSync = useCallback(async () => {
    setIsSyncing(true);
    setError(null);
    setCurrentStageLabel('Starting data import...');

    try {
      const res = await apiFetch('/api/sync/initial-sync', {
        method: 'POST',
        body: JSON.stringify({
          agencyId: user?.agencyId,
          cloudAuthToken: token,
        }),
      });

      const data = await res.json();

      if (!data.success) {
        setError(data.error || 'Failed to start initial sync');
        setIsSyncing(false);
        return;
      }

      // Sync has been started on the backend — events will come via Socket.IO
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start initial sync');
      setIsSyncing(false);
    }
  }, [user, token]);

  // Auto-start sync on mount
  useEffect(() => {
    if (!isSyncing && !syncCompleted && !error) {
      startSync();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Retry handler
  const handleRetry = useCallback(async () => {
    setIsRetrying(true);
    setError(null);
    setStages(STAGE_DEFINITIONS.map(s => ({ id: s.id, label: s.label, status: 'pending', mandatory: ['agency', 'users', 'services', 'branches', 'counters', 'agencyStaff', 'queueSettings', 'reservations'].includes(s.id) })));
    setOverallProgress(0);
    setSyncCompleted(false);

    try {
      await startSync();
    } finally {
      setIsRetrying(false);
    }
  }, [startSync]);

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-lg">
        {/* Logo and Branding */}
        <div className="text-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-emerald-500 flex items-center justify-center mx-auto mb-4 shadow-lg shadow-emerald-500/20">
            <Database className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-foreground">
            {syncCompleted ? 'All Set!' : 'Preparing your Agency workspace'}
          </h1>
          <p className="text-sm text-muted-foreground mt-1.5">
            {syncCompleted
              ? `${totalRecords} records imported in ${(duration / 1000).toFixed(1)}s`
              : 'Importing your data for the first time...'}
          </p>
        </div>

        {/* Current Stage Label */}
        {!syncCompleted && (
          <div className="text-center mb-4">
            <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400">
              {currentStageLabel}
            </p>
          </div>
        )}

        {/* Overall Progress Bar */}
        <div className="mb-6">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-muted-foreground">Overall Progress</span>
            <span className="text-xs font-medium text-foreground">{overallProgress}%</span>
          </div>
          <Progress value={overallProgress} className="h-2.5" />
        </div>

        {/* Per-Stage Progress */}
        <div className="bg-muted/30 rounded-xl border border-border/50 p-4 mb-6 max-h-72 overflow-y-auto">
          <div className="space-y-2.5">
            {stages.map(stage => (
              <div key={stage.id} className="flex items-center gap-3 text-sm">
                {/* Status Icon */}
                <div className="w-5 h-5 flex-shrink-0 flex items-center justify-center">
                  {stage.status === 'completed' ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                  ) : stage.status === 'in_progress' ? (
                    <Loader2 className="w-4 h-4 text-emerald-500 animate-spin" />
                  ) : stage.status === 'error' ? (
                    <AlertCircle className="w-4 h-4 text-amber-500" />
                  ) : (
                    <Circle className="w-4 h-4 text-muted-foreground/40" />
                  )}
                </div>

                {/* Stage Label */}
                <span className={`flex-1 ${
                  stage.status === 'completed'
                    ? 'text-foreground'
                    : stage.status === 'in_progress'
                    ? 'text-foreground font-medium'
                    : stage.status === 'error'
                    ? 'text-amber-600 dark:text-amber-400'
                    : 'text-muted-foreground'
                }`}>
                  {stage.label}
                </span>

                {/* Stage Progress / Count */}
                <span className="text-xs tabular-nums text-muted-foreground flex-shrink-0">
                  {stage.status === 'completed' && stage.count !== undefined ? (
                    <span className="text-emerald-600 dark:text-emerald-400">✓ {stage.count}</span>
                  ) : stage.status === 'in_progress' ? (
                    stage.current !== undefined && stage.total ? (
                      <span>
                        {stage.current}/{stage.total}
                        {stage.percentage !== undefined && (
                          <span className="ml-1 text-emerald-500">({stage.percentage}%)</span>
                        )}
                      </span>
                    ) : (
                      <Loader2 className="w-3 h-3 animate-spin text-emerald-500 inline" />
                    )
                  ) : stage.status === 'error' ? (
                    <span className="text-amber-500">failed</span>
                  ) : (
                    'waiting...'
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Connection Status */}
        <div className="flex items-center justify-center gap-2 mb-4">
          {isOnline ? (
            <p className="text-xs text-emerald-500 flex items-center gap-1.5">
              <Wifi className="w-3.5 h-3.5" /> Connected to Cloud
            </p>
          ) : (
            <p className="text-xs text-amber-500 flex items-center gap-1.5">
              <WifiOff className="w-3.5 h-3.5" /> Connection lost — will retry
            </p>
          )}
        </div>

        {/* Error State */}
        {error && (
          <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-4 mb-4">
            <div className="flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="text-sm font-medium text-amber-600 dark:text-amber-400">
                  Sync Failed
                </p>
                <p className="text-xs text-amber-600/80 dark:text-amber-400/80 mt-1">
                  {error}
                </p>
                <button
                  onClick={handleRetry}
                  disabled={isRetrying}
                  className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-300 hover:text-amber-800 dark:hover:text-amber-200 transition-colors"
                >
                  {isRetrying ? (
                    <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Retrying...</>
                  ) : (
                    <><RefreshCw className="w-3.5 h-3.5" /> Retry Sync</>
                  )}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Completed State */}
        {syncCompleted && (
          <div className="text-center">
            <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-4 mb-4">
              <div className="flex items-center justify-center gap-2 mb-1">
                <CheckCircle2 className="w-5 h-5 text-emerald-500" />
                <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400">
                  Workspace Ready
                </p>
              </div>
              <p className="text-xs text-emerald-600/70 dark:text-emerald-400/70">
                All agency data has been imported. Redirecting to dashboard...
              </p>
            </div>
            <button
              onClick={() => navigate('/', { replace: true })}
              className="inline-flex items-center gap-2 text-sm font-medium text-emerald-600 dark:text-emerald-400 hover:text-emerald-700 dark:hover:text-emerald-300 transition-colors"
            >
              Go to Dashboard <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
