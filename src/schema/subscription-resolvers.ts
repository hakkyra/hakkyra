/**
 * Subscription resolver factory functions.
 *
 * Each factory produces an AsyncGenerator-based `subscribe` function that:
 * 1. Checks permissions (same as regular resolvers)
 * 2. Compiles the SQL query
 * 3. Registers with the subscription manager
 * 4. Yields the initial result, then yields updates via an async queue
 * 5. Cleans up on unsubscribe (finally block)
 */

import { randomUUID } from 'crypto';
import type { GraphQLResolveInfo } from 'graphql';
import type {
  TableInfo,
  SessionVariables,
  BoolExp,
} from '../types.js';
import type { SubscriptionManager } from '../subscriptions/manager.js';
import type { OrderByItem, RelationshipSelection, AggregateSelection, AggregateComputedFieldRef } from '../sql/select.js';
import { compileSelect, compileSelectByPk, compileSelectAggregate } from '../sql/select.js';
import { toCamelCase, getColumnFieldName } from './type-builder.js';
import type { ResolverContext } from './resolvers/index.js';
import { isSubscriptionRootFieldAllowed, isNumericColumn, buildComputedFieldSelections, buildSetReturningComputedFieldSelections, resolveLimit, camelToColumnAndCFMap, remapBoolExp as remapBoolExpFull, remapOrderBy as remapOrderByFull, getAllowedColumns as getAllowedColumnsFull, remapRowsToCamel as remapRowsToCamelFull } from './resolvers/index.js';
import { parseResolveInfo, parseAggregateNodesInfo, parseAggregateCountArgs, type ParsedSelection, type SetReturningComputedFieldParsed } from './resolve-info.js';
import type { TrackedFunctionInfo } from './tracked-functions.js';
import {
  extractFuncArgs,
  hasRolePermission,
  compileTrackedFunctionCall,
  remapTrackedFnRowToCamel,
  buildNamedFuncCall,
  parseAggregateFromInfo,
} from './tracked-functions.js';
import { ParamCollector, quoteIdentifier } from '../sql/utils.js';
import { compileWhere } from '../sql/where.js';

// ─── Async Queue (push-to-pull adapter) ─────────────────────────────────────

/**
 * A simple push-to-pull adapter that converts callback-based pushes
 * into an AsyncIterable suitable for GraphQL subscription resolvers.
 *
 * The subscription manager calls `push(value)` when new data arrives;
 * the GraphQL engine consumes values via `for await...of`.
 */
export interface AsyncQueue<T> {
  push(value: T): void;
  iterator: AsyncIterableIterator<T>;
  done(): void;
}

export function createAsyncQueue<T>(): AsyncQueue<T> {
  // Pending values waiting to be consumed
  const buffer: T[] = [];
  // Pending resolvers waiting for values
  const waiters: Array<(result: IteratorResult<T>) => void> = [];
  let finished = false;

  function push(value: T): void {
    if (finished) return;

    if (waiters.length > 0) {
      // A consumer is waiting — resolve it immediately
      const resolve = waiters.shift()!;
      resolve({ value, done: false });
    } else {
      // No consumer waiting — buffer the value
      buffer.push(value);
    }
  }

  function done(): void {
    finished = true;
    // Resolve all pending waiters with done: true
    for (const resolve of waiters) {
      resolve({ value: undefined as unknown as T, done: true });
    }
    waiters.length = 0;
  }

  const iterator: AsyncIterableIterator<T> = {
    next(): Promise<IteratorResult<T>> {
      if (buffer.length > 0) {
        return Promise.resolve({ value: buffer.shift()!, done: false });
      }
      if (finished) {
        return Promise.resolve({ value: undefined as unknown as T, done: true });
      }
      // Wait for a value to be pushed
      return new Promise<IteratorResult<T>>((resolve) => {
        waiters.push(resolve);
      });
    },

    return(): Promise<IteratorResult<T>> {
      done();
      return Promise.resolve({ value: undefined as unknown as T, done: true });
    },

    throw(error: unknown): Promise<IteratorResult<T>> {
      done();
      return Promise.reject(error);
    },

    [Symbol.asyncIterator]() {
      return this;
    },
  };

  return { push, iterator, done };
}

// ─── Helper Functions ────────────────────────────────────────────────────────

function permissionDenied(operation: string, table: string, role: string): Error {
  return new Error(
    `Permission denied: role "${role}" does not have ${operation} access to "${table}"`,
  );
}

function camelToColumnMap(table: TableInfo): Map<string, string> {
  const map = new Map<string, string>();
  for (const col of table.columns) {
    map.set(getColumnFieldName(table, col.name), col.name);
  }
  return map;
}

function remapBoolExp(
  boolExp: BoolExp | undefined | null,
  columnMap: Map<string, string>,
): BoolExp | undefined {
  if (!boolExp || typeof boolExp !== 'object') return undefined;

  const keys = Object.keys(boolExp);
  if (keys.length === 0) return boolExp;

  if ('_and' in boolExp) {
    const typed = boolExp as { _and: BoolExp[] };
    return { _and: typed._and.map((sub) => remapBoolExp(sub, columnMap) ?? ({} as BoolExp)) };
  }

  if ('_or' in boolExp) {
    const typed = boolExp as { _or: BoolExp[] };
    return { _or: typed._or.map((sub) => remapBoolExp(sub, columnMap) ?? ({} as BoolExp)) };
  }

  if ('_not' in boolExp) {
    const typed = boolExp as { _not: BoolExp };
    return { _not: remapBoolExp(typed._not, columnMap) ?? ({} as BoolExp) };
  }

  if ('_exists' in boolExp) {
    return boolExp;
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(boolExp as Record<string, unknown>)) {
    const pgName = columnMap.get(key) ?? key;
    result[pgName] = value;
  }
  return result as BoolExp;
}

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

function remapOrderBy(
  orderBy: Array<Record<string, string>> | undefined | null,
  columnMap: Map<string, string>,
): OrderByItem[] | undefined {
  if (!orderBy || orderBy.length === 0) return undefined;

  return orderBy.map((item) => {
    for (const [camelKey, direction] of Object.entries(item)) {
      const pgName = columnMap.get(camelKey) ?? camelKey;
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
    return { column: '', direction: 'asc' as const };
  });
}

function getAllowedColumns(
  table: TableInfo,
  permColumns?: string[] | '*',
): string[] {
  const allColumns = table.columns.map((c) => c.name);
  if (!permColumns || permColumns === '*') return allColumns;
  return allColumns.filter((c) => permColumns.includes(c));
}

// resolveLimit is imported from resolvers.ts (single source of truth)

function remapRowToCamel(
  row: Record<string, unknown>,
  table: TableInfo,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const col of table.columns) {
    if (col.name in row) {
      result[table.customColumnNames?.[col.name] ?? toCamelCase(col.name)] = row[col.name];
    }
  }
  for (const [key, value] of Object.entries(row)) {
    const camelKey = toCamelCase(key);
    if (!(camelKey in result)) {
      result[camelKey] = value;
    }
  }
  return result;
}

function remapRowsToCamel(
  rows: Record<string, unknown>[],
  table: TableInfo,
): Record<string, unknown>[] {
  return rows.map((row) => remapRowToCamel(row, table));
}

// ─── Related Table Key Collection ────────────────────────────────────────────

/**
 * Collect all related table keys from a parsed selection.
 * This includes tables referenced by relationships and set-returning computed fields,
 * recursively through nested relationships.
 *
 * Used to register subscriptions under related table keys so that changes
 * to related tables (e.g., inserting an invoice) trigger re-query of the
 * parent subscription (e.g., a subscription on clients with nested invoices).
 */
function collectRelatedTableKeys(parsed: ParsedSelection): string[] {
  const keys = new Set<string>();

  function walkRelationships(relationships: RelationshipSelection[]): void {
    for (const rel of relationships) {
      keys.add(`${rel.remoteTable.schema}.${rel.remoteTable.name}`);
      if (rel.relationships) {
        walkRelationships(rel.relationships);
      }
    }
  }

  function walkSetReturning(srcfs: SetReturningComputedFieldParsed[] | undefined): void {
    if (!srcfs) return;
    for (const srcf of srcfs) {
      keys.add(`${srcf.remoteTable.schema}.${srcf.remoteTable.name}`);
      if (srcf.relationships.length > 0) {
        walkRelationships(srcf.relationships);
      }
      walkSetReturning(srcf.setReturningComputedFields);
    }
  }

  if (parsed.relationships.length > 0) {
    walkRelationships(parsed.relationships);
  }
  walkSetReturning(parsed.setReturningComputedFields);

  return keys.size > 0 ? Array.from(keys) : [];
}

// ─── Subscription Subscribe: Select (list) ──────────────────────────────────

/**
 * Creates a `subscribe` function for list subscription fields.
 *
 * Returns an AsyncGenerator that:
 * 1. Checks select permissions
 * 2. Compiles the SQL query
 * 3. Registers with the subscription manager (which runs the initial query)
 * 4. Yields the initial result (remapped to camelCase)
 * 5. Yields subsequent updates pushed by the manager when the table changes
 * 6. Unregisters on cleanup (generator return/throw)
 */
export function makeSubscriptionSelectSubscribe(
  table: TableInfo,
): (_parent: unknown, args: Record<string, unknown>, context: ResolverContext, info: GraphQLResolveInfo) => AsyncIterableIterator<unknown> {
  const columnMap = camelToColumnMap(table);
  const tableKeyStr = `${table.schema}.${table.name}`;

  return (_parent, args, context, info) => {
    const { auth, permissionLookup, subscriptionManager } = context;

    if (!subscriptionManager) {
      throw new Error('Subscription manager is not available');
    }

    const perm = permissionLookup.getSelect(table.schema, table.name, auth.role);

    if (!perm && !auth.isAdmin) {
      throw permissionDenied('select', `${table.schema}.${table.name}`, auth.role);
    }

    // Check subscription root field visibility
    if (!auth.isAdmin && !isSubscriptionRootFieldAllowed(perm, 'select')) {
      throw permissionDenied('select', `${table.schema}.${table.name}`, auth.role);
    }

    // Parse resolve info to extract requested columns, relationships, and computed fields
    const parsed = parseResolveInfo(info, table, context.tables, permissionLookup, auth, context.functions);
    const columns = parsed.columns.length > 0 ? parsed.columns : getAllowedColumns(table, perm?.columns);

    // Build computed field selections
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

    const where = remapBoolExp(args.where as BoolExp | undefined, columnMap);
    const orderBy = remapOrderBy(args.orderBy as Array<Record<string, string>> | undefined, columnMap);
    const limit = resolveLimit(args.limit as number | undefined, perm?.limit, context.graphqlMaxLimit);

    // Extract distinctOn — enum values resolve to PG column names directly
    const rawDistinctOn = args.distinctOn as string[] | undefined;
    let distinctOn: string[] | undefined;
    if (rawDistinctOn && rawDistinctOn.length > 0) {
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

    const relatedTableKeys = collectRelatedTableKeys(parsed);
    const queue = createAsyncQueue<unknown>();
    const subscriptionId = randomUUID();

    // Start the subscription asynchronously and yield results
    async function* generate(): AsyncGenerator<unknown> {
      try {
        // Register with the manager — this executes the initial query
        const initialData = await subscriptionManager!.register({
          id: subscriptionId,
          tableKey: tableKeyStr,
          query: { sql: compiled.sql, params: compiled.params },
          session: auth,
          relatedTableKeys: relatedTableKeys.length > 0 ? relatedTableKeys : undefined,
          push: (data: unknown) => {
            // The manager pushes raw data from the SQL result;
            // we need to remap it to camelCase for the GraphQL layer
            if (Array.isArray(data)) {
              queue.push(remapRowsToCamel(data as Record<string, unknown>[], table));
            } else {
              queue.push(data);
            }
          },
        });

        // Yield the initial result (remapped)
        if (Array.isArray(initialData)) {
          yield remapRowsToCamel(initialData as Record<string, unknown>[], table);
        } else {
          yield initialData;
        }

        // Yield subsequent updates from the queue
        for await (const value of queue.iterator) {
          yield value;
        }
      } finally {
        // Cleanup: unregister when the client disconnects
        subscriptionManager!.unregister(subscriptionId);
        queue.done();
      }
    }

    return generate();
  };
}

// ─── Subscription Subscribe: Select By PK ───────────────────────────────────

/**
 * Creates a `subscribe` function for by-pk subscription fields.
 *
 * Same pattern as the list subscription but uses compileSelectByPk
 * and returns a single row (nullable) instead of an array.
 */
export function makeSubscriptionSelectByPkSubscribe(
  table: TableInfo,
): (_parent: unknown, args: Record<string, unknown>, context: ResolverContext, info: GraphQLResolveInfo) => AsyncIterableIterator<unknown> {
  const columnMap = camelToColumnMap(table);
  const tableKeyStr = `${table.schema}.${table.name}`;

  return (_parent, args, context, info) => {
    const { auth, permissionLookup, subscriptionManager } = context;

    if (!subscriptionManager) {
      throw new Error('Subscription manager is not available');
    }

    const perm = permissionLookup.getSelect(table.schema, table.name, auth.role);

    if (!perm && !auth.isAdmin) {
      throw permissionDenied('select', `${table.schema}.${table.name}`, auth.role);
    }

    // Check subscription root field visibility
    if (!auth.isAdmin && !isSubscriptionRootFieldAllowed(perm, 'select_by_pk')) {
      throw permissionDenied('select', `${table.schema}.${table.name}`, auth.role);
    }

    const pkValues = remapKeys(args as Record<string, unknown>, columnMap) ?? {};

    // Parse resolve info to extract requested columns, relationships, and computed fields
    const parsed = parseResolveInfo(info, table, context.tables, permissionLookup, auth, context.functions);
    const columns = parsed.columns.length > 0 ? parsed.columns : getAllowedColumns(table, perm?.columns);

    // Build computed field selections
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

    const relatedTableKeys = collectRelatedTableKeys(parsed);
    const queue = createAsyncQueue<unknown>();
    const subscriptionId = randomUUID();

    async function* generate(): AsyncGenerator<unknown> {
      try {
        // Register with the manager — this executes the initial query
        const initialData = await subscriptionManager!.register({
          id: subscriptionId,
          tableKey: tableKeyStr,
          query: { sql: compiled.sql, params: compiled.params },
          session: auth,
          relatedTableKeys: relatedTableKeys.length > 0 ? relatedTableKeys : undefined,
          push: (data: unknown) => {
            // Remap single row result to camelCase
            if (data && typeof data === 'object' && !Array.isArray(data)) {
              queue.push(remapRowToCamel(data as Record<string, unknown>, table));
            } else {
              queue.push(data);
            }
          },
        });

        // Yield the initial result (remapped)
        if (initialData && typeof initialData === 'object' && !Array.isArray(initialData)) {
          yield remapRowToCamel(initialData as Record<string, unknown>, table);
        } else {
          yield initialData;
        }

        // Yield subsequent updates from the queue
        for await (const value of queue.iterator) {
          yield value;
        }
      } finally {
        // Cleanup: unregister when the client disconnects
        subscriptionManager!.unregister(subscriptionId);
        queue.done();
      }
    }

    return generate();
  };
}

// ─── Subscription Subscribe: Select Aggregate ────────────────────────────────

/**
 * Creates a `subscribe` function for aggregate subscription fields ({table}Aggregate).
 *
 * Mirrors the query aggregate resolver but as a subscription:
 * - Subscribes to table change notifications
 * - When a change occurs, re-executes the aggregate query
 * - Pushes updated aggregate results to the subscriber
 *
 * The aggregate SQL is wrapped so that its result is placed into a "data" column,
 * making it compatible with the subscription manager's executeQuery which extracts rows[0].data.
 */
export function makeSubscriptionSelectAggregateSubscribe(
  table: TableInfo,
): (_parent: unknown, args: Record<string, unknown>, context: ResolverContext, info: GraphQLResolveInfo) => AsyncIterableIterator<unknown> {
  const columnMap = camelToColumnAndCFMap(table);
  const tableKeyStr = `${table.schema}.${table.name}`;

  return (_parent, args, context, info) => {
    const { auth, permissionLookup, subscriptionManager } = context;

    if (!subscriptionManager) {
      throw new Error('Subscription manager is not available');
    }

    const perm = permissionLookup.getSelect(table.schema, table.name, auth.role);

    if (!perm && !auth.isAdmin) {
      throw permissionDenied('select', `${table.schema}.${table.name}`, auth.role);
    }

    // Check subscription root field visibility
    if (!auth.isAdmin && !isSubscriptionRootFieldAllowed(perm, 'select_aggregate')) {
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
      : getAllowedColumnsFull(table, perm?.columns);
    const nodeRelationships = nodesParsed?.relationships ?? [];

    const where = remapBoolExpFull(args.where as BoolExp | undefined, columnMap, table, context.tables);
    const orderBy = remapOrderByFull(
      args.orderBy as Array<Record<string, unknown>> | undefined,
      columnMap, table, context.tables,
    );
    const limit = resolveLimit(args.limit as number | undefined, perm?.limit, context.graphqlMaxLimit);

    // Extract count field arguments (columns, distinct) from the resolve info
    const countArgs = parseAggregateCountArgs(info);

    // Build aggregate selection — request count + sum/avg/min/max for numeric columns
    const aggregate: AggregateSelection = {
      count: {
        columns: countArgs.columns,
        distinct: countArgs.distinct,
      },
    };

    // Build computed field refs for aggregation
    const numericCFRefs: AggregateComputedFieldRef[] = [];
    if (table.computedFields) {
      for (const cf of table.computedFields) {
        const fnSchema = cf.function.schema ?? 'public';
        const fn = context.functions.find(
          (f) => f.name === cf.function.name && f.schema === fnSchema,
        );
        if (!fn || fn.isSetReturning) continue;
        const NUMERIC_PG_RETURN = new Set(['int2', 'smallint', 'int4', 'integer', 'int8', 'bigint', 'float4', 'real', 'float8', 'double precision', 'numeric', 'serial', 'serial4', 'serial8', 'bigserial', 'oid']);
        if (NUMERIC_PG_RETURN.has(fn.returnType)) {
          numericCFRefs.push({ name: toCamelCase(cf.name), functionName: cf.function.name, schema: fnSchema });
        }
      }
    }

    // Extract distinctOn — enum values resolve to PG column names directly
    const rawDistinctOn = args.distinctOn as string[] | undefined;
    let distinctOn: string[] | undefined;
    if (rawDistinctOn && rawDistinctOn.length > 0) {
      const allowedColumns = perm?.columns === '*'
        ? table.columns.map((c) => c.name)
        : (perm?.columns ?? table.columns.map((c) => c.name));
      distinctOn = rawDistinctOn.filter((col) => allowedColumns.includes(col));
      if (distinctOn.length === 0) distinctOn = undefined;
    }

    // When distinctOn is present, also request sum/avg/stddev/variance for numeric columns
    if (distinctOn) {
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
    }

    // Add numeric computed fields to aggregates
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

    if (distinctOn) {
      // Grouped aggregate path (using distinctOn as groupBy)
      const compiled = compileSelectAggregate({
        table,
        where,
        aggregate,
        groupBy: distinctOn,
        permission: perm ? {
          filter: perm.filter,
          columns: perm.columns,
          limit: perm.limit,
        } : undefined,
        session: auth,
      });

      const wrappedSql = `SELECT row_to_json("_agg_") AS "data" FROM (${compiled.sql}) "_agg_"`;

      const relatedTableKeys = nodesParsed ? collectRelatedTableKeys(nodesParsed) : [];
      const queue = createAsyncQueue<unknown>();
      const subscriptionId = randomUUID();

      function processGroupedData(data: unknown): unknown {
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
          return { aggregate: { count: 0 }, nodes: [], groupedAggregates: [] };
        }

        const row = data as Record<string, unknown>;
        const groupedData = row.groupedAggregates as Record<string, unknown>[] | undefined;

        const remappedGroups = (groupedData ?? []).map((group) => {
          const keys = group.keys as Record<string, unknown> | undefined;
          const remappedKeys: Record<string, unknown> = {};
          if (keys) {
            for (const [k, v] of Object.entries(keys)) {
              remappedKeys[toCamelCase(k)] = v;
            }
          }

          const result: Record<string, unknown> = { keys: remappedKeys };
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

      async function* generate(): AsyncGenerator<unknown> {
        try {
          const initialData = await subscriptionManager!.register({
            id: subscriptionId,
            tableKey: tableKeyStr,
            query: { sql: wrappedSql, params: compiled.params },
            session: auth,
            relatedTableKeys: relatedTableKeys.length > 0 ? relatedTableKeys : undefined,
            push: (data: unknown) => {
              queue.push(processGroupedData(data));
            },
          });

          yield processGroupedData(initialData);

          for await (const value of queue.iterator) {
            yield value;
          }
        } finally {
          subscriptionManager!.unregister(subscriptionId);
          queue.done();
        }
      }

      return generate();
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

    // Wrap the aggregate SQL so the result is in a "data" column,
    // compatible with the subscription manager's executeQuery which extracts rows[0].data
    const wrappedSql = `SELECT row_to_json("_agg_") AS "data" FROM (${compiled.sql}) "_agg_"`;

    const relatedTableKeys = nodesParsed ? collectRelatedTableKeys(nodesParsed) : [];
    const queue = createAsyncQueue<unknown>();
    const subscriptionId = randomUUID();

    /**
     * Process raw aggregate data from the subscription manager into the
     * format expected by the GraphQL aggregate type: { aggregate, nodes }.
     * Remaps node rows from snake_case to camelCase.
     */
    function processAggregateData(data: unknown): unknown {
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return { aggregate: { count: 0 }, nodes: [] };
      }

      const row = data as Record<string, unknown>;
      const aggData = row.aggregate as Record<string, unknown> | undefined;
      const nodesData = row.nodes as Record<string, unknown>[] | undefined;

      return {
        aggregate: aggData ?? { count: 0 },
        nodes: nodesData ? remapRowsToCamelFull(nodesData, table) : [],
      };
    }

    async function* generate(): AsyncGenerator<unknown> {
      try {
        // Register with the manager — this executes the initial query
        const initialData = await subscriptionManager!.register({
          id: subscriptionId,
          tableKey: tableKeyStr,
          query: { sql: wrappedSql, params: compiled.params },
          session: auth,
          relatedTableKeys: relatedTableKeys.length > 0 ? relatedTableKeys : undefined,
          push: (data: unknown) => {
            queue.push(processAggregateData(data));
          },
        });

        // Yield the initial result (processed)
        yield processAggregateData(initialData);

        // Yield subsequent updates from the queue
        for await (const value of queue.iterator) {
          yield value;
        }
      } finally {
        // Cleanup: unregister when the client disconnects
        subscriptionManager!.unregister(subscriptionId);
        queue.done();
      }
    }

    return generate();
  };
}

// ─── Subscription Subscribe: Streaming ───────────────────────────────────────

/**
 * Cursor entry parsed from the GraphQL cursor argument.
 */
export interface CursorEntry {
  column: string;
  ordering: 'ASC' | 'DESC';
  value: unknown;
}

/**
 * Creates a `subscribe` function for streaming subscription fields ({table}Stream).
 *
 * Streaming subscriptions differ from regular subscriptions:
 * - They track cursor positions and deliver batches of new rows
 * - The cursor advances after each batch
 * - No hash comparison — always pushes if rows are returned
 */
export function makeSubscriptionStreamSubscribe(
  table: TableInfo,
): (_parent: unknown, args: Record<string, unknown>, context: ResolverContext, info: GraphQLResolveInfo) => AsyncIterableIterator<unknown> {
  const columnMap = camelToColumnMap(table);
  const tableKeyStr = `${table.schema}.${table.name}`;

  return (_parent, args, context, info) => {
    const { auth, permissionLookup, subscriptionManager } = context;

    if (!subscriptionManager) {
      throw new Error('Subscription manager is not available');
    }

    const perm = permissionLookup.getSelect(table.schema, table.name, auth.role);

    if (!perm && !auth.isAdmin) {
      throw permissionDenied('select', `${table.schema}.${table.name}`, auth.role);
    }

    // Check subscription root field visibility
    if (!auth.isAdmin && !isSubscriptionRootFieldAllowed(perm, 'select_stream')) {
      throw permissionDenied('select', `${table.schema}.${table.name}`, auth.role);
    }

    // Parse resolve info to extract requested columns, relationships, and computed fields
    const parsed = parseResolveInfo(info, table, context.tables, permissionLookup, auth, context.functions);
    const parsedColumns = parsed.columns.length > 0 ? parsed.columns : getAllowedColumns(table, perm?.columns);

    // Build computed field selections
    const streamComputedFields = buildComputedFieldSelections(
      parsed.computedFields,
      table,
      context.functions,
      perm?.computedFields,
      auth.isAdmin,
      parsed.computedFieldArgs,
    );

    // Build set-returning computed field selections
    const streamSetReturningComputedFields = buildSetReturningComputedFieldSelections(
      parsed.setReturningComputedFields,
      table,
      context.functions,
      perm?.computedFields,
      auth.isAdmin,
    );

    const rawBatchSize = args.batchSize as number;
    const globalMaxLimit = context.graphqlMaxLimit;
    const batchSize = (globalMaxLimit !== undefined && globalMaxLimit > 0 && rawBatchSize > globalMaxLimit)
      ? globalMaxLimit
      : rawBatchSize;
    const cursorArgs = args.cursor as Array<{
      initialValue: Record<string, unknown>;
      ordering?: string;
    }>;
    const where = remapBoolExp(args.where as BoolExp | undefined, columnMap);
    const columns = parsedColumns;

    // Parse cursor entries: remap camelCase to snake_case
    const cursors: CursorEntry[] = cursorArgs
      .filter((c) => c != null)
      .map((c) => {
        const ordering = (c.ordering === 'DESC' ? 'DESC' : 'ASC') as 'ASC' | 'DESC';
        // initialValue has camelCase keys — remap to snake_case
        const remappedValues = remapKeys(c.initialValue, columnMap) ?? {};
        // Each cursor entry can specify one or more columns
        const entries = Object.entries(remappedValues).filter(([, v]) => v !== undefined && v !== null);
        if (entries.length === 0) {
          throw new Error('Stream cursor initialValue must specify at least one column');
        }
        return entries.map(([col, value]) => ({
          column: col,
          ordering,
          value,
        }));
      })
      .flat();

    if (cursors.length === 0) {
      throw new Error('Stream cursor must specify at least one cursor column');
    }

    function buildCursorBoolExp(currentCursors: CursorEntry[]): BoolExp | undefined {
      if (currentCursors.length === 0) return undefined;

      if (currentCursors.length === 1) {
        const c = currentCursors[0];
        const op = c.ordering === 'DESC' ? '_lt' : '_gt';
        return { [c.column]: { [op]: c.value } } as BoolExp;
      }

      // Multi-column cursor: (a > $1) OR (a = $1 AND b > $2)
      const orConditions: BoolExp[] = [];
      for (let i = 0; i < currentCursors.length; i++) {
        const andParts: Record<string, unknown> = {};
        // All preceding columns must be equal
        for (let j = 0; j < i; j++) {
          andParts[currentCursors[j].column] = { _eq: currentCursors[j].value };
        }
        // Current column uses the comparison operator
        const c = currentCursors[i];
        const op = c.ordering === 'DESC' ? '_lt' : '_gt';
        andParts[c.column] = { [op]: c.value };

        const parts = Object.entries(andParts).map(([k, v]) => ({ [k]: v } as BoolExp));
        if (parts.length === 1) {
          orConditions.push(parts[0]);
        } else {
          orConditions.push({ _and: parts });
        }
      }

      return orConditions.length === 1 ? orConditions[0] : { _or: orConditions };
    }

    function compileStreamQueryWithCursor(currentCursors: CursorEntry[]): { sql: string; params: unknown[] } {
      const cursorWhere = buildCursorBoolExp(currentCursors);

      // Combine user where + cursor where
      let combinedWhere: BoolExp | undefined;
      if (where && cursorWhere) {
        combinedWhere = { _and: [where, cursorWhere] };
      } else {
        combinedWhere = cursorWhere ?? where;
      }

      const orderBy: OrderByItem[] = currentCursors.map((c) => ({
        column: c.column,
        direction: c.ordering === 'DESC' ? 'desc' as const : 'asc' as const,
      }));

      return compileSelect({
        table,
        columns,
        where: combinedWhere,
        orderBy,
        limit: batchSize,
        relationships: parsed.relationships,
        computedFields: streamComputedFields.length > 0 ? streamComputedFields : undefined,
        setReturningComputedFields: streamSetReturningComputedFields.length > 0 ? streamSetReturningComputedFields : undefined,
        jsonbPaths: parsed.jsonbPaths,
        permission: perm ? {
          filter: perm.filter,
          columns: perm.columns,
          limit: perm.limit,
        } : undefined,
        session: auth,
      });
    }

    // Mutable cursor state
    const currentCursors = cursors.map((c) => ({ ...c }));

    const relatedTableKeys = collectRelatedTableKeys(parsed);
    const queue = createAsyncQueue<unknown>();
    const subscriptionId = randomUUID();

    async function* generate(): AsyncGenerator<unknown> {
      try {
        // Initial query uses cursor values from the args
        const initialCompiled = compileStreamQueryWithCursor(currentCursors);

        const initialData = await subscriptionManager!.registerStreaming({
          id: subscriptionId,
          tableKey: tableKeyStr,
          session: auth,
          recompile: () => compileStreamQueryWithCursor(currentCursors),
          cursors: currentCursors,
          relatedTableKeys: relatedTableKeys.length > 0 ? relatedTableKeys : undefined,
          push: (data: unknown) => {
            if (Array.isArray(data)) {
              queue.push(remapRowsToCamel(data as Record<string, unknown>[], table));
            } else {
              queue.push(data);
            }
          },
        }, { sql: initialCompiled.sql, params: initialCompiled.params });

        // Yield the initial result (remapped)
        if (Array.isArray(initialData)) {
          const remapped = remapRowsToCamel(initialData as Record<string, unknown>[], table);
          // Update cursors from initial data
          updateCursorsFromRows(initialData as Record<string, unknown>[], currentCursors);
          yield remapped;
        } else {
          yield initialData;
        }

        // Yield subsequent updates from the queue
        for await (const value of queue.iterator) {
          yield value;
        }
      } finally {
        subscriptionManager!.unregister(subscriptionId);
        queue.done();
      }
    }

    return generate();
  };
}

function remapTrackedFnDistinctOn(
  distinctOn: string[] | undefined | null,
  columnMap: Map<string, string>,
): string[] | undefined {
  if (!distinctOn || distinctOn.length === 0) return undefined;
  return distinctOn.map((camelKey) => columnMap.get(camelKey) ?? camelKey);
}

// ─── Subscription Subscribe: Tracked Function (list) ─────────────────────────

/**
 * Creates a `subscribe` function for tracked function subscription fields.
 *
 * Subscribes to changes on the return table and re-executes the function SQL
 * when the table changes. Same pattern as table subscriptions but with the
 * function call as the FROM source.
 */
export function makeTrackedFunctionSubscriptionSubscribe(
  trackedFn: TrackedFunctionInfo,
): (_parent: unknown, args: Record<string, unknown>, context: ResolverContext, info: GraphQLResolveInfo) => AsyncIterableIterator<unknown> {
  if (!trackedFn.returnTable) throw new Error(`No return table for tracked function ${trackedFn.config.name}`);
  const returnTable: import('../types.js').TableInfo = trackedFn.returnTable;
  const tableKeyStr = `${returnTable.schema}.${returnTable.name}`;

  return (_parent, args, context, info) => {
    const { auth, permissionLookup, subscriptionManager, inheritedRoles, tables, functions } = context;

    if (!subscriptionManager) {
      throw new Error('Subscription manager is not available');
    }

    const { config, functionInfo: fn } = trackedFn;

    // ── Function-level permission check ──────────────────────────────
    if (!auth.isAdmin) {
      if (!config.permissions || config.permissions.length === 0) {
        throw new Error(
          `Permission denied: no roles have access to function "${config.name}"`,
        );
      }
      if (!hasRolePermission(auth.role, config.permissions, inheritedRoles)) {
        throw new Error(
          `Permission denied: role "${auth.role}" does not have access to function "${config.name}"`,
        );
      }
    }

    // ── Return-table permission check ────────────────────────────────
    const perm = auth.isAdmin
      ? undefined
      : permissionLookup.getSelect(returnTable.schema, returnTable.name, auth.role);

    if (!auth.isAdmin && !perm) {
      throw new Error(
        `Permission denied: role "${auth.role}" does not have select access to "${returnTable.schema}.${returnTable.name}"`,
      );
    }

    // ── Parse resolve info for requested columns + relationships ─────
    const parsed = parseResolveInfo(info, returnTable, tables, permissionLookup, auth, functions);

    // ── Extract function arguments ──────────────────────────────────
    const funcArgs = extractFuncArgs(trackedFn, args, auth);

    // ── Remap camelCase args to snake_case ────────────────────────────
    const colMap = camelToColumnMap(returnTable);
    const where = remapBoolExp(args.where as BoolExp | undefined, colMap);
    const orderBy = remapOrderBy(
      args.orderBy as Array<Record<string, string>> | undefined,
      colMap,
    );
    const distinctOn = remapTrackedFnDistinctOn(
      args.distinctOn as string[] | undefined,
      colMap,
    );

    // ── Compile SQL ──────────────────────────────────────────────────
    const compiled = compileTrackedFunctionCall({
      trackedFn,
      funcArgs,
      table: returnTable,
      columns: parsed.columns,
      where,
      orderBy,
      limit: args.limit as number | undefined,
      offset: args.offset as number | undefined,
      distinctOn,
      relationships: parsed.relationships.length > 0 ? parsed.relationships : undefined,
      permission: perm ? {
        filter: perm.filter,
        columns: perm.columns,
        limit: perm.limit,
      } : undefined,
      session: auth,
      globalMaxLimit: context.graphqlMaxLimit,
    });

    const queue = createAsyncQueue<unknown>();
    const subscriptionId = randomUUID();

    async function* generate(): AsyncGenerator<unknown> {
      try {
        const initialData = await subscriptionManager!.register({
          id: subscriptionId,
          tableKey: tableKeyStr,
          query: { sql: compiled.sql, params: compiled.params },
          session: auth,
          push: (data: unknown) => {
            if (Array.isArray(data)) {
              queue.push(data.map((r: Record<string, unknown>) =>
                remapTrackedFnRowToCamel(r, returnTable),
              ));
            } else {
              queue.push(data);
            }
          },
        });

        // Yield the initial result (remapped)
        if (Array.isArray(initialData)) {
          yield initialData.map((r: Record<string, unknown>) =>
            remapTrackedFnRowToCamel(r, returnTable),
          );
        } else {
          yield initialData;
        }

        // Yield subsequent updates from the queue
        for await (const value of queue.iterator) {
          yield value;
        }
      } finally {
        subscriptionManager!.unregister(subscriptionId);
        queue.done();
      }
    }

    return generate();
  };
}

// ─── Subscription Subscribe: Tracked Function Aggregate ──────────────────────

/**
 * Creates a `subscribe` function for tracked function aggregate subscription fields.
 *
 * Re-runs the function aggregate SQL when the return table changes.
 */
export function makeTrackedFunctionAggregateSubscriptionSubscribe(
  trackedFn: TrackedFunctionInfo,
): (_parent: unknown, args: Record<string, unknown>, context: ResolverContext, info: GraphQLResolveInfo) => AsyncIterableIterator<unknown> {
  if (!trackedFn.returnTable) throw new Error(`No return table for tracked function ${trackedFn.config.name}`);
  const returnTable: import('../types.js').TableInfo = trackedFn.returnTable;
  const tableKeyStr = `${returnTable.schema}.${returnTable.name}`;

  return (_parent, args, context, info) => {
    const { auth, permissionLookup, subscriptionManager, inheritedRoles } = context;

    if (!subscriptionManager) {
      throw new Error('Subscription manager is not available');
    }

    const { config, functionInfo: fn } = trackedFn;

    // ── Function-level permission check ──────────────────────────────
    if (!auth.isAdmin) {
      if (!config.permissions || config.permissions.length === 0) {
        throw new Error(
          `Permission denied: no roles have access to function "${config.name}"`,
        );
      }
      if (!hasRolePermission(auth.role, config.permissions, inheritedRoles)) {
        throw new Error(
          `Permission denied: role "${auth.role}" does not have access to function "${config.name}"`,
        );
      }
    }

    // ── Return-table permission check ────────────────────────────────
    const perm = auth.isAdmin
      ? undefined
      : permissionLookup.getSelect(returnTable.schema, returnTable.name, auth.role);

    if (!auth.isAdmin && !perm) {
      throw new Error(
        `Permission denied: role "${auth.role}" does not have select access to "${returnTable.schema}.${returnTable.name}"`,
      );
    }

    // Check aggregation permission
    if (!auth.isAdmin && perm && !perm.allowAggregations) {
      throw new Error(
        `Permission denied: role "${auth.role}" does not have aggregation access to "${returnTable.schema}.${returnTable.name}"`,
      );
    }

    // ── Extract function arguments ──────────────────────────────────
    const funcArgs = extractFuncArgs(trackedFn, args, auth);

    // ── Remap camelCase args to snake_case ────────────────────────────
    const colMap = camelToColumnMap(returnTable);
    const where = remapBoolExp(args.where as BoolExp | undefined, colMap);

    // ── Build aggregate SQL using function as source ─────────────────
    const params = new ParamCollector();
    const alias = 't0';

    const funcCall = buildNamedFuncCall(fn.schema, fn.name, funcArgs, params);

    // Build WHERE
    const whereParts: string[] = [];
    const userWhere = compileWhere(where, params, alias, auth);
    if (userWhere) whereParts.push(userWhere);

    if (perm?.filter) {
      const permResult = perm.filter.toSQL(
        auth,
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

    // Parse the aggregate field from resolve info
    const aggSelection = parseAggregateFromInfo(info);

    // Build aggregate expressions
    const aggFields: string[] = [];
    if (aggSelection.count !== undefined) {
      aggFields.push(`'count', count(*)`);
    }
    for (const aggFn of ['sum', 'avg', 'min', 'max'] as const) {
      const fieldCols = aggSelection[aggFn];
      if (fieldCols && fieldCols.length > 0) {
        const fnFields = fieldCols.map((camelName) => {
          const snakeName = camelName.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase());
          return `'${camelName}', ${aggFn}(${quoteIdentifier(alias)}.${quoteIdentifier(snakeName)})`;
        }).join(', ');
        aggFields.push(`'${aggFn}', json_build_object(${fnFields})`);
      }
    }

    const selectParts: string[] = [];
    if (aggFields.length > 0) {
      selectParts.push(`json_build_object(${aggFields.join(', ')}) AS "aggregate"`);
    } else {
      selectParts.push(`json_build_object('count', count(*)) AS "aggregate"`);
    }

    const sql = [
      `SELECT ${selectParts.join(', ')}`,
      `FROM ${funcCall} ${quoteIdentifier(alias)}`,
      whereClause ? whereClause.trim() : null,
    ].filter(Boolean).join('\n');

    // Wrap so the result is in a "data" column (compatible with subscription manager's executeQuery)
    const wrappedSql = `SELECT row_to_json("_agg_") AS "data" FROM (${sql}) "_agg_"`;

    const queue = createAsyncQueue<unknown>();
    const subscriptionId = randomUUID();

    function processAggregateData(data: unknown): unknown {
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return { aggregate: { count: 0 } };
      }
      const row = data as Record<string, unknown>;
      return { aggregate: row.aggregate ?? { count: 0 } };
    }

    async function* generate(): AsyncGenerator<unknown> {
      try {
        const initialData = await subscriptionManager!.register({
          id: subscriptionId,
          tableKey: tableKeyStr,
          query: { sql: wrappedSql, params: params.getParams() },
          session: auth,
          push: (data: unknown) => {
            queue.push(processAggregateData(data));
          },
        });

        yield processAggregateData(initialData);

        for await (const value of queue.iterator) {
          yield value;
        }
      } finally {
        subscriptionManager!.unregister(subscriptionId);
        queue.done();
      }
    }

    return generate();
  };
}

/**
 * Update cursor values from the returned rows.
 * Takes the last row's value for each cursor column (since rows are ordered).
 */
export function updateCursorsFromRows(
  rows: Record<string, unknown>[],
  cursors: CursorEntry[],
): void {
  if (rows.length === 0) return;

  for (const cursor of cursors) {
    const lastRow = rows[rows.length - 1];
    if (lastRow && cursor.column in lastRow) {
      cursor.value = lastRow[cursor.column];
    }
  }
}
