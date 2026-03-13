/**
 * Event trigger installation.
 *
 * Installs PostgreSQL trigger functions on tracked tables that write
 * to the hakkyra.event_log table when data changes, implementing
 * the outbox pattern for reliable event delivery.
 */

import type { Pool } from 'pg';
import type { TableInfo, EventTriggerConfig } from '../types.js';
import { quoteIdentifier } from '../sql/utils.js';

// ─── Trigger SQL generation ────────────────────────────────────────────────

/**
 * Generate the trigger function SQL for a specific table.
 *
 * The function checks each configured event trigger and writes matching
 * events to hakkyra.event_log, then fires NOTIFY hakkyra_events.
 */
function generateTriggerFunctionSQL(
  table: TableInfo,
  triggers: EventTriggerConfig[],
): string {
  const funcName = `hakkyra.event_trigger_${table.schema}_${table.name}`;
  const insertTriggers = triggers.filter((t) => t.definition.insert);
  const updateTriggers = triggers.filter((t) => t.definition.update);
  const deleteTriggers = triggers.filter((t) => t.definition.delete);

  const blocks: string[] = [];

  // Session vars capture
  blocks.push(`  _session_vars := current_setting('hasura.user', true)::jsonb;`);

  // INSERT triggers
  if (insertTriggers.length > 0) {
    blocks.push(`  IF TG_OP = 'INSERT' THEN`);
    for (const trigger of insertTriggers) {
      blocks.push(`    INSERT INTO hakkyra.event_log(trigger_name, table_schema, table_name, operation, new_data, session_vars)
    VALUES (${quoteLiteral(trigger.name)}, TG_TABLE_SCHEMA, TG_TABLE_NAME, 'INSERT', to_jsonb(NEW), _session_vars);`);
    }
    blocks.push(`  END IF;`);
  }

  // UPDATE triggers
  if (updateTriggers.length > 0) {
    blocks.push(`  IF TG_OP = 'UPDATE' THEN`);
    for (const trigger of updateTriggers) {
      const updateDef = trigger.definition.update!;
      // If specific columns are tracked, only fire when those columns change
      if (updateDef.columns !== '*' && Array.isArray(updateDef.columns) && updateDef.columns.length > 0) {
        const conditions = updateDef.columns.map(
          (col) => `OLD.${quoteIdentifier(col)} IS DISTINCT FROM NEW.${quoteIdentifier(col)}`,
        );
        blocks.push(`    IF ${conditions.join(' OR ')} THEN`);
        blocks.push(`      INSERT INTO hakkyra.event_log(trigger_name, table_schema, table_name, operation, old_data, new_data, session_vars)
      VALUES (${quoteLiteral(trigger.name)}, TG_TABLE_SCHEMA, TG_TABLE_NAME, 'UPDATE', to_jsonb(OLD), to_jsonb(NEW), _session_vars);`);
        blocks.push(`    END IF;`);
      } else {
        blocks.push(`    INSERT INTO hakkyra.event_log(trigger_name, table_schema, table_name, operation, old_data, new_data, session_vars)
    VALUES (${quoteLiteral(trigger.name)}, TG_TABLE_SCHEMA, TG_TABLE_NAME, 'UPDATE', to_jsonb(OLD), to_jsonb(NEW), _session_vars);`);
      }
    }
    blocks.push(`  END IF;`);
  }

  // DELETE triggers
  if (deleteTriggers.length > 0) {
    blocks.push(`  IF TG_OP = 'DELETE' THEN`);
    for (const trigger of deleteTriggers) {
      blocks.push(`    INSERT INTO hakkyra.event_log(trigger_name, table_schema, table_name, operation, old_data, session_vars)
    VALUES (${quoteLiteral(trigger.name)}, TG_TABLE_SCHEMA, TG_TABLE_NAME, 'DELETE', to_jsonb(OLD), _session_vars);`);
    }
    blocks.push(`  END IF;`);
  }

  // Notification for delivery worker
  blocks.push(`  PERFORM pg_notify('hakkyra_events', json_build_object(
    'table', TG_TABLE_NAME,
    'schema', TG_TABLE_SCHEMA,
    'op', TG_OP
  )::text);`);

  // Determine which operations to trigger on
  const ops: string[] = [];
  if (insertTriggers.length > 0) ops.push('INSERT');
  if (updateTriggers.length > 0) ops.push('UPDATE');
  if (deleteTriggers.length > 0) ops.push('DELETE');

  const functionSQL = `
CREATE OR REPLACE FUNCTION ${funcName}() RETURNS trigger AS $$
DECLARE
  _session_vars JSONB;
BEGIN
${blocks.join('\n')}
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
`;

  const triggerSQL = `
DROP TRIGGER IF EXISTS hakkyra_event_${table.schema}_${table.name} ON ${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)};
CREATE TRIGGER hakkyra_event_${table.schema}_${table.name}
  AFTER ${ops.join(' OR ')} ON ${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)}
  FOR EACH ROW
  EXECUTE FUNCTION ${funcName}();
`;

  return functionSQL + triggerSQL;
}

/**
 * SQL-safe string literal quoting.
 */
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// ─── Installation ──────────────────────────────────────────────────────────

/**
 * Install event triggers on all tables that have event trigger configurations.
 */
export async function installEventTriggers(
  pool: Pool,
  tables: TableInfo[],
): Promise<void> {
  for (const table of tables) {
    if (table.eventTriggers.length === 0) continue;

    const sql = generateTriggerFunctionSQL(table, table.eventTriggers);
    await pool.query(sql);
  }
}

/**
 * Remove event triggers from all tables.
 * Used during shutdown or schema reload.
 */
export async function removeEventTriggers(
  pool: Pool,
  tables: TableInfo[],
): Promise<void> {
  for (const table of tables) {
    if (table.eventTriggers.length === 0) continue;

    const triggerName = `hakkyra_event_${table.schema}_${table.name}`;
    const tableRef = `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)}`;
    await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON ${tableRef}`);
    await pool.query(`DROP FUNCTION IF EXISTS hakkyra.event_trigger_${table.schema}_${table.name}()`);
  }
}
