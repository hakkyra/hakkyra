/**
 * Delete resolver factories: makeDeleteResolver, makeDeleteByPkResolver.
 */

import type { GraphQLFieldResolver } from 'graphql';
import type {
  TableInfo,
  BoolExp,
} from '../../types.js';
import { compileDeleteByPk, compileDelete } from '../../sql/delete.js';
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
