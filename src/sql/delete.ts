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
import { AliasCounter, filterColumns, buildJsonFields } from './select.js';
import type { RelationshipSelection, ComputedFieldSelection } from './select.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DeleteByPkOptions {
  table: TableInfo;
  /** Primary key values: { pk_column: value } */
  pkValues: Record<string, unknown>;
  /** Columns to return in the response */
  returningColumns: string[];
  /** Relationships to include in the RETURNING clause */
  returningRelationships?: RelationshipSelection[];
  /** Computed fields to include in the RETURNING clause */
  returningComputedFields?: ComputedFieldSelection[];
  /** JSONB path arguments for RETURNING fields */
  returningJsonbPaths?: Map<string, string>;
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
  /** Relationships to include in the RETURNING clause */
  returningRelationships?: RelationshipSelection[];
  /** Computed fields to include in the RETURNING clause */
  returningComputedFields?: ComputedFieldSelection[];
  /** JSONB path arguments for RETURNING fields */
  returningJsonbPaths?: Map<string, string>;
  permission?: {
    filter: CompiledFilter;
  };
  session: SessionVariables;
}

// ─── Returning Fields Builder ────────────────────────────────────────────────

/**
 * Build json_build_object fields for the RETURNING clause, including
 * relationship subqueries when requested.
 */
function buildReturningFields(
  table: TableInfo,
  returningColumns: string[],
  alias: string,
  params: ParamCollector,
  session: SessionVariables,
  relationships?: RelationshipSelection[],
  jsonbPaths?: Map<string, string>,
  computedFields?: ComputedFieldSelection[],
): string {
  const tableColumnNames = new Set(table.columns.map((c) => c.name));
  const validReturning = returningColumns.filter((c) => tableColumnNames.has(c));

  const hasRelationships = relationships && relationships.length > 0;
  const hasJsonbPaths = jsonbPaths && jsonbPaths.size > 0;
  const hasComputedFields = computedFields && computedFields.length > 0;

  if (hasRelationships || hasJsonbPaths || hasComputedFields) {
    const columns = filterColumns(validReturning, table);
    const aliasCounter = new AliasCounter();
    return buildJsonFields(columns, alias, relationships, params, session, aliasCounter, computedFields, undefined, jsonbPaths);
  }

  return validReturning.map(
    (c) => `'${c}', ${quoteIdentifier(alias)}.${quoteIdentifier(c)}`,
  ).join(', ');
}

// ─── DELETE BY PK ────────────────────────────────────────────────────────────

/**
 * Compile a DELETE by primary key.
 * Returns the deleted row as json_build_object.
 *
 * When relationships are requested in RETURNING, uses a CTE pattern so
 * correlated subqueries can reference the deleted row's columns.
 *
 * IMPORTANT: For DELETE with relationships, the relationship subqueries read
 * from the live tables AFTER the delete has occurred. This means:
 * - Array relationships pointing TO the deleted row (e.g., child rows with FK
 *   to this row) will reflect post-delete state. If ON DELETE CASCADE is set,
 *   those child rows will already be deleted and return empty arrays.
 * - Array relationships FROM the deleted row (e.g., the deleted row references
 *   a parent) will still work since the parent is not deleted.
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
  const hasRelationships = opts.returningRelationships && opts.returningRelationships.length > 0;
  const hasJsonbPaths = opts.returningJsonbPaths && opts.returningJsonbPaths.size > 0;
  const hasComputedFields = opts.returningComputedFields && opts.returningComputedFields.length > 0;

  if (hasRelationships || hasJsonbPaths || hasComputedFields) {
    // Use CTE pattern so relationship subqueries / jsonb path extraction / computed fields can reference the deleted row
    const returningFields = buildReturningFields(
      opts.table,
      opts.returningColumns,
      '_deleted',
      params,
      opts.session,
      opts.returningRelationships,
      opts.returningJsonbPaths,
      opts.returningComputedFields,
    );

    const sql = [
      `WITH "_deleted" AS (`,
      `  DELETE FROM ${tableRef}`,
      whereClause ? `  ${whereClause}` : null,
      `  RETURNING *`,
      `)`,
      `SELECT json_build_object(${returningFields}) AS "data"`,
      `FROM "_deleted"`,
    ].filter(Boolean).join('\n');

    return { sql, params: params.getParams() };
  }

  // Simple delete without relationships — RETURNING references bare column names
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
  const deleteColumnLookup = new Map(opts.table.columns.map(c => [c.name, c]));
  const userWhere = compileWhere(opts.where, params, alias, opts.session, deleteColumnLookup);
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
  const hasRelationships = opts.returningRelationships && opts.returningRelationships.length > 0;
  const hasJsonbPaths = opts.returningJsonbPaths && opts.returningJsonbPaths.size > 0;
  const hasComputedFields2 = opts.returningComputedFields && opts.returningComputedFields.length > 0;

  if (validReturning.length > 0 || hasRelationships || hasJsonbPaths || hasComputedFields2) {
    // Use CTE to collect results as JSON array, with optional relationship subqueries, computed fields, and JSONB path extraction
    const returningFields = buildReturningFields(
      opts.table,
      opts.returningColumns,
      '_deleted',
      params,
      opts.session,
      opts.returningRelationships,
      opts.returningJsonbPaths,
      opts.returningComputedFields,
    );

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
