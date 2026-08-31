/**
 * BLASTI WatermelonDB Models (Non-Decorator API)
 *
 * Uses the non-decorator API for maximum bundler compatibility
 * (works with Turbopack/SWC without needing legacy decorator support).
 *
 * Fields are defined as getters/setters that delegate to _getRaw/_setRaw,
 * which is exactly what the @text/@field/@date decorators do internally.
 */

import { Model, Q } from '@nozbe/watermelondb';

type Query<T extends Model> = import('@nozbe/watermelondb').Query<T>;
type Relation<T extends Model> = import('@nozbe/watermelondb').Relation<T>;

// ─── Helper: Define a simple field accessor ─────────────────────────────────
//
// This mimics what @text/@field decorators do: creates a getter/setter
// that reads/writes the raw record value.

function defineField<T extends Model>(
  ModelClass: { prototype: T; new (...args: any[]): T },
  propertyName: string,
  columnName: string,
): void {
  Object.defineProperty(ModelClass.prototype, propertyName, {
    get(): any {
      return (this as any)._getRaw(columnName);
    },
    set(value: any): void {
      (this as any)._setRaw(columnName, value);
    },
    enumerable: true,
    configurable: true,
  });
}

// ─── Helper: Define a date field (converts between timestamp and Date) ──────

function defineDateField<T extends Model>(
  ModelClass: { prototype: T; new (...args: any[]): T },
  propertyName: string,
  columnName: string,
): void {
  Object.defineProperty(ModelClass.prototype, propertyName, {
    get(): Date | null {
      const raw = (this as any)._getRaw(columnName);
      return raw ? new Date(raw) : null;
    },
    set(value: Date | null): void {
      (this as any)._setRaw(columnName, value ? value.getTime() : null);
    },
    enumerable: true,
    configurable: true,
  });
}

// ─── Helper: Define a children relation ─────────────────────────────────────

function defineChildren<T extends Model, C extends Model>(
  ModelClass: { prototype: T; new (...args: any[]): T },
  propertyName: string,
  childTable: string,
  foreignKey: string,
): void {
  Object.defineProperty(ModelClass.prototype, propertyName, {
    get(): Query<C> {
      return (this as any).collections.get(childTable).query(Q.where(foreignKey, (this as any).id));
    },
    enumerable: true,
    configurable: true,
  });
}

// ─── Helper: Define a belongsTo relation ────────────────────────────────────

function defineRelation<T extends Model, R extends Model>(
  ModelClass: { prototype: T; new (...args: any[]): T },
  propertyName: string,
  relatedTable: string,
  foreignKey: string,
): void {
  Object.defineProperty(ModelClass.prototype, propertyName, {
    get(): Relation<R> {
      const self = this as any;
      const id = self._getRaw(foreignKey);
      if (!id) {
        return {
          observe: () => ({
            subscribe: (observer: { next: (v: R | null) => void; error: (e: any) => void }) => {
              observer.next(null);
              return { unsubscribe: () => {} };
            },
          }),
          fetch: () => Promise.resolve(null),
        } as any;
      }
      return self.collections.get(relatedTable).findAndObserve(id) as any;
    },
    enumerable: true,
    configurable: true,
  });
}

// ─── Agency ──────────────────────────────────────────────────────────────────

export class Agency extends Model {
  static table = 'agencies';
}

defineField(Agency, 'name', 'name');
defineField(Agency, 'nameFr', 'name_fr');
defineField(Agency, 'nameAr', 'name_ar');
defineField(Agency, 'customCode', 'custom_code');
defineField(Agency, 'category', 'category');
defineField(Agency, 'address', 'address');
defineField(Agency, 'city', 'city');
defineField(Agency, 'phone', 'phone');
defineField(Agency, 'email', 'email');
defineField(Agency, 'averageServiceTime', 'average_service_time');
defineField(Agency, 'maxActiveReservations', 'max_active_reservations');
defineField(Agency, 'isQueueOpen', 'is_queue_open');
defineField(Agency, 'subscriptionTier', 'subscription_tier');
defineField(Agency, 'subscriptionStatus', 'subscription_status');
defineField(Agency, 'workingHoursStart', 'working_hours_start');
defineField(Agency, 'workingHoursEnd', 'working_hours_end');
defineField(Agency, 'isActive', 'is_active');
defineChildren(Agency as any, 'services', 'services', 'agency_id');
defineChildren(Agency as any, 'branches', 'branches', 'agency_id');
defineChildren(Agency as any, 'reservations', 'reservations', 'agency_id');

// ─── Service ─────────────────────────────────────────────────────────────────

export class Service extends Model {
  static table = 'services';
}

defineField(Service, 'agencyId', 'agency_id');
defineField(Service, 'name', 'name');
defineField(Service, 'nameFr', 'name_fr');
defineField(Service, 'nameAr', 'name_ar');
defineField(Service, 'prefix', 'prefix');
defineField(Service, 'isActive', 'is_active');
defineChildren(Service as any, 'reservations', 'reservations', 'service_id');
defineRelation(Service as any, 'agency', 'agencies', 'agency_id');

// ─── Branch ──────────────────────────────────────────────────────────────────

export class Branch extends Model {
  static table = 'branches';
}

defineField(Branch, 'agencyId', 'agency_id');
defineField(Branch, 'name', 'name');
defineField(Branch, 'nameAr', 'name_ar');
defineField(Branch, 'nameFr', 'name_fr');
defineField(Branch, 'address', 'address');
defineField(Branch, 'phone', 'phone');
defineField(Branch, 'isMain', 'is_main');
defineField(Branch, 'isActive', 'is_active');
defineChildren(Branch as any, 'counters', 'counters', 'branch_id');
defineRelation(Branch as any, 'agency', 'agencies', 'agency_id');

// ─── Counter ─────────────────────────────────────────────────────────────────

export class Counter extends Model {
  static table = 'counters';
}

defineField(Counter, 'branchId', 'branch_id');
defineField(Counter, 'number', 'number');
defineField(Counter, 'name', 'name');
defineField(Counter, 'nameAr', 'name_ar');
defineField(Counter, 'nameFr', 'name_fr');
defineField(Counter, 'isActive', 'is_active');
defineRelation(Counter as any, 'branch', 'branches', 'branch_id');

// ─── Reservation ─────────────────────────────────────────────────────────────
// This is the primary offline model — customers/staff create reservations
// while offline, and they sync to the server when connectivity returns.

export class Reservation extends Model {
  static table = 'reservations';
}

defineField(Reservation, 'userId', 'user_id');
defineField(Reservation, 'agencyId', 'agency_id');
defineField(Reservation, 'serviceId', 'service_id');
defineField(Reservation, 'queueNumber', 'queue_number');
defineField(Reservation, 'displayNumber', 'display_number');
defineField(Reservation, 'status', 'status');
defineField(Reservation, 'estimatedWait', 'estimated_wait');
defineField(Reservation, 'preferredTime', 'preferred_time');
defineField(Reservation, 'fixedTimeEnabled', 'fixed_time_enabled');
defineField(Reservation, 'postponeCount', 'postpone_count');
defineField(Reservation, 'isWalkIn', 'is_walk_in');
defineField(Reservation, 'walkInCustomerName', 'walk_in_customer_name');
defineField(Reservation, 'counterId', 'counter_id');
defineField(Reservation, 'syncDeviceId', 'sync_device_id');
defineField(Reservation, 'offlineCreatedAt', 'offline_created_at');
defineDateField(Reservation as any, 'calledAt', 'called_at');
defineDateField(Reservation as any, 'completedAt', 'completed_at');
defineDateField(Reservation as any, 'cancelledAt', 'cancelled_at');
defineDateField(Reservation as any, 'pausedAt', 'paused_at');
defineRelation(Reservation as any, 'agency', 'agencies', 'agency_id');
defineRelation(Reservation as any, 'service', 'services', 'service_id');

// ─── Notification ────────────────────────────────────────────────────────────

export class Notification extends Model {
  static table = 'notifications';
}

defineField(Notification, 'userId', 'user_id');
defineField(Notification, 'type', 'type');
defineField(Notification, 'title', 'title');
defineField(Notification, 'message', 'message');
defineField(Notification, 'isRead', 'is_read');
defineField(Notification, 'entityId', 'entity_id');

// ─── QueueSettings ───────────────────────────────────────────────────────────

export class QueueSettings extends Model {
  static table = 'queue_settings';
}

defineField(QueueSettings, 'agencyId', 'agency_id');
defineField(QueueSettings, 'currentServingNumber', 'current_serving_number');
defineField(QueueSettings, 'lastIssuedNumber', 'last_issued_number');
defineField(QueueSettings, 'isPaused', 'is_paused');
defineDateField(QueueSettings as any, 'pausedAt', 'paused_at');
defineRelation(QueueSettings as any, 'agency', 'agencies', 'agency_id');

// ─── Export all model classes ────────────────────────────────────────────────

export const modelClasses = [
  Agency,
  Service,
  Branch,
  Counter,
  Reservation,
  Notification,
  QueueSettings,
];
