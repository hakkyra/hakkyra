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
import type { OrderByItem, RelationshipSelection } from '../sql/select.js';
import { compileSelect, compileSelectByPk } from '../sql/select.js';
import { toCamelCase, getColumnFieldName } from './type-builder.js';
import type { ResolverContext } from './resolvers.js';
import { isSubscriptionRootFieldAllowed, buildComputedFieldSelections, buildSetReturningComputedFieldSelections } from './resolvers.js';
import { parseResolveInfo, type ParsedSelection, type SetReturningComputedFieldParsed } from './resolve-info.js';

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

    const compiled = compileSelect({
      table,
      columns,
      where,
      orderBy,
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

    const batchSize = args.batchSize as number;
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
