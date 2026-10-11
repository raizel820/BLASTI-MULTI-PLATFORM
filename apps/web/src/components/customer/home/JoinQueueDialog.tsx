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
import { Calendar } from '@/components/ui/calendar';
import { Loader2, TicketCheck, CalendarDays, Clock, Zap } from 'lucide-react';

interface JoinQueueDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedDate: Date | undefined;
  onSelectedDateChange: (date: Date | undefined) => void;
  joining: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  preferredTime: string;
  onPreferredTimeChange: (time: string) => void;
  fixedTimeEnabled: boolean;
  onFixedTimeEnabledChange: (enabled: boolean) => void;
  t: (key: import("@/i18n").TranslationKeys) => string;
  lang: string;
}

export function JoinQueueDialog({
  open,
  onOpenChange,
  selectedDate,
  onSelectedDateChange,
  joining,
  onConfirm,
  onCancel,
  preferredTime,
  onPreferredTimeChange,
  fixedTimeEnabled,
  onFixedTimeEnabledChange,
  t,
  lang,
}: JoinQueueDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md rounded-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
              <CalendarDays className="h-4 w-4 text-emerald-600" />
            </div>
            {t('reserveForDate')}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t('selectDate')}
          </DialogDescription>
        </DialogHeader>
        <div className="py-2">
          <p className="text-sm text-muted-foreground mb-4">{t('selectDate')}</p>
          <div className="flex justify-center">
            <Calendar
              mode="single"
              selected={selectedDate}
              onSelect={onSelectedDateChange}
              disabled={(date) => date < new Date(new Date().setHours(0, 0, 0, 0))}
              className="rounded-xl border w-full max-w-[300px] sm:max-w-none"
            />
          </div>
          {/* Quick date buttons */}
          <div className="flex gap-2 mt-4 justify-center">
            <Button
              variant="outline"
              size="sm"
              className="rounded-lg h-9 gap-1.5"
              onClick={() => onSelectedDateChange(undefined)}
            >
              <Zap className="h-3.5 w-3.5" />
              {t('today')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="rounded-lg h-9 gap-1.5"
              onClick={() => {
                const tomorrow = new Date();
                tomorrow.setDate(tomorrow.getDate() + 1);
                onSelectedDateChange(tomorrow);
              }}
            >
              <CalendarDays className="h-3.5 w-3.5" />
              {t('tomorrow')}
            </Button>
          </div>
          {selectedDate && (
            <div className="mt-3 text-center">
              <p className="text-sm text-emerald-600 dark:text-emerald-400 font-medium">
                📅 {t('reservedFor')} {selectedDate.toLocaleDateString(lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
              </p>
            </div>
          )}

          {/* Preferred Time Section */}
          <div className="mt-4 pt-4 border-t border-border">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Clock className="h-4 w-4 text-teal-600 dark:text-teal-400" />
                <div>
                  <p className="text-sm font-medium text-foreground">{t('preferredTime')}</p>
                  <p className="text-xs text-muted-foreground">{t('preferredTimeDesc')}</p>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <input
                type="time"
                value={preferredTime}
                onChange={(e) => {
                  onPreferredTimeChange(e.target.value);
                  if (e.target.value && !fixedTimeEnabled) onFixedTimeEnabledChange(true);
                }}
                className="h-10 px-3 rounded-xl border border-border bg-background text-sm focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 outline-none transition-colors"
                dir="ltr"
              />
              {preferredTime && (
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={fixedTimeEnabled}
                    onChange={(e) => onFixedTimeEnabledChange(e.target.checked)}
                    className="h-4 w-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
                  />
                  <span className="text-xs text-muted-foreground">{t('enableFixedTime')}</span>
                </label>
              )}
              {preferredTime && (
                <button
                  onClick={() => { onPreferredTimeChange(''); onFixedTimeEnabledChange(false); }}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  ✕
                </button>
              )}
            </div>
          </div>
        </div>
        <DialogFooter className="flex-col gap-2 sm:flex-row">
          <Button variant="outline" onClick={onCancel} className="rounded-xl h-10">
            {t('cancel')}
          </Button>
          <Button
            onClick={onConfirm}
            disabled={joining}
            className="bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white rounded-xl h-10 shadow-lg shadow-emerald-500/20"
          >
            {joining ? <Loader2 className="h-4 w-4 animate-spin me-2" /> : <TicketCheck className="h-4 w-4 me-2" />}
            {t('joinQueue')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
