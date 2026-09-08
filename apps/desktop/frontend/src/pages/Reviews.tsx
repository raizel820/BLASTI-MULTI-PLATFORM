import { useCallback } from 'react';
import { Star, Loader2 } from 'lucide-react';
import api from '@/api/client';
import { useApi } from '@/hooks/use-api';
import { formatRelativeTime } from '@/lib/utils';

interface Review {
  id: string;
  rating: number;
  comment?: string;
  customerName?: string;
  createdAt?: string;
  serviceName?: string;
}

export default function ReviewsPage() {
  const fetchReviews = useCallback(() => api.getReviews({ take: 50 }), []);
  const { data, isLoading } = useApi(fetchReviews);

  const reviews = ((data?.reviews || data?.data || []) as Review[]) || [];
  const avgRating = (data?.avgRating || data?.averageRating || 0) as number;
  const distribution = (data?.ratingDistribution || {}) as Record<string, number>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Reviews</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Customer feedback and ratings</p>
      </div>

      {/* Rating Summary */}
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-center gap-6">
          <div className="text-center">
            <p className="text-4xl font-bold text-foreground">{avgRating.toFixed(1)}</p>
            <div className="flex items-center gap-0.5 mt-1 justify-center">
              {[1,2,3,4,5].map((n) => (
                <Star key={n} className={`w-4 h-4 ${n <= Math.round(avgRating) ? 'text-amber-400 fill-amber-400' : 'text-muted-foreground'}`} />
              ))}
            </div>
            <p className="text-xs text-muted-foreground mt-1">{reviews.length} reviews</p>
          </div>
          <div className="flex-1 space-y-1.5">
            {[5,4,3,2,1].map((n) => {
              const count = distribution[n] || distribution[String(n)] || 0;
              const pct = reviews.length > 0 ? (count / reviews.length) * 100 : 0;
              return (
                <div key={n} className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground w-3">{n}</span>
                  <Star className="w-3 h-3 text-amber-400 fill-amber-400" />
                  <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                    <div className="h-full bg-amber-400 rounded-full" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="text-xs text-muted-foreground w-6 text-right">{count}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Reviews List */}
      <div className="space-y-3">
        {isLoading ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin" />
          </div>
        ) : reviews.length === 0 ? (
          <div className="rounded-xl border border-border bg-card py-12 text-center">
            <p className="text-sm text-muted-foreground">No reviews yet</p>
          </div>
        ) : (
          reviews.map((r) => (
            <div key={r.id} className="rounded-xl border border-border bg-card p-4">
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-0.5">
                  {[1,2,3,4,5].map((n) => (
                    <Star key={n} className={`w-4 h-4 ${n <= r.rating ? 'text-amber-400 fill-amber-400' : 'text-muted-foreground'}`} />
                  ))}
                </div>
                <span className="text-xs text-muted-foreground">{formatRelativeTime(r.createdAt)}</span>
                {r.serviceName && <span className="text-xs text-muted-foreground">• {r.serviceName}</span>}
              </div>
              {r.comment && (
                <p className="text-sm text-foreground mt-2">{r.comment}</p>
              )}
              {r.customerName && (
                <p className="text-xs text-muted-foreground mt-2">— {r.customerName}</p>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
