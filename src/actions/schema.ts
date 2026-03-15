/**
 * Action schema integration.
 *
 * Parses actions.graphql SDL, builds GraphQL types for action inputs/outputs,
 * and generates resolver-wired field configs for Query and Mutation root types.
 *
 * Supports both synchronous and asynchronous actions:
 * - Sync: mutation calls webhook inline, returns result directly
 * - Async: mutation enqueues job, returns { actionId }, result queried separately
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
  GraphQLError,
  GraphQLEnumType,
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
import type { ResolverContext } from '../schema/resolvers.js';
import { checkActionPermission } from './permissions.js';
import { executeAction } from './proxy.js';
import { enqueueAsyncAction, getAsyncActionResult } from './async.js';
import { compileSelect } from '../sql/select.js';
import { toCamelCase } from '../schema/type-builder.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ActionSchemaResult {
  queryFields: Record<string, GraphQLFieldConfig<unknown, ResolverContext>>;
  mutationFields: Record<string, GraphQLFieldConfig<unknown, ResolverContext>>;
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
}

// ─── SDL Type Resolution ────────────────────────────────────────────────────

/** Map of scalar names used in actions.graphql → GraphQL types */
const SCALAR_MAP: Record<string, GraphQLOutputType & GraphQLInputType> = {
  String: GraphQLString,
  Int: GraphQLInt,
  Float: GraphQLFloat,
  Boolean: GraphQLBoolean,
  // New canonical names
  uuid: customScalars['Uuid']!,
  Uuid: customScalars['Uuid']!,
  json: customScalars['json']!,
  Jsonb: customScalars['Jsonb']!,
  Timestamptz: customScalars['Timestamptz']!,
  Date: customScalars['Date']!,
  Time: customScalars['Time']!,
  Bigint: customScalars['Bigint']!,
  Numeric: customScalars['Numeric']!,
  Bpchar: customScalars['Bpchar']!,
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
): GraphQLOutputType {
  if (typeNode.kind === 'NonNullType') {
    return new GraphQLNonNull(resolveOutputType(typeNode.type, outputTypes));
  }
  if (typeNode.kind === 'ListType') {
    return new GraphQLList(resolveOutputType(typeNode.type, outputTypes));
  }
  // NamedType
  const name = typeNode.name.value;
  const scalar = SCALAR_MAP[name];
  if (scalar) return scalar;
  const objectType = outputTypes.get(name);
  if (objectType) return objectType;
  // Fallback to String for unknown types
  return GraphQLString;
}

function resolveInputType(
  typeNode: TypeNode,
  inputTypes: Map<string, GraphQLInputObjectType>,
): GraphQLInputType {
  if (typeNode.kind === 'NonNullType') {
    return new GraphQLNonNull(resolveInputType(typeNode.type, inputTypes));
  }
  if (typeNode.kind === 'ListType') {
    return new GraphQLList(resolveInputType(typeNode.type, inputTypes));
  }
  const name = typeNode.name.value;
  const scalar = SCALAR_MAP[name];
  if (scalar) return scalar;
  const inputType = inputTypes.get(name);
  if (inputType) return inputType;
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
  }

  return { actions, inputTypeDefs, outputTypeDefs };
}

// ─── Shared Async Action Types ──────────────────────────────────────────────

/** AsyncActionStatus enum type — shared across all async actions */
const AsyncActionStatusEnum = new GraphQLEnumType({
  name: 'AsyncActionStatus',
  description: 'Status of an asynchronous action',
  values: {
    created: { value: 'created' },
    processing: { value: 'processing' },
    completed: { value: 'completed' },
    failed: { value: 'failed' },
  },
});

/** The return type for async action mutations: { actionId: Uuid! } */
const AsyncActionIdType = new GraphQLObjectType({
  name: 'AsyncActionId',
  description: 'Return type for async action mutations',
  fields: {
    actionId: { type: new GraphQLNonNull(customScalars['Uuid']!) },
  },
});

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
      result[toCamelCase(col.name)] = row[col.name];
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
      fields[toCamelCase(rel.name)] = {
        type: remoteType,
        resolve: makeActionRelationshipResolver(rel, remoteTable),
      };
    } else {
      // array relationship
      fields[toCamelCase(rel.name)] = {
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
    return { queryFields: {}, mutationFields: {}, types: [] };
  }

  const { actions: parsedActions, inputTypeDefs, outputTypeDefs } = parseActionsSDL(sdl);

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
              type: resolveInputType(fieldDef.type, inputTypes),
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
              type: resolveOutputType(fieldDef.type, outputTypes),
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

  // Build field configs for Query and Mutation
  const queryFields: Record<string, GraphQLFieldConfig<unknown, ResolverContext>> = {};
  const mutationFields: Record<string, GraphQLFieldConfig<unknown, ResolverContext>> = {};

  // Track whether we need async types in the schema
  let hasAsyncActions = false;

  for (const parsed of parsedActions) {
    const actionConfig = actionConfigMap.get(parsed.name);
    if (!actionConfig) continue;

    const isAsync = actionConfig.definition.kind === 'asynchronous';
    const returnType = resolveOutputType(parsed.returnTypeNode, outputTypes);
    const inputType = inputTypes.get(parsed.inputTypeName);
    const hasInlineArgs = parsed.inlineArgs.length > 0;

    // Build args config: either wrapped input type or inline arguments
    let argsConfig: Record<string, { type: GraphQLInputType }> = {};
    if (inputType) {
      argsConfig = { input: { type: new GraphQLNonNull(inputType) } };
    } else if (hasInlineArgs) {
      for (const argDef of parsed.inlineArgs) {
        argsConfig[argDef.name.value] = {
          type: resolveInputType(argDef.type, inputTypes),
        };
      }
    }

    if (isAsync) {
      hasAsyncActions = true;

      // ── Async action: mutation returns { actionId: Uuid! } ────────────
      const mutationFieldConfig: GraphQLFieldConfig<unknown, ResolverContext> = {
        type: new GraphQLNonNull(AsyncActionIdType),
        args: argsConfig,
        description: actionConfig.comment
          ? `${actionConfig.comment} (async — returns action ID)`
          : `Async action: ${actionConfig.name}`,
        resolve: makeAsyncActionResolver(actionConfig, hasInlineArgs),
      };
      mutationFields[parsed.name] = mutationFieldConfig;

      // ── Async action: result query field ──────────────────────────────
      // Build a per-action result type that includes the action's output type
      const resultTypeName = `${parsed.name.charAt(0).toUpperCase()}${parsed.name.slice(1)}AsyncResult`;
      const asyncResultType = new GraphQLObjectType({
        name: resultTypeName,
        description: `Async action result for ${actionConfig.name}`,
        fields: {
          id: { type: new GraphQLNonNull(customScalars['Uuid']!) },
          status: { type: new GraphQLNonNull(AsyncActionStatusEnum) },
          output: { type: returnType },
          errors: { type: customScalars['Jsonb']! },
          createdAt: { type: new GraphQLNonNull(customScalars['Timestamptz']!) },
        },
      });
      outputTypes.set(resultTypeName, asyncResultType);

      const resultQueryFieldConfig: GraphQLFieldConfig<unknown, ResolverContext> = {
        type: asyncResultType,
        args: {
          id: { type: new GraphQLNonNull(customScalars['Uuid']!) },
        },
        description: `Check the status and result of async action "${actionConfig.name}"`,
        resolve: makeAsyncActionResultResolver(actionConfig),
      };
      queryFields[`${parsed.name}Result`] = resultQueryFieldConfig;
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
  const types: GraphQLNamedType[] = [
    ...inputTypes.values(),
    ...outputTypes.values(),
  ];

  // Add async action shared types if any async actions exist
  if (hasAsyncActions) {
    types.push(AsyncActionStatusEnum, AsyncActionIdType);
  }

  return { queryFields, mutationFields, types };
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
 * Returns { actionId } immediately after enqueuing the action.
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

    return { actionId };
  };
}

/**
 * Creates a resolver for the async action result query.
 * Returns the current status and output of the action.
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

    return {
      id: result.id,
      status: result.status,
      output: result.output,
      errors: result.errors,
      createdAt: result.createdAt,
    };
  };
}
