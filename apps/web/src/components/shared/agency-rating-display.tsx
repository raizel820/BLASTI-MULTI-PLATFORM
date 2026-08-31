'use client';

import { Star } from 'lucide-react';

interface AgencyRatingDisplayProps {
  averageRating: number;
  totalCount: number;
  compact?: boolean;
  size?: 'sm' | 'md';
}

export function AgencyRatingDisplay({
  averageRating,
  totalCount,
  compact = false,
  size = 'sm',
}: AgencyRatingDisplayProps) {
  const starSize = size === 'sm' ? 'h-3 w-3' : 'h-4 w-4';
  const textSize = size === 'sm' ? 'text-xs' : 'text-sm';
  const countSize = size === 'sm' ? 'text-[10px]' : 'text-xs';

  if (totalCount === 0 && compact) {
    return null;
  }

  if (totalCount === 0) {
    return (
      <div className="flex items-center gap-1 text-muted-foreground">
        {[1, 2, 3, 4, 5].map((star) => (
          <Star
            key={star}
            className={`${starSize} fill-gray-200 text-gray-200 dark:fill-gray-600 dark:text-gray-600`}
          />
        ))}
        <span className={`${countSize} ms-1`}>(0)</span>
      </div>
    );
  }

  // Calculate filled, half, and empty stars
  const fullStars = Math.floor(averageRating);
  const hasHalfStar = averageRating - fullStars >= 0.25 && averageRating - fullStars < 0.75;
  const emptyStars = 5 - fullStars - (hasHalfStar ? 1 : 0);

  if (compact) {
    return (
      <div className="flex items-center gap-1">
        <Star className={`${starSize} fill-amber-400 text-amber-400`} />
        <span className={`${textSize} font-semibold text-foreground`}>
          {averageRating.toFixed(1)}
        </span>
        {totalCount > 0 && (
          <span className={`${countSize} text-muted-foreground`}>
            ({totalCount})
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <div className="flex items-center gap-0.5">
        {/* Full stars */}
        {Array.from({ length: fullStars }).map((_, i) => (
          <Star
            key={`full-${i}`}
            className={`${starSize} fill-amber-400 text-amber-400`}
          />
        ))}
        {/* Half star */}
        {hasHalfStar && (
          <div className="relative">
            <Star className={`${starSize} fill-gray-200 text-gray-200 dark:fill-gray-600 dark:text-gray-600`} />
            <div className="absolute inset-0 overflow-hidden w-1/2">
              <Star className={`${starSize} fill-amber-400 text-amber-400`} />
            </div>
          </div>
        )}
        {/* Empty stars */}
        {Array.from({ length: emptyStars }).map((_, i) => (
          <Star
            key={`empty-${i}`}
            className={`${starSize} fill-gray-200 text-gray-200 dark:fill-gray-600 dark:text-gray-600`}
          />
        ))}
      </div>
      <span className={`${textSize} font-semibold text-foreground`}>
        {averageRating.toFixed(1)}
      </span>
      {totalCount > 0 && (
        <span className={`${countSize} text-muted-foreground`}>
          ({totalCount})
        </span>
      )}
    </div>
  );
}
