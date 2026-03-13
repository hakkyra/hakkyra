/**
 * Subscription change notification triggers.
 *
 * Installs a generic PG trigger function on all tracked tables that
 * fires NOTIFY hakkyra_changes with table/schema/operation info
 * when data changes.
 */

import type { Pool } from 'pg';
import type { TableInfo } from '../types.js';
import { quoteIdentifier } from '../sql/utils.js';

/**
 * SQL for the generic change notification function.
 * Fires pg_notify with a JSON payload identifying the changed table.
 */
const NOTIFY_FUNCTION_SQL = `
CREATE OR REPLACE FUNCTION hakkyra.notify_change() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('hakkyra_changes', json_build_object(
    'table', TG_TABLE_NAME,
    'schema', TG_TABLE_SCHEMA,
    'op', TG_OP
  )::text);
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
`;

/**
 * Install subscription notification triggers on all tracked tables.
 *
 * Uses a single shared trigger function (hakkyra.notify_change) that
 * sends a lightweight NOTIFY payload with table + operation info.
 * The subscription manager uses this to determine which subscriptions
 * need re-querying.
 */
export async function installSubscriptionTriggers(
  pool: Pool,
  tables: TableInfo[],
): Promise<void> {
  // Ensure hakkyra schema exists
  await pool.query(`CREATE SCHEMA IF NOT EXISTS hakkyra`);

  // Create the shared notification function
  await pool.query(NOTIFY_FUNCTION_SQL);

  // Install trigger on each tracked table (skip views/materialized views)
  for (const table of tables) {
    const tableRef = `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)}`;
    const triggerName = `hakkyra_notify_${table.schema}_${table.name}`;

    try {
      await pool.query(`
        DROP TRIGGER IF EXISTS ${triggerName} ON ${tableRef};
        CREATE TRIGGER ${triggerName}
          AFTER INSERT OR UPDATE OR DELETE ON ${tableRef}
          FOR EACH ROW
          EXECUTE FUNCTION hakkyra.notify_change();
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
): Promise<void> {
  for (const table of tables) {
    const tableRef = `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)}`;
    const triggerName = `hakkyra_notify_${table.schema}_${table.name}`;
    await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON ${tableRef}`);
  }
}
