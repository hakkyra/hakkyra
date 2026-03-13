/**
 * SELECT query compiler.
 *
 * Compiles SELECT queries from table info, query arguments, and permissions.
 * Uses json_build_object() and json_agg() to shape results directly in SQL
 * to match the expected GraphQL response shape — no post-processing needed.
 */

import type {
  BoolExp,
  ColumnInfo,
  CompiledFilter,
  CompiledQuery,
  ComputedFieldConfig,
  FunctionInfo,
  RelationshipConfig,
  SessionVariables,
  TableInfo,
} from '../types.js';
import { ParamCollector, quoteIdentifier, quoteTableRef } from './utils.js';
import { compileWhere } from './where.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface OrderByItem {
  column: string;
  direction: 'asc' | 'desc';
  nulls?: 'first' | 'last';
}

export interface ComputedFieldSelection {
  config: ComputedFieldConfig;
  functionInfo: FunctionInfo;
}

export interface RelationshipSelection {
  relationship: RelationshipConfig;
  remoteTable: TableInfo;
  columns: string[];
  where?: BoolExp;
  orderBy?: OrderByItem[];
  limit?: number;
  offset?: number;
  relationships?: RelationshipSelection[];
  computedFields?: ComputedFieldSelection[];
  permission?: {
    filter: CompiledFilter;
    columns: string[] | '*';
    limit?: number;
  };
}

export interface AggregateSelection {
  count?: { columns?: string[]; distinct?: boolean };
  sum?: string[];
  avg?: string[];
  min?: string[];
  max?: string[];
}

export interface SelectOptions {
  table: TableInfo;
  columns: string[];
  where?: BoolExp;
  orderBy?: OrderByItem[];
  limit?: number;
  offset?: number;
  relationships?: RelationshipSelection[];
  computedFields?: ComputedFieldSelection[];
  permission?: {
    filter: CompiledFilter;
    columns: string[] | '*';
    limit?: number;
  };
  session: SessionVariables;
}

export interface SelectByPkOptions {
  table: TableInfo;
  pkValues: Record<string, unknown>;
  columns: string[];
  relationships?: RelationshipSelection[];
  computedFields?: ComputedFieldSelection[];
  permission?: {
    filter: CompiledFilter;
    columns: string[] | '*';
  };
  session: SessionVariables;
}

export interface SelectAggregateOptions {
  table: TableInfo;
  where?: BoolExp;
  aggregate: AggregateSelection;
  /** Optional: also return nodes (rows) alongside aggregates. */
  nodes?: {
    columns: string[];
    relationships?: RelationshipSelection[];
    orderBy?: OrderByItem[];
    limit?: number;
    offset?: number;
  };
  permission?: {
    filter: CompiledFilter;
    columns: string[] | '*';
    limit?: number;
  };
  session: SessionVariables;
}

// ─── Alias Counter ───────────────────────────────────────────────────────────

/** Thread-local alias counter for generating unique table aliases. */
class AliasCounter {
  private count = 0;

  next(): string {
    return `t${this.count++}`;
  }

  reset(): void {
    this.count = 0;
  }
}

// ─── Column Filtering ────────────────────────────────────────────────────────

/**
 * Filter requested columns against permitted columns.
 * Returns only columns that exist on the table AND are allowed by permissions.
 */
function filterColumns(
  requested: string[],
  table: TableInfo,
  permittedColumns?: string[] | '*',
): ColumnInfo[] {
  const tableColumnMap = new Map(table.columns.map((c) => [c.name, c]));

  return requested.filter((name) => {
    // Column must exist on the table
    if (!tableColumnMap.has(name)) return false;
    // If no permission restriction, allow all
    if (!permittedColumns) return true;
    // '*' means all columns allowed
    if (permittedColumns === '*') return true;
    return permittedColumns.includes(name);
  }).map((name) => tableColumnMap.get(name)!);
}

// ─── ORDER BY ────────────────────────────────────────────────────────────────

function compileOrderBy(orderBy: OrderByItem[], alias: string): string {
  if (orderBy.length === 0) return '';

  const parts = orderBy.map((item) => {
    let clause = `${quoteIdentifier(alias)}.${quoteIdentifier(item.column)} ${item.direction.toUpperCase()}`;
    if (item.nulls) {
      clause += ` NULLS ${item.nulls.toUpperCase()}`;
    }
    return clause;
  });

  return ` ORDER BY ${parts.join(', ')}`;
}

// ─── json_build_object Fields ────────────────────────────────────────────────

/**
 * Build the json_build_object argument list for selected columns, computed fields,
 * and relationships.
 */
function buildJsonFields(
  columns: ColumnInfo[],
  alias: string,
  relationships: RelationshipSelection[] | undefined,
  params: ParamCollector,
  session: SessionVariables,
  aliasCounter: AliasCounter,
  computedFields?: ComputedFieldSelection[],
): string {
  const fields: string[] = [];

  // Scalar columns
  for (const col of columns) {
    fields.push(`'${col.name}', ${quoteIdentifier(alias)}.${quoteIdentifier(col.name)}`);
  }

  // Computed fields — call PG function with table row as argument
  if (computedFields) {
    for (const cf of computedFields) {
      const fnSchema = cf.config.function.schema ?? 'public';
      const fnName = cf.config.function.name;
      const funcRef = `${quoteIdentifier(fnSchema)}.${quoteIdentifier(fnName)}`;
      fields.push(`'${cf.config.name}', ${funcRef}(${quoteIdentifier(alias)})`);
    }
  }

  // Relationship subqueries
  if (relationships) {
    for (const relSel of relationships) {
      const subquery = buildRelationshipSubquery(
        relSel,
        alias,
        params,
        session,
        aliasCounter,
      );
      fields.push(`'${relSel.relationship.name}', (${subquery})`);
    }
  }

  return fields.join(', ');
}

// ─── Relationship Subqueries ─────────────────────────────────────────────────

/**
 * Build a correlated subquery for a relationship.
 *
 * Object relationships: SELECT json_build_object(...)
 * Array relationships:  SELECT coalesce(json_agg(json_build_object(...)), '[]'::json)
 */
function buildRelationshipSubquery(
  relSel: RelationshipSelection,
  parentAlias: string,
  params: ParamCollector,
  session: SessionVariables,
  aliasCounter: AliasCounter,
): string {
  const rel = relSel.relationship;
  const remoteTable = relSel.remoteTable;
  const subAlias = aliasCounter.next();
  const tableRef = quoteTableRef(remoteTable.schema, remoteTable.name);

  // Filter columns for the sub-selection
  const subColumns = filterColumns(
    relSel.columns,
    remoteTable,
    relSel.permission?.columns,
  );

  // Build json_build_object fields (recursive — handles nested relationships)
  const jsonFields = buildJsonFields(
    subColumns,
    subAlias,
    relSel.relationships,
    params,
    session,
    aliasCounter,
    relSel.computedFields,
  );

  // Build the join condition from the relationship mapping
  const joinConditions = buildJoinConditions(rel, parentAlias, subAlias);

  // Additional WHERE clauses
  const whereParts: string[] = [...joinConditions];

  // User-provided filter on this relationship
  const userWhere = compileWhere(relSel.where, params, subAlias, session);
  if (userWhere) whereParts.push(userWhere);

  // Permission filter
  if (relSel.permission?.filter) {
    const permResult = relSel.permission.filter.toSQL(
      session,
      params.getOffset(),
      subAlias,
    );
    if (permResult.sql) {
      // Add permission params to our collector
      for (const p of permResult.params) {
        params.add(p);
      }
      whereParts.push(permResult.sql);
    }
  }

  const whereClause = whereParts.length > 0 ? ` WHERE ${whereParts.join(' AND ')}` : '';

  // ORDER BY
  const orderByClause = relSel.orderBy ? compileOrderBy(relSel.orderBy, subAlias) : '';

  // LIMIT / OFFSET
  let limitClause = '';
  // Apply the more restrictive limit (user vs permission)
  const effectiveLimit = resolveLimit(relSel.limit, relSel.permission?.limit);
  if (effectiveLimit !== undefined) {
    limitClause += ` LIMIT ${params.add(effectiveLimit)}`;
  }
  if (relSel.offset !== undefined) {
    limitClause += ` OFFSET ${params.add(relSel.offset)}`;
  }

  if (rel.type === 'object') {
    // Object relationship: single row, return json_build_object directly
    return `SELECT json_build_object(${jsonFields}) FROM ${tableRef} ${quoteIdentifier(subAlias)}${whereClause}${orderByClause} LIMIT 1`;
  }

  // Array relationship: return json_agg wrapped in coalesce
  // When LIMIT/OFFSET is used, we need a subquery to apply it before aggregation
  const hasLimitOffset = limitClause.length > 0;

  if (hasLimitOffset) {
    // Wrap in a subquery: first select with WHERE + ORDER BY + LIMIT, then aggregate
    const innerAlias = aliasCounter.next();
    const innerSelect = `SELECT json_build_object(${jsonFields}) AS "_row_" FROM ${tableRef} ${quoteIdentifier(subAlias)}${whereClause}${orderByClause}${limitClause}`;
    return `SELECT coalesce(json_agg(${quoteIdentifier(innerAlias)}."_row_"), '[]'::json) FROM (${innerSelect}) ${quoteIdentifier(innerAlias)}`;
  }

  // No LIMIT — use ORDER BY inside json_agg for efficiency
  return `SELECT coalesce(json_agg(json_build_object(${jsonFields})${orderByClause}), '[]'::json) FROM ${tableRef} ${quoteIdentifier(subAlias)}${whereClause}`;
}

/**
 * Build join conditions between parent and remote table based on relationship config.
 */
function buildJoinConditions(
  rel: RelationshipConfig,
  parentAlias: string,
  subAlias: string,
): string[] {
  const conditions: string[] = [];

  if (rel.columnMapping) {
    // Manual mapping: { localCol: remoteCol }
    for (const [localCol, remoteCol] of Object.entries(rel.columnMapping)) {
      conditions.push(
        `${quoteIdentifier(subAlias)}.${quoteIdentifier(remoteCol)} = ${quoteIdentifier(parentAlias)}.${quoteIdentifier(localCol)}`,
      );
    }
  } else if (rel.type === 'object' && rel.localColumns && rel.remoteColumns) {
    // Object relationship: FK is on this table, pointing to remote table's PK
    for (let i = 0; i < rel.localColumns.length; i++) {
      conditions.push(
        `${quoteIdentifier(subAlias)}.${quoteIdentifier(rel.remoteColumns[i])} = ${quoteIdentifier(parentAlias)}.${quoteIdentifier(rel.localColumns[i])}`,
      );
    }
  } else if (rel.type === 'array' && rel.remoteColumns && rel.localColumns) {
    // Array relationship: FK is on the remote table, pointing to this table's PK
    for (let i = 0; i < rel.remoteColumns.length; i++) {
      conditions.push(
        `${quoteIdentifier(subAlias)}.${quoteIdentifier(rel.remoteColumns[i])} = ${quoteIdentifier(parentAlias)}.${quoteIdentifier(rel.localColumns[i])}`,
      );
    }
  }

  return conditions;
}

// ─── Limit Resolution ────────────────────────────────────────────────────────

function resolveLimit(
  userLimit?: number,
  permLimit?: number,
): number | undefined {
  if (userLimit !== undefined && permLimit !== undefined) {
    return Math.min(userLimit, permLimit);
  }
  return userLimit ?? permLimit;
}

// ─── SELECT Compiler ─────────────────────────────────────────────────────────

/**
 * Compile a full SELECT query that returns JSON-shaped results.
 *
 * The outer query wraps results in json_agg(json_build_object(...)) so that
 * the response can be directly returned as the GraphQL "data" field.
 */
export function compileSelect(opts: SelectOptions): CompiledQuery {
  const params = new ParamCollector();
  const aliasCounter = new AliasCounter();
  const alias = aliasCounter.next(); // t0
  const tableRef = quoteTableRef(opts.table.schema, opts.table.name);

  // Filter columns against permissions
  const columns = filterColumns(
    opts.columns,
    opts.table,
    opts.permission?.columns,
  );

  // Build json_build_object fields
  const jsonFields = buildJsonFields(
    columns,
    alias,
    opts.relationships,
    params,
    opts.session,
    aliasCounter,
    opts.computedFields,
  );

  // Build WHERE clause
  const whereParts: string[] = [];

  // User-provided filter
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

  // ORDER BY
  const orderByClause = opts.orderBy ? compileOrderBy(opts.orderBy, alias) : '';

  // LIMIT / OFFSET
  let limitOffsetClause = '';
  const effectiveLimit = resolveLimit(opts.limit, opts.permission?.limit);
  if (effectiveLimit !== undefined) {
    limitOffsetClause += ` LIMIT ${params.add(effectiveLimit)}`;
  }
  if (opts.offset !== undefined) {
    limitOffsetClause += ` OFFSET ${params.add(opts.offset)}`;
  }

  // If ORDER BY or LIMIT is used, wrap in a subquery so the ordering/limiting
  // applies to the rows, then aggregate the result.
  let sql: string;
  if (orderByClause || limitOffsetClause) {
    const innerSql = [
      `SELECT ${jsonFields ? `json_build_object(${jsonFields}) AS "_row_"` : `${quoteIdentifier(alias)}.*`}`,
      `FROM ${tableRef} ${quoteIdentifier(alias)}`,
      whereClause ? whereClause.trim() : null,
      orderByClause ? orderByClause.trim() : null,
      limitOffsetClause ? limitOffsetClause.trim() : null,
    ].filter(Boolean).join('\n');
    sql = `SELECT coalesce(json_agg("_inner_"."_row_"), '[]'::json) AS "data" FROM (${innerSql}) "_inner_"`;
  } else {
    sql = [
      `SELECT coalesce(json_agg(json_build_object(${jsonFields})), '[]'::json) AS "data"`,
      `FROM ${tableRef} ${quoteIdentifier(alias)}`,
      whereClause ? whereClause.trim() : null,
    ].filter(Boolean).join('\n');
  }

  return { sql, params: params.getParams() };
}

// ─── SELECT BY PK ────────────────────────────────────────────────────────────

/**
 * Compile a SELECT query for a single row by primary key.
 * Returns a single json_build_object (not wrapped in json_agg).
 */
export function compileSelectByPk(opts: SelectByPkOptions): CompiledQuery {
  const params = new ParamCollector();
  const aliasCounter = new AliasCounter();
  const alias = aliasCounter.next(); // t0
  const tableRef = quoteTableRef(opts.table.schema, opts.table.name);

  // Filter columns against permissions
  const columns = filterColumns(
    opts.columns,
    opts.table,
    opts.permission?.columns,
  );

  // Build json_build_object fields
  const jsonFields = buildJsonFields(
    columns,
    alias,
    opts.relationships,
    params,
    opts.session,
    aliasCounter,
    opts.computedFields,
  );

  // Build WHERE for PK columns
  const whereParts: string[] = [];
  for (const [col, val] of Object.entries(opts.pkValues)) {
    whereParts.push(`${quoteIdentifier(alias)}.${quoteIdentifier(col)} = ${params.add(val)}`);
  }

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

  const sql = [
    `SELECT json_build_object(${jsonFields}) AS "data"`,
    `FROM ${tableRef} ${quoteIdentifier(alias)}`,
    whereClause ? whereClause.trim() : null,
    'LIMIT 1',
  ].filter(Boolean).join('\n');

  return { sql, params: params.getParams() };
}

// ─── SELECT AGGREGATE ────────────────────────────────────────────────────────

/**
 * Compile a SELECT aggregate query.
 * Returns aggregate results (count, sum, avg, min, max) and optionally nodes.
 */
export function compileSelectAggregate(opts: SelectAggregateOptions): CompiledQuery {
  const params = new ParamCollector();
  const aliasCounter = new AliasCounter();
  const alias = aliasCounter.next(); // t0
  const tableRef = quoteTableRef(opts.table.schema, opts.table.name);

  // Build WHERE clause
  const whereParts: string[] = [];

  const userWhere = compileWhere(opts.where, params, alias, opts.session);
  if (userWhere) whereParts.push(userWhere);

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

  // Build aggregate expressions
  const aggFields: string[] = [];
  const agg = opts.aggregate;

  if (agg.count !== undefined) {
    if (agg.count.columns && agg.count.columns.length > 0) {
      const colRefs = agg.count.columns.map(
        (c) => `${quoteIdentifier(alias)}.${quoteIdentifier(c)}`,
      ).join(', ');
      const distinct = agg.count.distinct ? 'DISTINCT ' : '';
      aggFields.push(`'count', count(${distinct}${colRefs})`);
    } else {
      aggFields.push(`'count', count(*)`);
    }
  }

  for (const fn of ['sum', 'avg', 'min', 'max'] as const) {
    const fieldCols = agg[fn];
    if (fieldCols && fieldCols.length > 0) {
      const fnFields = fieldCols.map(
        (c) => `'${c}', ${fn}(${quoteIdentifier(alias)}.${quoteIdentifier(c)})`,
      ).join(', ');
      aggFields.push(`'${fn}', json_build_object(${fnFields})`);
    }
  }

  // Build the main SELECT
  const selectParts: string[] = [];

  // Aggregate part
  if (aggFields.length > 0) {
    selectParts.push(`json_build_object(${aggFields.join(', ')}) AS "aggregate"`);
  }

  // Nodes part (optional)
  if (opts.nodes) {
    const nodeColumns = filterColumns(
      opts.nodes.columns,
      opts.table,
      opts.permission?.columns,
    );

    const jsonFields = buildJsonFields(
      nodeColumns,
      alias,
      opts.nodes.relationships,
      params,
      opts.session,
      aliasCounter,
    );

    // Nodes need their own subquery with ORDER BY / LIMIT
    const nodesOrderBy = opts.nodes.orderBy
      ? compileOrderBy(opts.nodes.orderBy, alias)
      : '';
    const effectiveLimit = resolveLimit(opts.nodes.limit, opts.permission?.limit);
    let nodesLimitOffset = '';
    if (effectiveLimit !== undefined) {
      nodesLimitOffset += ` LIMIT ${params.add(effectiveLimit)}`;
    }
    if (opts.nodes.offset !== undefined) {
      nodesLimitOffset += ` OFFSET ${params.add(opts.nodes.offset)}`;
    }

    // Use a subquery for nodes with potential different LIMIT
    const nodesSubquery = [
      `SELECT json_build_object(${jsonFields}) AS "_node_"`,
      `FROM ${tableRef} ${quoteIdentifier(alias)}`,
      whereClause ? whereClause.trim() : null,
      nodesOrderBy ? nodesOrderBy.trim() : null,
      nodesLimitOffset ? nodesLimitOffset.trim() : null,
    ].filter(Boolean).join('\n');

    selectParts.push(
      `(SELECT coalesce(json_agg("_nodes_"."_node_"), '[]'::json) FROM (${nodesSubquery}) "_nodes_") AS "nodes"`,
    );
  }

  // For the aggregate, we query from the filtered set
  const sql = [
    `SELECT ${selectParts.join(', ')}`,
    `FROM ${tableRef} ${quoteIdentifier(alias)}`,
    whereClause ? whereClause.trim() : null,
  ].filter(Boolean).join('\n');

  return { sql, params: params.getParams() };
}
