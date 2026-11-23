'use client';

// ─── 0.6.114 — KIOSK PRINTER SETTINGS (the setting ON the kiosk) ────────────
// User requirement: "there is no setting for select default printer for kiosk
// among registered printers". The Device Manager kiosk card already carries a
// Default-printer select (0.6.104), but the operator standing IN FRONT of the
// kiosk had NO surface — and a kiosk whose pair was saved only on one store
// never showed a manager card to configure at all.
//
// This sheet lists the agency's REGISTERED printers (PRINTER AgencyDevice
// rows, via GET /api/agency-devices/device/printer-options — Bearer device
// token, works LAN-direct AND against the cloud through the apiFetch
// failover) and persists the pick on the KIOSK'S OWN row via POST
// /api/agency-devices/device/printer-default (printerConfig
// .defaultPrinterDeviceId — the exact key the receipt print route resolves).
// From the ticket screen the "Print receipt" button therefore prints DIRECTLY
// on the printer chosen here (no receipt popup — popup fallback removed).

import { useCallback, useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Printer, Loader2, X, Check, AlertTriangle, Wifi, Cable } from 'lucide-react';
import { apiFetch } from '@/lib/api-fetch';
import { toast } from 'sonner';

interface PrinterOption {
  id: string;
  name: string;
  nameAr: string | null;
  nameFr: string | null;
  connectionType: string;
  ipAddress: string | null;
  port: number | null;
  attachment: string | null;
  hostIp: string | null;
  cupsName: string | null;
}

export interface KioskPrinterSettingsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The kiosk's device token (canonical). Null = not paired yet. */
  deviceToken: string | null;
  t: (key: string) => string;
  lang: string;
}

/** Localized printer label (agency devices carry nameAr/nameFr). */
function printerLabel(p: PrinterOption, lang: string): string {
  if (lang === 'ar' && p.nameAr) return p.nameAr;
  if (lang === 'fr' && p.nameFr) return p.nameFr;
  return p.name;
}

/** How the receipt would reach this printer (delivery path hint). */
function deliveryHint(p: PrinterOption): string {
  if (p.attachment === 'USB' && p.hostIp) return `USB @ ${p.hostIp}`;
  if (p.attachment === 'USB') return 'USB';
  if (p.ipAddress) return `${p.ipAddress}${p.port ? `:${p.port}` : ''}`;
  return p.connectionType;
}

export function KioskPrinterSettings({ open, onOpenChange, deviceToken, t, lang }: KioskPrinterSettingsProps) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [printers, setPrinters] = useState<PrinterOption[]>([]);
  const [assignedId, setAssignedId] = useState('');
  const [agencyDefault, setAgencyDefault] = useState<{ name: string | null; ip: string | null } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const fetchOptions = useCallback(async () => {
    if (!deviceToken) return;
    setLoading(true);
    setLoadError(null);
    try {
      const res = await apiFetch('/api/agency-devices/device/printer-options', {
        headers: { Authorization: `Bearer ${deviceToken}` },
        timeout: 10_000,
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.success) {
        setPrinters(Array.isArray(data.printers) ? data.printers : []);
        setAssignedId(typeof data.assignedPrinterId === 'string' ? data.assignedPrinterId : '');
        setAgencyDefault(data.agencyDefault || null);
      } else {
        setLoadError(data?.error || `Could not load printers (${res.status})`);
      }
    } catch {
      setLoadError(t('kioskPrinterUnreachable') || 'Printer service unreachable');
    } finally {
      setLoading(false);
    }
  }, [deviceToken, t]);

  // Load (and reload on every open) so the list always reflects the manager.
  useEffect(() => {
    if (open) void fetchOptions();
  }, [open, fetchOptions]);

  const save = useCallback(async (printerId: string) => {
    if (!deviceToken || saving) return;
    setSaving(true);
    try {
      const res = await apiFetch('/api/agency-devices/device/printer-default', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${deviceToken}` },
        body: JSON.stringify({ printerId }),
        timeout: 10_000,
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.success) {
        setAssignedId(typeof data.assignedPrinterId === 'string' ? data.assignedPrinterId : '');
        toast.success(t('kioskPrinterDefaultSaved') || 'Default printer saved for this kiosk');
        onOpenChange(false);
      } else {
        toast.error(data?.error || t('kioskPrinterDefaultSaveFailed') || 'Failed to save the default printer');
      }
    } catch {
      toast.error(t('kioskPrinterDefaultSaveFailed') || 'Failed to save the default printer');
    } finally {
      setSaving(false);
    }
  }, [deviceToken, saving, t, onOpenChange]);

  const currentPrinter = assignedId ? printers.find((p) => p.id === assignedId) ?? null : null;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="kiosk-printer-settings"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-[60] bg-black/70 backdrop-blur-sm flex items-center justify-center p-3"
          role="dialog"
          aria-modal="true"
          aria-label={t('kioskPrinterSettings') || 'Printer settings'}
        >
          <motion.div
            initial={{ scale: 0.94, opacity: 0, y: 12 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.96, opacity: 0, y: 8 }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
            className="bg-white dark:bg-gray-900 rounded-3xl shadow-2xl w-full max-w-md max-h-[88vh] flex flex-col overflow-hidden"
          >
            {/* Header */}
            <div className="shrink-0 flex items-center gap-2.5 px-4 py-3.5 border-b dark:border-gray-800">
              <div className="p-2 rounded-xl bg-emerald-100 dark:bg-emerald-950/50">
                <Printer className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-sm leading-tight">{t('kioskPrinterSettings') || 'Printer settings'}</p>
                <p className="text-[11px] text-muted-foreground truncate">
                  {t('kioskPrinterSettingsHint') || 'Receipts print on the printer chosen here'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                aria-label="close"
                className="p-2 rounded-xl hover:bg-muted transition-colors min-h-[40px] min-w-[40px] flex items-center justify-center"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Body — scrollable, tall lists never push the actions off-screen */}
            <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-2">
              {!deviceToken ? (
                <div className="flex items-start gap-2 p-3 rounded-xl bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300 text-xs">
                  <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                  <p>{t('kioskPrinterNeedsPairing') || 'Connect this kiosk to an agency first — pairing gives it access to the registered printers.'}</p>
                </div>
              ) : loading ? (
                <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin" />
                  {t('loading') || 'Loading…'}
                </div>
              ) : loadError ? (
                <div className="flex items-start gap-2 p-3 rounded-xl bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300 text-xs">
                  <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                  <div>
                    <p>{loadError}</p>
                    <button
                      type="button"
                      onClick={() => void fetchOptions()}
                      className="mt-2 underline underline-offset-2 font-medium"
                    >
                      {t('retry') || 'Retry'}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  {/* Current assignment */}
                  <p className="text-[11px] text-muted-foreground px-1 pb-1">
                    {t('kioskPrinterCurrent') || 'Receipts print on'}:{' '}
                    <span className="font-semibold text-foreground">
                      {currentPrinter
                        ? printerLabel(currentPrinter, lang)
                        : (agencyDefault?.name || agencyDefault?.ip
                          ? `${t('dmKioskPrinterAgencyDefault') || 'Agency default'}${agencyDefault?.name ? ` (${agencyDefault.name})` : ''}`
                          : (t('dmKioskPrinterAgencyDefault') || 'Agency default'))}
                    </span>
                  </p>

                  {/* Agency-default row (clears the kiosk assignment) */}
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void save('')}
                    className={`w-full flex items-center gap-3 p-3 rounded-2xl border text-start transition-colors min-h-[56px] ${
                      !assignedId
                        ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/40'
                        : 'border-border hover:bg-muted/60'
                    }`}
                  >
                    <div className="p-1.5 rounded-lg bg-muted shrink-0">
                      <Wifi className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{t('dmKioskPrinterAgencyDefault') || 'Agency default'}</p>
                      <p className="text-[11px] text-muted-foreground truncate">
                        {agencyDefault?.name || agencyDefault?.ip || (t('kioskPrinterAgencyDefaultHint') || 'The printer saved as the agency default')}
                      </p>
                    </div>
                    {!assignedId && <Check className="h-4 w-4 text-emerald-600 shrink-0" />}
                  </button>

                  {/* Registered printers of the agency */}
                  {printers.length === 0 ? (
                    <div className="flex items-start gap-2 p-3 rounded-xl bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300 text-xs">
                      <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                      <p>{t('dmKioskPrinterNoRegistered') || 'No registered printers found'} — {t('kioskPrinterRegisterHint') || 'register printers from the Device Manager on the branch PC first'}</p>
                    </div>
                  ) : (
                    printers.map((p) => {
                      const selected = assignedId === p.id;
                      return (
                        <button
                          key={p.id}
                          type="button"
                          disabled={saving}
                          onClick={() => void save(p.id)}
                          className={`w-full flex items-center gap-3 p-3 rounded-2xl border text-start transition-colors min-h-[56px] ${
                            selected
                              ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/40'
                              : 'border-border hover:bg-muted/60'
                          }`}
                        >
                          <div className="p-1.5 rounded-lg bg-muted shrink-0">
                            {p.connectionType === 'USB' || p.attachment === 'USB'
                              ? <Cable className="h-4 w-4 text-muted-foreground" />
                              : <Wifi className="h-4 w-4 text-muted-foreground" />}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium truncate">{printerLabel(p, lang)}</p>
                            <p className="text-[11px] text-muted-foreground truncate" dir="ltr">
                              {deliveryHint(p)}
                            </p>
                          </div>
                          {saving && selected ? (
                            <Loader2 className="h-4 w-4 animate-spin text-emerald-600 shrink-0" />
                          ) : selected ? (
                            <Check className="h-4 w-4 text-emerald-600 shrink-0" />
                          ) : null}
                        </button>
                      );
                    })
                  )}
                </>
              )}
            </div>

            {/* Footer — pinned, never pushed off-screen */}
            <div className="shrink-0 px-4 py-3 border-t dark:border-gray-800">
              <p className="text-[10px] text-muted-foreground text-center">
                {t('kioskPrinterDirectPrintNote') || 'Tapping a printer saves it and prints receipts directly — no popup, no receipt window.'}
              </p>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
