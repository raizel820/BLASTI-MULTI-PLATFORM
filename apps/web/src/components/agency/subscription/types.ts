export interface Transaction {
  id: string;
  amount: number;
  plan: string;
  method: string;
  status: string;
  createdAt: string;
}

export interface SubscriptionData {
  currentPlan: string;
  status: string;
  expiresAt?: string;
  recentTransactions: Transaction[];
}

export interface FaqItem {
  id: string;
  question: string;
  answer: string;
  category: string;
  order: number;
}

export interface PlanInfo {
  id: string;
  name: string;
  price: string;
  priceShort: string;
  features: string[];
  highlight: boolean;
  badge?: string;
  gradientFrom: string;
  gradientTo: string;
  icon: React.ComponentType<{ className?: string }>;
  description: string;
  // Enterprise custom-plan flags (mirrors the SubscriptionPlan DB columns).
  // When `isEnterprise` is true the plan is a bespoke plan created for a
  // specific agency; `ownerAgencyId` identifies that agency.
  isEnterprise?: boolean;
  ownerAgencyId?: string | null;
}

// Plan comparison data (NO ENTERPRISE)
export const PLAN_COMPARISON = {
  maxQueues: { basic: '5', premium: '15' },
  maxServices: { basic: '3', premium: '10' },
  maxStaff: { basic: '2', premium: '5' },
  smsCreditsMonthly: { basic: '50', premium: '200' },
  analytics: { basic: 'basic', premium: 'full' },
  apiAccess: { basic: false, premium: false },
  prioritySupport: { basic: false, premium: false },
  customBranding: { basic: false, premium: false },
};
