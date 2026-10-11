'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import {
  LogOut,
  Trash2,
  AlertTriangle,
  Loader2,
} from 'lucide-react';
import { motion } from 'framer-motion';
import type { ProfileDangerZoneProps } from './profile-types';

export function ProfileDangerZone({
  deleteDialogOpen,
  deleteConfirmText,
  deleteLoading,
  onDeleteDialogOpenChange,
  onDeleteConfirmTextChange,
  onDeleteAccount,
  onLogout,
  lang,
  t,
}: ProfileDangerZoneProps) {
  const confirmWord = lang === 'ar' ? 'حذف' : lang === 'fr' ? 'supprimer' : 'delete';

  return (
    <>
      {/* Gradient divider before logout */}
      <hr className="gradient-divider my-5" />

      {/* Logout */}
      <motion.div
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.35 }}
      >
        <Button
          variant="outline"
          className="w-full h-12 rounded-xl border-red-200 text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-900/20 font-semibold transition-all duration-200 hover:scale-[1.01] mb-3"
          onClick={onLogout}
        >
          <LogOut className="h-4 w-4 me-2" />
          {t('logout')}
        </Button>
      </motion.div>

      {/* Delete Account - Red Gradient Border Warning Card */}
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
            <AlertDialog open={deleteDialogOpen} onOpenChange={(open) => { onDeleteDialogOpenChange(open); if (!open) onDeleteConfirmTextChange(''); }}>
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
                        onChange={(e) => onDeleteConfirmTextChange(e.target.value)}
                        placeholder={confirmWord}
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
                    onClick={onDeleteAccount}
                    disabled={deleteLoading || deleteConfirmText !== confirmWord}
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
    </>
  );
}
