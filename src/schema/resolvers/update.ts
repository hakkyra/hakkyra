/**
 * Update resolver factories: makeUpdateResolver, makeUpdateByPkResolver, makeUpdateManyResolver.
 */

import type { GraphQLFieldResolver } from 'graphql';
import type {
  TableInfo,
  BoolExp,
} from '../../types.js';
import { compileUpdateByPk, compileUpdate, compileUpdateMany } from '../../sql/update.js';
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
