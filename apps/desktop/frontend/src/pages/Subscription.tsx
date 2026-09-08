import { useCallback } from 'react';
import { Check, Crown, Loader2 } from 'lucide-react';
import api from '@/api/client';
import { useApi } from '@/hooks/use-api';
import { formatDate } from '@/lib/utils';

interface Plan {
  id: string;
  name: string;
  price?: number;
  interval?: string;
  features?: string[];
  isCurrent?: boolean;
}

interface Transaction {
  id: string;
  amount?: number;
  currency?: string;
  status?: string;
  description?: string;
  createdAt?: string;
}

export default function SubscriptionPage() {
  const fetchSub = useCallback(() => api.getSubscription(), []);
  const fetchPlans = useCallback(() => api.getSubscriptionPlans(), []);
  const fetchTxns = useCallback(() => api.getTransactions({ take: 20 }), []);

  const { data: subData, isLoading: subLoading } = useApi(fetchSub);
  const { data: plansData, isLoading: plansLoading } = useApi(fetchPlans);
  const { data: txnData, isLoading: txnLoading } = useApi(fetchTxns);

  const subscription = (subData?.subscription || subData?.data || subData || {}) as Record<string, unknown>;
  const plans = ((plansData?.plans || plansData?.data || []) as Plan[]) || [];
  const transactions = ((txnData?.transactions || txnData?.data || []) as Transaction[]) || [];

  const planName = (subscription.planName || subscription.plan || 'Free') as string;
  const status = (subscription.status || 'active') as string;
  const expiresAt = (subscription.expiresAt || subscription.currentPeriodEnd) as string | undefined;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Subscription</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Manage your plan and billing</p>
      </div>

      {/* Current Plan */}
      <div className="rounded-xl border border-border bg-card p-5">
        {subLoading ? (
          <div className="flex items-center justify-center py-6 text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin" /></div>
        ) : (
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-emerald-500/10 text-emerald-400 flex items-center justify-center">
              <Crown className="w-6 h-6" />
            </div>
            <div className="flex-1">
              <p className="text-lg font-semibold text-foreground">{planName}</p>
              <p className="text-sm text-muted-foreground">
                Status: <span className={status === 'active' ? 'text-emerald-400' : 'text-amber-400'}>{status}</span>
                {expiresAt && <> &middot; Renews {formatDate(expiresAt)}</>}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Available Plans */}
      <div>
        <h2 className="text-sm font-semibold text-foreground mb-3">Available Plans</h2>
        {plansLoading ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin" /></div>
        ) : plans.length === 0 ? (
          <div className="rounded-xl border border-border bg-card py-8 text-center">
            <p className="text-sm text-muted-foreground">No plans available</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {plans.map((plan) => (
              <div
                key={plan.id}
                className={`rounded-xl border bg-card p-5 space-y-3 ${
                  plan.isCurrent ? 'border-emerald-500/50 ring-1 ring-emerald-500/20' : 'border-border'
                }`}
              >
                <div className="flex items-center justify-between">
                  <p className="text-base font-semibold text-foreground">{plan.name}</p>
                  {plan.isCurrent && (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400">Current</span>
                  )}
                </div>
                {plan.price != null && (
                  <p className="text-2xl font-bold text-foreground">
                    ${plan.price}
                    {plan.interval && <span className="text-sm font-normal text-muted-foreground">/{plan.interval}</span>}
                  </p>
                )}
                {plan.features && plan.features.length > 0 && (
                  <ul className="space-y-1.5">
                    {plan.features.map((feat, i) => (
                      <li key={i} className="flex items-start gap-2 text-sm text-foreground">
                        <Check className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" />
                        <span>{feat}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Transaction History */}
      <div>
        <h2 className="text-sm font-semibold text-foreground mb-3">Transaction History</h2>
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          {txnLoading ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin" /></div>
          ) : transactions.length === 0 ? (
            <div className="py-8 text-center">
              <p className="text-sm text-muted-foreground">No transactions yet</p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {transactions.map((txn) => (
                <div key={txn.id} className="flex items-center gap-4 px-5 py-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{txn.description || 'Payment'}</p>
                    <p className="text-xs text-muted-foreground">{formatDate(txn.createdAt)}</p>
                  </div>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${
                    txn.status === 'succeeded' || txn.status === 'paid'
                      ? 'bg-emerald-500/10 text-emerald-400'
                      : txn.status === 'pending'
                      ? 'bg-amber-500/10 text-amber-400'
                      : 'bg-red-500/10 text-red-400'
                  }`}>
                    {txn.status || 'unknown'}
                  </span>
                  <p className="text-sm font-medium text-foreground">
                    {txn.amount != null ? `$${(txn.amount / 100).toFixed(2)}` : '--'}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
