'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import { Star, Clock, Users, ArrowRight, ArrowLeft } from 'lucide-react';
import { useLanguage } from '@/hooks/use-language';
import { isRTL } from '@/i18n';

interface EnhancedRatingCardProps {
  agency: {
    id: string;
    name: string;
    nameAr?: string | null;
    category: string;
    averageRating: number;
    reviewCount: number;
    isQueueOpen: boolean;
    avgServiceTime?: number;
    waitingCount?: number;
    logoUrl?: string | null;
    customCode?: string;
  };
  onJoinQueue?: (agencyId: string) => void;
  compact?: boolean;
}

export function EnhancedRatingCard({ agency, onJoinQueue, compact = false }: EnhancedRatingCardProps) {
  const { t, lang } = useLanguage();
  const rtl = isRTL(lang);
  const [isHovered, setIsHovered] = useState(false);

  // Calculate star fill
  const fullStars = Math.floor(agency.averageRating);
  const hasHalfStar = agency.averageRating - fullStars >= 0.25 && agency.averageRating - fullStars < 0.75;
  const emptyStars = 5 - fullStars - (hasHalfStar ? 1 : 0);

  const categoryColors: Record<string, string> = {
    hospital: 'from-emerald-500 to-teal-500',
    bank: 'from-teal-500 to-cyan-500',
    government: 'from-emerald-600 to-emerald-500',
    telecom: 'from-cyan-500 to-teal-500',
    post: 'from-teal-600 to-emerald-500',
    default: 'from-emerald-500 to-teal-500',
  };

  const categoryBg = categoryColors[agency.category?.toLowerCase()] || categoryColors.default;

  const getInitial = () => {
    if (agency.nameAr && lang === 'ar') return agency.nameAr.charAt(0);
    return agency.name.charAt(0);
  };

  const getDisplayName = () => {
    if (lang === 'ar' && agency.nameAr) return agency.nameAr;
    return agency.name;
  };

  if (compact) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        whileHover={{ scale: 1.02, y: -2 }}
        onHoverStart={() => setIsHovered(true)}
        onHoverEnd={() => setIsHovered(false)}
        className="relative p-[1px] rounded-2xl bg-gradient-to-br from-emerald-200/60 via-teal-200/60 to-cyan-200/60 dark:from-emerald-700/40 dark:via-teal-700/40 dark:to-cyan-700/40 transition-all duration-300"
        style={{
          boxShadow: isHovered
            ? '0 8px 30px rgba(16, 185, 129, 0.15)'
            : '0 2px 8px rgba(0, 0, 0, 0.05)',
        }}
      >
        <div className="bg-white dark:bg-gray-900 rounded-2xl p-3">
          <div className="flex items-center gap-3">
            {/* Logo/Initial */}
            <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-500 flex items-center justify-center text-white font-bold text-sm flex-shrink-0 overflow-hidden shadow-sm">
              {agency.logoUrl ? (
                <img src={agency.logoUrl} alt={agency.name} width={48} height={48} className="h-full w-full object-contain" />
              ) : (
                getInitial()
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-foreground truncate">{getDisplayName()}</p>
              <div className="flex items-center gap-1.5 mt-0.5">
                <div className="flex items-center gap-0.5">
                  {Array.from({ length: fullStars }).map((_, i) => (
                    <Star key={`full-${i}`} className="h-3 w-3 fill-emerald-500 text-emerald-500" />
                  ))}
                  {hasHalfStar && (
                    <div className="relative">
                      <Star className="h-3 w-3 fill-gray-200 text-gray-200 dark:fill-gray-600 dark:text-gray-600" />
                      <div className="absolute inset-0 overflow-hidden w-1/2">
                        <Star className="h-3 w-3 fill-emerald-500 text-emerald-500" />
                      </div>
                    </div>
                  )}
                  {Array.from({ length: emptyStars }).map((_, i) => (
                    <Star key={`empty-${i}`} className="h-3 w-3 fill-gray-200 text-gray-200 dark:fill-gray-600 dark:text-gray-600" />
                  ))}
                </div>
                <span className="text-[10px] text-muted-foreground">({agency.reviewCount})</span>
              </div>
            </div>
            {/* Queue status dot */}
            <div className="flex items-center gap-1.5 flex-shrink-0">
              <span className={`h-2 w-2 rounded-full ${agency.isQueueOpen ? 'bg-emerald-500 animate-pulse' : 'bg-gray-400'}`} />
              <span className="text-[10px] text-muted-foreground">{agency.isQueueOpen ? t('open') : t('closed') || 'Closed'}</span>
            </div>
          </div>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: 'easeOut' }}
      whileHover={{ scale: 1.02, y: -4 }}
      onHoverStart={() => setIsHovered(true)}
      onHoverEnd={() => setIsHovered(false)}
      className="relative p-[1.5px] rounded-2xl bg-gradient-to-br from-emerald-300/80 via-teal-300/80 to-cyan-300/80 dark:from-emerald-600/50 dark:via-teal-600/50 dark:to-cyan-600/50 transition-all duration-300"
      style={{
        boxShadow: isHovered
          ? '0 12px 40px rgba(16, 185, 129, 0.2)'
          : '0 4px 12px rgba(0, 0, 0, 0.06)',
      }}
    >
      <div className="bg-white dark:bg-gray-900 rounded-[14px] p-5 relative overflow-hidden">
        {/* Subtle background pattern */}
        <div className="absolute inset-0 opacity-[0.03] dark:opacity-[0.05]" style={{
          backgroundImage: 'radial-gradient(circle at 20% 20%, #10b981 1px, transparent 1px), radial-gradient(circle at 80% 80%, #14b8a6 1px, transparent 1px)',
          backgroundSize: '30px 30px',
        }} />

        <div className="relative">
          {/* Top row: Logo + Name + Status */}
          <div className="flex items-start gap-3 mb-4">
            {/* Logo / Initial */}
            <motion.div
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: 'spring', stiffness: 260, damping: 20 }}
              className="h-14 w-14 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-500 flex items-center justify-center text-white font-bold text-xl flex-shrink-0 overflow-hidden shadow-lg shadow-emerald-500/20"
            >
              {agency.logoUrl ? (
                <img src={agency.logoUrl} alt={agency.name} width={48} height={48} className="h-full w-full object-contain" />
              ) : (
                getInitial()
              )}
            </motion.div>

            <div className="flex-1 min-w-0">
              {/* Agency name with gradient text */}
              <h3 className="text-lg font-bold bg-gradient-to-r from-emerald-700 via-teal-700 to-cyan-700 dark:from-emerald-400 dark:via-teal-400 dark:to-cyan-400 bg-clip-text text-transparent truncate">
                {getDisplayName()}
              </h3>
              {/* Category badge */}
              <div className="flex items-center gap-2 mt-1.5">
                <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-bold text-white bg-gradient-to-r ${categoryBg} shadow-sm`}>
                  {t(agency.category) || agency.category}
                </span>
                {agency.customCode && (
                  <span className="text-[10px] text-muted-foreground font-mono">#{agency.customCode}</span>
                )}
              </div>
            </div>

            {/* Queue status indicator */}
            <div className="flex flex-col items-end gap-1 flex-shrink-0">
              <div className="flex items-center gap-1.5">
                <span className={`h-2.5 w-2.5 rounded-full ${agency.isQueueOpen ? 'bg-emerald-500' : 'bg-gray-400'} ${agency.isQueueOpen ? 'animate-pulse' : ''}`} />
                <span className={`text-xs font-semibold ${agency.isQueueOpen ? 'text-emerald-600 dark:text-emerald-400' : 'text-gray-500 dark:text-gray-400'}`}>
                  {agency.isQueueOpen ? t('open') : (t('closed') || 'Closed')}
                </span>
              </div>
            </div>
          </div>

          {/* Rating Section */}
          <div className="flex items-center gap-3 mb-4">
            <motion.div
              initial={{ opacity: 0, x: rtl ? 10 : -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.2 }}
              className="flex items-center gap-1"
            >
              {/* Stars with animated fill */}
              {Array.from({ length: fullStars }).map((_, i) => (
                <motion.div
                  key={`full-${i}`}
                  initial={{ scale: 0, rotate: -180 }}
                  animate={{ scale: 1, rotate: 0 }}
                  transition={{ delay: 0.3 + i * 0.08, type: 'spring', stiffness: 300, damping: 15 }}
                >
                  <Star className="h-5 w-5 fill-emerald-500 text-emerald-500" />
                </motion.div>
              ))}
              {hasHalfStar && (
                <motion.div
                  initial={{ scale: 0, rotate: -180 }}
                  animate={{ scale: 1, rotate: 0 }}
                  transition={{ delay: 0.3 + fullStars * 0.08, type: 'spring', stiffness: 300, damping: 15 }}
                  className="relative"
                >
                  <Star className="h-5 w-5 fill-gray-200 text-gray-200 dark:fill-gray-600 dark:text-gray-600" />
                  <div className="absolute inset-0 overflow-hidden w-1/2">
                    <Star className="h-5 w-5 fill-emerald-500 text-emerald-500" />
                  </div>
                </motion.div>
              )}
              {Array.from({ length: emptyStars }).map((_, i) => (
                <motion.div
                  key={`empty-${i}`}
                  initial={{ scale: 0, rotate: -180 }}
                  animate={{ scale: 1, rotate: 0 }}
                  transition={{ delay: 0.3 + (fullStars + (hasHalfStar ? 1 : 0) + i) * 0.08, type: 'spring', stiffness: 300, damping: 15 }}
                >
                  <Star className="h-5 w-5 fill-gray-200 text-gray-200 dark:fill-gray-600 dark:text-gray-600" />
                </motion.div>
              ))}
            </motion.div>
            <span className="text-lg font-bold text-foreground">{agency.averageRating.toFixed(1)}</span>
            {/* Review count badge */}
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 border border-emerald-200/50 dark:border-emerald-700/30">
              {agency.reviewCount} {t('reviews') || 'reviews'}
            </span>
          </div>

          {/* Stats Row */}
          <div className="grid grid-cols-2 gap-2 mb-4">
            {agency.avgServiceTime !== undefined && (
              <div className="flex items-center gap-2 p-2.5 rounded-xl bg-gradient-to-br from-teal-50 to-cyan-50 dark:from-teal-900/20 dark:to-cyan-900/20 border border-teal-100/50 dark:border-teal-800/30">
                <div className="h-7 w-7 rounded-lg bg-teal-200/80 dark:bg-teal-800/60 flex items-center justify-center flex-shrink-0">
                  <Clock className="h-3.5 w-3.5 text-teal-700 dark:text-teal-300" />
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground">{t('avgServiceTime') || 'Avg. service'}</p>
                  <p className="text-xs font-bold text-foreground">{agency.avgServiceTime} {t('min') || 'min'}</p>
                </div>
              </div>
            )}
            {agency.waitingCount !== undefined && (
              <div className="flex items-center gap-2 p-2.5 rounded-xl bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-emerald-900/20 dark:to-teal-900/20 border border-emerald-100/50 dark:border-emerald-800/30">
                <div className="h-7 w-7 rounded-lg bg-emerald-200/80 dark:bg-emerald-800/60 flex items-center justify-center flex-shrink-0">
                  <Users className="h-3.5 w-3.5 text-emerald-700 dark:text-emerald-300" />
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground">{t('waiting') || 'Waiting'}</p>
                  <p className="text-xs font-bold text-foreground">{agency.waitingCount}</p>
                </div>
              </div>
            )}
          </div>

          {/* Join Queue Button */}
          {onJoinQueue && (
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              onClick={() => onJoinQueue(agency.id)}
              disabled={!agency.isQueueOpen}
              className={`w-full h-11 rounded-xl text-sm font-bold flex items-center justify-center gap-2 transition-all duration-200 ${
                agency.isQueueOpen
                  ? 'bg-gradient-to-r from-emerald-600 via-teal-600 to-emerald-600 hover:from-emerald-700 hover:via-teal-700 hover:to-emerald-700 text-white shadow-lg shadow-emerald-500/20 hover:shadow-xl hover:shadow-emerald-500/30'
                  : 'bg-gray-200 dark:bg-gray-700 text-gray-500 dark:text-gray-400 cursor-not-allowed'
              }`}
            >
              {agency.isQueueOpen ? (
                <>
                  {t('joinQueue') || 'Join Queue'}
                  {rtl ? <ArrowLeft className="h-4 w-4" /> : <ArrowRight className="h-4 w-4" />}
                </>
              ) : (
                t('queueClosed') || 'Queue Closed'
              )}
            </motion.button>
          )}
        </div>
      </div>
    </motion.div>
  );
}
