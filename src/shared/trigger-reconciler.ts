/**
 * Trigger reconciler — diff-based startup instead of DROP+CREATE all.
 *
 * Queries existing hakkyra triggers from pg_trigger/pg_proc, diffs them
 * against the desired triggers from YAML config, and only creates new,
 * drops orphaned, or replaces changed triggers.
 */

import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { TableInfo } from '../types.js';
import { quoteIdentifier } from '../sql/utils.js';
import { generateEventTriggerSQL } from '../events/triggers.js';
import {
  SUBSCRIPTION_FUNCTION_BODY,
  SUBSCRIPTION_FUNCTION_SQL,
  generateSubscriptionTriggerSQL,
} from '../subscriptions/triggers.js';

// ─── Types ─────────────────────────────────────────────────────────────────

interface ExistingTrigger {
  triggerName: string;
  tableSchema: string;
  tableName: string;
  functionSchema: string;
  functionName: string;
  events: string;
  functionBody: string;
}

export interface DesiredTrigger {
  triggerName: string;
  tableSchema: string;
  tableName: string;
  functionSchema: string;
  functionName: string;
  events: string;
  functionBody: string;
  createFunctionSQL: string;
  createTriggerSQL: string;
}

export interface ReconcileResult {
  created: string[];
  dropped: string[];
  replaced: string[];
  unchanged: string[];
}

export interface ReconcileOptions {
  /** Filter discovery to triggers matching this prefix (e.g. 'hakkyra_event_'). */
  triggerPrefix?: string;
}

// ─── Catalog discovery ──────────────────────────────────────────────────────

const DISCOVERY_SQL = `
SELECT
  t.tgname AS trigger_name,
  c.relname AS table_name,
  n.nspname AS table_schema,
  p.proname AS function_name,
  pn.nspname AS function_schema,
  array_to_string(ARRAY[]::text[]
    || CASE WHEN (t.tgtype & 4)  != 0 THEN ARRAY['INSERT'] ELSE ARRAY[]::text[] END
    || CASE WHEN (t.tgtype & 16) != 0 THEN ARRAY['UPDATE'] ELSE ARRAY[]::text[] END
    || CASE WHEN (t.tgtype & 8)  != 0 THEN ARRAY['DELETE'] ELSE ARRAY[]::text[] END
  , ' OR ') AS events,
  p.prosrc AS function_body
FROM pg_trigger t
JOIN pg_class c ON t.tgrelid = c.oid
JOIN pg_namespace n ON c.relnamespace = n.oid
JOIN pg_proc p ON t.tgfoid = p.oid
JOIN pg_namespace pn ON p.pronamespace = pn.oid
WHERE t.tgname LIKE $1
  AND NOT t.tgisinternal`;

async function fetchExistingTriggers(
  pool: Pool,
  prefix: string,
): Promise<ExistingTrigger[]> {
  const result = await pool.query(DISCOVERY_SQL, [`${prefix}%`]);
  return result.rows.map((row: Record<string, string>) => ({
    triggerName: row.trigger_name,
    tableSchema: row.table_schema,
    tableName: row.table_name,
    functionSchema: row.function_schema,
    functionName: row.function_name,
    events: row.events,
    functionBody: row.function_body,
  }));
}

// ─── Normalization ──────────────────────────────────────────────────────────

/**
 * Normalize a PL/pgSQL function body for comparison.
 * Trims whitespace and collapses runs of whitespace to single spaces.
 */
export function normalizeFunctionBody(body: string): string {
  return body.trim().replace(/\s+/g, ' ');
}

// ─── Reconcile ──────────────────────────────────────────────────────────────

/**
 * Reconcile desired triggers against what exists in the database.
 *
 * - Creates new triggers that don't exist yet
 * - Drops orphaned triggers (exist in DB but not in desired set)
 * - Replaces triggers whose function body or events changed
 * - Skips unchanged triggers
 */
export async function reconcileTriggers(
  pool: Pool,
  desired: DesiredTrigger[],
  logger: Logger,
  options?: ReconcileOptions,
): Promise<ReconcileResult> {
  const prefix = options?.triggerPrefix ?? 'hakkyra_';
  const existing = await fetchExistingTriggers(pool, prefix);

  const existingMap = new Map<string, ExistingTrigger>();
  for (const e of existing) existingMap.set(e.triggerName, e);

  const desiredMap = new Map<string, DesiredTrigger>();
  for (const d of desired) desiredMap.set(d.triggerName, d);

  const result: ReconcileResult = {
    created: [],
    dropped: [],
    replaced: [],
    unchanged: [],
  };

  // Ensure hakkyra schema exists
  await pool.query('CREATE SCHEMA IF NOT EXISTS hakkyra');

  // Process desired triggers
  for (const [name, d] of desiredMap) {
    const e = existingMap.get(name);

    if (!e) {
      // New trigger
      try {
        await pool.query(d.createFunctionSQL);
        await pool.query(d.createTriggerSQL);
        result.created.push(name);
      } catch (err) {
        // Views and materialized views cannot have row-level triggers — skip
        const code = (err as { code?: string }).code;
        if (code === '42809') {
          logger.debug({ trigger: name }, 'Skipping trigger on view/materialized view');
          continue;
        }
        throw err;
      }
    } else {
      const bodyChanged =
        normalizeFunctionBody(d.functionBody) !== normalizeFunctionBody(e.functionBody);
      const eventsChanged = d.events !== e.events;

      if (bodyChanged) {
        await pool.query(d.createFunctionSQL);
      }

      if (eventsChanged) {
        const tableRef = `${quoteIdentifier(d.tableSchema)}.${quoteIdentifier(d.tableName)}`;
        await pool.query(`DROP TRIGGER IF EXISTS ${name} ON ${tableRef}`);
        await pool.query(d.createTriggerSQL);
      }

      if (bodyChanged || eventsChanged) {
        result.replaced.push(name);
      } else {
        result.unchanged.push(name);
      }
    }
  }

  // Orphan cleanup — triggers in DB but not in desired set
  for (const [name, e] of existingMap) {
    if (!desiredMap.has(name)) {
      const tableRef = `${quoteIdentifier(e.tableSchema)}.${quoteIdentifier(e.tableName)}`;
      await pool.query(`DROP TRIGGER IF EXISTS ${name} ON ${tableRef}`);
      // Drop per-table event functions, but NOT the shared subscription function
      if (e.functionName !== 'notify_change') {
        await pool.query(
          `DROP FUNCTION IF EXISTS ${quoteIdentifier(e.functionSchema)}.${quoteIdentifier(e.functionName)}()`,
        );
      }
      result.dropped.push(name);
      logger.info({ trigger: name, table: `${e.tableSchema}.${e.tableName}` }, 'Dropped orphaned trigger');
    }
  }

  return result;
}

// ─── Desired trigger builders ───────────────────────────────────────────────

/**
 * Build desired subscription triggers from tracked tables.
 */
export function buildDesiredSubscriptionTriggers(
  tables: TableInfo[],
): DesiredTrigger[] {
  const desired: DesiredTrigger[] = [];

  for (const table of tables) {
    if (table.isView) continue;
    const gen = generateSubscriptionTriggerSQL(table);

    desired.push({
      triggerName: gen.triggerName,
      tableSchema: table.schema,
      tableName: table.name,
      functionSchema: 'hakkyra',
      functionName: 'notify_change',
      events: gen.events,
      functionBody: SUBSCRIPTION_FUNCTION_BODY,
      createFunctionSQL: SUBSCRIPTION_FUNCTION_SQL,
      createTriggerSQL: gen.createTriggerSQL,
    });
  }

  return desired;
}

/**
 * Build desired event triggers from tables with event trigger configs.
 */
export function buildDesiredEventTriggers(
  tables: TableInfo[],
): DesiredTrigger[] {
  const desired: DesiredTrigger[] = [];

  for (const table of tables) {
    if (table.isView) continue;
    if (table.eventTriggers.length === 0) continue;

    const gen = generateEventTriggerSQL(table, table.eventTriggers);

    desired.push({
      triggerName: gen.triggerName,
      tableSchema: table.schema,
      tableName: table.name,
      functionSchema: gen.functionSchema,
      functionName: gen.functionName,
      events: gen.events,
      functionBody: gen.functionBody,
      createFunctionSQL: gen.createFunctionSQL,
      createTriggerSQL: gen.createTriggerSQL,
    });
  }

  return desired;
}
