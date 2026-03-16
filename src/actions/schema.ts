/**
 * Action schema integration.
 *
 * Parses actions.graphql SDL, builds GraphQL types for action inputs/outputs,
 * and generates resolver-wired field configs for Query and Mutation root types.
 *
 * Supports both synchronous and asynchronous actions:
 * - Sync: mutation calls webhook inline, returns result directly
 * - Async: mutation enqueues job, returns uuid! (action ID), result queried via action's output type
 *
 * Action output types can include relationship fields that resolve nested
 * database records via the action's configured field_mapping.
 */

import {
  parse,
  GraphQLObjectType,
  GraphQLInputObjectType,
  GraphQLNonNull,
  GraphQLList,
  GraphQLString,
  GraphQLFloat,
  GraphQLBoolean,
  GraphQLInt,
  GraphQLID,
  GraphQLEnumType,
  GraphQLError,
} from 'graphql';
import type {
  DocumentNode,
  TypeNode,
  FieldDefinitionNode,
  InputValueDefinitionNode,
  GraphQLFieldConfig,
  GraphQLOutputType,
  GraphQLInputType,
  GraphQLNamedType,
  GraphQLFieldConfigMap,
} from 'graphql';
import type { ActionConfig, ActionRelationship, TableInfo, BoolExp } from '../types.js';
import { customScalars } from '../schema/scalars.js';
import type { ResolverContext } from '../schema/resolvers/index.js';
import { checkActionPermission } from './permissions.js';
import { executeAction } from './proxy.js';
import { enqueueAsyncAction, getAsyncActionResult } from './async.js';
import { compileSelect } from '../sql/select.js';
import { toCamelCase, getRelFieldName } from '../shared/naming.js';
import { randomUUID } from 'crypto';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ActionSchemaResult {
  queryFields: Record<string, GraphQLFieldConfig<unknown, ResolverContext>>;
  mutationFields: Record<string, GraphQLFieldConfig<unknown, ResolverContext>>;
  /** Subscription fields for async action result polling (mirrors query fields). */
  subscriptionFields: Record<string, GraphQLFieldConfig<unknown, ResolverContext>>;
  types: GraphQLNamedType[];
}

/**
 * Options for building action fields, including table type information
 * needed for relationship resolution.
 */
export interface ActionSchemaOptions {
  /** All tracked tables in the schema model */
  tables?: TableInfo[];
  /** Registry of table GraphQL object types, keyed by "schema.name" */
  tableTypeRegistry?: Map<string, GraphQLObjectType>;
  /** PG-introspected enum types, keyed by GraphQL enum name */
  enumTypes?: Map<string, GraphQLEnumType>;
}

// ─── SDL Type Resolution ────────────────────────────────────────────────────

/** Map of scalar names used in actions.graphql → GraphQL types */
const SCALAR_MAP: Record<string, GraphQLOutputType & GraphQLInputType> = {
  // Built-in GraphQL scalars
  String: GraphQLString,
  Int: GraphQLInt,
  Float: GraphQLFloat,
  Boolean: GraphQLBoolean,
  ID: GraphQLID,
  // Canonical custom scalar names
  uuid: customScalars['Uuid']!,
  Uuid: customScalars['Uuid']!,
  json: customScalars['json']!,
  Jsonb: customScalars['Jsonb']!,
  jsonb: customScalars['Jsonb']!,
  Timestamptz: customScalars['Timestamptz']!,
  timestamptz: customScalars['Timestamptz']!,
  Date: customScalars['Date']!,
  Time: customScalars['Time']!,
  Bigint: customScalars['Bigint']!,
  bigint: customScalars['Bigint']!,
  numeric: customScalars['Numeric']!,
  Numeric: customScalars['Numeric']!,
  Bpchar: customScalars['Bpchar']!,
  bpchar: customScalars['Bpchar']!,
  Interval: customScalars['Interval']!,
  Bytea: customScalars['Bytea']!,
  Inet: customScalars['Inet']!,
  // PG array type scalars
  _text: customScalars['_text']!,
  // Backwards-compat aliases for action SDL parsing
  UUID: customScalars['Uuid']!,
  JSON: customScalars['json']!,
  JSONB: customScalars['Jsonb']!,
  DateTime: customScalars['Timestamptz']!,
  BigInt: customScalars['Bigint']!,
  BigDecimal: customScalars['Numeric']!,
};

function resolveOutputType(
  typeNode: TypeNode,
  outputTypes: Map<string, GraphQLObjectType>,
  enumTypes?: Map<string, GraphQLEnumType>,
): GraphQLOutputType {
  if (typeNode.kind === 'NonNullType') {
    return new GraphQLNonNull(resolveOutputType(typeNode.type, outputTypes, enumTypes));
  }
  if (typeNode.kind === 'ListType') {
    return new GraphQLList(resolveOutputType(typeNode.type, outputTypes, enumTypes));
  }
  // NamedType
  const name = typeNode.name.value;
  const scalar = SCALAR_MAP[name];
  if (scalar) return scalar;
  const objectType = outputTypes.get(name);
  if (objectType) return objectType;
  // Check SDL-defined and PG-introspected enum types
  const enumType = enumTypes?.get(name);
  if (enumType) return enumType;
  // Fallback to String for unknown types
  return GraphQLString;
}

function resolveInputType(
  typeNode: TypeNode,
  inputTypes: Map<string, GraphQLInputObjectType>,
  enumTypes?: Map<string, GraphQLEnumType>,
): GraphQLInputType {
  if (typeNode.kind === 'NonNullType') {
    return new GraphQLNonNull(resolveInputType(typeNode.type, inputTypes, enumTypes));
  }
  if (typeNode.kind === 'ListType') {
    return new GraphQLList(resolveInputType(typeNode.type, inputTypes, enumTypes));
  }
  const name = typeNode.name.value;
  const scalar = SCALAR_MAP[name];
  if (scalar) return scalar;
  const inputType = inputTypes.get(name);
  if (inputType) return inputType;
  // Check SDL-defined and PG-introspected enum types
  const enumType = enumTypes?.get(name);
  if (enumType) return enumType;
  return GraphQLString;
}

// ─── SDL Parser ─────────────────────────────────────────────────────────────

interface ParsedAction {
  name: string;
  rootType: 'Query' | 'Mutation';
  inputTypeName: string;
  returnTypeNode: TypeNode;
  /** Inline argument definitions (when the action doesn't use a wrapped input type) */
  inlineArgs: InputValueDefinitionNode[];
}

/**
 * Unwrap a TypeNode to get the base named type name.
 */
function getBaseTypeName(typeNode: TypeNode): string {
  if (typeNode.kind === 'NonNullType' || typeNode.kind === 'ListType') {
    return getBaseTypeName(typeNode.type);
  }
  return typeNode.name.value;
}

/**
 * Parse the actions.graphql SDL and extract action definitions + types.
 */
function parseActionsSDL(sdl: string) {
  const doc: DocumentNode = parse(sdl);

  const actions: ParsedAction[] = [];
  const inputTypeDefs: Map<string, InputValueDefinitionNode[]> = new Map();
  const outputTypeDefs: Map<string, FieldDefinitionNode[]> = new Map();
  /** Enum types defined in the SDL (e.g., `enum PaymentType { ... }`) */
  const sdlEnumDefs: Map<string, string[]> = new Map();
  /** Scalar type names declared in the SDL (e.g., `scalar _text`) */
  const sdlScalarNames: Set<string> = new Set();

  for (const def of doc.definitions) {
    if (
      def.kind === 'ObjectTypeDefinition' ||
      def.kind === 'ObjectTypeExtension'
    ) {
      const typeName = def.name.value;

      if (typeName === 'Query' || typeName === 'Mutation') {
        // Extract action field definitions from Query/Mutation
        for (const field of def.fields ?? []) {
          const inputArg = field.arguments?.find((a) => a.name.value === 'input');
          let inputTypeName = '';
          let inlineArgs: InputValueDefinitionNode[] = [];

          if (inputArg) {
            // Wrapped input type pattern: action(input: SomeInput!)
            let typeNode = inputArg.type;
            while (typeNode.kind === 'NonNullType' || typeNode.kind === 'ListType') {
              typeNode = typeNode.type;
            }
            inputTypeName = typeNode.name.value;
          } else if (field.arguments && field.arguments.length > 0) {
            // Inline arguments pattern: action(arg1: Type!, arg2: Type)
            inlineArgs = [...field.arguments];
          }

          actions.push({
            name: field.name.value,
            rootType: typeName,
            inputTypeName,
            returnTypeNode: field.type,
            inlineArgs,
          });
        }
      } else {
        // Output type definition
        outputTypeDefs.set(typeName, [...(def.fields ?? [])]);
      }
    }

    if (def.kind === 'InputObjectTypeDefinition') {
      inputTypeDefs.set(def.name.value, [...(def.fields ?? [])]);
    }

    // Parse enum type definitions from SDL
    if (def.kind === 'EnumTypeDefinition') {
      const values = (def.values ?? []).map((v) => v.name.value);
      sdlEnumDefs.set(def.name.value, values);
    }

    // Parse scalar type declarations from SDL
    if (def.kind === 'ScalarTypeDefinition') {
      sdlScalarNames.add(def.name.value);
    }
  }

  return { actions, inputTypeDefs, outputTypeDefs, sdlEnumDefs, sdlScalarNames };
}

// (Async action types removed — mutations now return uuid! directly,
//  and result queries use the action's handler return type)

// ─── Relationship Helpers ────────────────────────────────────────────────────

/**
 * Remap a database result row from snake_case column names to camelCase field names.
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
  // Preserve any extra keys (e.g., nested relationship data)
  for (const [key, value] of Object.entries(row)) {
    const camelKey = toCamelCase(key);
    if (!(camelKey in result)) {
      result[camelKey] = value;
    }
  }
  return result;
}

/**
 * Build relationship fields for an action output type.
 *
 * For each configured relationship, adds a field to the output type that
 * resolves to the related database record(s) by querying via the field mapping.
 */
function buildRelationshipFields(
  relationships: ActionRelationship[],
  tables: TableInfo[],
  tableTypeRegistry: Map<string, GraphQLObjectType>,
): GraphQLFieldConfigMap<Record<string, unknown>, ResolverContext> {
  const fields: GraphQLFieldConfigMap<Record<string, unknown>, ResolverContext> = {};

  for (const rel of relationships) {
    const tableKey = `${rel.remoteTable.schema}.${rel.remoteTable.name}`;
    const remoteTable = tables.find(
      (t) => t.schema === rel.remoteTable.schema && t.name === rel.remoteTable.name,
    );
    const remoteType = tableTypeRegistry.get(tableKey);

    if (!remoteTable || !remoteType) {
      // Remote table not found in schema — skip this relationship
      continue;
    }

    if (rel.type === 'object') {
      fields[getRelFieldName(rel)] = {
        type: remoteType,
        resolve: makeActionRelationshipResolver(rel, remoteTable),
      };
    } else {
      // array relationship
      fields[getRelFieldName(rel)] = {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(remoteType))),
        resolve: makeActionRelationshipResolver(rel, remoteTable),
      };
    }
  }

  return fields;
}

/**
 * Creates a resolver for an action relationship field.
 *
 * The resolver extracts the join key value from the parent (action result),
 * compiles a SELECT query with a WHERE clause matching the field mapping,
 * executes it with the current session context, and returns the result.
 */
function makeActionRelationshipResolver(
  rel: ActionRelationship,
  remoteTable: TableInfo,
) {
  return async (
    parent: Record<string, unknown>,
    _args: unknown,
    context: ResolverContext,
  ): Promise<unknown> => {
    const { auth, queryWithSession, permissionLookup } = context;

    // Check permissions on the remote table
    const perm = permissionLookup.getSelect(
      remoteTable.schema,
      remoteTable.name,
      auth.role,
    );

    if (!perm && !auth.isAdmin) {
      // No select permission on remote table — return null/empty
      return rel.type === 'object' ? null : [];
    }

    // Build WHERE condition from the field mapping
    // field_mapping: { actionOutputField: remoteTableColumn }
    const whereConditions: Record<string, { _eq: unknown }> = {};
    let hasMissingKey = false;

    for (const [actionField, remoteColumn] of Object.entries(rel.fieldMapping)) {
      const value = parent[actionField];
      if (value === undefined || value === null) {
        hasMissingKey = true;
        break;
      }
      whereConditions[remoteColumn] = { _eq: value };
    }

    if (hasMissingKey) {
      return rel.type === 'object' ? null : [];
    }

    // Select all permitted columns
    const allColumns = remoteTable.columns.map((c) => c.name);
    const columns =
      !perm || perm.columns === '*'
        ? allColumns
        : allColumns.filter((c) => (perm.columns as string[]).includes(c));

    const compiled = compileSelect({
      table: remoteTable,
      columns,
      where: whereConditions as BoolExp,
      limit: rel.type === 'object' ? 1 : undefined,
      permission: perm
        ? {
            filter: perm.filter,
            columns: perm.columns,
            limit: perm.limit,
          }
        : undefined,
      session: auth,
    });

    const result = await queryWithSession(compiled.sql, compiled.params, auth, 'read');

    // compileSelect wraps results in json_agg → single row with "data" column
    const data = (result.rows[0] as Record<string, unknown> | undefined)?.data;

    if (rel.type === 'object') {
      if (!data || !Array.isArray(data) || data.length === 0) {
        return null;
      }
      return remapRowToCamel(data[0] as Record<string, unknown>, remoteTable);
    }

    // array relationship
    if (!data || !Array.isArray(data)) {
      return [];
    }
    return data.map((row) =>
      remapRowToCamel(row as Record<string, unknown>, remoteTable),
    );
  };
}

// ─── Main Builder ───────────────────────────────────────────────────────────

/**
 * Build action GraphQL fields from the actions config and actions.graphql SDL.
 *
 * @param actions   - Action configs from actions.yaml
 * @param sdl       - Raw actions.graphql SDL content
 * @param options   - Additional options for relationship resolution
 * @returns Query and Mutation field configs with wired resolvers
 */
export function buildActionFields(
  actions: ActionConfig[],
  sdl: string,
  options?: ActionSchemaOptions,
): ActionSchemaResult {
  if (!sdl || actions.length === 0) {
    return { queryFields: {}, mutationFields: {}, subscriptionFields: {}, types: [] };
  }

  const { actions: parsedActions, inputTypeDefs, outputTypeDefs, sdlEnumDefs, sdlScalarNames } = parseActionsSDL(sdl);

  // Build merged enum types map: SDL-defined enums + PG-introspected enums
  const allEnumTypes = new Map<string, GraphQLEnumType>();

  // Add PG-introspected enum types from schema model
  if (options?.enumTypes) {
    for (const [name, enumType] of options.enumTypes) {
      allEnumTypes.set(name, enumType);
    }
  }

  // Build GraphQL enum types from SDL-defined enum declarations
  for (const [name, values] of sdlEnumDefs) {
    const enumValues: Record<string, { value: string }> = {};
    for (const val of values) {
      enumValues[val] = { value: val };
    }
    allEnumTypes.set(name, new GraphQLEnumType({
      name,
      values: enumValues,
    }));
  }

  // Register SDL-declared scalars (e.g., `scalar _text`) in the SCALAR_MAP if they
  // correspond to known scalars. This handles cases like `scalar _text` → [String].
  // Unknown SDL scalars that aren't in SCALAR_MAP or customScalars are treated as
  // GraphQLString (the existing fallback behavior).
  for (const scalarName of sdlScalarNames) {
    if (!SCALAR_MAP[scalarName] && customScalars[scalarName]) {
      // Add to SCALAR_MAP at runtime for this build pass — the customScalars
      // registry already has the type, just the action SCALAR_MAP alias is missing.
      SCALAR_MAP[scalarName] = customScalars[scalarName] as GraphQLOutputType & GraphQLInputType;
    }
  }

  // Build action config lookup
  const actionConfigMap = new Map<string, ActionConfig>();
  for (const action of actions) {
    actionConfigMap.set(action.name, action);
  }

  // Build a mapping from action name to its return type name (for relationship augmentation)
  const actionReturnTypeNames = new Map<string, string>();
  for (const parsed of parsedActions) {
    const baseTypeName = getBaseTypeName(parsed.returnTypeNode);
    actionReturnTypeNames.set(parsed.name, baseTypeName);
  }

  // Build a mapping from output type name to the relationships that should augment it
  const typeRelationships = new Map<string, ActionRelationship[]>();
  if (options?.tables && options?.tableTypeRegistry) {
    for (const action of actions) {
      if (!action.relationships || action.relationships.length === 0) continue;
      const returnTypeName = actionReturnTypeNames.get(action.name);
      if (!returnTypeName) continue;

      const existing = typeRelationships.get(returnTypeName) ?? [];
      // Merge relationships (avoid duplicates by name)
      for (const rel of action.relationships) {
        if (!existing.some((r) => r.name === rel.name)) {
          existing.push(rel);
        }
      }
      typeRelationships.set(returnTypeName, existing);
    }
  }

  // Build GraphQL input types
  const inputTypes = new Map<string, GraphQLInputObjectType>();
  for (const [name, fieldDefs] of inputTypeDefs) {
    inputTypes.set(
      name,
      new GraphQLInputObjectType({
        name,
        fields: () => {
          const fields: Record<string, { type: GraphQLInputType }> = {};
          for (const fieldDef of fieldDefs) {
            fields[fieldDef.name.value] = {
              type: resolveInputType(fieldDef.type, inputTypes, allEnumTypes),
            };
          }
          return fields;
        },
      }),
    );
  }

  // Build GraphQL output types (with optional relationship fields)
  const outputTypes = new Map<string, GraphQLObjectType>();
  for (const [name, fieldDefs] of outputTypeDefs) {
    const rels = typeRelationships.get(name);
    outputTypes.set(
      name,
      new GraphQLObjectType({
        name,
        fields: () => {
          const fields: GraphQLFieldConfigMap<Record<string, unknown>, ResolverContext> = {};
          for (const fieldDef of fieldDefs) {
            fields[fieldDef.name.value] = {
              type: resolveOutputType(fieldDef.type, outputTypes, allEnumTypes),
            };
          }

          // Add relationship fields if this output type has configured relationships
          if (rels && rels.length > 0 && options?.tables && options?.tableTypeRegistry) {
            const relFields = buildRelationshipFields(
              rels,
              options.tables,
              options.tableTypeRegistry,
            );
            for (const [fieldName, fieldConfig] of Object.entries(relFields)) {
              fields[fieldName] = fieldConfig;
            }
          }

          return fields;
        },
      }),
    );
  }

  // Build field configs for Query, Mutation, and Subscription
  const queryFields: Record<string, GraphQLFieldConfig<unknown, ResolverContext>> = {};
  const mutationFields: Record<string, GraphQLFieldConfig<unknown, ResolverContext>> = {};
  const subscriptionFields: Record<string, GraphQLFieldConfig<unknown, ResolverContext>> = {};

  for (const parsed of parsedActions) {
    const actionConfig = actionConfigMap.get(parsed.name);
    if (!actionConfig) continue;

    const isAsync = actionConfig.definition.kind === 'asynchronous';
    const returnType = resolveOutputType(parsed.returnTypeNode, outputTypes, allEnumTypes);
    const inputType = inputTypes.get(parsed.inputTypeName);
    const hasInlineArgs = parsed.inlineArgs.length > 0;

    // Build args config: either wrapped input type or inline arguments
    let argsConfig: Record<string, { type: GraphQLInputType }> = {};
    if (inputType) {
      argsConfig = { input: { type: new GraphQLNonNull(inputType) } };
    } else if (hasInlineArgs) {
      for (const argDef of parsed.inlineArgs) {
        argsConfig[argDef.name.value] = {
          type: resolveInputType(argDef.type, inputTypes, allEnumTypes),
        };
      }
    }

    if (isAsync) {
      // ── Async action: mutation returns uuid! (Hasura-compatible) ───────
      const mutationFieldConfig: GraphQLFieldConfig<unknown, ResolverContext> = {
        type: new GraphQLNonNull(customScalars['Uuid']!),
        args: argsConfig,
        description: actionConfig.comment
          ? `${actionConfig.comment} (async — returns action ID)`
          : `Async action: ${actionConfig.name}`,
        resolve: makeAsyncActionResolver(actionConfig, hasInlineArgs),
      };
      mutationFields[parsed.name] = mutationFieldConfig;

      // ── Async action: result query field ──────────────────────────────
      // Uses the action's handler return type directly (Hasura-compatible)
      const resultQueryFieldConfig: GraphQLFieldConfig<unknown, ResolverContext> = {
        type: returnType,
        args: {
          id: { type: new GraphQLNonNull(customScalars['Uuid']!) },
        },
        description: `Check the status and result of async action "${actionConfig.name}"`,
        resolve: makeAsyncActionResultResolver(actionConfig),
      };
      queryFields[parsed.name] = resultQueryFieldConfig;

      // ── Async action: subscription field (mirrors query) ─────────────
      // Hasura exposes async action result queries as subscription fields,
      // allowing clients to subscribe to action completion.
      subscriptionFields[parsed.name] = {
        type: returnType,
        args: {
          id: { type: new GraphQLNonNull(customScalars['Uuid']!) },
        },
        description: `Subscribe to the result of async action "${actionConfig.name}"`,
        resolve: (payload: unknown) => payload,
        subscribe: makeAsyncActionResultSubscribe(actionConfig),
      };
    } else {
      // ── Sync action: standard resolver ────────────────────────────────
      const fieldConfig: GraphQLFieldConfig<unknown, ResolverContext> = {
        type: returnType,
        args: argsConfig,
        description: actionConfig.comment ?? undefined,
        resolve: makeActionResolver(actionConfig, hasInlineArgs),
      };

      if (parsed.rootType === 'Query') {
        queryFields[parsed.name] = fieldConfig;
      } else {
        mutationFields[parsed.name] = fieldConfig;
      }
    }
  }

  // Collect all types to register in the schema
  // Include SDL-defined enum types so they appear in the schema
  const sdlEnumTypes: GraphQLEnumType[] = [];
  for (const [name] of sdlEnumDefs) {
    const et = allEnumTypes.get(name);
    if (et) sdlEnumTypes.push(et);
  }

  const types: GraphQLNamedType[] = [
    ...inputTypes.values(),
    ...outputTypes.values(),
    ...sdlEnumTypes,
  ];

  return { queryFields, mutationFields, subscriptionFields, types };
}

// ─── Sync Action Resolver Factory ───────────────────────────────────────────

function makeActionResolver(
  action: ActionConfig,
  inlineArgs = false,
) {
  return async (
    _parent: unknown,
    args: Record<string, unknown>,
    context: ResolverContext,
  ): Promise<unknown> => {
    // Check permissions
    if (!checkActionPermission(action, context.auth)) {
      throw new GraphQLError(
        `Not authorized to execute action "${action.name}"`,
        { extensions: { code: 'FORBIDDEN' } },
      );
    }

    // Execute the action via webhook proxy
    const input = inlineArgs ? args : ((args.input as Record<string, unknown>) ?? {});
    const result = await executeAction({
      action,
      input,
      session: context.auth,
      clientHeaders: context.clientHeaders,
    });

    if (!result.success) {
      throw new GraphQLError(
        result.error ?? `Action "${action.name}" failed`,
        { extensions: { code: 'ACTION_HANDLER_ERROR', ...result.extensions } },
      );
    }

    return result.data;
  };
}

// ─── Async Action Resolver Factories ────────────────────────────────────────

/**
 * Creates a resolver for the async action mutation.
 * Returns the action ID (UUID) immediately after enqueuing the action.
 */
function makeAsyncActionResolver(
  action: ActionConfig,
  inlineArgs = false,
) {
  return async (
    _parent: unknown,
    args: Record<string, unknown>,
    context: ResolverContext,
  ): Promise<unknown> => {
    // Check permissions
    if (!checkActionPermission(action, context.auth)) {
      throw new GraphQLError(
        `Not authorized to execute action "${action.name}"`,
        { extensions: { code: 'FORBIDDEN' } },
      );
    }

    // Check that async action infrastructure is available
    if (!context.jobQueue || !context.pool) {
      throw new GraphQLError(
        `Async action infrastructure not available`,
        { extensions: { code: 'SERVICE_UNAVAILABLE' } },
      );
    }

    // Enqueue the action and return the ID immediately
    const input = inlineArgs ? args : ((args.input as Record<string, unknown>) ?? {});
    const actionId = await enqueueAsyncAction(
      context.jobQueue,
      context.pool,
      action,
      input,
      context.auth,
    );

    return actionId;
  };
}

/**
 * Creates a resolver for the async action result query.
 * Returns the action's output directly (Hasura-compatible).
 *
 * - If the action is not found or belongs to a different action, returns null.
 * - If the action is still processing, returns null.
 * - If the action failed, throws a GraphQLError with the stored error.
 * - If the action completed, returns the output data.
 */
function makeAsyncActionResultResolver(
  action: ActionConfig,
) {
  return async (
    _parent: unknown,
    args: Record<string, unknown>,
    context: ResolverContext,
  ): Promise<unknown> => {
    // Check permissions — same as the action itself
    if (!checkActionPermission(action, context.auth)) {
      throw new GraphQLError(
        `Not authorized to query result of action "${action.name}"`,
        { extensions: { code: 'FORBIDDEN' } },
      );
    }

    if (!context.pool) {
      throw new GraphQLError(
        `Async action infrastructure not available`,
        { extensions: { code: 'SERVICE_UNAVAILABLE' } },
      );
    }

    const actionId = args.id as string;
    const result = await getAsyncActionResult(context.pool, actionId);

    if (!result) {
      return null;
    }

    // Verify the action name matches (prevent cross-action snooping)
    if (result.actionName !== action.name) {
      return null;
    }

    // Return the output directly (Hasura-compatible)
    if (result.status === 'completed') {
      return result.output ?? null;
    }

    if (result.status === 'failed') {
      const errorMsg = (result.errors as Record<string, unknown>)?.message ?? 'Action failed';
      throw new GraphQLError(
        String(errorMsg),
        { extensions: { code: 'ACTION_HANDLER_ERROR' } },
      );
    }

    // Still processing — return null
    return null;
  };
}

// ─── Async Action Result Subscription Factory ─────────────────────────────

/**
 * Simple push-to-pull adapter for async action result subscriptions.
 * Same pattern used in subscription-resolvers.ts (createAsyncQueue).
 */
function createAsyncQueue<T>(): {
  push(value: T): void;
  iterator: AsyncIterableIterator<T>;
  done(): void;
} {
  const buffer: T[] = [];
  const waiters: Array<(result: IteratorResult<T>) => void> = [];
  let finished = false;

  function push(value: T): void {
    if (finished) return;
    if (waiters.length > 0) {
      const resolve = waiters.shift()!;
      resolve({ value, done: false });
    } else {
      buffer.push(value);
    }
  }

  function done(): void {
    finished = true;
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

/**
 * Creates a `subscribe` function for async action result subscription fields.
 *
 * Registers with the subscription manager on the `hakkyra.async_action_log` table,
 * re-querying the action result whenever the table changes. This allows clients
 * to subscribe to async action completion.
 */
function makeAsyncActionResultSubscribe(
  action: ActionConfig,
) {
  return (
    _parent: unknown,
    args: Record<string, unknown>,
    context: ResolverContext,
  ): AsyncIterableIterator<unknown> => {
    const { auth, subscriptionManager, pool } = context;

    // Check permissions — same as the action query
    if (!checkActionPermission(action, auth)) {
      throw new GraphQLError(
        `Not authorized to subscribe to result of action "${action.name}"`,
        { extensions: { code: 'FORBIDDEN' } },
      );
    }

    if (!subscriptionManager) {
      throw new Error('Subscription manager is not available');
    }

    if (!pool) {
      throw new GraphQLError(
        'Async action infrastructure not available',
        { extensions: { code: 'SERVICE_UNAVAILABLE' } },
      );
    }

    const actionId = args.id as string;

    // Build a SQL query that fetches the async action result and wraps it
    // in the format expected by the subscription manager
    const sql = `SELECT json_build_object(
      'id', id,
      'status', status,
      'output', output,
      'errors', errors,
      'createdAt', created_at
    ) AS "data"
    FROM hakkyra.async_action_log
    WHERE id = $1 AND action_name = $2
    LIMIT 1`;
    const params = [actionId, action.name];

    const queue = createAsyncQueue<unknown>();
    const subscriptionId = randomUUID();

    function processResult(data: unknown): unknown {
      if (!data || typeof data !== 'object') {
        return null;
      }
      return data;
    }

    async function* generate(): AsyncGenerator<unknown> {
      try {
        const initialData = await subscriptionManager!.register({
          id: subscriptionId,
          tableKey: 'hakkyra.async_action_log',
          query: { sql, params },
          session: auth,
          push: (data: unknown) => {
            queue.push(processResult(data));
          },
        });

        yield processResult(initialData);

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
