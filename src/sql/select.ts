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
import { shouldCastToText } from '../introspection/type-map.js';
import { toCamelCase } from '../shared/naming.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface OrderByItem {
  column: string;
  direction: 'asc' | 'desc';
  nulls?: 'first' | 'last';
  /** For object relationship ordering: nested order item on the related table */
  relationship?: {
    config: RelationshipConfig;
    remoteTable: TableInfo;
    orderByItem: OrderByItem;
  };
  /** For array relationship aggregate ordering */
  aggregate?: {
    config: RelationshipConfig;
    remoteTable: TableInfo;
    function: 'count' | 'avg' | 'max' | 'min' | 'sum' | 'stddev' | 'stddev_pop' | 'stddev_samp' | 'var_pop' | 'var_samp' | 'variance';
    column?: string; // undefined for count
  };
  /** For computed field ordering: emit function call instead of column ref */
  computedField?: {
    functionName: string;
    schema: string;
  };
}

export interface ComputedFieldSelection {
  config: ComputedFieldConfig;
  functionInfo: FunctionInfo;
  /** When set, the session variables are injected as a JSON parameter to this named argument. */
  sessionArgument?: string;
  /** User-provided extra arguments (beyond the table row), keyed by snake_case arg name. */
  args?: Map<string, unknown>;
}

export interface SetReturningComputedFieldSelection {
  config: ComputedFieldConfig;
  functionInfo: FunctionInfo;
  remoteTable: TableInfo;
  columns: string[];
  where?: BoolExp;
  orderBy?: OrderByItem[];
  limit?: number;
  offset?: number;
  relationships?: RelationshipSelection[];
  computedFields?: ComputedFieldSelection[];
  setReturningComputedFields?: SetReturningComputedFieldSelection[];
  /** JSONB path arguments: snake_case column name → dot-separated path string */
  jsonbPaths?: Map<string, string>;
  permission?: {
    filter: CompiledFilter;
    columns: string[] | '*';
    limit?: number;
  };
}

export interface RelationshipSelection {
  relationship: RelationshipConfig;
  /** camelCase field name for the JSON key (defaults to relationship.name) */
  fieldName?: string;
  remoteTable: TableInfo;
  columns: string[];
  distinctOn?: string[];
  where?: BoolExp;
  orderBy?: OrderByItem[];
  limit?: number;
  offset?: number;
  relationships?: RelationshipSelection[];
  computedFields?: ComputedFieldSelection[];
  setReturningComputedFields?: SetReturningComputedFieldSelection[];
  /** JSONB path arguments: snake_case column name → dot-separated path string */
  jsonbPaths?: Map<string, string>;
  permission?: {
    filter: CompiledFilter;
    columns: string[] | '*';
    limit?: number;
  };
}

export interface AggregateRelationshipSelection {
  relationship: RelationshipConfig;
  /** camelCase field name for the JSON key */
  fieldName: string;
  remoteTable: TableInfo;
  aggregate: AggregateSelection;
  where?: BoolExp;
  permission?: {
    filter: CompiledFilter;
    columns: string[] | '*';
    limit?: number;
  };
  session: SessionVariables;
}

export interface AggregateComputedFieldRef {
  /** snake_case computed field name (used as JSON key in output) */
  name: string;
  functionName: string;
  schema: string;
}

export interface AggregateSelection {
  count?: { columns?: string[]; distinct?: boolean };
  sum?: string[];
  avg?: string[];
  min?: string[];
  max?: string[];
  stddev?: string[];
  stddevPop?: string[];
  stddevSamp?: string[];
  variance?: string[];
  varPop?: string[];
  varSamp?: string[];
  /** Computed fields to include in aggregate functions (sum, avg, etc.) */
  computedFields?: {
    sum?: AggregateComputedFieldRef[];
    avg?: AggregateComputedFieldRef[];
    min?: AggregateComputedFieldRef[];
    max?: AggregateComputedFieldRef[];
    stddev?: AggregateComputedFieldRef[];
    stddevPop?: AggregateComputedFieldRef[];
    stddevSamp?: AggregateComputedFieldRef[];
    variance?: AggregateComputedFieldRef[];
    varPop?: AggregateComputedFieldRef[];
    varSamp?: AggregateComputedFieldRef[];
  };
}

export interface SelectOptions {
  table: TableInfo;
  columns: string[];
  where?: BoolExp;
  orderBy?: OrderByItem[];
  distinctOn?: string[];
  limit?: number;
  offset?: number;
  relationships?: RelationshipSelection[];
  aggregateRelationships?: AggregateRelationshipSelection[];
  computedFields?: ComputedFieldSelection[];
  setReturningComputedFields?: SetReturningComputedFieldSelection[];
  /** JSONB path arguments: snake_case column name → dot-separated path string */
  jsonbPaths?: Map<string, string>;
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
  aggregateRelationships?: AggregateRelationshipSelection[];
  computedFields?: ComputedFieldSelection[];
  setReturningComputedFields?: SetReturningComputedFieldSelection[];
  /** JSONB path arguments: snake_case column name → dot-separated path string */
  jsonbPaths?: Map<string, string>;
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
  /** Optional: GROUP BY columns for grouped aggregates. */
  groupBy?: string[];
  permission?: {
    filter: CompiledFilter;
    columns: string[] | '*';
    limit?: number;
  };
  session: SessionVariables;
}

// ─── Alias Counter ───────────────────────────────────────────────────────────

/** Thread-local alias counter for generating unique table aliases. */
export class AliasCounter {
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
export function filterColumns(
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

/**
 * Flatten a nested object-relationship OrderByItem into the leaf column,
 * collecting the chain of relationships along the way.
 */
function flattenRelationshipOrderBy(
  item: OrderByItem,
): { chain: Array<{ config: RelationshipConfig; remoteTable: TableInfo }>; leaf: OrderByItem } {
  const chain: Array<{ config: RelationshipConfig; remoteTable: TableInfo }> = [];
  let current = item;
  while (current.relationship) {
    chain.push({ config: current.relationship.config, remoteTable: current.relationship.remoteTable });
    current = current.relationship.orderByItem;
  }
  return { chain, leaf: current };
}

/**
 * Build the LEFT JOIN clauses needed for object-relationship ordering.
 * Returns the JOIN SQL fragments and a mapping from chain signature to alias.
 */
function buildOrderByJoins(
  orderBy: OrderByItem[],
  parentAlias: string,
  aliasCounter: AliasCounter,
): { joinSql: string; joinAliases: Map<string, string> } {
  const joinAliases = new Map<string, string>();
  const joinParts: string[] = [];

  for (const item of orderBy) {
    if (!item.relationship) continue;

    const { chain } = flattenRelationshipOrderBy(item);
    let currentAlias = parentAlias;
    let pathKey = '';

    for (const link of chain) {
      const rel = link.config;
      const remote = link.remoteTable;
      pathKey += `/${rel.name}`;

      if (joinAliases.has(pathKey)) {
        currentAlias = joinAliases.get(pathKey)!;
        continue;
      }

      const joinAlias = aliasCounter.next();
      joinAliases.set(pathKey, joinAlias);

      const tableRef = quoteTableRef(remote.schema, remote.name);
      const conditions = buildJoinConditions(rel, currentAlias, joinAlias);
      joinParts.push(`LEFT JOIN ${tableRef} ${quoteIdentifier(joinAlias)} ON ${conditions.join(' AND ')}`);

      currentAlias = joinAlias;
    }
  }

  return { joinSql: joinParts.join(' '), joinAliases };
}

/**
 * Build a correlated subquery expression for aggregate ordering.
 */
function buildAggregateOrderExpr(
  item: OrderByItem,
  parentAlias: string,
  aliasCounter: AliasCounter,
): string {
  const agg = item.aggregate!;
  const rel = agg.config;
  const remote = agg.remoteTable;
  const subAlias = aliasCounter.next();
  const tableRef = quoteTableRef(remote.schema, remote.name);

  // Build join conditions for the correlated subquery
  const conditions = buildJoinConditions(rel, parentAlias, subAlias);
  const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';

  if (agg.function === 'count') {
    return `(SELECT count(*) FROM ${tableRef} ${quoteIdentifier(subAlias)}${whereClause})`;
  }

  // For other aggregate functions, we need a column
  const col = agg.column!;
  const fnName = agg.function;
  return `(SELECT ${fnName}(${quoteIdentifier(subAlias)}.${quoteIdentifier(col)}) FROM ${tableRef} ${quoteIdentifier(subAlias)}${whereClause})`;
}

/**
 * Precompute all ORDER BY metadata: LEFT JOIN SQL for object relationships,
 * the join alias map, and the ORDER BY clause string.
 *
 * This ensures a single pass through the alias counter, so JOIN aliases are
 * consistent between the JOIN clause and the ORDER BY expressions.
 */
function compileOrderByFull(
  orderBy: OrderByItem[],
  alias: string,
  aliasCounter: AliasCounter,
): { joinSql: string; orderByClause: string } {
  if (orderBy.length === 0) return { joinSql: '', orderByClause: '' };

  const hasRelationship = orderBy.some((item) => item.relationship);
  const hasAggregate = orderBy.some((item) => item.aggregate);

  if (!hasRelationship && !hasAggregate) {
    // Simple case: just column ordering (and possibly computed fields), no JOINs needed
    const parts = orderBy.map((item) => {
      let ref: string;
      if (item.computedField) {
        ref = `${quoteIdentifier(item.computedField.schema)}.${quoteIdentifier(item.computedField.functionName)}(${quoteIdentifier(alias)})`;
      } else {
        ref = `${quoteIdentifier(alias)}.${quoteIdentifier(item.column)}`;
      }
      let clause = `${ref} ${item.direction.toUpperCase()}`;
      if (item.nulls) {
        clause += ` NULLS ${item.nulls.toUpperCase()}`;
      }
      return clause;
    });
    return { joinSql: '', orderByClause: ` ORDER BY ${parts.join(', ')}` };
  }

  // Build join aliases for object relationships (single pass)
  const { joinSql, joinAliases } = hasRelationship
    ? buildOrderByJoins(orderBy, alias, aliasCounter)
    : { joinSql: '', joinAliases: new Map<string, string>() };

  const parts = orderBy.map((item) => {
    if (item.aggregate) {
      // Aggregate ordering: correlated subquery
      const expr = buildAggregateOrderExpr(item, alias, aliasCounter);
      let clause = `${expr} ${item.direction.toUpperCase()}`;
      if (item.nulls) {
        clause += ` NULLS ${item.nulls.toUpperCase()}`;
      }
      return clause;
    }

    if (item.relationship) {
      // Object relationship ordering: reference the joined column
      const { chain, leaf } = flattenRelationshipOrderBy(item);
      let pathKey = '';
      for (const link of chain) {
        pathKey += `/${link.config.name}`;
      }
      const joinAlias = joinAliases.get(pathKey)!;
      let clause = `${quoteIdentifier(joinAlias)}.${quoteIdentifier(leaf.column)} ${leaf.direction.toUpperCase()}`;
      if (leaf.nulls) {
        clause += ` NULLS ${leaf.nulls.toUpperCase()}`;
      }
      return clause;
    }

    // Regular column or computed field ordering
    let ref: string;
    if (item.computedField) {
      ref = `${quoteIdentifier(item.computedField.schema)}.${quoteIdentifier(item.computedField.functionName)}(${quoteIdentifier(alias)})`;
    } else {
      ref = `${quoteIdentifier(alias)}.${quoteIdentifier(item.column)}`;
    }
    let clause = `${ref} ${item.direction.toUpperCase()}`;
    if (item.nulls) {
      clause += ` NULLS ${item.nulls.toUpperCase()}`;
    }
    return clause;
  });

  const joinSqlPrefixed = joinSql ? ` ${joinSql}` : '';
  return { joinSql: joinSqlPrefixed, orderByClause: ` ORDER BY ${parts.join(', ')}` };
}

// Keep the simple compileOrderBy for use by relationship subqueries (no JOINs needed there)
function compileOrderBy(orderBy: OrderByItem[], alias: string): string {
  if (orderBy.length === 0) return '';

  const parts = orderBy.map((item) => {
    let ref: string;
    if (item.computedField) {
      ref = `${quoteIdentifier(item.computedField.schema)}.${quoteIdentifier(item.computedField.functionName)}(${quoteIdentifier(alias)})`;
    } else {
      ref = `${quoteIdentifier(alias)}.${quoteIdentifier(item.column)}`;
    }
    let clause = `${ref} ${item.direction.toUpperCase()}`;
    if (item.nulls) {
      clause += ` NULLS ${item.nulls.toUpperCase()}`;
    }
    return clause;
  });

  return ` ORDER BY ${parts.join(', ')}`;
}

// ─── DISTINCT ON ─────────────────────────────────────────────────────────────

/**
 * Compile DISTINCT ON clause for PostgreSQL.
 */
function compileDistinctOn(distinctOn: string[], alias: string): string {
  if (distinctOn.length === 0) return '';

  const cols = distinctOn.map((col) =>
    `${quoteIdentifier(alias)}.${quoteIdentifier(col)}`,
  );

  return `DISTINCT ON (${cols.join(', ')}) `;
}

/**
 * Ensure ORDER BY starts with the DISTINCT ON columns.
 * PostgreSQL requires that DISTINCT ON expressions must match the leftmost ORDER BY expressions.
 * If the user-provided ORDER BY doesn't already start with the distinct columns,
 * prepend them (using ASC as default direction).
 */
function ensureDistinctOnInOrderBy(
  distinctOn: string[],
  orderBy?: OrderByItem[],
): OrderByItem[] {
  const existing = orderBy ?? [];

  // Check which distinct columns are already at the start of ORDER BY
  const result: OrderByItem[] = [];

  for (const col of distinctOn) {
    const existingIdx = existing.findIndex((item) => item.column === col);
    if (existingIdx !== -1) {
      // Use the user-specified direction for this column
      result.push(existing[existingIdx]);
    } else {
      // Prepend with default ASC direction
      result.push({ column: col, direction: 'asc' });
    }
  }

  // Append remaining ORDER BY items that aren't already in result
  for (const item of existing) {
    if (!result.some((r) => r.column === item.column)) {
      result.push(item);
    }
  }

  return result;
}

// ─── json_build_object Fields ────────────────────────────────────────────────

/**
 * Build the json_build_object argument list for selected columns, computed fields,
 * and relationships.
 */
export function buildJsonFields(
  columns: ColumnInfo[],
  alias: string,
  relationships: RelationshipSelection[] | undefined,
  params: ParamCollector,
  session: SessionVariables,
  aliasCounter: AliasCounter,
  computedFields?: ComputedFieldSelection[],
  setReturningComputedFields?: SetReturningComputedFieldSelection[],
  jsonbPaths?: Map<string, string>,
  customColumnNames?: Record<string, string>,
  aggregateRelationships?: AggregateRelationshipSelection[],
): string {
  const fields: string[] = [];

  // Scalar columns
  for (const col of columns) {
    const colRef = `${quoteIdentifier(alias)}.${quoteIdentifier(col.name)}`;

    const jsonKey = customColumnNames?.[col.name] ?? toCamelCase(col.name);

    // JSONB path extraction: column #> $N::text[]
    const pathStr = jsonbPaths?.get(col.name);
    if (pathStr) {
      const segments = pathStr.split('.');
      const placeholder = params.add(segments);
      fields.push(`'${jsonKey}', ${colRef} #> ${placeholder}::text[]`);
      continue;
    }

    // When stringify_numeric_types is enabled, cast numeric columns to text
    // so json_build_object emits a JSON string, preserving precision and trailing zeros.
    const expr = shouldCastToText(col.udtName) ? `(${colRef})::text` : colRef;
    fields.push(`'${jsonKey}', ${expr}`);
  }

  // Computed fields — call PG function with table row as argument
  if (computedFields) {
    for (const cf of computedFields) {
      const fnSchema = cf.config.function.schema ?? 'public';
      const fnName = cf.config.function.name;
      const funcRef = `${quoteIdentifier(fnSchema)}.${quoteIdentifier(fnName)}`;
      // Build function argument list: table row first, then optional extra args
      const argParts: string[] = [quoteIdentifier(alias)];
      // User-provided extra arguments (named notation for DEFAULT support)
      if (cf.args && cf.args.size > 0) {
        for (const [argName, argValue] of cf.args) {
          argParts.push(`${quoteIdentifier(argName)} := ${params.add(argValue)}`);
        }
      }
      // When sessionArgument is set, inject session variables as a JSON parameter
      if (cf.sessionArgument) {
        argParts.push(`${quoteIdentifier(cf.sessionArgument)} := ${params.add(JSON.stringify(session.claims))}::json`);
      }
      const funcCall = `${funcRef}(${argParts.join(', ')})`;
      const expr = shouldCastToText(cf.functionInfo.returnType)
        ? `(${funcCall})::text`
        : funcCall;
      fields.push(`'${toCamelCase(cf.config.name)}', ${expr}`);
    }
  }

  // Set-returning computed fields — lateral subquery over PG function
  if (setReturningComputedFields) {
    for (const srcf of setReturningComputedFields) {
      const subquery = buildSetReturningComputedFieldSubquery(
        srcf,
        alias,
        params,
        session,
        aliasCounter,
      );
      fields.push(`'${toCamelCase(srcf.config.name)}', (${subquery})`);
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
      fields.push(`'${relSel.fieldName ?? relSel.relationship.name}', (${subquery})`);
    }
  }

  // Aggregate relationship subqueries
  if (aggregateRelationships) {
    for (const aggRelSel of aggregateRelationships) {
      const subquery = buildAggregateRelationshipSubquery(
        aggRelSel,
        alias,
        params,
        aliasCounter,
      );
      fields.push(`'${aggRelSel.fieldName}', (${subquery})`);
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
    relSel.setReturningComputedFields,
    relSel.jsonbPaths,
    remoteTable.customColumnNames,
  );

  // Build the join condition from the relationship mapping
  const joinConditions = buildJoinConditions(rel, parentAlias, subAlias);

  // Additional WHERE clauses
  const whereParts: string[] = [...joinConditions];

  // User-provided filter on this relationship
  const relColumnLookup = new Map(remoteTable.columns.map(c => [c.name, c]));
  const userWhere = compileWhere(relSel.where, params, subAlias, session, relColumnLookup);
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

  // DISTINCT ON for array relationships
  const distinctOn = relSel.distinctOn;
  const distinctOnClause = distinctOn && distinctOn.length > 0
    ? compileDistinctOn(distinctOn, subAlias)
    : '';
  const effectiveOrderBy = distinctOn && distinctOn.length > 0
    ? ensureDistinctOnInOrderBy(distinctOn, relSel.orderBy)
    : relSel.orderBy;

  // ORDER BY
  const orderByClause = effectiveOrderBy ? compileOrderBy(effectiveOrderBy, subAlias) : '';

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
  // When LIMIT/OFFSET/DISTINCT ON is used, we need a subquery to apply it before aggregation
  const needsSubquery = limitClause.length > 0 || distinctOnClause.length > 0;

  if (needsSubquery) {
    // Wrap in a subquery: first select with DISTINCT ON + WHERE + ORDER BY + LIMIT, then aggregate
    const innerAlias = aliasCounter.next();
    const innerSelect = `SELECT ${distinctOnClause}json_build_object(${jsonFields}) AS "_row_" FROM ${tableRef} ${quoteIdentifier(subAlias)}${whereClause}${orderByClause}${limitClause}`;
    return `SELECT coalesce(json_agg(${quoteIdentifier(innerAlias)}."_row_"), '[]'::json) FROM (${innerSelect}) ${quoteIdentifier(innerAlias)}`;
  }

  // No LIMIT/DISTINCT ON — use ORDER BY inside json_agg for efficiency
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

// ─── Aggregate Relationship Subquery ─────────────────────────────────────────

/**
 * Build a correlated aggregate subquery for an array relationship.
 *
 * Returns a json_build_object with 'aggregate' and 'nodes' keys, matching
 * the structure of the root-level aggregate query but scoped to the parent row
 * via the relationship's foreign key join condition.
 *
 * Example output shape:
 *   SELECT json_build_object(
 *     'aggregate', json_build_object('count', count(*)),
 *     'nodes', coalesce(json_agg(json_build_object(...)), '[]'::json)
 *   )
 *   FROM "public"."invoice" "t1"
 *   WHERE "t1"."client_id" = "t0"."id"
 */
function buildAggregateRelationshipSubquery(
  aggRelSel: AggregateRelationshipSelection,
  parentAlias: string,
  params: ParamCollector,
  aliasCounter: AliasCounter,
): string {
  const rel = aggRelSel.relationship;
  const remoteTable = aggRelSel.remoteTable;
  const subAlias = aliasCounter.next();
  const tableRef = quoteTableRef(remoteTable.schema, remoteTable.name);

  // Build the join condition from the relationship mapping
  const joinConditions = buildJoinConditions(rel, parentAlias, subAlias);

  // Additional WHERE clauses
  const whereParts: string[] = [...joinConditions];

  // User-provided filter
  const aggColumnLookup = new Map(remoteTable.columns.map(c => [c.name, c]));
  const userWhere = compileWhere(aggRelSel.where, params, subAlias, aggRelSel.session, aggColumnLookup, remoteTable.computedFields);
  if (userWhere) whereParts.push(userWhere);

  // Permission filter
  if (aggRelSel.permission?.filter) {
    const permResult = aggRelSel.permission.filter.toSQL(
      aggRelSel.session,
      params.getOffset(),
      subAlias,
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
  const agg = aggRelSel.aggregate;

  if (agg.count !== undefined) {
    if (agg.count.columns && agg.count.columns.length > 0) {
      const colRefs = agg.count.columns.map(
        (c) => `${quoteIdentifier(subAlias)}.${quoteIdentifier(c)}`,
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
      const colParts = fieldCols.map(
        (c) => `'${c}', ${fn}(${quoteIdentifier(subAlias)}.${quoteIdentifier(c)})`,
      ).join(', ');
      aggFields.push(`'${fn}', json_build_object(${colParts})`);
    }
  }

  // Statistical aggregate functions
  const STAT_AGG_MAP_REL: Array<{ key: keyof AggregateSelection; sqlFn: string }> = [
    { key: 'stddev', sqlFn: 'stddev' },
    { key: 'stddevPop', sqlFn: 'stddev_pop' },
    { key: 'stddevSamp', sqlFn: 'stddev_samp' },
    { key: 'variance', sqlFn: 'variance' },
    { key: 'varPop', sqlFn: 'var_pop' },
    { key: 'varSamp', sqlFn: 'var_samp' },
  ];

  for (const { key, sqlFn } of STAT_AGG_MAP_REL) {
    const fieldCols = agg[key] as string[] | undefined;
    if (fieldCols && fieldCols.length > 0) {
      const colParts = fieldCols.map(
        (c) => `'${c}', ${sqlFn}(${quoteIdentifier(subAlias)}.${quoteIdentifier(c)})`,
      ).join(', ');
      aggFields.push(`'${key}', json_build_object(${colParts})`);
    }
  }

  // Build the SELECT: aggregate only (no nodes for nested aggregate)
  const selectParts: string[] = [];
  if (aggFields.length > 0) {
    selectParts.push(`'aggregate', json_build_object(${aggFields.join(', ')})`);
  }
  // Always include nodes as an empty array for consistent shape
  selectParts.push(`'nodes', coalesce(json_agg(json_build_object()), '[]'::json)`);

  const sql = `SELECT json_build_object(${selectParts.join(', ')}) FROM ${tableRef} ${quoteIdentifier(subAlias)}${whereClause}`;

  return sql;
}

// ─── Set-Returning Computed Field Subquery ───────────────────────────────────

/**
 * Build a subquery for a set-returning computed field.
 *
 * Similar to array relationship subqueries but uses the PG function call
 * as the FROM source instead of a table with join conditions.
 * e.g., SELECT coalesce(json_agg(json_build_object(...)), '[]'::json)
 *        FROM "public"."game_visible_brands"("t0") "t1" WHERE ...
 */
function buildSetReturningComputedFieldSubquery(
  selection: SetReturningComputedFieldSelection,
  parentAlias: string,
  params: ParamCollector,
  session: SessionVariables,
  aliasCounter: AliasCounter,
): string {
  const subAlias = aliasCounter.next();
  const fnSchema = selection.config.function.schema ?? 'public';
  const fnName = selection.config.function.name;
  const funcCall = `${quoteIdentifier(fnSchema)}.${quoteIdentifier(fnName)}(${quoteIdentifier(parentAlias)})`;

  // Filter columns for the sub-selection
  const subColumns = filterColumns(
    selection.columns,
    selection.remoteTable,
    selection.permission?.columns,
  );

  // Build json_build_object fields (recursive — handles nested relationships and computed fields)
  const jsonFields = buildJsonFields(
    subColumns,
    subAlias,
    selection.relationships,
    params,
    session,
    aliasCounter,
    selection.computedFields,
    selection.setReturningComputedFields,
    selection.jsonbPaths,
    selection.remoteTable.customColumnNames,
  );

  // WHERE clauses (no join conditions — function call handles the relationship)
  const whereParts: string[] = [];

  const srcfColumnLookup = new Map(selection.remoteTable.columns.map(c => [c.name, c]));
  const userWhere = compileWhere(selection.where, params, subAlias, session, srcfColumnLookup);
  if (userWhere) whereParts.push(userWhere);

  if (selection.permission?.filter) {
    const permResult = selection.permission.filter.toSQL(
      session,
      params.getOffset(),
      subAlias,
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
  const orderByClause = selection.orderBy ? compileOrderBy(selection.orderBy, subAlias) : '';

  // LIMIT / OFFSET
  let limitClause = '';
  const effectiveLimit = resolveLimit(selection.limit, selection.permission?.limit);
  if (effectiveLimit !== undefined) {
    limitClause += ` LIMIT ${params.add(effectiveLimit)}`;
  }
  if (selection.offset !== undefined) {
    limitClause += ` OFFSET ${params.add(selection.offset)}`;
  }

  const hasLimitOffset = limitClause.length > 0;

  if (hasLimitOffset) {
    const innerAlias = aliasCounter.next();
    const innerSelect = `SELECT json_build_object(${jsonFields}) AS "_row_" FROM ${funcCall} ${quoteIdentifier(subAlias)}${whereClause}${orderByClause}${limitClause}`;
    return `SELECT coalesce(json_agg(${quoteIdentifier(innerAlias)}."_row_"), '[]'::json) FROM (${innerSelect}) ${quoteIdentifier(innerAlias)}`;
  }

  return `SELECT coalesce(json_agg(json_build_object(${jsonFields})${orderByClause}), '[]'::json) FROM ${funcCall} ${quoteIdentifier(subAlias)}${whereClause}`;
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
    opts.setReturningComputedFields,
    opts.jsonbPaths,
    opts.table.customColumnNames,
    opts.aggregateRelationships,
  );

  // Build WHERE clause
  const whereParts: string[] = [];

  // User-provided filter
  const columnLookup = new Map(opts.table.columns.map(c => [c.name, c]));
  const userWhere = compileWhere(opts.where, params, alias, opts.session, columnLookup, opts.table.computedFields);
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

  // DISTINCT ON — adjust ORDER BY to satisfy PostgreSQL requirement
  const distinctOn = opts.distinctOn;
  const distinctOnClause = distinctOn && distinctOn.length > 0
    ? compileDistinctOn(distinctOn, alias)
    : '';
  const effectiveOrderBy = distinctOn && distinctOn.length > 0
    ? ensureDistinctOnInOrderBy(distinctOn, opts.orderBy)
    : opts.orderBy;

  // ORDER BY — compute JOINs and ORDER BY clause in a single pass
  const { joinSql: orderByJoinsClause, orderByClause } = effectiveOrderBy
    ? compileOrderByFull(effectiveOrderBy, alias, aliasCounter)
    : { joinSql: '', orderByClause: '' };

  // LIMIT / OFFSET
  let limitOffsetClause = '';
  const effectiveLimit = resolveLimit(opts.limit, opts.permission?.limit);
  if (effectiveLimit !== undefined) {
    limitOffsetClause += ` LIMIT ${params.add(effectiveLimit)}`;
  }
  if (opts.offset !== undefined) {
    limitOffsetClause += ` OFFSET ${params.add(opts.offset)}`;
  }

  // If ORDER BY, LIMIT, or DISTINCT ON is used, wrap in a subquery so the
  // ordering/limiting/deduplication applies to the rows, then aggregate the result.
  let sql: string;
  if (orderByClause || limitOffsetClause || distinctOnClause) {
    const innerSql = [
      `SELECT ${distinctOnClause}${jsonFields ? `json_build_object(${jsonFields}) AS "_row_"` : `${quoteIdentifier(alias)}.*`}`,
      `FROM ${tableRef} ${quoteIdentifier(alias)}${orderByJoinsClause}`,
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
    opts.setReturningComputedFields,
    opts.jsonbPaths,
    opts.table.customColumnNames,
    opts.aggregateRelationships,
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

  const aggColumnLookup = new Map(opts.table.columns.map(c => [c.name, c]));
  const userWhere = compileWhere(opts.where, params, alias, opts.session, aggColumnLookup, opts.table.computedFields);
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
    const cfRefs = agg.computedFields?.[fn];
    const allParts: string[] = [];
    if (fieldCols && fieldCols.length > 0) {
      for (const c of fieldCols) {
        allParts.push(`'${c}', ${fn}(${quoteIdentifier(alias)}.${quoteIdentifier(c)})`);
      }
    }
    if (cfRefs && cfRefs.length > 0) {
      for (const cf of cfRefs) {
        const funcCall = `${quoteIdentifier(cf.schema)}.${quoteIdentifier(cf.functionName)}(${quoteIdentifier(alias)})`;
        allParts.push(`'${cf.name}', ${fn}(${funcCall})`);
      }
    }
    if (allParts.length > 0) {
      aggFields.push(`'${fn}', json_build_object(${allParts.join(', ')})`);
    }
  }

  // Statistical aggregate functions (stddev, variance family)
  const STAT_AGG_MAP: Array<{ key: keyof AggregateSelection; sqlFn: string }> = [
    { key: 'stddev', sqlFn: 'stddev' },
    { key: 'stddevPop', sqlFn: 'stddev_pop' },
    { key: 'stddevSamp', sqlFn: 'stddev_samp' },
    { key: 'variance', sqlFn: 'variance' },
    { key: 'varPop', sqlFn: 'var_pop' },
    { key: 'varSamp', sqlFn: 'var_samp' },
  ];

  for (const { key, sqlFn } of STAT_AGG_MAP) {
    const fieldCols = agg[key] as string[] | undefined;
    const cfKey = key as keyof NonNullable<AggregateSelection['computedFields']>;
    const cfRefs = agg.computedFields?.[cfKey];
    const allParts: string[] = [];
    if (fieldCols && fieldCols.length > 0) {
      for (const c of fieldCols) {
        allParts.push(`'${c}', ${sqlFn}(${quoteIdentifier(alias)}.${quoteIdentifier(c)})`);
      }
    }
    if (cfRefs && cfRefs.length > 0) {
      for (const cf of cfRefs) {
        const funcCall = `${quoteIdentifier(cf.schema)}.${quoteIdentifier(cf.functionName)}(${quoteIdentifier(alias)})`;
        allParts.push(`'${cf.name}', ${sqlFn}(${funcCall})`);
      }
    }
    if (allParts.length > 0) {
      aggFields.push(`'${key}', json_build_object(${allParts.join(', ')})`);
    }
  }

  // ── GROUP BY path ──────────────────────────────────────────────────────
  if (opts.groupBy && opts.groupBy.length > 0) {
    // Filter groupBy columns against permissions
    const allowedGroupByCols = opts.groupBy.filter((col) => {
      const tableCol = opts.table.columns.find((c) => c.name === col);
      if (!tableCol) return false;
      if (!opts.permission?.columns) return true;
      if (opts.permission.columns === '*') return true;
      return opts.permission.columns.includes(col);
    });

    if (allowedGroupByCols.length > 0) {
      // GROUP BY column references
      const groupByRefs = allowedGroupByCols.map(
        (c) => `${quoteIdentifier(alias)}.${quoteIdentifier(c)}`,
      ).join(', ');

      // Inner query: GROUP BY with aggregate functions, producing one row per group
      const innerAggFields: string[] = [];

      // Include group-by columns in inner SELECT
      for (const col of allowedGroupByCols) {
        innerAggFields.push(`${quoteIdentifier(alias)}.${quoteIdentifier(col)}`);
      }

      // Include aggregate expressions
      if (agg.count !== undefined) {
        if (agg.count.columns && agg.count.columns.length > 0) {
          const colRefs = agg.count.columns.map(
            (c) => `${quoteIdentifier(alias)}.${quoteIdentifier(c)}`,
          ).join(', ');
          const distinct = agg.count.distinct ? 'DISTINCT ' : '';
          innerAggFields.push(`count(${distinct}${colRefs}) AS "_count_"`);
        } else {
          innerAggFields.push(`count(*) AS "_count_"`);
        }
      }

      for (const fn of ['sum', 'avg', 'min', 'max'] as const) {
        const fieldCols = agg[fn];
        if (fieldCols && fieldCols.length > 0) {
          for (const c of fieldCols) {
            innerAggFields.push(
              `${fn}(${quoteIdentifier(alias)}.${quoteIdentifier(c)}) AS "_${fn}_${c}_"`,
            );
          }
        }
      }

      // Statistical aggregate functions in GROUP BY
      const STAT_AGG_MAP_GB: Array<{ key: keyof AggregateSelection; sqlFn: string }> = [
        { key: 'stddev', sqlFn: 'stddev' },
        { key: 'stddevPop', sqlFn: 'stddev_pop' },
        { key: 'stddevSamp', sqlFn: 'stddev_samp' },
        { key: 'variance', sqlFn: 'variance' },
        { key: 'varPop', sqlFn: 'var_pop' },
        { key: 'varSamp', sqlFn: 'var_samp' },
      ];

      for (const { key, sqlFn } of STAT_AGG_MAP_GB) {
        const fieldCols = agg[key] as string[] | undefined;
        if (fieldCols && fieldCols.length > 0) {
          for (const c of fieldCols) {
            innerAggFields.push(
              `${sqlFn}(${quoteIdentifier(alias)}.${quoteIdentifier(c)}) AS "_${key}_${c}_"`,
            );
          }
        }
      }

      const innerSql = [
        `SELECT ${innerAggFields.join(', ')}`,
        `FROM ${tableRef} ${quoteIdentifier(alias)}`,
        whereClause ? whereClause.trim() : null,
        `GROUP BY ${groupByRefs}`,
      ].filter(Boolean).join('\n');

      // Outer query: wrap each group row into a JSON object
      const groupedAlias = '"_g_"';
      const outerJsonParts: string[] = [];

      // keys object
      const outerKeysFields = allowedGroupByCols.map(
        (c) => `'${c}', ${groupedAlias}.${quoteIdentifier(c)}`,
      ).join(', ');
      outerJsonParts.push(`'keys', json_build_object(${outerKeysFields})`);

      // count
      if (agg.count !== undefined) {
        outerJsonParts.push(`'count', ${groupedAlias}."_count_"`);
      }

      // sum, avg, min, max
      for (const fn of ['sum', 'avg', 'min', 'max'] as const) {
        const fieldCols = agg[fn];
        if (fieldCols && fieldCols.length > 0) {
          const fnParts = fieldCols.map(
            (c) => `'${c}', ${groupedAlias}."_${fn}_${c}_"`,
          ).join(', ');
          outerJsonParts.push(`'${fn}', json_build_object(${fnParts})`);
        }
      }

      // Statistical aggregate functions in outer JSON
      for (const { key } of STAT_AGG_MAP_GB) {
        const fieldCols = agg[key] as string[] | undefined;
        if (fieldCols && fieldCols.length > 0) {
          const fnParts = fieldCols.map(
            (c) => `'${c}', ${groupedAlias}."_${key}_${c}_"`,
          ).join(', ');
          outerJsonParts.push(`'${key}', json_build_object(${fnParts})`);
        }
      }

      const outerSql = `SELECT coalesce(json_agg(json_build_object(${outerJsonParts.join(', ')})), '[]'::json) AS "groupedAggregates" FROM (${innerSql}) ${groupedAlias}`;

      return { sql: outerSql, params: params.getParams() };
    }
  }

  // ── Standard (non-grouped) aggregate path ────────────────────────────

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
      undefined,
      undefined,
      undefined,
      opts.table.customColumnNames,
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
