'use client'
import { apiFetch } from '@/lib/api-fetch';;

import { useState } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Star, Loader2, CheckCircle2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';

interface RatingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agencyName: string;
  serviceName?: string;
  agencyId: string;
  userId: string;
  reservationId?: string;
  onSubmitted?: () => void;
}

export function RatingDialog({
  open,
  onOpenChange,
  agencyName,
  serviceName,
  agencyId,
  userId,
  reservationId,
  onSubmitted,
}: RatingDialogProps) {
  const { t } = useLanguage();
  const [rating, setRating] = useState(0);
  const [hoveredStar, setHoveredStar] = useState(0);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async () => {
    if (rating === 0) return;
    setSubmitting(true);
    try {
      const res = await apiFetch('/api/reviews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          agencyId,
          rating,
          comment: comment.trim() || undefined,
          reservationId: reservationId || undefined,
        }),
      });

      if (res.ok) {
        setSubmitted(true);
        toast.success(t('ratingSubmitted'));
        onSubmitted?.();
        // Auto close after showing success animation
        setTimeout(() => {
          setSubmitted(false);
          setRating(0);
          setComment('');
          onOpenChange(false);
        }, 1500);
      } else {
        const data = await res.json();
        toast.error(data.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = () => {
    if (!submitting) {
      onOpenChange(false);
      // Reset state after close animation
      setTimeout(() => {
        setSubmitted(false);
        setRating(0);
        setComment('');
        setHoveredStar(0);
      }, 200);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <AnimatePresence mode="wait">
          {submitted ? (
            <motion.div
              key="success"
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              className="flex flex-col items-center justify-center py-8 gap-4"
            >
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: 'spring', stiffness: 200, damping: 15, delay: 0.1 }}
                className="h-16 w-16 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center"
              >
                <CheckCircle2 className="h-8 w-8 text-emerald-600 dark:text-emerald-400" />
              </motion.div>
              <motion.p
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2 }}
                className="text-lg font-semibold text-foreground"
              >
                {t('ratingSubmitted')}
              </motion.p>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.3 }}
                className="flex gap-1"
              >
                {[1, 2, 3, 4, 5].map((star) => (
                  <Star
                    key={star}
                    className="h-5 w-5 fill-amber-400 text-amber-400"
                  />
                ))}
              </motion.div>
            </motion.div>
          ) : (
            <motion.div
              key="form"
              initial={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Star className="h-5 w-5 text-amber-500" />
                  {t('rateYourExperience')}
                </DialogTitle>
                <DialogDescription>{t('rateAgency')}</DialogDescription>
              </DialogHeader>

              <div className="py-4 space-y-5">
                {/* Agency & Service Info */}
                <div className="bg-muted/50 rounded-xl p-3">
                  <p className="font-semibold text-sm text-foreground">{agencyName}</p>
                  {serviceName && (
                    <p className="text-xs text-muted-foreground mt-0.5">{serviceName}</p>
                  )}
                </div>

                {/* Star Rating */}
                <div className="flex flex-col items-center gap-2">
                  <div className="flex gap-2">
                    {[1, 2, 3, 4, 5].map((star) => (
                      <motion.button
                        key={star}
                        type="button"
                        whileHover={{ scale: 1.2 }}
                        whileTap={{ scale: 0.9 }}
                        onClick={() => setRating(star)}
                        onMouseEnter={() => setHoveredStar(star)}
                        onMouseLeave={() => setHoveredStar(0)}
                        className="focus:outline-none"
                        aria-label={`${star} star${star > 1 ? 's' : ''}`}
                      >
                        <Star
                          className={`h-10 w-10 transition-colors duration-150 ${
                            star <= (hoveredStar || rating)
                              ? 'fill-amber-400 text-amber-400'
                              : 'fill-gray-200 text-gray-200 dark:fill-gray-600 dark:text-gray-600'
                          }`}
                        />
                      </motion.button>
                    ))}
                  </div>
                  {rating > 0 && (
                    <motion.p
                      initial={{ opacity: 0, y: -5 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="text-sm font-medium text-amber-600 dark:text-amber-400"
                    >
                      {rating}/5
                    </motion.p>
                  )}
                </div>

                {/* Comment */}
                <Textarea
                  placeholder={t('writeComment')}
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  className="min-h-[80px] resize-none rounded-xl"
                  maxLength={500}
                />

                {/* Submit Button */}
                <Button
                  onClick={handleSubmit}
                  disabled={rating === 0 || submitting}
                  className="w-full h-11 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white rounded-xl font-semibold"
                >
                  {submitting ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin me-2" />
                      {t('loading')}
                    </>
                  ) : (
                    <>
                      <Star className="h-4 w-4 me-2" />
                      {t('submitRating')}
                    </>
                  )}
                </Button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </DialogContent>
    </Dialog>
  );
}
