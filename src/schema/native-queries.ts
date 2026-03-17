/**
 * Native query support: exposes raw SQL (defined in Hasura metadata as
 * native_queries + logical_models) as GraphQL Query fields.
 *
 * Each native query becomes a Query field. The resolver:
 * 1. Checks role-based permissions via the logical model's select_permissions
 * 2. Replaces {{paramName}} placeholders in SQL with $N parameters
 * 3. Executes the parameterized SQL
 * 4. Returns typed results filtered by column permissions
 */

import {
  GraphQLObjectType,
  GraphQLNonNull,
  GraphQLList,
  GraphQLInputObjectType,
  GraphQLEnumType,
} from 'graphql';
import type {
  GraphQLFieldConfig,
  GraphQLFieldConfigArgumentMap,
  GraphQLOutputType,
  GraphQLScalarType,
  GraphQLInputType,
} from 'graphql';
import {
  GraphQLInt,
  GraphQLFloat,
  GraphQLString,
  GraphQLBoolean,
} from 'graphql';
import type {
  NativeQuery,
  LogicalModel,
  SessionVariables,
  BoolExp,
} from '../types.js';
import { customScalars, asScalar, asInputType, asOutputType } from './scalars.js';
import type { ResolverContext } from './resolvers/index.js';
import {
  isSessionVariable,
  resolveSessionVar,
  DEFAULT_SESSION_NAMESPACE,
} from '../auth/session-namespace.js';
import { OrderByDirection } from './inputs.js';
import { randomUUID } from 'crypto';
import { createAsyncQueue } from './subscription-resolvers.js';

// ─── Type Mapping ────────────────────────────────────────────────────────────

/** Built-in GraphQL scalars by name */
const BUILTIN_SCALARS: Record<string, GraphQLScalarType> = {
  Int: asScalar(GraphQLInt),
  Float: asScalar(GraphQLFloat),
  String: asScalar(GraphQLString),
  Boolean: asScalar(GraphQLBoolean),
};

/** Map PG scalar type names to GraphQL scalar names */
const PG_SCALAR_MAP: Record<string, string> = {
  uuid: 'Uuid',
  int: 'Int',
  int2: 'Int',
  int4: 'Int',
  int8: 'Bigint',
  integer: 'Int',
  bigint: 'Bigint',
  float: 'Float',
  float4: 'Float',
  float8: 'Float',
  numeric: 'Numeric',
  decimal: 'Numeric',
  text: 'String',
  varchar: 'String',
  char: 'String',
  bpchar: 'Bpchar',
  bool: 'Boolean',
  boolean: 'Boolean',
  json: 'json',
  jsonb: 'Jsonb',
  timestamp: 'Timestamptz',
  timestamptz: 'Timestamptz',
  date: 'Date',
  time: 'Time',
  bytea: 'Bytea',
  inet: 'Inet',
};

function scalarToGraphQL(typeName: string): GraphQLScalarType {
  const normalized = typeName.toLowerCase();
  const graphqlName = PG_SCALAR_MAP[normalized] ?? typeName;

  const builtin = BUILTIN_SCALARS[graphqlName];
  if (builtin) return builtin;

  const custom = customScalars[graphqlName];
  if (custom) return custom;

  // Fallback to String
  return asScalar(GraphQLString);
}

// ─── Logical Model Query Arg Types ──────────────────────────────────────────

/** Cache for comparison input types used in logical model BoolExp */
const lmComparisonTypeCache = new Map<string, GraphQLInputObjectType>();

function getOrCreateComparisonType(scalarType: GraphQLScalarType): GraphQLInputObjectType {
  const name = `${scalarType.name}ComparisonExpLm`;
  const cached = lmComparisonTypeCache.get(name);
  if (cached) return cached;

  const inputScalar = asInputType(scalarType);
  const fields: Record<string, { type: GraphQLInputType }> = {
    _eq: { type: inputScalar },
    _neq: { type: inputScalar },
    _in: { type: new GraphQLList(new GraphQLNonNull(inputScalar)) },
    _nin: { type: new GraphQLList(new GraphQLNonNull(inputScalar)) },
    _isNull: { type: asInputType(asScalar(GraphQLBoolean)) },
    _gt: { type: inputScalar },
    _lt: { type: inputScalar },
    _gte: { type: inputScalar },
    _lte: { type: inputScalar },
  };

  const compType = new GraphQLInputObjectType({ name, fields });
  lmComparisonTypeCache.set(name, compType);
  return compType;
}

/**
 * Build a BoolExp input type for a logical model.
 * Supports per-field comparison operators and _and / _or / _not combinators.
 */
function buildLogicalModelBoolExp(model: LogicalModel): GraphQLInputObjectType {
  const typeName = `${model.name}BoolExp`;
  return new GraphQLInputObjectType({
    name: typeName,
    description: `Boolean expression to filter ${model.name} results.`,
    fields: () => {
      const fields: Record<string, { type: GraphQLInputType }> = {};
      for (const field of model.fields) {
        const scalarType = scalarToGraphQL(field.type);
        fields[field.name] = { type: getOrCreateComparisonType(scalarType) };
      }
      // Logical combinators
      const selfType = logicalModelBoolExpCache.get(typeName)!;
      fields['_and'] = { type: new GraphQLList(new GraphQLNonNull(selfType)) };
      fields['_or'] = { type: new GraphQLList(new GraphQLNonNull(selfType)) };
      fields['_not'] = { type: selfType };
      return fields;
    },
  });
}

/** Cache for logical model BoolExp types */
const logicalModelBoolExpCache = new Map<string, GraphQLInputObjectType>();

function getOrCreateLogicalModelBoolExp(model: LogicalModel): GraphQLInputObjectType {
  const key = `${model.name}BoolExp`;
  const cached = logicalModelBoolExpCache.get(key);
  if (cached) return cached;
  const boolExp = buildLogicalModelBoolExp(model);
  logicalModelBoolExpCache.set(key, boolExp);
  return boolExp;
}

/**
 * Build an OrderBy input type for a logical model.
 */
function buildLogicalModelOrderBy(model: LogicalModel): GraphQLInputObjectType {
  const fields: Record<string, { type: GraphQLInputType }> = {};
  for (const field of model.fields) {
    fields[field.name] = { type: OrderByDirection };
  }
  return new GraphQLInputObjectType({
    name: `${model.name}OrderBy`,
    description: `Ordering options for ${model.name} results.`,
    fields,
  });
}

/**
 * Build a SelectColumn enum for a logical model.
 */
function buildLogicalModelSelectColumnEnum(model: LogicalModel): GraphQLEnumType {
  const values: Record<string, { value: string }> = {};
  for (const field of model.fields) {
    // Hasura uses SCREAMING_SNAKE_CASE for enum values
    const enumKey = field.name.replace(/[A-Z]/g, (m) => `_${m}`).toUpperCase();
    values[enumKey] = { value: field.name };
  }
  return new GraphQLEnumType({
    name: `${model.name}SelectColumn`,
    description: `Select columns of ${model.name}.`,
    values,
  });
}

// ─── SQL Parameter Parsing ──────────────────────────────────────────────────

/**
 * Parse `{{paramName}}` placeholders in native query SQL code.
 * Returns the parameterized SQL (with $N) and the ordered list of parameter names.
 *
 * A parameter that appears multiple times gets the same $N.
 */
export function parseNativeQuerySQL(code: string): { sql: string; paramNames: string[] } {
  const paramNames: string[] = [];
  const paramIndex = new Map<string, number>();

  const sql = code.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
    let idx = paramIndex.get(name);
    if (idx === undefined) {
      paramNames.push(name);
      idx = paramNames.length; // 1-based
      paramIndex.set(name, idx);
    }
    return `$${idx}`;
  });

  return { sql, paramNames };
}

// ─── Session Variable Resolution ─────────────────────────────────────────────

function resolveSessionVariable(
  name: string,
  session: SessionVariables,
): string | undefined {
  if (!isSessionVariable(name, DEFAULT_SESSION_NAMESPACE)) {
    // Not a session variable — return undefined
    return undefined;
  }
  const resolved = resolveSessionVar(name, session, DEFAULT_SESSION_NAMESPACE);
  if (resolved === undefined) return undefined;
  return Array.isArray(resolved) ? resolved[0] : String(resolved);
}

// ─── Permission Filter Compilation ───────────────────────────────────────────

/**
 * Compile a logical model permission filter into a SQL WHERE clause.
 * Supports session variable references (e.g., `{ id: { _eq: "X-Hasura-Player-Id" } }`).
 *
 * This is simpler than the full table permission compiler because logical model
 * results are flat (no relationships to traverse).
 */
function compilePermissionFilter(
  filter: BoolExp,
  session: SessionVariables,
  paramOffset: number,
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];

  function compile(expr: BoolExp): string {
    if (!expr || typeof expr !== 'object') return 'TRUE';

    const keys = Object.keys(expr);
    if (keys.length === 0) return 'TRUE';

    if ('_and' in expr) {
      const clauses = (expr as { _and: BoolExp[] })._and.map(compile);
      return clauses.length > 0 ? `(${clauses.join(' AND ')})` : 'TRUE';
    }
    if ('_or' in expr) {
      const clauses = (expr as { _or: BoolExp[] })._or.map(compile);
      return clauses.length > 0 ? `(${clauses.join(' OR ')})` : 'FALSE';
    }
    if ('_not' in expr) {
      return `NOT (${compile((expr as { _not: BoolExp })._not)})`;
    }

    // Column-level operators
    const parts: string[] = [];
    for (const [column, ops] of Object.entries(expr)) {
      if (!ops || typeof ops !== 'object') continue;
      const operators = ops as Record<string, unknown>;

      for (const [op, rawValue] of Object.entries(operators)) {
        let value = rawValue;
        // Check if the value is a session variable reference
        if (typeof value === 'string' && isSessionVariable(value, DEFAULT_SESSION_NAMESPACE)) {
          value = resolveSessionVariable(value, session);
        }

        const idx = paramOffset + params.length + 1;
        switch (op) {
          case '_eq':
            params.push(value);
            parts.push(`"${column}" = $${idx}`);
            break;
          case '_neq':
            params.push(value);
            parts.push(`"${column}" != $${idx}`);
            break;
          case '_gt':
            params.push(value);
            parts.push(`"${column}" > $${idx}`);
            break;
          case '_lt':
            params.push(value);
            parts.push(`"${column}" < $${idx}`);
            break;
          case '_gte':
            params.push(value);
            parts.push(`"${column}" >= $${idx}`);
            break;
          case '_lte':
            params.push(value);
            parts.push(`"${column}" <= $${idx}`);
            break;
          case '_in':
            params.push(value);
            parts.push(`"${column}" = ANY($${idx})`);
            break;
          case '_nin':
            params.push(value);
            parts.push(`"${column}" != ALL($${idx})`);
            break;
          case '_isNull':
            if (value) {
              parts.push(`"${column}" IS NULL`);
            } else {
              parts.push(`"${column}" IS NOT NULL`);
            }
            break;
          default:
            // Unsupported operator — skip
            break;
        }
      }
    }

    return parts.length > 0 ? parts.join(' AND ') : 'TRUE';
  }

  const sql = compile(filter);
  return { sql, params };
}

// ─── Schema Integration ─────────────────────────────────────────────────────

/** Cache of generated logical model output types. */
const logicalModelTypes = new Map<string, GraphQLObjectType>();

/**
 * Build GraphQL field configs for all native queries.
 *
 * For each native query:
 * - Creates a GraphQLObjectType from the logical model's fields
 * - Builds input arguments from the native query's arguments
 * - Creates a resolver with permission checks + parameter substitution
 * - Returns the field as a Query field (native queries are always queries)
 */
export function buildNativeQueryFields(
  nativeQueries: NativeQuery[],
  logicalModels: LogicalModel[],
): NativeQueryFields {
  const queryFields: Record<string, GraphQLFieldConfig<unknown, ResolverContext>> = {};
  const subscriptionFields: Record<string, GraphQLFieldConfig<unknown, ResolverContext>> = {};
  const outputTypes: GraphQLObjectType[] = [];
  const inputTypes: GraphQLInputObjectType[] = [];
  const logicalModelMap = new Map<string, LogicalModel>();

  for (const lm of logicalModels) {
    logicalModelMap.set(lm.name, lm);
  }

  for (const nq of nativeQueries) {
    const logicalModel = logicalModelMap.get(nq.returns);
    if (!logicalModel) {
      continue; // Skip if logical model not found
    }

    // Build or reuse the output type
    const outputType = getOrCreateLogicalModelType(logicalModel);
    if (!outputTypes.includes(outputType)) {
      outputTypes.push(outputType);
    }

    // Build field arguments — Hasura wraps native query params in an *_arguments input type
    const fieldArgs: GraphQLFieldConfigArgumentMap = {};

    if (nq.arguments.length > 0) {
      const argsFields: Record<string, { type: GraphQLInputType; description?: string }> = {};
      for (const arg of nq.arguments) {
        const gqlType = scalarToGraphQL(arg.type);
        argsFields[arg.name] = {
          type: arg.nullable ? asInputType(gqlType) : new GraphQLNonNull(asInputType(gqlType)),
          description: `Argument: ${arg.name} (${arg.type})`,
        };
      }
      const argsInputType = new GraphQLInputObjectType({
        name: `${nq.rootFieldName}_arguments`,
        description: `Arguments for native query ${nq.rootFieldName}`,
        fields: argsFields,
      });
      inputTypes.push(argsInputType);
      fieldArgs['args'] = { type: new GraphQLNonNull(argsInputType) };
    }

    // Add standard query args: distinctOn, limit, offset, orderBy, where
    const boolExpType = getOrCreateLogicalModelBoolExp(logicalModel);
    fieldArgs['where'] = { type: boolExpType };

    const orderByType = buildLogicalModelOrderBy(logicalModel);
    fieldArgs['orderBy'] = { type: new GraphQLList(new GraphQLNonNull(orderByType)) };

    fieldArgs['limit'] = { type: GraphQLInt };
    fieldArgs['offset'] = { type: GraphQLInt };

    const selectColumnEnum = buildLogicalModelSelectColumnEnum(logicalModel);
    fieldArgs['distinctOn'] = { type: new GraphQLList(new GraphQLNonNull(selectColumnEnum)) };

    // Native queries always return [LogicalModel!]!
    const returnType = new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(outputType)));

    queryFields[nq.rootFieldName] = {
      type: returnType,
      args: fieldArgs,
      resolve: makeNativeQueryResolver(nq, logicalModel),
      description: `Native query: ${nq.rootFieldName}`,
    };

    // Build subscription field — watches tables referenced in the SQL
    const referencedTables = extractReferencedTables(nq.code);
    if (referencedTables.length > 0) {
      subscriptionFields[nq.rootFieldName] = {
        type: returnType,
        args: fieldArgs,
        description: `Subscribe to native query: ${nq.rootFieldName}`,
        resolve: (payload: unknown) => payload,
        subscribe: makeNativeQuerySubscriptionSubscribe(nq, logicalModel, referencedTables),
      };
    }
  }

  return { queryFields, subscriptionFields, outputTypes, inputTypes };
}

function getOrCreateLogicalModelType(model: LogicalModel): GraphQLObjectType {
  const cached = logicalModelTypes.get(model.name);
  if (cached) return cached;

  const fields: Record<string, { type: GraphQLOutputType }> = {};
  for (const field of model.fields) {
    const scalarType = scalarToGraphQL(field.type);
    fields[field.name] = {
      type: field.nullable
        ? asOutputType(scalarType)
        : new GraphQLNonNull(asOutputType(scalarType)),
    };
  }

  const objectType = new GraphQLObjectType({
    name: model.name,
    description: `Logical model: ${model.name}`,
    fields,
  });

  logicalModelTypes.set(model.name, objectType);
  return objectType;
}

// ─── Resolver Factory ────────────────────────────────────────────────────────

function makeNativeQueryResolver(
  nq: NativeQuery,
  logicalModel: LogicalModel,
): (parent: unknown, args: Record<string, unknown>, context: ResolverContext) => Promise<unknown> {
  const { sql: parameterizedSQL, paramNames } = parseNativeQuerySQL(nq.code);

  return async (_parent, args, context) => {
    const { auth, queryWithSession } = context;

    // Extract native query arguments from the `args` wrapper (Hasura convention)
    const nqArgs = (args.args ?? {}) as Record<string, unknown>;

    // ── Permission check ──────────────────────────────────────────────
    if (!auth.isAdmin) {
      const perm = logicalModel.selectPermissions.find((p) => p.role === auth.role);
      if (!perm) {
        throw new Error(
          `Permission denied: role "${auth.role}" does not have access to native query "${nq.rootFieldName}"`,
        );
      }

      // Build parameter values
      const params: unknown[] = paramNames.map((name) => nqArgs[name] ?? null);

      // Check if there is a row-level filter
      const filterKeys = Object.keys(perm.filter);
      let finalSQL = parameterizedSQL;
      let finalParams = params;

      if (filterKeys.length > 0) {
        // Wrap the native query in a subquery and apply the permission filter
        const { sql: filterSQL, params: filterParams } = compilePermissionFilter(
          perm.filter,
          auth,
          params.length,
        );
        finalSQL = `SELECT * FROM (${parameterizedSQL}) AS __nq WHERE ${filterSQL}`;
        finalParams = [...params, ...filterParams];
      }

      // Apply column filtering
      const allowedColumns = new Set(perm.columns);
      const result = await queryWithSession(finalSQL, finalParams, auth, 'read');
      const rows = result.rows as Record<string, unknown>[];

      return rows.map((row) => {
        const filtered: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row)) {
          if (allowedColumns.has(key)) {
            filtered[key] = value;
          }
        }
        return filtered;
      });
    }

    // Admin path — no permission filtering
    const params: unknown[] = paramNames.map((name) => nqArgs[name] ?? null);
    const result = await queryWithSession(parameterizedSQL, params, auth, 'read');
    return result.rows;
  };
}

// ─── SQL Table Reference Extraction ──────────────────────────────────────────

/**
 * Extract table names referenced in a SQL query (FROM/JOIN clauses).
 * Used to determine which tables a native query subscription should watch.
 *
 * Returns schema-qualified table keys (e.g., "public.client").
 */
export function extractReferencedTables(sql: string): string[] {
  const tables = new Set<string>();
  // Match FROM/JOIN followed by optional schema-qualified table name.
  // Skip subquery opens: FROM (SELECT ...)
  const regex = /\b(?:FROM|JOIN)\s+(?!\()("?[\w]+"?(?:\."?[\w]+"?)?)/gi;
  let match;
  while ((match = regex.exec(sql)) !== null) {
    const raw = match[1].replace(/"/g, '');
    if (raw.includes('.')) {
      tables.add(raw);
    } else {
      tables.add(`public.${raw}`);
    }
  }
  return Array.from(tables);
}

// ─── Subscription Factory ───────────────────────────────────────────────────

/**
 * Wrap a raw SQL query so it returns a single row with a "data" column
 * containing a JSON array, matching the format the subscription manager expects.
 */
function wrapForSubscription(innerSQL: string): string {
  return `SELECT coalesce(json_agg(row_to_json("__nq_sub")), '[]'::json) AS "data" FROM (${innerSQL}) AS "__nq_sub"`;
}

/**
 * Creates a `subscribe` function for native query subscription fields.
 *
 * Watches the tables referenced in the native query's SQL. When any
 * referenced table changes, re-executes the native query and pushes
 * the result if it changed (hash-diff handled by subscription manager).
 */
function makeNativeQuerySubscriptionSubscribe(
  nq: NativeQuery,
  logicalModel: LogicalModel,
  referencedTables: string[],
): (_parent: unknown, args: Record<string, unknown>, context: ResolverContext) => AsyncIterableIterator<unknown> {
  const { sql: parameterizedSQL, paramNames } = parseNativeQuerySQL(nq.code);
  const primaryTable = referencedTables[0];
  const additionalTables = referencedTables.slice(1);

  return (_parent, args, context) => {
    const { auth, subscriptionManager } = context;

    if (!subscriptionManager) {
      throw new Error('Subscription manager is not available');
    }

    // ── Permission check ──────────────────────────────────────────────
    const nqArgs = (args.args ?? {}) as Record<string, unknown>;
    const params: unknown[] = paramNames.map((name) => nqArgs[name] ?? null);

    let compiledSQL: string;
    let compiledParams: unknown[];
    let allowedColumns: Set<string> | null = null;

    if (!auth.isAdmin) {
      const perm = logicalModel.selectPermissions.find((p) => p.role === auth.role);
      if (!perm) {
        throw new Error(
          `Permission denied: role "${auth.role}" does not have access to native query "${nq.rootFieldName}"`,
        );
      }

      allowedColumns = new Set(perm.columns);
      const filterKeys = Object.keys(perm.filter);

      if (filterKeys.length > 0) {
        const { sql: filterSQL, params: filterParams } = compilePermissionFilter(
          perm.filter,
          auth,
          params.length,
        );
        const innerSQL = `SELECT * FROM (${parameterizedSQL}) AS __nq WHERE ${filterSQL}`;
        compiledSQL = wrapForSubscription(innerSQL);
        compiledParams = [...params, ...filterParams];
      } else {
        compiledSQL = wrapForSubscription(parameterizedSQL);
        compiledParams = params;
      }
    } else {
      compiledSQL = wrapForSubscription(parameterizedSQL);
      compiledParams = params;
    }

    // ── Column filter helper ──────────────────────────────────────────
    function filterColumns(rows: Record<string, unknown>[]): Record<string, unknown>[] {
      if (!allowedColumns) return rows;
      return rows.map((row) => {
        const filtered: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row)) {
          if (allowedColumns!.has(key)) {
            filtered[key] = value;
          }
        }
        return filtered;
      });
    }

    const queue = createAsyncQueue<unknown>();
    const subscriptionId = randomUUID();

    async function* generate(): AsyncGenerator<unknown> {
      try {
        const initialData = await subscriptionManager!.register({
          id: subscriptionId,
          tableKey: primaryTable,
          query: { sql: compiledSQL, params: compiledParams },
          session: auth,
          relatedTableKeys: additionalTables.length > 0 ? additionalTables : undefined,
          push: (data: unknown) => {
            if (Array.isArray(data)) {
              queue.push(filterColumns(data as Record<string, unknown>[]));
            } else {
              queue.push(data);
            }
          },
        });

        // Yield the initial result
        if (Array.isArray(initialData)) {
          yield filterColumns(initialData as Record<string, unknown>[]);
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

// ─── Types ───────────────────────────────────────────────────────────────────

export interface NativeQueryFields {
  queryFields: Record<string, GraphQLFieldConfig<unknown, ResolverContext>>;
  subscriptionFields: Record<string, GraphQLFieldConfig<unknown, ResolverContext>>;
  outputTypes: GraphQLObjectType[];
  inputTypes: GraphQLInputObjectType[];
}

/**
 * Reset the logical model type cache. Used in tests.
 */
export function resetLogicalModelTypeCache(): void {
  logicalModelTypes.clear();
  logicalModelBoolExpCache.clear();
  lmComparisonTypeCache.clear();
}
