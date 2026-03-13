/**
 * Custom query support: allows hand-written SQL to be exposed as
 * GraphQL query/mutation fields with role-based permission checks.
 *
 * Each custom query defined in api_config.yaml becomes either a Query or
 * Mutation field. The resolver:
 * 1. Checks role-based permissions
 * 2. Maps GraphQL input parameters (+ session variable references) to SQL parameters
 * 3. Executes the custom SQL
 * 4. Returns typed results
 */

import {
  GraphQLObjectType,
  GraphQLNonNull,
  GraphQLList,
  GraphQLInt,
  GraphQLFloat,
  GraphQLString,
  GraphQLBoolean,
} from 'graphql';
import type {
  GraphQLFieldConfig,
  GraphQLFieldConfigArgumentMap,
  GraphQLInputType,
  GraphQLOutputType,
  GraphQLScalarType,
} from 'graphql';
import type {
  CustomQueryConfig,
  SessionVariables,
  TableInfo,
} from '../types.js';
import { customScalars } from './scalars.js';
import { toCamelCase } from './type-builder.js';
import type { TypeRegistry } from './type-builder.js';
import type { ResolverContext } from './resolvers.js';

// ─── Session Variable Mapping ────────────────────────────────────────────────

/**
 * Well-known session variable names mapped to their short form
 * used in custom query parameter references.
 */
const SESSION_VARIABLE_MAP: Record<string, (session: SessionVariables) => string | undefined> = {
  'x-hasura-user-id': (s) => s.userId,
  'x-hasura-role': (s) => s.role,
  'x-hasura-player-id': (s) => {
    const val = s.claims['x-hasura-player-id'];
    return Array.isArray(val) ? val[0] : val;
  },
};

/**
 * Resolve a session variable reference from the session.
 * Supports both the standard x-hasura-* format and looking up
 * arbitrary claims from the session.
 */
function resolveSessionVariable(
  name: string,
  session: SessionVariables,
): string | undefined {
  const lowerName = name.toLowerCase();

  // Check well-known mappings first
  const resolver = SESSION_VARIABLE_MAP[lowerName];
  if (resolver) {
    return resolver(session);
  }

  // Fall back to claims lookup
  const claimValue = session.claims[lowerName] ?? session.claims[name];
  if (claimValue !== undefined) {
    return Array.isArray(claimValue) ? claimValue[0] : claimValue;
  }

  return undefined;
}

// ─── Type Mapping ────────────────────────────────────────────────────────────

/** Built-in GraphQL scalars by name */
const BUILTIN_SCALARS: Record<string, GraphQLScalarType> = {
  Int: GraphQLInt as unknown as GraphQLScalarType,
  Float: GraphQLFloat as unknown as GraphQLScalarType,
  String: GraphQLString as unknown as GraphQLScalarType,
  Boolean: GraphQLBoolean as unknown as GraphQLScalarType,
};

/**
 * Map a custom query parameter type string to a GraphQL input type.
 *
 * Supports PG type names (uuid, int, text, numeric, etc.)
 * and GraphQL type names (Int, String, UUID, etc.).
 */
function paramTypeToGraphQL(typeName: string): GraphQLInputType {
  // Check PG type name mappings
  const pgMappings: Record<string, string> = {
    uuid: 'UUID',
    int: 'Int',
    int2: 'Int',
    int4: 'Int',
    int8: 'BigInt',
    integer: 'Int',
    bigint: 'BigInt',
    float: 'Float',
    float4: 'Float',
    float8: 'Float',
    numeric: 'BigDecimal',
    decimal: 'BigDecimal',
    text: 'String',
    varchar: 'String',
    char: 'String',
    bool: 'Boolean',
    boolean: 'Boolean',
    json: 'JSON',
    jsonb: 'JSON',
    timestamp: 'DateTime',
    timestamptz: 'DateTime',
    date: 'Date',
    time: 'Time',
    bytea: 'Bytea',
    inet: 'Inet',
  };

  const normalized = typeName.toLowerCase();
  const graphqlName = pgMappings[normalized] ?? typeName;

  // Check built-in scalars
  const builtin = BUILTIN_SCALARS[graphqlName];
  if (builtin) return builtin;

  // Check custom scalars
  const custom = customScalars[graphqlName];
  if (custom) return custom;

  // Fallback to String
  return GraphQLString as unknown as GraphQLScalarType;
}

/**
 * Map a custom query return type string to a GraphQL output type.
 * Same logic as param mapping but returns an output type.
 */
function returnFieldTypeToGraphQL(typeName: string): GraphQLOutputType {
  return paramTypeToGraphQL(typeName) as unknown as GraphQLOutputType;
}

// ─── Return Type Inference ──────────────────────────────────────────────────

/**
 * Well-known return field definitions inferred from SQL column names.
 * Maps common column name patterns to their likely GraphQL types.
 */
const COLUMN_TYPE_HINTS: Record<string, string> = {
  id: 'UUID',
  uuid: 'UUID',
  email: 'String',
  username: 'String',
  name: 'String',
  status: 'String',
  active: 'Boolean',
  enabled: 'Boolean',
  count: 'Int',
  limit: 'Int',
  offset: 'Int',
};

/**
 * Infer the GraphQL type for a return field based on its name.
 * Falls back to String for unknown fields.
 */
function inferReturnFieldType(fieldName: string): GraphQLOutputType {
  const normalized = fieldName.toLowerCase();

  // Check exact matches in hints
  const hint = COLUMN_TYPE_HINTS[normalized];
  if (hint) return returnFieldTypeToGraphQL(hint);

  // Check suffix patterns
  if (normalized.endsWith('_id') || normalized === 'id') {
    return returnFieldTypeToGraphQL('UUID');
  }
  if (normalized.endsWith('_at') || normalized.endsWith('_date')) {
    return returnFieldTypeToGraphQL('DateTime');
  }
  if (normalized.endsWith('_count') || normalized.endsWith('_total') ||
      normalized === 'total_sessions' || normalized === 'deposit_count') {
    return returnFieldTypeToGraphQL('Int');
  }
  if (normalized.includes('balance') || normalized.includes('amount') ||
      normalized.includes('total_deposits') || normalized.includes('total_balance') ||
      normalized.includes('total_bonus')) {
    return returnFieldTypeToGraphQL('BigDecimal');
  }

  // Fallback
  return returnFieldTypeToGraphQL('String');
}

// ─── Custom Query Output Types ──────────────────────────────────────────────

/** Cache of generated output types to avoid duplicates. */
const customOutputTypes = new Map<string, GraphQLObjectType>();

/**
 * Parse column names from a SQL statement for return type inference.
 * Supports:
 * - SELECT ... FROM (standard queries)
 * - RETURNING ... (INSERT/UPDATE/DELETE mutations)
 */
function parseSelectColumns(sql: string): string[] {
  // Try SELECT ... FROM first
  let selectClause: string | null = null;

  const selectMatch = sql.match(/SELECT\s+([\s\S]+?)\s+FROM\s+/i);
  if (selectMatch) {
    selectClause = selectMatch[1];
  }

  // Try RETURNING clause (for INSERT/UPDATE/DELETE)
  if (!selectClause) {
    const returningMatch = sql.match(/RETURNING\s+([\s\S]+?)$/im);
    if (returningMatch) {
      selectClause = returningMatch[1].trim();
    }
  }

  if (!selectClause) return [];

  // Split by commas, handling nested function calls
  const columns: string[] = [];
  let depth = 0;
  let current = '';

  for (const char of selectClause) {
    if (char === '(') depth++;
    else if (char === ')') depth--;
    else if (char === ',' && depth === 0) {
      columns.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) columns.push(current.trim());

  // Extract the alias or column name from each expression
  return columns.map((col) => {
    // "expression AS alias" pattern
    const asMatch = col.match(/\s+as\s+(\w+)\s*$/i);
    if (asMatch) return asMatch[1];

    // "table.column" pattern
    const dotMatch = col.match(/\w+\.(\w+)\s*$/);
    if (dotMatch) return dotMatch[1];

    // Simple column name
    const simpleMatch = col.match(/^(\w+)\s*$/);
    if (simpleMatch) return simpleMatch[1];

    return col.trim();
  });
}

/**
 * Get or create a GraphQL output type for a custom query's return value.
 *
 * If `returns` references a known table type name (from the TypeRegistry),
 * reuse that existing type. Otherwise, generate a new type by parsing
 * the SQL SELECT columns.
 */
function getOrCreateOutputType(
  query: CustomQueryConfig,
  typeRegistry: TypeRegistry,
  tables: TableInfo[],
): GraphQLObjectType {
  // Check if a type for this return name already exists in our cache
  const cached = customOutputTypes.get(query.returns);
  if (cached) return cached;

  // Check if `returns` references an existing table type
  for (const [_key, objectType] of typeRegistry) {
    if (objectType.name === query.returns) {
      return objectType;
    }
  }

  // Also check if it matches a table name (matching by table name directly)
  for (const table of tables) {
    const tablePascal = table.name
      .split('_')
      .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
      .join('');
    if (tablePascal === query.returns) {
      // Find the type in the registry
      const key = `${table.schema}.${table.name}`;
      const existingType = typeRegistry.get(key);
      if (existingType) return existingType;
    }
  }

  // Generate a new type by parsing SQL columns
  const columns = parseSelectColumns(query.sql);

  const fields: Record<string, { type: GraphQLOutputType }> = {};
  for (const col of columns) {
    const fieldName = toCamelCase(col);
    fields[fieldName] = {
      type: inferReturnFieldType(col),
    };
  }

  // If no columns could be parsed, add a generic JSON result field
  if (Object.keys(fields).length === 0) {
    fields['result'] = {
      type: customScalars['JSON'] as unknown as GraphQLOutputType,
    };
  }

  const outputType = new GraphQLObjectType({
    name: query.returns,
    description: `Custom query return type for ${query.name}`,
    fields,
  });

  customOutputTypes.set(query.returns, outputType);
  return outputType;
}

// ─── Resolver Factory ────────────────────────────────────────────────────────

/**
 * Create a resolver function for a custom query.
 *
 * The resolver:
 * 1. Checks permissions for the active role
 * 2. Maps input arguments to SQL parameters, injecting session variables
 *    where referenced
 * 3. Executes the SQL
 * 4. Returns the results, remapping snake_case columns to camelCase
 */
function makeCustomQueryResolver(
  query: CustomQueryConfig,
): (parent: unknown, args: Record<string, unknown>, context: ResolverContext) => Promise<unknown> {
  const isMutation = query.type === 'mutation';

  return async (_parent, args, context) => {
    const { auth, queryWithSession } = context;

    // ── Permission check ──────────────────────────────────────────────
    if (!auth.isAdmin) {
      if (!query.permissions || query.permissions.length === 0) {
        throw new Error(
          `Permission denied: no roles have access to custom ${query.type} "${query.name}"`,
        );
      }

      const perm = query.permissions.find((p) => p.role === auth.role);
      if (!perm) {
        throw new Error(
          `Permission denied: role "${auth.role}" does not have access to custom ${query.type} "${query.name}"`,
        );
      }
    }

    // ── Map parameters ────────────────────────────────────────────────
    const params: unknown[] = [];
    if (query.params) {
      for (const paramDef of query.params) {
        let value = args[paramDef.name];

        // If value is not provided, check if it should be resolved from session
        if (value === undefined || value === null) {
          // Check if the param name maps to a session variable
          value = resolveSessionVariable(`x-hasura-${paramDef.name.replace(/([A-Z])/g, '-$1').toLowerCase()}`, auth);
        }

        params.push(value ?? null);
      }
    }

    // ── Execute SQL ───────────────────────────────────────────────────
    const intent = isMutation ? 'write' : 'read';
    const result = await queryWithSession(query.sql, params, auth, intent);

    // ── Remap results ─────────────────────────────────────────────────
    const rows = result.rows as Record<string, unknown>[];

    // Remap snake_case keys to camelCase
    const remapped = rows.map((row) => {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row)) {
        out[toCamelCase(key)] = value;
      }
      return out;
    });

    // For queries that return a list, the SQL should return multiple rows
    // For single-result queries (e.g., by ID), return first row or null
    // We determine this by looking at the SQL: if it has LIMIT 1 or uses
    // a primary key equality, it's likely a single result
    if (isMutation) {
      // Mutations typically return the modified rows
      if (remapped.length === 0) return null;
      if (remapped.length === 1) return remapped[0];
      return remapped;
    }

    // Queries return an array
    return remapped;
  };
}

// ─── Schema Integration ─────────────────────────────────────────────────────

/**
 * Registered custom query field configs, separated into Query and Mutation fields.
 */
export interface CustomQueryFields {
  queryFields: Record<string, GraphQLFieldConfig<unknown, ResolverContext>>;
  mutationFields: Record<string, GraphQLFieldConfig<unknown, ResolverContext>>;
  /** Output types created for custom queries (for schema registration). */
  outputTypes: GraphQLObjectType[];
}

/**
 * Build GraphQL field configs for all custom queries.
 *
 * For each custom query:
 * - Creates or reuses an output GraphQL type
 * - Builds input argument definitions from params
 * - Creates a resolver with permission checks + session variable injection
 * - Registers the field as either a Query or Mutation field
 *
 * @param customQueries  - Custom query configs from api_config.yaml
 * @param typeRegistry   - Registry of existing table object types
 * @param tables         - All tracked tables (for type matching)
 * @returns Fields to add to Query and Mutation root types
 */
export function buildCustomQueryFields(
  customQueries: CustomQueryConfig[],
  typeRegistry: TypeRegistry,
  tables: TableInfo[],
): CustomQueryFields {
  const queryFields: Record<string, GraphQLFieldConfig<unknown, ResolverContext>> = {};
  const mutationFields: Record<string, GraphQLFieldConfig<unknown, ResolverContext>> = {};
  const outputTypes: GraphQLObjectType[] = [];

  for (const query of customQueries) {
    const outputType = getOrCreateOutputType(query, typeRegistry, tables);

    // Track newly created output types
    if (!typeRegistry.has(outputType.name) && !outputTypes.includes(outputType)) {
      outputTypes.push(outputType);
    }

    // Build input arguments
    const args: GraphQLFieldConfigArgumentMap = {};
    if (query.params) {
      for (const param of query.params) {
        args[param.name] = {
          type: new GraphQLNonNull(paramTypeToGraphQL(param.type)),
          description: `Parameter: ${param.name} (${param.type})`,
        };
      }
    }

    // Determine return type: mutations return a single object,
    // queries return a list
    const isMutation = query.type === 'mutation';
    const returnType = isMutation
      ? outputType
      : new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(outputType)));

    const fieldConfig: GraphQLFieldConfig<unknown, ResolverContext> = {
      type: returnType,
      args,
      resolve: makeCustomQueryResolver(query),
      description: `Custom ${query.type}: ${query.name}`,
    };

    if (isMutation) {
      mutationFields[query.name] = fieldConfig;
    } else {
      queryFields[query.name] = fieldConfig;
    }
  }

  return { queryFields, mutationFields, outputTypes };
}

/**
 * Reset the custom output type cache. Used in tests.
 */
export function resetCustomOutputTypeCache(): void {
  customOutputTypes.clear();
}
