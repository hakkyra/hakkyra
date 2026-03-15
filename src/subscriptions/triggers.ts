/**
 * Subscription change notification triggers.
 *
 * Installs a generic PG trigger function on all tracked tables that
 * fires NOTIFY with table/schema/operation info when data changes.
 */

import type { Pool } from 'pg';
import type { TableInfo } from '../types.js';
import { quoteIdentifier } from '../sql/utils.js';

/**
 * Raw PL/pgSQL body of the notify_change() function (without CREATE FUNCTION wrapper).
 */
export function subscriptionFunctionBody(schemaName: string = 'hakkyra'): string {
  const channelName = `${schemaName}_changes`;
  return `
  PERFORM pg_notify('${channelName}', json_build_object(
    'table', TG_TABLE_NAME,
    'schema', TG_TABLE_SCHEMA,
    'op', TG_OP
  )::text);
  RETURN COALESCE(NEW, OLD);`.trim();
}

/**
 * Full CREATE OR REPLACE FUNCTION SQL for the shared notification function.
 */
export function subscriptionFunctionSQL(schemaName: string = 'hakkyra'): string {
  const channelName = `${schemaName}_changes`;
  return `
CREATE OR REPLACE FUNCTION ${quoteIdentifier(schemaName)}.notify_change() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('${channelName}', json_build_object(
    'table', TG_TABLE_NAME,
    'schema', TG_TABLE_SCHEMA,
    'op', TG_OP
  )::text);
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;`;
}

// Backward-compatible constants (default schema name)
export const SUBSCRIPTION_FUNCTION_BODY = subscriptionFunctionBody('hakkyra');
export const SUBSCRIPTION_FUNCTION_SQL = subscriptionFunctionSQL('hakkyra');

/**
 * Generate the CREATE TRIGGER SQL for a single subscription trigger.
 */
export function generateSubscriptionTriggerSQL(table: TableInfo, schemaName: string = 'hakkyra'): {
  triggerName: string;
  createTriggerSQL: string;
  events: string;
} {
  const tableRef = `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)}`;
  const triggerName = `${schemaName}_notify_${table.schema}_${table.name}`;
  const events = 'INSERT OR UPDATE OR DELETE';
  const createTriggerSQL = `
CREATE TRIGGER ${triggerName}
  AFTER ${events} ON ${tableRef}
  FOR EACH ROW
  EXECUTE FUNCTION ${quoteIdentifier(schemaName)}.notify_change();`;

  return { triggerName, createTriggerSQL, events };
}

/**
 * Install subscription notification triggers on all tracked tables.
 *
 * Uses a single shared trigger function (notify_change) that
 * sends a lightweight NOTIFY payload with table + operation info.
 * The subscription manager uses this to determine which subscriptions
 * need re-querying.
 */
export async function installSubscriptionTriggers(
  pool: Pool,
  tables: TableInfo[],
  schemaName: string = 'hakkyra',
): Promise<void> {
  // Ensure internal schema exists
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schemaName)}`);

  // Create the shared notification function
  await pool.query(subscriptionFunctionSQL(schemaName));

  // Install trigger on each tracked table (skip views/materialized views)
  for (const table of tables) {
    const tableRef = `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)}`;
    const triggerName = `${schemaName}_notify_${table.schema}_${table.name}`;

    try {
      await pool.query(`
        DROP TRIGGER IF EXISTS ${triggerName} ON ${tableRef};
        CREATE TRIGGER ${triggerName}
          AFTER INSERT OR UPDATE OR DELETE ON ${tableRef}
          FOR EACH ROW
          EXECUTE FUNCTION ${quoteIdentifier(schemaName)}.notify_change();
      `);
    } catch (err) {
      // Materialized views and some views cannot have triggers — skip silently
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('cannot have triggers')) {
        continue;
      }
      throw err;
    }
  }
}

/**
 * Remove subscription notification triggers from all tracked tables.
 */
export async function removeSubscriptionTriggers(
  pool: Pool,
  tables: TableInfo[],
  schemaName: string = 'hakkyra',
): Promise<void> {
  for (const table of tables) {
    const tableRef = `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)}`;
    const triggerName = `${schemaName}_notify_${table.schema}_${table.name}`;
    await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON ${tableRef}`);
  }
}
