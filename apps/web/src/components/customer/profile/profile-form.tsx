'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Phone, Check, KeyRound, Loader2 } from 'lucide-react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import type { TranslationKeys } from '@/i18n';

import { useLanguage } from '@/hooks/use-language';
interface ProfileFormProps {
  user: {
    id?: string;
    phoneNumber?: string | null;
  } | null;
  initialPhoneNumber: string;
  onSavePhone: (phone: string) => Promise<void>;
  onChangePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  t: (key: TranslationKeys) => string;
}

export function ProfileForm({ user, initialPhoneNumber, onSavePhone, onChangePassword, t }: ProfileFormProps) {
  const [phoneNumber, setPhoneNumber] = useState(initialPhoneNumber);
  const [savingPhone, setSavingPhone] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPasswordVal, setNewPasswordVal] = useState('');
  const [confirmPasswordVal, setConfirmPasswordVal] = useState('');
  const [changePasswordLoading, setChangePasswordLoading] = useState(false);

  const handleSavePhone = async () => {
    if (!phoneNumber.trim()) return;
    setSavingPhone(true);
    try {
      await onSavePhone(phoneNumber.trim());
    } finally {
      setSavingPhone(false);
    }
  };

  const handleChangePassword = async () => {
    if (!currentPassword || !newPasswordVal || !confirmPasswordVal) {
      toast.error(t('requiredField'));
      return;
    }
    if (newPasswordVal !== confirmPasswordVal) {
      toast.error(t('passwordMismatch'));
      return;
    }
    if (newPasswordVal.length < 6) {
      toast.error(t('passwordMinLength'));
      return;
    }
    setChangePasswordLoading(true);
    try {
      await onChangePassword(currentPassword, newPasswordVal);
      setCurrentPassword('');
      setNewPasswordVal('');
      setConfirmPasswordVal('');
    } finally {
      setChangePasswordLoading(false);
    }
  };

  return (
    <>
      {/* Phone Number */}
      <motion.div
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15 }}
      >
        <Card className="border-0 shadow-sm mb-4 bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Phone className="h-4 w-4 text-emerald-600" />
              {t('phoneNumber')}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="flex gap-2">
              <Input
                type="tel"
                placeholder={t('phonePlaceholder')}
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(e.target.value)}
                className="h-11"
                dir="ltr"
              />
              <Button
                size="sm"
                className="bg-emerald-600 hover:bg-emerald-700 text-white px-4"
                onClick={handleSavePhone}
                disabled={savingPhone}
              >
                <Check className="h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>
      </motion.div>

      {/* Change Password */}
      <motion.div
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.18 }}
      >
        <Card className="border-0 shadow-sm mb-4 bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-emerald-600" />
              {t('changePassword')}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">{t('currentPassword')}</Label>
                <Input
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  placeholder="••••••"
                  className="h-11"
                  dir="ltr"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">{t('newPassword')}</Label>
                <Input
                  type="password"
                  value={newPasswordVal}
                  onChange={(e) => setNewPasswordVal(e.target.value)}
                  placeholder="••••••"
                  className="h-11"
                  dir="ltr"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">{t('confirmNewPassword')}</Label>
                <Input
                  type="password"
                  value={confirmPasswordVal}
                  onChange={(e) => setConfirmPasswordVal(e.target.value)}
                  placeholder="••••••"
                  className="h-11"
                  dir="ltr"
                />
              </div>
              <Button
                size="sm"
                className="w-full bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg h-10"
                onClick={handleChangePassword}
                disabled={changePasswordLoading || !currentPassword || !newPasswordVal || !confirmPasswordVal}
              >
                {changePasswordLoading ? <Loader2 className="h-4 w-4 animate-spin me-2" /> : <KeyRound className="h-4 w-4 me-2" />}
                {t('changePassword')}
              </Button>
            </div>
          </CardContent>
        </Card>
      </motion.div>
    </>
  );
}
