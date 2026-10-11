/**
 * BLASTI WatermelonDB Schema
 *
 * Defines the table columns for each model. Column names must match the
 * @text/@field/@date decorators in models.ts.
 *
 * Note: WatermelonDB automatically adds `id`, `created_at`, `updated_at`,
 * and `_status` / `_changed` columns for sync tracking — do not declare them here.
 */

import { appSchema, tableSchema } from '@nozbe/watermelondb';

export const schema = appSchema({
  version: 2,
  tables: [
    tableSchema({
      name: 'agencies',
      columns: [
        { name: 'name', type: 'string' },
        { name: 'name_fr', type: 'string', isOptional: true },
        { name: 'name_ar', type: 'string', isOptional: true },
        { name: 'custom_code', type: 'string', isOptional: true },
        { name: 'category', type: 'string', isOptional: true },
        { name: 'address', type: 'string', isOptional: true },
        { name: 'city', type: 'string', isOptional: true },
        { name: 'phone', type: 'string', isOptional: true },
        { name: 'email', type: 'string', isOptional: true },
        { name: 'average_service_time', type: 'number', isOptional: true },
        { name: 'max_active_reservations', type: 'number', isOptional: true },
        { name: 'is_queue_open', type: 'boolean' },
        { name: 'subscription_tier', type: 'string', isOptional: true },
        { name: 'subscription_status', type: 'string', isOptional: true },
        { name: 'working_hours_start', type: 'string', isOptional: true },
        { name: 'working_hours_end', type: 'string', isOptional: true },
        { name: 'is_active', type: 'boolean' },
      ],
    }),
    tableSchema({
      name: 'services',
      columns: [
        { name: 'agency_id', type: 'string' },
        { name: 'name', type: 'string' },
        { name: 'name_fr', type: 'string', isOptional: true },
        { name: 'name_ar', type: 'string', isOptional: true },
        { name: 'prefix', type: 'string', isOptional: true },
        { name: 'is_active', type: 'boolean' },
      ],
    }),
    tableSchema({
      name: 'branches',
      columns: [
        { name: 'agency_id', type: 'string' },
        { name: 'name', type: 'string' },
        { name: 'name_ar', type: 'string', isOptional: true },
        { name: 'name_fr', type: 'string', isOptional: true },
        { name: 'address', type: 'string', isOptional: true },
        { name: 'phone', type: 'string', isOptional: true },
        { name: 'is_main', type: 'boolean' },
        { name: 'is_active', type: 'boolean' },
      ],
    }),
    tableSchema({
      name: 'counters',
      columns: [
        { name: 'branch_id', type: 'string' },
        { name: 'number', type: 'number' },
        { name: 'name', type: 'string', isOptional: true },
        { name: 'name_ar', type: 'string', isOptional: true },
        { name: 'name_fr', type: 'string', isOptional: true },
        { name: 'is_active', type: 'boolean' },
      ],
    }),
    tableSchema({
      name: 'reservations',
      columns: [
        { name: 'user_id', type: 'string', isOptional: true },
        { name: 'agency_id', type: 'string' },
        { name: 'service_id', type: 'string' },
        { name: 'queue_number', type: 'number', isOptional: true },
        { name: 'display_number', type: 'string', isOptional: true },
        { name: 'status', type: 'string' },
        { name: 'estimated_wait', type: 'number', isOptional: true },
        { name: 'joined_at', type: 'number' }, // readonly timestamp
        { name: 'called_at', type: 'number', isOptional: true },
        { name: 'completed_at', type: 'number', isOptional: true },
        { name: 'cancelled_at', type: 'number', isOptional: true },
        { name: 'preferred_time', type: 'string', isOptional: true },
        { name: 'fixed_time_enabled', type: 'boolean' },
        { name: 'postpone_count', type: 'number' },
        { name: 'is_walk_in', type: 'boolean' },
        { name: 'walk_in_customer_name', type: 'string', isOptional: true },
        { name: 'counter_id', type: 'string', isOptional: true },
        { name: 'sync_device_id', type: 'string', isOptional: true },
        { name: 'offline_created_at', type: 'string', isOptional: true },
      ],
    }),
    tableSchema({
      name: 'notifications',
      columns: [
        { name: 'user_id', type: 'string' },
        { name: 'type', type: 'string' },
        { name: 'title', type: 'string' },
        { name: 'message', type: 'string' },
        { name: 'is_read', type: 'boolean' },
        { name: 'entity_id', type: 'string', isOptional: true },
      ],
    }),
    tableSchema({
      name: 'queue_settings',
      columns: [
        { name: 'agency_id', type: 'string' },
        { name: 'current_serving_number', type: 'number' },
        { name: 'last_issued_number', type: 'number' },
        { name: 'is_paused', type: 'boolean' },
        { name: 'paused_at', type: 'number', isOptional: true },
      ],
    }),
  ],
});
