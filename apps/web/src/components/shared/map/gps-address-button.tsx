'use client';

/**
 * GpsAddressButton — r26: the explicit "fill the address from GPS" button
 * the user asked for (create/edit agency + branch profiles). One press:
 * device GPS → honest-accuracy gate → reverse geocode → the form's
 * `onFilled` callback maps the result onto its own fields.
 *
 * The hook owns the accuracy policy (r21-5): a COARSE network/IP-grade fix
 * (accuracy > 2km) NEVER fills textual fields — the form is still told
 * about the coordinates so the map pin can move, and the user gets an
 * amber explanation instead of a silently wrong address.
 */
import { Button } from '@/components/ui/button';
import { Loader2, LocateFixed } from 'lucide-react';
import { toast } from 'sonner';
import { useLanguage } from '@/hooks/use-language';
import { useGpsAddressFill, type GpsFillOutcome } from './use-gps-address-fill';

export type { GpsFillOutcome } from './use-gps-address-fill';

export function GpsAddressButton({
  onFilled,
  label,
  className = '',
}: {
  onFilled: (outcome: GpsFillOutcome) => void;
  /** Override label (defaults to maps.fillFromGps). */
  label?: string;
  className?: string;
}) {
  const { t } = useLanguage();
  const { fill, locating } = useGpsAddressFill();

  const handleClick = async () => {
    const outcome = await fill();
    switch (outcome.kind) {
      case 'OK':
        toast.success(t('maps.addressFilled'));
        break;
      case 'COARSE':
        toast.warning(t('maps.coarseNoFill'));
        break;
      case 'ERROR':
        toast.error(t('maps.gpsFillFailed'));
        break;
    }
    onFilled(outcome);
  };

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={
        'h-9 rounded-lg text-xs gap-1.5 border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 ' +
        className
      }
      onClick={handleClick}
      disabled={locating}
      aria-label={label || t('maps.fillFromGps')}
    >
      {locating ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <LocateFixed className="h-3.5 w-3.5" />
      )}
      {label || t('maps.fillFromGps')}
    </Button>
  );
}
