/**
 * Shared helper utilities used across resolver modules.
 *
 * Extracted from the original resolvers.ts monolith for modularity.
 */

import type { GraphQLFieldResolver } from 'graphql';
import type {
  TableInfo,
  ColumnInfo,
  SessionVariables,
  BoolExp,
  CompiledPermission,
  ComputedFieldConfig,
  FunctionInfo,
} from '../../types.js';
import type { Pool } from 'pg';
import type { QueryCache } from '../../sql/cache.js';
import type { SubscriptionManager } from '../../subscriptions/manager.js';
import type { JobQueue } from '../../shared/job-queue/types.js';
import type { OrderByItem, AggregateSelection, AggregateComputedFieldRef, AggregateRelationshipSelection, ComputedFieldSelection, SetReturningComputedFieldSelection } from '../../sql/select.js';
import { toCamelCase, getColumnFieldName, getRelFieldName } from '../type-builder.js';
import type { SetReturningComputedFieldParsed, AggregateRelationshipParsed } from '../resolve-info.js';

// ─── Resolver Context ───────────────────────────────────────────────────────

/**
 * The context object available in every resolver.
 * Attached by the Mercurius context function on each request.
 */
export interface ResolverContext {
  /** The authenticated session variables extracted from JWT/webhook. */
  auth: SessionVariables;

  /** Execute a query with session variable injection into the PG connection. */
  queryWithSession(
    sql: string,
    params: unknown[],
    session: SessionVariables,
    intent: 'read' | 'write',
  ): Promise<{ rows: unknown[]; rowCount: number }>;

  /** Execute multiple queries within a single transaction (for nested inserts). */
  transactionalQueryWithSession(
    queries: Array<{ sql: string; params: unknown[] }>,
    session: SessionVariables,
  ): Promise<Array<{ rows: unknown[]; rowCount: number }>>;

  /** Permission lookup — returns compiled permissions for a table + role. */
  permissionLookup: ResolverPermissionLookup;

  /** Inherited roles mapping (role_name → constituent role_set). */
  inheritedRoles: Record<string, string[]>;

  /** All tracked tables (for relationship resolution). */
  tables: TableInfo[];

  /** All introspected PG functions (for computed field resolution). */
  functions: FunctionInfo[];

  /** Query cache for compiled SQL templates. */
  queryCache?: QueryCache;

  /** Subscription manager for real-time subscriptions (available when subscriptions are enabled). */
  subscriptionManager?: SubscriptionManager;

  /** Job queue instance for async action enqueuing (available when job queue is enabled). */
  jobQueue?: JobQueue;

  /** Primary database pool for async action storage (available when database is connected). */
  pool?: Pool;

  /** Original client HTTP headers (for forwarding to action handlers). */
  clientHeaders?: Record<string, string>;

  /** Maximum allowed limit for GraphQL select queries. */
  graphqlMaxLimit?: number;
}

/**
 * Adapter interface for permission lookup in resolvers.
 * Maps table schema/name + role to the correct compiled permission for each operation.
 */
export interface ResolverPermissionLookup {
  getSelect(tableSchema: string, tableName: string, role: string): CompiledPermission['select'] | null;
  getInsert(tableSchema: string, tableName: string, role: string): CompiledPermission['insert'] | null;
  getUpdate(tableSchema: string, tableName: string, role: string): CompiledPermission['update'] | null;
  getDelete(tableSchema: string, tableName: string, role: string): CompiledPermission['delete'] | null;
}

// ─── Error Helpers ──────────────────────────────────────────────────────────

export function permissionDenied(operation: string, table: string, role: string): Error {
  return new Error(
    `Permission denied: role "${role}" does not have ${operation} access to "${table}"`,
  );
}

// ─── Root Field Visibility Check ─────────────────────────────────────────────

/**
 * Check if a query root field operation is allowed for the role.
 *
 * `queryRootFields` on the compiled permission controls which query operations
 * the role can access:
 * - undefined → all operations allowed (default)
 * - [] → no operations allowed (role can only access via relationships)
 * - ['select', 'select_by_pk'] → only those operations allowed
 */
export function isQueryRootFieldAllowed(
  perm: { queryRootFields?: string[] } | null | undefined,
  rootFieldType: 'select' | 'select_by_pk' | 'select_aggregate',
): boolean {
  if (!perm || perm.queryRootFields === undefined) return true;
  return perm.queryRootFields.includes(rootFieldType);
}

/**
 * Same as isQueryRootFieldAllowed but for subscription root fields.
 */
export function isSubscriptionRootFieldAllowed(
  perm: { subscriptionRootFields?: string[] } | null | undefined,
  rootFieldType: 'select' | 'select_by_pk' | 'select_aggregate' | 'select_stream',
): boolean {
  if (!perm || perm.subscriptionRootFields === undefined) return true;
  return perm.subscriptionRootFields.includes(rootFieldType);
}

// ─── camelCase ↔ snake_case Conversion ──────────────────────────────────────

/**
 * Build a mapping of camelCase field names → snake_case column names for a table.
 */
export function camelToColumnMap(table: TableInfo): Map<string, string> {
  const map = new Map<string, string>();
  for (const col of table.columns) {
    map.set(getColumnFieldName(table, col.name), col.name);
  }
  return map;
}

/**
 * Build a mapping of camelCase field names → snake_case names for columns AND computed fields.
 * Used by remapBoolExp and remapOrderBy so that computed field names are correctly remapped.
 */
export function camelToColumnAndCFMap(table: TableInfo): Map<string, string> {
  const map = camelToColumnMap(table);
  if (table.computedFields) {
    for (const cf of table.computedFields) {
      map.set(toCamelCase(cf.name), cf.name);
    }
  }
  return map;
}

/**
 * Convert a camelCase-keyed object to snake_case column names.
 */
export function remapKeys(
  obj: Record<string, unknown> | undefined | null,
  columnMap: Map<string, string>,
): Record<string, unknown> | undefined {
  if (!obj) return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const pgName = columnMap.get(key) ?? key;
    result[pgName] = value;
  }
  return result;
}

/**
 * Recursively remap camelCase keys in a BoolExp to snake_case column names.
 * Logical operators (_and, _or, _not) and comparison operators (_eq, _gt, etc.)
 * are preserved as-is; only column-level keys are remapped.
 *
 * When `table` and `allTables` are provided, aggregate filter keys (e.g., `accountsAggregate`)
 * are detected and converted into internal `_aggregateFilter` entries for the SQL compiler.
 */
export function remapBoolExp(
  boolExp: BoolExp | undefined | null,
  columnMap: Map<string, string>,
  table?: TableInfo,
  allTables?: TableInfo[],
): BoolExp | undefined {
  if (!boolExp || typeof boolExp !== 'object') return undefined;

  const keys = Object.keys(boolExp);
  if (keys.length === 0) return boolExp;

  // _and: recursively remap each child
  if ('_and' in boolExp) {
    const typed = boolExp as { _and: BoolExp[] };
    return { _and: typed._and.map((sub) => remapBoolExp(sub, columnMap, table, allTables) ?? ({} as BoolExp)) };
  }

  // _or: recursively remap each child
  if ('_or' in boolExp) {
    const typed = boolExp as { _or: BoolExp[] };
    return { _or: typed._or.map((sub) => remapBoolExp(sub, columnMap, table, allTables) ?? ({} as BoolExp)) };
  }

  // _not: recursively remap child
  if ('_not' in boolExp) {
    const typed = boolExp as { _not: BoolExp };
    return { _not: remapBoolExp(typed._not, columnMap, table, allTables) ?? ({} as BoolExp) };
  }

  // _exists: pass through (table-level, not column-level)
  if ('_exists' in boolExp) {
    return boolExp;
  }

  // Build a map of aggregate filter key -> relationship config for quick lookup
  const aggRelMap = new Map<string, TableInfo['relationships'][number]>();
  if (table && allTables) {
    for (const rel of table.relationships) {
      if (rel.type === 'array') {
        aggRelMap.set(`${getRelFieldName(rel)}Aggregate`, rel);
      }
    }
  }

  // Build a map of relationship name -> relationship config for traversal filters
  const relMap = new Map<string, TableInfo['relationships'][number]>();
  if (table) {
    for (const rel of table.relationships) {
      relMap.set(getRelFieldName(rel), rel);
    }
  }

  // Column-level: remap keys from camelCase to snake_case
  const result: Record<string, unknown> = {};
  const aggregateFilters: unknown[] = [];

  for (const [key, value] of Object.entries(boolExp as Record<string, unknown>)) {
    // Check for aggregate filter keys (e.g., accountsAggregate)
    const aggRel = aggRelMap.get(key);
    if (aggRel && value && typeof value === 'object') {
      const aggValue = value as Record<string, unknown>;

      // Currently only 'count' is supported
      if (aggValue.count && typeof aggValue.count === 'object') {
        const countSpec = aggValue.count as Record<string, unknown>;
        const remoteTable = allTables!.find(
          (t) => t.name === aggRel.remoteTable.name && t.schema === aggRel.remoteTable.schema,
        );
        if (!remoteTable) continue;

        // Build column mapping from the relationship config
        const colMapping: Record<string, string> = {};
        if (aggRel.columnMapping) {
          for (const [localCol, remoteCol] of Object.entries(aggRel.columnMapping)) {
            colMapping[localCol] = remoteCol;
          }
        } else if (aggRel.localColumns && aggRel.remoteColumns) {
          for (let i = 0; i < aggRel.localColumns.length; i++) {
            colMapping[aggRel.localColumns[i]] = aggRel.remoteColumns[i];
          }
        }

        // Remap the filter sub-expression if present
        let remappedFilter: BoolExp | undefined;
        if (countSpec.filter) {
          const remoteColMap = camelToColumnMap(remoteTable);
          remappedFilter = remapBoolExp(
            countSpec.filter as BoolExp,
            remoteColMap,
            remoteTable,
            allTables,
          );
        }

        aggregateFilters.push({
          _aggregateFilter: {
            function: 'count',
            arguments: countSpec.arguments as string[] | undefined,
            distinct: countSpec.distinct as boolean | undefined,
            filter: remappedFilter,
            predicate: countSpec.predicate,
            columnMapping: colMapping,
            remoteSchema: remoteTable.schema,
            remoteTable: remoteTable.name,
          },
        });
      }
      continue;
    }

    // Check for relationship traversal filter keys (e.g., campaign: { key: { _eq: "foo" } })
    const rel = relMap.get(key);
    if (rel && value && typeof value === 'object' && allTables) {
      const remoteTable = allTables.find(
        (t) => t.name === rel.remoteTable.name && t.schema === rel.remoteTable.schema,
      );
      if (remoteTable) {
        // Build column mapping from the relationship config
        const colMapping: Record<string, string> = {};
        if (rel.columnMapping) {
          for (const [localCol, remoteCol] of Object.entries(rel.columnMapping)) {
            colMapping[localCol] = remoteCol;
          }
        } else if (rel.localColumns && rel.remoteColumns) {
          for (let i = 0; i < rel.localColumns.length; i++) {
            colMapping[rel.localColumns[i]] = rel.remoteColumns[i];
          }
        }

        // Recursively remap the child BoolExp using remote table's column map
        const remoteColMap = camelToColumnMap(remoteTable);
        const remappedChild = remapBoolExp(
          value as BoolExp,
          remoteColMap,
          remoteTable,
          allTables,
        );

        aggregateFilters.push({
          _relationshipFilter: {
            columnMapping: colMapping,
            remoteSchema: remoteTable.schema,
            remoteTable: remoteTable.name,
            where: remappedChild,
          },
        });
        continue;
      }
    }

    const pgName = columnMap.get(key) ?? key;
    result[pgName] = value;
  }

  // If we have aggregate/relationship filters, combine them with regular filters using _and
  if (aggregateFilters.length > 0) {
    const parts: BoolExp[] = [];
    if (Object.keys(result).length > 0) {
      parts.push(result as BoolExp);
    }
    for (const af of aggregateFilters) {
      parts.push(af as BoolExp);
    }
    if (parts.length === 1) return parts[0];
    return { _and: parts };
  }

  return result as BoolExp;
}

/**
 * Parse a direction string like 'asc', 'desc_nulls_first' etc.
 */
function parseDirection(direction: string): { direction: 'asc' | 'desc'; nulls?: 'first' | 'last' } {
  const parts = direction.toLowerCase().split('_');
  const dir = parts[0] === 'desc' ? 'desc' : 'asc';
  let nulls: 'first' | 'last' | undefined;
  if (parts.includes('nulls') && parts.includes('first')) {
    nulls = 'first';
  } else if (parts.includes('nulls') && parts.includes('last')) {
    nulls = 'last';
  }
  return { direction: dir, nulls };
}

/** Map of aggregate function camelCase name -> SQL function name */
const AGGREGATE_FN_MAP: Record<string, OrderByItem['aggregate'] extends { function: infer F } | undefined ? F : never> = {
  count: 'count',
  avg: 'avg',
  max: 'max',
  min: 'min',
  sum: 'sum',
  stddev: 'stddev',
  stddevPop: 'stddev_pop',
  stddevSamp: 'stddev_samp',
  varPop: 'var_pop',
  varSamp: 'var_samp',
  variance: 'variance',
};

/**
 * Convert camelCase orderBy args from GraphQL to the OrderByItem[] the SQL compiler expects.
 * Handles:
 * - Simple column ordering: { fieldName: 'asc' }
 * - Object relationship ordering: { relName: { remoteField: 'asc' } }
 * - Array aggregate ordering: { relNameAggregate: { count: 'desc' } }
 */
export function remapOrderBy(
  orderBy: Array<Record<string, unknown>> | undefined | null,
  columnMap: Map<string, string>,
  table?: TableInfo,
  allTables?: TableInfo[],
): OrderByItem[] | undefined {
  if (!orderBy || orderBy.length === 0) return undefined;

  const result: OrderByItem[] = [];

  // Build a lookup for computed field camelCase name → config
  const cfLookup = new Map<string, { functionName: string; schema: string }>();
  if (table?.computedFields) {
    for (const cf of table.computedFields) {
      cfLookup.set(toCamelCase(cf.name), {
        functionName: cf.function.name,
        schema: cf.function.schema ?? 'public',
      });
    }
  }

  for (const item of orderBy) {
    for (const [camelKey, value] of Object.entries(item)) {
      if (typeof value === 'string') {
        // Check if this is a computed field ordering
        const cfInfo = cfLookup.get(camelKey);
        if (cfInfo) {
          const { direction, nulls } = parseDirection(value);
          result.push({
            column: '',
            direction,
            nulls,
            computedField: cfInfo,
          });
          continue;
        }
        // Simple column ordering
        const pgName = columnMap.get(camelKey) ?? camelKey;
        const { direction, nulls } = parseDirection(value);
        result.push({ column: pgName, direction, nulls });
        continue;
      }

      if (typeof value === 'object' && value !== null && table && allTables) {
        const valueObj = value as Record<string, unknown>;

        // Check if this is an aggregate ordering (relNameAggregate)
        if (camelKey.endsWith('Aggregate')) {
          const relName = camelKey.slice(0, -'Aggregate'.length);
          const rel = table.relationships.find((r) => toCamelCase(r.name) === relName && r.type === 'array');
          if (!rel) continue;

          const remoteTable = allTables.find(
            (t) => t.name === rel.remoteTable.name && t.schema === rel.remoteTable.schema,
          );
          if (!remoteTable) continue;

          // Parse the aggregate ordering object
          for (const [aggFnName, aggValue] of Object.entries(valueObj)) {
            if (aggFnName === 'count' && typeof aggValue === 'string') {
              const { direction, nulls } = parseDirection(aggValue);
              result.push({
                column: '',
                direction,
                nulls,
                aggregate: {
                  config: rel,
                  remoteTable,
                  function: 'count',
                },
              });
            } else if (typeof aggValue === 'object' && aggValue !== null) {
              // Per-function aggregate: e.g., { avg: { balance: 'desc' } }
              const sqlFn = AGGREGATE_FN_MAP[aggFnName];
              if (!sqlFn) continue;

              const remoteColMap = camelToColumnMap(remoteTable);
              for (const [colCamel, colDir] of Object.entries(aggValue as Record<string, string>)) {
                const colPg = remoteColMap.get(colCamel) ?? colCamel;
                const { direction, nulls } = parseDirection(colDir);
                result.push({
                  column: '',
                  direction,
                  nulls,
                  aggregate: {
                    config: rel,
                    remoteTable,
                    function: sqlFn,
                    column: colPg,
                  },
                });
              }
            }
          }
          continue;
        }

        // Check if this is an object relationship ordering
        const rel = table.relationships.find((r) => toCamelCase(r.name) === camelKey && r.type === 'object');
        if (rel) {
          const remoteTable = allTables.find(
            (t) => t.name === rel.remoteTable.name && t.schema === rel.remoteTable.schema,
          );
          if (!remoteTable) continue;

          // Recursively remap the nested ordering
          const remoteColMap = camelToColumnMap(remoteTable);
          const nestedItems = remapOrderBy(
            [valueObj as Record<string, unknown>],
            remoteColMap,
            remoteTable,
            allTables,
          );

          if (nestedItems && nestedItems.length > 0) {
            for (const nested of nestedItems) {
              result.push({
                column: '',
                direction: nested.direction,
                nulls: nested.nulls,
                relationship: {
                  config: rel,
                  remoteTable,
                  orderByItem: nested,
                },
              });
            }
          }
          continue;
        }
      }
    }
  }

  return result.length > 0 ? result : undefined;
}

/**
 * Get all column names for a table, optionally filtered to allowed columns.
 */
export function getAllowedColumns(
  table: TableInfo,
  permColumns?: string[] | '*',
): string[] {
  const allColumns = table.columns.map((c) => c.name);
  if (!permColumns || permColumns === '*') return allColumns;
  return allColumns.filter((c) => permColumns.includes(c));
}

/**
 * Get all column names as the returning list for mutations.
 */
export function getReturningColumns(table: TableInfo): string[] {
  return table.columns.map((c) => c.name);
}

/**
 * Resolve the most restrictive limit among user-provided, permission-defined, and global max.
 */
export function resolveLimit(userLimit?: number, permLimit?: number, globalMaxLimit?: number): number | undefined {
  let limit: number | undefined;
  if (userLimit !== undefined && permLimit !== undefined) {
    limit = Math.min(userLimit, permLimit);
  } else {
    limit = userLimit ?? permLimit;
  }
  if (globalMaxLimit !== undefined && globalMaxLimit > 0) {
    if (limit !== undefined) {
      limit = Math.min(limit, globalMaxLimit);
    } else {
      limit = globalMaxLimit;
    }
  }
  return limit;
}

/**
 * Check if a column is a numeric type (for aggregate sum/avg).
 */
export const NUMERIC_PG_TYPES = new Set([
  'int2', 'int4', 'int8', 'serial', 'serial4', 'serial8', 'bigserial',
  'float4', 'float8', 'numeric', 'oid',
]);

export function isNumericColumn(column: ColumnInfo): boolean {
  return NUMERIC_PG_TYPES.has(column.udtName);
}

/**
 * Build ComputedFieldSelection[] from parsed computed field names + table config + schema functions.
 */
export function buildComputedFieldSelections(
  computedFieldNames: string[] | undefined,
  table: TableInfo,
  functions: FunctionInfo[],
  permComputedFields?: string[],
  isAdmin?: boolean,
  computedFieldArgs?: Map<string, Record<string, unknown>>,
): ComputedFieldSelection[] {
  if (!computedFieldNames || computedFieldNames.length === 0 || !table.computedFields) {
    return [];
  }

  const selections: ComputedFieldSelection[] = [];

  for (const cfName of computedFieldNames) {
    // Check permission: non-admin roles need computed field listed in permission
    if (!isAdmin && permComputedFields && !permComputedFields.includes(cfName)) {
      continue;
    }

    const cfConfig = table.computedFields.find((cf) => cf.name === cfName);
    if (!cfConfig) continue;

    const fnSchema = cfConfig.function.schema ?? 'public';
    const fn = functions.find(
      (f) => f.name === cfConfig.function.name && f.schema === fnSchema,
    );
    if (!fn) continue;

    // Skip set-returning functions — handled by buildSetReturningComputedFieldSelections
    if (fn.isSetReturning) continue;

    // Build args map from user-provided arguments (camelCase → snake_case)
    let argsMap: Map<string, unknown> | undefined;
    const cfArgsRaw = computedFieldArgs?.get(cfName);
    if (cfArgsRaw && Object.keys(cfArgsRaw).length > 0) {
      argsMap = new Map();
      // Build a camelCase → snake_case mapping for function arg names
      // (skipping the table row arg and session arg)
      const tableArgName = cfConfig.tableArgument;
      const sessionArgName = cfConfig.sessionArgument;
      for (let i = 0; i < fn.argNames.length; i++) {
        const argName = fn.argNames[i];
        if (argName === tableArgName) continue;
        if (sessionArgName && argName === sessionArgName) continue;
        const camelName = toCamelCase(argName);
        if (camelName in cfArgsRaw) {
          argsMap.set(argName, cfArgsRaw[camelName]);
        }
      }
      if (argsMap.size === 0) argsMap = undefined;
    }

    selections.push({
      config: cfConfig,
      functionInfo: fn,
      sessionArgument: cfConfig.sessionArgument,
      args: argsMap,
    });
  }

  return selections;
}

/**
 * Build SetReturningComputedFieldSelection[] from parsed set-returning computed fields.
 */
export function buildSetReturningComputedFieldSelections(
  parsed: SetReturningComputedFieldParsed[] | undefined,
  table: TableInfo,
  functions: FunctionInfo[],
  permComputedFields?: string[],
  isAdmin?: boolean,
): SetReturningComputedFieldSelection[] {
  if (!parsed || parsed.length === 0) return [];

  const result: SetReturningComputedFieldSelection[] = [];

  for (const srcf of parsed) {
    // Check computed field permission on the parent table
    if (!isAdmin && permComputedFields && !permComputedFields.includes(srcf.name)) {
      continue;
    }

    const cfConfig = table.computedFields?.find((cf) => cf.name === srcf.name);
    if (!cfConfig) continue;

    const fnSchema = cfConfig.function.schema ?? 'public';
    const fn = functions.find(
      (f) => f.name === cfConfig.function.name && f.schema === fnSchema,
    );
    if (!fn) continue;

    // Build nested scalar computed field selections for the return table
    const nestedComputedFields = buildComputedFieldSelections(
      srcf.computedFields,
      srcf.remoteTable,
      functions,
      undefined,
      isAdmin,
    );

    // Recursively build nested set-returning computed field selections
    const nestedSetReturning = buildSetReturningComputedFieldSelections(
      srcf.setReturningComputedFields,
      srcf.remoteTable,
      functions,
      undefined,
      isAdmin,
    );

    result.push({
      config: cfConfig,
      functionInfo: fn,
      remoteTable: srcf.remoteTable,
      columns: srcf.columns,
      where: srcf.where,
      orderBy: srcf.orderBy,
      limit: srcf.limit,
      offset: srcf.offset,
      relationships: srcf.relationships.length > 0 ? srcf.relationships : undefined,
      computedFields: nestedComputedFields.length > 0 ? nestedComputedFields : undefined,
      setReturningComputedFields: nestedSetReturning.length > 0 ? nestedSetReturning : undefined,
      jsonbPaths: srcf.jsonbPaths,
      permission: srcf.permission,
    });
  }

  return result;
}

/**
 * Build AggregateRelationshipSelection[] from parsed aggregate relationship info.
 *
 * Converts the parse-time AggregateRelationshipParsed into the SQL compiler's
 * AggregateRelationshipSelection format, adding the session and building
 * the aggregate selection (count + numeric column aggregates).
 */
export function buildAggregateRelationshipSelections(
  parsed: AggregateRelationshipParsed[] | undefined,
  session: SessionVariables,
): AggregateRelationshipSelection[] {
  if (!parsed || parsed.length === 0) return [];

  const result: AggregateRelationshipSelection[] = [];

  for (const aggRel of parsed) {
    const aggregate: AggregateSelection = { count: {} };

    // Populate sum/avg/min/max with all numeric columns from the remote table
    // so that nested aggregate queries like { invoicesAggregate { aggregate { sum { amount } } } }
    // produce the correct SQL with aggregate functions for those columns.
    const numericCols = aggRel.remoteTable.columns
      .filter((c) => isNumericColumn(c))
      .map((c) => c.name);
    if (numericCols.length > 0) {
      aggregate.sum = numericCols;
      aggregate.avg = numericCols;
      aggregate.min = numericCols;
      aggregate.max = numericCols;
      aggregate.stddev = numericCols;
      aggregate.stddevPop = numericCols;
      aggregate.stddevSamp = numericCols;
      aggregate.variance = numericCols;
      aggregate.varPop = numericCols;
      aggregate.varSamp = numericCols;
    }

    result.push({
      relationship: aggRel.relationship,
      fieldName: aggRel.fieldName,
      remoteTable: aggRel.remoteTable,
      aggregate,
      where: aggRel.where,
      permission: aggRel.permission,
      session,
    });
  }

  return result;
}

/**
 * Remap row keys from snake_case to camelCase for GraphQL response.
 */
export function remapRowToCamel(
  row: Record<string, unknown>,
  table: TableInfo,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const col of table.columns) {
    if (col.name in row) {
      result[table.customColumnNames?.[col.name] ?? toCamelCase(col.name)] = row[col.name];
    }
  }
  // Preserve any extra keys (e.g., relationship subquery results and computed fields
  // already use the right name)
  for (const [key, value] of Object.entries(row)) {
    const camelKey = toCamelCase(key);
    if (!(camelKey in result)) {
      result[camelKey] = value;
    }
  }
  return result;
}

/**
 * Remap an array of rows from snake_case to camelCase.
 */
export function remapRowsToCamel(
  rows: Record<string, unknown>[],
  table: TableInfo,
): Record<string, unknown>[] {
  return rows.map((row) => remapRowToCamel(row, table));
}
