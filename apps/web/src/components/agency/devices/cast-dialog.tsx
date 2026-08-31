'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Cast,
  Tv,
  Loader2,
  CheckCircle2,
  XCircle,
  Radio,
  Wifi,
  Cpu,
  Monitor,
  Play,
  Pause,
  Square,
  ExternalLink,
  Info,
} from 'lucide-react';
import { useLanguage } from '@/hooks/use-language';
import { getLocalizedName, type RealDiscoveredDevice } from './types';
import { getCastApi } from '@/lib/google-cast';

const PORT_Q = 'XTransformPort=3003';

// ── Protocol metadata ──────────────────────────────────────────────────────

type ProtocolKey = 'auto' | 'dlna' | 'samsung-tizen' | 'lg-webos' | 'roku-ecp' | 'google-cast' | 'url';

interface ProtocolOption {
  value: ProtocolKey;
  labelKey: string;
  icon: typeof Cast;
  description?: string;
  available?: boolean;
}

interface DetectedProtocol {
  protocol: 'dlna' | 'samsung-tizen' | 'lg-webos' | 'roku-ecp' | 'url';
  label: string;
  available: boolean;
  description: string;
}

type CastStatus = 'idle' | 'sending' | 'active' | 'error';

// ── Cast Dialog Component ──────────────────────────────────────────────────

interface CastDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  device: RealDiscoveredDevice | null;
  agencyId?: string;
  onToast: (type: 'success' | 'error' | 'info', message: string) => void;
}

export function CastDialog({ open, onOpenChange, device, agencyId, onToast }: CastDialogProps) {
  const { t, lang } = useLanguage();
  const [protocols, setProtocols] = useState<DetectedProtocol[]>([]);
  const [googleCastAvailable, setGoogleCastAvailable] = useState(false);
  const [googleCastChecking, setGoogleCastChecking] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [selected, setSelected] = useState<ProtocolKey>('auto');
  const [mirror, setMirror] = useState(false);
  const [status, setStatus] = useState<CastStatus>('idle');
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [lastProtocol, setLastProtocol] = useState<string>('');

  // Refs to the live Google Cast session so we can pause/play/stop it.
  const castApiRef = useRef<Awaited<ReturnType<typeof getCastApi>> | null>(null);

  // ── Detect protocols when the dialog opens ──────────────────────────────
  useEffect(() => {
    if (!open || !device) return;
    let cancelled = false;
    setDetecting(true);
    setProtocols([]);
    setGoogleCastAvailable(false);
    setSelected('auto');
    setStatus('idle');
    setStatusMessage('');

    (async () => {
      // 1. Backend detection (DLNA / Samsung / LG / Roku) via the real
      //    detectCastProtocols() helper.
      try {
        const params = new URLSearchParams({
          ip: device.ip,
          XTransformPort: '3003',
        });
        if (device.port) params.set('port', String(device.port));
        if (device.manufacturer) params.set('manufacturer', device.manufacturer);
        if (device.macVendor) params.set('manufacturer', device.macVendor);
        if (device.model) params.set('model', device.model);
        if (device.ssdpLocation) params.set('ssdpLocation', device.ssdpLocation);
        if (device.mdnsService) params.set('mdnsService', device.mdnsService);

        const res = await fetch(`/api/agency-devices/discovery/cast/protocols?${params}`);
        const data = await res.json();
        if (!cancelled && data.success) {
          setProtocols(data.protocols || []);
          setGoogleCastAvailable(!!data.googleCast?.available);
        }
      } catch {
        /* network error — fall back to all protocols shown */
      }

      // 2. Frontend Google Cast SDK availability check (real Chromecast).
      if (!cancelled) {
        setGoogleCastChecking(true);
        try {
          const cast = await getCastApi();
          if (!cancelled) {
            setGoogleCastAvailable(cast.available);
            castApiRef.current = cast;
          }
        } catch {
          /* ignore */
        } finally {
          if (!cancelled) setGoogleCastChecking(false);
        }
      }

      if (!cancelled) setDetecting(false);
    })();

    return () => { cancelled = true; };
  }, [open, device]);

  // ── Build the list of selectable protocol options ───────────────────────
  const options: ProtocolOption[] = [
    { value: 'auto', labelKey: 'dmCastProtocolAuto', icon: Radio, available: true },
    ...protocols.map((p) => ({
      value: p.protocol as ProtocolKey,
      labelKey: protocolLabelKey(p.protocol),
      icon: protocolIcon(p.protocol),
      available: p.available,
      description: p.description,
    })),
    {
      value: 'google-cast',
      labelKey: 'dmCastProtocolGoogle',
      icon: Cast,
      available: googleCastAvailable,
      description: t('dmCastGoogleHint'),
    },
  ];

  const hasAnyAvailable = options.some((o) => o.value !== 'auto' && o.value !== 'url' && o.available);

  // ── Detect insecure context (Google Cast SDK requires HTTPS or localhost) ─
  const isInsecureContext = typeof window !== 'undefined'
    ? (window.location.protocol !== 'https:' && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1')
    : false;

  // ── Start cast ──────────────────────────────────────────────────────────
  const handleStartCast = useCallback(async () => {
    if (!device) return;
    setStatus('sending');
    setStatusMessage(t('dmCastStatusSending'));

    const tvBoardUrl = `${window.location.origin}/?mode=device&type=TV&agencyId=${agencyId || ''}`;
    const protocol = selected === 'auto' ? undefined : selected;

    try {
      // Google Cast uses the frontend Cast Sender SDK (real Chromecast).
      if (selected === 'google-cast') {
        const cast = castApiRef.current ?? (await getCastApi());
        if (!cast.available) {
          throw new Error(t('dmCastGoogleHint'));
        }
        await cast.requestSession(tvBoardUrl, device.name || 'BLASTI TV Board');
        setStatus('active');
        setLastProtocol('google-cast');
        setStatusMessage(t('dmCastSuccessGoogle'));
        onToast('success', t('dmCastSuccessGoogle'));
        return;
      }

      // All other protocols go through the backend cast service.
      const body: Record<string, unknown> = {
        ip: device.ip,
        port: device.port,
        manufacturer: device.manufacturer || device.macVendor,
        model: device.model,
        ssdpLocation: device.ssdpLocation,
        mdnsService: device.mdnsService,
        name: device.name,
        mirror,
      };
      if (protocol && protocol !== 'url') {
        body.protocol = protocol;
      }

      const endpoint = protocol && protocol !== 'url'
        ? `/api/agency-devices/discovery/cast/${endpointForProtocol(protocol)}?${PORT_Q}`
        : `/api/agency-devices/discovery/cast?${PORT_Q}`;

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();

      if (data.success) {
        const usedProtocol = data.protocol || (protocol ?? 'url');
        setLastProtocol(usedProtocol);
        if (usedProtocol === 'url') {
          // Open URL fallback in a new tab — no active session to control.
          if (data.tvBoardUrl) window.open(data.tvBoardUrl, '_blank');
          setStatus('idle');
          setStatusMessage(t('dmCastSuccessUrl'));
          onToast('info', t('dmCastSuccessUrl'));
        } else {
          setStatus('active');
          const msg = successMessageFor(usedProtocol, t);
          setStatusMessage(msg);
          onToast('success', msg);
        }
      } else {
        // Protocol failed — auto-fallback to opening the URL in a new tab.
        // The user can then cast it from Chrome's built-in Cast menu
        // (right-click → Cast), which works on any Chromecast-enabled TV
        // regardless of the app's secure-context limitations.
        const reason = data.message || data.error || 'Unknown error';
        window.open(tvBoardUrl, '_blank');
        setStatus('idle');
        const fallbackMsg = t('dmCastFailedFallback').replace('{reason}', reason);
        setStatusMessage(fallbackMsg);
        onToast('info', fallbackMsg);
      }
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      // Auto-fallback: open the URL so the user can cast via Chrome.
      window.open(tvBoardUrl, '_blank');
      setStatus('idle');
      const fallbackMsg = t('dmCastFailedFallback').replace('{reason}', reason);
      setStatusMessage(fallbackMsg);
      onToast('info', fallbackMsg);
    }
  }, [device, agencyId, selected, mirror, t, onToast]);

  // ── Stop cast ───────────────────────────────────────────────────────────
  const handleStopCast = useCallback(async () => {
    if (!device) return;

    // Stop Google Cast session via the frontend SDK.
    if (lastProtocol === 'google-cast' && castApiRef.current) {
      try {
        await castApiRef.current.stop();
        setStatus('idle');
        setStatusMessage(t('dmCastStopped'));
        onToast('info', t('dmCastStopped'));
      } catch {
        /* ignore */
      }
      return;
    }

    // Stop DLNA session via the backend SOAP Stop command.
    try {
      await fetch(`/api/agency-devices/discovery/cast/stop?${PORT_Q}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ip: device.ip,
          ssdpLocation: device.ssdpLocation,
          manufacturer: device.manufacturer || device.macVendor,
        }),
      });
      setStatus('idle');
      setStatusMessage(t('dmCastStopped'));
      onToast('info', t('dmCastStopped'));
    } catch {
      /* ignore */
    }
  }, [device, lastProtocol, t, onToast]);

  // ── Pause / Resume (Google Cast only — DLNA has no transport control) ──
  const handlePause = useCallback(async () => {
    if (lastProtocol !== 'google-cast' || !castApiRef.current) return;
    try { await castApiRef.current.pause(); } catch { /* ignore */ }
  }, [lastProtocol]);

  const handleResume = useCallback(async () => {
    if (lastProtocol !== 'google-cast' || !castApiRef.current) return;
    try { await castApiRef.current.play(); } catch { /* ignore */ }
  }, [lastProtocol]);

  const handleOpenUrl = useCallback(() => {
    const url = `${window.location.origin}/?mode=device&type=TV&agencyId=${agencyId || ''}`;
    window.open(url, '_blank');
    setStatus('idle');
    setStatusMessage(t('dmCastSuccessUrl'));
    onToast('info', t('dmCastSuccessUrl'));
  }, [agencyId, t, onToast]);

  if (!device) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-gradient-to-br from-cyan-500 to-blue-600 text-white shadow-lg shrink-0">
              <Cast className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <DialogTitle className="text-base">{t('dmCastDialogTitle')}</DialogTitle>
              <DialogDescription className="text-xs">{t('dmCastDialogSubtitle')}</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {/* Target TV summary */}
        <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
          <div className="flex items-center gap-2">
            <Tv className="h-4 w-4 text-cyan-600 dark:text-cyan-400 shrink-0" />
            <span className="text-xs text-muted-foreground shrink-0">{t('dmCastTarget')}:</span>
            <span className="text-sm font-semibold truncate">{getLocalizedName(device, lang)}</span>
          </div>
          <div className="flex items-center gap-2 flex-wrap text-[10px] text-muted-foreground">
            <Badge variant="outline" className="font-mono text-[10px] px-1.5 py-0">
              {device.ip}{device.port ? `:${device.port}` : ''}
            </Badge>
            {device.manufacturer && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0">{device.manufacturer}</Badge>
            )}
            {device.macVendor && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0">{device.macVendor}</Badge>
            )}
            {device.mdnsService && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-mono">{device.mdnsService}</Badge>
            )}
          </div>
        </div>

        {/* Protocol detection */}
        {detecting ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('dmCastDetecting')}
            </div>
            <Skeleton className="h-20 w-full" />
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <Label className="text-xs font-medium mb-2 block">{t('dmCastProtocol')}</Label>
              <RadioGroup
                value={selected}
                onValueChange={(v) => setSelected(v as ProtocolKey)}
                className="space-y-1.5"
              >
                {options.map((opt) => {
                  const Icon = opt.icon;
                  const isAvailable = opt.value === 'auto' || opt.value === 'url' || opt.available;
                  return (
                    <label
                      key={opt.value}
                      htmlFor={`proto-${opt.value}`}
                      className={`flex items-start gap-2.5 rounded-lg border p-2.5 cursor-pointer transition-colors ${
                        selected === opt.value
                          ? 'border-cyan-400 bg-cyan-50 dark:border-cyan-700 dark:bg-cyan-950/30'
                          : isAvailable
                            ? 'border-border hover:bg-muted/50'
                            : 'border-dashed border-muted-foreground/30 opacity-60 cursor-not-allowed'
                      }`}
                    >
                      <RadioGroupItem
                        id={`proto-${opt.value}`}
                        value={opt.value}
                        disabled={!isAvailable}
                        className="mt-0.5"
                      />
                      <Icon className={`h-4 w-4 mt-0.5 shrink-0 ${
                        opt.value === 'google-cast' ? 'text-cyan-600 dark:text-cyan-400' : 'text-muted-foreground'
                      }`} />
                      <div className="flex-1 min-w-0 space-y-0.5">
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-medium">{protocolDisplayLabel(opt.value, t)}</span>
                          {opt.value !== 'auto' && opt.value !== 'url' && (
                            <Badge
                              variant="secondary"
                              className={`text-[9px] px-1 py-0 ${
                                opt.available
                                  ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400'
                                  : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-500'
                              }`}
                            >
                              {opt.available ? t('dmCastAvailable') : t('dmCastUnavailable')}
                            </Badge>
                          )}
                          {opt.value === 'google-cast' && googleCastChecking && (
                            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                          )}
                        </div>
                        {opt.description && (
                          <p className="text-[11px] text-muted-foreground leading-snug">{opt.description}</p>
                        )}
                      </div>
                    </label>
                  );
                })}
              </RadioGroup>
            </div>

            {/* Screen mirror toggle */}
            <div className="flex items-start gap-3 rounded-lg border border-dashed border-cyan-300 dark:border-cyan-800 bg-cyan-50/40 dark:bg-cyan-950/20 p-3">
              <Switch
                id="cast-mirror"
                checked={mirror}
                onCheckedChange={setMirror}
                className="data-[state=checked]:bg-cyan-600 mt-0.5"
              />
              <div className="flex-1 space-y-0.5">
                <Label htmlFor="cast-mirror" className="text-xs font-medium cursor-pointer flex items-center gap-1.5">
                  <Monitor className="h-3.5 w-3.5" />
                  {t('dmCastMirror')}
                </Label>
                <p className="text-[11px] text-muted-foreground leading-snug">{t('dmCastMirrorHint')}</p>
              </div>
            </div>

            {!hasAnyAvailable && !detecting && (
              <div className="flex items-start gap-2 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 p-2.5">
                <Info className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
                <p className="text-[11px] text-amber-700 dark:text-amber-400">{t('dmCastNoProtocol')}</p>
              </div>
            )}

            {/* Insecure context warning — Google Cast SDK won't load over HTTP LAN IP */}
            {isInsecureContext && !googleCastAvailable && !detecting && (
              <div className="flex items-start gap-2 rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 p-2.5">
                <Info className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400 mt-0.5 shrink-0" />
                <div className="text-[11px] text-blue-700 dark:text-blue-400 space-y-1">
                  <p>{t('dmCastInsecureContext')}</p>
                  <button
                    type="button"
                    onClick={handleOpenUrl}
                    className="font-semibold underline underline-offset-2 hover:text-blue-800 dark:hover:text-blue-300"
                  >
                    {t('dmCastOpenUrl')} →
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Status banner */}
        <AnimatePresence>
          {status !== 'idle' && statusMessage && (
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              className={`flex items-center gap-2 rounded-lg p-2.5 text-xs ${
                status === 'active'
                  ? 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800'
                  : status === 'error'
                    ? 'bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-400 border border-red-200 dark:border-red-800'
                    : 'bg-cyan-50 dark:bg-cyan-950/30 text-cyan-700 dark:text-cyan-400 border border-cyan-200 dark:border-cyan-800'
              }`}
            >
              {status === 'sending' && <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />}
              {status === 'active' && <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />}
              {status === 'error' && <XCircle className="h-3.5 w-3.5 shrink-0" />}
              <span className="flex-1">{statusMessage}</span>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Transport controls (Google Cast only) */}
        {status === 'active' && lastProtocol === 'google-cast' && (
          <div className="flex items-center justify-center gap-2">
            <Button size="sm" variant="outline" onClick={handlePause} className="gap-1.5 h-8">
              <Pause className="h-3.5 w-3.5" />{t('dmCastPause')}
            </Button>
            <Button size="sm" variant="outline" onClick={handleResume} className="gap-1.5 h-8">
              <Play className="h-3.5 w-3.5" />{t('dmCastResume')}
            </Button>
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-2 flex-col sm:flex-col">
          {status === 'active' ? (
            <Button
              onClick={handleStopCast}
              variant="destructive"
              className="w-full gap-1.5"
            >
              <Square className="h-4 w-4" />
              {t('dmCastStop')}
            </Button>
          ) : (
            <div className="flex gap-2 w-full">
              <Button
                variant="outline"
                onClick={handleOpenUrl}
                className="gap-1.5 flex-1"
                disabled={detecting}
              >
                <ExternalLink className="h-4 w-4" />
                {t('dmCastOpenUrl')}
              </Button>
              <Button
                onClick={handleStartCast}
                disabled={detecting || status === 'sending'}
                className="gap-1.5 flex-1 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-600 hover:to-blue-700 text-white"
              >
                {status === 'sending' ? (
                  <><Loader2 className="h-4 w-4 animate-spin" />{t('dmCastStatusSending')}</>
                ) : (
                  <><Cast className="h-4 w-4" />{t('dmCastStart')}</>
                )}
              </Button>
            </div>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function protocolLabelKey(p: string): string {
  switch (p) {
    case 'dlna': return 'dmCastProtocolDlna';
    case 'samsung-tizen': return 'dmCastProtocolSamsung';
    case 'lg-webos': return 'dmCastProtocolLg';
    case 'roku-ecp': return 'dmCastProtocolRoku';
    case 'url': return 'dmCastProtocolUrl';
    default: return 'dmCastProtocolAuto';
  }
}

function protocolDisplayLabel(value: ProtocolKey, t: (k: any) => string): string {
  switch (value) {
    case 'auto': return t('dmCastProtocolAuto');
    case 'dlna': return t('dmCastProtocolDlna');
    case 'samsung-tizen': return t('dmCastProtocolSamsung');
    case 'lg-webos': return t('dmCastProtocolLg');
    case 'roku-ecp': return t('dmCastProtocolRoku');
    case 'google-cast': return t('dmCastProtocolGoogle');
    case 'url': return t('dmCastProtocolUrl');
    default: return value;
  }
}

function protocolIcon(p: string): typeof Cast {
  switch (p) {
    case 'dlna': return Wifi;
    case 'samsung-tizen': return Tv;
    case 'lg-webos': return Tv;
    case 'roku-ecp': return Tv;
    case 'url': return ExternalLink;
    default: return Cpu;
  }
}

function endpointForProtocol(p: ProtocolKey): string {
  switch (p) {
    case 'dlna': return 'dlna';
    case 'samsung-tizen': return 'samsung';
    case 'lg-webos': return 'lg';
    case 'roku-ecp': return 'roku';
    default: return '';
  }
}

function successMessageFor(protocol: string, t: (k: any) => string): string {
  switch (protocol) {
    case 'dlna': return t('dmCastSuccessDlna');
    case 'samsung-tizen': return t('dmCastSuccessSamsung');
    case 'lg-webos': return t('dmCastSuccessLg');
    case 'roku-ecp': return t('dmCastSuccessRoku');
    case 'google-cast': return t('dmCastSuccessGoogle');
    case 'url': return t('dmCastSuccessUrl');
    default: return t('dmCastSuccessUrl');
  }
}
