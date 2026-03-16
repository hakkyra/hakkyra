/**
 * Event trigger database schema.
 *
 * Creates the internal schema and event_log table used by the
 * outbox pattern for reliable event delivery.
 */

import type { Pool } from 'pg';

/**
 * SQL to create the internal schema.
 */
export function createSchemaSQL(schemaName: string): string {
  return `CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schemaName)}`;
}

export function createEventLogSQL(schemaName: string): string {
  return `
CREATE TABLE IF NOT EXISTS ${quoteIdent(schemaName)}.event_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger_name TEXT NOT NULL,
  table_schema TEXT NOT NULL,
  table_name TEXT NOT NULL,
  operation TEXT NOT NULL,
  old_data JSONB,
  new_data JSONB,
  session_vars JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  delivered BOOLEAN DEFAULT false,
  delivered_at TIMESTAMPTZ,
  retry_count INTEGER DEFAULT 0,
  next_retry TIMESTAMPTZ DEFAULT now(),
  status TEXT DEFAULT 'pending',
  last_error TEXT,
  response_status INTEGER
)
`;
}

export function createIndexesSQL(schemaName: string): string {
  return `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_event_log_status') THEN
    CREATE INDEX idx_event_log_status ON ${quoteIdent(schemaName)}.event_log(status, next_retry);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_event_log_trigger') THEN
    CREATE INDEX idx_event_log_trigger ON ${quoteIdent(schemaName)}.event_log(trigger_name);
  END IF;
END $$
`;
}

/**
 * Double-quote a SQL identifier to prevent injection.
 */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Ensure all columns exist on an already-created event_log table.
 * Uses ADD COLUMN IF NOT EXISTS to be idempotent.
 */
export function migrateEventLogSQL(schemaName: string): string {
  return `
DO $$ BEGIN
  ALTER TABLE ${quoteIdent(schemaName)}.event_log ADD COLUMN IF NOT EXISTS delivered BOOLEAN DEFAULT false;
  ALTER TABLE ${quoteIdent(schemaName)}.event_log ADD COLUMN IF NOT EXISTS response_status INTEGER;
END $$
`;
}

/**
 * Ensure the internal schema and event_log table exist.
 */
export async function ensureEventSchema(pool: Pool, schemaName: string = 'hakkyra'): Promise<void> {
  await pool.query(createSchemaSQL(schemaName));
  await pool.query(createEventLogSQL(schemaName));
  await pool.query(migrateEventLogSQL(schemaName));
  await pool.query(createIndexesSQL(schemaName));
}
