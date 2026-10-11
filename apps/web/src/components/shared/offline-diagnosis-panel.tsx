'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  X,
  RefreshCw,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Loader2,
  Wifi,
  WifiOff,
  Server,
  Database,
  Cloud,
  Monitor,
  ArrowRight,
  Activity,
  Clock,
  Info,
  ChevronDown,
  ChevronUp,
  Shield,
  KeyRound,
  HardDrive,
  Layers,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { useLanguage } from '@/hooks/use-language';
import { getApiBaseUrl } from '@/lib/api-client';
import { detectPlatform } from '@/lib/platform';

// ─── Types ──────────────────────────────────────────────────────────────────

type CheckStatus = 'pending' | 'running' | 'success' | 'warning' | 'error';

interface DiagnosticCheck {
  id: string;
  label: string;
  labelEn: string;
  labelFr: string;
  icon: React.ReactNode;
  status: CheckStatus;
  message: string;
  messageEn: string;
  messageFr: string;
  duration?: number;
  details?: string;
  group: string;
}

interface DiagnosisResult {
  checks: DiagnosticCheck[];
  overallStatus: 'pending' | 'ok' | 'degraded' | 'offline';
  isCloudReachable: boolean;
  isLocalApiReachable: boolean;
  isBrowserOnline: boolean;
  localApiHasSession: boolean;
  localApiAuthWorks: boolean;
  localDbEmpty: boolean;
  hasZustandSession: boolean;
  hasLocalApiToken: boolean;
  tokenMatch: boolean;
  watermelonInitialized: boolean;
  timestamp: number;
}

// ─── Helper: detect Electron ───────────────────────────────────────────────

function isElectron(): boolean {
  if (typeof window === 'undefined') return false;
  return !!(window as any).electronAPI || navigator.userAgent.includes('Electron');
}

// ─── Helper: get local API token from localStorage ──────────────────────────

function getLocalApiToken(): string | null {
  try {
    return localStorage.getItem('blasti-local-api-token');
  } catch {
    return null;
  }
}

// ─── Helper: get Zustand persisted session ──────────────────────────────────

function getZustandSession(): { user: unknown; sessionToken: string | null } | null {
  try {
    const data = localStorage.getItem('blasti-app');
    if (!data) return null;
    const parsed = JSON.parse(data);
    return {
      user: parsed?.state?.user || null,
      sessionToken: parsed?.state?.sessionToken || null,
    };
  } catch {
    return null;
  }
}

// ─── Helper: mask sensitive data for display ───────────────────────────────

function maskToken(token: string): string {
  if (!token || token.length < 12) return token ? '••••••••' : '(empty)';
  return token.substring(0, 8) + '••••' + token.substring(token.length - 4);
}

function maskObject(obj: Record<string, unknown>): string {
  try {
    const masked: Record<string, unknown> = {};
    const sensitiveKeys = ['password', 'passwordHash', 'token', 'sessionToken', 'fullName'];
    for (const [key, value] of Object.entries(obj)) {
      if (sensitiveKeys.some(k => key.toLowerCase().includes(k.toLowerCase()))) {
        masked[key] = typeof value === 'string' ? maskToken(value) : '••••';
      } else {
        masked[key] = value;
      }
    }
    return JSON.stringify(masked, null, 2);
  } catch {
    return '{...}';
  }
}

// ─── Helper: check WatermelonDB / LokiJS via IndexedDB ──────────────────────

async function checkWatermelonDB(): Promise<{
  initialized: boolean;
  tables: string[];
  details: string;
}> {
  try {
    if (!window.indexedDB) {
      return { initialized: false, tables: [], details: 'IndexedDB not available' };
    }

    // WatermelonDB with LokiJS stores data in IndexedDB.
    // The database name pattern is typically `_watermelon` or a custom name.
    // We enumerate all databases and look for watermelon-related ones.
    const databases = await window.indexedDB.databases();
    const watermelonDBs = (databases || [])
      .filter((db) => db.name && (db.name.includes('watermelon') || db.name.includes('lokijs')))
      .map((db) => db.name || 'unknown');

    if (watermelonDBs.length === 0) {
      return { initialized: false, tables: [], details: `No WatermelonDB/LokiJS databases found. IndexedDB databases: [${(databases || []).map((d) => d.name).join(', ')}]` };
    }

    // Try to open the first watermelon database and inspect its stores
    const dbName = watermelonDBs[0];
    const tables: string[] = [];

    try {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = window.indexedDB.open(dbName, 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onupgradeneeded = () => resolve(request.result);
      });

      for (let i = 0; i < db.objectStoreNames.length; i++) {
        const storeName = db.objectStoreNames[i];
        tables.push(storeName);
      }
      db.close();
    } catch {
      // If we can't open it, at least we know it exists
    }

    return {
      initialized: true,
      tables,
      details: `Found ${watermelonDBs.length} WatermelonDB(s): ${watermelonDBs.join(', ')}. Stores: [${tables.join(', ') || 'none accessible'}]`,
    };
  } catch (err) {
    return {
      initialized: false,
      tables: [],
      details: `IndexedDB check error: ${err instanceof Error ? err.message : 'Unknown'}`,
    };
  }
}

// ─── Helper: run a health check with timeout ───────────────────────────────

async function healthCheck(
  url: string,
  timeout = 3000,
  headers?: Record<string, string>,
): Promise<{ ok: boolean; status: number; latency: number; error?: string; data?: unknown }> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const res = await fetch(url, {
      signal: controller.signal,
      credentials: 'omit',
      headers,
    });
    clearTimeout(timer);
    let data: unknown = null;
    try {
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        data = await res.json();
      }
    } catch {
      /* ignore parse error */
    }
    return {
      ok: res.ok,
      status: res.status,
      latency: Date.now() - start,
      data,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      latency: Date.now() - start,
      error: err instanceof Error ? err.message : 'Connection failed',
    };
  }
}

// ─── Helper: extract record counts from db-status response ─────────────────

function extractDbRecordCounts(dbData: Record<string, unknown>): { totalRecords: number; empty: boolean; summary: string } {
  try {
    // The /api/db-status endpoint returns:
    //   { success: true, tables: 12, tableNames: [...], counts: { TableName: N, ... }, mode: 'sqlite', ... }
    // OR a legacy format:
    //   { tables: [...], tableCounts: { TableName: count, ... } }
    const tableCounts = dbData?.tableCounts || dbData?.counts || dbData?.records || {};

    // Handle both formats: tableNames (array) OR tables (array) OR tables (number → use tableNames)
    let tables: string[] = [];
    if (Array.isArray(dbData?.tableNames) && dbData.tableNames.length > 0) {
      tables = dbData.tableNames as string[];
    } else if (Array.isArray(dbData?.tables)) {
      tables = dbData.tables as string[];
    } else if (typeof dbData?.tables === 'number') {
      // tables is a count, not an array — derive from counts keys
      tables = Object.keys(tableCounts);
    } else {
      tables = Object.keys(tableCounts);
    }

    let totalRecords = 0;
    const countEntries: string[] = [];

    for (const table of tables) {
      const count = (tableCounts as Record<string, number>)[table] ?? 0;
      if (count >= 0) {
        totalRecords += count;
        countEntries.push(`${table}: ${count}`);
      }
    }

    return {
      totalRecords,
      empty: totalRecords === 0,
      summary: countEntries.length > 0 ? countEntries.join(', ') : 'No tables found',
    };
  } catch (err) {
    return { totalRecords: 0, empty: true, summary: `Parse error: ${err instanceof Error ? err.message : 'unknown'}` };
  }
}

// ─── Main Component ────────────────────────────────────────────────────────

interface OfflineDiagnosisPanelProps {
  open: boolean;
  onClose: () => void;
  autoRun?: boolean;
}

export function OfflineDiagnosisPanel({ open, onClose, autoRun = true }: OfflineDiagnosisPanelProps) {
  const { t, lang } = useLanguage();
  const [result, setResult] = useState<DiagnosisResult | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [expandedChecks, setExpandedChecks] = useState<Set<string>>(new Set());
  const [runCount, setRunCount] = useState(0);
  const abortRef = useRef(false);

  const toggleCheckDetails = useCallback((checkId: string) => {
    setExpandedChecks((prev) => {
      const next = new Set(prev);
      if (next.has(checkId)) {
        next.delete(checkId);
      } else {
        next.add(checkId);
      }
      return next;
    });
  }, []);

  const runDiagnostics = useCallback(async () => {
    abortRef.current = false;
    setIsRunning(true);

    const platform = detectPlatform();
    const isElectronApp = isElectron();
    const browserOnline = navigator.onLine;
    const checks: DiagnosticCheck[] = [];

    // ═══════════════════════════════════════════════════════════════════════
    // GROUP 1: NETWORK
    // ═══════════════════════════════════════════════════════════════════════

    // ── Check 1: Browser Network Status ──
    const networkCheck: DiagnosticCheck = {
      id: 'network',
      label: 'حالة الشبكة',
      labelEn: 'Network Status',
      labelFr: 'État du réseau',
      icon: <Wifi className="h-4 w-4" />,
      status: browserOnline ? 'success' : 'error',
      message: browserOnline ? 'المتصفح متصل بالإنترنت' : 'المتصفح غير متصل بالإنترنت',
      messageEn: browserOnline ? 'Browser is online' : 'Browser is offline',
      messageFr: browserOnline ? 'Le navigateur est en ligne' : 'Le navigateur est hors ligne',
      details: `navigator.onLine = ${browserOnline} · Platform: ${platform.platform} · OS: ${platform.os}`,
      group: 'network',
    };
    checks.push(networkCheck);

    if (abortRef.current) return;

    // ── Check 2: Cloud API Reachability ──
    const cloudCheck: DiagnosticCheck = {
      id: 'cloud-api',
      label: 'خادم السحابة (Cloud API)',
      labelEn: 'Cloud API Server',
      labelFr: 'Serveur Cloud API',
      icon: <Cloud className="h-4 w-4" />,
      status: 'running',
      message: 'جاري الفحص...',
      messageEn: 'Checking...',
      messageFr: 'Vérification...',
      group: 'network',
    };
    checks.push(cloudCheck);

    // In Electron, if the browser reports no network connectivity, skip the
    // cloud health check entirely — it would just generate ERR_CONNECTION_REFUSED
    // console noise and waste time waiting for timeout.
    let cloudReachable = false;
    if (!browserOnline && isElectronApp) {
      Object.assign(checks[1], {
        status: 'warning',
        message: 'غير متاح — الشبكة غير متصلة',
        messageEn: 'Unavailable — network is offline',
        messageFr: 'Indisponible — réseau hors ligne',
        duration: 0,
        details: 'Skipped — navigator.onLine is false (Electron)',
      });
    } else {
      const cloudBaseUrl = getApiBaseUrl();
      let cloudHealthUrl = `${cloudBaseUrl}/health`;
      if (!cloudBaseUrl && typeof window !== 'undefined' && !isElectronApp) {
        cloudHealthUrl += '?XTransformPort=3003';
      }

      const cloudResult = await healthCheck(cloudHealthUrl, isElectronApp ? 2000 : 3000);
      cloudReachable = cloudResult.ok;
      Object.assign(checks[1], {
        status: cloudReachable ? 'success' : (browserOnline ? 'error' : 'warning'),
        message: cloudReachable
          ? `خادم السحابة يعمل (${cloudResult.latency}ms)`
          : browserOnline
            ? `خادم السحابة غير متاح: ${cloudResult.error || 'Timeout'}`
            : 'غير متاح — الشبكة غير متصلة',
        messageEn: cloudReachable
          ? `Cloud API is up (${cloudResult.latency}ms)`
          : browserOnline
            ? `Cloud API unreachable: ${cloudResult.error || 'Timeout'}`
            : 'Unavailable — network is offline',
        messageFr: cloudReachable
          ? `Cloud API fonctionne (${cloudResult.latency}ms)`
          : browserOnline
            ? `Cloud API inaccessible: ${cloudResult.error || 'Timeout'}`
            : 'Indisponible — réseau hors ligne',
        duration: cloudResult.latency,
        details: `URL: ${cloudHealthUrl} · Status: ${cloudResult.status === 0 ? 'Connection failed' : cloudResult.status} · Method: ${isElectronApp ? 'Direct (Electron)' : 'Gateway (XTransformPort)'}${cloudResult.error ? ' · Error: ' + cloudResult.error : ''}`,
      });
    }

    if (abortRef.current) return;

    // ═══════════════════════════════════════════════════════════════════════
    // GROUP 2: LOCAL API (Electron only)
    // ═══════════════════════════════════════════════════════════════════════

    let localReachable = false;
    let localApiHasSession = false;
    let localApiAuthWorks = false;
    let localDbEmpty = false;
    let localDbInfo: Record<string, unknown> | null = null;

    if (isElectronApp) {

      // ── Check 3: Local API Server Health ──
      const localApiCheck: DiagnosticCheck = {
        id: 'local-api',
        label: 'الخادم المحلي (localhost:3080)',
        labelEn: 'Local API Server (localhost:3080)',
        labelFr: 'Serveur API local (localhost:3080)',
        icon: <Server className="h-4 w-4" />,
        status: 'running',
        message: 'جاري الفحص...',
        messageEn: 'Checking...',
        messageFr: 'Vérification...',
        group: 'local-api',
      };
      checks.push(localApiCheck);

      const localResult = await healthCheck('http://127.0.0.1:3080/api/health', 2000);
      localReachable = localResult.ok;
      Object.assign(checks[checks.length - 1], {
        status: localReachable ? 'success' : 'error',
        message: localReachable
          ? `الخادم المحلي يعمل (${localResult.latency}ms)`
          : `الخادم المحلي غير متاح: ${localResult.error || 'Timeout'}`,
        messageEn: localReachable
          ? `Local API is up (${localResult.latency}ms)`
          : `Local API unreachable: ${localResult.error || 'Timeout'}`,
        messageFr: localReachable
          ? `API local fonctionne (${localResult.latency}ms)`
          : `API local inaccessible: ${localResult.error || 'Timeout'}`,
        duration: localResult.latency,
        details: `URL: http://127.0.0.1:3080/api/health · Status: ${localResult.status}${localResult.data ? ' · Response: ' + JSON.stringify(localResult.data) : ''}`,
      });

      if (abortRef.current) return;

      // ── Check 4: Local API Session Status ──
      const sessionCheck: DiagnosticCheck = {
        id: 'local-session',
        label: 'جلسة الخادم المحلي',
        labelEn: 'Local API Session',
        labelFr: 'Session API local',
        icon: <Shield className="h-4 w-4" />,
        status: 'running',
        message: 'جاري الفحص...',
        messageEn: 'Checking...',
        messageFr: 'Vérification...',
        group: 'local-api',
      };
      checks.push(sessionCheck);

      if (localReachable) {
        const sessionResult = await healthCheck('http://127.0.0.1:3080/api/auth/session', 2000);
        // Session endpoint returns 200 with session data if active, 401 if no session
        localApiHasSession = sessionResult.ok && sessionResult.status === 200;

        if (sessionResult.ok && sessionResult.status === 200) {
          const sessionData = sessionResult.data as Record<string, unknown> | undefined;
          const userId = sessionData?.user ? String((sessionData.user as Record<string, unknown>)?.id || 'present') : 'unknown';
          Object.assign(checks[checks.length - 1], {
            status: 'success',
            message: `الخادم المحلي لديه جلسة نشطة — المستخدم: ${userId}`,
            messageEn: `Local API has an active session — User: ${userId}`,
            messageFr: `API local a une session active — Utilisateur: ${userId}`,
            duration: sessionResult.latency,
            details: `URL: /api/auth/session · Status: ${sessionResult.status}${sessionData ? ' · Data: ' + maskObject(sessionData as Record<string, unknown>) : ''}`,
          });
        } else if (sessionResult.status === 401) {
          Object.assign(checks[checks.length - 1], {
            status: 'error',
            message: 'الخادم المحلي ليس لديه جلسة نشطة (401 Unauthorized)',
            messageEn: 'Local API has no active session (401 Unauthorized)',
            messageFr: 'API local n\'a pas de session active (401 Unauthorized)',
            duration: sessionResult.latency,
            details: `URL: /api/auth/session · Status: 401 — The local API server does not have a stored session. This causes all LAN failover requests to return 401.`,
          });
        } else {
          Object.assign(checks[checks.length - 1], {
            status: 'warning',
            message: `لا يمكن التحقق من الجلسة: HTTP ${sessionResult.status}`,
            messageEn: `Cannot verify session: HTTP ${sessionResult.status}`,
            messageFr: `Impossible de vérifier la session: HTTP ${sessionResult.status}`,
            duration: sessionResult.latency,
            details: `URL: /api/auth/session · Status: ${sessionResult.status} · Error: ${sessionResult.error || 'none'}`,
          });
        }
      } else {
        Object.assign(checks[checks.length - 1], {
          status: 'error',
          message: 'الخادم المحلي لا يعمل — لا يمكن فحص الجلسة',
          messageEn: 'Local API is down — cannot check session',
          messageFr: 'API local est arrêté — impossible de vérifier la session',
          details: 'Skipped — Local API is unreachable',
        });
      }

      if (abortRef.current) return;

      // ── Check 5: Local API Auth Test ──
      const authTestCheck: DiagnosticCheck = {
        id: 'local-auth-test',
        label: 'اختبار المصادقة المحلي',
        labelEn: 'Local API Auth Test',
        labelFr: 'Test d\'authentification local',
        icon: <KeyRound className="h-4 w-4" />,
        status: 'running',
        message: 'جاري الفحص...',
        messageEn: 'Checking...',
        messageFr: 'Vérification...',
        group: 'local-api',
      };
      checks.push(authTestCheck);

      const localToken = getLocalApiToken();

      if (localReachable && localApiHasSession) {
        if (localToken) {
          const authResult = await healthCheck('http://127.0.0.1:3080/api/sync-status', 2000, {
            Authorization: `Bearer ${localToken}`,
          });
          localApiAuthWorks = authResult.ok || authResult.status === 200;

          if (localApiAuthWorks) {
            Object.assign(checks[checks.length - 1], {
              status: 'success',
              message: `المصادقة المحلية تعمل — الطلب حصل على ${authResult.status}`,
              messageEn: `Local auth works — request got ${authResult.status}`,
              messageFr: `Authentification locale fonctionne — requête a reçu ${authResult.status}`,
              duration: authResult.latency,
              details: `URL: /api/sync-status · Token: ${maskToken(localToken)} · Status: ${authResult.status}${authResult.data ? ' · Data: ' + maskObject(authResult.data as Record<string, unknown>) : ''}`,
            });
          } else {
            Object.assign(checks[checks.length - 1], {
              status: 'error',
              message: `المصادقة فشلت — HTTP ${authResult.status} — التوكن لا يتطابق مع جلسة الخادم المحلي`,
              messageEn: `Auth failed — HTTP ${authResult.status} — Token does not match local API session`,
              messageFr: `Échec de l'authentification — HTTP ${authResult.status} — Le token ne correspond pas à la session API locale`,
              duration: authResult.latency,
              details: `URL: /api/sync-status · Token: ${maskToken(localToken)} · Status: ${authResult.status} · Error: ${authResult.error || 'none'}`,
            });
          }
        } else {
          localApiAuthWorks = false;
          Object.assign(checks[checks.length - 1], {
            status: 'error',
            message: 'لا يوجد توكن في localStorage — لا يمكن اختبار المصادقة',
            messageEn: 'No token in localStorage — cannot test auth',
            messageFr: 'Pas de token dans localStorage — impossible de tester l\'authentification',
            details: 'blasti-local-api-token is missing from localStorage. The local API has a session but no client-side token to authenticate requests.',
          });
        }
      } else if (localReachable && !localApiHasSession) {
        Object.assign(checks[checks.length - 1], {
          status: 'warning',
          message: 'لا يوجد جلسة في الخادم المحلي — اختبار المصادقة غير ممكن',
          messageEn: 'No session in local API — auth test skipped',
          messageFr: 'Pas de session dans l\'API local — test d\'authentification ignoré',
          details: 'Skipped — Local API has no active session to test against',
        });
      } else {
        Object.assign(checks[checks.length - 1], {
          status: 'error',
          message: 'الخادم المحلي لا يعمل — لا يمكن اختبار المصادقة',
          messageEn: 'Local API is down — cannot test auth',
          messageFr: 'API local est arrêté — impossible de tester l\'authentification',
          details: 'Skipped — Local API is unreachable',
        });
      }

      if (abortRef.current) return;

      // ── Check 6: Local API Database Status ──
      const localDbCheck: DiagnosticCheck = {
        id: 'local-db',
        label: 'قاعدة البيانات المحلية (SQLite)',
        labelEn: 'Local Database (SQLite)',
        labelFr: 'Base de données locale (SQLite)',
        icon: <HardDrive className="h-4 w-4" />,
        status: 'running',
        message: 'جاري الفحص...',
        messageEn: 'Checking...',
        messageFr: 'Vérification...',
        group: 'local-api',
      };
      checks.push(localDbCheck);

      if (localReachable) {
        const dbResult = await healthCheck('http://127.0.0.1:3080/api/db-status', 2000);
        localDbInfo = dbResult.data as Record<string, unknown> | null;

        if (dbResult.ok && dbResult.data) {
          const dbCounts = extractDbRecordCounts(dbResult.data as Record<string, unknown>);
          localDbEmpty = dbCounts.empty;

          Object.assign(checks[checks.length - 1], {
            status: dbCounts.empty ? 'warning' : 'success',
            message: dbCounts.empty
              ? `قاعدة البيانات فارغة — ${dbCounts.summary}`
              : `قاعدة البيانات تعمل — إجمالي السجلات: ${dbCounts.totalRecords}`,
            messageEn: dbCounts.empty
              ? `Local database is empty — ${dbCounts.summary}`
              : `Database operational — total records: ${dbCounts.totalRecords}`,
            messageFr: dbCounts.empty
              ? `Base de données locale vide — ${dbCounts.summary}`
              : `Base de données opérationnelle — total enregistrements: ${dbCounts.totalRecords}`,
            duration: dbResult.latency,
            details: `URL: /api/db-status · Status: ${dbResult.status} · ${dbCounts.summary}${dbResult.data ? ' · Raw: ' + JSON.stringify(dbResult.data, null, 2) : ''}`,
          });
        } else {
          localDbEmpty = true;
          Object.assign(checks[checks.length - 1], {
            status: 'error',
            message: `قاعدة البيانات: ${dbResult.error || 'Unknown status'} (HTTP ${dbResult.status})`,
            messageEn: `Database: ${dbResult.error || 'Unknown status'} (HTTP ${dbResult.status})`,
            messageFr: `Base de données: ${dbResult.error || 'Statut inconnu'} (HTTP ${dbResult.status})`,
            duration: dbResult.latency,
            details: `URL: /api/db-status · Status: ${dbResult.status} · Error: ${dbResult.error || 'none'}`,
          });
        }
      } else {
        Object.assign(checks[checks.length - 1], {
          status: 'error',
          message: 'الخادم المحلي لا يعمل — لا يمكن فحص قاعدة البيانات',
          messageEn: 'Local API is down — cannot check database',
          messageFr: 'API local est arrêté — impossible de vérifier la BDD',
          details: 'Skipped — Local API is unreachable',
        });
      }
    }

    if (abortRef.current) return;

    // ═══════════════════════════════════════════════════════════════════════
    // GROUP 3: CLIENT-SIDE AUTH
    // ═══════════════════════════════════════════════════════════════════════

    // ── Check 7: Zustand Session ──
    const zustandSession = getZustandSession();
    const hasZustandSession = !!(zustandSession?.sessionToken && zustandSession?.user);
    const zustandCheck: DiagnosticCheck = {
      id: 'zustand-session',
      label: 'جلسة Zustand',
      labelEn: 'Zustand Session',
      labelFr: 'Session Zustand',
      icon: <Shield className="h-4 w-4" />,
      status: hasZustandSession ? 'success' : 'error',
      message: hasZustandSession
        ? 'بيانات المستخدم والجلسة موجودة في Zustand'
        : 'لا توجد جلسة في Zustand — المستخدم غير مسجل الدخول',
      messageEn: hasZustandSession
        ? 'User data and session token exist in Zustand'
        : 'No session in Zustand — user is not logged in',
      messageFr: hasZustandSession
        ? 'Données utilisateur et token de session existent dans Zustand'
        : 'Pas de session dans Zustand — utilisateur non connecté',
      details: zustandSession
        ? `User: ${zustandSession.user ? maskObject(zustandSession.user as Record<string, unknown>).substring(0, 120) : 'null'} · sessionToken: ${zustandSession.sessionToken ? maskToken(zustandSession.sessionToken) : 'null'}`
        : 'localStorage key "blasti-app" not found or empty',
      group: 'client-auth',
    };
    checks.push(zustandCheck);

    // ── Check 8: Local API Token in localStorage ──
    const localToken = getLocalApiToken();
    const hasLocalApiToken = !!localToken;
    const tokenCheck: DiagnosticCheck = {
      id: 'local-api-token',
      label: 'توكن API المحلي (localStorage)',
      labelEn: 'Local API Token (localStorage)',
      labelFr: 'Token API local (localStorage)',
      icon: <KeyRound className="h-4 w-4" />,
      status: hasLocalApiToken ? 'success' : 'error',
      message: hasLocalApiToken
        ? `blasti-local-api-token موجود (${localToken!.substring(0, 16)}...)`
        : 'blasti-local-api-token غير موجود في localStorage',
      messageEn: hasLocalApiToken
        ? `blasti-local-api-token found (${localToken!.substring(0, 16)}...)`
        : 'blasti-local-api-token is NOT in localStorage',
      messageFr: hasLocalApiToken
        ? `blasti-local-api-token trouvé (${localToken!.substring(0, 16)}...)`
        : 'blasti-local-api-token n\'est PAS dans localStorage',
      details: hasLocalApiToken
        ? `Key: blasti-local-api-token · Value: ${maskToken(localToken!)} (${localToken!.length} chars)`
        : 'The blasti-local-api-token key is not set in localStorage. This token is required for the local API to accept requests. It is normally set during login via window.electronAPI.setLocalApiSession().',
      group: 'client-auth',
    };
    checks.push(tokenCheck);

    // ── Check 9: Token Match ──
    let tokenMatch = false;
    let tokenMatchDetails = '';

    if (isElectronApp && localToken && zustandSession?.sessionToken) {
      // Compare the Zustand session token with the local API token
      tokenMatch = localToken === zustandSession.sessionToken;
      tokenMatchDetails = tokenMatch
        ? `blasti-local-api-token matches Zustand sessionToken (length: ${localToken.length})`
        : `MISMATCH! local-api-token (${maskToken(localToken)}) != sessionToken (${maskToken(zustandSession.sessionToken)})`;
    } else if (!isElectronApp) {
      tokenMatch = true; // Not applicable
      tokenMatchDetails = 'Skipped — Not running in Electron';
    } else if (!localToken) {
      tokenMatch = false;
      tokenMatchDetails = 'blasti-local-api-token is missing — cannot compare';
    } else if (!zustandSession?.sessionToken) {
      tokenMatch = false;
      tokenMatchDetails = 'Zustand sessionToken is missing — cannot compare';
    }

    const tokenMatchCheck: DiagnosticCheck = {
      id: 'token-match',
      label: 'تطابق التوكنات',
      labelEn: 'Token Match',
      labelFr: 'Correspondance des tokens',
      icon: <ArrowRight className="h-4 w-4" />,
      status: isElectronApp ? (tokenMatch ? 'success' : 'error') : 'warning',
      message: isElectronApp
        ? (tokenMatch ? 'التوكنات متطابقة — التوكن في localStorage يطابق جلسة Zustand' : 'التوكنات غير متطابقة — التوكن في localStorage يختلف عن جلسة Zustand')
        : 'اختبار التوكن متاح فقط في تطبيق Electron',
      messageEn: isElectronApp
        ? (tokenMatch ? 'Tokens match — localStorage token matches Zustand session' : 'Tokens do NOT match — localStorage token differs from Zustand session')
        : 'Token match test only applies to Electron',
      messageFr: isElectronApp
        ? (tokenMatch ? 'Tokens correspondent — le token localStorage correspond à la session Zustand' : 'Tokens NE correspondent PAS — le token localStorage diffère de la session Zustand')
        : 'Le test de correspondance ne s\'applique qu\'à Electron',
      details: tokenMatchDetails,
      group: 'client-auth',
    };
    checks.push(tokenMatchCheck);

    if (abortRef.current) return;

    // ═══════════════════════════════════════════════════════════════════════
    // GROUP 4: DATA AVAILABILITY
    // ═══════════════════════════════════════════════════════════════════════

    // ── Check 10: WatermelonDB / LokiJS Initialization ──
    const watermelonCheck: DiagnosticCheck = {
      id: 'watermelon-db',
      label: 'ذاكرة WatermelonDB',
      labelEn: 'WatermelonDB Cache',
      labelFr: 'Cache WatermelonDB',
      icon: <Layers className="h-4 w-4" />,
      status: 'running',
      message: 'جاري الفحص...',
      messageEn: 'Checking...',
      messageFr: 'Vérification...',
      group: 'data',
    };
    checks.push(watermelonCheck);

    const wmResult = await checkWatermelonDB();

    Object.assign(checks[checks.length - 1], {
      status: wmResult.initialized ? (wmResult.tables.length > 0 ? 'success' : 'warning') : 'warning',
      message: wmResult.initialized
        ? wmResult.tables.length > 0
          ? `WatermelonDB مُهيأ — ${wmResult.tables.length} مخزن بيانات`
          : `WatermelonDB موجود لكن لا توجد مخازن بيانات`
        : 'WatermelonDB/LokiJS غير مُهيأ أو لا توجد بيانات مخزنة',
      messageEn: wmResult.initialized
        ? wmResult.tables.length > 0
          ? `WatermelonDB initialized — ${wmResult.tables.length} object stores`
          : `WatermelonDB exists but has no object stores`
        : 'WatermelonDB/LokiJS not initialized or no cached data',
      messageFr: wmResult.initialized
        ? wmResult.tables.length > 0
          ? `WatermelonDB initialisé — ${wmResult.tables.length} magasins d'objets`
          : `WatermelonDB existe mais n'a pas de magasins d'objets`
        : 'WatermelonDB/LokiJS non initialisé ou pas de données en cache',
      details: wmResult.details,
    });

    if (abortRef.current) return;

    // ── Check 11: Offline Cache Content Test ──
    const cacheCheck: DiagnosticCheck = {
      id: 'offline-cache',
      label: 'محتوى ذاكرة عدم الاتصال',
      labelEn: 'Offline Cache Content',
      labelFr: 'Contenu du cache hors ligne',
      icon: <Database className="h-4 w-4" />,
      status: 'running',
      message: 'جاري الفحص...',
      messageEn: 'Checking...',
      messageFr: 'Vérification...',
      group: 'data',
    };
    checks.push(cacheCheck);

    // Try to detect if any meaningful data exists in the cache
    let cacheHasData = false;
    let cacheSummary = '';

    try {
      if (wmResult.initialized && wmResult.tables.length > 0) {
        // Try to read from the WatermelonDB IndexedDB stores to see if they have records
        const dbName = (await window.indexedDB.databases()).find(
          (db) => db.name && (db.name.includes('watermelon') || db.name.includes('lokijs'))
        )?.name;

        if (dbName) {
          const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = window.indexedDB.open(dbName, 1);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
            request.onupgradeneeded = () => resolve(request.result);
          });

          const storeCounts: string[] = [];
          let total = 0;

          for (let i = 0; i < db.objectStoreNames.length; i++) {
            const storeName = db.objectStoreNames[i];
            try {
              const tx = db.transaction(storeName, 'readonly');
              const store = tx.objectStore(storeName);
              const countReq = store.count();
              const count = await new Promise<number>((resolve, reject) => {
                countReq.onsuccess = () => resolve(countReq.result);
                countReq.onerror = () => reject(countReq.error);
              });
              storeCounts.push(`${storeName}: ${count}`);
              if (count > 0) cacheHasData = true;
              total += count;
            } catch {
              storeCounts.push(`${storeName}: ?`);
            }
          }

          cacheSummary = `Total records: ${total} — [${storeCounts.join(', ')}]`;
          db.close();
        }
      } else {
        cacheSummary = 'WatermelonDB not initialized — cannot read offline cache';
      }
    } catch (err) {
      cacheSummary = `Cache read error: ${err instanceof Error ? err.message : 'Unknown'}`;
    }

    Object.assign(checks[checks.length - 1], {
      status: cacheHasData ? 'success' : 'warning',
      message: cacheHasData
        ? `الذاكرة تحتوي بيانات — ${cacheSummary}`
        : `الذاكرة فارغة — لا توجد بيانات مخزنة للعمل بدون اتصال`,
      messageEn: cacheHasData
        ? `Cache has data — ${cacheSummary}`
        : `Cache is empty — no data stored for offline use`,
      messageFr: cacheHasData
        ? `Le cache contient des données — ${cacheSummary}`
        : `Le cache est vide — aucune donnée stockée pour le mode hors ligne`,
      details: cacheSummary,
    });

    // ═══════════════════════════════════════════════════════════════════════
    // OVERALL STATUS
    // ═══════════════════════════════════════════════════════════════════════

    const hasError = checks.some((c) => c.status === 'error');
    const hasWarning = checks.some((c) => c.status === 'warning');
    const allSuccess = checks.every((c) => c.status === 'success');

    // Offline-capable: cloud down but local API works with data and auth
    const offlineCapable = isElectronApp && !cloudReachable && localReachable && localApiHasSession && localApiAuthWorks && !localDbEmpty;

    const overallStatus: DiagnosisResult['overallStatus'] = allSuccess
      ? 'ok'
      : offlineCapable
        ? 'degraded'
        : hasError
          ? 'offline'
          : 'degraded';

    const newResult: DiagnosisResult = {
      checks,
      overallStatus,
      isCloudReachable: cloudReachable,
      isLocalApiReachable: isElectronApp ? localReachable : false,
      isBrowserOnline: browserOnline,
      localApiHasSession,
      localApiAuthWorks,
      localDbEmpty,
      hasZustandSession,
      hasLocalApiToken,
      tokenMatch,
      watermelonInitialized: wmResult.initialized,
      timestamp: Date.now(),
    };

    setResult(newResult);
    setIsRunning(false);
    setRunCount((c) => c + 1);
  }, []);

  // Auto-run on open
  useEffect(() => {
    if (open && autoRun) {
      runDiagnostics();
    }
  }, [open, autoRun, runDiagnostics]);

  // Cleanup on close
  useEffect(() => {
    if (!open) {
      abortRef.current = true;
      setIsRunning(false);
    }
  }, [open]);

  // Get localized message
  const getLabel = (check: DiagnosticCheck) => {
    if (lang === 'fr') return check.labelFr;
    if (lang === 'en') return check.labelEn;
    return check.label;
  };
  const getMessage = (check: DiagnosticCheck) => {
    if (lang === 'fr') return check.messageFr;
    if (lang === 'en') return check.messageEn;
    return check.message;
  };

  const statusIcon = (status: CheckStatus) => {
    switch (status) {
      case 'success':
        return <CheckCircle2 className="h-5 w-5 text-emerald-500" />;
      case 'error':
        return <XCircle className="h-5 w-5 text-rose-500" />;
      case 'warning':
        return <AlertTriangle className="h-5 w-5 text-amber-500" />;
      case 'running':
        return <Loader2 className="h-5 w-5 text-blue-500 animate-spin" />;
      default:
        return <Loader2 className="h-5 w-5 text-gray-400 animate-pulse" />;
    }
  };

  const statusColor = (status: CheckStatus) => {
    switch (status) {
      case 'success': return 'border-emerald-500/30 bg-emerald-50 dark:bg-emerald-950/20';
      case 'error': return 'border-rose-500/30 bg-rose-50 dark:bg-rose-950/20';
      case 'warning': return 'border-amber-500/30 bg-amber-50 dark:bg-amber-950/20';
      case 'running': return 'border-blue-500/30 bg-blue-50 dark:bg-blue-950/20';
      default: return 'border-gray-500/30 bg-gray-50 dark:bg-gray-950/20';
    }
  };

  const overallBadge = () => {
    if (!result) return null;
    switch (result.overallStatus) {
      case 'ok':
        return (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-100 dark:bg-emerald-900/30 border border-emerald-200 dark:border-emerald-800">
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            <span className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">
              {lang === 'fr' ? 'Tout fonctionne' : lang === 'en' ? 'All Systems OK' : 'كل شيء يعمل'}
            </span>
          </div>
        );
      case 'degraded':
        return (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-100 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            <span className="text-sm font-semibold text-amber-700 dark:text-amber-400">
              {lang === 'fr' ? 'Mode dégradé' : lang === 'en' ? 'Degraded Mode' : 'وضع محدود'}
            </span>
          </div>
        );
      case 'offline':
        return (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-rose-100 dark:bg-rose-900/30 border border-rose-200 dark:border-rose-800">
            <WifiOff className="h-4 w-4 text-rose-600" />
            <span className="text-sm font-semibold text-rose-700 dark:text-rose-400">
              {lang === 'fr' ? 'Mode hors ligne' : lang === 'en' ? 'Offline Mode' : 'وضع غير متصل'}
            </span>
          </div>
        );
      default:
        return null;
    }
  };

  // ─── Smart Remediation Tips ──────────────────────────────────────────────

  const getTips = () => {
    const tips: Array<{ icon: React.ReactNode; text: string; textEn: string; textFr: string }> = [];

    if (!result) return tips;

    const isElectronApp = isElectron();

    // 1. Local API is completely down
    if (isElectronApp && !result.isLocalApiReachable) {
      tips.push({
        icon: <Server className="h-4 w-4" />,
        text: 'الخادم المحلي (localhost:3080) لا يعمل. أعد تشغيل تطبيق Electron.',
        textEn: 'Local API (localhost:3080) is not running. Restart the Electron app.',
        textFr: 'API local (localhost:3080) ne fonctionne pas. Redémarrez l\'application Electron.',
      });
    }

    // 2. Local API is up but no session
    if (isElectronApp && result.isLocalApiReachable && !result.localApiHasSession) {
      tips.push({
        icon: <Shield className="h-4 w-4" />,
        text: 'الخادم المحلي ليس لديه جلسة نشطة. حاول تسجيل الخروج ثم تسجيل الدخول مرة أخرى لإعادة إنشاء الجلسة.',
        textEn: 'Local API has no active session. Try logging out and logging back in to re-establish the session.',
        textFr: 'API local n\'a pas de session active. Essayez de vous déconnecter puis vous reconnecter pour rétablir la session.',
      });
    }

    // 3. Token in localStorage but local API returns 401 (token mismatch)
    if (isElectronApp && result.hasLocalApiToken && result.isLocalApiReachable && !result.localApiAuthWorks && result.localApiHasSession) {
      tips.push({
        icon: <KeyRound className="h-4 w-4" />,
        text: 'عدم تطابق التوكن — التوكن المخزن في localStorage لا يتطابق مع جلسة الخادم المحلي. يمكن أن يحدث هذا بعد إعادة تشغيل التطبيق. حاول تحديث الصفحة (Ctrl+R).',
        textEn: 'Token mismatch — the token stored in localStorage doesn\'t match the local API\'s session. This can happen after an app restart. Try refreshing the page (Ctrl+R).',
        textFr: 'Inadéquation du token — le token stocké dans localStorage ne correspond pas à la session de l\'API locale. Cela peut arriver après un redémarrage. Essayez de rafraîchir la page (Ctrl+R).',
      });
    }

    // 4. No token in localStorage at all
    if (isElectronApp && !result.hasLocalApiToken && result.isLocalApiReachable) {
      tips.push({
        icon: <KeyRound className="h-4 w-4" />,
        text: 'blasti-local-api-token غير موجود في localStorage. هذا يعني أن جلسة API المحلية لم تُؤسس. سجل الخروج ثم سجل الدخول مرة أخرى.',
        textEn: 'blasti-local-api-token is not in localStorage. This means the local API session was never established. Log out and log back in.',
        textFr: 'blasti-local-api-token n\'est pas dans localStorage. Cela signifie que la session API locale n\'a jamais été établie. Déconnectez-vous puis reconnectez-vous.',
      });
    }

    // 5. Local API auth works but DB is empty
    if (isElectronApp && result.isLocalApiReachable && result.localApiAuthWorks && result.localDbEmpty) {
      tips.push({
        icon: <HardDrive className="h-4 w-4" />,
        text: 'قاعدة البيانات المحلية فارغة (0 سجلات). يجب مزامنة البيانات من السحابة أولاً. وضع عدم الاتصال يتطلب توفر البيانات محلياً. انتظر عودة السحابة وتم المزامنة.',
        textEn: 'Local database is empty (0 records). Data must be synced from the cloud first. Offline mode requires data to be available locally. Wait for cloud to come back and sync.',
        textFr: 'La base de données locale est vide (0 enregistrements). Les données doivent être synchronisées depuis le cloud d\'abord. Le mode hors ligne nécessite des données locales. Attendez le retour du cloud et la synchronisation.',
      });
    }

    // 6. WatermelonDB cache is empty
    if (isElectronApp && !result.watermelonInitialized) {
      tips.push({
        icon: <Layers className="h-4 w-4" />,
        text: 'ذاكرة WatermelonDB غير مهيأة. مخزن البيانات المحلي للعمل بدون اتصال لا يحتوي بيانات. قم بفتح التطبيق مرة واحدة مع اتصال بالسحابة لتحميل البيانات محلياً.',
        textEn: 'WatermelonDB cache is not initialized. The local offline data store has no data. Open the app once with cloud connectivity to download data locally.',
        textFr: 'Le cache WatermelonDB n\'est pas initialisé. Le magasin de données hors ligne n\'a pas de données. Ouvrez l\'application une fois avec connexion au cloud pour télécharger les données localement.',
      });
    }

    // 7. Cloud is down but offline is working
    if (!result.isCloudReachable && result.isBrowserOnline && isElectronApp && result.isLocalApiReachable && result.localApiAuthWorks && !result.localDbEmpty) {
      tips.push({
        icon: <CheckCircle2 className="h-4 w-4 text-emerald-500" />,
        text: 'التطبيق يعمل في وضع عدم الاتصال. التعديلات ستُزامن عند عودة السحابة.',
        textEn: 'App is running in offline mode. Changes will sync when Cloud returns.',
        textFr: 'L\'app fonctionne en mode hors ligne. Les modifications seront synchronisées au retour du Cloud.',
      });
    }

    // 8. No network at all
    if (!result.isBrowserOnline) {
      tips.push({
        icon: <WifiOff className="h-4 w-4" />,
        text: 'تحقق من اتصال الإنترنت والشبكة المحلية.',
        textEn: 'Check your internet connection and local network.',
        textFr: 'Vérifiez votre connexion Internet et réseau local.',
      });
    }

    // 9. Cloud is down (for non-Electron)
    if (!isElectronApp && !result.isCloudReachable && result.isBrowserOnline) {
      tips.push({
        icon: <Cloud className="h-4 w-4" />,
        text: 'خادم السحابة (Cloud API) لا يعمل. هذا التطبيق يعتمد على السحابة فقط.',
        textEn: 'Cloud API is down. This app relies on cloud connectivity only.',
        textFr: 'Cloud API est arrêté. Cette application dépend uniquement du cloud.',
      });
    }

    // 10. Everything green but still broken
    if (result.isCloudReachable && !isElectronApp) {
      // For web, if cloud works, everything should be fine
      tips.push({
        icon: <CheckCircle2 className="h-4 w-4 text-emerald-500" />,
        text: 'جميع المكونات تعمل بشكل طبيعي.',
        textEn: 'All components are working normally.',
        textFr: 'Tous les composants fonctionnent normalement.',
      });
    }

    if (isElectronApp && result.isLocalApiReachable && result.localApiHasSession && result.localApiAuthWorks && !result.localDbEmpty && result.hasZustandSession && result.hasLocalApiToken && result.tokenMatch) {
      // Everything is green
      if (!result.isCloudReachable) {
        tips.push({
          icon: <CheckCircle2 className="h-4 w-4 text-emerald-500" />,
          text: 'جميع الأنظمة المحلية تعمل بشكل طبيعي. وضع عدم الاتصال جاهز.',
          textEn: 'All local systems are healthy. Offline mode is ready.',
          textFr: 'Tous les systèmes locaux fonctionnent normalement. Le mode hors ligne est prêt.',
        });
      } else {
        tips.push({
          icon: <CheckCircle2 className="h-4 w-4 text-emerald-500" />,
          text: 'جميع المكونات تعمل بشكل طبيعي.',
          textEn: 'All components are working normally.',
          textFr: 'Tous les composants fonctionnent normalement.',
        });
      }
    }

    // 11. Catch-all: if nothing specific matches but there are errors
    if (tips.length === 0 && result.checks.some((c) => c.status === 'error' || c.status === 'warning')) {
      tips.push({
        icon: <Info className="h-4 w-4" />,
        text: 'جميع الأنظمة تبدو سليمة. حاول تحديث الصفحة. إذا استمرت المشكلة، تحقق من وحدة التحكم في المتصفح.',
        textEn: 'All systems appear healthy. Try refreshing the page. If the problem persists, check the browser console for errors.',
        textFr: 'Tous les systèmes semblent sains. Essayez de rafraîchir la page. Si le problème persiste, vérifiez la console du navigateur.',
      });
    }

    return tips;
  };

  const tips = getTips();

  // ─── Group definitions ────────────────────────────────────────────────────

  const groupLabels: Record<string, { ar: string; en: string; fr: string; icon: React.ReactNode }> = {
    'network': {
      ar: 'الشبكة',
      en: 'Network',
      fr: 'Réseau',
      icon: <Wifi className="h-3.5 w-3.5" />,
    },
    'local-api': {
      ar: 'الخادم المحلي (Electron)',
      en: 'Local API (Electron)',
      fr: 'API local (Electron)',
      icon: <Monitor className="h-3.5 w-3.5" />,
    },
    'client-auth': {
      ar: 'المصادقة (العميل)',
      en: 'Client-Side Auth',
      fr: 'Authentification (Client)',
      icon: <Shield className="h-3.5 w-3.5" />,
    },
    'data': {
      ar: 'توفر البيانات',
      en: 'Data Availability',
      fr: 'Disponibilité des données',
      icon: <Database className="h-3.5 w-3.5" />,
    },
  };

  const getGroupLabel = (groupId: string) => {
    const group = groupLabels[groupId];
    if (!group) return '';
    if (lang === 'fr') return group.fr;
    if (lang === 'en') return group.en;
    return group.ar;
  };

  // Group the checks
  const groupedChecks = result?.checks.reduce<Record<string, DiagnosticCheck[]>>((acc, check) => {
    if (!acc[check.group]) acc[check.group] = [];
    acc[check.group].push(check);
    return acc;
  }, {}) || {};

  const groupOrder = ['network', 'local-api', 'client-auth', 'data'];

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 backdrop-blur-sm p-4 pt-[8vh]"
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.95 }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            className="w-full max-w-lg bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-800 overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-800">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-lg shadow-emerald-500/20">
                  <Activity className="h-5 w-5 text-white" />
                </div>
                <div>
                  <h2 className="text-base font-bold text-foreground">
                    {lang === 'fr' ? 'Diagnostic hors ligne' : lang === 'en' ? 'Offline Diagnostics' : 'تشخيص وضع عدم الاتصال'}
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    {lang === 'fr'
                      ? `Exécuté ${runCount} fois`
                      : lang === 'en'
                        ? `Run ${runCount} time${runCount !== 1 ? 's' : ''}`
                        : `تم التشغيل ${runCount} مرة`}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {overallBadge()}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 rounded-lg"
                  onClick={onClose}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {/* Body */}
            <div className="px-5 py-4 max-h-[55vh] overflow-y-auto space-y-4 custom-scrollbar">
              {result ? (
                groupOrder.map((groupId) => {
                  const groupChecks = groupedChecks[groupId];
                  if (!groupChecks || groupChecks.length === 0) return null;

                  const groupDef = groupLabels[groupId];
                  const passedCount = groupChecks.filter((c) => c.status === 'success').length;
                  const totalCount = groupChecks.length;

                  return (
                    <div key={groupId}>
                      {/* Group header */}
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-muted-foreground">{groupDef.icon}</span>
                        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                          {getGroupLabel(groupId)}
                        </span>
                        <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded-full ${
                          passedCount === totalCount
                            ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400'
                            : passedCount > 0
                              ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400'
                              : 'bg-rose-100 dark:bg-rose-900/30 text-rose-700 dark:text-rose-400'
                        }`}>
                          {passedCount}/{totalCount}
                        </span>
                      </div>

                      {/* Group checks */}
                      <div className="space-y-2">
                        {groupChecks.map((check) => (
                          <motion.div
                            key={check.id}
                            initial={{ opacity: 0, x: -8 }}
                            animate={{ opacity: 1, x: 0 }}
                            className={`rounded-xl border p-3 transition-colors ${statusColor(check.status)}`}
                          >
                            <div className="flex items-start gap-3">
                              <div className="mt-0.5 flex-shrink-0">
                                {statusIcon(check.status)}
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center justify-between">
                                  <span className="text-sm font-semibold text-foreground">
                                    {getLabel(check)}
                                  </span>
                                  {check.duration != null && (
                                    <span className="text-[10px] text-muted-foreground font-mono">
                                      {check.duration}ms
                                    </span>
                                  )}
                                </div>
                                <p className="text-xs text-muted-foreground mt-0.5">
                                  {getMessage(check)}
                                </p>

                                {/* Expandable details per check */}
                                {check.details && (
                                  <button
                                    type="button"
                                    onClick={() => toggleCheckDetails(check.id)}
                                    className="mt-1.5 flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                                  >
                                    {expandedChecks.has(check.id) ? (
                                      <ChevronUp className="h-3 w-3" />
                                    ) : (
                                      <ChevronDown className="h-3 w-3" />
                                    )}
                                    {lang === 'fr' ? 'Détails' : lang === 'en' ? 'Details' : 'التفاصيل'}
                                  </button>
                                )}
                                {check.details && expandedChecks.has(check.id) && (
                                  <pre dir="ltr" className="mt-1.5 text-[10px] font-mono text-muted-foreground bg-black/5 dark:bg-white/5 rounded-lg p-2 overflow-x-auto whitespace-pre-wrap max-h-32 overflow-y-auto text-left">
                                    {check.details}
                                  </pre>
                                )}
                              </div>
                            </div>
                          </motion.div>
                        ))}
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="flex flex-col items-center justify-center py-12 gap-3">
                  <Loader2 className="h-8 w-8 animate-spin text-emerald-500" />
                  <p className="text-sm text-muted-foreground">
                    {lang === 'fr' ? 'Exécution des diagnostics...' : lang === 'en' ? 'Running diagnostics...' : 'جاري تشخيص...'}
                  </p>
                </div>
              )}
            </div>

            {/* Tips Section */}
            {tips.length > 0 && result && (
              <div className="px-5 pb-2">
                <div className="rounded-xl bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800/50 p-3 space-y-2">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-blue-700 dark:text-blue-400">
                    <Info className="h-3.5 w-3.5" />
                    {lang === 'fr' ? 'Conseils de dépannage' : lang === 'en' ? 'Troubleshooting Tips' : 'نصائح لحل المشاكل'}
                  </div>
                  {tips.map((tip, i) => (
                    <div key={i} className="flex items-start gap-2 text-xs text-blue-600 dark:text-blue-400">
                      <span className="mt-0.5 flex-shrink-0">{tip.icon}</span>
                      <span>
                        {lang === 'fr' ? tip.textFr : lang === 'en' ? tip.textEn : tip.text}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Footer */}
            <div className="flex items-center justify-between px-5 py-3 border-t border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-950/50">
              <div className="flex items-center gap-2">
                {result && (
                  <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {new Date(result.timestamp).toLocaleTimeString()}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  className="h-8 text-xs gap-1.5"
                  onClick={runDiagnostics}
                  disabled={isRunning}
                >
                  {isRunning ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5" />
                  )}
                  {isRunning
                    ? (lang === 'fr' ? 'Vérification...' : lang === 'en' ? 'Checking...' : 'جاري الفحص...')
                    : (lang === 'fr' ? 'Réexécuter' : lang === 'en' ? 'Re-run' : 'إعادة تشخيص')}
                </Button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
