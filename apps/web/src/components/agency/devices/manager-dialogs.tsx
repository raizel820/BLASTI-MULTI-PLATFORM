'use client';

/**
 * manager-dialogs.tsx — all dialogs of the unified Device Manager (0.6.74).
 * One file, seven compact dialogs, zero dead exports:
 *   EditDeviceDialog   — names / type / branch / screen style (TV designs!) /
 *                        connection / service filter
 *   PairDeviceDialog   — pairing code + countdown + copy
 *   CommandDialog      — REFRESH / REBOOT / CONFIG_UPDATE / CLEAR_CACHE
 *   ConfirmDialog      — generic destructive confirm (delete / unpair)
 *   KioskCredDialog    — pairing code + device token (+ regenerate)
 *   CreateKioskDialog  — provision a kiosk with credentials
 *   TvPreviewDialog    — board URL + QR + per-design preview links
 */

import { useState, useEffect } from 'react';
import QRCode from 'qrcode';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import {
  Copy, ExternalLink, Loader2, QrCode, Monitor, Unplug, Trash2, RefreshCw,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  type AgencyDevice, type Branch, type DeviceType, type ConnectionType,
  type DeviceStatus, type ScreenLayout, type CommandType, type DisplaySettings,
  DEVICE_TYPE_CONFIG, SCREEN_LAYOUT_CONFIG, getLocalizedLabel, getLocalizedString,
} from './types';

type TranslateFn = (key: string) => string;

// ─── Edit / Add device ──────────────────────────────────────────────────────

export interface DeviceFormState {
  name: string; nameAr: string; nameFr: string;
  type: DeviceType; connectionType: ConnectionType;
  ipAddress: string; port: string;
  autoDiscovery: boolean; screenLayout: ScreenLayout;
  branchId: string; serviceFilter: string;
  status: DeviceStatus; displaySettings: DisplaySettings;
}

export function EditDeviceDialog({
  open, lang, rtl, t, submitting, editing,
  form, branches, onFormChange, onOpenChange, onSubmit, onPreviewTv,
}: {
  open: boolean;
  lang: string;
  rtl: boolean;
  t: TranslateFn;
  submitting: boolean;
  editing: AgencyDevice | null;
  form: DeviceFormState;
  branches: Branch[];
  onFormChange: (patch: Partial<DeviceFormState>) => void;
  onOpenChange: (open: boolean) => void;
  onSubmit: () => void;
  onPreviewTv: (device: AgencyDevice, layout: ScreenLayout) => void;
}) {
  const isTvLike = form.type === 'TV' || form.type === 'DISPLAY';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto" dir={rtl ? 'rtl' : 'ltr'}>
        <DialogHeader>
          <DialogTitle>{editing ? t('dmEditTitle') : t('dmAddTitle')}</DialogTitle>
          <DialogDescription>{t('dmEditDesc')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="dev-name">{t('deviceName')}</Label>
            <Input id="dev-name" value={form.name} onChange={(e) => onFormChange({ name: e.target.value })} placeholder="Reception TV" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label>{t('deviceTypeLabel')}</Label>
              <Select value={form.type} onValueChange={(v) => onFormChange({ type: v as DeviceType })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(['TV', 'KIOSK', 'DISPLAY', 'PRINTER', 'APP'] as DeviceType[]).map((type) => (
                    <SelectItem key={type} value={type}>{getLocalizedLabel(DEVICE_TYPE_CONFIG[type], lang)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>{t('deviceBranch')}</Label>
              <Select value={form.branchId || 'none'} onValueChange={(v) => onFormChange({ branchId: v === 'none' ? '' : v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t('dmNoBranch')}</SelectItem>
                  {branches.map((b) => (
                    <SelectItem key={b.id} value={b.id}>{getLocalizedString(b.nameAr || b.name, b.nameFr || b.name, b.name, lang)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {isTvLike && (
            <div className="grid gap-2 rounded-xl border bg-muted/30 p-3">
              <Label>{t('dmScreenStyle')}</Label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {(Object.keys(SCREEN_LAYOUT_CONFIG) as ScreenLayout[])
                  .filter((k) => k !== 'CUSTOM' && k !== 'TICKET_PRINTER' && k !== 'SERVICE_SELECTOR')
                  .map((key) => {
                    const cfg = SCREEN_LAYOUT_CONFIG[key];
                    const Icon = cfg.icon;
                    const active = form.screenLayout === key;
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => onFormChange({ screenLayout: key })}
                        className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-start text-sm transition-colors ${
                          active ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300' : 'bg-background hover:bg-muted/60'
                        }`}
                      >
                        <Icon className="h-4 w-4 shrink-0" />
                        <span className="truncate flex-1">{getLocalizedLabel(cfg, lang)}</span>
                        {editing && (
                          <span
                            role="button"
                            tabIndex={0}
                            aria-label={t('dmPreview')}
                            className="text-muted-foreground hover:text-foreground"
                            onClick={(e) => { e.stopPropagation(); onPreviewTv(editing, key); }}
                            onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onPreviewTv(editing, key); } }}
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </span>
                        )}
                      </button>
                    );
                  })}
              </div>
              <p className="text-xs text-muted-foreground">{t('dmScreenStyleHint')}</p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label>{t('deviceConnection')}</Label>
              <Select value={form.connectionType} onValueChange={(v) => onFormChange({ connectionType: v as ConnectionType })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(['LAN', 'WIFI', 'CABLE', 'MANUAL'] as ConnectionType[]).map((ct) => (
                    <SelectItem key={ct} value={ct}>{getLocalizedLabel({ labelAr: { LAN: 'شبكة محلية', WIFI: 'واي فاي', CABLE: 'كابل', MANUAL: 'يدوي' }[ct], labelEn: ct, labelFr: { LAN: 'Réseau local', WIFI: 'Wi-Fi', CABLE: 'Câble', MANUAL: 'Manuel' }[ct] }, lang)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="dev-ip">{t('dmIpAddress')}</Label>
              <Input id="dev-ip" dir="ltr" value={form.ipAddress} onChange={(e) => onFormChange({ ipAddress: e.target.value })} placeholder="192.168.1.50" />
            </div>
          </div>

          {form.type === 'KIOSK' && (
            <div className="grid gap-2">
              <Label htmlFor="dev-filter">{t('dmServiceFilter')}</Label>
              <Input id="dev-filter" value={form.serviceFilter} onChange={(e) => onFormChange({ serviceFilter: e.target.value })} placeholder="serviceId1,serviceId2" />
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('cancel')}</Button>
          <Button onClick={onSubmit} disabled={submitting || !form.name.trim()} className="gap-1.5">
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            {editing ? t('save') : t('dmAddTitle')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Pairing code ───────────────────────────────────────────────────────────

export function PairDeviceDialog({
  open, lang, rtl, device, pairingCode, pairingCodeCopied, pairingLoading, pairingTimer,
  onOpenChange, onCopyPairingCode,
}: {
  open: boolean;
  lang: string;
  rtl: boolean;
  device: AgencyDevice | null;
  pairingCode: string;
  pairingCodeCopied: boolean;
  pairingLoading: boolean;
  pairingTimer: number;
  onOpenChange: (open: boolean) => void;
  onCopyPairingCode: () => void;
}) {
  const minutes = Math.floor(pairingTimer / 60000);
  const seconds = Math.floor((pairingTimer % 60000) / 1000);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm" dir={rtl ? 'rtl' : 'ltr'}>
        <DialogHeader>
          <DialogTitle>{getLocalizedString('ربط الجهاز', 'Associer l\'appareil', 'Pair Device', lang)}</DialogTitle>
          <DialogDescription>
            {getLocalizedString('أدخل هذا الرمز على الجهاز لإقرانه بوكالتك.', 'Saisissez ce code sur l\'appareil pour l\'associer.', 'Enter this code on the device to pair it with your agency.', lang)}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col items-center gap-3 py-4">
          {pairingLoading ? (
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          ) : pairingCode ? (
            <>
              <div className="rounded-2xl bg-muted px-8 py-4 text-4xl font-black tracking-[0.3em] tabular-nums" dir="ltr">{pairingCode}</div>
              <p className="text-xs text-muted-foreground">
                {getLocalizedString('ينتهي بعد', 'Expire dans', 'Expires in', lang)} {minutes}:{String(seconds).padStart(2, '0')}
              </p>
              <Button variant="outline" size="sm" className="gap-1.5" onClick={onCopyPairingCode}>
                {pairingCodeCopied ? <Copy className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
                {getLocalizedString('نسخ الرمز', 'Copier le code', 'Copy code', lang)}
              </Button>
            </>
          ) : null}
          {device && <p className="text-sm text-muted-foreground">{device.name}</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Command ────────────────────────────────────────────────────────────────

export function CommandDialog({
  open, lang, rtl, device, commandType, commandSending,
  onOpenChange, onCommandTypeChange, onSend,
}: {
  open: boolean;
  lang: string;
  rtl: boolean;
  device: AgencyDevice | null;
  commandType: CommandType;
  commandSending: boolean;
  onOpenChange: (open: boolean) => void;
  onCommandTypeChange: (t: CommandType) => void;
  onSend: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm" dir={rtl ? 'rtl' : 'ltr'}>
        <DialogHeader>
          <DialogTitle>{getLocalizedString('إرسال أمر', 'Envoyer une commande', 'Send Command', lang)}</DialogTitle>
          <DialogDescription>{device?.name}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2 py-2">
          {(['REFRESH', 'CLEAR_CACHE', 'CONFIG_UPDATE', 'REBOOT'] as CommandType[]).map((ct) => (
            <button
              key={ct}
              type="button"
              onClick={() => onCommandTypeChange(ct)}
              className={`rounded-lg border px-3 py-2 text-start text-sm ${commandType === ct ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/40' : 'hover:bg-muted/60'}`}
            >
              {getLocalizedString(
                { REFRESH: 'تحديث الصفحة', CLEAR_CACHE: 'مسح الذاكرة المؤقتة', CONFIG_UPDATE: 'إعادة تحميل الإعدادات', REBOOT: 'إعادة تشغيل كاملة' }[ct],
                { REFRESH: 'Rafraîchir', CLEAR_CACHE: 'Vider le cache', CONFIG_UPDATE: 'Recharger la config', REBOOT: 'Redémarrer' }[ct],
                { REFRESH: 'Refresh screen', CLEAR_CACHE: 'Clear cache', CONFIG_UPDATE: 'Reload config', REBOOT: 'Full reboot' }[ct],
                lang,
              )}
            </button>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{getLocalizedString('إلغاء', 'Annuler', 'Cancel', lang)}</Button>
          <Button onClick={onSend} disabled={commandSending} className="gap-1.5">
            {commandSending && <Loader2 className="h-4 w-4 animate-spin" />}
            {getLocalizedString('إرسال', 'Envoyer', 'Send', lang)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Generic destructive confirm (delete / unpair) ──────────────────────────

export function ConfirmDialog({
  open, lang, rtl, title, message, confirmLabel, tone = 'destructive', loading,
  onOpenChange, onConfirm, icon,
}: {
  open: boolean;
  lang: string;
  rtl: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  tone?: 'destructive' | 'default';
  loading: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  icon?: 'trash' | 'unplug';
}) {
  const Icon = icon === 'unplug' ? Unplug : Trash2;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm" dir={rtl ? 'rtl' : 'ltr'}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className={`p-2 rounded-lg ${tone === 'destructive' ? 'bg-red-100 text-red-600 dark:bg-red-950/50 dark:text-red-400' : 'bg-orange-100 text-orange-600'}`}>
              <Icon className="h-4 w-4" />
            </span>
            {title}
          </DialogTitle>
          <DialogDescription>{message}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>{getLocalizedString('إلغاء', 'Annuler', 'Cancel', lang)}</Button>
          <Button
            onClick={onConfirm}
            disabled={loading}
            className={tone === 'destructive' ? 'bg-red-600 hover:bg-red-700 text-white' : 'bg-orange-500 hover:bg-orange-600 text-white'}
          >
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Kiosk credentials ──────────────────────────────────────────────────────

export function KioskCredDialog({
  open, lang, rtl, device, loading, pairingCode, token, tokenVisible, copiedField,
  onOpenChange, onTokenVisibleChange, onCopyField, onRegenerate,
}: {
  open: boolean;
  lang: string;
  rtl: boolean;
  device: AgencyDevice | null;
  loading: boolean;
  pairingCode: string;
  token: string;
  tokenVisible: boolean;
  copiedField: string | null;
  onOpenChange: (open: boolean) => void;
  onTokenVisibleChange: (v: boolean) => void;
  onCopyField: (text: string, field: string) => void;
  onRegenerate: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" dir={rtl ? 'rtl' : 'ltr'}>
        <DialogHeader>
          <DialogTitle>{getLocalizedString('بيانات دخول الكيوسك', 'Identifiants du kiosque', 'Kiosk Credentials', lang)}</DialogTitle>
          <DialogDescription>{getLocalizedString('استخدمها في شاشة دخول الكيوسك.', 'À saisir sur l\'écran de connexion du kiosque.', 'Enter them on the kiosk login screen.', lang)}</DialogDescription>
        </DialogHeader>
        {loading ? (
          <div className="grid place-items-center py-6"><Loader2 className="h-6 w-6 animate-spin" /></div>
        ) : (
          <div className="space-y-3 py-2">
            <div className="flex items-center justify-between gap-3 rounded-xl border p-3">
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">{getLocalizedString('رمز الاقتران', 'Code d\'appariement', 'Pairing code', lang)}</p>
                <p className="text-2xl font-black tracking-[0.2em] tabular-nums" dir="ltr">{pairingCode}</p>
              </div>
              <Button variant="ghost" size="icon" onClick={() => onCopyField(pairingCode, 'code')} aria-label="copy code">
                {copiedField === 'code' ? <Copy className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
            <div className="flex items-center justify-between gap-3 rounded-xl border p-3">
              <div className="min-w-0 flex-1">
                <p className="text-xs text-muted-foreground">{getLocalizedString('رمز الجهاز', 'Token de l\'appareil', 'Device token', lang)}</p>
                <p className="truncate font-mono text-sm" dir="ltr">{tokenVisible ? token : '••••••••••••••••'}</p>
              </div>
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="sm" onClick={() => onTokenVisibleChange(!tokenVisible)}>
                  {tokenVisible
                    ? getLocalizedString('إخفاء', 'Masquer', 'Hide', lang)
                    : getLocalizedString('إظهار', 'Afficher', 'Show', lang)}
                </Button>
                <Button variant="ghost" size="icon" onClick={() => onCopyField(token, 'token')} aria-label="copy token">
                  {copiedField === 'token' ? <Copy className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
            </div>
          </div>
        )}
        <DialogFooter className="gap-2">
          <Button variant="outline" className="gap-1.5" onClick={onRegenerate} disabled={loading}>
            <RefreshCw className="h-4 w-4" />
            {getLocalizedString('إعادة إنشاء', 'Régénérer', 'Regenerate', lang)}
          </Button>
          <Button onClick={() => onOpenChange(false)}>{getLocalizedString('إغلاق', 'Fermer', 'Close', lang)}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Create kiosk ───────────────────────────────────────────────────────────

export function CreateKioskDialog({
  open, lang, rtl, loading, name, branchId, branches, result,
  onOpenChange, onNameChange, onBranchIdChange, onSubmit, onCopyField,
}: {
  open: boolean;
  lang: string;
  rtl: boolean;
  loading: boolean;
  name: string;
  branchId: string;
  branches: Branch[];
  result: { pairingCode: string; deviceToken: string } | null;
  onOpenChange: (open: boolean) => void;
  onNameChange: (v: string) => void;
  onBranchIdChange: (v: string) => void;
  onSubmit: () => void;
  onCopyField: (text: string, field: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" dir={rtl ? 'rtl' : 'ltr'}>
        <DialogHeader>
          <DialogTitle>{getLocalizedString('إنشاء كيوسك جديد', 'Créer un nouveau kiosque', 'Create New Kiosk', lang)}</DialogTitle>
          <DialogDescription>{getLocalizedString('سيتم توليد رمز اقتران ورمز جهاز للكيوسك.', 'Un code d\'appariement et un token seront générés.', 'A pairing code and device token will be generated.', lang)}</DialogDescription>
        </DialogHeader>
        {result ? (
          <div className="space-y-3 py-2">
            <div className="flex items-center justify-between rounded-xl border bg-emerald-50/50 dark:bg-emerald-950/20 p-3">
              <div>
                <p className="text-xs text-muted-foreground">{getLocalizedString('رمز الاقتران', 'Code', 'Pairing code', lang)}</p>
                <p className="text-2xl font-black tracking-[0.2em] tabular-nums" dir="ltr">{result.pairingCode}</p>
              </div>
              <Button variant="ghost" size="icon" onClick={() => onCopyField(result.pairingCode, 'code')} aria-label="copy">
                <Copy className="h-4 w-4" />
              </Button>
            </div>
            <div className="flex items-center justify-between rounded-xl border p-3">
              <p className="truncate font-mono text-xs" dir="ltr">{result.deviceToken}</p>
              <Button variant="ghost" size="icon" onClick={() => onCopyField(result.deviceToken, 'token')} aria-label="copy">
                <Copy className="h-4 w-4" />
              </Button>
            </div>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>{getLocalizedString('تم', 'Terminé', 'Done', lang)}</Button>
            </DialogFooter>
          </div>
        ) : (
          <>
            <div className="space-y-4 py-2">
              <div className="grid gap-2">
                <Label htmlFor="kiosk-name">{getLocalizedString('اسم الكيوسك', 'Nom du kiosque', 'Kiosk name', lang)}</Label>
                <Input id="kiosk-name" value={name} onChange={(e) => onNameChange(e.target.value)} placeholder="Entrance kiosk" />
              </div>
              <div className="grid gap-2">
                <Label>{getLocalizedString('الفرع', 'Succursale', 'Branch', lang)}</Label>
                <Select value={branchId || 'none'} onValueChange={(v) => onBranchIdChange(v === 'none' ? '' : v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{getLocalizedString('بدون فرع', 'Aucune', 'No branch', lang)}</SelectItem>
                    {branches.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>{getLocalizedString('إلغاء', 'Annuler', 'Cancel', lang)}</Button>
              <Button onClick={onSubmit} disabled={loading || !name.trim()} className="gap-1.5">
                {loading && <Loader2 className="h-4 w-4 animate-spin" />}
                {getLocalizedString('إنشاء', 'Créer', 'Create', lang)}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── TV preview (+ per-design quick links) ──────────────────────────────────

export function TvPreviewDialog({
  open, lang, rtl, device, boardUrl, designUrls,
  onOpenChange, onCopyUrl,
}: {
  open: boolean;
  lang: string;
  rtl: boolean;
  device: AgencyDevice | null;
  boardUrl: string;
  designUrls: Array<{ layout: ScreenLayout; url: string }>;
  onOpenChange: (open: boolean) => void;
  onCopyUrl: (url: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" dir={rtl ? 'rtl' : 'ltr'}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Monitor className="h-5 w-5" />
            {getLocalizedString('معاينة شاشة التلفاز', 'Aperçu de l\'écran TV', 'TV Screen Preview', lang)}
          </DialogTitle>
          <DialogDescription>{device?.name}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="flex items-center gap-2">
            <Input readOnly value={boardUrl} dir="ltr" className="text-xs" />
            <Button variant="outline" size="icon" onClick={() => onCopyUrl(boardUrl)} aria-label="copy url">
              <Copy className="h-4 w-4" />
            </Button>
            <Button size="icon" onClick={() => window.open(boardUrl, '_blank')} aria-label="open url">
              <ExternalLink className="h-4 w-4" />
            </Button>
          </div>
          <div className="grid gap-2">
            <p className="text-xs font-medium text-muted-foreground">{getLocalizedString('معاينة التصاميم الأربعة', 'Aperçu des 4 designs', 'Preview the 4 designs', lang)}</p>
            <div className="grid grid-cols-2 gap-2">
              {designUrls.map(({ layout, url }) => {
                const cfg = SCREEN_LAYOUT_CONFIG[layout];
                const Icon = cfg.icon;
                return (
                  <div key={layout} className="flex items-center gap-1.5 rounded-lg border p-2">
                    <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="truncate flex-1 text-xs">{getLocalizedLabel(cfg, lang)}</span>
                    <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => window.open(url, '_blank')} aria-label={`open ${layout}`}>
                      <ExternalLink className="h-3.5 w-3.5" />
                    </button>
                    <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => onCopyUrl(url)} aria-label={`copy ${layout}`}>
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-xl bg-muted/50 p-3">
            <QrCode className="h-5 w-5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium">{getLocalizedString('امسح الرمز بالتلفاز الذكي', 'Scannez avec la Smart TV', 'Scan with the Smart TV', lang)}</p>
              <p className="truncate text-xs text-muted-foreground" dir="ltr">{boardUrl}</p>
            </div>
            <Badge variant="secondary" className="shrink-0">QR</Badge>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── TV QR (full-size) ──────────────────────────────────────────────────────

export function TvQrDialog({
  open, lang, rtl, url,
  onOpenChange, onCopyUrl,
}: {
  open: boolean;
  lang: string;
  rtl: boolean;
  url: string;
  onOpenChange: (open: boolean) => void;
  onCopyUrl: () => void;
}) {
  // Generated locally with the `qrcode` package — no external service call.
  const [dataUrl, setDataUrl] = useState('');
  useEffect(() => {
    if (!open || !url) return;
    QRCode.toDataURL(url, { width: 416, margin: 1 })
      .then((d: string) => setDataUrl(d))
      .catch(() => setDataUrl(''));
  }, [open, url]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm" dir={rtl ? 'rtl' : 'ltr'}>
        <DialogHeader>
          <DialogTitle>{getLocalizedString('رابط شاشة التلفاز', 'Lien écran TV', 'TV Screen Link', lang)}</DialogTitle>
          <DialogDescription>{getLocalizedString('افتح هذا الرابط في متصفح التلفاز الذكي.', 'Ouvrez ce lien dans le navigateur de la Smart TV.', 'Open this link in the Smart TV browser.', lang)}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col items-center gap-4 py-2">
          {dataUrl ? (
            <img src={dataUrl} alt="TV screen QR code" className="rounded-2xl bg-white p-2 shadow-sm w-52 h-52" />
          ) : (
            <div className="grid h-52 w-52 place-items-center rounded-2xl bg-muted"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
          )}
          <p className="break-all text-center text-xs text-muted-foreground" dir="ltr">{url}</p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="gap-1.5" onClick={onCopyUrl}>
              <Copy className="h-4 w-4" />
              {getLocalizedString('نسخ', 'Copier', 'Copy', lang)}
            </Button>
            <Button size="sm" className="gap-1.5" onClick={() => window.open(url, '_blank')}>
              <ExternalLink className="h-4 w-4" />
              {getLocalizedString('فتح', 'Ouvrir', 'Open', lang)}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
