/**
 * One-off scheduled event database schema.
 *
 * Mirrors Hasura's hdb_catalog.hdb_scheduled_events /
 * hdb_scheduled_event_invocation_logs column naming so clients that inserted
 * scheduled events directly into Hasura's catalog only need to change the
 * schema/table name.
 */

import type { Pool } from 'pg';
import { quoteIdentifier as quoteIdent } from '../sql/utils.js';

export function createScheduledEventsSQL(schemaName: string): string {
  return `
CREATE TABLE IF NOT EXISTS ${quoteIdent(schemaName)}.scheduled_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_conf TEXT NOT NULL,
  scheduled_time TIMESTAMPTZ NOT NULL,
  retry_conf JSONB,
  payload JSONB,
  header_conf JSONB,
  status TEXT NOT NULL DEFAULT 'scheduled',
  tries INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  next_retry_at TIMESTAMPTZ,
  locked_at TIMESTAMPTZ,
  comment TEXT
)
`;
}

export function createScheduledEventInvocationsSQL(schemaName: string): string {
  return `
CREATE TABLE IF NOT EXISTS ${quoteIdent(schemaName)}.scheduled_event_invocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES ${quoteIdent(schemaName)}.scheduled_events(id) ON DELETE CASCADE,
  status INTEGER,
  request JSONB,
  response JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
)
`;
}

export function createScheduledEventIndexesSQL(schemaName: string): string {
  return `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_scheduled_events_due') THEN
    CREATE INDEX idx_scheduled_events_due ON ${quoteIdent(schemaName)}.scheduled_events(status, scheduled_time);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_scheduled_event_invocations_event') THEN
    CREATE INDEX idx_scheduled_event_invocations_event ON ${quoteIdent(schemaName)}.scheduled_event_invocations(event_id);
  END IF;
END $$
`;
}

/**
 * Ensure the scheduled event tables exist (the internal schema itself is
 * created by ensureEventSchema; this also creates it for standalone use).
 */
export async function ensureScheduledEventSchema(pool: Pool, schemaName: string = 'hakkyra'): Promise<void> {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schemaName)}`);
  await pool.query(createScheduledEventsSQL(schemaName));
  await pool.query(createScheduledEventInvocationsSQL(schemaName));
  await pool.query(createScheduledEventIndexesSQL(schemaName));
}
