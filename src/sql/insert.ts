/**
 * INSERT query compiler.
 *
 * Compiles INSERT queries with:
 * - Column permission enforcement (reject disallowed columns)
 * - Column presets (inject session-variable-based default values)
 * - Post-insert check constraints via CTE validation
 * - RETURNING clause shaped as json_build_object for GraphQL response
 */

import type {
  BoolExp,
  CompiledFilter,
  CompiledQuery,
  SessionVariables,
  TableInfo,
} from '../types.js';
import { ParamCollector, quoteIdentifier, quoteTableRef } from './utils.js';
import { compileWhere } from './where.js';
import { AliasCounter, filterColumns, buildJsonFields } from './select.js';
import type { RelationshipSelection } from './select.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface InsertOneOptions {
  table: TableInfo;
  /** The object to insert: { column_name: value } */
  object: Record<string, unknown>;
  /** Columns to return in the response */
  returningColumns: string[];
  /** Relationships to include in the RETURNING clause */
  returningRelationships?: RelationshipSelection[];
  /** Conflict handling */
  onConflict?: OnConflictClause;
  permission?: {
    check: CompiledFilter;
    columns: string[] | '*';
    presets?: Record<string, string>;
  };
  session: SessionVariables;
}

export interface InsertOptions {
  table: TableInfo;
  /** Array of objects to insert */
  objects: Record<string, unknown>[];
  /** Columns to return in the response */
  returningColumns: string[];
  /** Relationships to include in the RETURNING clause */
  returningRelationships?: RelationshipSelection[];
  /** Conflict handling */
  onConflict?: OnConflictClause;
  permission?: {
    check: CompiledFilter;
    columns: string[] | '*';
    presets?: Record<string, string>;
  };
  session: SessionVariables;
}

export interface OnConflictClause {
  constraint: string;
  updateColumns: string[];
  where?: BoolExp;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Resolve a preset value. If it's a session variable reference (x-hasura-*),
 * resolve it from the session. Otherwise use the literal value.
 */
function resolvePreset(value: string, session: SessionVariables): unknown {
  const lower = value.toLowerCase();
  if (!lower.startsWith('x-hasura-')) return value;

  if (lower === 'x-hasura-role') return session.role;
  if (lower === 'x-hasura-user-id') return session.userId;

  const claimKey = lower.slice('x-hasura-'.length);
  if (session.claims) {
    if (claimKey in session.claims) return session.claims[claimKey];
    for (const [k, v] of Object.entries(session.claims)) {
      if (k.toLowerCase() === claimKey) return v;
    }
  }

  return undefined;
}

/**
 * Filter columns based on permission and apply presets.
 * Returns the final column-value pairs for the INSERT.
 */
function prepareInsertData(
  obj: Record<string, unknown>,
  table: TableInfo,
  permission: InsertOneOptions['permission'],
  session: SessionVariables,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const tableColumnNames = new Set(table.columns.map((c) => c.name));
  const allowedColumns = permission?.columns;

  // Add user-provided columns (filtered by permissions)
  for (const [col, val] of Object.entries(obj)) {
    if (!tableColumnNames.has(col)) continue; // skip unknown columns
    if (allowedColumns && allowedColumns !== '*' && !allowedColumns.includes(col)) {
      throw new Error(`Column "${col}" is not allowed for insert on table "${table.schema}"."${table.name}"`);
    }
    result[col] = val;
  }

  // Apply presets (override user values)
  if (permission?.presets) {
    for (const [col, presetValue] of Object.entries(permission.presets)) {
      result[col] = resolvePreset(presetValue, session);
    }
  }

  return result;
}

// ─── ON CONFLICT Clause Builder ───────────────────────────────────────────────

/**
 * Build the ON CONFLICT SQL fragment from an OnConflictClause.
 * Handles DO UPDATE SET ... WHERE ... and DO NOTHING.
 */
function buildOnConflictSQL(
  oc: OnConflictClause,
  params: ParamCollector,
  table: TableInfo,
  session: SessionVariables,
): string {
  const constraintRef = quoteIdentifier(oc.constraint);

  if (oc.updateColumns.length === 0) {
    return `\nON CONFLICT ON CONSTRAINT ${constraintRef} DO NOTHING`;
  }

  const updates = oc.updateColumns.map(
    (c) => `${quoteIdentifier(c)} = EXCLUDED.${quoteIdentifier(c)}`,
  ).join(', ');

  let whereClause = '';
  if (oc.where) {
    // Compile the where clause — use the table name as alias since DO UPDATE
    // SET ... WHERE references the target table columns directly
    const whereSQL = compileWhere(oc.where, params, table.name, session);
    if (whereSQL) {
      whereClause = ` WHERE ${whereSQL}`;
    }
  }

  return `\nON CONFLICT ON CONSTRAINT ${constraintRef} DO UPDATE SET ${updates}${whereClause}`;
}

// ─── Returning Fields Builder ────────────────────────────────────────────────

/**
 * Build json_build_object fields for the RETURNING clause, including
 * relationship subqueries when requested.
 *
 * When relationships are present, uses buildJsonFields from the SELECT compiler
 * to generate correlated subqueries alongside scalar column fields.
 */
function buildReturningFields(
  table: TableInfo,
  returningColumns: string[],
  alias: string,
  params: ParamCollector,
  session: SessionVariables,
  relationships?: RelationshipSelection[],
): string {
  const tableColumnNames = new Set(table.columns.map((c) => c.name));
  const validReturning = returningColumns.filter((c) => tableColumnNames.has(c));

  if (relationships && relationships.length > 0) {
    // Use buildJsonFields from SELECT compiler — it handles both scalar columns
    // and relationship subqueries in one pass
    const columns = filterColumns(validReturning, table);
    const aliasCounter = new AliasCounter();
    return buildJsonFields(columns, alias, relationships, params, session, aliasCounter);
  }

  // No relationships — simple column list
  return validReturning.map(
    (c) => `'${c}', ${quoteIdentifier(alias)}.${quoteIdentifier(c)}`,
  ).join(', ');
}

// ─── INSERT ONE ──────────────────────────────────────────────────────────────

/**
 * Compile an INSERT for a single row.
 *
 * If a permission check is provided, uses a CTE pattern:
 *   WITH "_inserted" AS (INSERT ... RETURNING *)
 *   SELECT ... FROM "_inserted"
 *   WHERE <check_condition>
 *
 * If the check fails (no rows returned), the caller should raise a permission error.
 */
export function compileInsertOne(opts: InsertOneOptions): CompiledQuery {
  const params = new ParamCollector();
  const tableRef = quoteTableRef(opts.table.schema, opts.table.name);

  // Prepare data with permissions and presets
  const data = prepareInsertData(opts.object, opts.table, opts.permission, opts.session);

  const columnNames = Object.keys(data);
  if (columnNames.length === 0) {
    throw new Error(`No columns to insert into "${opts.table.schema}"."${opts.table.name}"`);
  }

  const quotedColumns = columnNames.map(quoteIdentifier).join(', ');
  const valuePlaceholders = columnNames.map((col) => params.add(data[col])).join(', ');

  // Build ON CONFLICT clause
  const onConflictClause = opts.onConflict
    ? buildOnConflictSQL(opts.onConflict, params, opts.table, opts.session)
    : '';

  const hasRelationships = opts.returningRelationships && opts.returningRelationships.length > 0;

  // Check if we need a CTE (permission check OR relationships in RETURNING)
  if (opts.permission?.check || hasRelationships) {
    // Build RETURNING fields with potential relationship subqueries
    const returningFields = buildReturningFields(
      opts.table,
      opts.returningColumns,
      '_inserted',
      params,
      opts.session,
      opts.returningRelationships,
    );

    let checkWhere = '';
    if (opts.permission?.check) {
      const checkResult = opts.permission.check.toSQL(
        opts.session,
        params.getOffset(),
        '_inserted',
      );
      // Add check params
      for (const p of checkResult.params) {
        params.add(p);
      }
      checkWhere = checkResult.sql ? ` WHERE ${checkResult.sql}` : '';
    }

    const sql = [
      `WITH "_inserted" AS (`,
      `  INSERT INTO ${tableRef} (${quotedColumns})`,
      `  VALUES (${valuePlaceholders})${onConflictClause}`,
      `  RETURNING *`,
      `)`,
      `SELECT json_build_object(${returningFields}) AS "data"`,
      `FROM "_inserted"`,
      checkWhere ? checkWhere : null,
    ].filter(Boolean).join('\n');

    return { sql, params: params.getParams() };
  }

  // Simple insert without check or relationships — RETURNING references bare column names
  const tableColumnNames = new Set(opts.table.columns.map((c) => c.name));
  const validReturning = opts.returningColumns.filter((c) => tableColumnNames.has(c));
  const simpleReturningFields = validReturning.map(
    (c) => `'${c}', ${quoteIdentifier(c)}`,
  ).join(', ');
  const returningClause = validReturning.length > 0
    ? `\nRETURNING json_build_object(${simpleReturningFields}) AS "data"`
    : '';

  const sql = [
    `INSERT INTO ${tableRef} (${quotedColumns})`,
    `VALUES (${valuePlaceholders})`,
  ].join('\n') + onConflictClause + returningClause;

  return { sql, params: params.getParams() };
}

// ─── BULK INSERT ─────────────────────────────────────────────────────────────

/**
 * Compile a bulk INSERT for multiple rows.
 *
 * All objects must be normalized to the same column set (union of all keys).
 * Missing columns are filled with DEFAULT.
 */
export function compileInsert(opts: InsertOptions): CompiledQuery {
  const params = new ParamCollector();
  const tableRef = quoteTableRef(opts.table.schema, opts.table.name);

  if (opts.objects.length === 0) {
    throw new Error(`No objects to insert into "${opts.table.schema}"."${opts.table.name}"`);
  }

  // Prepare all objects
  const preparedObjects = opts.objects.map((obj) =>
    prepareInsertData(obj, opts.table, opts.permission, opts.session),
  );

  // Collect the union of all column names (order matters for consistency)
  const columnSet = new Set<string>();
  for (const obj of preparedObjects) {
    for (const col of Object.keys(obj)) {
      columnSet.add(col);
    }
  }
  const columnNames = [...columnSet];

  if (columnNames.length === 0) {
    throw new Error(`No columns to insert into "${opts.table.schema}"."${opts.table.name}"`);
  }

  const quotedColumns = columnNames.map(quoteIdentifier).join(', ');

  // Build VALUES rows
  const valueRows = preparedObjects.map((obj) => {
    const values = columnNames.map((col) => {
      if (col in obj) {
        return params.add(obj[col]);
      }
      return 'DEFAULT';
    });
    return `(${values.join(', ')})`;
  });

  // Build ON CONFLICT clause
  const onConflictClause = opts.onConflict
    ? buildOnConflictSQL(opts.onConflict, params, opts.table, opts.session)
    : '';

  const hasRelationships = opts.returningRelationships && opts.returningRelationships.length > 0;

  // Check if we need a CTE (permission check OR relationships in RETURNING)
  if (opts.permission?.check || hasRelationships) {
    const returningFields = buildReturningFields(
      opts.table,
      opts.returningColumns,
      '_inserted',
      params,
      opts.session,
      opts.returningRelationships,
    );

    let checkWhere = '';
    if (opts.permission?.check) {
      const checkResult = opts.permission.check.toSQL(
        opts.session,
        params.getOffset(),
        '_inserted',
      );
      for (const p of checkResult.params) {
        params.add(p);
      }
      checkWhere = checkResult.sql ? ` WHERE ${checkResult.sql}` : '';
    }

    const sql = [
      `WITH "_inserted" AS (`,
      `  INSERT INTO ${tableRef} (${quotedColumns})`,
      `  VALUES ${valueRows.join(',\n  ')}${onConflictClause}`,
      `  RETURNING *`,
      `)`,
      `SELECT coalesce(json_agg(json_build_object(${returningFields})), '[]'::json) AS "data"`,
      `FROM "_inserted"`,
      checkWhere ? checkWhere : null,
    ].filter(Boolean).join('\n');

    return { sql, params: params.getParams() };
  }

  // Simple bulk insert without check or relationships
  const tableColumnNames = new Set(opts.table.columns.map((c) => c.name));
  const validReturning = opts.returningColumns.filter((c) => tableColumnNames.has(c));
  const simpleReturningFields = validReturning.map(
    (c) => `'${c}', ${quoteIdentifier(c)}`,
  ).join(', ');

  const returningClause = validReturning.length > 0
    ? `\nRETURNING json_build_object(${simpleReturningFields}) AS "data"`
    : '';

  const sql = [
    `INSERT INTO ${tableRef} (${quotedColumns})`,
    `VALUES ${valueRows.join(',\n')}`,
  ].join('\n') + onConflictClause + returningClause;

  return { sql, params: params.getParams() };
}
