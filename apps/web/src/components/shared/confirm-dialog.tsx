'use client';

import { useState, useEffect, useCallback } from 'react';
import { Loader2 } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void | Promise<void>;
  variant?: 'default' | 'danger';
  loading?: boolean;
  confirmText?: string;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  variant = 'default',
  loading: externalLoading,
  confirmText,
}: ConfirmDialogProps) {
  const [internalLoading, setInternalLoading] = useState(false);
  const [confirmationInput, setConfirmationInput] = useState('');

  const isLoading = externalLoading ?? internalLoading;

  // Reset confirmation input when dialog opens/closes
  useEffect(() => {
    if (!open) {
      setConfirmationInput('');
    }
  }, [open]);

  const isConfirmEnabled = confirmText
    ? confirmationInput.trim() === confirmText.trim()
    : true;

  const handleConfirm = useCallback(async () => {
    if (!isConfirmEnabled || isLoading) return;

    if (externalLoading === undefined) {
      setInternalLoading(true);
    }

    try {
      await onConfirm();
      onOpenChange(false);
    } catch {
      // Let the parent handle the error via their own error handling
    } finally {
      if (externalLoading === undefined) {
        setInternalLoading(false);
      }
    }
  }, [isConfirmEnabled, isLoading, onConfirm, onOpenChange, externalLoading]);

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-base font-semibold">
            {title}
          </AlertDialogTitle>
          <AlertDialogDescription className="text-sm leading-relaxed">
            {description}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {/* Type-to-confirm input */}
        {confirmText && (
          <div className="mt-2 space-y-2">
            <p className="text-sm text-muted-foreground">
              Type <span className="font-semibold text-foreground">{confirmText}</span> to confirm:
            </p>
            <Input
              value={confirmationInput}
              onChange={(e) => setConfirmationInput(e.target.value)}
              placeholder={confirmText}
              autoFocus
              className="font-mono text-sm"
            />
          </div>
        )}

        <AlertDialogFooter className="mt-2">
          <AlertDialogCancel disabled={isLoading}>
            {cancelLabel}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            disabled={!isConfirmEnabled || isLoading}
            className={cn(
              'relative overflow-hidden transition-all duration-200',
              variant === 'danger' &&
                'bg-gradient-to-r from-red-600 to-rose-600 text-white hover:from-red-700 hover:to-rose-700 border-0 shadow-sm',
              variant === 'default' &&
                'bg-gradient-to-r from-emerald-600 to-teal-600 text-white hover:from-emerald-700 hover:to-teal-700 border-0 shadow-sm'
            )}
          >
            {isLoading && <Loader2 className="h-4 w-4 animate-spin me-2" />}
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
