/**
 * DELETE query compiler.
 *
 * Compiles DELETE queries with:
 * - Permission filter as additional WHERE clause
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

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DeleteByPkOptions {
  table: TableInfo;
  /** Primary key values: { pk_column: value } */
  pkValues: Record<string, unknown>;
  /** Columns to return in the response */
  returningColumns: string[];
  permission?: {
    filter: CompiledFilter;
  };
  session: SessionVariables;
}

export interface DeleteOptions {
  table: TableInfo;
  /** WHERE clause for selecting rows to delete */
  where: BoolExp;
  /** Columns to return in the response */
  returningColumns: string[];
  permission?: {
    filter: CompiledFilter;
  };
  session: SessionVariables;
}

// ─── DELETE BY PK ────────────────────────────────────────────────────────────

/**
 * Compile a DELETE by primary key.
 * Returns the deleted row as json_build_object.
 */
export function compileDeleteByPk(opts: DeleteByPkOptions): CompiledQuery {
  const params = new ParamCollector();
  const tableRef = quoteTableRef(opts.table.schema, opts.table.name);

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

  const whereClause = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';

  // Build RETURNING
  const tableColumnNames = new Set(opts.table.columns.map((c) => c.name));
  const validReturning = opts.returningColumns.filter((c) => tableColumnNames.has(c));

  const returningFields = validReturning.map(
    (c) => `'${c}', ${quoteIdentifier(c)}`,
  ).join(', ');

  const returningClause = validReturning.length > 0
    ? `\nRETURNING json_build_object(${returningFields}) AS "data"`
    : '';

  const sql = [
    `DELETE FROM ${tableRef}`,
    whereClause ? whereClause : null,
  ].filter(Boolean).join('\n') + returningClause;

  return { sql, params: params.getParams() };
}

// ─── BULK DELETE ─────────────────────────────────────────────────────────────

/**
 * Compile a DELETE with a WHERE clause (affects multiple rows).
 * Returns deleted rows as json_agg(json_build_object(...)).
 */
export function compileDelete(opts: DeleteOptions): CompiledQuery {
  const params = new ParamCollector();
  const tableRef = quoteTableRef(opts.table.schema, opts.table.name);
  const alias = '_t0';

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

  const whereClause = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';

  // Build RETURNING
  const tableColumnNames = new Set(opts.table.columns.map((c) => c.name));
  const validReturning = opts.returningColumns.filter((c) => tableColumnNames.has(c));

  // For bulk delete, we use a CTE to collect results as JSON array
  const returningFields = validReturning.map(
    (c) => `'${c}', "_deleted".${quoteIdentifier(c)}`,
  ).join(', ');

  if (validReturning.length > 0) {
    const sql = [
      `WITH "_deleted" AS (`,
      `  DELETE FROM ${tableRef} AS ${quoteIdentifier(alias)}`,
      whereClause ? `  ${whereClause}` : null,
      `  RETURNING *`,
      `)`,
      `SELECT coalesce(json_agg(json_build_object(${returningFields})), '[]'::json) AS "data"`,
      `FROM "_deleted"`,
    ].filter(Boolean).join('\n');

    return { sql, params: params.getParams() };
  }

  // No returning columns — simple delete
  const sql = [
    `DELETE FROM ${tableRef} AS ${quoteIdentifier(alias)}`,
    whereClause ? whereClause : null,
  ].filter(Boolean).join('\n');

  return { sql, params: params.getParams() };
}
