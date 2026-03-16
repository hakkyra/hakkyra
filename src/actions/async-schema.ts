/**
 * Async action database schema.
 *
 * Creates the hakkyra.async_action_log table used to track async action
 * requests, their processing status, and results.
 */

import type { Pool } from 'pg';

/**
 * SQL to create the async_action_log table.
 *
 * Relies on the hakkyra schema already existing (created by event schema).
 */
const CREATE_SCHEMA_SQL = `CREATE SCHEMA IF NOT EXISTS hakkyra`;

const CREATE_ASYNC_ACTION_LOG_SQL = `
CREATE TABLE IF NOT EXISTS hakkyra.async_action_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action_name TEXT NOT NULL,
  input JSONB NOT NULL,
  session_variables JSONB,
  user_id TEXT,
  status TEXT NOT NULL DEFAULT 'created',
  output JSONB,
  errors JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
)
`;

const CREATE_INDEXES_SQL = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_async_action_log_status') THEN
    CREATE INDEX idx_async_action_log_status ON hakkyra.async_action_log(status);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_async_action_log_action_name') THEN
    CREATE INDEX idx_async_action_log_action_name ON hakkyra.async_action_log(action_name);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_async_action_log_user_id') THEN
    CREATE INDEX idx_async_action_log_user_id ON hakkyra.async_action_log(user_id);
  END IF;
END $$
`;

/**
 * Ensure the hakkyra schema and async_action_log table exist.
 */
export async function ensureAsyncActionSchema(pool: Pool): Promise<void> {
  await pool.query(CREATE_SCHEMA_SQL);
  await pool.query(CREATE_ASYNC_ACTION_LOG_SQL);
  await pool.query(CREATE_INDEXES_SQL);
}
