export interface Reservation {
  id: string;
  queueNumber: string;
  status: string;
  position: number;
  peopleAhead: number;
  estimatedWait: number;
  currentServingNumber: string;
  agencyName: string;
  agencyNameAr?: string;
  agencyNameFr?: string;
  serviceName: string;
  serviceNameAr?: string;
  serviceNameFr?: string;
  joinedAt: string;
  reservedDate?: string;
  rating?: number | null;
  skippedForNoShow?: boolean;
  preferredTime?: string;
  fixedTimeEnabled?: boolean;
  postponeCount?: number;
}

export interface Countdown {
  hours: number;
  minutes: number;
  seconds: number;
}
