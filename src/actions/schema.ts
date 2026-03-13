/**
 * Action schema integration.
 *
 * Parses actions.graphql SDL, builds GraphQL types for action inputs/outputs,
 * and generates resolver-wired field configs for Query and Mutation root types.
 *
 * Supports both synchronous and asynchronous actions:
 * - Sync: mutation calls webhook inline, returns result directly
 * - Async: mutation enqueues job, returns { actionId }, result queried separately
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
} from 'graphql';
import type { ActionConfig } from '../types.js';
import { customScalars } from '../schema/scalars.js';
import type { ResolverContext } from '../schema/resolvers.js';
import { checkActionPermission } from './permissions.js';
import { executeAction } from './proxy.js';
import { enqueueAsyncAction, getAsyncActionResult } from './async.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ActionSchemaResult {
  queryFields: Record<string, GraphQLFieldConfig<unknown, ResolverContext>>;
  mutationFields: Record<string, GraphQLFieldConfig<unknown, ResolverContext>>;
  types: GraphQLNamedType[];
}

// ─── SDL Type Resolution ────────────────────────────────────────────────────

/** Map of scalar names used in actions.graphql → GraphQL types */
const SCALAR_MAP: Record<string, GraphQLOutputType & GraphQLInputType> = {
  String: GraphQLString,
  Int: GraphQLInt,
  Float: GraphQLFloat,
  Boolean: GraphQLBoolean,
  uuid: customScalars['UUID']!,
  UUID: customScalars['UUID']!,
  JSON: customScalars['JSON']!,
  JSONB: customScalars['JSONB']!,
  DateTime: customScalars['DateTime']!,
  Timestamptz: customScalars['Timestamptz']!,
  Date: customScalars['Date']!,
  Time: customScalars['Time']!,
  BigInt: customScalars['BigInt']!,
  BigDecimal: customScalars['BigDecimal']!,
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
          if (inputArg) {
            // Unwrap NonNull to get the named type
            let typeNode = inputArg.type;
            while (typeNode.kind === 'NonNullType' || typeNode.kind === 'ListType') {
              typeNode = typeNode.type;
            }
            inputTypeName = typeNode.name.value;
          }

          actions.push({
            name: field.name.value,
            rootType: typeName,
            inputTypeName,
            returnTypeNode: field.type,
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

/** The return type for async action mutations: { actionId: UUID! } */
const AsyncActionIdType = new GraphQLObjectType({
  name: 'AsyncActionId',
  description: 'Return type for async action mutations',
  fields: {
    actionId: { type: new GraphQLNonNull(customScalars['UUID']!) },
  },
});

// ─── Main Builder ───────────────────────────────────────────────────────────

/**
 * Build action GraphQL fields from the actions config and actions.graphql SDL.
 *
 * @param actions   - Action configs from actions.yaml
 * @param sdl       - Raw actions.graphql SDL content
 * @returns Query and Mutation field configs with wired resolvers
 */
export function buildActionFields(
  actions: ActionConfig[],
  sdl: string,
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

  // Build GraphQL output types
  const outputTypes = new Map<string, GraphQLObjectType>();
  for (const [name, fieldDefs] of outputTypeDefs) {
    outputTypes.set(
      name,
      new GraphQLObjectType({
        name,
        fields: () => {
          const fields: Record<string, { type: GraphQLOutputType }> = {};
          for (const fieldDef of fieldDefs) {
            fields[fieldDef.name.value] = {
              type: resolveOutputType(fieldDef.type, outputTypes),
            };
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

    if (isAsync) {
      hasAsyncActions = true;

      // ── Async action: mutation returns { actionId: UUID! } ────────────
      const mutationFieldConfig: GraphQLFieldConfig<unknown, ResolverContext> = {
        type: new GraphQLNonNull(AsyncActionIdType),
        args: inputType
          ? { input: { type: new GraphQLNonNull(inputType) } }
          : {},
        description: actionConfig.comment
          ? `${actionConfig.comment} (async — returns action ID)`
          : `Async action: ${actionConfig.name}`,
        resolve: makeAsyncActionResolver(actionConfig),
      };
      mutationFields[parsed.name] = mutationFieldConfig;

      // ── Async action: result query field ──────────────────────────────
      // Build a per-action result type that includes the action's output type
      const resultTypeName = `${parsed.name.charAt(0).toUpperCase()}${parsed.name.slice(1)}AsyncResult`;
      const asyncResultType = new GraphQLObjectType({
        name: resultTypeName,
        description: `Async action result for ${actionConfig.name}`,
        fields: {
          id: { type: new GraphQLNonNull(customScalars['UUID']!) },
          status: { type: new GraphQLNonNull(AsyncActionStatusEnum) },
          output: { type: returnType },
          errors: { type: customScalars['JSONB']! },
          createdAt: { type: new GraphQLNonNull(customScalars['Timestamptz']!) },
        },
      });
      outputTypes.set(resultTypeName, asyncResultType);

      const resultQueryFieldConfig: GraphQLFieldConfig<unknown, ResolverContext> = {
        type: asyncResultType,
        args: {
          id: { type: new GraphQLNonNull(customScalars['UUID']!) },
        },
        description: `Check the status and result of async action "${actionConfig.name}"`,
        resolve: makeAsyncActionResultResolver(actionConfig),
      };
      queryFields[`${parsed.name}Result`] = resultQueryFieldConfig;
    } else {
      // ── Sync action: standard resolver ────────────────────────────────
      const fieldConfig: GraphQLFieldConfig<unknown, ResolverContext> = {
        type: returnType,
        args: inputType
          ? { input: { type: new GraphQLNonNull(inputType) } }
          : {},
        description: actionConfig.comment ?? undefined,
        resolve: makeActionResolver(actionConfig),
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
    const result = await executeAction({
      action,
      input: (args.input as Record<string, unknown>) ?? {},
      session: context.auth,
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
    const actionId = await enqueueAsyncAction(
      context.jobQueue,
      context.pool,
      action,
      (args.input as Record<string, unknown>) ?? {},
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
