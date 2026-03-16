/**
 * Insert resolver factories: makeInsertResolver, makeInsertOneResolver.
 */

import type { GraphQLFieldResolver } from 'graphql';
import type {
  TableInfo,
  SessionVariables,
  BoolExp,
} from '../../types.js';
import { compileInsertOne, compileInsert } from '../../sql/insert.js';
import { toCamelCase } from '../type-builder.js';
import { parseResolveInfo, parseReturningInfo } from '../resolve-info.js';
import {
  type ResolverContext,
  permissionDenied,
  camelToColumnMap,
  remapKeys,
  remapBoolExp,
  getReturningColumns,
  buildComputedFieldSelections,
  buildSetReturningComputedFieldSelections,
  remapRowToCamel,
  remapRowsToCamel,
} from './helpers.js';

// ─── Nested Insert Helpers ───────────────────────────────────────────────────

interface NestedInsertData {
  rel: TableInfo['relationships'][number];
  remoteTable: TableInfo;
  /** For object relationships: the single nested object data */
  data: Record<string, unknown>;
}

interface NestedArrayInsertData {
  rel: TableInfo['relationships'][number];
  remoteTable: TableInfo;
  /** For array relationships: the array of nested object data */
  data: Record<string, unknown>[];
}

/**
 * Extract nested relationship data from a raw insert input object.
 *
 * Returns the parent object with nested relationship keys removed, plus
 * arrays of before-parent and after-parent nested inserts.
 *
 * Insertion order logic:
 * - Object relationships with `insertion_order: 'after_parent'`: insert parent first
 * - Object relationships with `insertion_order: 'before_parent'` (or default): insert child first
 * - Array relationships: always after_parent (the FK is on the child table)
 */
function extractNestedInserts(
  obj: Record<string, unknown>,
  table: TableInfo,
  allTables: TableInfo[],
): {
  cleanObj: Record<string, unknown>;
  beforeParent: NestedInsertData[];
  afterParentObj: NestedInsertData[];
  afterParentArr: NestedArrayInsertData[];
} {
  const cleanObj: Record<string, unknown> = {};
  const beforeParent: NestedInsertData[] = [];
  const afterParentObj: NestedInsertData[] = [];
  const afterParentArr: NestedArrayInsertData[] = [];

  const tableColumnNames = new Set(table.columns.map((c) => c.name));
  // Build relationship lookup by camelCase name → rel config
  const relByName = new Map<string, TableInfo['relationships'][number]>();
  for (const rel of table.relationships) {
    relByName.set(toCamelCase(rel.name), rel);
  }

  for (const [key, value] of Object.entries(obj)) {
    // Check if this key matches a relationship name (camelCase already in input)
    const rel = relByName.get(key);
    if (rel && value != null) {
      const remoteTable = allTables.find(
        (t) => t.name === rel.remoteTable.name && t.schema === rel.remoteTable.schema,
      );
      if (!remoteTable) {
        // Unknown remote table — skip
        continue;
      }

      if (rel.type === 'object') {
        const insertionOrder = rel.insertionOrder ?? 'before_parent';
        const nestedData: NestedInsertData = {
          rel,
          remoteTable,
          data: value as Record<string, unknown>,
        };
        if (insertionOrder === 'after_parent') {
          afterParentObj.push(nestedData);
        } else {
          beforeParent.push(nestedData);
        }
      } else {
        // Array relationship: always after_parent
        const arr = value as Record<string, unknown>[];
        if (arr.length > 0) {
          afterParentArr.push({
            rel,
            remoteTable,
            data: arr,
          });
        }
      }
    } else if (tableColumnNames.has(key)) {
      cleanObj[key] = value;
    } else if (!rel) {
      // Unknown key — pass through (prepareInsertData will handle it)
      cleanObj[key] = value;
    }
  }

  return { cleanObj, beforeParent, afterParentObj, afterParentArr };
}

/**
 * Get the column mapping for a relationship.
 * Returns pairs of [localColumn, remoteColumn].
 *
 * For FK-based relationships:
 * - Object rel: localColumns are on the parent, remoteColumns are PK of remote
 * - Array rel: remoteColumns are on the child, localColumns are PK of parent
 *
 * For manual_configuration: columnMapping provides the explicit mapping.
 */
function getRelColumnMapping(
  rel: TableInfo['relationships'][number],
  parentTable: TableInfo,
  remoteTable: TableInfo,
): Array<[string, string]> {
  if (rel.columnMapping) {
    return Object.entries(rel.columnMapping);
  }

  if (rel.type === 'object') {
    // Object relationship: localColumns on parent → PK of remote
    const localCols = rel.localColumns ?? [];
    const remotePK = remoteTable.primaryKey;
    return localCols.map((local, i) => [local, remotePK[i] ?? local] as [string, string]);
  } else {
    // Array relationship: remoteColumns on child → PK of parent
    const remoteCols = rel.remoteColumns ?? [];
    const parentPK = parentTable.primaryKey;
    return parentPK.map((pk, i) => [pk, remoteCols[i] ?? pk] as [string, string]);
  }
}

/**
 * Check if an insert input object contains any nested relationship data.
 */
function hasNestedData(
  obj: Record<string, unknown>,
  table: TableInfo,
): boolean {
  for (const rel of table.relationships) {
    const key = toCamelCase(rel.name);
    if (key in obj && obj[key] != null) return true;
  }
  return false;
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
    const { auth, queryWithSession, transactionalQueryWithSession, permissionLookup } = context;
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

    const rawObj = args.object as Record<string, unknown>;

    // Check for nested relationship data
    if (hasNestedData(rawObj, table)) {
      return executeNestedInsertOne(
        rawObj, table, columnMap, args, context, info, perm, auth,
      );
    }

    const obj = remapKeys(rawObj, columnMap) ?? {};
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

/**
 * Execute a nested insert_one operation.
 *
 * Handles before_parent and after_parent nested inserts within a single
 * database transaction.
 */
async function executeNestedInsertOne(
  rawObj: Record<string, unknown>,
  table: TableInfo,
  columnMap: Map<string, string>,
  args: Record<string, unknown>,
  context: ResolverContext,
  info: import('graphql').GraphQLResolveInfo,
  perm: ReturnType<ResolverContext['permissionLookup']['getInsert']>,
  auth: SessionVariables,
): Promise<Record<string, unknown> | null> {
  const { permissionLookup, transactionalQueryWithSession } = context;

  // Remap the raw input to snake_case before extracting nested data
  const remappedObj = remapKeys(rawObj, columnMap) ?? {};

  // Extract nested relationship data
  const { cleanObj, beforeParent, afterParentObj, afterParentArr } = extractNestedInserts(
    remappedObj, table, context.tables,
  );

  // Build queries in order: before_parent -> parent -> after_parent
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  // Track which query index corresponds to which step
  const steps: Array<{ type: 'before'; idx: number; nested: NestedInsertData }
    | { type: 'parent'; idx: number }
    | { type: 'after_obj'; idx: number; nested: NestedInsertData }
    | { type: 'after_arr'; idx: number; nested: NestedArrayInsertData }> = [];

  // Step 1: Compile before_parent nested inserts
  for (const nested of beforeParent) {
    const remoteColumnMap = camelToColumnMap(nested.remoteTable);
    const nestedObj = remapKeys(nested.data, remoteColumnMap) ?? nested.data;
    const remotePerm = permissionLookup.getInsert(nested.remoteTable.schema, nested.remoteTable.name, auth.role);
    if (!remotePerm && !auth.isAdmin) {
      throw permissionDenied('insert', `${nested.remoteTable.schema}.${nested.remoteTable.name}`, auth.role);
    }

    const compiled = compileInsertOne({
      table: nested.remoteTable,
      object: nestedObj,
      returningColumns: getReturningColumns(nested.remoteTable),
      permission: remotePerm ? {
        check: remotePerm.check,
        columns: remotePerm.columns,
        presets: remotePerm.presets,
      } : undefined,
      session: auth,
    });

    steps.push({ type: 'before', idx: queries.length, nested });
    queries.push({ sql: compiled.sql, params: compiled.params });
  }

  // Step 2: Parent insert (placeholder — FK values will be filled after before_parent results)
  // We need to defer compilation until we have FK values from before_parent inserts.
  // For the parent insert, we mark its position.
  const parentStepIdx = steps.length;
  const parentQueryIdx = queries.length;
  steps.push({ type: 'parent', idx: parentQueryIdx });
  // Push a placeholder — will be replaced after we know FK values
  queries.push({ sql: '', params: [] });

  // Step 3: after_parent object relationship inserts (also deferred until parent result is known)
  for (const nested of afterParentObj) {
    const afterStepIdx = steps.length;
    steps.push({ type: 'after_obj', idx: queries.length, nested });
    queries.push({ sql: '', params: [] }); // placeholder
  }

  // Step 4: after_parent array relationship inserts
  for (const nested of afterParentArr) {
    for (let i = 0; i < nested.data.length; i++) {
      steps.push({ type: 'after_arr', idx: queries.length, nested });
      queries.push({ sql: '', params: [] }); // placeholder
    }
  }

  // Now we need to execute in stages since after_parent queries depend on parent results.
  // Use a multi-step approach: execute before_parent, compile parent, execute parent,
  // compile after_parent, execute after_parent — all within one transaction.

  // Since transactionalQueryWithSession executes all queries in sequence,
  // we need a different approach: build a callback-based execution.
  // Instead, let's execute step by step using the pool directly.
  // Actually, let's use a simpler approach: execute all queries via
  // transactionalQueryWithSession but build them incrementally.

  // Simpler approach: Use transactional queries incrementally
  // Phase 1: Execute before_parent inserts
  const beforeQueries: Array<{ sql: string; params: unknown[] }> = [];
  for (const nested of beforeParent) {
    const remoteColumnMap = camelToColumnMap(nested.remoteTable);
    const nestedObj = remapKeys(nested.data, remoteColumnMap) ?? nested.data;
    const remotePerm = permissionLookup.getInsert(nested.remoteTable.schema, nested.remoteTable.name, auth.role);

    const compiled = compileInsertOne({
      table: nested.remoteTable,
      object: nestedObj,
      returningColumns: getReturningColumns(nested.remoteTable),
      permission: remotePerm ? {
        check: remotePerm.check,
        columns: remotePerm.columns,
        presets: remotePerm.presets,
      } : undefined,
      session: auth,
    });
    beforeQueries.push({ sql: compiled.sql, params: compiled.params });
  }

  // Phase 2: After getting before_parent results, set FK values on parent object
  const parentObj = { ...cleanObj };

  // Parse returning info for the parent
  const parsed = parseResolveInfo(info, table, context.tables, permissionLookup, auth, context.functions);
  const returningRelationships = parsed.relationships.length > 0
    ? parsed.relationships
    : undefined;
  const selectPerm = permissionLookup.getSelect(table.schema, table.name, auth.role);
  const returningComputedFields = buildComputedFieldSelections(
    parsed.computedFields,
    table,
    context.functions,
    selectPerm?.computedFields,
    auth.isAdmin,
  );
  const returningSetReturningComputedFields = buildSetReturningComputedFieldSelections(
    parsed.setReturningComputedFields,
    table,
    context.functions,
    selectPerm?.computedFields,
    auth.isAdmin,
  );

  let onConflict: { constraint: string; updateColumns: string[]; where?: BoolExp } | undefined;
  if (args.onConflict) {
    const oc = args.onConflict as Record<string, unknown>;
    const updateCols = (oc.updateColumns as string[] | undefined) ?? [];
    const remappedUpdateCols = updateCols.map((c: string) => columnMap.get(c) ?? c);
    onConflict = {
      constraint: oc.constraint as string,
      updateColumns: remappedUpdateCols,
      where: oc.where ? remapBoolExp(oc.where as BoolExp, columnMap) : undefined,
    };
  }

  // Build all queries in order for transactional execution
  const allQueries: Array<{ sql: string; params: unknown[] }> = [...beforeQueries];

  // We can't pre-compile parent and after_parent because they depend on
  // results of earlier queries. Instead, use a callback-style execution.
  // Let's use the pool directly with manual transaction management.

  // Get the pool from context
  const pool = context.pool;
  if (!pool) {
    throw new Error('Database pool not available for nested insert transaction');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Inject session variables
    const sessionJson = JSON.stringify(auth.claims);
    await client.query(`SELECT set_config('hasura.user', $1, true)`, [sessionJson]);
    if (auth.userId) {
      await client.query(`SELECT set_config('hakkyra.user_id', $1, true)`, [auth.userId]);
    }
    await client.query(`SELECT set_config('hakkyra.role', $1, true)`, [auth.role]);

    // Phase 1: Execute before_parent inserts and collect FK values
    for (let i = 0; i < beforeParent.length; i++) {
      const nested = beforeParent[i];
      const q = beforeQueries[i];
      const result = await client.query(q.sql, q.params);
      const row = result.rows[0] as Record<string, unknown> | undefined;
      const childData = row?.data as Record<string, unknown> | undefined;

      if (!childData) {
        throw new Error(
          `Nested insert for "${nested.remoteTable.name}" returned no data`,
        );
      }

      // Set FK values on parent: localColumn = childData[remoteColumn]
      const mapping = getRelColumnMapping(nested.rel, table, nested.remoteTable);
      for (const [localCol, remoteCol] of mapping) {
        parentObj[localCol] = childData[remoteCol];
      }
    }

    // Phase 2: Compile and execute parent insert
    const parentCompiled = compileInsertOne({
      table,
      object: parentObj,
      returningColumns: getReturningColumns(table),
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

    const parentResult = await client.query(parentCompiled.sql, parentCompiled.params);
    const parentRow = parentResult.rows[0] as Record<string, unknown> | undefined;
    const parentData = parentRow?.data as Record<string, unknown> | undefined;

    if (!parentData || typeof parentData !== 'object') {
      if (perm?.check && parentResult.rowCount === 0) {
        throw new Error(
          `Insert check constraint failed for "${table.schema}"."${table.name}"`,
        );
      }
      await client.query('COMMIT');
      return null;
    }

    // Phase 3: Execute after_parent object relationship inserts
    for (const nested of afterParentObj) {
      const remoteColumnMap = camelToColumnMap(nested.remoteTable);
      const nestedObj = remapKeys(nested.data, remoteColumnMap) ?? { ...nested.data };
      const remotePerm = permissionLookup.getInsert(nested.remoteTable.schema, nested.remoteTable.name, auth.role);
      if (!remotePerm && !auth.isAdmin) {
        throw permissionDenied('insert', `${nested.remoteTable.schema}.${nested.remoteTable.name}`, auth.role);
      }

      // Set FK values on child: remoteColumn = parentData[localColumn]
      const mapping = getRelColumnMapping(nested.rel, table, nested.remoteTable);
      const childObj = { ...nestedObj };
      for (const [localCol, remoteCol] of mapping) {
        childObj[remoteCol] = parentData[localCol];
      }

      const compiled = compileInsertOne({
        table: nested.remoteTable,
        object: childObj,
        returningColumns: getReturningColumns(nested.remoteTable),
        permission: remotePerm ? {
          check: remotePerm.check,
          columns: remotePerm.columns,
          presets: remotePerm.presets,
        } : undefined,
        session: auth,
      });
      await client.query(compiled.sql, compiled.params);
    }

    // Phase 4: Execute after_parent array relationship inserts
    for (const nested of afterParentArr) {
      const remoteColumnMap = camelToColumnMap(nested.remoteTable);
      const remotePerm = permissionLookup.getInsert(nested.remoteTable.schema, nested.remoteTable.name, auth.role);
      if (!remotePerm && !auth.isAdmin) {
        throw permissionDenied('insert', `${nested.remoteTable.schema}.${nested.remoteTable.name}`, auth.role);
      }

      const mapping = getRelColumnMapping(nested.rel, table, nested.remoteTable);

      for (const item of nested.data) {
        const nestedObj = remapKeys(item, remoteColumnMap) ?? { ...item };
        const childObj = { ...nestedObj };
        // Set FK values on child: remoteColumn = parentData[localColumn]
        for (const [localCol, remoteCol] of mapping) {
          childObj[remoteCol] = parentData[localCol];
        }

        const compiled = compileInsertOne({
          table: nested.remoteTable,
          object: childObj,
          returningColumns: getReturningColumns(nested.remoteTable),
          permission: remotePerm ? {
            check: remotePerm.check,
            columns: remotePerm.columns,
            presets: remotePerm.presets,
          } : undefined,
          session: auth,
        });
        await client.query(compiled.sql, compiled.params);
      }
    }

    await client.query('COMMIT');
    return remapRowToCamel(parentData as Record<string, unknown>, table);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
