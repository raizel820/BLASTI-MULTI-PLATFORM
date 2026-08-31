'use client';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Star, Loader2 } from 'lucide-react';
import { useLanguage } from '@/hooks/use-language';

interface QueueRatingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ratingTargetId: string | null;
  selectedRating: number;
  onRatingSelect: (rating: number) => void;
  feedbackComment: string;
  onFeedbackChange: (comment: string) => void;
  onSubmit: () => void;
  submitting: boolean;
}

export function QueueRatingDialog({
  open,
  onOpenChange,
  ratingTargetId,
  selectedRating,
  onRatingSelect,
  feedbackComment,
  onFeedbackChange,
  onSubmit,
  submitting,
}: QueueRatingDialogProps) {
  const { t } = useLanguage();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Star className="h-5 w-5 text-amber-500" />
            {t('rateExperience')}
          </DialogTitle>
          <DialogDescription>{t('rateExperienceDesc') || 'How was your experience?'}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col items-center gap-4 py-4">
          <div className="flex items-center gap-2">
            {[1, 2, 3, 4, 5].map((s) => (
              <button key={s} onClick={() => onRatingSelect(s)} className="transition-transform hover:scale-110">
                <Star className={`h-8 w-8 ${s <= selectedRating ? 'text-amber-400 fill-amber-400' : 'text-gray-300 dark:text-gray-600'}`} />
              </button>
            ))}
          </div>
          <textarea
            className="w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-transparent p-3 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
            rows={3}
            placeholder={t('feedbackPlaceholder') || 'Share your feedback (optional)'}
            value={feedbackComment}
            onChange={(e) => onFeedbackChange(e.target.value)}
          />
        </div>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => onOpenChange(false)} className="rounded-xl">{t('cancel')}</Button>
          <Button
            onClick={onSubmit}
            disabled={selectedRating < 1 || submitting}
            className="bg-amber-600 hover:bg-amber-700 text-white font-semibold rounded-xl gap-1.5"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Star className="h-4 w-4" />}
            {t('submitRating') || 'Submit'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
