'use client';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Phone, Check } from 'lucide-react';
import { motion } from 'framer-motion';
import type { ProfilePhoneNumberProps } from './profile-types';

import { useLanguage } from '@/hooks/use-language';
export function ProfilePhoneNumber({ phoneNumber, savingPhone, onPhoneNumberChange, onSave, t }: ProfilePhoneNumberProps) {
  return (
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
              onChange={(e) => onPhoneNumberChange(e.target.value)}
              className="h-11"
              dir="ltr"
            />
            <Button
              size="sm"
              className="bg-emerald-600 hover:bg-emerald-700 text-white px-4"
              onClick={onSave}
              disabled={savingPhone}
            >
              <Check className="h-4 w-4" />
            </Button>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}
