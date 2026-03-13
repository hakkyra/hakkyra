/**
 * UPDATE query compiler.
 *
 * Compiles UPDATE queries with:
 * - Column permission enforcement
 * - Column presets (session-variable-based values injected automatically)
 * - Permission filter as additional WHERE clause
 * - Post-update check constraint validation via CTE
 * - RETURNING clause shaped as json_build_object
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

// ─── Types ───────────────────────────────────────────────────────────────────

export interface UpdateByPkOptions {
  table: TableInfo;
  /** Primary key values: { pk_column: value } */
  pkValues: Record<string, unknown>;
  /** Fields to update: { column: newValue } */
  _set: Record<string, unknown>;
  /** Columns to return in the response */
  returningColumns: string[];
  permission?: {
    filter: CompiledFilter;
    check?: CompiledFilter;
    columns: string[] | '*';
    presets?: Record<string, string>;
  };
  session: SessionVariables;
}

export interface UpdateOptions {
  table: TableInfo;
  /** WHERE clause for selecting rows to update */
  where: BoolExp;
  /** Fields to update: { column: newValue } */
  _set: Record<string, unknown>;
  /** Columns to return in the response */
  returningColumns: string[];
  permission?: {
    filter: CompiledFilter;
    check?: CompiledFilter;
    columns: string[] | '*';
    presets?: Record<string, string>;
  };
  session: SessionVariables;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Resolve a preset value from session variables.
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
 * Build the SET clause: validate columns, apply presets, parameterize values.
 */
function buildSetClause(
  _set: Record<string, unknown>,
  table: TableInfo,
  params: ParamCollector,
  permission: UpdateByPkOptions['permission'],
  session: SessionVariables,
): string {
  const tableColumnNames = new Set(table.columns.map((c) => c.name));
  const allowedColumns = permission?.columns;
  const assignments: string[] = [];

  // User-provided SET values
  for (const [col, val] of Object.entries(_set)) {
    if (!tableColumnNames.has(col)) continue;
    if (allowedColumns && allowedColumns !== '*' && !allowedColumns.includes(col)) {
      throw new Error(
        `Column "${col}" is not allowed for update on table "${table.schema}"."${table.name}"`,
      );
    }
    assignments.push(`${quoteIdentifier(col)} = ${params.add(val)}`);
  }

  // Apply presets (override user values)
  if (permission?.presets) {
    for (const [col, presetValue] of Object.entries(permission.presets)) {
      const resolved = resolvePreset(presetValue, session);
      // Remove any existing assignment for this column (preset overrides)
      const existingIdx = assignments.findIndex((a) =>
        a.startsWith(quoteIdentifier(col) + ' = '),
      );
      const assignment = `${quoteIdentifier(col)} = ${params.add(resolved)}`;
      if (existingIdx >= 0) {
        assignments[existingIdx] = assignment;
      } else {
        assignments.push(assignment);
      }
    }
  }

  if (assignments.length === 0) {
    throw new Error(
      `No columns to update on "${table.schema}"."${table.name}"`,
    );
  }

  return assignments.join(', ');
}

// ─── UPDATE BY PK ────────────────────────────────────────────────────────────

/**
 * Compile an UPDATE by primary key.
 *
 * If a post-update check is provided, uses a CTE pattern:
 *   WITH "_updated" AS (UPDATE ... RETURNING *)
 *   SELECT ... FROM "_updated" WHERE <check_condition>
 */
export function compileUpdateByPk(opts: UpdateByPkOptions): CompiledQuery {
  const params = new ParamCollector();
  const tableRef = quoteTableRef(opts.table.schema, opts.table.name);

  // Build SET clause
  const setClause = buildSetClause(
    opts._set,
    opts.table,
    params,
    opts.permission,
    opts.session,
  );

  // Build WHERE for PK
  const whereParts: string[] = [];
  for (const [col, val] of Object.entries(opts.pkValues)) {
    whereParts.push(`${quoteIdentifier(col)} = ${params.add(val)}`);
  }

  // Permission filter
  if (opts.permission?.filter) {
    const permResult = opts.permission.filter.toSQL(
      opts.session,
      params.getOffset(),
    );
    if (permResult.sql) {
      for (const p of permResult.params) {
        params.add(p);
      }
      whereParts.push(permResult.sql);
    }
  }

  const whereClause = whereParts.length > 0 ? ` WHERE ${whereParts.join(' AND ')}` : '';

  // Build RETURNING
  const tableColumnNames = new Set(opts.table.columns.map((c) => c.name));
  const validReturning = opts.returningColumns.filter((c) => tableColumnNames.has(c));

  // Post-update check via CTE
  if (opts.permission?.check) {
    const returningFields = validReturning.map(
      (c) => `'${c}', "_updated".${quoteIdentifier(c)}`,
    ).join(', ');

    const checkResult = opts.permission.check.toSQL(
      opts.session,
      params.getOffset(),
      '_updated',
    );
    for (const p of checkResult.params) {
      params.add(p);
    }

    const checkWhere = checkResult.sql ? ` WHERE ${checkResult.sql}` : '';

    const sql = [
      `WITH "_updated" AS (`,
      `  UPDATE ${tableRef}`,
      `  SET ${setClause}`,
      `  ${whereClause.trim()}`,
      `  RETURNING *`,
      `)`,
      `SELECT json_build_object(${returningFields}) AS "data"`,
      `FROM "_updated"`,
      checkWhere ? checkWhere : null,
    ].filter(Boolean).join('\n');

    return { sql, params: params.getParams() };
  }

  // Simple update without post-check
  const simpleReturningFields = validReturning.map(
    (c) => `'${c}', ${quoteIdentifier(c)}`,
  ).join(', ');

  const returningClause = validReturning.length > 0
    ? `\nRETURNING json_build_object(${simpleReturningFields}) AS "data"`
    : '';

  const sql = [
    `UPDATE ${tableRef}`,
    `SET ${setClause}`,
    whereClause ? whereClause.trim() : null,
  ].filter(Boolean).join('\n') + returningClause;

  return { sql, params: params.getParams() };
}

// ─── BULK UPDATE ─────────────────────────────────────────────────────────────

/**
 * Compile an UPDATE with a WHERE clause (affects multiple rows).
 */
export function compileUpdate(opts: UpdateOptions): CompiledQuery {
  const params = new ParamCollector();
  const tableRef = quoteTableRef(opts.table.schema, opts.table.name);
  const alias = '_t0';

  // Build SET clause
  const setClause = buildSetClause(
    opts._set,
    opts.table,
    params,
    opts.permission,
    opts.session,
  );

  // Build WHERE clause
  const whereParts: string[] = [];

  // User-provided WHERE
  const userWhere = compileWhere(opts.where, params, alias, opts.session);
  if (userWhere) whereParts.push(userWhere);

  // Permission filter
  if (opts.permission?.filter) {
    const permResult = opts.permission.filter.toSQL(
      opts.session,
      params.getOffset(),
      alias,
    );
    if (permResult.sql) {
      for (const p of permResult.params) {
        params.add(p);
      }
      whereParts.push(permResult.sql);
    }
  }

  const whereClause = whereParts.length > 0 ? ` WHERE ${whereParts.join(' AND ')}` : '';

  // Build RETURNING
  const tableColumnNames = new Set(opts.table.columns.map((c) => c.name));
  const validReturning = opts.returningColumns.filter((c) => tableColumnNames.has(c));

  // Post-update check via CTE
  if (opts.permission?.check) {
    const returningFields = validReturning.map(
      (c) => `'${c}', "_updated".${quoteIdentifier(c)}`,
    ).join(', ');

    const checkResult = opts.permission.check.toSQL(
      opts.session,
      params.getOffset(),
      '_updated',
    );
    for (const p of checkResult.params) {
      params.add(p);
    }

    const checkWhere = checkResult.sql ? ` WHERE ${checkResult.sql}` : '';

    const sql = [
      `WITH "_updated" AS (`,
      `  UPDATE ${tableRef} AS ${quoteIdentifier(alias)}`,
      `  SET ${setClause}`,
      `  ${whereClause.trim()}`,
      `  RETURNING *`,
      `)`,
      `SELECT coalesce(json_agg(json_build_object(${returningFields})), '[]'::json) AS "data"`,
      `FROM "_updated"`,
      checkWhere ? checkWhere : null,
    ].filter(Boolean).join('\n');

    return { sql, params: params.getParams() };
  }

  // Simple update without post-check
  const simpleReturningFields = validReturning.map(
    (c) => `'${c}', ${quoteIdentifier(c)}`,
  ).join(', ');

  const returningClause = validReturning.length > 0
    ? `\nRETURNING json_build_object(${simpleReturningFields}) AS "data"`
    : '';

  const sql = [
    `UPDATE ${tableRef} AS ${quoteIdentifier(alias)}`,
    `SET ${setClause}`,
    whereClause ? whereClause.trim() : null,
  ].filter(Boolean).join('\n') + returningClause;

  return { sql, params: params.getParams() };
}
