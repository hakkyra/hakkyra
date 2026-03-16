/**
 * Main schema generator — assembles a complete GraphQLSchema from a SchemaModel.
 *
 * Steps:
 * 1. Create TypeRegistry for type lookups and circular ref handling
 * 2. Build custom scalars + enum types
 * 3. Build GraphQLObjectType for each tracked table
 * 4. Build filter (BoolExp) input types for each table
 * 5. Build mutation input types (insert/set/pk/orderby/aggregate) for each table
 * 6. Build Query type with all select / selectByPk / aggregate fields
 * 7. Build Mutation type with all insert / update / delete fields
 * 8. Build Subscription type with select / selectByPk / selectAggregate fields
 * 9. Assemble and return a complete GraphQLSchema
 */

import {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLNonNull,
  GraphQLList,
  GraphQLInt,
  GraphQLEnumType,
  GraphQLInputObjectType,
} from 'graphql';
import type {
  GraphQLFieldConfigMap,
  GraphQLFieldConfigArgumentMap,
} from 'graphql';
import type { SchemaModel, TableInfo, EnumInfo, ActionConfig, OperationsConfig } from '../types.js';
import { buildActionFields } from '../actions/schema.js';
import { pgEnumToGraphQLName } from '../introspection/type-map.js';
import { customScalars } from './scalars.js';
import {
  buildObjectType,
  getTypeName,
  getColumnFieldName,
  toCamelCase,
  tableKey,
} from './type-builder.js';
import type { TypeRegistry } from './type-builder.js';
import { buildFilterTypes } from './filters.js';
import { buildMutationInputTypes, buildAllAggregateOrderByTypes, OrderByDirection, CursorOrdering, buildStreamCursorTypes } from './inputs.js';
import type { MutationInputTypes, StreamCursorTypes } from './inputs.js';
import {
  makeSelectResolver,
  makeSelectByPkResolver,
  makeSelectAggregateResolver,
  makeInsertResolver,
  makeInsertOneResolver,
  makeUpdateResolver,
  makeUpdateByPkResolver,
  makeUpdateManyResolver,
  makeDeleteResolver,
  makeDeleteByPkResolver,
} from './resolvers/index.js';
import type { ResolverContext } from './resolvers/index.js';
import {
  makeSubscriptionSelectSubscribe,
  makeSubscriptionSelectByPkSubscribe,
  makeSubscriptionSelectAggregateSubscribe,
  makeSubscriptionStreamSubscribe,
  makeTrackedFunctionSubscriptionSubscribe,
  makeTrackedFunctionAggregateSubscriptionSubscribe,
} from './subscription-resolvers.js';
import { buildNativeQueryFields } from './native-queries.js';
import { resolveTrackedFunctions, buildTrackedFunctionFields } from './tracked-functions.js';
import type { TrackedFunctionConfig } from '../types.js';

// ─── Root Field Naming ──────────────────────────────────────────────────────

/**
 * Derive root field names for a table, respecting customRootFields overrides.
 */
interface RootFieldNames {
  select: string;
  selectByPk: string;
  selectAggregate: string;
  selectStream: string;
  insert: string;
  insertOne: string;
  update: string;
  updateByPk: string;
  updateMany: string;
  delete: string;
  deleteByPk: string;
}

function getRootFieldNames(table: TableInfo): RootFieldNames {
  // When custom_name (alias) is set, use it verbatim — Hasura does NOT camelCase it.
  const base = table.alias ?? toCamelCase(table.name);
  const typeName = getTypeName(table);
  // For prefixed root fields (insert/update/delete), capitalize the first letter
  // so that e.g. custom_name "gameSession" becomes "insertGameSession", not "insertgameSession".
  const prefixedName = typeName.charAt(0).toUpperCase() + typeName.slice(1);
  const custom = table.customRootFields;

  return {
    select: custom?.select ?? base,
    selectByPk: custom?.select_by_pk ?? `${base}ByPk`,
    selectAggregate: custom?.select_aggregate ?? `${base}Aggregate`,
    selectStream: custom?.select_stream ?? `${base}Stream`,
    insert: custom?.insert ?? `insert${prefixedName}`,
    insertOne: custom?.insert_one ?? `insert${prefixedName}One`,
    update: custom?.update ?? `update${prefixedName}`,
    updateByPk: custom?.update_by_pk ?? `update${prefixedName}ByPk`,
    updateMany: custom?.update_many ?? `update${prefixedName}Many`,
    delete: custom?.delete ?? `delete${prefixedName}`,
    deleteByPk: custom?.delete_by_pk ?? `delete${prefixedName}ByPk`,
  };
}

/**
 * Check if a specific operation is enabled for a table.
 * When no operations config exists, all operations default to enabled.
 */
function isMutationOp(op: keyof OperationsConfig): boolean {
  return op !== 'select' && op !== 'selectByPk' && op !== 'selectAggregate';
}

function isOpEnabled(table: TableInfo, op: keyof OperationsConfig): boolean {
  // Views and materialized views cannot have mutation operations
  if (table.isView && isMutationOp(op)) return false;
  if (!table.operations) return true;
  return table.operations[op] !== false;
}

// ─── Enum Builder ───────────────────────────────────────────────────────────

function buildEnumTypes(enums: EnumInfo[]): Map<string, GraphQLEnumType> {
  const enumTypes = new Map<string, GraphQLEnumType>();

  for (const enumInfo of enums) {
    const name = pgEnumToGraphQLName(enumInfo.name);
    const values: Record<string, { value: string }> = {};
    for (const val of enumInfo.values) {
      // UPPER_CASE enum values per graphql-default naming convention
      // PG enum 'active' → GraphQL 'ACTIVE', 'pending_review' → 'PENDING_REVIEW'
      const enumValueName = val.replace(/[^_a-zA-Z0-9]/g, '_').toUpperCase();
      values[enumValueName] = { value: val };
    }

    const enumType = new GraphQLEnumType({
      name,
      description: `Enum type for ${enumInfo.schema}.${enumInfo.name}`,
      values,
    });

    enumTypes.set(name, enumType);
  }

  return enumTypes;
}

// ─── Main Generator ─────────────────────────────────────────────────────────

/**
 * Generate a complete GraphQL schema from the introspected + configured schema model.
 *
 * @param model  The merged schema model (introspection + Hasura config)
 * @returns      A complete, executable GraphQLSchema
 */
export interface GenerateSchemaOptions {
  actions?: ActionConfig[];
  actionsGraphql?: string;
  trackedFunctions?: TrackedFunctionConfig[];
  /** If provided, only these tables get root query/mutation/subscription fields.
   *  All tables still get object types (needed for relationship resolution). */
  rootFieldTables?: Set<string>;
}

export function generateSchema(model: SchemaModel, options?: GenerateSchemaOptions): GraphQLSchema {
  const { tables, enums, functions } = model;

  // ── Step 1: Initialize registries ──────────────────────────────────────
  const typeRegistry: TypeRegistry = new Map();
  const enumTypes = buildEnumTypes(enums);
  const enumNames = new Set(enums.map((e) => e.name));

  // ── Step 2: Build filter types (needed by object types for array rel args)
  // Create a shared selectColumnEnums map that will be populated during buildMutationInputTypes.
  // The filter types use thunks (lazy fields), so the map will be populated by the time they execute.
  const selectColumnEnums = new Map<string, GraphQLEnumType>();
  const filterTypes = buildFilterTypes(tables, typeRegistry, enumTypes, enumNames, selectColumnEnums, functions);

  // ── Step 3: Build OrderBy types for each table (needed by array rel args)
  const orderByTypes = new Map<string, GraphQLInputObjectType>();

  // ── Step 4: Build GraphQLObjectType for each table ─────────────────────
  // Pre-create the aggregate types map. It will be populated in Step 5 after
  // mutation input types are built, but object type fields use thunks (lazy
  // evaluation) so the map will be ready by the time fields are resolved.
  const aggregateTypesByTable = new Map<string, GraphQLObjectType>();

  // First pass: create all object types and register them
  for (const table of tables) {
    const key = tableKey(table.schema, table.name);
    const objectType = buildObjectType(
      table,
      typeRegistry,
      enumTypes,
      enumNames,
      filterTypes,
      orderByTypes,
      functions,
      aggregateTypesByTable,
      selectColumnEnums,
    );
    typeRegistry.set(key, objectType);
  }

  // ── Step 5: Build mutation input types for each table ──────────────────
  // Pre-pass: build AggregateOrderBy types for all tables first.
  // These are needed by parent tables' OrderBy thunks for array relationship aggregate ordering.
  buildAllAggregateOrderByTypes(tables, enumNames, orderByTypes);

  const mutationInputsByTable = new Map<string, MutationInputTypes>();
  const insertInputTypes = new Map<string, import('graphql').GraphQLInputObjectType>();

  for (const table of tables) {
    const key = tableKey(table.schema, table.name);
    const objectType = typeRegistry.get(key)!;
    const filterType = filterTypes.get(key);
    const mutInputs = buildMutationInputTypes(
      table, objectType, enumTypes, enumNames, filterType, orderByTypes, tables, functions, insertInputTypes,
    );
    mutationInputsByTable.set(key, mutInputs);
    // Register orderBy types for use in array relationship args
    orderByTypes.set(key, mutInputs.orderBy);
    // Populate the selectColumnEnums map for aggregate BoolExp types (used by filter thunks)
    selectColumnEnums.set(key, mutInputs.selectColumnEnum);
  }

  // Collect selectColumnEnums and populate the aggregate types map
  // (aggregateTypesByTable was pre-created in Step 4 for use by object type thunks)
  const selectColumnEnumsByTable = new Map<string, import('graphql').GraphQLEnumType>();

  for (const table of tables) {
    const key = tableKey(table.schema, table.name);
    const mutInputs = mutationInputsByTable.get(key)!;
    selectColumnEnumsByTable.set(key, mutInputs.selectColumnEnum);
    aggregateTypesByTable.set(key, mutInputs.selectAggregateFields);
  }

  // ── Step 5b: Build native query fields ───────────────────────────────────
  const nativeQueryFieldResult = buildNativeQueryFields(
    model.nativeQueries ?? [],
    model.logicalModels ?? [],
  );

  // ── Step 5c: Build tracked function fields ─────────────────────────────
  const trackedFunctionConfigs = options?.trackedFunctions ?? model.trackedFunctions ?? [];
  const resolvedTrackedFunctions = resolveTrackedFunctions(
    trackedFunctionConfigs,
    functions,
    tables,
  );
  const trackedFunctionFields = buildTrackedFunctionFields(
    resolvedTrackedFunctions,
    typeRegistry,
    filterTypes,
    orderByTypes,
    selectColumnEnumsByTable,
    aggregateTypesByTable,
    enumTypes,
    enumNames,
  );

  // ── Step 6: Build Query type ───────────────────────────────────────────
  const queryFields: GraphQLFieldConfigMap<unknown, ResolverContext> = {};
  const rootFieldTables = options?.rootFieldTables;

  for (const table of tables) {
    if (rootFieldTables && !rootFieldTables.has(table.name)) continue;
    const key = tableKey(table.schema, table.name);
    const objectType = typeRegistry.get(key)!;
    const filterType = filterTypes.get(key);
    const mutInputs = mutationInputsByTable.get(key)!;
    const names = getRootFieldNames(table);

    // select (list)
    if (isOpEnabled(table, 'select')) {
      const selectArgs: GraphQLFieldConfigArgumentMap = {};
      selectArgs['distinctOn'] = {
        type: new GraphQLList(new GraphQLNonNull(mutInputs.selectColumnEnum)),
        description: 'Distinct on columns. DISTINCT ON selects one row per unique combination of the specified columns.',
      };
      if (filterType) {
        selectArgs['where'] = { type: filterType };
      }
      selectArgs['orderBy'] = {
        type: new GraphQLList(new GraphQLNonNull(mutInputs.orderBy)),
      };
      selectArgs['limit'] = { type: GraphQLInt };
      selectArgs['offset'] = { type: GraphQLInt };

      queryFields[names.select] = {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(objectType))),
        args: selectArgs,
        resolve: makeSelectResolver(table),
        description: `Fetch rows from ${table.schema}.${table.name}`,
      };
    }

    // select_by_pk
    if (isOpEnabled(table, 'selectByPk') && table.primaryKey.length > 0 && mutInputs.pkColumnsInput) {
      const pkArgs: GraphQLFieldConfigArgumentMap = {};
      for (const pkColName of table.primaryKey) {
        const column = table.columns.find((c) => c.name === pkColName);
        if (!column) continue;
        const fieldName = getColumnFieldName(table, column.name);
        // PK args are required non-null scalars
        const pkInputType = mutInputs.pkColumnsInput.getFields()[fieldName];
        if (pkInputType) {
          pkArgs[fieldName] = { type: pkInputType.type };
        }
      }

      queryFields[names.selectByPk] = {
        type: objectType,
        args: pkArgs,
        resolve: makeSelectByPkResolver(table),
        description: `Fetch a single row from ${table.schema}.${table.name} by primary key`,
      };
    }

    // select_aggregate
    if (isOpEnabled(table, 'selectAggregate')) {
      const aggArgs: GraphQLFieldConfigArgumentMap = {};
      if (filterType) {
        aggArgs['where'] = { type: filterType };
      }
      aggArgs['orderBy'] = {
        type: new GraphQLList(new GraphQLNonNull(mutInputs.orderBy)),
      };
      aggArgs['limit'] = { type: GraphQLInt };
      aggArgs['offset'] = { type: GraphQLInt };
      aggArgs['distinctOn'] = {
        type: new GraphQLList(new GraphQLNonNull(mutInputs.selectColumnEnum)),
        description: 'Distinct on columns. DISTINCT ON selects one row per unique combination of the specified columns.',
      };

      queryFields[names.selectAggregate] = {
        type: new GraphQLNonNull(mutInputs.selectAggregateFields),
        args: aggArgs,
        resolve: makeSelectAggregateResolver(table),
        description: `Aggregate rows from ${table.schema}.${table.name}`,
      };
    }
  }

  // Add native query fields to Query
  for (const [name, fieldConfig] of Object.entries(nativeQueryFieldResult.queryFields)) {
    queryFields[name] = fieldConfig;
  }

  // Add tracked function query fields to Query
  for (const [name, fieldConfig] of Object.entries(trackedFunctionFields.queryFields)) {
    queryFields[name] = fieldConfig;
  }

  // ── Step 5d: Build action fields ────────────────────────────────────────
  const actionFields = (options?.actions?.length && options?.actionsGraphql)
    ? buildActionFields(options.actions, options.actionsGraphql, {
        tables,
        tableTypeRegistry: typeRegistry,
        enumTypes,
      })
    : { queryFields: {}, mutationFields: {}, subscriptionFields: {}, types: [] };

  // Add action query fields to Query
  for (const [name, fieldConfig] of Object.entries(actionFields.queryFields)) {
    queryFields[name] = fieldConfig;
  }

  const queryType = new GraphQLObjectType({
    name: 'query_root',
    fields: queryFields,
  });

  // ── Step 7: Build Mutation type ────────────────────────────────────────
  const mutationFields: GraphQLFieldConfigMap<unknown, ResolverContext> = {};

  for (const table of tables) {
    if (rootFieldTables && !rootFieldTables.has(table.name)) continue;
    const key = tableKey(table.schema, table.name);
    const objectType = typeRegistry.get(key)!;
    const filterType = filterTypes.get(key);
    const mutInputs = mutationInputsByTable.get(key)!;
    const names = getRootFieldNames(table);

    // insert (batch)
    if (isOpEnabled(table, 'insert')) {
      const insertArgs: GraphQLFieldConfigArgumentMap = {
        objects: {
          type: new GraphQLNonNull(
            new GraphQLList(new GraphQLNonNull(mutInputs.insertInput)),
          ),
        },
      };
      if (mutInputs.onConflict) {
        insertArgs['onConflict'] = { type: mutInputs.onConflict };
      }

      mutationFields[names.insert] = {
        type: mutInputs.mutationResponse,
        args: insertArgs,
        resolve: makeInsertResolver(table),
        description: `Insert rows into ${table.schema}.${table.name}`,
      };
    }

    // insert_one
    if (isOpEnabled(table, 'insertOne')) {
      const insertOneArgs: GraphQLFieldConfigArgumentMap = {
        object: {
          type: new GraphQLNonNull(mutInputs.insertInput),
        },
      };
      if (mutInputs.onConflict) {
        insertOneArgs['onConflict'] = { type: mutInputs.onConflict };
      }

      mutationFields[names.insertOne] = {
        type: objectType,
        args: insertOneArgs,
        resolve: makeInsertOneResolver(table),
        description: `Insert a single row into ${table.schema}.${table.name}`,
      };
    }

    // update (batch)
    if (isOpEnabled(table, 'update')) {
      const updateArgs: GraphQLFieldConfigArgumentMap = {};
      if (filterType) {
        updateArgs['where'] = { type: new GraphQLNonNull(filterType) };
      }
      updateArgs['_set'] = { type: mutInputs.setInput };

      mutationFields[names.update] = {
        type: mutInputs.mutationResponse,
        args: updateArgs,
        resolve: makeUpdateResolver(table),
        description: `Update rows in ${table.schema}.${table.name}`,
      };
    }

    // update_by_pk
    if (isOpEnabled(table, 'updateByPk') && table.primaryKey.length > 0 && mutInputs.pkColumnsInput) {
      mutationFields[names.updateByPk] = {
        type: objectType,
        args: {
          pkColumns: { type: new GraphQLNonNull(mutInputs.pkColumnsInput) },
          _set: { type: new GraphQLNonNull(mutInputs.setInput) },
        },
        resolve: makeUpdateByPkResolver(table),
        description: `Update a single row in ${table.schema}.${table.name} by primary key`,
      };
    }

    // update_many — batch updates with different values per entry
    // Hasura returns [MutationResponse] (one result per update entry)
    if (isOpEnabled(table, 'updateMany') && mutInputs.updateManyInput) {
      mutationFields[names.updateMany] = {
        type: new GraphQLList(mutInputs.mutationResponse),
        args: {
          updates: {
            type: new GraphQLNonNull(
              new GraphQLList(new GraphQLNonNull(mutInputs.updateManyInput)),
            ),
          },
        },
        resolve: makeUpdateManyResolver(table),
        description: `Update multiple rows with different values in ${table.schema}.${table.name}`,
      };
    }

    // delete (batch)
    if (isOpEnabled(table, 'delete')) {
      const deleteArgs: GraphQLFieldConfigArgumentMap = {};
      if (filterType) {
        deleteArgs['where'] = { type: new GraphQLNonNull(filterType) };
      }

      mutationFields[names.delete] = {
        type: mutInputs.mutationResponse,
        args: deleteArgs,
        resolve: makeDeleteResolver(table),
        description: `Delete rows from ${table.schema}.${table.name}`,
      };
    }

    // delete_by_pk
    if (isOpEnabled(table, 'deleteByPk') && table.primaryKey.length > 0 && mutInputs.pkColumnsInput) {
      const pkArgs: GraphQLFieldConfigArgumentMap = {};
      for (const pkColName of table.primaryKey) {
        const column = table.columns.find((c) => c.name === pkColName);
        if (!column) continue;
        const fieldName = getColumnFieldName(table, column.name);
        const pkField = mutInputs.pkColumnsInput.getFields()[fieldName];
        if (pkField) {
          pkArgs[fieldName] = { type: pkField.type };
        }
      }

      mutationFields[names.deleteByPk] = {
        type: objectType,
        args: pkArgs,
        resolve: makeDeleteByPkResolver(table),
        description: `Delete a single row from ${table.schema}.${table.name} by primary key`,
      };
    }
  }

  // Add tracked function mutation fields to Mutation
  for (const [name, fieldConfig] of Object.entries(trackedFunctionFields.mutationFields)) {
    mutationFields[name] = fieldConfig;
  }

  // Add action mutation fields to Mutation
  for (const [name, fieldConfig] of Object.entries(actionFields.mutationFields)) {
    mutationFields[name] = fieldConfig;
  }

  const mutationType = new GraphQLObjectType({
    name: 'mutation_root',
    fields: mutationFields,
  });

  // ── Step 8: Build Subscription type ────────────────────────────────────
  const subscriptionFields: GraphQLFieldConfigMap<unknown, ResolverContext> = {};

  for (const table of tables) {
    if (rootFieldTables && !rootFieldTables.has(table.name)) continue;
    const key = tableKey(table.schema, table.name);
    const objectType = typeRegistry.get(key)!;
    const filterType = filterTypes.get(key);
    const mutInputs = mutationInputsByTable.get(key)!;
    const names = getRootFieldNames(table);

    // subscribe to select (list)
    if (isOpEnabled(table, 'select')) {
      const subSelectArgs: GraphQLFieldConfigArgumentMap = {};
      subSelectArgs['distinctOn'] = {
        type: new GraphQLList(new GraphQLNonNull(mutInputs.selectColumnEnum)),
        description: 'Distinct on columns. DISTINCT ON selects one row per unique combination of the specified columns.',
      };
      if (filterType) {
        subSelectArgs['where'] = { type: filterType };
      }
      subSelectArgs['orderBy'] = {
        type: new GraphQLList(new GraphQLNonNull(mutInputs.orderBy)),
      };
      subSelectArgs['limit'] = { type: GraphQLInt };
      subSelectArgs['offset'] = { type: GraphQLInt };

      subscriptionFields[names.select] = {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(objectType))),
        args: subSelectArgs,
        description: `Subscribe to rows from ${table.schema}.${table.name}`,
        // The resolve function returns the yielded payload as-is
        resolve: (payload: unknown) => payload,
        subscribe: makeSubscriptionSelectSubscribe(table),
      };
    }

    // subscribe to select_by_pk
    if (isOpEnabled(table, 'selectByPk') && table.primaryKey.length > 0 && mutInputs.pkColumnsInput) {
      const pkArgs: GraphQLFieldConfigArgumentMap = {};
      for (const pkColName of table.primaryKey) {
        const column = table.columns.find((c) => c.name === pkColName);
        if (!column) continue;
        const fieldName = getColumnFieldName(table, column.name);
        const pkField = mutInputs.pkColumnsInput.getFields()[fieldName];
        if (pkField) {
          pkArgs[fieldName] = { type: pkField.type };
        }
      }

      subscriptionFields[names.selectByPk] = {
        type: objectType,
        args: pkArgs,
        description: `Subscribe to a single row from ${table.schema}.${table.name} by primary key`,
        resolve: (payload: unknown) => payload,
        subscribe: makeSubscriptionSelectByPkSubscribe(table),
      };
    }

    // subscribe to select_aggregate
    const subAggArgs: GraphQLFieldConfigArgumentMap = {};
    if (filterType) {
      subAggArgs['where'] = { type: filterType };
    }
    subAggArgs['orderBy'] = {
      type: new GraphQLList(new GraphQLNonNull(mutInputs.orderBy)),
    };
    subAggArgs['limit'] = { type: GraphQLInt };
    subAggArgs['offset'] = { type: GraphQLInt };
    subAggArgs['distinctOn'] = {
      type: new GraphQLList(new GraphQLNonNull(mutInputs.selectColumnEnum)),
      description: 'Distinct on columns. DISTINCT ON selects one row per unique combination of the specified columns.',
    };

    subscriptionFields[names.selectAggregate] = {
      type: new GraphQLNonNull(mutInputs.selectAggregateFields),
      args: subAggArgs,
      description: `Subscribe to aggregate values from ${table.schema}.${table.name}`,
      resolve: (payload: unknown) => payload,
      subscribe: makeSubscriptionSelectAggregateSubscribe(table),
    };

    // subscribe to stream (cursor-based streaming)
    const streamCursorTypes = buildStreamCursorTypes(table, enumTypes, enumNames);
    const streamArgs: GraphQLFieldConfigArgumentMap = {
      batchSize: { type: new GraphQLNonNull(GraphQLInt), description: 'Maximum number of rows to return per batch.' },
      cursor: {
        type: new GraphQLNonNull(
          new GraphQLList(streamCursorTypes.streamCursorInput),
        ),
        description: 'Cursor to stream results from.',
      },
    };
    if (filterType) {
      streamArgs['where'] = { type: filterType };
    }

    subscriptionFields[names.selectStream] = {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(objectType))),
      args: streamArgs,
      description: `Stream rows from ${table.schema}.${table.name} using cursor-based streaming.`,
      resolve: (payload: unknown) => payload,
      subscribe: makeSubscriptionStreamSubscribe(table),
    };
  }

  // Add tracked function subscription fields (query-exposed functions only)
  for (const trackedFn of resolvedTrackedFunctions) {
    const { config, functionInfo: fn, returnTable } = trackedFn;
    if (!returnTable) continue;
    // Only query-exposed functions get subscriptions (not mutations)
    if (config.exposedAs === 'mutation') continue;

    const key = tableKey(returnTable.schema, returnTable.name);
    const objectType = typeRegistry.get(key);
    if (!objectType) continue;

    const fieldName = config.customRootFields?.function ?? toCamelCase(config.name);

    // Mirror the query field's args for the subscription
    const queryField = trackedFunctionFields.queryFields[fieldName];
    if (!queryField) continue;

    // List subscription
    subscriptionFields[fieldName] = {
      type: queryField.type!,
      args: queryField.args,
      description: `Subscribe to function ${config.schema}.${config.name}`,
      resolve: (payload: unknown) => payload,
      subscribe: makeTrackedFunctionSubscriptionSubscribe(trackedFn),
    };

    // Aggregate subscription for SETOF functions
    if (fn.isSetReturning) {
      const aggFieldName = config.customRootFields?.functionAggregate
        ?? `${fieldName}Aggregate`;
      const aggQueryField = trackedFunctionFields.queryFields[aggFieldName];
      if (aggQueryField) {
        subscriptionFields[aggFieldName] = {
          type: aggQueryField.type!,
          args: aggQueryField.args,
          description: `Subscribe to aggregate of function ${config.schema}.${config.name}`,
          resolve: (payload: unknown) => payload,
          subscribe: makeTrackedFunctionAggregateSubscriptionSubscribe(trackedFn),
        };
      }
    }
  }

  // Add async action result subscription fields
  for (const [name, fieldConfig] of Object.entries(actionFields.subscriptionFields)) {
    subscriptionFields[name] = fieldConfig;
  }

  // Only create subscription type if there are subscription fields
  const subscriptionType = Object.keys(subscriptionFields).length > 0
    ? new GraphQLObjectType({
        name: 'subscription_root',
        fields: subscriptionFields,
      })
    : undefined;

  // ── Step 9: Assemble schema ────────────────────────────────────────────
  return new GraphQLSchema({
    query: queryType,
    mutation: Object.keys(mutationFields).length > 0 ? mutationType : undefined,
    subscription: subscriptionType,
    // Register custom scalars so they appear in the schema
    types: [
      ...Object.values(customScalars),
      ...enumTypes.values(),
      OrderByDirection,
      CursorOrdering,
      ...nativeQueryFieldResult.outputTypes,
      // Note: action types are NOT included here because they are reachable
      // through the query/mutation field graph. Including them would cause
      // ESM/CJS dual-module issues when Mercurius rebuilds the schema via SDL.
    ],
  });
}
