'use client';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import {
  Monitor,
  Printer,
  Radio,
  Send,
  Edit3,
  Trash2,
  QrCode,
  Copy,
  Eye,
  EyeOff,
  Terminal,
  Clock,
  Link2,
  MapPin,
  CircleAlert,
  Activity,
  Settings,
  Unplug,
} from 'lucide-react';
import {
  type AgencyDevice,
  DEVICE_TYPE_CONFIG,
  STATUS_CONFIG,
  CONNECTION_TYPE_CONFIG,
  SCREEN_LAYOUT_CONFIG,
  COMMAND_TYPE_CONFIG,
  COMMAND_STATUS_CONFIG,
  StatusDot,
  HeartbeatIndicator,
  ConnectionQualityBar,
  parseDisplaySettings,
  getHeartbeatLabel,
  formatUptime,
  timeSince,
  getConnectionQuality,
  getLocalizedName,
  getLocalizedLabel,
  getLocalizedString,
} from './types';

interface DeviceDetailSheetProps {
  device: AgencyDevice;
  lang: string;
  rtl: boolean;
  tokenRevealed: boolean;
  onTokenRevealedChange: (revealed: boolean) => void;
  onTabChange: (tab: string) => void;
  onPair: (device: AgencyDevice) => void;
  onCommand: (device: AgencyDevice) => void;
  onEdit: (device: AgencyDevice) => void;
  onDelete: (device: AgencyDevice) => void;
  onUnpair: (device: AgencyDevice) => void;
  onCopy: (text: string, label: string) => void;
  onClose: () => void;
}

export function DeviceDetailSheet({
  device,
  lang,
  rtl,
  tokenRevealed,
  onTokenRevealedChange,
  onTabChange,
  onPair,
  onCommand,
  onEdit,
  onDelete,
  onUnpair,
  onCopy,
  onClose,
}: DeviceDetailSheetProps) {
  return (
    <Sheet open={true} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent className={`w-full sm:max-w-lg overflow-y-auto ${rtl ? 'sm:-mr-0' : ''}`} dir={rtl ? 'rtl' : 'ltr'}>
        <SheetHeader className="space-y-1 mb-4">
          <SheetTitle className="flex items-center gap-2 text-lg">
            {(() => {
              const cfg = DEVICE_TYPE_CONFIG[device.type];
              const Icon = cfg.icon;
              return (
                <div className={`p-1.5 rounded-lg ${cfg.color}`}>
                  <Icon className="h-4 w-4" />
                </div>
              );
            })()}
            {getLocalizedName(device, lang)}
          </SheetTitle>
          <SheetDescription>
            {device.ipAddress && `${device.ipAddress}${device.port ? `:${device.port}` : ''}`}
          </SheetDescription>
        </SheetHeader>

        <Tabs defaultValue="info" onValueChange={onTabChange} className="space-y-4">
          <TabsList className="w-full">
            <TabsTrigger value="info" className="flex-1 gap-1">
              <Activity className="h-3.5 w-3.5" />
              {getLocalizedString('معلومات', 'Info', 'Info', lang)}
            </TabsTrigger>
            <TabsTrigger value="config" className="flex-1 gap-1">
              <Settings className="h-3.5 w-3.5" />
              {getLocalizedString('إعدادات', 'Config', 'Config', lang)}
            </TabsTrigger>
            <TabsTrigger value="commands" className="flex-1 gap-1">
              <Terminal className="h-3.5 w-3.5" />
              {getLocalizedString('الأوامر', 'Commandes', 'Commands', lang)}
            </TabsTrigger>
          </TabsList>

          {/* ── Info Tab ────────────────────────────────────── */}
          <TabsContent value="info" className="space-y-4 mt-0">
            {/* Status & Connection */}
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1 rounded-lg border p-3 bg-muted/30">
                  <span className="text-[10px] text-muted-foreground uppercase tracking-wider">{getLocalizedString('الحالة', 'Statut', 'Status', lang)}</span>
                  <div className="flex items-center gap-2">
                    <StatusDot status={device.status} />
                    <span className="text-sm font-medium">{getLocalizedLabel(STATUS_CONFIG[device.status], lang)}</span>
                  </div>
                </div>
                <div className="space-y-1 rounded-lg border p-3 bg-muted/30">
                  <span className="text-[10px] text-muted-foreground uppercase tracking-wider">{getLocalizedString('الاتصال', 'Connexion', 'Connection', lang)}</span>
                  <div className="flex items-center gap-1.5 text-sm font-medium">
                    {(() => {
                      const CIcon = CONNECTION_TYPE_CONFIG[device.connectionType].icon;
                      return <CIcon className="h-4 w-4 text-muted-foreground" />;
                    })()}
                    {getLocalizedLabel(CONNECTION_TYPE_CONFIG[device.connectionType], lang)}
                  </div>
                </div>
              </div>

              {/* Heartbeat live indicator */}
              <div className="rounded-lg border p-3 bg-muted/30 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-muted-foreground uppercase tracking-wider">{getLocalizedString('نبض القلب', 'Heartbeat', 'Heartbeat', lang)}</span>
                  <HeartbeatIndicator lastHeartbeatAt={device.lastHeartbeatAt} />
                </div>
                {(() => {
                  const hb = getHeartbeatLabel(device.lastHeartbeatAt);
                  return (
                    <span className={`text-xs font-medium ${hb.color}`}>
                      {hb.text === 'heartbeatAlive'
                        ? getLocalizedString('نشط الآن', 'En vie maintenant', 'Alive now', lang)
                        : hb.text === 'neverConnected'
                          ? getLocalizedString('لم يتصل أبداً', 'Jamais connecté', 'Never connected', lang)
                          : `${getLocalizedString('آخر ظهور', 'Vu il y a', 'Last seen', lang)} ${hb.text.split('|')[1]}`
                      }
                    </span>
                  );
                })()}
              </div>

              {/* Connection quality */}
              <div className="rounded-lg border p-3 bg-muted/30 space-y-1.5">
                <span className="text-[10px] text-muted-foreground uppercase tracking-wider">{getLocalizedString('جودة الاتصال', 'Qualité de connexion', 'Connection Quality', lang)}</span>
                <ConnectionQualityBar quality={getConnectionQuality(device).quality} />
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>{getLocalizedString('متصل عبر', 'Connecté via', 'Connected via', lang)}: {getLocalizedLabel(CONNECTION_TYPE_CONFIG[device.connectionType], lang)}</span>
                </div>
              </div>

              {/* Details grid */}
              <div className="grid grid-cols-2 gap-2 text-xs">
                {device.ipAddress && (
                  <div className="space-y-0.5">
                    <span className="text-muted-foreground">{getLocalizedString('عنوان IP', 'Adresse IP', 'IP Address', lang)}</span>
                    <p className="font-mono font-medium">{device.ipAddress}{device.port ? `:${device.port}` : ''}</p>
                  </div>
                )}
                <div className="space-y-0.5">
                  <span className="text-muted-foreground">{getLocalizedString('تخطيط الشاشة', 'Disposition', 'Screen Layout', lang)}</span>
                  <p>{getLocalizedLabel(SCREEN_LAYOUT_CONFIG[device.screenLayout], lang)}</p>
                </div>
                <div className="space-y-0.5">
                  <span className="text-muted-foreground">{getLocalizedString('مدة التشغيل', 'Temps de fonction.', 'Total Uptime', lang)}</span>
                  <p className="font-medium">{formatUptime(device.totalUptimeSec)}</p>
                </div>
                {device.appVersion && (
                  <div className="space-y-0.5">
                    <span className="text-muted-foreground">{getLocalizedString('إصدار التطبيق', 'Version de l\'app', 'App Version', lang)}</span>
                    <p>v{device.appVersion}</p>
                  </div>
                )}
                {device.branch && (
                  <div className="space-y-0.5">
                    <span className="text-muted-foreground">{getLocalizedString('الفرع', 'Branche', 'Branch', lang)}</span>
                    <p className="flex items-center gap-1">
                      <MapPin className="h-3 w-3" />
                      {getLocalizedName(device.branch, lang)}
                    </p>
                  </div>
                )}
                {device.deviceFingerprint && (
                  <div className="space-y-0.5">
                    <span className="text-muted-foreground">{getLocalizedString('بصمة الجهاز', 'Empreinte', 'Fingerprint', lang)}</span>
                    <p className="font-mono text-[10px] truncate">{device.deviceFingerprint}</p>
                  </div>
                )}
              </div>

              {/* Pairing Code */}
              {device.pairingCode && (
                <div className="rounded-lg border p-3 bg-amber-50/50 dark:bg-amber-950/20 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-muted-foreground uppercase tracking-wider">{getLocalizedString('رمز الربط', 'Code d\'appariement', 'Pairing Code', lang)}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onCopy(device.pairingCode!, getLocalizedString('تم النسخ', 'Copié', 'Copied', lang))}
                      className="h-6 w-6 p-0"
                    >
                      <Copy className="h-3 w-3" />
                    </Button>
                  </div>
                  <p className="font-mono text-2xl font-bold tracking-widest text-center text-amber-700 dark:text-amber-400">
                    {device.pairingCode}
                  </p>
                </div>
              )}

              {/* Device Token (masked) */}
              {device.token && (
                <div className="rounded-lg border p-3 bg-muted/30 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-muted-foreground uppercase tracking-wider">{getLocalizedString('رمز الجهاز', 'Jeton de l\'appareil', 'Device Token', lang)}</span>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onCopy(device.token!, getLocalizedString('تم نسخ الرمز', 'Jeton copié', 'Token copied', lang))}
                        className="h-6 w-6 p-0"
                      >
                        <Copy className="h-3 w-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onTokenRevealedChange(!tokenRevealed)}
                        className="h-6 w-6 p-0"
                      >
                        {tokenRevealed ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                      </Button>
                    </div>
                  </div>
                  <p className="font-mono text-xs break-all">
                    {tokenRevealed ? device.token : `${device.token?.slice(0, 8)}••••••••••••••••••••••`}
                  </p>
                  <p className="text-[10px] text-amber-600 dark:text-amber-400 flex items-center gap-1">
                    <CircleAlert className="h-3 w-3" />
                    {getLocalizedString('احفظ هذا الرمز بأمان، لن يظهر مرة أخرى', 'Conservez ce jeton en sécurité', 'Keep this token safe, it won\'t be shown again', lang)}
                  </p>
                </div>
              )}

              {/* Action buttons in detail */}
              <div className="grid grid-cols-2 gap-2 pt-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onPair(device)}
                  className="gap-1.5"
                >
                  <QrCode className="h-3.5 w-3.5" />
                  {getLocalizedString('ربط', 'Associer', 'Pair', lang)}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onCommand(device)}
                  className="gap-1.5"
                >
                  <Send className="h-3.5 w-3.5" />
                  {getLocalizedString('إرسال أمر', 'Commande', 'Command', lang)}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onEdit(device)}
                  className="gap-1.5"
                >
                  <Edit3 className="h-3.5 w-3.5" />
                  {getLocalizedString('تعديل', 'Modifier', 'Edit', lang)}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onDelete(device)}
                  className="gap-1.5 text-red-600 hover:text-red-700 border-red-200 hover:bg-red-50 dark:border-red-800 dark:hover:bg-red-950/20"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {getLocalizedString('حذف', 'Supprimer', 'Delete', lang)}
                </Button>
              </div>
              {device.agencyId && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onUnpair(device)}
                  className="w-full gap-1.5 mt-2 text-orange-600 hover:text-orange-700 border-orange-200 hover:bg-orange-50 dark:border-orange-800 dark:hover:bg-orange-950/20"
                >
                  <Unplug className="h-3.5 w-3.5" />
                  {getLocalizedString('فك الربط', 'Dissocier', 'Unpair Device', lang)}
                </Button>
              )}
            </div>
          </TabsContent>

          {/* ── Config Tab ───────────────────────────────────── */}
          <TabsContent value="config" className="space-y-4 mt-0">
            {/* Display Settings as JSON */}
            <div className="space-y-2">
              <Label className="text-xs font-medium flex items-center gap-1.5">
                <Monitor className="h-3.5 w-3.5 text-cyan-500" />
                {getLocalizedString('إعدادات العرض', 'Paramètres d\'affichage', 'Display Settings', lang)}
              </Label>
              <Textarea
                className="font-mono text-xs min-h-[120px]"
                value={JSON.stringify(parseDisplaySettings(device.displaySettings), null, 2)}
                readOnly
              />
            </div>

            {/* Print Config as JSON (for printers) */}
            {device.type === 'PRINTER' && device.printConfig && (
              <div className="space-y-2">
                <Label className="text-xs font-medium flex items-center gap-1.5">
                  <Printer className="h-3.5 w-3.5 text-amber-500" />
                  {getLocalizedString('إعدادات الطباعة', 'Config. impression', 'Print Configuration', lang)}
                </Label>
                <Textarea
                  className="font-mono text-xs min-h-[120px]"
                  value={(() => {
                    let printConfigObj: Record<string, unknown> = {};
                    try {
                      printConfigObj = typeof device.printConfig === 'string' ? JSON.parse(device.printConfig) : (device.printConfig || {});
                    } catch { printConfigObj = {}; }
                    return JSON.stringify(printConfigObj, null, 2);
                  })()}
                  readOnly
                />
              </div>
            )}

            {/* Service Filter */}
            {device.serviceFilter && (
              <div className="space-y-1 rounded-lg border p-3 bg-muted/30">
                <span className="text-[10px] text-muted-foreground uppercase tracking-wider">{getLocalizedString('فلتر الخدمة', 'Filtre de service', 'Service Filter', lang)}</span>
                <p className="text-sm font-medium">{device.serviceFilter}</p>
              </div>
            )}

            {/* Auto Discovery */}
            <div className="rounded-lg border p-3 bg-muted/30 space-y-1">
              <span className="text-[10px] text-muted-foreground uppercase tracking-wider">{getLocalizedString('الاكتشاف التلقائي', 'Découverte auto', 'Auto Discovery', lang)}</span>
              <div className="flex items-center gap-2">
                <Radio className={`h-4 w-4 ${device.autoDiscovery ? 'text-emerald-500' : 'text-muted-foreground'}`} />
                <span className="text-sm">{device.autoDiscovery
                  ? getLocalizedString('مفعّل', 'Activé', 'Enabled', lang)
                  : getLocalizedString('معطّل', 'Désactivé', 'Disabled', lang)
                }</span>
              </div>
            </div>

            {/* Timestamps */}
            <div className="space-y-2 text-xs text-muted-foreground">
              <div className="flex items-center gap-1.5">
                <Clock className="h-3 w-3" />
                {getLocalizedString('تاريخ الإنشاء', 'Créé le', 'Created', lang)}: {timeSince(device.createdAt)}
              </div>
              <div className="flex items-center gap-1.5">
                <Clock className="h-3 w-3" />
                {getLocalizedString('آخر تحديث', 'Mis à jour', 'Updated', lang)}: {timeSince(device.updatedAt)}
              </div>
              {device.connectedAt && (
                <div className="flex items-center gap-1.5">
                  <Link2 className="h-3 w-3" />
                  {getLocalizedString('متصل منذ', 'Connecté depuis', 'Connected since', lang)}: {timeSince(device.connectedAt)}
                </div>
              )}
            </div>
          </TabsContent>

          {/* ── Commands Tab ──────────────────────────────────── */}
          <TabsContent value="commands" className="space-y-4 mt-0">
            <Button
              size="sm"
              onClick={() => onCommand(device)}
              className="gap-1.5 w-full bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-600 hover:to-teal-700 text-white"
            >
              <Send className="h-4 w-4" />
              {getLocalizedString('إرسال أمر جديد', 'Nouvelle commande', 'Send New Command', lang)}
            </Button>

            {(device.commands && device.commands.length > 0) ? (
              <div className="space-y-2 max-h-96 overflow-y-auto">
                {device.commands.map((cmd) => {
                  const cmdTypeCfg = COMMAND_TYPE_CONFIG[cmd.type];
                  const cmdStatusCfg = COMMAND_STATUS_CONFIG[cmd.status];
                  const CmdIcon = cmdTypeCfg.icon;
                  return (
                    <div key={cmd.id} className="flex items-center gap-3 rounded-lg border p-3 bg-muted/30 text-xs">
                      <div className={`p-1.5 rounded-md ${cmdTypeCfg.color} shrink-0`}>
                        <CmdIcon className="h-3.5 w-3.5" />
                      </div>
                      <div className="flex-1 min-w-0 space-y-0.5">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{getLocalizedLabel(cmdTypeCfg, lang)}</span>
                          <Badge variant="secondary" className={`text-[10px] px-1.5 py-0 ${cmdStatusCfg.color}`}>
                            {getLocalizedLabel(cmdStatusCfg, lang)}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-3 text-muted-foreground">
                          <span>{timeSince(cmd.createdAt)}</span>
                          {cmd.deliveredAt && <span>→ {getLocalizedString('تم التسليم', 'Livré', 'Delivered', lang)}</span>}
                          {cmd.completedAt && <span>→ {getLocalizedString('مكتمل', 'Terminé', 'Completed', lang)}</span>}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-center py-8 text-muted-foreground space-y-2">
                <Terminal className="h-8 w-8 mx-auto opacity-40" />
                <p className="text-sm">
                  {getLocalizedString('لا توجد أوامر بعد', 'Aucune commande pour le moment', 'No commands yet', lang)}
                </p>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}