'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select } from '@/components/ui/select';
import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipProvider } from '@/components/ui/tooltip';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Radio,
  Wifi,
  WifiOff,
  Activity,
  Server,
  Globe,
  Network,
  Clock,
  Cast,
  Settings,
  RefreshCw,
  Database,
  ShieldCheck,
  Loader2,
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Plus,
  Trash2,
  Power,
  Globe as GlobeIcon,
  Clock as ClockIcon,
  ShieldCheck as ShieldIcon,
} from 'lucide-react';
import { useLanguage } from '@/hooks/use-language';
import { apiFetch } from '@/lib/api-fetch';

// ── Types ────────────────────────────────────────────────────────────────

interface ProtocolStatus {
  name: string;
  enabled: boolean;
  available: boolean;
  description: string;
}

interface NetworkInterface {
  name: string;
  address: string;
  netmask: string;
  cidr: string;
  family: string;
  internal: boolean;
  mac: string;
}

interface ScanHistoryEntry {
  id: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  subnets: string[];
  devicesFound: number;
  protocolsUsed: string[];
  status: string;
}

interface DiagnosticInfo {
  version: string;
  uptime: number;
  memoryUsage: { rss: number; heapUsed: number; heapTotal: number };
  databaseStats: { devices: number; scans: number; aliases: number; dbSizeBytes: number };
  config: Record<string, unknown>;
  networkInterfaces: NetworkInterface[];
  protocolAvailability: ProtocolStatus[];
  uptime: number;
}

// ── Config ──────────────────────────────────────────────────────────────────────

const DISCOVERY_SERVICE_URL = '/api?XTransformPort=3010';

// ── Helper ──────────────────────────────────────────────────────────────────────

function getLocalizedString(ar: string, fr: string, en: string, lang: string): string {
  if (lang === 'ar') return ar;
  if (lang === 'fr') return fr;
  return en;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function formatUptime(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const hrs = Math.floor(ms / 3600000);
  const mins = Math.floor((ms % 3600000) / 60000);
  return `${hrs}h ${mins}m`;
}

function getTimeSince(dateStr: string | null | undefined): string {
  if (!dateStr) return '—';
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  return `${Math.floor(min / 60)}h ${min % 60}s ago`;
}

// ── Sub-Components ────────────────────────────────────────────────────────────────

function ServiceStatusCard({ diagnostics }: { diagnostics: DiagnosticInfo }) {
  const isOk = diagnostics?.version ? true : false;
  return (
    <Card className="overflow-hidden">
      <CardHeader className="border-b border-border/50">
        <div className={`p-4 ${isOk ? 'bg-gradient-to-r from-emerald-500 to-teal-600 text-white' : 'bg-gradient-to-r from-amber-500 to-red-600 text-white'} rounded-t-xl`}>
          <CardTitle className="text-white text-sm font-semibold flex items-center gap-2">
            <Activity className={`h-5 w-5 ${isOk ? 'animate-pulse' : ''}`} />
            <span>
              {isOk
                ? getLocalizedString('متصل ونشيط', 'Service connecté', 'Connected', diagnostics?.version || 'v2.0')
                : getLocalizedString('غير متصل', 'Hors service', 'Disconnected', diagnostics?.version || '?')
              }
            </span>
          </CardTitle>
        </div>
      </CardHeader>
      <CardContent className="p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="space-y-1">
              <Label className="text-xs font-medium text-muted-foreground">
                {getLocalizedString('الإصدار', 'Version du service', 'Version', lang)}
              </Label>
              <p className="text-lg font-bold">{diagnostics?.version || '—'}</p>
            </div>
            <div className="space-y-1">
              <Label className="text-xs font-medium text-muted-foreground">
                {getLocalizedString('مدة التشغيل', 'Temps de fonctionnement', 'Uptime', lang)}
              </Label>
              <p className="text-xl font-mono">{formatUptime(diagnostics?.uptime || 0)}</p>
            </div>
            <div className="space-y-1">
              <Label className="text-xs font-medium text-muted-foreground">
                {getLocalizedString('استهلاك البيانات', 'Taille de la DB', 'DB Size', lang)}
              </Label>
              <p className="text-lg font-mono">{formatBytes(diagnostics?.databaseStats?.dbSizeBytes || 0)}</p>
            </div>
            <div className="space-y-1">
              <Label className="text-xs font-medium text-muted-foreground">
                {getLocalizedString('عدد الأجهزة المكتشفة', 'Discovered devices', 'Devices', lang)}
              </Label>
              <p className="text-2xl font-bold text-lg">{diagnostics?.deviceCount ?? 0}</p>
            </div>
            <div className="space-y-1">
              <Label className="text-xs font-medium text-muted-foreground">
                {getLocalizedString('حالة الذاكرة', 'Erreurs', 'Errors', lang)}
              </Label>
              <p className="text-2xl font-bold text-lg text-red-500">{diagnostics?.databaseStats?.scans ?? 0}</p>
            </div>
            <div className="space-y-1">
              <Label className="text-xs font-medium text-muted-foreground">
                {getLocalizedString('الذاكرة', 'Mémoire', 'Memory', lang)}
              </Label>
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground">RSS: {formatBytes(diagnostics?.memoryUsage?.rss)}</span>
                <span className="text-xs text-muted-foreground">Heap: {formatBytes(diagnostics?.memoryUsage?.heapUsed)}/{formatBytes(diagnostics?.memoryUsage?.heapTotal)}</span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    );
}

function ProtocolCard({ protocol, lang }: { protocol: ProtocolStatus; lang: string }) {
  const isAvailable = protocol.available;
  const isEnabled = protocol.enabled;
  return (
    <Card className="overflow-hidden">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className={`p-2 rounded-lg ${isAvailable && isEnabled ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400' : isAvailable ? 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400' : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400'} `}>
            {(() => {
              if (protocol.name === 'udp_bdp') return <Radio className="h-5 w-5" />;
              if (protocol.name === 'ssdp') return <Cast className="h-5 w-5" />;
              if (protocol.name === 'http_probe') return <Globe className="h-5 w-5" />;
              if (protocol.name === 'https_probe') return <Globe className="h-5 w-5" />;
              if (protocol.name === 'mdns') return <Wifi className="h-5 w-5" />;
              return <Settings className="h-5 w-5" />;
            })()}
          </div>
          <div className="flex-1 min-w-0 space-y-1">
            <h4 className="text-sm font-semibold">{getLocalizedString(protocol.description, protocol.description, lang)}</h4>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${isAvailable && isEnabled ? 'border-emerald-500 text-emerald-700 dark:border-emerald-900/40' : 'border-gray-300 dark:border-gray-700'}`}>
                {isAvailable
                  ? getLocalizedString('متاح', 'Disponible', 'Available', lang)
                  : getLocalizedString('غير متاح', 'Indisponible', 'Unavailable', lang)}
              </Badge>
            </div>
          </div>
          <div className="flex items-center gap-2 pt-2 border-t border-border/40">
            <div className="flex items-center gap-2">
              <Label className="text-xs font-medium">{getLocalizedString('مفعّل', 'Activé', 'Enabled', lang)}</Label>
              <Switch
                checked={isEnabled}
                onChecked={(checked) => {
                  apiFetch(`/api/protocols/${protocol.name}/${checked ? 'enable' : 'disable'}?XTransformPort=3010`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                  }).catch(() => {});
                }}
              />
            </div>
          </div>
        </div>
      </CardContent>
      </Card>
  );
}

// ── Network Interface Table ───────────────────────────────────────────────────────

function NetworkInterfacesTable({ interfaces, lang }: { interfaces: NetworkInterface[]; lang: string }) {
  return (
    <div className="rounded-xl border overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow className="border-b bg-muted/50">
            <TableHead>{getLocalizedString('الاسم', 'Nom', 'Name', lang)}</TableHead>
            <TableHead>{getLocalizedString('العنوان', 'IP Address', 'IP', lang)}</TableHead>
            <TableHead>{getLocalizedString('القناع', 'Netmask', 'Netmask', lang)}</TableHead>
            <TableHead>{getLocalizedString('CIDR', 'CIDR', 'CIDR', lang)}</TableHead>
            <TableHead>{getLocalizedString('عائلة', 'Family', 'Family', lang)}</TableHead>
            <TableHead>{getLocalizedString('MAC', 'MAC', 'MAC', lang)}</TableHead>
            <TableHead>{getLocalizedString('داخلي', 'Internal', 'Internal', lang)}</TableHead>
          </TableRow>
          {interfaces.map((iface) => (
            <TableRow key={iface.name} className="hover:bg-muted/30">
              <TableCell className="font-mono text-xs">{iface.name}</TableCell>
              <TableCell className="font-mono text-xs">{iface.address}</TableCell>
              <TableCell className="font-mono text-xs text-muted-foreground">{iface.netmask}</TableCell>
              <TableCell className="font-mono text-xs">{iface.cidr}</TableCell>
              <TableCell className="font-mono text-xs">{iface.family}</TableCell>
              <TableCell className="font-mono text-xs font-mono" style={{ letterSpacing: '0.05em' }}>{iface.mac}</TableCell>
              <TableCell className="text-center">
                {iface.internal
                  ? <Badge variant="secondary" className="bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400 px-1.5 py-0 text-[10px]">
                    {getLocalizedString('داخلي', 'Interne', 'Internal', lang)}
                  </Badge>
                : <span className="text-gray-400 text-xs">{getLocalizedString('خارجي', 'Externe', 'External', lang)}</span>}
              </TableCell>
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {interfaces.length === 0 && (
            <TableRow className="hover:bg-muted/30">
              <TableCell colSpan={7} className="text-center text-muted-foreground text-sm py-8">
                {getLocalizedString('لا توجد واجهات شبكة', 'Aucune interface trouvée', 'No interfaces found', lang)}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}

// ── Scan Settings ───────────────────────────────────────────────────────────────

function ScanSettingsForm({ config, onConfigChange, lang }: {
  config: any;
  onConfigChange: (config: any) => void;
  lang: string;
}) {
  const [form, setForm] = useState(config);
  const [saving, setSaving] = useState(false);

  const updateField = useCallback(
    (key: string, value: string | number) => {
      const updated = { ...form, [key]: value };
      setForm(updated);
    },
    [form, setForm],
  );

  const handleSave = useCallback(() => {
    setSaving(true);
    apiFetch(`${DISCOVERY_SERVICE_URL}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${localStorage.getItem('blasti-discovery-token') || ''}`,
      },
      body: JSON.stringify(form),
    })
      .then(() => {
        setSaving(false);
      })
      .catch(() => {
        setSaving(false);
      });
    }, [form, saving]);

  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Settings className="h-5 w-5 bg-gradient-to-r from-teal-500 to-teal-600 text-white rounded-lg" />
          <span>{getLocalizedString('إعدادات الفحص', 'Paramètres de scan', 'Scan Settings', lang)}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-4 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label className="text-sm font-medium">{getLocalizedString('مهلة الفحص (مللي ثانية)', 'Scan Timeout (ms)', 'Scan Timeout (ms)', lang)}</Label>
            <Input
              type="number"
              value={form.scan?.scanTimeout ?? 800}
              onChange={(e) => updateField('scan.scanTimeout', parseInt(e.target.value))}
              className="h-9"
              min={100}
              max={60000}
              step={100}
            />
          </div>
          <div className="space-y-2">
            <Label className="text-sm font-medium">{getLocalizedString('التزامنية', 'Concurrency', 'Concurrency', lang)}</Label>
            <Input
              type="number"
              value={form.scan?.concurrency ?? 20}
              onChange={(e) => updateField('scan.concurrency', parseInt(e.target.value))}
              className="h-9"
              min={1}
              max={200}
            />
          </div>
          <div className="space-y-2">
            <Label className="text-sm font-medium">{getLocalizedString('عدد المحاولات', 'Retry Count', 'Retry Count', lang)}</Label>
            <Input
              type="number"
              value={form.scan?.retryCount ?? 2}
              onChange={(e) => updateField('scan.retryCount', parseInt(e.target.value))}
              className="h-9"
              min={0}
              max={20}
            />
          </div>
          <div className="space-y-2">
            <Label className="text-sm font-medium">{getLocalizedString('منافذ الافتر الدخول (ملى ثانية)', 'Heartbeat Interval (ms)', 'Heartbeat Interval (ms)', lang)}</Label>
            <Input
              type="number"
              value={form.scan?.heartbeatInterval ?? 15000}
              onChange={(e) => updateField('scan.heartbeatInterval', parseInt(e.target.value))}
              className="h-9"
              min={5000}
              max={120000}
              step={1000}
            />
          </div>
          <div className="space-y-2">
            <Label className="text-sm font-medium">{getLocalizedString('مهلة انتهاء الصلاحية (مللي ثانية)', 'Stale Timeout (ms)', 'Stale Timeout (ms)', lang)}</Label>
            <Input
              type="number"
              value={form.scan?.staleTimeout ?? 300000}
              onChange={(e) => updateField('scan.staleTimeout', parseInt(e.target.value))}
              className="h-9"
              min={30000}
              max={3600000}
              step={10000}
            />
          </div>
          <div className="space-y-2">
            <Label className="text-sm font-medium">{getLocalizedString('مهلة الحذف (مللي ثانية)', 'Removal Timeout (ms)', 'Removal Timeout (ms)', lang)}</Label>
            <Input
              type="number"
              value={form.scan?.removalTimeout ?? 600000}
              onChange={(e) => updateField('scan.removalTimeout', parseInt(e.target.value))}
              className="h-9"
              min={60000}
              max={3600000}
              step={10000}
            />
          </div>
          <div className="pt-4">
            <Button
              onClick={handleSave}
              disabled={saving}
              className="w-full gap-2 bg-gradient-to-r from-teal-500 to-teal-600 hover:from-teal-600 hover:from-teal-700 text-white shadow-md disabled:opacity-50"
            >
              {saving ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {getLocalizedString('جاري الحفظ...', 'Saving...', 'Saving...', lang)}
                </>
              ) : (
                <>
                  <CheckCircle2 className="h-4 w-4" />
                  {getLocalizedString('حفظ الإعدادات', 'Save Settings', 'Save Settings', lang)}
                </>
              )}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Auto-Scan Schedule ───────────────────────────────────────────────────

function AutoScanSchedule({ config, onConfigChange, lang }: {
  config: any;
  onConfigChange: (config: any) => void;
  lang: string;
}) {
  const [autoScanEnabled, setAutoScanEnabled] = useState(config.scan?.schedules?.autoScan ?? false);
  const [lastScanAt, setLastScanAt] = useState<string | null>(null);

  const intervalMs = config.scan?.schedules?.autoScanIntervalMs ?? 300000;

  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Clock className="h-5 w-5 bg-gradient-to-r from-cyan-500 to-teal-600 text-white rounded-lg" />
          <span>{getLocalizedString('جدولة الفحص التلقائي', 'Auto-Scan Schedule', 'Auto-Scan Schedule', lang)}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-4 space-y-4">
        <div className="flex items-center gap-4">
          <div className="flex-1">
            <Switch
              checked={autoScanEnabled}
              onChecked={(checked) => {
                const cfg = { ...config };
                cfg.scan.schedules.autoScan = checked;
                cfg.scan.schedules.autoScanIntervalMs = intervalMs;
                onConfigChange(cfg);
              }}
            />
            <Label htmlFor="auto-scan-toggle" className="text-xs text-muted-foreground cursor-pointer">
              {getLocalizedString('تفعيل تلقائي', 'Enable auto-scan', 'Enable auto-scan', lang)}
            </Label>
          </div>
          <div className="flex-1">
            <div className="space-y-1">
              <Label className="text-xs font-medium">{getLocalizedString('الفاصل (كل ... ثانية)', 'Interval', 'Interval', lang)}</Label>
              <Select
                value={String(intervalMs / 1000)}
                onValueChange={(v) => {
                  const ms = parseInt(v);
                  const cfg = { ...config };
                  cfg.scan.schedules.autoScanIntervalMs = ms * 1000;
                  onConfigChange(cfg);
                }}
                disabled={!autoScanEnabled}
                className="w-full h-9"
              >
                <option value="30">{getLocalizedString('30 ثانية', '30s', '30s', lang)}</option>
                <option value="60">{getLocalizedString('دقيقة واحدة', '1 minute', '1min', lang)}</option>
                <option value="300">{getLocalizedString('5 دقائق', '5min', '5min', lang)}</option>
                <option value="600">{getLocalizedString('10 دقائق', '10min', '10min', lang)}</option>
                <option value="1800">{getLocalizedString('30 دقيقة', '30min', '30min', lang)}</option>
              </Select>
            </div>
          </div>
          <div className="flex items-center gap-2 text-sm">
            {lastScanAt ? (
              <>
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                <span className="text-xs text-muted-foreground">
                  {getTimeSince(lastScanAt)}
                </span>
              </>
            ) : (
              <span className="text-xs text-muted-foreground">
                {getLocalizedString('لا توجد فحوص بعد', 'No scans yet', 'No scans yet', lang)}
              </span>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Scan History Table ───────────────────────────────────────────────────────────────

function ScanHistoryTable({ scans, lang }: { scans: ScanHistoryEntry[]; lang: string }) {
  if (scans.length === 0) {
    return (
      <Card className="overflow-hidden">
        <CardContent className="p-6 text-center">
          <WifiOff className="h-10 w-10 mx-auto text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            {getLocalizedString('لا توجد سجل فحص بعد', 'No scans yet', 'No scans yet', lang)}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <div className="space-y-6 p-4 md:p-6 max-w-7xl mx-auto">
        {/* Service Status */}
        <ServiceStatusCard diagnostics={undefined} />

        {/* Protocol Management */}
        <ProtocolCard protocols={[] /* filled by the parent */} lang={lang} />

        {/* Network Configuration */}
        <NetworkInterfacesTable interfaces={[] /* filled by the parent */} lang={lang} />

        {/* Scan Settings */}
        <ScanSettingsForm config={config} onConfigChange={onConfigChange} lang={lang} />

        {/* Auto-Scan Schedule */}
        <AutoScanSchedule config={config} onConfigChange={onConfigChange} lang={lang} />

        {/* Scan History */}
        <ScanHistoryTable scans={scans} lang={lang} />
      </div>
    </>
  );
}