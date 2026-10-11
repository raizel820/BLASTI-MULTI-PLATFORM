'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { motion } from 'framer-motion';
import {
  Plus,
  Edit3,
  Trash2,
  Radio,
  QrCode,
  Copy,
  CheckCircle2,
  Loader2,
  Power,
  ShieldCheck,
  KeyRound,
  Terminal,
  Send,
  Settings,
  Wifi,
  WifiOff,
  Search,
  Eye,
  EyeOff,
  Globe,
  Cable,
  Cast,
  Monitor,
  CircleAlert,
  Info,
  RotateCw,
} from 'lucide-react';
import {
  type AgencyDevice,
  type DiscoveredDevice,
  type Branch,
  type DeviceType,
  type ConnectionType,
  type CommandType,
  type ScreenLayout,
  type DisplaySettings,
  DEVICE_TYPE_CONFIG,
  STATUS_CONFIG,
  CONNECTION_TYPE_CONFIG,
  SCREEN_LAYOUT_CONFIG,
  COMMAND_TYPE_CONFIG,
  getLocalizedName,
  getLocalizedLabel,
  getLocalizedString,
} from './types';

// ─── Shared form fields for Add / Edit ──────────────────────────────────────

interface DeviceFormFieldsProps {
  lang: string;
  rtl: boolean;
  formName: string;
  formNameAr: string;
  formNameFr: string;
  formType: DeviceType;
  formConnectionType: ConnectionType;
  formIpAddress: string;
  formPort: string;
  formAutoDiscovery: boolean;
  formScreenLayout: ScreenLayout;
  formBranchId: string;
  formServiceFilter: string;
  formStatus?: DeviceStatus;
  formDisplaySettings?: DisplaySettings;
  branches: Branch[];
  t: (key: string) => string;
  onFormNameChange: (v: string) => void;
  onFormNameArChange: (v: string) => void;
  onFormNameFrChange: (v: string) => void;
  onFormTypeChange: (v: DeviceType) => void;
  onFormConnectionTypeChange: (v: ConnectionType) => void;
  onFormIpAddressChange: (v: string) => void;
  onFormPortChange: (v: string) => void;
  onFormAutoDiscoveryChange: (v: boolean) => void;
  onFormScreenLayoutChange: (v: ScreenLayout) => void;
  onFormBranchIdChange: (v: string) => void;
  onFormServiceFilterChange: (v: string) => void;
  onFormStatusChange?: (v: DeviceStatus) => void;
  onFormDisplaySettingsChange?: (v: DisplaySettings | ((prev: DisplaySettings) => DisplaySettings)) => void;
  includeStatus?: boolean;
  includeDisplaySettings?: boolean;
}

function DeviceFormFields({
  lang,
  formName,
  formNameAr,
  formNameFr,
  formType,
  formConnectionType,
  formIpAddress,
  formPort,
  formAutoDiscovery,
  formScreenLayout,
  formBranchId,
  formServiceFilter,
  formStatus,
  formDisplaySettings = {},
  branches,
  t,
  includeStatus,
  includeDisplaySettings,
  onFormNameChange,
  onFormNameArChange,
  onFormNameFrChange,
  onFormTypeChange,
  onFormConnectionTypeChange,
  onFormIpAddressChange,
  onFormPortChange,
  onFormAutoDiscoveryChange,
  onFormScreenLayoutChange,
  onFormBranchIdChange,
  onFormServiceFilterChange,
  onFormStatusChange,
  onFormDisplaySettingsChange,
}: DeviceFormFieldsProps) {
  return (
    <div className="space-y-4 py-2">
      {/* Status Toggle (edit only) */}
      {includeStatus && onFormStatusChange && formStatus && (
        <div className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
          <div>
            <Label className="text-sm font-medium">
              {formStatus === 'DISABLED'
                ? getLocalizedString('الجهاز معطّل', 'Appareil désactivé', 'Device Disabled', lang)
                : getLocalizedString('الجهاز مفعّل', 'Appareil activé', 'Device Enabled', lang)
              }
            </Label>
            <p className="text-xs text-muted-foreground">
              {formStatus === 'DISABLED'
                ? getLocalizedString('فعّل الجهاز للسماح بالاتصال', 'Activez l\'appareil pour autoriser les connexions', 'Enable device to allow connections', lang)
                : getLocalizedString('عطّل الجهاز لمنع الاتصال', 'Désactivez l\'appareil pour empêcher les connexions', 'Disable device to prevent connections', lang)
              }
            </p>
          </div>
          <Switch
            checked={formStatus !== 'DISABLED'}
            onCheckedChange={(checked) => onFormStatusChange(checked ? 'OFFLINE' : 'DISABLED')}
          />
        </div>
      )}

      {/* Device Name */}
      <div className="space-y-1.5">
        <Label className="text-sm font-medium">
          {getLocalizedString('اسم الجهاز', 'Nom de l\'appareil', 'Device Name', lang)} <span className="text-red-500">*</span>
        </Label>
        <Input
          value={formName}
          onChange={(e) => onFormNameChange(e.target.value)}
          placeholder={lang === 'ar' ? 'مثال: شاشة الاستقبال' : 'e.g., Reception Display'}
        />
      </div>

      {/* Name variants */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-sm">{getLocalizedString('الاسم بالعربية', 'Nom en arabe', 'Arabic Name', lang)}</Label>
          <Input
            value={formNameAr}
            onChange={(e) => onFormNameArChange(e.target.value)}
            placeholder="الاسم بالعربية"
            dir="rtl"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-sm">{getLocalizedString('الاسم بالفرنسية', 'Nom en français', 'French Name', lang)}</Label>
          <Input
            value={formNameFr}
            onChange={(e) => onFormNameFrChange(e.target.value)}
            placeholder={t('dmFrenchNamePlaceholder') || 'Nom en français'}
            dir="ltr"
          />
        </div>
      </div>

      {/* Device Type */}
      <div className="space-y-1.5">
        <Label className="text-sm font-medium">{getLocalizedString('نوع الجهاز', 'Type d\'appareil', 'Device Type', lang)}</Label>
        <div className="grid grid-cols-4 gap-2">
          {(Object.keys(DEVICE_TYPE_CONFIG) as DeviceType[]).map((dt) => {
            const cfg = DEVICE_TYPE_CONFIG[dt];
            const DIcon = cfg.icon;
            const isSelected = formType === dt;
            return (
              <button
                key={dt}
                type="button"
                onClick={() => onFormTypeChange(dt)}
                className={`flex flex-col items-center gap-1.5 p-3 rounded-xl border-2 transition-all text-center ${
                  isSelected
                    ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30'
                    : 'border-border hover:border-emerald-300 dark:hover:border-emerald-800'
                }`}
              >
                <DIcon className={`h-5 w-5 ${isSelected ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}`} />
                <span className="text-[10px] font-medium">{getLocalizedLabel(cfg, lang)}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Connection Type */}
      <div className="space-y-1.5">
        <Label className="text-sm font-medium">{getLocalizedString('نوع الاتصال', 'Type de connexion', 'Connection Type', lang)}</Label>
        <Select value={formConnectionType} onValueChange={(v) => onFormConnectionTypeChange(v as ConnectionType)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(CONNECTION_TYPE_CONFIG) as ConnectionType[]).map((ct) => {
              const cfg = CONNECTION_TYPE_CONFIG[ct];
              return (
                <SelectItem key={ct} value={ct}>
                  <span className="flex items-center gap-2">
                    <cfg.icon className="h-4 w-4" />
                    {getLocalizedLabel(cfg, lang)}
                  </span>
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </div>

      {/* IP / Port */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-sm">{getLocalizedString('عنوان IP', 'Adresse IP', 'IP Address', lang)}</Label>
          <Input
            value={formIpAddress}
            onChange={(e) => onFormIpAddressChange(e.target.value)}
            placeholder="192.168.1.100"
            dir="ltr"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-sm">{getLocalizedString('المنفذ', 'Port', 'Port', lang)}</Label>
          <Input
            value={formPort}
            onChange={(e) => onFormPortChange(e.target.value.replace(/\D/g, ''))}
            placeholder="8080"
            dir="ltr"
          />
        </div>
      </div>

      {/* Auto Discovery */}
      <div className="flex items-center justify-between">
        <div>
          <Label className="text-sm">{getLocalizedString('الاكتشاف التلقائي', 'Découverte auto', 'Auto Discovery', lang)}</Label>
          <p className="text-xs text-muted-foreground">
            {getLocalizedString(
              'السماح باكتشاف الجهاز تلقائياً في الشبكة',
              'Autoriser la découverte automatique sur le réseau',
              'Allow device to be discovered automatically on the network',
              lang,
            )}
          </p>
        </div>
        <Switch checked={formAutoDiscovery} onCheckedChange={onFormAutoDiscoveryChange} />
      </div>

      {/* Screen Layout */}
      <div className="space-y-1.5">
        <Label className="text-sm font-medium">{getLocalizedString('تخطيط الشاشة', 'Disposition de l\'écran', 'Screen Layout', lang)}</Label>
        <Select value={formScreenLayout} onValueChange={(v) => onFormScreenLayoutChange(v as ScreenLayout)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(SCREEN_LAYOUT_CONFIG) as ScreenLayout[]).map((sl) => {
              const cfg = SCREEN_LAYOUT_CONFIG[sl];
              return (
                <SelectItem key={sl} value={sl}>
                  <span className="flex items-center gap-2">
                    <cfg.icon className="h-4 w-4" />
                    {getLocalizedLabel(cfg, lang)}
                  </span>
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </div>

      {/* Branch */}
      {branches.length > 0 && (
        <div className="space-y-1.5">
          <Label className="text-sm">{getLocalizedString('الفرع', 'Branche', 'Branch', lang)}</Label>
          <Select value={formBranchId} onValueChange={onFormBranchIdChange}>
            <SelectTrigger>
              <SelectValue placeholder={getLocalizedString('اختر فرعاً', 'Sélectionner', 'Select branch', lang)} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">{getLocalizedString('بدون فرع', 'Aucune branche', 'No branch', lang)}</SelectItem>
              {branches.map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {getLocalizedName(b, lang)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Service Filter */}
      <div className="space-y-1.5">
        <Label className="text-sm">{getLocalizedString('فلتر الخدمة', 'Filtre de service', 'Service Filter', lang)}</Label>
        <Input
          value={formServiceFilter}
          onChange={(e) => onFormServiceFilterChange(e.target.value)}
          placeholder={getLocalizedString('معرف الخدمة (اختياري)', 'ID de service (optionnel)', 'Service ID (optional)', lang)}
        />
      </div>

      {/* Display Settings (edit only) */}
      {includeDisplaySettings && onFormDisplaySettingsChange && (
        <>
          <Separator />
          <div className="space-y-3">
            <h4 className="text-sm font-medium flex items-center gap-1.5">
              <Settings className="h-4 w-4 text-cyan-500" />
              {getLocalizedString('إعدادات العرض', 'Paramètres d\'affichage', 'Display Settings', lang)}
            </h4>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">{getLocalizedString('حجم الخط', 'Taille de police', 'Font Size', lang)}</Label>
                <Input
                  type="number"
                  value={formDisplaySettings.fontSize ?? ''}
                  onChange={(e) => onFormDisplaySettingsChange((prev) => ({ ...prev, fontSize: e.target.value ? parseInt(e.target.value) : undefined }))}
                  placeholder="24"
                  dir="ltr"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">{getLocalizedString('السمة', 'Thème', 'Theme', lang)}</Label>
                <Select
                  value={formDisplaySettings.theme ?? ''}
                  onValueChange={(v) => onFormDisplaySettingsChange((prev) => ({ ...prev, theme: v || undefined }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={getLocalizedString('افتراضي', 'Par défaut', 'Default', lang)} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="light">{getLocalizedString('فاتح', 'Clair', 'Light', lang)}</SelectItem>
                    <SelectItem value="dark">{getLocalizedString('داكن', 'Sombre', 'Dark', lang)}</SelectItem>
                    <SelectItem value="auto">{getLocalizedString('تلقائي', 'Auto', 'Auto', lang)}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">{getLocalizedString('اللغة', 'Langue', 'Language', lang)}</Label>
                <Select
                  value={formDisplaySettings.language ?? ''}
                  onValueChange={(v) => onFormDisplaySettingsChange((prev) => ({ ...prev, language: v || undefined }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={getLocalizedString('افتراضي', 'Par défaut', 'Default', lang)} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ar">العربية</SelectItem>
                    <SelectItem value="fr">Français</SelectItem>
                    <SelectItem value="en">English</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">{getLocalizedString('مدة التدوير (ث)', 'Rotation (sec)', 'Rotation (sec)', lang)}</Label>
                <Input
                  type="number"
                  value={formDisplaySettings.rotationSec ?? ''}
                  onChange={(e) => onFormDisplaySettingsChange((prev) => ({ ...prev, rotationSec: e.target.value ? parseInt(e.target.value) : undefined }))}
                  placeholder="10"
                  dir="ltr"
                />
              </div>
            </div>
            <div className="flex items-center justify-between">
              <Label className="text-xs">{getLocalizedString('إظهار الإعلانات', 'Afficher les pubs', 'Show Ads', lang)}</Label>
              <Switch
                checked={formDisplaySettings.showAds ?? false}
                onCheckedChange={(v) => onFormDisplaySettingsChange((prev) => ({ ...prev, showAds: v }))}
              />
            </div>
            <div className="flex items-center justify-between">
              <Label className="text-xs">{getLocalizedString('إظهار الشعار', 'Afficher le logo', 'Show Logo', lang)}</Label>
              <Switch
                checked={formDisplaySettings.showLogo ?? true}
                onCheckedChange={(v) => onFormDisplaySettingsChange((prev) => ({ ...prev, showLogo: v }))}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Add Device Dialog ────────────────────────────────────────────────────

interface AddDeviceDialogProps {
  open: boolean;
  lang: string;
  rtl: boolean;
  t: (key: string) => string;
  submitting: boolean;
  createdToken: string | null;
  createdPairingCode: string | null;
  tokenRevealed: boolean;
  formName: string;
  formNameAr: string;
  formNameFr: string;
  formType: DeviceType;
  formConnectionType: ConnectionType;
  formIpAddress: string;
  formPort: string;
  formAutoDiscovery: boolean;
  formScreenLayout: ScreenLayout;
  formBranchId: string;
  formServiceFilter: string;
  branches: Branch[];
  onOpenChange: (open: boolean) => void;
  onFormNameChange: (v: string) => void;
  onFormNameArChange: (v: string) => void;
  onFormNameFrChange: (v: string) => void;
  onFormTypeChange: (v: DeviceType) => void;
  onFormConnectionTypeChange: (v: ConnectionType) => void;
  onFormIpAddressChange: (v: string) => void;
  onFormPortChange: (v: string) => void;
  onFormAutoDiscoveryChange: (v: boolean) => void;
  onFormScreenLayoutChange: (v: ScreenLayout) => void;
  onFormBranchIdChange: (v: string) => void;
  onFormServiceFilterChange: (v: string) => void;
  onTokenRevealedChange: (v: boolean) => void;
  onSubmit: () => void;
  onReset: () => void;
  onCopy: (text: string, label: string) => void;
}


// ─── Edit Device Dialog ───────────────────────────────────────────────────

interface EditDeviceDialogProps extends Omit<AddDeviceDialogProps, 'createdToken' | 'createdPairingCode' | 'onSubmit' | 'onReset'> {
  formStatus: DeviceStatus;
  formDisplaySettings: DisplaySettings;
  onFormStatusChange: (v: DeviceStatus) => void;
  onFormDisplaySettingsChange: (v: DisplaySettings | ((prev: DisplaySettings) => DisplaySettings)) => void;
  onSubmit: () => void;
  onReset: () => void;
  editingDevice: AgencyDevice | null;
}

export function EditDeviceDialog({
  open,
  lang,
  rtl,
  t,
  submitting,
  tokenRevealed,
  formName,
  formNameAr,
  formNameFr,
  formType,
  formConnectionType,
  formIpAddress,
  formPort,
  formAutoDiscovery,
  formScreenLayout,
  formBranchId,
  formServiceFilter,
  formStatus,
  formDisplaySettings,
  branches,
  editingDevice,
  onOpenChange,
  onFormNameChange,
  onFormNameArChange,
  onFormNameFrChange,
  onFormTypeChange,
  onFormConnectionTypeChange,
  onFormIpAddressChange,
  onFormPortChange,
  onFormAutoDiscoveryChange,
  onFormScreenLayoutChange,
  onFormBranchIdChange,
  onFormServiceFilterChange,
  onFormStatusChange,
  onFormDisplaySettingsChange,
  onSubmit,
  onReset,
}: EditDeviceDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onReset(); onOpenChange(o); }}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto" dir={rtl ? 'rtl' : 'ltr'}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Edit3 className="h-5 w-5 text-teal-500" />
            {getLocalizedString('تعديل الجهاز', 'Modifier l\'appareil', 'Edit Device', lang)}
          </DialogTitle>
          <DialogDescription>
            {editingDevice?.name ?? ''}
          </DialogDescription>
        </DialogHeader>

        <DeviceFormFields
          lang={lang}
          rtl={rtl}
          formName={formName}
          formNameAr={formNameAr}
          formNameFr={formNameFr}
          formType={formType}
          formConnectionType={formConnectionType}
          formIpAddress={formIpAddress}
          formPort={formPort}
          formAutoDiscovery={formAutoDiscovery}
          formScreenLayout={formScreenLayout}
          formBranchId={formBranchId}
          formServiceFilter={formServiceFilter}
          formStatus={formStatus}
          formDisplaySettings={formDisplaySettings}
          branches={branches}
          t={t}
          includeStatus
          includeDisplaySettings
          onFormNameChange={onFormNameChange}
          onFormNameArChange={onFormNameArChange}
          onFormNameFrChange={onFormNameFrChange}
          onFormTypeChange={onFormTypeChange}
          onFormConnectionTypeChange={onFormConnectionTypeChange}
          onFormIpAddressChange={onFormIpAddressChange}
          onFormPortChange={onFormPortChange}
          onFormAutoDiscoveryChange={onFormAutoDiscoveryChange}
          onFormScreenLayoutChange={onFormScreenLayoutChange}
          onFormBranchIdChange={onFormBranchIdChange}
          onFormServiceFilterChange={onFormServiceFilterChange}
          onFormStatusChange={onFormStatusChange}
          onFormDisplaySettingsChange={onFormDisplaySettingsChange}
        />

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => { onOpenChange(false); onReset(); }}>
            {getLocalizedString('إلغاء', 'Annuler', 'Cancel', lang)}
          </Button>
          <Button
            onClick={onSubmit}
            disabled={submitting || !formName.trim()}
            className="gap-1.5 bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-600 hover:to-teal-700 text-white"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            {getLocalizedString('حفظ التغييرات', 'Enregistrer', 'Save Changes', lang)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Pair Device Dialog ───────────────────────────────────────────────────

interface PairDeviceDialogProps {
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
}

export function PairDeviceDialog({
  open,
  lang,
  rtl,
  device,
  pairingCode,
  pairingCodeCopied,
  pairingLoading,
  pairingTimer,
  onOpenChange,
  onCopyPairingCode,
}: PairDeviceDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); }}>
      <DialogContent className="max-w-sm" dir={rtl ? 'rtl' : 'ltr'}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <QrCode className="h-5 w-5 text-amber-500" />
            {getLocalizedString('ربط الجهاز', 'Associer l\'appareil', 'Pair Device', lang)}
          </DialogTitle>
          <DialogDescription>
            {device ? getLocalizedName(device, lang) : ''}
          </DialogDescription>
        </DialogHeader>

        <div className="py-4 text-center space-y-4">
          {pairingLoading ? (
            <div className="flex flex-col items-center gap-3 py-6">
              <Loader2 className="h-8 w-8 animate-spin text-emerald-500" />
              <p className="text-sm text-muted-foreground">
                {getLocalizedString('جاري إنشاء رمز الربط...', 'Génération du code...', 'Generating pairing code...', lang)}
              </p>
            </div>
          ) : pairingCode ? (
            <>
              {/* Timer */}
              <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                <TimerIcon className="h-4 w-4" />
                {getLocalizedString('ينتهي خلال', 'Expire dans', 'Expires in', lang)}:{' '}
                <span className={`font-mono font-medium ${pairingTimer < 60000 ? 'text-red-500' : 'text-amber-600 dark:text-amber-400'}`}>
                  {Math.floor(pairingTimer / 60000)}:{String(Math.floor((pairingTimer % 60000) / 1000)).padStart(2, '0')}
                </span>
              </div>

              {/* Large Pairing Code */}
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">
                  {getLocalizedString(
                    'أدخل هذا الرمز على الجهاز الفعلي لإتمام الربط',
                    'Entrez ce code sur l\'appareil physique pour terminer l\'association',
                    'Enter this code on the physical device to complete pairing',
                    lang,
                  )}
                </p>
                <div className="mx-auto w-fit p-6 rounded-2xl bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-emerald-950/40 dark:to-teal-950/40 border-2 border-dashed border-emerald-300 dark:border-emerald-800">
                  <p className="text-4xl font-bold font-mono tracking-[0.3em] text-emerald-700 dark:text-emerald-400">
                    {pairingCode}
                  </p>
                </div>
              </div>

              {/* QR Code placeholder */}
              <div className="flex justify-center">
                <div className="w-32 h-32 rounded-xl border-2 border-dashed border-muted-foreground/30 flex items-center justify-center">
                  <QrCode className="h-16 w-16 text-muted-foreground/40" />
                </div>
              </div>

              {/* Instructions */}
              <div className="space-y-2 text-start text-sm bg-muted/50 rounded-lg p-3">
                <p className="font-medium">{getLocalizedString('التعليمات:', 'Instructions :', 'Instructions:', lang)}</p>
                <ol className={`list-decimal space-y-1 text-muted-foreground ${rtl ? 'pr-4' : 'pl-4'}`}>
                  <li>{getLocalizedString('افتح تطبيق بلاصتي على الجهاز', 'Ouvrez l\'application BLASTI sur l\'appareil', 'Open BLASTI app on the device', lang)}</li>
                  <li>{getLocalizedString('اذهب إلى إعدادات الربط', 'Allez dans les paramètres d\'association', 'Go to pairing settings', lang)}</li>
                  <li>{getLocalizedString('أدخل رمز الربط أعلاه', 'Entrez le code d\'association ci-dessus', 'Enter the pairing code above', lang)}</li>
                  <li>{getLocalizedString('انتظر تأكيد الربط', 'Attendez la confirmation', 'Wait for pairing confirmation', lang)}</li>
                </ol>
              </div>

              {/* Copy Button */}
              <Button
                variant="outline"
                onClick={onCopyPairingCode}
                className="gap-1.5"
              >
                {pairingCodeCopied ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
                {pairingCodeCopied
                  ? getLocalizedString('تم النسخ', 'Copié', 'Copied', lang)
                  : (getLocalizedString('نسخ الرمز', 'Copier le code', 'Copy Code', lang))
                }
              </Button>
            </>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// tiny timer icon since we can't import from lucide (Timer may conflict)
function TimerIcon({ className }: { className?: string }) {
  return <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2"/><path d="M5 3L2 6"/><path d="M22 6l-3-3"/><path d="M12 2v3"/></svg>;
}

// ─── Command Dialog ───────────────────────────────────────────────────────

interface CommandDialogProps {
  open: boolean;
  lang: string;
  rtl: boolean;
  device: AgencyDevice | null;
  commandType: CommandType;
  commandPayload: string;
  commandSending: boolean;
  onOpenChange: (open: boolean) => void;
  onCommandTypeChange: (v: CommandType) => void;
  onCommandPayloadChange: (v: string) => void;
  onSend: () => void;
}

export function CommandDialog({
  open,
  lang,
  rtl,
  device,
  commandType,
  commandPayload,
  commandSending,
  onOpenChange,
  onCommandTypeChange,
  onCommandPayloadChange,
  onSend,
}: CommandDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) { /* clear */ } }}>
      <DialogContent className="max-w-md" dir={rtl ? 'rtl' : 'ltr'}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Terminal className="h-5 w-5 text-violet-500" />
            {getLocalizedString('إرسال أمر', 'Envoyer une commande', 'Send Command', lang)}
          </DialogTitle>
          <DialogDescription>
            {device ? getLocalizedName(device, lang) : ''}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label className="text-sm font-medium">{getLocalizedString('نوع الأمر', 'Type de commande', 'Command Type', lang)}</Label>
            <div className="grid grid-cols-2 gap-2">
              {(Object.keys(COMMAND_TYPE_CONFIG) as CommandType[]).map((ct) => {
                const cfg = COMMAND_TYPE_CONFIG[ct];
                const CIcon = cfg.icon;
                const isSelected = commandType === ct;
                return (
                  <button
                    key={ct}
                    type="button"
                    onClick={() => onCommandTypeChange(ct)}
                    className={`flex items-center gap-2 p-2.5 rounded-lg border-2 transition-all text-start text-sm ${
                      isSelected
                        ? 'border-violet-500 bg-violet-50 dark:bg-violet-950/30'
                        : 'border-border hover:border-violet-300 dark:hover:border-violet-800'
                    }`}
                  >
                    <div className={`p-1 rounded ${isSelected ? cfg.color : 'bg-muted'}`}>
                      <CIcon className="h-4 w-4" />
                    </div>
                    <span className={`font-medium text-xs ${isSelected ? 'text-foreground' : 'text-muted-foreground'}`}>
                      {getLocalizedLabel(cfg, lang)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {commandType === 'CONFIG_UPDATE' && (
            <div className="space-y-1.5">
              <Label className="text-sm font-medium">{getLocalizedString('المحتوى', 'Charge utile', 'Payload', lang)} (JSON)</Label>
              <Textarea
                className="font-mono text-xs min-h-[120px]"
                value={commandPayload}
                onChange={(e) => onCommandPayloadChange(e.target.value)}
                placeholder='{"fontSize": 24, "theme": "dark"}'
              />
            </div>
          )}

          {commandType === 'REBOOT' && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800">
              <CircleAlert className="h-4 w-4 text-red-500 mt-0.5 shrink-0" />
              <div className="text-xs text-red-700 dark:text-red-400 space-y-1">
                <p className="font-medium">{getLocalizedString('تحذير', 'Avertissement', 'Warning', lang)}</p>
                <p>
                  {getLocalizedString(
                    'سيتم إعادة تشغيل الجهاز على الفور. قد يستغرق الأمر بضع دقائق للاتصال مجدداً.',
                    'L\'appareil redémarrera immédiatement. La reconnexion peut prendre quelques minutes.',
                    'The device will reboot immediately. It may take a few minutes to reconnect.',
                    lang,
                  )}
                </p>
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {getLocalizedString('إلغاء', 'Annuler', 'Cancel', lang)}
          </Button>
          <Button
            onClick={onSend}
            disabled={commandSending || (commandType === 'CONFIG_UPDATE' && !commandPayload.trim())}
            className={`gap-1.5 ${
              commandType === 'REBOOT'
                ? 'bg-red-600 hover:bg-red-700 text-white'
                : 'bg-gradient-to-r from-violet-500 to-purple-600 hover:from-violet-600 hover:to-purple-700 text-white'
            }`}
          >
            {commandSending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            {commandType === 'REBOOT'
              ? (getLocalizedString('إعادة التشغيل', 'Redémarrer', 'Reboot Device', lang))
              : (getLocalizedString('إرسال الأمر', 'Envoyer', 'Send Command', lang))
            }
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Delete Confirm Dialog ────────────────────────────────────────────────

interface DeleteConfirmDialogProps {
  open: boolean;
  lang: string;
  rtl: boolean;
  device: AgencyDevice | null;
  loading: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

export function DeleteConfirmDialog({
  open,
  lang,
  rtl,
  device,
  loading,
  onOpenChange,
  onConfirm,
}: DeleteConfirmDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={(o) => { onOpenChange(o); }}>
      <AlertDialogContent dir={rtl ? 'rtl' : 'ltr'}>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Trash2 className="h-5 w-5 text-red-500" />
            {getLocalizedString('حذف الجهاز', 'Supprimer l\'appareil', 'Delete Device', lang)}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {getLocalizedString(
              `هل أنت متأكد من حذف "${device?.name ?? ''}"؟ لا يمكن التراجع عن هذا الإجراء.`,
              `Êtes-vous sûr de vouloir supprimer "${device?.name ?? ''}" ? Cette action est irréversible.`,
              `Are you sure you want to delete "${device?.name ?? ''}"? This action cannot be undone.`,
              lang,
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{getLocalizedString('إلغاء', 'Annuler', 'Cancel', lang)}</AlertDialogCancel>
          <Button
            onClick={onConfirm}
            disabled={loading}
            className="bg-red-600 hover:bg-red-700 text-white gap-1.5"
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="h-4 w-4" />
            )}
            {getLocalizedString('حذف', 'Supprimer', 'Delete', lang)}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ─── Reboot Confirm Dialog ────────────────────────────────────────────────

interface RebootConfirmDialogProps {
  open: boolean;
  lang: string;
  rtl: boolean;
  device: AgencyDevice | null;
  sending: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

export function RebootConfirmDialog({
  open,
  lang,
  rtl,
  device,
  sending,
  onOpenChange,
  onConfirm,
}: RebootConfirmDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent dir={rtl ? 'rtl' : 'ltr'}>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Power className="h-5 w-5 text-red-500" />
            {getLocalizedString('تأكيد إعادة التشغيل', 'Confirmer le redémarrage', 'Confirm Reboot', lang)}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {getLocalizedString(
              `هل أنت متأكد من إعادة تشغيل "${device?.name ?? ''}"؟ سيتم قطع الاتصال مؤقتاً.`,
              `Êtes-vous sûr de vouloir redémarrer "${device?.name ?? ''}" ? L'appareil sera temporairement déconnecté.`,
              `Are you sure you want to reboot "${device?.name ?? ''}"? The device will be temporarily disconnected.`,
              lang,
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{getLocalizedString('إلغاء', 'Annuler', 'Cancel', lang)}</AlertDialogCancel>
          <Button
            onClick={onConfirm}
            disabled={sending}
            className="bg-red-600 hover:bg-red-700 text-white gap-1.5"
          >
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Power className="h-4 w-4" />}
            {getLocalizedString('إعادة التشغيل', 'Redémarrer', 'Reboot', lang)}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ─── Kiosk Credentials Dialog ─────────────────────────────────────────────

interface KioskCredentialsDialogProps {
  open: boolean;
  lang: string;
  rtl: boolean;
  device: AgencyDevice | null;
  loading: boolean;
  pairingCode: string;
  token: string;
  tokenVisible: boolean;
  copiedField: string | null;
  t: (key: string) => string;
  onOpenChange: (open: boolean) => void;
  onTokenVisibleChange: (v: boolean) => void;
  onCopyField: (text: string, field: string) => void;
  onRegenerate: () => void;
}

export function KioskCredentialsDialog({
  open,
  lang,
  rtl,
  device,
  loading,
  pairingCode,
  token,
  tokenVisible,
  copiedField,
  t,
  onOpenChange,
  onTokenVisibleChange,
  onCopyField,
  onRegenerate,
}: KioskCredentialsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); }}>
      <DialogContent className="max-w-md" dir={rtl ? 'rtl' : 'ltr'}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-amber-500" />
            {t('kioskCredentialsTitle')}
          </DialogTitle>
          <DialogDescription>
            {device ? getLocalizedName(device, lang) : ''}
          </DialogDescription>
        </DialogHeader>

        {loading && !token ? (
          <div className="flex flex-col items-center gap-3 py-8">
            <Loader2 className="h-8 w-8 animate-spin text-emerald-500" />
            <p className="text-sm text-muted-foreground">{t('loading')}</p>
          </div>
        ) : token ? (
          <div className="space-y-4 py-2">
            <div className="rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 p-3">
              <p className="text-xs text-amber-700 dark:text-amber-300">{t('kioskCredentialsInstructions')}</p>
            </div>

            <div className="space-y-1.5">
              <Label className="text-sm font-medium flex items-center gap-1.5">
                <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
                {t('kioskCredentialUsername')}
              </Label>
              <div className="flex items-center gap-2">
                <div className="flex-1 p-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/30 border-2 border-emerald-200 dark:border-emerald-800 font-mono text-lg font-bold text-center tracking-widest text-emerald-700 dark:text-emerald-400">
                  {pairingCode}
                </div>
                <Button variant="outline" size="icon" onClick={() => onCopyField(pairingCode, 'code')} className="shrink-0">
                  {copiedField === 'code' ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-sm font-medium flex items-center gap-1.5">
                <KeyRound className="h-3.5 w-3.5 text-amber-500" />
                {t('kioskCredentialPassword')}
              </Label>
              <div className="flex items-center gap-2">
                <div className="flex-1 p-3 rounded-lg bg-gray-50 dark:bg-gray-900 border-2 border-gray-200 dark:border-gray-700 font-mono text-xs break-all text-center text-foreground overflow-hidden max-h-20">
                  {tokenVisible ? token : '•••••••••••••••••••••••••••••••••••••••••••••••••••••••••'}
                </div>
                <div className="flex flex-col gap-1">
                  <Button variant="outline" size="icon" onClick={() => onTokenVisibleChange(!tokenVisible)} className="shrink-0 h-8 w-8">
                    {tokenVisible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </Button>
                  <Button variant="outline" size="icon" onClick={() => onCopyField(token, 'token')} className="shrink-0 h-8 w-8">
                    {copiedField === 'token' ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
                  </Button>
                </div>
              </div>
            </div>

            <div className="rounded-lg bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800 p-3">
              <p className="text-xs text-red-600 dark:text-red-400">
                <CircleAlert className="h-3.5 w-3.5 inline-block me-1 -mt-0.5" />
                {t('kioskRegenerateWarning')}
              </p>
            </div>

            <div className="flex gap-2 pt-1">
              <Button
                variant="outline"
                className="flex-1 gap-1.5 text-amber-600 border-amber-300 hover:bg-amber-50 dark:text-amber-400 dark:border-amber-700 dark:hover:bg-amber-950/20"
                onClick={onRegenerate}
                disabled={loading}
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCw className="h-4 w-4" />}
                {t('kioskRegenerateCredentials')}
              </Button>
              <Button className="flex-1" onClick={() => onOpenChange(false)}>
                {getLocalizedString('إغلاق', 'Fermer', 'Close', lang)}
              </Button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

// ─── Create Kiosk Dialog ──────────────────────────────────────────────────

interface CreateKioskDialogProps {
  open: boolean;
  lang: string;
  rtl: boolean;
  t: (key: string) => string;
  loading: boolean;
  name: string;
  nameAr: string;
  nameFr: string;
  branchId: string;
  result: { pairingCode: string; deviceToken: string; deviceName: string } | null;
  resultVisible: boolean;
  resultCopiedField: string | null;
  branches: Branch[];
  onOpenChange: (open: boolean) => void;
  onNameChange: (v: string) => void;
  onNameArChange: (v: string) => void;
  onNameFrChange: (v: string) => void;
  onBranchIdChange: (v: string) => void;
  onResultVisibleChange: (v: boolean) => void;
  onSubmit: () => void;
  onCopyField: (text: string, field: string) => void;
}

export function CreateKioskDialog({
  open,
  lang,
  rtl,
  t,
  loading,
  name,
  nameAr,
  nameFr,
  branchId,
  result,
  resultVisible,
  resultCopiedField,
  branches,
  onOpenChange,
  onNameChange,
  onNameArChange,
  onNameFrChange,
  onBranchIdChange,
  onResultVisibleChange,
  onSubmit,
  onCopyField,
}: CreateKioskDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) { /* clear */ } }}>
      <DialogContent className="max-w-lg" dir={rtl ? 'rtl' : 'ltr'}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-gradient-to-br from-amber-500 to-orange-500 text-white">
              <KeyRound className="h-4 w-4" />
            </div>
            {getLocalizedString('إنشاء بيانات دخول الكيوسك', 'Créer identifiants kiosque', 'Create Kiosk Login Credentials', lang)}
          </DialogTitle>
          <DialogDescription>
            {getLocalizedString(
              'أنشئ بيانات دخول لجهاز الكيوسك لربطه بفرعوكالة',
              'Créez des identifiants pour connecter un kiosque à une branche',
              'Create login credentials to connect a kiosk device to a branch',
              lang,
            )}
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-4 py-2">
            <div className="rounded-xl border-2 border-dashed border-amber-300 dark:border-amber-700 p-5 space-y-4 text-center">
              <CheckCircle2 className="h-10 w-10 mx-auto text-emerald-500" />
              <h3 className="text-lg font-semibold">
                {getLocalizedString('تم إنشاء بيانات الكيوسك بنجاح!', 'Identifiants créés avec succès!', 'Kiosk credentials created!', lang)}
              </h3>

              <div className="space-y-2">
                <Label className="text-sm font-medium flex items-center justify-center gap-1.5">
                  <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
                  {getLocalizedString('اسم المستخدم (رمز الربط)', 'Nom d\'utilisateur (code)', 'Username (Pairing Code)', lang)}
                </Label>
                <div className="flex items-center gap-2">
                  <div className="flex-1 p-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/30 border-2 border-emerald-200 dark:border-emerald-800 font-mono text-lg font-bold text-center tracking-widest text-emerald-700 dark:text-emerald-400">
                    {result.pairingCode}
                  </div>
                  <Button variant="outline" size="icon" onClick={() => onCopyField(result.pairingCode, 'code')} className="shrink-0">
                    {resultCopiedField === 'code' ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
              </div>

              <div className="space-y-2">
                <Label className="text-sm font-medium flex items-center justify-center gap-1.5">
                  <KeyRound className="h-3.5 w-3.5 text-amber-500" />
                  {getLocalizedString('كلمة المرور (رمز المصادقة)', 'Mot de passe (jeton)', 'Password (Device Token)', lang)}
                </Label>
                <div className="flex items-center gap-2">
                  <div className="flex-1 p-3 rounded-lg bg-gray-50 dark:bg-gray-900 border-2 border-gray-200 dark:border-gray-700 font-mono text-xs break-all text-center text-foreground overflow-hidden max-h-20">
                    {resultVisible
                      ? result.deviceToken
                      : '•••••••••••••••••••••••••••••••••••••••••••••••••••••••••'
                    }
                  </div>
                  <div className="flex flex-col gap-1">
                    <Button variant="outline" size="icon" onClick={() => onResultVisibleChange(!resultVisible)} className="shrink-0 h-8 w-8">
                      {resultVisible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    </Button>
                    <Button variant="outline" size="icon" onClick={() => onCopyField(result.deviceToken, 'token')} className="shrink-0 h-8 w-8">
                      {resultCopiedField === 'token' ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
                    </Button>
                  </div>
                </div>
              </div>

              <div className="rounded-lg bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800 p-3">
                <p className="text-xs text-red-600 dark:text-red-400">
                  <CircleAlert className="h-3.5 w-3.5 inline-block me-1 -mt-0.5" />
                  {getLocalizedString(
                    'احفظ هذه البيانات بأمان. كلمة المرور لن تظهر مرة أخرى!',
                    'Conservez ces identifiants en sécurité. Le mot de passe ne s\'affichera plus!',
                    'Keep these credentials safe. The password will not be shown again!',
                    lang,
                  )}
                </p>
              </div>
            </div>

            <DialogFooter className="gap-2">
              <Button onClick={() => onOpenChange(false)} className="w-full bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white">
                {getLocalizedString('تم', 'Terminé', 'Done', lang)}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <>
            <div className="space-y-4 py-2">
              <div className="space-y-1.5">
                <Label className="text-sm font-medium">
                  {getLocalizedString('اسم الكيوسك', 'Nom du kiosque', 'Kiosk Name', lang)} <span className="text-red-500">*</span>
                </Label>
                <Input value={name} onChange={(e) => onNameChange(e.target.value)} placeholder={lang === 'ar' ? 'مثال: كيوسك الاستقبال' : 'e.g., Reception Kiosk'} />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-sm">{getLocalizedString('الاسم بالعربية', 'Nom en arabe', 'Arabic Name', lang)}</Label>
                  <Input value={nameAr} onChange={(e) => onNameArChange(e.target.value)} placeholder="الاسم بالعربية" dir="rtl" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-sm">{getLocalizedString('الاسم بالفرنسية', 'Nom en français', 'French Name', lang)}</Label>
                  <Input value={nameFr} onChange={(e) => onNameFrChange(e.target.value)} placeholder={t('dmFrenchNamePlaceholder') || 'Nom en français'} dir="ltr" />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-sm font-medium">
                  {getLocalizedString('الفرع', 'Branche', 'Branch', lang)} <span className="text-red-500">*</span>
                </Label>
                {branches.length > 0 ? (
                  <Select value={branchId} onValueChange={onBranchIdChange}>
                    <SelectTrigger>
                      <SelectValue placeholder={getLocalizedString('اختر فرعاً', 'Sélectionner une branche', 'Select a branch', lang)} />
                    </SelectTrigger>
                    <SelectContent>
                      {branches.map((b) => (
                        <SelectItem key={b.id} value={b.id}>{getLocalizedName(b, lang)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {getLocalizedString('لا توجد فروع متاحة', 'Aucune branche disponible', 'No branches available', lang)}
                  </p>
                )}
              </div>

              <div className="rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 p-3">
                <p className="text-xs text-amber-700 dark:text-amber-300">
                  <Info className="h-3.5 w-3.5 inline-block me-1 -mt-0.5" />
                  {getLocalizedString(
                    'سيتم إنشاء جهاز كيوسك جديد مع بيانات دخول (اسم مستخدم + كلمة مرور). استخدم هذه البيانات لتسجيل الدخول على جهاز الكيوسك.',
                    'Un nouvel appareil kiosque sera créé avec des identifiants (nom d\'utilisateur + mot de passe). Utilisez-les pour vous connecter sur l\'appareil kiosque.',
                    'A new kiosk device will be created with login credentials (username + password). Use these to log in on the kiosk device.',
                    lang,
                  )}
                </p>
              </div>
            </div>

            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {getLocalizedString('إلغاء', 'Annuler', 'Cancel', lang)}
              </Button>
              <Button
                onClick={onSubmit}
                disabled={loading || !name.trim()}
                className="flex-1 bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                {getLocalizedString('إنشاء بيانات الدخول', 'Créer les identifiants', 'Create Credentials', lang)}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── TV Preview Dialog ────────────────────────────────────────────────────

interface TvPreviewDialogProps {
  open: boolean;
  lang: string;
  rtl: boolean;
  device: AgencyDevice | null;
  urlCopied: boolean;
  agencyId: string;
  onOpenChange: (open: boolean) => void;
  onCopyUrl: () => void;
  getTvBoardUrl: (device: AgencyDevice) => string;
}

export function TvPreviewDialog({
  open,
  lang,
  rtl,
  device,
  urlCopied,
  agencyId,
  onOpenChange,
  onCopyUrl,
  getTvBoardUrl,
}: TvPreviewDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) { /* clear */ } }}>
      <DialogContent className="bg-gray-900 border-gray-800 text-white sm:max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Monitor className="h-5 w-5 text-cyan-400" />
            {getLocalizedString('معاينة شاشة العرض', 'Aperçu écran TV', 'TV Screen Preview', lang)}
            {device && <span className="text-sm font-normal text-gray-400">— {device.name}</span>}
          </DialogTitle>
          <DialogDescription className="text-gray-400">
            {getLocalizedString(
              'معاينة مباشرة لشاشة عرض الطابور. انسخ الرابط لفتحه على أي شاشة متصلة.',
              "Aperçu en direct de l'écran d'affichage de la file. Copiez le lien pour l'ouvrir sur n'importe quel écran connecté.",
              'Live preview of the queue display board. Copy the URL to open on any connected screen.',
              lang,
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 mt-2">
          {device && (
            <div className="relative w-full rounded-xl overflow-hidden border border-gray-700 bg-black" style={{ aspectRatio: '16/9' }}>
              <iframe
                src={getTvBoardUrl(device)}
                className="w-full h-full"
                title="TV Board Preview"
                sandbox="allow-scripts allow-same-origin"
                loading="lazy"
              />
              <div className="absolute top-2 end-2 bg-black/60 backdrop-blur-sm rounded-lg px-2.5 py-1 text-xs text-cyan-300 font-medium flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-cyan-400 animate-pulse" />
                {getLocalizedString('معاينة مباشرة', 'Aperçu en direct', 'Live Preview', lang)}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 mt-3 pt-3 border-t border-gray-800">
          <div className="flex-1 flex items-center gap-2 bg-gray-800/60 rounded-lg px-3 py-2">
            <Globe className="h-4 w-4 text-gray-400 flex-shrink-0" />
            <span className="text-xs text-gray-300 truncate font-mono">
              {device ? getTvBoardUrl(device) : ''}
            </span>
          </div>
          <Button variant="outline" size="sm" onClick={onCopyUrl} className="gap-1.5 border-gray-700 hover:bg-gray-800 flex-shrink-0">
            {urlCopied ? (
              <><CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" /> {getLocalizedString('تم النسخ', 'Copié', 'Copied', lang)}</>
            ) : (
              <><Copy className="h-3.5 w-3.5" /> {getLocalizedString('نسخ الرابط', 'Copier le lien', 'Copy URL', lang)}</>
            )}
          </Button>
          <Button variant="outline" size="sm" onClick={() => { if (device) window.open(getTvBoardUrl(device), '_blank'); }} className="gap-1.5 border-gray-700 hover:bg-gray-800 flex-shrink-0">
            <Globe className="h-3.5 w-3.5" />
            {getLocalizedString('فتح في علامة جديدة', 'Ouvrir dans un nouvel onglet', 'Open in New Tab', lang)}
          </Button>
        </div>

        <div className="mt-3 rounded-lg bg-gray-800/40 border border-gray-700/50 p-3">
          <p className="text-xs font-medium text-gray-300 mb-2">
            {getLocalizedString('🔗 كيفية الاتصال بالشاشة', '🔗 Comment connecter l\'écran', '🔗 How to connect the screen', lang)}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px] text-gray-400">
            <div className="flex items-start gap-2">
              <Wifi className="h-3.5 w-3.5 text-cyan-400 mt-0.5 flex-shrink-0" />
              <span>{getLocalizedString('WIFI: افتح الرابط على متصفح جهاز متصل بنفس الشبكة', 'WIFI: Ouvrez le lien dans un navigateur sur le même réseau', 'WIFI: Open the URL in a browser on the same network', lang)}</span>
            </div>
            <div className="flex items-start gap-2">
              <Cable className="h-3.5 w-3.5 text-cyan-400 mt-0.5 flex-shrink-0" />
              <span>{getLocalizedString('LAN/HDMI: انسخ الرابط وافتحه على الشاشة الثانوية', 'LAN/HDMI: Copiez le lien et ouvrez-le sur l\'écran secondaire', 'LAN/HDMI: Copy the URL and open on the secondary screen', lang)}</span>
            </div>
            <div className="flex items-start gap-2">
              <Cast className="h-3.5 w-3.5 text-cyan-400 mt-0.5 flex-shrink-0" />
              <span>{getLocalizedString('ChromeCast: استخدم بث Chrome من متصفح Chrome لعرض الشاشة', 'ChromeCast: Utilisez le cast Chrome depuis le navigateur Chrome', 'ChromeCast: Use Chrome Cast from Chrome browser to display', lang)}</span>
            </div>
            <div className="flex items-start gap-2">
              <Monitor className="h-3.5 w-3.5 text-cyan-400 mt-0.5 flex-shrink-0" />
              <span>{getLocalizedString('شاشة ثانوية: اسحب المتصفح إلى الشاشة الثانوية واجعله بملء الشاشة', 'Écran secondaire: Glissez le navigateur vers l\'écran secondaire et mettez en plein écran', 'Secondary screen: Drag browser to secondary display and go fullscreen', lang)}</span>
            </div>
          </div>
        </div>

        <DialogFooter className="mt-2">
          <Button onClick={() => onOpenChange(false)} className="gap-1.5">
            {getLocalizedString('إغلاق', 'Fermer', 'Close', lang)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── TV QR Dialog ─────────────────────────────────────────────────────────

interface TvQrDialogProps {
  open: boolean;
  lang: string;
  agencyId: string;
  onOpenChange: (open: boolean) => void;
  onCopyUrl: () => void;
}

export function TvQrDialog({
  open,
  lang,
  agencyId,
  onOpenChange,
  onCopyUrl,
}: TvQrDialogProps) {
  const tvUrl = `${window.location.origin}/?mode=device&type=TV&agencyId=${agencyId}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <QrCode className="h-5 w-5 text-cyan-400" />
            {getLocalizedString('رابط شاشة التلفاز', 'Lien écran TV', 'TV Screen Link', lang)}
          </DialogTitle>
          <DialogDescription className="text-gray-400">
            {getLocalizedString(
              'استخدم هذا الرابط لفتح شاشة عرض الطابور على أي تلفاز أو جهاز متصل بالشبكة',
              'Utilisez ce lien pour ouvrir l\'écran de file sur tout téléviseur ou appareil connecté au réseau',
              'Use this URL to open the queue display on any TV or device on the network',
              lang,
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col items-center gap-5 py-4">
          <div className="w-full rounded-xl bg-gray-900 border border-gray-700 p-4">
            <p className="text-xs font-semibold text-gray-400 mb-2 uppercase tracking-wider">
              {getLocalizedString('أدخل هذا الرابط في متصفح التلفاز', 'Entrez ce lien dans le navigateur TV', 'Enter this URL in the TV browser', lang)}
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-sm font-mono text-emerald-300 bg-gray-800 rounded-lg px-3 py-2.5 break-all select-all leading-relaxed">
                {tvUrl}
              </code>
              <Button
                size="sm"
                onClick={onCopyUrl}
                className="flex-shrink-0 gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white"
              >
                <Copy className="h-4 w-4" />
                {getLocalizedString('نسخ', 'Copier', 'Copy', lang)}
              </Button>
            </div>
          </div>

          <div className="flex items-center gap-3 w-full">
            <div className="flex-1 h-px bg-gray-700" />
            <span className="text-xs text-gray-500">{getLocalizedString('أو', 'ou', 'OR')}</span>
            <div className="flex-1 h-px bg-gray-700" />
          </div>

          <div className="bg-white rounded-2xl p-4 shadow-lg">
            <img
              src={`https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(tvUrl)}&bgcolor=ffffff&color=000000`}
              alt="TV Screen QR Code"
              className="w-[220px] h-[220px]"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = 'none';
                (e.target as HTMLImageElement).parentElement!.innerHTML = `<div class="p-4 text-center"><p class="text-xs text-gray-500">QR unavailable</p></div>`;
              }}
            />
          </div>
          <p className="text-xs text-gray-400 text-center">
            {getLocalizedString(
              '📱 امسح الرمز بهاتفك لفتح الشاشة فوراً',
              '📱 Scannez le code pour ouvrir l\'écran instantanément',
              '📱 Scan the code to open the display instantly',
              lang,
            )}
          </p>
        </div>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} className="gap-1.5">
            {getLocalizedString('إغلاق', 'Fermer', 'Close', lang)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Scan Results Dialog ──────────────────────────────────────────────────

interface ScanResultsDialogProps {
  open: boolean;
  lang: string;
  rtl: boolean;
  scanning: boolean;
  scanProgress: number;
  discoveredDevices: DiscoveredDevice[];
  registeredDeviceIds: Set<string>;
  onOpenChange: (open: boolean) => void;
  onScan: () => void;
  onAddDiscovered: (disc: DiscoveredDevice) => void;
}

export function ScanResultsDialog({
  open,
  lang,
  rtl,
  scanning,
  scanProgress,
  discoveredDevices,
  registeredDeviceIds,
  onOpenChange,
  onScan,
  onAddDiscovered,
}: ScanResultsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) { /* clear */ } }}>
      <DialogContent className="max-w-md" dir={rtl ? 'rtl' : 'ltr'}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Radio className="h-5 w-5 text-teal-500" />
            {getLocalizedString('البحث في الشبكة', 'Recherche réseau', 'Scan Network', lang)}
          </DialogTitle>
          <DialogDescription>
            {getLocalizedString(
              'البحث عن الأجهزة المتاحة على الشبكة المحلية',
              'Rechercher les appareils disponibles sur le réseau local',
              'Scan for available devices on the local network',
              lang,
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {scanning && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin text-amber-500" />
                <span className="text-sm text-amber-600 dark:text-amber-400">
                  {getLocalizedString('جاري البحث في الشبكة...', 'Recherche en cours...', 'Scanning network...', lang)}
                </span>
              </div>
              <div className="w-full bg-muted rounded-full h-2 overflow-hidden">
                <motion.div
                  className="bg-gradient-to-r from-teal-500 to-emerald-500 h-2 rounded-full"
                  initial={{ width: 0 }}
                  animate={{ width: `${scanProgress}%` }}
                  transition={{ duration: 0.3 }}
                />
              </div>
            </div>
          )}

          {!scanning && discoveredDevices.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm font-medium">
                {getLocalizedString(
                  `تم اكتشاف ${discoveredDevices.length} جهاز`,
                  `${discoveredDevices.length} appareil(s) découvert(s)`,
                  `${discoveredDevices.length} device(s) found`,
                  lang,
                )}
              </p>
              <div className="space-y-2 max-h-80 overflow-y-auto">
                {discoveredDevices.map((disc) => {
                  const discTypeConfig = DEVICE_TYPE_CONFIG[disc.type as keyof typeof DEVICE_TYPE_CONFIG];
                  const discStatusConfig = STATUS_CONFIG[disc.status];
                  const DiscIcon = discTypeConfig?.icon ?? Globe;
                  const alreadyAdded = registeredDeviceIds.has(disc.id);

                  return (
                    <motion.div
                      key={disc.id}
                      initial={{ opacity: 0, x: rtl ? 10 : -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      className="flex items-center justify-between p-3 rounded-lg bg-muted/50 hover:bg-muted/80 transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <div className={`p-1.5 rounded-md ${discTypeConfig?.color ?? 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400'}`}>
                          <DiscIcon className="h-4 w-4" />
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium">
                              {getLocalizedName(disc, lang)}
                            </span>
                            <Badge variant="secondary" className={`text-[10px] px-1 py-0 ${discStatusConfig.color}`}>
                              <span className={`inline-block h-1.5 w-1.5 rounded-full ${discStatusConfig.dotColor} mr-1`} />
                              {getLocalizedLabel(discStatusConfig, lang)}
                            </Badge>
                          </div>
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            {disc.ipAddress && <span className="font-mono">{disc.ipAddress}{disc.port ? `:${disc.port}` : ''}</span>}
                          </div>
                        </div>
                      </div>
                      <div>
                        {alreadyAdded ? (
                          <Badge variant="secondary" className="text-[10px] gap-1 text-emerald-600 bg-emerald-50 dark:bg-emerald-950/30 dark:text-emerald-400">
                            <CheckCircle2 className="h-3 w-3" />
                            {getLocalizedString('مضاف', 'Ajouté', 'Added', lang)}
                          </Badge>
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => { onAddDiscovered(disc); onOpenChange(false); }}
                            className="h-7 text-xs gap-1"
                          >
                            <Plus className="h-3 w-3" />
                            {getLocalizedString('إضافة', 'Ajouter', 'Add', lang)}
                          </Button>
                        )}
                      </div>
                    </motion.div>
                  );
                })}
              </div>
            </div>
          )}

          {!scanning && discoveredDevices.length === 0 && (
            <div className="flex flex-col items-center gap-3 py-6 text-muted-foreground">
              <WifiOff className="h-8 w-8 opacity-50" />
              <p className="text-sm">
                {getLocalizedString('لم يتم اكتشاف أجهزة', 'Aucun appareil découvert', 'No devices found', lang)}
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onScan} disabled={scanning} className="gap-1.5">
            {scanning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            {getLocalizedString('بحث مرة أخرى', 'Rechercher à nouveau', 'Scan Again', lang)}
          </Button>
          <Button onClick={() => onOpenChange(false)}>
            {getLocalizedString('إغلاق', 'Fermer', 'Close', lang)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}