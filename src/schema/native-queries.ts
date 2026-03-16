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
} from 'graphql';
import type {
  GraphQLFieldConfig,
  GraphQLFieldConfigArgumentMap,
  GraphQLInputType,
  GraphQLOutputType,
  GraphQLScalarType,
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
import { customScalars } from './scalars.js';
import type { ResolverContext } from './resolvers/index.js';
import {
  isSessionVariable,
  resolveSessionVar,
  DEFAULT_SESSION_NAMESPACE,
} from '../auth/session-namespace.js';

// ─── Type Mapping ────────────────────────────────────────────────────────────

/** Built-in GraphQL scalars by name */
const BUILTIN_SCALARS: Record<string, GraphQLScalarType> = {
  Int: GraphQLInt as unknown as GraphQLScalarType,
  Float: GraphQLFloat as unknown as GraphQLScalarType,
  String: GraphQLString as unknown as GraphQLScalarType,
  Boolean: GraphQLBoolean as unknown as GraphQLScalarType,
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
  return GraphQLString as unknown as GraphQLScalarType;
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
  const outputTypes: GraphQLObjectType[] = [];
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

    // Build arguments
    const args: GraphQLFieldConfigArgumentMap = {};
    for (const arg of nq.arguments) {
      const gqlType = scalarToGraphQL(arg.type);
      args[arg.name] = {
        type: arg.nullable ? (gqlType as unknown as GraphQLInputType) : new GraphQLNonNull(gqlType as unknown as GraphQLInputType),
        description: `Argument: ${arg.name} (${arg.type})`,
      };
    }

    // Native queries always return [LogicalModel!]!
    const returnType = new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(outputType)));

    queryFields[nq.rootFieldName] = {
      type: returnType,
      args,
      resolve: makeNativeQueryResolver(nq, logicalModel),
      description: `Native query: ${nq.rootFieldName}`,
    };
  }

  return { queryFields, outputTypes };
}

function getOrCreateLogicalModelType(model: LogicalModel): GraphQLObjectType {
  const cached = logicalModelTypes.get(model.name);
  if (cached) return cached;

  const fields: Record<string, { type: GraphQLOutputType }> = {};
  for (const field of model.fields) {
    const scalarType = scalarToGraphQL(field.type);
    fields[field.name] = {
      type: field.nullable
        ? (scalarType as unknown as GraphQLOutputType)
        : new GraphQLNonNull(scalarType as unknown as GraphQLOutputType),
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

    // ── Permission check ──────────────────────────────────────────────
    if (!auth.isAdmin) {
      const perm = logicalModel.selectPermissions.find((p) => p.role === auth.role);
      if (!perm) {
        throw new Error(
          `Permission denied: role "${auth.role}" does not have access to native query "${nq.rootFieldName}"`,
        );
      }

      // Build parameter values
      const params: unknown[] = paramNames.map((name) => args[name] ?? null);

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
    const params: unknown[] = paramNames.map((name) => args[name] ?? null);
    const result = await queryWithSession(parameterizedSQL, params, auth, 'read');
    return result.rows;
  };
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface NativeQueryFields {
  queryFields: Record<string, GraphQLFieldConfig<unknown, ResolverContext>>;
  outputTypes: GraphQLObjectType[];
}

/**
 * Reset the logical model type cache. Used in tests.
 */
export function resetLogicalModelTypeCache(): void {
  logicalModelTypes.clear();
}
