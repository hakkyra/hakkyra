/**
 * Select resolver factories: makeSelectResolver, makeSelectByPkResolver, makeSelectAggregateResolver.
 */

import type { GraphQLFieldResolver } from 'graphql';
import type {
  TableInfo,
  BoolExp,
  FunctionInfo,
} from '../../types.js';
import type { AggregateSelection, AggregateComputedFieldRef } from '../../sql/select.js';
import { compileSelect, compileSelectByPk, compileSelectAggregate } from '../../sql/select.js';
import { toCamelCase } from '../type-builder.js';
import { parseResolveInfo, parseAggregateNodesInfo } from '../resolve-info.js';
import {
  type ResolverContext,
  permissionDenied,
  isQueryRootFieldAllowed,
  camelToColumnMap,
  camelToColumnAndCFMap,
  remapKeys,
  remapBoolExp,
  remapOrderBy,
  getAllowedColumns,
  resolveLimit,
  isNumericColumn,
  buildComputedFieldSelections,
  buildSetReturningComputedFieldSelections,
  buildAggregateRelationshipSelections,
  remapRowToCamel,
  remapRowsToCamel,
} from './helpers.js';

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

    // Build aggregate relationship selections
    const aggregateRelationships = buildAggregateRelationshipSelections(
      parsed.aggregateRelationships,
      auth,
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
      aggregateRelationships: aggregateRelationships.length > 0 ? aggregateRelationships : undefined,
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

    // Build aggregate relationship selections
    const aggregateRelationships = buildAggregateRelationshipSelections(
      parsed.aggregateRelationships,
      auth,
    );

    const compiled = compileSelectByPk({
      table,
      pkValues,
      columns,
      relationships: parsed.relationships,
      aggregateRelationships: aggregateRelationships.length > 0 ? aggregateRelationships : undefined,
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
        const NUMERIC_PG_RETURN = new Set(['int2', 'smallint', 'int4', 'integer', 'int8', 'bigint', 'float4', 'real', 'float8', 'double precision', 'numeric', 'serial', 'serial4', 'serial8', 'bigserial', 'oid']);
        if (NUMERIC_PG_RETURN.has(fn.returnType)) {
          numericCFRefs.push({ name: toCamelCase(cf.name), functionName: cf.function.name, schema: fnSchema });
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
    }

    // Add numeric computed fields to aggregates (both groupBy and non-groupBy paths)
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
