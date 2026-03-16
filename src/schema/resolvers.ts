/**
 * Resolver factory functions for GraphQL query/mutation/subscription fields.
 *
 * Each factory produces a resolver that:
 * 1. Extracts auth context (SessionVariables) from the request
 * 2. Looks up permissions for the active role
 * 3. Delegates to the SQL compiler to build a parameterized query
 * 4. Executes the query with session variable injection
 * 5. Returns the result
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
} from '../types.js';
import type { Pool } from 'pg';
import type { QueryCache } from '../sql/cache.js';
import type { SubscriptionManager } from '../subscriptions/manager.js';
import type { JobQueue } from '../shared/job-queue/types.js';
import { compileSelect, compileSelectByPk, compileSelectAggregate } from '../sql/select.js';
import type { OrderByItem, AggregateSelection, AggregateComputedFieldRef, ComputedFieldSelection, SetReturningComputedFieldSelection } from '../sql/select.js';
import { compileInsertOne, compileInsert } from '../sql/insert.js';
import { compileUpdateByPk, compileUpdate, compileUpdateMany } from '../sql/update.js';
import { compileDeleteByPk, compileDelete } from '../sql/delete.js';
import { toCamelCase } from './type-builder.js';
import { parseResolveInfo, parseReturningInfo, parseAggregateNodesInfo, type SetReturningComputedFieldParsed } from './resolve-info.js';

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

function permissionDenied(operation: string, table: string, role: string): Error {
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
function camelToColumnMap(table: TableInfo): Map<string, string> {
  const map = new Map<string, string>();
  for (const col of table.columns) {
    map.set(toCamelCase(col.name), col.name);
  }
  return map;
}

/**
 * Build a mapping of camelCase field names → snake_case names for columns AND computed fields.
 * Used by remapBoolExp and remapOrderBy so that computed field names are correctly remapped.
 */
function camelToColumnAndCFMap(table: TableInfo): Map<string, string> {
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
function remapKeys(
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
        aggRelMap.set(`${toCamelCase(rel.name)}Aggregate`, rel);
      }
    }
  }

  // Build a map of relationship name -> relationship config for traversal filters
  const relMap = new Map<string, TableInfo['relationships'][number]>();
  if (table) {
    for (const rel of table.relationships) {
      relMap.set(toCamelCase(rel.name), rel);
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
function remapOrderBy(
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
function getAllowedColumns(
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
function getReturningColumns(table: TableInfo): string[] {
  return table.columns.map((c) => c.name);
}

/**
 * Resolve the most restrictive limit among user-provided, permission-defined, and global max.
 */
function resolveLimit(userLimit?: number, permLimit?: number, globalMaxLimit?: number): number | undefined {
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
const NUMERIC_PG_TYPES = new Set([
  'int2', 'int4', 'int8', 'serial', 'serial4', 'serial8', 'bigserial',
  'float4', 'float8', 'numeric', 'oid',
]);

function isNumericColumn(column: ColumnInfo): boolean {
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
 * Remap row keys from snake_case to camelCase for GraphQL response.
 */
function remapRowToCamel(
  row: Record<string, unknown>,
  table: TableInfo,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const col of table.columns) {
    if (col.name in row) {
      result[toCamelCase(col.name)] = row[col.name];
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
function remapRowsToCamel(
  rows: Record<string, unknown>[],
  table: TableInfo,
): Record<string, unknown>[] {
  return rows.map((row) => remapRowToCamel(row, table));
}

// ─── Select Resolver ────────────────────────────────────────────────────────

/**
 * Creates a resolver for the `<table>` (select many) query field.
 *
 * Arguments: where, orderBy, limit, offset
 * Returns: [<Type>!]!
 */
export function makeSelectResolver(
  table: TableInfo,
): GraphQLFieldResolver<unknown, ResolverContext> {
  const columnMap = camelToColumnAndCFMap(table);

  return async (_parent, args, context, info) => {
    const { auth, queryWithSession, permissionLookup } = context;
    const perm = permissionLookup.getSelect(table.schema, table.name, auth.role);

    if (!perm && !auth.isAdmin) {
      throw permissionDenied('select', `${table.schema}.${table.name}`, auth.role);
    }

    // Check query root field visibility
    if (!auth.isAdmin && !isQueryRootFieldAllowed(perm, 'select')) {
      throw permissionDenied('select', `${table.schema}.${table.name}`, auth.role);
    }

    // Parse resolve info to extract requested columns and relationships
    const parsed = parseResolveInfo(info, table, context.tables, permissionLookup, auth, context.functions);
    const columns = parsed.columns.length > 0 ? parsed.columns : getAllowedColumns(table, perm?.columns);

    // Build computed field selections (with user-provided args)
    const computedFields = buildComputedFieldSelections(
      parsed.computedFields,
      table,
      context.functions,
      perm?.computedFields,
      auth.isAdmin,
      parsed.computedFieldArgs,
    );

    // Build set-returning computed field selections
    const setReturningComputedFields = buildSetReturningComputedFieldSelections(
      parsed.setReturningComputedFields,
      table,
      context.functions,
      perm?.computedFields,
      auth.isAdmin,
    );

    const where = remapBoolExp(args.where as BoolExp | undefined, columnMap, table, context.tables);
    const orderBy = remapOrderBy(
      args.orderBy as Array<Record<string, unknown>> | undefined,
      columnMap, table, context.tables,
    );
    const limit = resolveLimit(args.limit as number | undefined, perm?.limit, context.graphqlMaxLimit);

    // Extract distinctOn — enum values resolve to PG column names directly
    const rawDistinctOn = args.distinctOn as string[] | undefined;
    let distinctOn: string[] | undefined;
    if (rawDistinctOn && rawDistinctOn.length > 0) {
      // Filter distinct_on columns against permitted columns
      const allowedColumns = perm?.columns === '*'
        ? table.columns.map((c) => c.name)
        : (perm?.columns ?? table.columns.map((c) => c.name));
      distinctOn = rawDistinctOn.filter((col) => allowedColumns.includes(col));
      if (distinctOn.length === 0) distinctOn = undefined;
    }

    const compiled = compileSelect({
      table,
      columns,
      where,
      orderBy,
      distinctOn,
      limit,
      offset: args.offset as number | undefined,
      relationships: parsed.relationships,
      computedFields: computedFields.length > 0 ? computedFields : undefined,
      setReturningComputedFields: setReturningComputedFields.length > 0 ? setReturningComputedFields : undefined,
      jsonbPaths: parsed.jsonbPaths,
      permission: perm ? {
        filter: perm.filter,
        columns: perm.columns,
        limit: perm.limit,
      } : undefined,
      session: auth,
    });

    const result = await queryWithSession(compiled.sql, compiled.params, auth, 'read');

    // compileSelect wraps results in json_agg → single row with "data" column
    const data = (result.rows[0] as Record<string, unknown> | undefined)?.data;
    if (!data || !Array.isArray(data)) return [];

    // The SQL compiler already shapes results with snake_case column names as JSON keys.
    // We need to remap them to camelCase for GraphQL.
    return remapRowsToCamel(data as Record<string, unknown>[], table);
  };
}

// ─── Select By PK Resolver ──────────────────────────────────────────────────

/**
 * Creates a resolver for the `<table>ByPk` (select by primary key) query field.
 *
 * Arguments: one argument per PK column (camelCase)
 * Returns: <Type> (nullable)
 */
export function makeSelectByPkResolver(
  table: TableInfo,
): GraphQLFieldResolver<unknown, ResolverContext> {
  const columnMap = camelToColumnMap(table);

  return async (_parent, args, context, info) => {
    const { auth, queryWithSession, permissionLookup } = context;
    const perm = permissionLookup.getSelect(table.schema, table.name, auth.role);

    if (!perm && !auth.isAdmin) {
      throw permissionDenied('select', `${table.schema}.${table.name}`, auth.role);
    }

    // Check query root field visibility
    if (!auth.isAdmin && !isQueryRootFieldAllowed(perm, 'select_by_pk')) {
      throw permissionDenied('select', `${table.schema}.${table.name}`, auth.role);
    }

    // Build PK values from camelCase args → snake_case column names
    const pkValues = remapKeys(args as Record<string, unknown>, columnMap) ?? {};

    // Parse resolve info to extract requested columns and relationships
    const parsed = parseResolveInfo(info, table, context.tables, permissionLookup, auth, context.functions);
    const columns = parsed.columns.length > 0 ? parsed.columns : getAllowedColumns(table, perm?.columns);

    // Build computed field selections (with user-provided args)
    const computedFields = buildComputedFieldSelections(
      parsed.computedFields,
      table,
      context.functions,
      perm?.computedFields,
      auth.isAdmin,
      parsed.computedFieldArgs,
    );

    // Build set-returning computed field selections
    const setReturningComputedFields = buildSetReturningComputedFieldSelections(
      parsed.setReturningComputedFields,
      table,
      context.functions,
      perm?.computedFields,
      auth.isAdmin,
    );

    const compiled = compileSelectByPk({
      table,
      pkValues,
      columns,
      relationships: parsed.relationships,
      computedFields: computedFields.length > 0 ? computedFields : undefined,
      setReturningComputedFields: setReturningComputedFields.length > 0 ? setReturningComputedFields : undefined,
      jsonbPaths: parsed.jsonbPaths,
      permission: perm ? {
        filter: perm.filter,
        columns: perm.columns,
      } : undefined,
      session: auth,
    });

    const result = await queryWithSession(compiled.sql, compiled.params, auth, 'read');

    // compileSelectByPk returns a single row with json_build_object in "data" column
    const data = (result.rows[0] as Record<string, unknown> | undefined)?.data;
    if (!data || typeof data !== 'object') return null;

    return remapRowToCamel(data as Record<string, unknown>, table);
  };
}

// ─── Select Aggregate Resolver ──────────────────────────────────────────────

/**
 * Creates a resolver for the `<table>Aggregate` query field.
 *
 * Arguments: where, orderBy, limit, offset
 * Returns: <Type>Aggregate { aggregate, nodes }
 */
export function makeSelectAggregateResolver(
  table: TableInfo,
): GraphQLFieldResolver<unknown, ResolverContext> {
  const columnMap = camelToColumnAndCFMap(table);

  return async (_parent, args, context, info) => {
    const { auth, queryWithSession, permissionLookup } = context;
    const perm = permissionLookup.getSelect(table.schema, table.name, auth.role);

    if (!perm && !auth.isAdmin) {
      throw permissionDenied('select', `${table.schema}.${table.name}`, auth.role);
    }

    // Check query root field visibility
    if (!auth.isAdmin && !isQueryRootFieldAllowed(perm, 'select_aggregate')) {
      throw permissionDenied('select', `${table.schema}.${table.name}`, auth.role);
    }

    if (perm && !perm.allowAggregations && !auth.isAdmin) {
      throw new Error(
        `Aggregations not allowed for role "${auth.role}" on "${table.schema}.${table.name}"`,
      );
    }

    // Parse resolve info for the "nodes" sub-selection to extract relationships
    const nodesParsed = parseAggregateNodesInfo(info, table, context.tables, permissionLookup, auth, context.functions);
    const columns = nodesParsed?.columns.length
      ? nodesParsed.columns
      : getAllowedColumns(table, perm?.columns);
    const nodeRelationships = nodesParsed?.relationships ?? [];

    const where = remapBoolExp(args.where as BoolExp | undefined, columnMap, table, context.tables);
    const orderBy = remapOrderBy(
      args.orderBy as Array<Record<string, unknown>> | undefined,
      columnMap, table, context.tables,
    );
    const limit = resolveLimit(args.limit as number | undefined, perm?.limit, context.graphqlMaxLimit);

    // Extract groupBy — enum values resolve to PG column names directly
    const rawGroupBy = args.groupBy as string[] | undefined;
    let groupBy: string[] | undefined;
    if (rawGroupBy && rawGroupBy.length > 0) {
      // Filter groupBy columns against permitted columns
      const allowedColumns = perm?.columns === '*'
        ? table.columns.map((c) => c.name)
        : (perm?.columns ?? table.columns.map((c) => c.name));
      groupBy = rawGroupBy.filter((col) => allowedColumns.includes(col));
      if (groupBy.length === 0) groupBy = undefined;
    }

    // Build aggregate selection — request count + sum/avg/min/max for numeric columns
    const aggregate: AggregateSelection = { count: {} };

    // Build computed field refs for aggregation
    const numericCFRefs: AggregateComputedFieldRef[] = [];
    if (table.computedFields) {
      for (const cf of table.computedFields) {
        const fnSchema = cf.function.schema ?? 'public';
        const fn = context.functions.find(
          (f) => f.name === cf.function.name && f.schema === fnSchema,
        );
        if (!fn || fn.isSetReturning) continue;
        const NUMERIC_PG_RETURN = new Set(['int2', 'int4', 'int8', 'float4', 'float8', 'numeric', 'serial', 'serial4', 'serial8', 'bigserial', 'oid']);
        if (NUMERIC_PG_RETURN.has(fn.returnType)) {
          numericCFRefs.push({ name: cf.name, functionName: cf.function.name, schema: fnSchema });
        }
      }
    }

    // When groupBy is present, also request sum/avg/stddev/variance for numeric columns
    if (groupBy) {
      const numericCols = table.columns
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
      // Add numeric computed fields to group-by aggregates
      if (numericCFRefs.length > 0) {
        aggregate.computedFields = {
          sum: numericCFRefs,
          avg: numericCFRefs,
          min: numericCFRefs,
          max: numericCFRefs,
          stddev: numericCFRefs,
          stddevPop: numericCFRefs,
          stddevSamp: numericCFRefs,
          variance: numericCFRefs,
          varPop: numericCFRefs,
          varSamp: numericCFRefs,
        };
      }
    }

    if (groupBy) {
      // Grouped aggregate path
      const compiled = compileSelectAggregate({
        table,
        where,
        aggregate,
        groupBy,
        permission: perm ? {
          filter: perm.filter,
          columns: perm.columns,
          limit: perm.limit,
        } : undefined,
        session: auth,
      });

      const result = await queryWithSession(compiled.sql, compiled.params, auth, 'read');

      const row = result.rows[0] as Record<string, unknown> | undefined;
      if (!row) {
        return { aggregate: { count: 0 }, nodes: [], groupedAggregates: [] };
      }

      const groupedData = row.groupedAggregates as Record<string, unknown>[] | undefined;

      // Remap keys from snake_case to camelCase
      const remappedGroups = (groupedData ?? []).map((group) => {
        const keys = group.keys as Record<string, unknown> | undefined;
        const remappedKeys: Record<string, unknown> = {};
        if (keys) {
          for (const [k, v] of Object.entries(keys)) {
            remappedKeys[toCamelCase(k)] = v;
          }
        }

        const result: Record<string, unknown> = { keys: remappedKeys };

        // Pass through aggregate fields (count, sum, avg, min, max, stddev, variance family)
        if ('count' in group) result.count = group.count;
        for (const aggKey of ['sum', 'avg', 'min', 'max', 'stddev', 'stddevPop', 'stddevSamp', 'variance', 'varPop', 'varSamp'] as const) {
          if (group[aggKey]) {
            const obj = group[aggKey] as Record<string, unknown>;
            const remapped: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(obj)) {
              remapped[toCamelCase(k)] = v;
            }
            result[aggKey] = remapped;
          }
        }

        return result;
      });

      return {
        aggregate: { count: 0 },
        nodes: [],
        groupedAggregates: remappedGroups,
      };
    }

    // Standard (non-grouped) aggregate path
    const compiled = compileSelectAggregate({
      table,
      where,
      aggregate,
      nodes: {
        columns,
        relationships: nodeRelationships,
        orderBy,
        limit,
        offset: args.offset as number | undefined,
      },
      permission: perm ? {
        filter: perm.filter,
        columns: perm.columns,
        limit: perm.limit,
      } : undefined,
      session: auth,
    });

    const result = await queryWithSession(compiled.sql, compiled.params, auth, 'read');

    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      return { aggregate: { count: 0 }, nodes: [] };
    }

    // Parse aggregate and nodes from the SQL result
    const aggData = row.aggregate as Record<string, unknown> | undefined;
    const nodesData = row.nodes as Record<string, unknown>[] | undefined;

    return {
      aggregate: aggData ?? { count: 0 },
      nodes: nodesData ? remapRowsToCamel(nodesData, table) : [],
    };
  };
}

// ─── Insert Resolver ────────────────────────────────────────────────────────

/**
 * Creates a resolver for the `insert_<table>` mutation field.
 *
 * Arguments: objects (required), onConflict (optional)
 * Returns: <Type>MutationResponse { affectedRows, returning }
 */
export function makeInsertResolver(
  table: TableInfo,
): GraphQLFieldResolver<unknown, ResolverContext> {
  const columnMap = camelToColumnMap(table);

  return async (_parent, args, context, info) => {
    const { auth, queryWithSession, permissionLookup } = context;
    const perm = permissionLookup.getInsert(table.schema, table.name, auth.role);

    if (!perm && !auth.isAdmin) {
      throw permissionDenied('insert', `${table.schema}.${table.name}`, auth.role);
    }

    // Enforce backend_only: the insert is only allowed from admin-secret-authenticated
    // clients or requests with the x-hasura-use-backend-only-permissions header
    if (perm?.backendOnly && !auth.useBackendOnlyPermissions) {
      throw new Error(
        `Permission denied: insert on "${table.schema}"."${table.name}" for role "${auth.role}" is backend_only`,
      );
    }

    const rawObjects = args.objects as Record<string, unknown>[];
    const objects = rawObjects.map((obj) => remapKeys(obj, columnMap) ?? {});

    if (objects.length === 0) {
      return { affectedRows: 0, returning: [] };
    }

    const returningColumns = getReturningColumns(table);

    // Parse returning selection set for relationships and computed fields
    const returningParsed = parseReturningInfo(info, table, context.tables, permissionLookup, auth, context.functions);
    const returningRelationships = returningParsed?.relationships && returningParsed.relationships.length > 0
      ? returningParsed.relationships
      : undefined;

    // Build computed field selections (use select permission for returning clause access)
    const selectPerm = permissionLookup.getSelect(table.schema, table.name, auth.role);
    const returningComputedFields = buildComputedFieldSelections(
      returningParsed?.computedFields,
      table,
      context.functions,
      selectPerm?.computedFields,
      auth.isAdmin,
    );

    // Build set-returning computed field selections
    const returningSetReturningComputedFields = buildSetReturningComputedFieldSelections(
      returningParsed?.setReturningComputedFields,
      table,
      context.functions,
      selectPerm?.computedFields,
      auth.isAdmin,
    );

    // Parse onConflict if provided
    let onConflict: { constraint: string; updateColumns: string[]; where?: BoolExp } | undefined;
    if (args.onConflict) {
      const oc = args.onConflict as Record<string, unknown>;
      const updateCols = (oc.updateColumns as string[] | undefined) ?? [];
      // UpdateColumn enum resolves to PG column names; remap any remaining camelCase names
      const remappedUpdateCols = updateCols.map((c) => columnMap.get(c) ?? c);
      onConflict = {
        constraint: oc.constraint as string,
        updateColumns: remappedUpdateCols,
        where: oc.where ? remapBoolExp(oc.where as BoolExp, columnMap) : undefined,
      };
    }

    const compiled = compileInsert({
      table,
      objects,
      returningColumns,
      returningRelationships,
      returningComputedFields: returningComputedFields.length > 0 ? returningComputedFields : undefined,
      returningSetReturningComputedFields: returningSetReturningComputedFields.length > 0 ? returningSetReturningComputedFields : undefined,
      returningJsonbPaths: returningParsed?.jsonbPaths,
      onConflict,
      permission: perm ? {
        check: perm.check,
        columns: perm.columns,
        presets: perm.presets,
      } : undefined,
      session: auth,
    });

    const result = await queryWithSession(compiled.sql, compiled.params, auth, 'write');

    // CTE pattern (check OR relationships/computedFields/jsonbPaths): single row with "data" as JSON array
    // Simple pattern: RETURNING json_build_object → "data" column per row
    const usesCTE = !!(perm?.check || returningRelationships || returningParsed?.jsonbPaths?.size
      || returningComputedFields.length > 0 || returningSetReturningComputedFields.length > 0);
    const firstRow = result.rows[0] as Record<string, unknown> | undefined;

    if (usesCTE) {
      const data = firstRow?.data;
      if (!data || !Array.isArray(data)) {
        // If the check filter eliminates all rows, it means the insert was done
        // but the check failed — this should be an error
        if (perm?.check && result.rowCount === 0 && objects.length > 0) {
          throw new Error(
            `Insert check constraint failed for "${table.schema}"."${table.name}"`,
          );
        }
        return { affectedRows: 0, returning: [] };
      }
      return {
        affectedRows: data.length,
        returning: remapRowsToCamel(data as Record<string, unknown>[], table),
      };
    }

    // Simple pattern: each row has a "data" column with json_build_object
    const returning = result.rows.map((row) => {
      const r = row as Record<string, unknown>;
      const data = r.data as Record<string, unknown> | undefined;
      return data ? remapRowToCamel(data, table) : {};
    });

    return {
      affectedRows: returning.length,
      returning,
    };
  };
}

// ─── Insert One Resolver ────────────────────────────────────────────────────

/**
 * Creates a resolver for the `insert_<table>_one` mutation field.
 *
 * Arguments: object (required), onConflict (optional)
 * Returns: <Type> (nullable)
 */
export function makeInsertOneResolver(
  table: TableInfo,
): GraphQLFieldResolver<unknown, ResolverContext> {
  const columnMap = camelToColumnMap(table);

  return async (_parent, args, context, info) => {
    const { auth, queryWithSession, permissionLookup } = context;
    const perm = permissionLookup.getInsert(table.schema, table.name, auth.role);

    if (!perm && !auth.isAdmin) {
      throw permissionDenied('insert', `${table.schema}.${table.name}`, auth.role);
    }

    // Enforce backend_only: the insert is only allowed from admin-secret-authenticated
    // clients or requests with the x-hasura-use-backend-only-permissions header
    if (perm?.backendOnly && !auth.useBackendOnlyPermissions) {
      throw new Error(
        `Permission denied: insert on "${table.schema}"."${table.name}" for role "${auth.role}" is backend_only`,
      );
    }

    const obj = remapKeys(args.object as Record<string, unknown>, columnMap) ?? {};
    const returningColumns = getReturningColumns(table);

    // Parse resolve info for relationships and computed fields (insertOne returns the type directly)
    const parsed = parseResolveInfo(info, table, context.tables, permissionLookup, auth, context.functions);
    const returningRelationships = parsed.relationships.length > 0
      ? parsed.relationships
      : undefined;

    // Build computed field selections (use select permission for returning clause access)
    const selectPerm = permissionLookup.getSelect(table.schema, table.name, auth.role);
    const returningComputedFields = buildComputedFieldSelections(
      parsed.computedFields,
      table,
      context.functions,
      selectPerm?.computedFields,
      auth.isAdmin,
    );

    // Build set-returning computed field selections
    const returningSetReturningComputedFields = buildSetReturningComputedFieldSelections(
      parsed.setReturningComputedFields,
      table,
      context.functions,
      selectPerm?.computedFields,
      auth.isAdmin,
    );

    // Parse onConflict if provided
    let onConflict: { constraint: string; updateColumns: string[]; where?: BoolExp } | undefined;
    if (args.onConflict) {
      const oc = args.onConflict as Record<string, unknown>;
      const updateCols = (oc.updateColumns as string[] | undefined) ?? [];
      // UpdateColumn enum resolves to PG column names; remap any remaining camelCase names
      const remappedUpdateCols = updateCols.map((c) => columnMap.get(c) ?? c);
      onConflict = {
        constraint: oc.constraint as string,
        updateColumns: remappedUpdateCols,
        where: oc.where ? remapBoolExp(oc.where as BoolExp, columnMap) : undefined,
      };
    }

    const compiled = compileInsertOne({
      table,
      object: obj,
      returningColumns,
      returningRelationships,
      returningComputedFields: returningComputedFields.length > 0 ? returningComputedFields : undefined,
      returningSetReturningComputedFields: returningSetReturningComputedFields.length > 0 ? returningSetReturningComputedFields : undefined,
      returningJsonbPaths: parsed.jsonbPaths,
      onConflict,
      permission: perm ? {
        check: perm.check,
        columns: perm.columns,
        presets: perm.presets,
      } : undefined,
      session: auth,
    });

    const result = await queryWithSession(compiled.sql, compiled.params, auth, 'write');

    // Both CTE and simple patterns return a "data" column with json_build_object
    const firstRow = result.rows[0] as Record<string, unknown> | undefined;
    const data = firstRow?.data;
    if (!data || typeof data !== 'object') {
      // If permission check failed, the CTE returns 0 rows
      if (perm?.check && result.rowCount === 0) {
        throw new Error(
          `Insert check constraint failed for "${table.schema}"."${table.name}"`,
        );
      }
      return null;
    }

    return remapRowToCamel(data as Record<string, unknown>, table);
  };
}

// ─── Update Resolver ────────────────────────────────────────────────────────

/**
 * Creates a resolver for the `update_<table>` mutation field.
 *
 * Arguments: where (required), _set (optional)
 * Returns: <Type>MutationResponse
 */
export function makeUpdateResolver(
  table: TableInfo,
): GraphQLFieldResolver<unknown, ResolverContext> {
  const columnMap = camelToColumnMap(table);

  return async (_parent, args, context, info) => {
    const { auth, queryWithSession, permissionLookup } = context;
    const perm = permissionLookup.getUpdate(table.schema, table.name, auth.role);

    if (!perm && !auth.isAdmin) {
      throw permissionDenied('update', `${table.schema}.${table.name}`, auth.role);
    }

    const setValues = remapKeys(args._set as Record<string, unknown> | undefined, columnMap);
    if (!setValues || Object.keys(setValues).length === 0) {
      return { affectedRows: 0, returning: [] };
    }

    const where = remapBoolExp(args.where as BoolExp | undefined, columnMap, table, context.tables) ?? ({} as BoolExp);
    const returningColumns = getReturningColumns(table);

    // Parse returning selection set for relationships and computed fields
    const returningParsed = parseReturningInfo(info, table, context.tables, permissionLookup, auth, context.functions);
    const returningRelationships = returningParsed?.relationships && returningParsed.relationships.length > 0
      ? returningParsed.relationships
      : undefined;

    // Build computed field selections (use select permission for returning clause access)
    const updateSelectPerm = permissionLookup.getSelect(table.schema, table.name, auth.role);
    const returningComputedFields = buildComputedFieldSelections(
      returningParsed?.computedFields,
      table,
      context.functions,
      updateSelectPerm?.computedFields,
      auth.isAdmin,
    );

    const compiled = compileUpdate({
      table,
      where,
      _set: setValues,
      returningColumns,
      returningRelationships,
      returningComputedFields: returningComputedFields.length > 0 ? returningComputedFields : undefined,
      returningJsonbPaths: returningParsed?.jsonbPaths,
      permission: perm ? {
        filter: perm.filter,
        check: perm.check,
        columns: perm.columns,
        presets: perm.presets,
      } : undefined,
      session: auth,
    });

    const result = await queryWithSession(compiled.sql, compiled.params, auth, 'write');

    // CTE pattern (check OR relationships, jsonbPaths, or computedFields): single row with "data" as JSON array
    // Without CTE: each row has a "data" column
    const usesCTE = !!(perm?.check || returningRelationships || returningParsed?.jsonbPaths?.size
      || returningComputedFields.length > 0);
    if (usesCTE) {
      const firstRow = result.rows[0] as Record<string, unknown> | undefined;
      const data = firstRow?.data;
      if (!data || !Array.isArray(data)) {
        return { affectedRows: 0, returning: [] };
      }
      return {
        affectedRows: data.length,
        returning: remapRowsToCamel(data as Record<string, unknown>[], table),
      };
    }

    const returning = result.rows.map((row) => {
      const r = row as Record<string, unknown>;
      const data = r.data as Record<string, unknown> | undefined;
      return data ? remapRowToCamel(data, table) : {};
    });

    return {
      affectedRows: returning.length,
      returning,
    };
  };
}

// ─── Update By PK Resolver ──────────────────────────────────────────────────

/**
 * Creates a resolver for the `update_<table>_by_pk` mutation field.
 *
 * Arguments: pkColumns (required), _set (required)
 * Returns: <Type> (nullable)
 */
export function makeUpdateByPkResolver(
  table: TableInfo,
): GraphQLFieldResolver<unknown, ResolverContext> {
  const columnMap = camelToColumnMap(table);

  return async (_parent, args, context, info) => {
    const { auth, queryWithSession, permissionLookup } = context;
    const perm = permissionLookup.getUpdate(table.schema, table.name, auth.role);

    if (!perm && !auth.isAdmin) {
      throw permissionDenied('update', `${table.schema}.${table.name}`, auth.role);
    }

    const pkValues = remapKeys(args.pkColumns as Record<string, unknown>, columnMap) ?? {};
    const setValues = remapKeys(args._set as Record<string, unknown> | undefined, columnMap);

    if (!setValues || Object.keys(setValues).length === 0) {
      return null;
    }

    const returningColumns = getReturningColumns(table);

    // Parse resolve info for relationships and computed fields (updateByPk returns the type directly)
    const parsed = parseResolveInfo(info, table, context.tables, permissionLookup, auth, context.functions);
    const returningRelationships = parsed.relationships.length > 0
      ? parsed.relationships
      : undefined;

    // Build computed field selections (use select permission for returning clause access)
    const updateByPkSelectPerm = permissionLookup.getSelect(table.schema, table.name, auth.role);
    const returningComputedFields = buildComputedFieldSelections(
      parsed.computedFields,
      table,
      context.functions,
      updateByPkSelectPerm?.computedFields,
      auth.isAdmin,
    );

    const compiled = compileUpdateByPk({
      table,
      pkValues,
      _set: setValues,
      returningColumns,
      returningRelationships,
      returningComputedFields: returningComputedFields.length > 0 ? returningComputedFields : undefined,
      returningJsonbPaths: parsed.jsonbPaths,
      permission: perm ? {
        filter: perm.filter,
        check: perm.check,
        columns: perm.columns,
        presets: perm.presets,
      } : undefined,
      session: auth,
    });

    const result = await queryWithSession(compiled.sql, compiled.params, auth, 'write');

    const firstRow = result.rows[0] as Record<string, unknown> | undefined;
    const data = firstRow?.data;
    if (!data || typeof data !== 'object') return null;

    return remapRowToCamel(data as Record<string, unknown>, table);
  };
}

// ─── Update Many Resolver ────────────────────────────────────────────────────

/**
 * Creates a resolver for the `update<Table>Many` mutation field.
 *
 * Arguments: updates (required) — array of { where, _set }
 * Returns: <Type>MutationResponse { affectedRows, returning }
 */
export function makeUpdateManyResolver(
  table: TableInfo,
): GraphQLFieldResolver<unknown, ResolverContext> {
  const columnMap = camelToColumnMap(table);

  return async (_parent, args, context, info) => {
    const { auth, queryWithSession, permissionLookup } = context;
    const perm = permissionLookup.getUpdate(table.schema, table.name, auth.role);

    if (!perm && !auth.isAdmin) {
      throw permissionDenied('update', `${table.schema}.${table.name}`, auth.role);
    }

    const rawUpdates = args.updates as Array<{ where: Record<string, unknown>; _set: Record<string, unknown> }>;
    if (!rawUpdates || rawUpdates.length === 0) {
      return { affectedRows: 0, returning: [] };
    }

    const returningColumns = getReturningColumns(table);

    // Parse returning selection set for relationships
    const returningParsed = parseReturningInfo(info, table, context.tables, permissionLookup, auth);
    const returningRelationships = returningParsed?.relationships && returningParsed.relationships.length > 0
      ? returningParsed.relationships
      : undefined;

    // Compile each update
    const updates = rawUpdates.map((entry) => ({
      where: remapBoolExp(entry.where as BoolExp | undefined, columnMap) ?? ({} as BoolExp),
      _set: remapKeys(entry._set as Record<string, unknown>, columnMap) ?? {},
    }));

    const compiledQueries = compileUpdateMany({
      table,
      updates,
      returningColumns,
      returningRelationships,
      returningJsonbPaths: returningParsed?.jsonbPaths,
      permission: perm ? {
        filter: perm.filter,
        check: perm.check,
        columns: perm.columns,
        presets: perm.presets,
      } : undefined,
      session: auth,
    });

    // Execute each update query within the same session (transaction)
    let totalAffected = 0;
    const allReturning: Record<string, unknown>[] = [];

    for (const compiled of compiledQueries) {
      const result = await queryWithSession(compiled.sql, compiled.params, auth, 'write');

      // CTE pattern (check OR relationships): single row with "data" as JSON array
      // Without CTE: each row has a "data" column
      const usesCTE = !!(perm?.check || returningRelationships);

      if (usesCTE) {
        const firstRow = result.rows[0] as Record<string, unknown> | undefined;
        const data = firstRow?.data;
        if (data && Array.isArray(data)) {
          totalAffected += data.length;
          allReturning.push(...remapRowsToCamel(data as Record<string, unknown>[], table));
        }
      } else {
        const rows = result.rows.map((row) => {
          const r = row as Record<string, unknown>;
          const data = r.data as Record<string, unknown> | undefined;
          return data ? remapRowToCamel(data, table) : {};
        });
        totalAffected += rows.length;
        allReturning.push(...rows);
      }
    }

    return {
      affectedRows: totalAffected,
      returning: allReturning,
    };
  };
}

// ─── Delete Resolver ────────────────────────────────────────────────────────

/**
 * Creates a resolver for the `delete_<table>` mutation field.
 *
 * Arguments: where (required)
 * Returns: <Type>MutationResponse
 */
export function makeDeleteResolver(
  table: TableInfo,
): GraphQLFieldResolver<unknown, ResolverContext> {
  const columnMap = camelToColumnMap(table);

  return async (_parent, args, context, info) => {
    const { auth, queryWithSession, permissionLookup } = context;
    const perm = permissionLookup.getDelete(table.schema, table.name, auth.role);

    if (!perm && !auth.isAdmin) {
      throw permissionDenied('delete', `${table.schema}.${table.name}`, auth.role);
    }

    const where = remapBoolExp(args.where as BoolExp | undefined, columnMap, table, context.tables) ?? ({} as BoolExp);
    const returningColumns = getReturningColumns(table);

    // Parse returning selection set for relationships and computed fields
    const returningParsed = parseReturningInfo(info, table, context.tables, permissionLookup, auth, context.functions);
    const returningRelationships = returningParsed?.relationships && returningParsed.relationships.length > 0
      ? returningParsed.relationships
      : undefined;

    // Build computed field selections (use select permission for returning clause access)
    const deleteSelectPerm = permissionLookup.getSelect(table.schema, table.name, auth.role);
    const deleteReturningComputedFields = buildComputedFieldSelections(
      returningParsed?.computedFields,
      table,
      context.functions,
      deleteSelectPerm?.computedFields,
      auth.isAdmin,
    );

    const compiled = compileDelete({
      table,
      where,
      returningColumns,
      returningRelationships,
      returningComputedFields: deleteReturningComputedFields.length > 0 ? deleteReturningComputedFields : undefined,
      returningJsonbPaths: returningParsed?.jsonbPaths,
      permission: perm ? {
        filter: perm.filter,
      } : undefined,
      session: auth,
    });

    const result = await queryWithSession(compiled.sql, compiled.params, auth, 'write');

    // compileDelete with returning uses a CTE: single row with "data" as JSON array
    const firstRow = result.rows[0] as Record<string, unknown> | undefined;
    const data = firstRow?.data;
    if (data && Array.isArray(data)) {
      return {
        affectedRows: data.length,
        returning: remapRowsToCamel(data as Record<string, unknown>[], table),
      };
    }

    // No returning columns case — rowCount from the query
    return {
      affectedRows: result.rowCount,
      returning: [],
    };
  };
}

// ─── Delete By PK Resolver ──────────────────────────────────────────────────

/**
 * Creates a resolver for the `delete_<table>_by_pk` mutation field.
 *
 * Arguments: one argument per PK column
 * Returns: <Type> (nullable)
 */
export function makeDeleteByPkResolver(
  table: TableInfo,
): GraphQLFieldResolver<unknown, ResolverContext> {
  const columnMap = camelToColumnMap(table);

  return async (_parent, args, context, info) => {
    const { auth, queryWithSession, permissionLookup } = context;
    const perm = permissionLookup.getDelete(table.schema, table.name, auth.role);

    if (!perm && !auth.isAdmin) {
      throw permissionDenied('delete', `${table.schema}.${table.name}`, auth.role);
    }

    const pkValues = remapKeys(args as Record<string, unknown>, columnMap) ?? {};
    const returningColumns = getReturningColumns(table);

    // Parse resolve info for relationships and computed fields (deleteByPk returns the type directly)
    const parsed = parseResolveInfo(info, table, context.tables, permissionLookup, auth, context.functions);
    const returningRelationships = parsed.relationships.length > 0
      ? parsed.relationships
      : undefined;

    // Build computed field selections (use select permission for returning clause access)
    const deleteByPkSelectPerm = permissionLookup.getSelect(table.schema, table.name, auth.role);
    const deleteByPkReturningCF = buildComputedFieldSelections(
      parsed.computedFields,
      table,
      context.functions,
      deleteByPkSelectPerm?.computedFields,
      auth.isAdmin,
    );

    const compiled = compileDeleteByPk({
      table,
      pkValues,
      returningColumns,
      returningRelationships,
      returningComputedFields: deleteByPkReturningCF.length > 0 ? deleteByPkReturningCF : undefined,
      returningJsonbPaths: parsed.jsonbPaths,
      permission: perm ? {
        filter: perm.filter,
      } : undefined,
      session: auth,
    });

    const result = await queryWithSession(compiled.sql, compiled.params, auth, 'write');

    // compileDeleteByPk: each row has a "data" column with json_build_object
    const firstRow = result.rows[0] as Record<string, unknown> | undefined;
    const data = firstRow?.data;
    if (!data || typeof data !== 'object') return null;

    return remapRowToCamel(data as Record<string, unknown>, table);
  };
}
