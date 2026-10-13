'use client';

/**
 * Image Upload Preview Dialog — Task 2-d.
 *
 * Shown BETWEEN file-pick and upload: renders the freshly chosen file
 * (object URL) in a circle (avatars / profile images) or rounded-2xl
 * (logos / covers) frame so the user can confirm "set this image active"
 * BEFORE anything reaches the server. The parent owns the entire upload
 * lifecycle — this dialog only previews and calls onConfirm().
 *
 * Styling matches the shared emerald theme (same confirm gradient as
 * ConfirmDialog / the settings accents).
 */
import { Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn, getProxiedUrl } from '@/lib/utils';

interface ImageUploadPreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Object URL (blob:) of the picked file — getProxiedUrl passes it through untouched. */
  previewUrl: string;
  /** 'circle' for avatars/profile images, 'rounded' for logos/covers. */
  shape: 'circle' | 'rounded';
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Parent-driven upload state — confirm shows a loader and stays disabled while true. */
  loading?: boolean;
  onConfirm: () => void | Promise<void>;
}

export function ImageUploadPreviewDialog({
  open,
  onOpenChange,
  previewUrl,
  shape,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  loading = false,
  onConfirm,
}: ImageUploadPreviewDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Never dismiss mid-upload (X button / overlay / Esc all funnel here).
        if (!loading) onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">{title}</DialogTitle>
          <DialogDescription className="text-sm leading-relaxed">
            {description}
          </DialogDescription>
        </DialogHeader>

        {/* Centered preview of the picked image */}
        <div className="flex justify-center py-2">
          {shape === 'circle' ? (
            <div className="h-40 w-40 overflow-hidden rounded-full bg-gray-100 ring-4 ring-emerald-100 dark:bg-gray-800 dark:ring-emerald-900">
              <img
                src={getProxiedUrl(previewUrl)}
                alt={title}
                className="h-full w-full object-cover"
              />
            </div>
          ) : (
            <div className="w-full max-w-xs overflow-hidden rounded-2xl bg-gray-100 ring-1 ring-border dark:bg-gray-800">
              <img
                src={getProxiedUrl(previewUrl)}
                alt={title}
                className="max-h-72 w-full object-cover"
              />
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={loading}
            onClick={() => onOpenChange(false)}
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            disabled={loading}
            onClick={() => void onConfirm()}
            className={cn(
              'bg-gradient-to-r from-emerald-600 to-teal-600 text-white',
              'hover:from-emerald-700 hover:to-teal-700 border-0 shadow-sm'
            )}
          >
            {loading && <Loader2 className="h-4 w-4 animate-spin me-2" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
