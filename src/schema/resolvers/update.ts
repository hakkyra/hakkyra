/**
 * Update resolver factories: makeUpdateResolver, makeUpdateByPkResolver, makeUpdateManyResolver.
 */

import type { GraphQLFieldResolver } from 'graphql';
import type {
  TableInfo,
  BoolExp,
} from '../../types.js';
import { compileUpdateByPk, compileUpdate, compileUpdateMany } from '../../sql/update.js';
import type { JsonbOperators } from '../../sql/update.js';
import { parseResolveInfo, parseReturningInfo } from '../resolve-info.js';
import {
  type ResolverContext,
  permissionDenied,
  camelToColumnMap,
  remapKeys,
  remapBoolExp,
  getReturningColumns,
  buildComputedFieldSelections,
  remapRowToCamel,
  remapRowsToCamel,
} from './helpers.js';

// ─── JSONB Operator Extraction ───────────────────────────────────────────────

/**
 * Extract JSONB mutation operator args from the GraphQL args and remap
 * camelCase field names to PG column names. Returns undefined if no
 * JSONB operators are present.
 */
function extractJsonbOps(
  args: Record<string, unknown>,
  columnMap: Map<string, string>,
): JsonbOperators | undefined {
  const ops: JsonbOperators = {};
  let hasAny = false;

  if (args._append) {
    ops._append = remapKeys(args._append as Record<string, unknown>, columnMap);
    if (ops._append && Object.keys(ops._append).length > 0) hasAny = true;
  }
  if (args._prepend) {
    ops._prepend = remapKeys(args._prepend as Record<string, unknown>, columnMap);
    if (ops._prepend && Object.keys(ops._prepend).length > 0) hasAny = true;
  }
  if (args._deleteAtPath) {
    ops._deleteAtPath = remapKeys(args._deleteAtPath as Record<string, unknown>, columnMap) as Record<string, string[]> | undefined;
    if (ops._deleteAtPath && Object.keys(ops._deleteAtPath).length > 0) hasAny = true;
  }
  if (args._deleteElem) {
    ops._deleteElem = remapKeys(args._deleteElem as Record<string, unknown>, columnMap) as Record<string, number> | undefined;
    if (ops._deleteElem && Object.keys(ops._deleteElem).length > 0) hasAny = true;
  }
  if (args._deleteKey) {
    ops._deleteKey = remapKeys(args._deleteKey as Record<string, unknown>, columnMap) as Record<string, string> | undefined;
    if (ops._deleteKey && Object.keys(ops._deleteKey).length > 0) hasAny = true;
  }

  return hasAny ? ops : undefined;
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
    const incValues = remapKeys(args._inc as Record<string, unknown> | undefined, columnMap);
    const jsonbOps = extractJsonbOps(args, columnMap);

    // If no _set values, no _inc values, and no JSONB operators, nothing to update
    if ((!setValues || Object.keys(setValues).length === 0) && (!incValues || Object.keys(incValues).length === 0) && !jsonbOps) {
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
      _set: setValues ?? {},
      _inc: incValues,
      jsonbOps,
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
    const incValues = remapKeys(args._inc as Record<string, unknown> | undefined, columnMap);
    const jsonbOps = extractJsonbOps(args, columnMap);

    // If no _set values, no _inc values, and no JSONB operators, nothing to update
    if ((!setValues || Object.keys(setValues).length === 0) && (!incValues || Object.keys(incValues).length === 0) && !jsonbOps) {
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
      _set: setValues ?? {},
      _inc: incValues,
      jsonbOps,
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
 * Arguments: updates (required) — array of { where, _set, _inc, _append, _prepend, _deleteAtPath, _deleteElem, _deleteKey }
 * Returns: [<Type>MutationResponse] { affectedRows, returning }
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

    const rawUpdates = args.updates as Array<Record<string, unknown>>;
    if (!rawUpdates || rawUpdates.length === 0) {
      return [];
    }

    const returningColumns = getReturningColumns(table);

    // Parse returning selection set for relationships and computed fields
    const returningParsed = parseReturningInfo(info, table, context.tables, permissionLookup, auth, context.functions);
    const returningRelationships = returningParsed?.relationships && returningParsed.relationships.length > 0
      ? returningParsed.relationships
      : undefined;

    // Build computed field selections (use select permission for returning clause access)
    const updateManySelectPerm = permissionLookup.getSelect(table.schema, table.name, auth.role);
    const returningComputedFields = buildComputedFieldSelections(
      returningParsed?.computedFields,
      table,
      context.functions,
      updateManySelectPerm?.computedFields,
      auth.isAdmin,
    );

    // Compile each update — extract all operator fields from each entry
    const updates = rawUpdates.map((entry) => ({
      where: remapBoolExp(entry.where as BoolExp | undefined, columnMap) ?? ({} as BoolExp),
      _set: remapKeys(entry._set as Record<string, unknown> | undefined, columnMap) ?? {},
      _inc: remapKeys(entry._inc as Record<string, unknown> | undefined, columnMap),
      jsonbOps: extractJsonbOps(entry, columnMap),
    }));

    const compiledQueries = compileUpdateMany({
      table,
      updates,
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

    // Execute each update query and return one MutationResponse per entry
    // (Hasura returns [MutationResponse] — one result per update entry)
    const results: Array<{ affectedRows: number; returning: Record<string, unknown>[] }> = [];

    for (const compiled of compiledQueries) {
      const result = await queryWithSession(compiled.sql, compiled.params, auth, 'write');

      // CTE pattern (check OR relationships, jsonbPaths, or computedFields): single row with "data" as JSON array
      // Without CTE: each row has a "data" column
      const usesCTE = !!(perm?.check || returningRelationships || returningParsed?.jsonbPaths?.size
        || returningComputedFields.length > 0);

      if (usesCTE) {
        const firstRow = result.rows[0] as Record<string, unknown> | undefined;
        const data = firstRow?.data;
        if (data && Array.isArray(data)) {
          results.push({
            affectedRows: data.length,
            returning: remapRowsToCamel(data as Record<string, unknown>[], table),
          });
        } else {
          results.push({ affectedRows: 0, returning: [] });
        }
      } else {
        const rows = result.rows.map((row) => {
          const r = row as Record<string, unknown>;
          const data = r.data as Record<string, unknown> | undefined;
          return data ? remapRowToCamel(data, table) : {};
        });
        results.push({
          affectedRows: rows.length,
          returning: rows,
        });
      }
    }

    return results;
  };
}
