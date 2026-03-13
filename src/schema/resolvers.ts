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
  SessionVariables,
  BoolExp,
  CompiledPermission,
  ComputedFieldConfig,
  FunctionInfo,
} from '../types.js';
import type { QueryCache } from '../sql/cache.js';
import type { SubscriptionManager } from '../subscriptions/manager.js';
import { compileSelect, compileSelectByPk, compileSelectAggregate } from '../sql/select.js';
import type { OrderByItem, AggregateSelection, ComputedFieldSelection } from '../sql/select.js';
import { compileInsertOne, compileInsert } from '../sql/insert.js';
import { compileUpdateByPk, compileUpdate } from '../sql/update.js';
import { compileDeleteByPk, compileDelete } from '../sql/delete.js';
import { toCamelCase } from './type-builder.js';
import { parseResolveInfo, parseAggregateNodesInfo } from './resolve-info.js';

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

  /** All tracked tables (for relationship resolution). */
  tables: TableInfo[];

  /** All introspected PG functions (for computed field resolution). */
  functions: FunctionInfo[];

  /** Query cache for compiled SQL templates. */
  queryCache?: QueryCache;

  /** Subscription manager for real-time subscriptions (available when subscriptions are enabled). */
  subscriptionManager?: SubscriptionManager;
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
 */
function remapBoolExp(
  boolExp: BoolExp | undefined | null,
  columnMap: Map<string, string>,
): BoolExp | undefined {
  if (!boolExp || typeof boolExp !== 'object') return undefined;

  const keys = Object.keys(boolExp);
  if (keys.length === 0) return boolExp;

  // _and: recursively remap each child
  if ('_and' in boolExp) {
    const typed = boolExp as { _and: BoolExp[] };
    return { _and: typed._and.map((sub) => remapBoolExp(sub, columnMap) ?? ({} as BoolExp)) };
  }

  // _or: recursively remap each child
  if ('_or' in boolExp) {
    const typed = boolExp as { _or: BoolExp[] };
    return { _or: typed._or.map((sub) => remapBoolExp(sub, columnMap) ?? ({} as BoolExp)) };
  }

  // _not: recursively remap child
  if ('_not' in boolExp) {
    const typed = boolExp as { _not: BoolExp };
    return { _not: remapBoolExp(typed._not, columnMap) ?? ({} as BoolExp) };
  }

  // _exists: pass through (table-level, not column-level)
  if ('_exists' in boolExp) {
    return boolExp;
  }

  // Column-level: remap keys from camelCase to snake_case
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(boolExp as Record<string, unknown>)) {
    const pgName = columnMap.get(key) ?? key;
    result[pgName] = value;
  }
  return result as BoolExp;
}

/**
 * Convert camelCase orderBy args from GraphQL to the OrderByItem[] the SQL compiler expects.
 */
function remapOrderBy(
  orderBy: Array<Record<string, string>> | undefined | null,
  columnMap: Map<string, string>,
): OrderByItem[] | undefined {
  if (!orderBy || orderBy.length === 0) return undefined;

  return orderBy.map((item) => {
    // Each item has the shape { fieldName: 'asc' | 'desc' | 'asc_nulls_first' | ... }
    for (const [camelKey, direction] of Object.entries(item)) {
      const pgName = columnMap.get(camelKey) ?? camelKey;
      // Parse direction string like 'asc_nulls_first'
      const parts = direction.toLowerCase().split('_');
      const dir = parts[0] === 'desc' ? 'desc' : 'asc';
      let nulls: 'first' | 'last' | undefined;
      if (parts.includes('nulls') && parts.includes('first')) {
        nulls = 'first';
      } else if (parts.includes('nulls') && parts.includes('last')) {
        nulls = 'last';
      }
      return { column: pgName, direction: dir as 'asc' | 'desc', nulls };
    }
    // Fallback (should never reach here)
    return { column: '', direction: 'asc' as const };
  });
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
 * Resolve the more restrictive limit between user-provided and permission-defined.
 */
function resolveLimit(userLimit?: number, permLimit?: number): number | undefined {
  if (userLimit !== undefined && permLimit !== undefined) {
    return Math.min(userLimit, permLimit);
  }
  return userLimit ?? permLimit;
}

/**
 * Build ComputedFieldSelection[] from parsed computed field names + table config + schema functions.
 */
function buildComputedFieldSelections(
  computedFieldNames: string[] | undefined,
  table: TableInfo,
  functions: FunctionInfo[],
  permComputedFields?: string[],
  isAdmin?: boolean,
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

    // Skip set-returning functions for now (TODO: array computed fields)
    if (fn.isSetReturning) continue;

    selections.push({ config: cfConfig, functionInfo: fn });
  }

  return selections;
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
  const columnMap = camelToColumnMap(table);

  return async (_parent, args, context, info) => {
    const { auth, queryWithSession, permissionLookup } = context;
    const perm = permissionLookup.getSelect(table.schema, table.name, auth.role);

    if (!perm && !auth.isAdmin) {
      throw permissionDenied('select', `${table.schema}.${table.name}`, auth.role);
    }

    // Parse resolve info to extract requested columns and relationships
    const parsed = parseResolveInfo(info, table, context.tables, permissionLookup, auth);
    const columns = parsed.columns.length > 0 ? parsed.columns : getAllowedColumns(table, perm?.columns);

    // Build computed field selections
    const computedFields = buildComputedFieldSelections(
      parsed.computedFields,
      table,
      context.functions,
      perm?.computedFields,
      auth.isAdmin,
    );

    const where = remapBoolExp(args.where as BoolExp | undefined, columnMap);
    const orderBy = remapOrderBy(args.orderBy as Array<Record<string, string>> | undefined, columnMap);
    const limit = resolveLimit(args.limit as number | undefined, perm?.limit);

    const compiled = compileSelect({
      table,
      columns,
      where,
      orderBy,
      limit,
      offset: args.offset as number | undefined,
      relationships: parsed.relationships,
      computedFields: computedFields.length > 0 ? computedFields : undefined,
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

    // Build PK values from camelCase args → snake_case column names
    const pkValues = remapKeys(args as Record<string, unknown>, columnMap) ?? {};

    // Parse resolve info to extract requested columns and relationships
    const parsed = parseResolveInfo(info, table, context.tables, permissionLookup, auth);
    const columns = parsed.columns.length > 0 ? parsed.columns : getAllowedColumns(table, perm?.columns);

    // Build computed field selections
    const computedFields = buildComputedFieldSelections(
      parsed.computedFields,
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
  const columnMap = camelToColumnMap(table);

  return async (_parent, args, context, info) => {
    const { auth, queryWithSession, permissionLookup } = context;
    const perm = permissionLookup.getSelect(table.schema, table.name, auth.role);

    if (!perm && !auth.isAdmin) {
      throw permissionDenied('select', `${table.schema}.${table.name}`, auth.role);
    }

    if (perm && !perm.allowAggregations && !auth.isAdmin) {
      throw new Error(
        `Aggregations not allowed for role "${auth.role}" on "${table.schema}.${table.name}"`,
      );
    }

    // Parse resolve info for the "nodes" sub-selection to extract relationships
    const nodesParsed = parseAggregateNodesInfo(info, table, context.tables, permissionLookup, auth);
    const columns = nodesParsed?.columns.length
      ? nodesParsed.columns
      : getAllowedColumns(table, perm?.columns);
    const nodeRelationships = nodesParsed?.relationships ?? [];

    const where = remapBoolExp(args.where as BoolExp | undefined, columnMap);
    const orderBy = remapOrderBy(args.orderBy as Array<Record<string, string>> | undefined, columnMap);
    const limit = resolveLimit(args.limit as number | undefined, perm?.limit);

    // Build aggregate selection — request count + nodes
    const aggregate: AggregateSelection = { count: {} };

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

  return async (_parent, args, context, _info) => {
    const { auth, queryWithSession, permissionLookup } = context;
    const perm = permissionLookup.getInsert(table.schema, table.name, auth.role);

    if (!perm && !auth.isAdmin) {
      throw permissionDenied('insert', `${table.schema}.${table.name}`, auth.role);
    }

    const rawObjects = args.objects as Record<string, unknown>[];
    const objects = rawObjects.map((obj) => remapKeys(obj, columnMap) ?? {});

    if (objects.length === 0) {
      return { affectedRows: 0, returning: [] };
    }

    const returningColumns = getReturningColumns(table);

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
      onConflict,
      permission: perm ? {
        check: perm.check,
        columns: perm.columns,
        presets: perm.presets,
      } : undefined,
      session: auth,
    });

    const result = await queryWithSession(compiled.sql, compiled.params, auth, 'write');

    // compileInsert with check: CTE wraps results in json_agg → "data" column
    // compileInsert without check: RETURNING json_build_object → "data" column per row
    const firstRow = result.rows[0] as Record<string, unknown> | undefined;

    if (perm?.check) {
      // CTE pattern: single row with "data" as JSON array
      const data = firstRow?.data;
      if (!data || !Array.isArray(data)) {
        // If the check filter eliminates all rows, it means the insert was done
        // but the check failed — this should be an error
        if (result.rowCount === 0 && objects.length > 0) {
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

  return async (_parent, args, context, _info) => {
    const { auth, queryWithSession, permissionLookup } = context;
    const perm = permissionLookup.getInsert(table.schema, table.name, auth.role);

    if (!perm && !auth.isAdmin) {
      throw permissionDenied('insert', `${table.schema}.${table.name}`, auth.role);
    }

    const obj = remapKeys(args.object as Record<string, unknown>, columnMap) ?? {};
    const returningColumns = getReturningColumns(table);

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

  return async (_parent, args, context, _info) => {
    const { auth, queryWithSession, permissionLookup } = context;
    const perm = permissionLookup.getUpdate(table.schema, table.name, auth.role);

    if (!perm && !auth.isAdmin) {
      throw permissionDenied('update', `${table.schema}.${table.name}`, auth.role);
    }

    const setValues = remapKeys(args._set as Record<string, unknown> | undefined, columnMap);
    if (!setValues || Object.keys(setValues).length === 0) {
      return { affectedRows: 0, returning: [] };
    }

    const where = remapBoolExp(args.where as BoolExp | undefined, columnMap) ?? ({} as BoolExp);
    const returningColumns = getReturningColumns(table);

    const compiled = compileUpdate({
      table,
      where,
      _set: setValues,
      returningColumns,
      permission: perm ? {
        filter: perm.filter,
        check: perm.check,
        columns: perm.columns,
        presets: perm.presets,
      } : undefined,
      session: auth,
    });

    const result = await queryWithSession(compiled.sql, compiled.params, auth, 'write');

    // With check CTE: single row with "data" as JSON array
    // Without check: each row has a "data" column
    if (perm?.check) {
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

  return async (_parent, args, context, _info) => {
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

    const compiled = compileUpdateByPk({
      table,
      pkValues,
      _set: setValues,
      returningColumns,
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

  return async (_parent, args, context, _info) => {
    const { auth, queryWithSession, permissionLookup } = context;
    const perm = permissionLookup.getDelete(table.schema, table.name, auth.role);

    if (!perm && !auth.isAdmin) {
      throw permissionDenied('delete', `${table.schema}.${table.name}`, auth.role);
    }

    const where = remapBoolExp(args.where as BoolExp | undefined, columnMap) ?? ({} as BoolExp);
    const returningColumns = getReturningColumns(table);

    const compiled = compileDelete({
      table,
      where,
      returningColumns,
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

  return async (_parent, args, context, _info) => {
    const { auth, queryWithSession, permissionLookup } = context;
    const perm = permissionLookup.getDelete(table.schema, table.name, auth.role);

    if (!perm && !auth.isAdmin) {
      throw permissionDenied('delete', `${table.schema}.${table.name}`, auth.role);
    }

    const pkValues = remapKeys(args as Record<string, unknown>, columnMap) ?? {};
    const returningColumns = getReturningColumns(table);

    const compiled = compileDeleteByPk({
      table,
      pkValues,
      returningColumns,
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
