'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  discoverLanServer,
  quickDiscover,
  onDiscoveryStateChange,
  clearCache,
  getServerLabel,
  getPlatformBadge,
  type DiscoveredServer,
  type DiscoveryState,
} from '@/lib/lan-discovery';
import {
  Wifi,
  WifiOff,
  Search,
  Monitor,
  CheckCircle,
  XCircle,
  RefreshCw,
  ArrowRight,
  Laptop,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

interface LanDiscoveryPanelProps {
  /** Called when a LAN server is discovered and selected */
  onServerSelected?: (server: DiscoveredServer) => void;
  /** Whether to auto-scan on mount */
  autoScan?: boolean;
  /** Compact mode for embedding in other components */
  compact?: boolean;
}

export function LanDiscoveryPanel({
  onServerSelected,
  autoScan = true,
  compact = false,
}: LanDiscoveryPanelProps) {
  const [discoveryState, setDiscoveryState] = useState<DiscoveryState>({
    status: 'idle',
    server: null,
    scannedCount: 0,
    totalToScan: 0,
  });
  const [manualIp, setManualIp] = useState('');
  const [manualConnecting, setManualConnecting] = useState(false);

  useEffect(() => {
    const unsubscribe = onDiscoveryStateChange(setDiscoveryState);
    return unsubscribe;
  }, []);

  const handleQuickDiscover = useCallback(async () => {
    const server = await quickDiscover();
    if (server) {
      setDiscoveryState({ status: 'found', server, scannedCount: 0, totalToScan: 0 });
    } else {
      setDiscoveryState({ status: 'failed', server: null, scannedCount: 0, totalToScan: 0 });
    }
  }, []);

  const handleFullScan = useCallback(async () => {
    const server = await discoverLanServer({
      skipCache: true,
      onProgress: setDiscoveryState,
    });
    if (server) {
      onServerSelected?.(server);
    }
  }, [onServerSelected]);

  const handleManualConnect = useCallback(async () => {
    if (!manualIp.trim()) return;
    setManualConnecting(true);

    try {
      // Try to discover the server at the manual IP
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);

      const response = await fetch(`http://${manualIp}:3080/api/discover`, {
        signal: controller.signal,
        mode: 'cors',
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        const server = await response.json();
        if (server.service === 'blasti-lan') {
          setDiscoveryState({ status: 'found', server, scannedCount: 0, totalToScan: 0 });
          onServerSelected?.(server);
        }
      }
    } catch {
      // Manual connection failed
    } finally {
      setManualConnecting(false);
    }
  }, [manualIp, onServerSelected]);

  const handleRescan = useCallback(() => {
    clearCache();
    handleFullScan();
  }, [handleFullScan]);

  const handleSelectServer = useCallback(() => {
    if (discoveryState.server) {
      onServerSelected?.(discoveryState.server);
    }
  }, [discoveryState.server, onServerSelected]);

  // Auto-scan on mount
  useEffect(() => {
    if (autoScan) {
      // Fire-and-forget: discovery updates state via listener callback
      quickDiscover().then((server) => {
        if (server) {
          setDiscoveryState({ status: 'found', server, scannedCount: 0, totalToScan: 0 });
        } else {
          setDiscoveryState({ status: 'failed', server: null, scannedCount: 0, totalToScan: 0 });
        }
      });
    }
  }, [autoScan]);

  // Compact mode
  if (compact) {
    return (
      <div className="flex items-center gap-2">
        {discoveryState.status === 'found' && discoveryState.server ? (
          <>
            <CheckCircle className="h-4 w-4 text-green-500" />
            <span className="text-sm text-green-700 dark:text-green-400">
              LAN: {getServerLabel(discoveryState.server)}
            </span>
            <Button variant="ghost" size="sm" onClick={handleRescan}>
              <RefreshCw className="h-3 w-3" />
            </Button>
          </>
        ) : discoveryState.status === 'scanning' ? (
          <>
            <Search className="h-4 w-4 animate-pulse text-amber-500" />
            <span className="text-sm text-amber-600 dark:text-amber-400">
              Scanning LAN...
            </span>
          </>
        ) : (
          <>
            <WifiOff className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">No LAN server</span>
            <Button variant="ghost" size="sm" onClick={handleQuickDiscover}>
              <Search className="h-3 w-3" />
            </Button>
          </>
        )}
      </div>
    );
  }

  // Full mode
  return (
    <Card className="w-full max-w-md">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Wifi className="h-5 w-5" />
          اكتشاف الشبكة المحلية
          <span className="text-sm text-muted-foreground font-normal">/ LAN Discovery</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Status */}
        <div className="flex items-center gap-3">
          {discoveryState.status === 'found' && discoveryState.server ? (
            <div className="flex-1 space-y-2">
              <div className="flex items-center gap-2">
                <CheckCircle className="h-5 w-5 text-green-500" />
                <span className="font-medium text-green-700 dark:text-green-400">تم العثور على الخادم / Server Found</span>
              </div>
              <div className="rounded-lg bg-green-50 dark:bg-green-950/20 p-3 text-sm space-y-1">
                <div className="flex items-center gap-2">
                  <Laptop className="h-4 w-4" />
                  <span className="font-medium">{getServerLabel(discoveryState.server)}</span>
                </div>
                <div className="text-muted-foreground">IP: {discoveryState.server.ip}:{discoveryState.server.port}</div>
                <div className="flex items-center gap-2">
                  <Monitor className="h-4 w-4" />
                  <span>{getPlatformBadge(discoveryState.server.platform)}{discoveryState.server.networkInterface ? ` · ${discoveryState.server.networkInterface}` : ''}</span>
                </div>
                {discoveryState.server.syncReady !== undefined && (
                  <div className="flex items-center gap-2">
                    <CheckCircle className="h-4 w-4" />
                    <span>{discoveryState.server.syncReady ? 'Sync Ready / جاهز للمزامنة' : 'Sync Not Ready'}</span>
                  </div>
                )}
              </div>
              <div className="flex gap-2">
                <Button onClick={handleSelectServer} size="sm" className="gap-1">
                  اتصل / Connect <ArrowRight className="h-3 w-3" />
                </Button>
                <Button variant="outline" size="sm" onClick={handleRescan} className="gap-1">
                  <RefreshCw className="h-3 w-3" /> إعادة البحث / Rescan
                </Button>
              </div>
            </div>
          ) : discoveryState.status === 'scanning' ? (
            <div className="flex-1 space-y-2">
              <div className="flex items-center gap-2">
                <Search className="h-5 w-5 animate-pulse text-amber-500" />
                <span className="text-amber-600 dark:text-amber-400">جاري البحث... / Scanning...</span>
              </div>
              {discoveryState.totalToScan > 0 && (
                <div className="w-full bg-muted rounded-full h-2">
                  <div
                    className="bg-amber-500 h-2 rounded-full transition-all"
                    style={{ width: `${Math.min(100, (discoveryState.scannedCount / discoveryState.totalToScan) * 100)}%` }}
                  />
                </div>
              )}
            </div>
          ) : discoveryState.status === 'failed' ? (
            <div className="flex-1 space-y-2">
              <div className="flex items-center gap-2">
                <XCircle className="h-5 w-5 text-red-500" />
                <span className="text-red-600 dark:text-red-400">لم يتم العثور على خادم / No server found</span>
              </div>
              <p className="text-sm text-muted-foreground">
                تأكد من تشغيل تطبيق بلاصتي على الكمبيوتر وأنك على نفس الشبكة
                <br />
                Make sure BLASTI Desktop is running and on the same network.
              </p>
              <Button variant="outline" size="sm" onClick={handleFullScan} className="gap-1">
                <Search className="h-3 w-3" /> بحث شامل / Full Scan
              </Button>
            </div>
          ) : (
            <div className="flex-1 space-y-2">
              <div className="flex items-center gap-2">
                <WifiOff className="h-5 w-5 text-muted-foreground" />
                <span className="text-muted-foreground">جاهز للبحث / Ready to scan</span>
              </div>
              <Button size="sm" onClick={handleQuickDiscover} className="gap-1">
                <Search className="h-3 w-3" /> بحث سريع / Quick Scan
              </Button>
            </div>
          )}
        </div>

        {/* Manual IP Entry */}
        <div className="border-t pt-3 space-y-2">
          <p className="text-xs text-muted-foreground">
            أدخل عنوان IP يدوياً / Enter IP manually:
          </p>
          <div className="flex gap-2">
            <Input
              placeholder="192.168.1.100"
              value={manualIp}
              onChange={(e) => setManualIp(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleManualConnect()}
              className="text-sm"
            />
            <Button
              size="sm"
              onClick={handleManualConnect}
              disabled={manualConnecting || !manualIp.trim()}
            >
              {manualConnecting ? <RefreshCw className="h-3 w-3 animate-spin" /> : 'اتصل / Connect'}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
