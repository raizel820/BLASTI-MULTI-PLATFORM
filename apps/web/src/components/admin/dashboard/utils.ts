/**
 * Formats a date string into relative time (e.g., "2 hours ago", "just now")
 */
export function formatRelativeTime(dateStr: string, lang: string): string {
  try {
    const now = new Date();
    const date = new Date(dateStr);
    const diffMs = now.getTime() - date.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);

    const locale = lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US';

    if (diffSec < 60) {
      return locale === 'ar-DZ' ? 'الآن' : locale === 'fr-DZ' ? "À l'instant" : 'just now';
    }
    if (diffMin < 60) {
      const min = locale === 'ar-DZ' ? 'دقيقة' : locale === 'fr-DZ' ? 'min' : 'min';
      return `${diffMin} ${min}`;
    }
    if (diffHour < 24) {
      const hr = locale === 'ar-DZ' ? 'ساعة' : locale === 'fr-DZ' ? 'h' : 'h';
      return `${diffHour} ${hr}`;
    }
    if (diffDay < 7) {
      const d = locale === 'ar-DZ' ? 'يوم' : locale === 'fr-DZ' ? 'j' : 'd';
      return `${diffDay} ${d}`;
    }
    return date.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

/**
 * Gets color info for activity type
 */
export function getActivityColor(action: string): { dot: string; bg: string; text: string } {
  const a = action.toUpperCase();
  if (a.includes('LOGIN')) return { dot: 'bg-emerald-500', bg: 'bg-emerald-100 dark:bg-emerald-900/30', text: 'text-emerald-600 dark:text-emerald-400' };
  if (a.includes('QUEUE_CALL') || a.includes('CALL')) return { dot: 'bg-teal-500', bg: 'bg-teal-100 dark:bg-teal-900/30', text: 'text-teal-600 dark:text-teal-400' };
  if (a.includes('PAYMENT_APPROVE') || a.includes('APPROVE')) return { dot: 'bg-amber-500', bg: 'bg-amber-100 dark:bg-amber-900/30', text: 'text-amber-600 dark:text-amber-400' };
  if (a.includes('CREATE') || a.includes('REGISTER')) return { dot: 'bg-emerald-500', bg: 'bg-emerald-100 dark:bg-emerald-900/30', text: 'text-emerald-600 dark:text-emerald-400' };
  if (a.includes('DELETE') || a.includes('REJECT')) return { dot: 'bg-red-500', bg: 'bg-red-100 dark:bg-red-900/30', text: 'text-red-600 dark:text-red-400' };
  if (a.includes('UPDATE')) return { dot: 'bg-amber-500', bg: 'bg-amber-100 dark:bg-amber-900/30', text: 'text-amber-600 dark:text-amber-400' };
  return { dot: 'bg-gray-400', bg: 'bg-gray-100 dark:bg-gray-800', text: 'text-gray-500 dark:text-gray-400' };
}

/**
 * Gets initials from details string for avatar
 */
export function getInitials(details: string): string {
  if (!details) return '?';
  const words = details.trim().split(/\s+/);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return details.slice(0, 2).toUpperCase();
}

/**
 * Formats a date string into localized short format
 */
export function formatTime(dateStr: string, lang: string): string {
  try {
    return new Date(dateStr).toLocaleString(
      lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US',
      { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
    );
  } catch {
    return '';
  }
}
