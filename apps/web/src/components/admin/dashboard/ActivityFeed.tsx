'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useLanguage } from '@/hooks/use-language';
import {
  TrendingUp,
  UserPlus,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { type ActivityItem } from './types';
import { formatRelativeTime, getActivityColor, getInitials } from './utils';

interface ActivityFeedProps {
  activities: ActivityItem[];
}

export function ActivityFeed({ activities }: ActivityFeedProps) {
  const { t, lang } = useLanguage();

  return (
    <>
      {/* Latest Registered Users */}
      <motion.div
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.17 }}
      >
        <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <UserPlus className="h-4 w-4 text-emerald-600" />
                {t('latestUsers' as any)}
              </CardTitle>
              <Badge variant="outline" className="text-[10px] text-emerald-600 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800">
                {t('recent' as any)}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="space-y-2">
              {activities.filter(a => a.action.toUpperCase().includes('REGISTER') || a.action.toUpperCase().includes('CREATE')).slice(0, 5).map((activity, idx) => {
                const colorInfo = getActivityColor(activity.action);
                return (
                  <motion.div
                    key={activity.id}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: idx * 0.05 }}
                    className="flex items-center gap-3 p-2.5 rounded-xl hover:bg-gray-50 dark:hover:bg-gray-800/30 transition-colors"
                  >
                    <div className={`h-9 w-9 rounded-xl ${colorInfo.bg} flex items-center justify-center flex-shrink-0`}>
                      <span className={`text-xs font-bold ${colorInfo.text}`}>{getInitials(activity.details)}</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">{activity.details}</p>
                      <p className="text-[10px] text-muted-foreground">{formatRelativeTime(activity.createdAt, lang)}</p>
                    </div>
                    <Badge className={`text-[8px] h-5 ${colorInfo.bg} ${colorInfo.text} border-0`}>
                      {activity.entity}
                    </Badge>
                  </motion.div>
                );
              })}
              {activities.filter(a => a.action.toUpperCase().includes('REGISTER') || a.action.toUpperCase().includes('CREATE')).length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-4">{t('noData')}</p>
              )}
            </div>
          </CardContent>
        </Card>
      </motion.div>

      {/* Recent Activity Timeline */}
      <motion.div
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3 }}
      >
        <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-emerald-600" />
                {t('recentActivity')}
              </CardTitle>
              <Badge variant="outline" className="text-[10px] text-muted-foreground">
                {activities.length} events
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            {activities.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">{t('noData')}</p>
            ) : (
              <div className="relative max-h-96 overflow-y-auto custom-scrollbar">
                {/* Vertical timeline line */}
                <div className="absolute start-5 top-2 bottom-2 w-0.5 bg-gradient-to-b from-emerald-200 via-teal-200 to-gray-200 dark:from-emerald-800 dark:via-teal-800 dark:to-gray-800 rounded-full" />
                <div className="space-y-0">
                  {activities.map((item, idx) => {
                    const colors = getActivityColor(item.action);
                    const initials = getInitials(item.details);
                    return (
                      <motion.div
                        key={item.id}
                        initial={{ opacity: 0, x: -10 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: idx * 0.04 }}
                        className="relative flex items-start gap-3 py-3 group"
                      >
                        {/* Timeline dot */}
                        <div className="relative z-10 flex-shrink-0 mt-1">
                          <div className={`h-2.5 w-2.5 rounded-full ${colors.dot} ring-2 ring-white dark:ring-gray-900 group-hover:scale-150 transition-transform duration-200`} />
                        </div>

                        {/* Avatar with initials */}
                        <div className={`h-8 w-8 rounded-full ${colors.bg} flex items-center justify-center flex-shrink-0 text-[10px] font-bold ${colors.text} ring-2 ring-white dark:ring-gray-900 shadow-sm`}>
                          {initials}
                        </div>

                        {/* Content */}
                        <div className="flex-1 min-w-0 pb-1">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <p className="text-sm font-medium text-foreground truncate">{item.details}</p>
                              <div className="flex items-center gap-1.5 mt-0.5">
                                <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">{item.entity}</span>
                                <span className="text-[10px] text-muted-foreground/50">·</span>
                                <span className="text-[10px] text-muted-foreground">{formatRelativeTime(item.createdAt, lang)}</span>
                              </div>
                            </div>
                            <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${colors.bg} ${colors.text} font-medium flex-shrink-0`}>
                              {item.action.replace(/_/g, ' ')}
                            </span>
                          </div>
                        </div>
                      </motion.div>
                    );
                  })}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </motion.div>
    </>
  );
}
