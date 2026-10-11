export interface QueueEntry {
  id: string;
  queueNumber: string;
  customerName: string;
  serviceName: string;
  serviceNameAr?: string;
  serviceNameFr?: string;
  joinedAt: string;
  status: string;
  position: number;
  isWalkIn?: boolean;
  walkInCustomerName?: string;
  preferredTime?: string;
  fixedTimeEnabled?: boolean;
  postponeCount?: number;
}

export interface DashboardStats {
  todayReservations: number;
  currentlyWaiting: number;
  servedToday: number;
  avgWaitTime: number;
  currentQueueNumber: string;
  isPaused: boolean;
  noShowCount?: number;
  cancelledCount?: number;
  peakHour?: string;
  avgRating?: number;
  totalRatings?: number;
  noShowRate?: number;
  hourlyWaitTime?: { hour: number; avgWaitTime: number; servedCount: number }[];
  ratingDistribution?: { rating: number; count: number }[];
  subscriptionStatus?: string;
}

export interface ServiceStat {
  id: string;
  name: string;
  nameAr?: string;
  nameFr?: string;
  waitingCount: number;
  completedCount: number;
  _count?: { waiting: number; completed: number };
}

export interface ActivityEvent {
  id: string;
  eventType: string;
  eventKey: string;
  customerName: string;
  queueNumber: string;
  timestamp: string;
  serviceName?: string;
}
