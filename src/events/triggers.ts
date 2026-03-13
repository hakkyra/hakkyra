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

// ─── Types ─────────────────────────────────────────────────────────────────

export interface GeneratedEventTrigger {
  triggerName: string;
  functionName: string;
  functionSchema: string;
  events: string;
  functionBody: string;
  createFunctionSQL: string;
  createTriggerSQL: string;
}

// ─── Trigger SQL generation ────────────────────────────────────────────────

/**
 * Generate structured event trigger SQL for a specific table.
 *
 * Returns the function body, CREATE FUNCTION, and CREATE TRIGGER
 * SQL separately so the trigger reconciler can diff and selectively apply.
 */
export function generateEventTriggerSQL(
  table: TableInfo,
  triggers: EventTriggerConfig[],
): GeneratedEventTrigger {
  const funcSchema = 'hakkyra';
  const funcName = `event_trigger_${table.schema}_${table.name}`;
  const triggerName = `hakkyra_event_${table.schema}_${table.name}`;
  const tableRef = `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)}`;

  const insertTriggers = triggers.filter((t) => t.definition.insert);
  const updateTriggers = triggers.filter((t) => t.definition.update);
  const deleteTriggers = triggers.filter((t) => t.definition.delete);

  const blocks: string[] = [];

  // Session vars capture
  blocks.push(`  _session_vars := NULLIF(current_setting('hasura.user', true), '')::jsonb;`);

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
  const events = ops.join(' OR ');

  const functionBody = `
  _session_vars := NULLIF(current_setting('hasura.user', true), '')::jsonb;
${blocks.slice(1).join('\n')}
  RETURN COALESCE(NEW, OLD);`.trim();

  const createFunctionSQL = `
CREATE OR REPLACE FUNCTION ${funcSchema}.${funcName}() RETURNS trigger AS $$
DECLARE
  _session_vars JSONB;
BEGIN
${blocks.join('\n')}
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;`;

  const createTriggerSQL = `
CREATE TRIGGER ${triggerName}
  AFTER ${events} ON ${tableRef}
  FOR EACH ROW
  EXECUTE FUNCTION ${funcSchema}.${funcName}();`;

  return {
    triggerName,
    functionName: funcName,
    functionSchema: funcSchema,
    events,
    functionBody,
    createFunctionSQL,
    createTriggerSQL,
  };
}

/**
 * Generate combined SQL for backward compatibility.
 */
function generateTriggerFunctionSQL(
  table: TableInfo,
  triggers: EventTriggerConfig[],
): string {
  const gen = generateEventTriggerSQL(table, triggers);
  const tableRef = `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)}`;
  return `${gen.createFunctionSQL}
DROP TRIGGER IF EXISTS ${gen.triggerName} ON ${tableRef};
${gen.createTriggerSQL}`;
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
