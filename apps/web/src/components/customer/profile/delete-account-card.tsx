'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Trash2, AlertTriangle, Loader2 } from 'lucide-react';
import { motion } from 'framer-motion';
import type { TranslationKeys } from '@/i18n';

interface DeleteAccountCardProps {
  onDeleteAccount: () => Promise<void>;
  lang: string;
  t: (key: TranslationKeys) => string;
}

export function DeleteAccountCard({ onDeleteAccount, lang, t }: DeleteAccountCardProps) {
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const expectedText = lang === 'ar' ? 'حذف' : lang === 'fr' ? 'supprimer' : 'delete';
  const isConfirmValid = deleteConfirmText === expectedText;

  const handleDelete = async () => {
    setDeleteLoading(true);
    try {
      await onDeleteAccount();
      setDeleteDialogOpen(false);
    } finally {
      setDeleteLoading(false);
      setDeleteConfirmText('');
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 15 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.4 }}
    >
      <div className="relative p-[2px] rounded-2xl bg-gradient-to-r from-red-500 via-rose-500 to-red-600 shadow-lg shadow-red-500/10 danger-gradient-border">
        <div className="bg-white dark:bg-gray-900 rounded-[14px] p-4">
          <div className="flex items-center gap-3 mb-3">
            <div className="h-10 w-10 rounded-xl bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
              <AlertTriangle className="h-5 w-5 text-red-600 dark:text-red-400" />
            </div>
            <div>
              <p className="text-sm font-bold text-red-600 dark:text-red-400">{t('deleteAccount')}</p>
              <p className="text-[11px] text-muted-foreground">{t('deleteAccountDesc')}</p>
            </div>
          </div>
          <AlertDialog open={deleteDialogOpen} onOpenChange={(open) => { setDeleteDialogOpen(open); if (!open) setDeleteConfirmText(''); }}>
            <AlertDialogTrigger asChild>
              <Button
                variant="outline"
                className="w-full h-11 rounded-xl border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-all"
              >
                <Trash2 className="h-4 w-4 me-2" />
                {t('deleteAccount')}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent className="sm:max-w-md">
              <AlertDialogHeader>
                <AlertDialogTitle className="flex items-center gap-2 text-red-600">
                  <AlertTriangle className="h-5 w-5" />
                  {t('deleteAccount')}
                </AlertDialogTitle>
                <AlertDialogDescription className="space-y-3">
                  <p>{t('deleteAccountDesc')}</p>
                  <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl p-3">
                    <p className="text-xs text-red-600 dark:text-red-400 font-medium">
                      ⚠️ {t('deleteAccountWarning')}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <p className="text-sm text-muted-foreground">{t('typeDeleteToConfirm')}</p>
                    <Input
                      value={deleteConfirmText}
                      onChange={(e) => setDeleteConfirmText(e.target.value)}
                      placeholder={expectedText}
                      className="h-10"
                      dir="ltr"
                    />
                  </div>
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter className="flex-col gap-2 sm:flex-col">
                <AlertDialogCancel className="w-full rounded-xl h-10">
                  {t('cancel')}
                </AlertDialogCancel>
                <Button
                  onClick={handleDelete}
                  disabled={deleteLoading || !isConfirmValid}
                  className="w-full bg-red-600 hover:bg-red-700 text-white rounded-xl h-10"
                >
                  {deleteLoading ? <Loader2 className="h-4 w-4 animate-spin me-2" /> : <Trash2 className="h-4 w-4 me-2" />}
                  {t('deleteAccount')}
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
    </motion.div>
  );
}
