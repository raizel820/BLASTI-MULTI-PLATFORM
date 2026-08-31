'use client';

import { Card, CardContent } from '@/components/ui/card';
import { getProxiedUrl } from '@/lib/utils';
import { User, Shield, CalendarDays } from 'lucide-react';
import { motion } from 'framer-motion';
import type { TranslationKeys } from '@/i18n';
import { useLanguage } from '@/hooks/use-language';

interface ProfileHeaderProps {
  user: {
    fullName?: string | null;
    username?: string | null;
    avatarUrl?: string | null;
    createdAt?: string | null;
  } | null;
  phoneNumber: string;
  memberSince: string;
  t: (key: TranslationKeys) => string;
}

export function ProfileHeader({ user, phoneNumber, memberSince, t }: ProfileHeaderProps) {
  const { t: tHook } = useLanguage();
  const getInitials = () => {
    if (!user?.fullName) return 'U';
    const parts = user.fullName.trim().split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
    }
    return parts[0].charAt(0).toUpperCase();
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 15 }}
      animate={{ opacity: 1, y: 0 }}
    >
      <Card className="border-0 shadow-sm mb-4 overflow-hidden">
        {/* Gradient banner background */}
        <div className="relative h-32 bg-gradient-to-br from-emerald-500 via-teal-500 to-emerald-600">
          {/* Decorative circles */}
          <div className="absolute inset-0 overflow-hidden">
            <div className="absolute -top-8 -end-8 w-32 h-32 rounded-full bg-white/10" />
            <div className="absolute -bottom-12 -start-12 w-40 h-40 rounded-full bg-white/5" />
            <div className="absolute top-4 end-20 w-16 h-16 rounded-full bg-white/5" />
          </div>
        </div>
        <CardContent className="p-5 -mt-12 relative">
          <div className="flex items-end gap-4 mb-4">
            {/* Avatar circle with ring */}
            <motion.div
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: 'spring', stiffness: 260, damping: 20 }}
              className="relative"
            >
              <div className="h-20 w-20 rounded-full bg-gradient-to-br from-emerald-400 via-teal-400 to-emerald-600 flex items-center justify-center text-white text-2xl font-bold ring-4 ring-white dark:ring-gray-900 shadow-xl flex-shrink-0 overflow-hidden">
                {user?.avatarUrl ? (
                  <img src={getProxiedUrl(user.avatarUrl)} alt={user.fullName || ''} width={80} height={80} className="h-full w-full object-cover" />
                ) : (
                  getInitials()
                )}
              </div>
              {/* Online indicator dot */}
              <div className="absolute bottom-0.5 end-0.5 h-5 w-5 rounded-full bg-emerald-500 border-[3px] border-white dark:border-gray-900" />
            </motion.div>
            <div className="pb-1 min-w-0 flex-1">
              <h2 className="text-xl font-bold text-foreground truncate">{user?.fullName || tHook('defaultUser')}</h2>
              <div className="flex items-center gap-2 mt-0.5">
                <p className="text-sm text-muted-foreground truncate">@{user?.username || 'user'}</p>
                {phoneNumber && (
                  <span className="text-xs text-muted-foreground hidden sm:inline">• {phoneNumber}</span>
                )}
              </div>
              {/* Member Since Badge */}
              {user?.createdAt && (
                <motion.div
                  initial={{ opacity: 0, x: 10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.2 }}
                  className="mt-2"
                >
                  <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold bg-gradient-to-r from-emerald-50 to-teal-50 dark:from-emerald-900/20 dark:to-teal-900/20 text-emerald-700 dark:text-emerald-400 px-2.5 py-1 rounded-full border border-emerald-200/50 dark:border-emerald-700/30">
                    <CalendarDays className="h-3 w-3" />
                    {t('memberSince') || 'Member since'} {memberSince}
                  </span>
                </motion.div>
              )}
            </div>
          </div>

          {/* Quick info row */}
          <div className="grid grid-cols-2 gap-2">
            <div className="flex items-center gap-2.5 text-sm p-2.5 rounded-xl bg-gray-50 dark:bg-gray-800/30">
              <div className="h-7 w-7 rounded-lg bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center flex-shrink-0">
                <User className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
              </div>
              <div className="min-w-0">
                <p className="text-[10px] text-muted-foreground">{t('fullName')}</p>
                <p className="text-xs font-medium text-foreground truncate">{user?.fullName || '-'}</p>
              </div>
            </div>
            <div className="flex items-center gap-2.5 text-sm p-2.5 rounded-xl bg-gray-50 dark:bg-gray-800/30">
              <div className="h-7 w-7 rounded-lg bg-teal-100 dark:bg-teal-900/30 flex items-center justify-center flex-shrink-0">
                <Shield className="h-3.5 w-3.5 text-teal-600 dark:text-teal-400" />
              </div>
              <div className="min-w-0">
                <p className="text-[10px] text-muted-foreground">{t('username')}</p>
                <p className="text-xs font-medium text-foreground truncate">{user?.username || '-'}</p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}
