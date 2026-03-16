/**
 * Tracked function support: exposes PostgreSQL functions as top-level
 * GraphQL Query/Mutation fields, matching Hasura's behavior.
 *
 * For SETOF functions returning a tracked table:
 * - Returns [TableType!]! with full query args (where, orderBy, limit, offset, distinctOn)
 * - Generates {functionName}Aggregate variant
 * - Function arguments are wrapped in an `args` input type
 *
 * For scalar/single-row functions:
 * - Returns the table type (nullable)
 * - Function arguments are wrapped in an `args` input type
 *
 * Permission model:
 * - Function-level: role must be listed in function's permissions
 * - Return-table-level: select permissions apply for column/row filtering
 *
 * Routing:
 * - Volatile functions -> primary DB (write intent)
 * - Stable/Immutable functions -> replicas (read intent)
 */

import {
  GraphQLObjectType,
  GraphQLNonNull,
  GraphQLList,
  GraphQLInt,
  GraphQLFloat,
  GraphQLString,
  GraphQLBoolean,
  GraphQLInputObjectType,
} from 'graphql';
import type {
  GraphQLFieldConfig,
  GraphQLFieldConfigArgumentMap,
  GraphQLInputType,
  GraphQLScalarType,
} from 'graphql';
import type {
  TrackedFunctionConfig,
  FunctionInfo,
  TableInfo,
  SessionVariables,
  BoolExp,
} from '../types.js';
import { customScalars } from './scalars.js';
import { toCamelCase, toPascalCase, getColumnFieldName, tableKey } from './type-builder.js';
import type { TypeRegistry } from './type-builder.js';
import type { ResolverContext, ResolverPermissionLookup } from './resolvers.js';
import { remapBoolExp as remapBoolExpFull } from './resolvers.js';
import { parseResolveInfo } from './resolve-info.js';
import {
  compileSelect,
  compileSelectAggregate,
  filterColumns,
  buildJsonFields,
  AliasCounter,
} from '../sql/select.js';
import type { OrderByItem, AggregateSelection, RelationshipSelection } from '../sql/select.js';
import { ParamCollector, quoteIdentifier, quoteTableRef } from '../sql/utils.js';
import { compileWhere } from '../sql/where.js';

// ─── Type Mapping for Function Arguments ──────────────────────────────────

/** Built-in GraphQL scalars by name */
const BUILTIN_SCALARS: Record<string, GraphQLScalarType> = {
  Int: GraphQLInt as unknown as GraphQLScalarType,
  Float: GraphQLFloat as unknown as GraphQLScalarType,
  String: GraphQLString as unknown as GraphQLScalarType,
  Boolean: GraphQLBoolean as unknown as GraphQLScalarType,
};

/**
 * Map from PG type name to GraphQL input type name.
 */
const PG_ARG_TYPE_MAP: Record<string, string> = {
  text: 'String',
  varchar: 'String',
  char: 'String',
  bpchar: 'String',
  name: 'String',
  int2: 'Int',
  int4: 'Int',
  serial: 'Int',
  serial4: 'Int',
  int8: 'BigInt',
  bigserial: 'BigInt',
  serial8: 'BigInt',
  float4: 'Float',
  float8: 'Float',
  numeric: 'BigDecimal',
  money: 'BigDecimal',
  bool: 'Boolean',
  boolean: 'Boolean',
  uuid: 'UUID',
  json: 'JSON',
  jsonb: 'JSON',
  timestamp: 'DateTime',
  timestamptz: 'DateTime',
  date: 'Date',
  time: 'Time',
  timetz: 'Time',
  interval: 'Interval',
  bytea: 'Bytea',
  inet: 'Inet',
  cidr: 'Inet',
  integer: 'Int',
  bigint: 'BigInt',
  'double precision': 'Float',
  real: 'Float',
  'character varying': 'String',
  character: 'String',
};

export function pgArgTypeToGraphQL(pgType: string): GraphQLInputType {
  const normalized = pgType.toLowerCase().replace(/\s+/g, ' ').trim();
  const graphqlName = PG_ARG_TYPE_MAP[normalized] ?? 'String';

  const builtin = BUILTIN_SCALARS[graphqlName];
  if (builtin) return builtin;

  const custom = customScalars[graphqlName];
  if (custom) return custom;

  return GraphQLString as unknown as GraphQLScalarType;
}

// ─── Naming ──────────────────────────────────────────────────────────────

/**
 * Convert a snake_case function name to camelCase for GraphQL field name.
 * e.g., "latest_wins" -> "latestWins", "accept_contract_with_token" -> "acceptContractWithToken"
 */
function functionFieldName(fnName: string): string {
  return toCamelCase(fnName);
}

/**
 * Convert a snake_case function name to PascalCase for args type.
 * e.g., "latest_wins" -> "LatestWinsArgs"
 */
function functionArgsTypeName(fnName: string): string {
  return toPascalCase(fnName) + 'Args';
}

// ─── Tracked Function Info (merged config + introspection) ────────────────

export interface TrackedFunctionInfo {
  config: TrackedFunctionConfig;
  functionInfo: FunctionInfo;
  /** The table this function returns rows from (for SETOF functions). */
  returnTable?: TableInfo;
  /** The function arguments, excluding the table-row argument (for computed fields)
   *  and the session argument. */
  userArgs: Array<{ name: string; pgType: string }>;
}

/**
 * Match tracked function configs with introspected FunctionInfo objects.
 * Identifies the return table for SETOF functions.
 */
export function resolveTrackedFunctions(
  trackedConfigs: TrackedFunctionConfig[],
  introspectedFunctions: FunctionInfo[],
  tables: TableInfo[],
): TrackedFunctionInfo[] {
  const result: TrackedFunctionInfo[] = [];

  for (const config of trackedConfigs) {
    const fn = introspectedFunctions.find(
      (f) => f.name === config.name && f.schema === config.schema,
    );
    if (!fn) {
      console.warn(
        `[hakkyra:tracked-functions] Function "${config.schema}.${config.name}" not found in introspection — skipping`,
      );
      continue;
    }

    let returnTable: TableInfo | undefined;
    if (fn.isSetReturning) {
      // Find the return table by matching the return type against tracked tables
      returnTable = tables.find(
        (t) => t.name === fn.returnType || `${t.schema}.${t.name}` === fn.returnType,
      );
      if (!returnTable) {
        console.warn(
          `[hakkyra:tracked-functions] Return table "${fn.returnType}" for SETOF function "${config.name}" not tracked — skipping`,
        );
        continue;
      }
    } else {
      // For non-SETOF functions, check if the return type is a tracked table
      returnTable = tables.find(
        (t) => t.name === fn.returnType || `${t.schema}.${t.name}` === fn.returnType,
      );
      // If it returns a non-table type (e.g., text, int), we skip for now
      // since Hasura requires tracked functions to return table types
      if (!returnTable) {
        console.warn(
          `[hakkyra:tracked-functions] Return type "${fn.returnType}" for function "${config.name}" is not a tracked table — skipping`,
        );
        continue;
      }
    }

    // Determine user-facing arguments (exclude table-row and session args)
    const userArgs: Array<{ name: string; pgType: string }> = [];
    for (let i = 0; i < fn.argTypes.length; i++) {
      const argName = fn.argNames[i] ?? `arg${i}`;

      // Skip session argument if configured
      if (config.sessionArgument && argName === config.sessionArgument) {
        continue;
      }

      // Skip table-row arguments (they reference a composite type matching a table name)
      // These are for computed fields, not tracked function root fields
      const argType = fn.argTypes[i];
      const isTableRowType = tables.some(
        (t) => argType === t.name || argType === `${t.schema}.${t.name}`,
      );
      if (isTableRowType) continue;

      userArgs.push({ name: argName, pgType: argType });
    }

    // Resolve exposedAs: if not explicitly set, default based on volatility
    // (Hasura exposes volatile functions as mutations, stable/immutable as queries)
    const resolvedConfig = config.exposedAs
      ? config
      : { ...config, exposedAs: fn.volatility === 'volatile' ? 'mutation' as const : 'query' as const };

    result.push({ config: resolvedConfig, functionInfo: fn, returnTable, userArgs });
  }

  return result;
}

// ─── Schema Builder ─────────────────────────────────────────────────────

export interface TrackedFunctionFields {
  queryFields: Record<string, GraphQLFieldConfig<unknown, ResolverContext>>;
  mutationFields: Record<string, GraphQLFieldConfig<unknown, ResolverContext>>;
  inputTypes: GraphQLInputObjectType[];
}

/**
 * Build GraphQL field configs for all tracked functions.
 */
export function buildTrackedFunctionFields(
  trackedFunctions: TrackedFunctionInfo[],
  typeRegistry: TypeRegistry,
  filterTypes: Map<string, GraphQLInputObjectType>,
  orderByTypes: Map<string, GraphQLInputObjectType>,
  selectColumnEnums: Map<string, import('graphql').GraphQLEnumType>,
  aggregateTypes: Map<string, GraphQLObjectType>,
): TrackedFunctionFields {
  const queryFields: Record<string, GraphQLFieldConfig<unknown, ResolverContext>> = {};
  const mutationFields: Record<string, GraphQLFieldConfig<unknown, ResolverContext>> = {};
  const inputTypes: GraphQLInputObjectType[] = [];

  for (const trackedFn of trackedFunctions) {
    const { config, functionInfo: fn, returnTable, userArgs } = trackedFn;
    if (!returnTable) continue;

    const key = tableKey(returnTable.schema, returnTable.name);
    const objectType = typeRegistry.get(key);
    if (!objectType) continue;

    // Derive field names
    const fieldName = config.customRootFields?.function ?? functionFieldName(config.name);

    // Build args input type if there are user arguments
    let argsInputType: GraphQLInputObjectType | undefined;
    if (userArgs.length > 0) {
      const argsFields: Record<string, { type: GraphQLInputType }> = {};
      for (const arg of userArgs) {
        argsFields[toCamelCase(arg.name)] = {
          type: pgArgTypeToGraphQL(arg.pgType),
        };
      }
      argsInputType = new GraphQLInputObjectType({
        name: functionArgsTypeName(config.name),
        fields: argsFields,
      });
      inputTypes.push(argsInputType);
    }

    // Build the field arguments
    const fieldArgs: GraphQLFieldConfigArgumentMap = {};

    if (argsInputType) {
      // Hasura makes args optional even when there are user arguments
      fieldArgs['args'] = { type: argsInputType };
    }

    if (fn.isSetReturning) {
      // SETOF function: add query-like args (where, orderBy, limit, offset, distinctOn)
      const filterType = filterTypes.get(key);
      if (filterType) {
        fieldArgs['where'] = { type: filterType };
      }

      const orderByType = orderByTypes.get(key);
      if (orderByType) {
        fieldArgs['orderBy'] = {
          type: new GraphQLList(new GraphQLNonNull(orderByType)),
        };
      }

      fieldArgs['limit'] = { type: GraphQLInt };
      fieldArgs['offset'] = { type: GraphQLInt };

      const selectColumnEnum = selectColumnEnums.get(key);
      if (selectColumnEnum) {
        fieldArgs['distinctOn'] = {
          type: new GraphQLList(new GraphQLNonNull(selectColumnEnum)),
        };
      }

      // Return type: [TableType!]!
      const fieldConfig: GraphQLFieldConfig<unknown, ResolverContext> = {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(objectType))),
        args: fieldArgs,
        resolve: makeTrackedFunctionResolver(trackedFn),
        description: `Execute function ${config.schema}.${config.name}`,
      };

      if (config.exposedAs === 'mutation') {
        mutationFields[fieldName] = fieldConfig;
      } else {
        queryFields[fieldName] = fieldConfig;
      }

      // Aggregate variant for SETOF query functions
      if (config.exposedAs !== 'mutation') {
        const aggFieldName = config.customRootFields?.functionAggregate
          ?? `${fieldName}Aggregate`;
        const aggType = aggregateTypes.get(key);
        if (aggType) {
          const aggArgs: GraphQLFieldConfigArgumentMap = {};
          if (argsInputType) {
            aggArgs['args'] = { type: argsInputType };
          }
          const filterType2 = filterTypes.get(key);
          if (filterType2) {
            aggArgs['where'] = { type: filterType2 };
          }
          const orderByType2 = orderByTypes.get(key);
          if (orderByType2) {
            aggArgs['orderBy'] = {
              type: new GraphQLList(new GraphQLNonNull(orderByType2)),
            };
          }
          aggArgs['limit'] = { type: GraphQLInt };
          aggArgs['offset'] = { type: GraphQLInt };

          queryFields[aggFieldName] = {
            type: new GraphQLNonNull(aggType),
            args: aggArgs,
            resolve: makeTrackedFunctionAggregateResolver(trackedFn),
            description: `Aggregate results of function ${config.schema}.${config.name}`,
          };
        }
      }
    } else {
      // Non-SETOF function: returns a single row (nullable)
      const fieldConfig: GraphQLFieldConfig<unknown, ResolverContext> = {
        type: objectType,
        args: fieldArgs,
        resolve: makeTrackedFunctionResolver(trackedFn),
        description: `Execute function ${config.schema}.${config.name}`,
      };

      if (config.exposedAs === 'mutation') {
        mutationFields[fieldName] = fieldConfig;
      } else {
        queryFields[fieldName] = fieldConfig;
      }
    }
  }

  return { queryFields, mutationFields, inputTypes };
}

// ─── SQL Compiler for Tracked Functions ──────────────────────────────────

/**
 * Compile a tracked function call to SQL.
 *
 * For SETOF: SELECT coalesce(json_agg(json_build_object(...)), '[]'::json) AS "data"
 *            FROM "schema"."func"($1, $2) "t0" WHERE ... ORDER BY ... LIMIT ...
 *
 * For scalar: SELECT json_build_object(...) AS "data"
 *             FROM "schema"."func"($1, $2) "t0" LIMIT 1
 */
function compileTrackedFunctionCall(opts: {
  trackedFn: TrackedFunctionInfo;
  funcArgs: NamedArg[];
  table: TableInfo;
  columns: string[];
  where?: BoolExp;
  orderBy?: OrderByItem[];
  limit?: number;
  offset?: number;
  distinctOn?: string[];
  relationships?: RelationshipSelection[];
  permission?: {
    filter: import('../types.js').CompiledFilter;
    columns: string[] | '*';
    limit?: number;
  };
  session: SessionVariables;
}): { sql: string; params: unknown[] } {
  const params = new ParamCollector();
  const aliasCounter = new AliasCounter();
  const alias = aliasCounter.next(); // t0

  const { trackedFn, table } = opts;
  const fn = trackedFn.functionInfo;

  // Build function call with named parameters so PG uses DEFAULT for omitted args
  const funcCall = buildNamedFuncCall(fn.schema, fn.name, opts.funcArgs, params);

  // Filter columns against permissions
  const columns = filterColumns(
    opts.columns,
    table,
    opts.permission?.columns,
  );

  // Build json_build_object fields
  const jsonFields = buildJsonFields(
    columns,
    alias,
    opts.relationships,
    params,
    opts.session,
    aliasCounter,
    undefined,
    undefined,
    undefined,
    table.customColumnNames,
  );

  // Build WHERE clause
  const whereParts: string[] = [];
  const userWhere = compileWhere(opts.where, params, alias, opts.session);
  if (userWhere) whereParts.push(userWhere);

  if (opts.permission?.filter) {
    const permResult = opts.permission.filter.toSQL(
      opts.session,
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

  if (fn.isSetReturning) {
    // ORDER BY
    let orderByClause = '';
    if (opts.orderBy && opts.orderBy.length > 0) {
      const parts = opts.orderBy.map((item) => {
        let clause = `${quoteIdentifier(alias)}.${quoteIdentifier(item.column)} ${item.direction.toUpperCase()}`;
        if (item.nulls) {
          clause += ` NULLS ${item.nulls.toUpperCase()}`;
        }
        return clause;
      });
      orderByClause = ` ORDER BY ${parts.join(', ')}`;
    }

    // LIMIT / OFFSET
    let limitOffsetClause = '';
    const effectiveLimit = resolveLimit(opts.limit, opts.permission?.limit);
    if (effectiveLimit !== undefined) {
      limitOffsetClause += ` LIMIT ${params.add(effectiveLimit)}`;
    }
    if (opts.offset !== undefined) {
      limitOffsetClause += ` OFFSET ${params.add(opts.offset)}`;
    }

    let sql: string;
    if (orderByClause || limitOffsetClause) {
      const innerSql = [
        `SELECT json_build_object(${jsonFields}) AS "_row_"`,
        `FROM ${funcCall} ${quoteIdentifier(alias)}`,
        whereClause ? whereClause.trim() : null,
        orderByClause ? orderByClause.trim() : null,
        limitOffsetClause ? limitOffsetClause.trim() : null,
      ].filter(Boolean).join('\n');
      sql = `SELECT coalesce(json_agg("_inner_"."_row_"), '[]'::json) AS "data" FROM (${innerSql}) "_inner_"`;
    } else {
      sql = [
        `SELECT coalesce(json_agg(json_build_object(${jsonFields})), '[]'::json) AS "data"`,
        `FROM ${funcCall} ${quoteIdentifier(alias)}`,
        whereClause ? whereClause.trim() : null,
      ].filter(Boolean).join('\n');
    }

    return { sql, params: params.getParams() };
  } else {
    // Non-SETOF: single row
    const sql = [
      `SELECT json_build_object(${jsonFields}) AS "data"`,
      `FROM ${funcCall} ${quoteIdentifier(alias)}`,
      whereClause ? whereClause.trim() : null,
      'LIMIT 1',
    ].filter(Boolean).join('\n');

    return { sql, params: params.getParams() };
  }
}

/**
 * Build a function call using named parameter notation so that omitted
 * arguments fall back to their PostgreSQL DEFAULT values.
 */
function buildNamedFuncCall(
  schema: string,
  name: string,
  namedArgs: NamedArg[],
  params: ParamCollector,
): string {
  const parts = namedArgs.map(
    (arg) => `${quoteIdentifier(arg.name)} := ${params.add(arg.value)}`,
  );
  return `${quoteIdentifier(schema)}.${quoteIdentifier(name)}(${parts.join(', ')})`;
}

function resolveLimit(userLimit?: number, permLimit?: number): number | undefined {
  if (userLimit !== undefined && permLimit !== undefined) {
    return Math.min(userLimit, permLimit);
  }
  return userLimit ?? permLimit;
}

// ─── Row remapping (snake_case → camelCase) ─────────────────────────────

/**
 * Remap row keys from snake_case to camelCase for GraphQL response.
 * Matches the remapping done by regular table resolvers.
 */
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
  // Preserve any extra keys (e.g., relationship subquery results)
  for (const [key, value] of Object.entries(row)) {
    const camelKey = toCamelCase(key);
    if (!(camelKey in result)) {
      result[camelKey] = value;
    }
  }
  return result;
}

// ─── camelCase / snake_case helpers ──────────────────────────────────────

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

function remapOrderBy(
  orderBy: Array<Record<string, string>> | undefined | null,
  columnMap: Map<string, string>,
): OrderByItem[] | undefined {
  if (!orderBy || !Array.isArray(orderBy) || orderBy.length === 0) return undefined;

  return orderBy.map((item) => {
    for (const [camelKey, direction] of Object.entries(item)) {
      const pgName = columnMap.get(camelKey) ?? camelKey;
      const parts = (direction as string).toLowerCase().split('_');
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

function remapDistinctOn(
  distinctOn: string[] | undefined | null,
  columnMap: Map<string, string>,
): string[] | undefined {
  if (!distinctOn || distinctOn.length === 0) return undefined;
  return distinctOn.map((camelKey) => columnMap.get(camelKey) ?? camelKey);
}

// ─── Resolver Factories ─────────────────────────────────────────────────

interface NamedArg {
  name: string;
  value: unknown;
}

function extractFuncArgs(
  trackedFn: TrackedFunctionInfo,
  args: Record<string, unknown>,
  session: SessionVariables,
): NamedArg[] {
  const fnArgs = args.args as Record<string, unknown> | undefined;
  const result: NamedArg[] = [];

  // Build args using named parameters so that unprovided arguments with
  // PG DEFAULT values are omitted (letting PostgreSQL use the defaults).
  const { functionInfo: fn, config } = trackedFn;
  // In PG, defaults apply to the last N input arguments (pronargdefaults).
  const totalArgs = fn.argTypes.length;
  const firstDefaultIdx = totalArgs - fn.numArgsWithDefaults;

  for (let i = 0; i < totalArgs; i++) {
    const argName = fn.argNames[i] ?? `arg${i}`;

    // Session argument: inject the session JSON
    if (config.sessionArgument && argName === config.sessionArgument) {
      result.push({ name: argName, value: JSON.stringify(session.claims) });
      continue;
    }

    // Table-row argument: skip (not applicable for root-level tracked functions)
    const isUserArg = trackedFn.userArgs.some((ua) => ua.name === argName);
    if (!isUserArg && argName !== config.sessionArgument) {
      continue;
    }

    // User argument: get from args input
    const camelName = toCamelCase(argName);
    const value = fnArgs?.[camelName];

    // If not provided and this arg has a PG DEFAULT, omit it
    if (value === undefined && i >= firstDefaultIdx) continue;

    result.push({ name: argName, value: value ?? null });
  }

  return result;
}

/**
 * Check if a role has permission for a tracked function, including inherited roles.
 * An inherited role has access if any of its constituent roles has access.
 */
function hasRolePermission(
  role: string,
  permissions: { role: string }[],
  inheritedRoles: Record<string, string[]>,
): boolean {
  // Direct match
  if (permissions.some((p) => p.role === role)) return true;
  // Inherited role: check constituent roles
  const roleSet = inheritedRoles[role];
  if (roleSet) {
    return roleSet.some((r) => permissions.some((p) => p.role === r));
  }
  return false;
}

function makeTrackedFunctionResolver(
  trackedFn: TrackedFunctionInfo,
): (parent: unknown, args: Record<string, unknown>, context: ResolverContext, info: import('graphql').GraphQLResolveInfo) => Promise<unknown> {
  return async (_parent, args, context, info) => {
    const { auth, queryWithSession, permissionLookup, inheritedRoles, tables, functions } = context;
    const { config, functionInfo: fn, returnTable } = trackedFn;
    if (!returnTable) throw new Error(`No return table for function ${config.name}`);

    // ── Function-level permission check ──────────────────────────────
    if (!auth.isAdmin) {
      if (!config.permissions || config.permissions.length === 0) {
        throw new Error(
          `Permission denied: no roles have access to function "${config.name}"`,
        );
      }
      const hasPerm = hasRolePermission(auth.role, config.permissions, inheritedRoles);
      if (!hasPerm) {
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
    const where = remapBoolExpFull(args.where as BoolExp | undefined, colMap, returnTable, tables);
    const orderBy = remapOrderBy(
      args.orderBy as Array<Record<string, string>> | undefined,
      colMap,
    );
    const distinctOn = remapDistinctOn(
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
    });

    // ── Execute query ────────────────────────────────────────────────
    const intent = fn.volatility === 'volatile' ? 'write' : 'read';
    const result = await queryWithSession(compiled.sql, compiled.params, auth, intent);

    if (fn.isSetReturning) {
      const row = result.rows[0] as { data: unknown } | undefined;
      const data = row?.data ?? [];
      return Array.isArray(data)
        ? data.map((r: Record<string, unknown>) => remapRowToCamel(r, returnTable))
        : data;
    } else {
      const row = result.rows[0] as { data: unknown } | undefined;
      const data = row?.data ?? null;
      return data ? remapRowToCamel(data as Record<string, unknown>, returnTable) : null;
    }
  };
}

function makeTrackedFunctionAggregateResolver(
  trackedFn: TrackedFunctionInfo,
): (parent: unknown, args: Record<string, unknown>, context: ResolverContext, info: import('graphql').GraphQLResolveInfo) => Promise<unknown> {
  return async (_parent, args, context, info) => {
    const { auth, queryWithSession, permissionLookup, inheritedRoles, tables } = context;
    const { config, functionInfo: fn, returnTable } = trackedFn;
    if (!returnTable) throw new Error(`No return table for function ${config.name}`);

    // ── Function-level permission check ──────────────────────────────
    if (!auth.isAdmin) {
      if (!config.permissions || config.permissions.length === 0) {
        throw new Error(
          `Permission denied: no roles have access to function "${config.name}"`,
        );
      }
      const hasPerm = hasRolePermission(auth.role, config.permissions, inheritedRoles);
      if (!hasPerm) {
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
    const where = remapBoolExpFull(args.where as BoolExp | undefined, colMap, returnTable, tables);

    // ── Build aggregate SQL using function as source ─────────────────
    // We build a custom SQL that uses the function call as the FROM source
    const params = new ParamCollector();
    const alias = 't0';

    // Build function call with named parameters
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
      // Default: just count
      selectParts.push(`json_build_object('count', count(*)) AS "aggregate"`);
    }

    const sql = [
      `SELECT ${selectParts.join(', ')}`,
      `FROM ${funcCall} ${quoteIdentifier(alias)}`,
      whereClause ? whereClause.trim() : null,
    ].filter(Boolean).join('\n');

    const intent = fn.volatility === 'volatile' ? 'write' : 'read';
    const result = await queryWithSession(sql, params.getParams(), auth, intent);

    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ?? { aggregate: { count: 0 } };
  };
}

/**
 * Parse aggregate selection from GraphQL resolve info.
 * Looks for the "aggregate" field and its sub-fields (count, sum, avg, min, max).
 */
function parseAggregateFromInfo(info: import('graphql').GraphQLResolveInfo): AggregateSelection {
  const agg: AggregateSelection = {};
  const fieldNode = info.fieldNodes[0];
  if (!fieldNode.selectionSet) return { count: {} };

  for (const selection of fieldNode.selectionSet.selections) {
    if (selection.kind !== 'Field') continue;
    if (selection.name.value === 'aggregate' && selection.selectionSet) {
      for (const aggField of selection.selectionSet.selections) {
        if (aggField.kind !== 'Field') continue;
        const name = aggField.name.value;
        if (name === 'count') {
          agg.count = {};
        } else if (['sum', 'avg', 'min', 'max'].includes(name)) {
          if (aggField.selectionSet) {
            const cols: string[] = [];
            for (const colField of aggField.selectionSet.selections) {
              if (colField.kind === 'Field') {
                // Store camelCase field name — convert to snake_case at SQL emission time
                cols.push(colField.name.value);
              }
            }
            (agg as Record<string, unknown>)[name] = cols;
          }
        }
      }
    }
  }

  // If no aggregate fields were specified, default to count
  if (Object.keys(agg).length === 0) {
    agg.count = {};
  }

  return agg;
}
