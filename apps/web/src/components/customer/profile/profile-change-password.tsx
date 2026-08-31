'use client';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { KeyRound, Loader2 } from 'lucide-react';
import { motion } from 'framer-motion';
import type { ProfileChangePasswordProps } from './profile-types';

export function ProfileChangePassword({
  currentPassword,
  newPasswordVal,
  confirmPasswordVal,
  changePasswordLoading,
  onCurrentPasswordChange,
  onNewPasswordChange,
  onConfirmPasswordChange,
  onChangePassword,
  t,
}: ProfileChangePasswordProps) {
  return (
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
                onChange={(e) => onCurrentPasswordChange(e.target.value)}
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
                onChange={(e) => onNewPasswordChange(e.target.value)}
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
                onChange={(e) => onConfirmPasswordChange(e.target.value)}
                placeholder="••••••"
                className="h-11"
                dir="ltr"
              />
            </div>
            <Button
              size="sm"
              className="w-full bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg h-10"
              onClick={onChangePassword}
              disabled={changePasswordLoading || !currentPassword || !newPasswordVal || !confirmPasswordVal}
            >
              {changePasswordLoading ? <Loader2 className="h-4 w-4 animate-spin me-2" /> : <KeyRound className="h-4 w-4 me-2" />}
              {t('changePassword')}
            </Button>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}
