'use client';

/**
 * Payment Gateway settings page (Task 5).
 *
 * The manual CCP / bank / e-wallet receipt settings used to be an inline card
 * buried mid-way in the admin-settings long-scroll page; they now live on
 * their own view (admin-settings-payments → #/admin/settings/payments).
 * Self-contained page component: owns the p-4 lg:p-6 padding + premium
 * section header via AdminSettingsSectionPage, then the settings card
 * (PUT /api/admin/payment-settings).
 */

import { useState, useEffect } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import { useLanguage } from '@/hooks/use-language';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { CreditCard, Building2, Wallet, Loader2, Save } from 'lucide-react';
import { toast } from 'sonner';
import { AdminSettingsSectionPage } from '@/components/admin/admin-settings-section-page';

export function AdminPaymentGatewaySettings() {
  const { t } = useLanguage();

  // ── State ──
  const [paymentSettings, setPaymentSettings] = useState<{
    ccpEnabled: boolean; bankEnabled: boolean; electronicEnabled: boolean;
    ccpAccount: string; ccpKey: string; bankName: string;
    bankAccount: string; bankRib: string; ewalletNumber: string;
  }>({ ccpEnabled: false, bankEnabled: false, electronicEnabled: false, ccpAccount: '', ccpKey: '', bankName: '', bankAccount: '', bankRib: '', ewalletNumber: '' });
  const [savingPayment, setSavingPayment] = useState(false);

  // ── Fetch on mount ──
  useEffect(() => {
    fetchPaymentSettings();
  }, []);

  // ── Payment settings ──
  const fetchPaymentSettings = async () => {
    try {
      const res = await apiFetch('/api/admin/payment-settings');
      if (res.ok) {
        const data = await res.json();
        if (data.settings) {
          setPaymentSettings({
            ccpEnabled: data.settings.ccpEnabled || false,
            bankEnabled: data.settings.bankEnabled || false,
            electronicEnabled: data.settings.electronicEnabled || false,
            ccpAccount: data.settings.ccpAccount || '',
            ccpKey: data.settings.ccpKey || '',
            bankName: data.settings.bankName || '',
            bankAccount: data.settings.bankAccount || '',
            bankRib: data.settings.bankRib || '',
            ewalletNumber: data.settings.ewalletNumber || '',
          });
        }
      }
    } catch {
      // silent fail
    }
  };

  const savePaymentSettings = async () => {
    setSavingPayment(true);
    try {
      const res = await apiFetch('/api/admin/payment-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(paymentSettings),
      });
      if (res.ok) {
        toast.success(t('paymentSaved'));
      } else {
        toast.error(t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setSavingPayment(false);
    }
  };

  return (
    <AdminSettingsSectionPage icon={CreditCard} titleKey="settingsPaymentsGateway" descKey="settingsPaymentsGatewayDesc">
      <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <CreditCard className="h-4 w-4 text-emerald-600" />
            {t('gatewaySettings')}
          </CardTitle>
          <p className="text-[11px] text-muted-foreground">{t('gatewaySettingsDesc')}</p>
        </CardHeader>
        <CardContent className="pt-0 space-y-5">
          {/* CCP Section */}
          <div className="space-y-3 p-3 rounded-xl bg-blue-50/50 dark:bg-blue-900/10 border border-blue-100 dark:border-blue-800/30">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-medium flex items-center gap-2">
                <Building2 className="h-3.5 w-3.5 text-blue-600" />
                {t('ccpEnabled')}
              </Label>
              <Switch
                checked={paymentSettings.ccpEnabled}
                onCheckedChange={(v) => setPaymentSettings({ ...paymentSettings, ccpEnabled: v })}
              />
            </div>
            {paymentSettings.ccpEnabled && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-[10px] text-muted-foreground">{t('ccpAccount')}</Label>
                  <Input
                    value={paymentSettings.ccpAccount}
                    onChange={(e) => setPaymentSettings({ ...paymentSettings, ccpAccount: e.target.value })}
                    placeholder="0000000000"
                    className="h-8 text-xs"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-[10px] text-muted-foreground">{t('ccpKey')}</Label>
                  <Input
                    value={paymentSettings.ccpKey}
                    onChange={(e) => setPaymentSettings({ ...paymentSettings, ccpKey: e.target.value })}
                    placeholder="00"
                    className="h-8 text-xs"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Bank Section */}
          <div className="space-y-3 p-3 rounded-xl bg-green-50/50 dark:bg-green-900/10 border border-green-100 dark:border-green-800/30">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-medium flex items-center gap-2">
                <Building2 className="h-3.5 w-3.5 text-green-600" />
                {t('bankEnabled')}
              </Label>
              <Switch
                checked={paymentSettings.bankEnabled}
                onCheckedChange={(v) => setPaymentSettings({ ...paymentSettings, bankEnabled: v })}
              />
            </div>
            {paymentSettings.bankEnabled && (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="space-y-1">
                  <Label className="text-[10px] text-muted-foreground">{t('bankName')}</Label>
                  <Input
                    value={paymentSettings.bankName}
                    onChange={(e) => setPaymentSettings({ ...paymentSettings, bankName: e.target.value })}
                    placeholder="BNA"
                    className="h-8 text-xs"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-[10px] text-muted-foreground">{t('bankAccount')}</Label>
                  <Input
                    value={paymentSettings.bankAccount}
                    onChange={(e) => setPaymentSettings({ ...paymentSettings, bankAccount: e.target.value })}
                    placeholder="0000000000"
                    className="h-8 text-xs"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-[10px] text-muted-foreground">{t('bankRib')}</Label>
                  <Input
                    value={paymentSettings.bankRib}
                    onChange={(e) => setPaymentSettings({ ...paymentSettings, bankRib: e.target.value })}
                    placeholder="00000000000000000000"
                    className="h-8 text-xs"
                  />
                </div>
              </div>
            )}
          </div>

          {/* E-Wallet Section */}
          <div className="space-y-3 p-3 rounded-xl bg-purple-50/50 dark:bg-purple-900/10 border border-purple-100 dark:border-purple-800/30">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-medium flex items-center gap-2">
                <Wallet className="h-3.5 w-3.5 text-purple-600" />
                {t('electronicEnabled')}
              </Label>
              <Switch
                checked={paymentSettings.electronicEnabled}
                onCheckedChange={(v) => setPaymentSettings({ ...paymentSettings, electronicEnabled: v })}
              />
            </div>
            {paymentSettings.electronicEnabled && (
              <div className="space-y-1">
                <Label className="text-[10px] text-muted-foreground">{t('ewalletNumber')}</Label>
                <Input
                  value={paymentSettings.ewalletNumber}
                  onChange={(e) => setPaymentSettings({ ...paymentSettings, ewalletNumber: e.target.value })}
                  placeholder={t('phonePlaceholder')}
                  className="h-8 text-xs"
                />
              </div>
            )}
          </div>

          {/* Save button */}
          <Button onClick={savePaymentSettings} disabled={savingPayment} className="w-full h-9 text-xs bg-emerald-600 hover:bg-emerald-700">
            {savingPayment ? <Loader2 className="h-3.5 w-3.5 animate-spin me-2" /> : <Save className="h-3.5 w-3.5 me-2" />}
            {t('save')}
          </Button>
        </CardContent>
      </Card>
    </AdminSettingsSectionPage>
  );
}
