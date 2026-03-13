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
 * 8. Build Subscription type with select / selectByPk fields
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
import type { SchemaModel, TableInfo, EnumInfo, ActionConfig } from '../types.js';
import { buildActionFields } from '../actions/schema.js';
import { pgEnumToGraphQLName } from '../introspection/type-map.js';
import { customScalars } from './scalars.js';
import {
  buildObjectType,
  getTypeName,
  toCamelCase,
  tableKey,
} from './type-builder.js';
import type { TypeRegistry } from './type-builder.js';
import { buildFilterTypes } from './filters.js';
import { buildMutationInputTypes, OrderByDirection } from './inputs.js';
import type { MutationInputTypes } from './inputs.js';
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
} from './resolvers.js';
import type { ResolverContext } from './resolvers.js';
import {
  makeSubscriptionSelectSubscribe,
  makeSubscriptionSelectByPkSubscribe,
} from './subscription-resolvers.js';
import { buildCustomQueryFields } from './custom-queries.js';

// ─── Root Field Naming ──────────────────────────────────────────────────────

/**
 * Derive root field names for a table, respecting customRootFields overrides.
 */
interface RootFieldNames {
  select: string;
  selectByPk: string;
  selectAggregate: string;
  insert: string;
  insertOne: string;
  update: string;
  updateByPk: string;
  updateMany: string;
  delete: string;
  deleteByPk: string;
}

function getRootFieldNames(table: TableInfo): RootFieldNames {
  const base = toCamelCase(table.alias ?? table.name);
  const typeName = getTypeName(table);
  const custom = table.customRootFields;

  return {
    select: custom?.select ?? base,
    selectByPk: custom?.select_by_pk ?? `${base}ByPk`,
    selectAggregate: custom?.select_aggregate ?? `${base}Aggregate`,
    insert: custom?.insert ?? `insert${typeName}`,
    insertOne: custom?.insert_one ?? `insert${typeName}One`,
    update: custom?.update ?? `update${typeName}`,
    updateByPk: custom?.update_by_pk ?? `update${typeName}ByPk`,
    updateMany: `update${typeName}Many`,
    delete: custom?.delete ?? `delete${typeName}`,
    deleteByPk: custom?.delete_by_pk ?? `delete${typeName}ByPk`,
  };
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
}

export function generateSchema(model: SchemaModel, options?: GenerateSchemaOptions): GraphQLSchema {
  const { tables, enums, functions, customQueries } = model;

  // ── Step 1: Initialize registries ──────────────────────────────────────
  const typeRegistry: TypeRegistry = new Map();
  const enumTypes = buildEnumTypes(enums);
  const enumNames = new Set(enums.map((e) => e.name));

  // ── Step 2: Build filter types (needed by object types for array rel args)
  const filterTypes = buildFilterTypes(tables, typeRegistry, enumTypes, enumNames);

  // ── Step 3: Build OrderBy types for each table (needed by array rel args)
  const orderByTypes = new Map<string, GraphQLInputObjectType>();

  // ── Step 4: Build GraphQLObjectType for each table ─────────────────────
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
    );
    typeRegistry.set(key, objectType);
  }

  // ── Step 5: Build mutation input types for each table ──────────────────
  const mutationInputsByTable = new Map<string, MutationInputTypes>();

  for (const table of tables) {
    const key = tableKey(table.schema, table.name);
    const objectType = typeRegistry.get(key)!;
    const filterType = filterTypes.get(key);
    const mutInputs = buildMutationInputTypes(table, objectType, enumTypes, enumNames, filterType);
    mutationInputsByTable.set(key, mutInputs);
    // Register orderBy types for use in array relationship args
    orderByTypes.set(key, mutInputs.orderBy);
  }

  // ── Step 5b: Build custom query fields ──────────────────────────────────
  const customFields = buildCustomQueryFields(
    customQueries ?? [],
    typeRegistry,
    tables,
  );

  // ── Step 6: Build Query type ───────────────────────────────────────────
  const queryFields: GraphQLFieldConfigMap<unknown, ResolverContext> = {};

  for (const table of tables) {
    const key = tableKey(table.schema, table.name);
    const objectType = typeRegistry.get(key)!;
    const filterType = filterTypes.get(key);
    const mutInputs = mutationInputsByTable.get(key)!;
    const names = getRootFieldNames(table);

    // select (list)
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

    // select_by_pk
    if (table.primaryKey.length > 0 && mutInputs.pkColumnsInput) {
      const pkArgs: GraphQLFieldConfigArgumentMap = {};
      for (const pkColName of table.primaryKey) {
        const column = table.columns.find((c) => c.name === pkColName);
        if (!column) continue;
        const fieldName = toCamelCase(column.name);
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
    const aggArgs: GraphQLFieldConfigArgumentMap = {};
    if (filterType) {
      aggArgs['where'] = { type: filterType };
    }
    aggArgs['orderBy'] = {
      type: new GraphQLList(new GraphQLNonNull(mutInputs.orderBy)),
    };
    aggArgs['limit'] = { type: GraphQLInt };
    aggArgs['offset'] = { type: GraphQLInt };
    aggArgs['groupBy'] = {
      type: new GraphQLList(new GraphQLNonNull(mutInputs.selectColumnEnum)),
      description: 'Group results by columns. When used, populates the groupedAggregates field.',
    };

    queryFields[names.selectAggregate] = {
      type: new GraphQLNonNull(mutInputs.selectAggregateFields),
      args: aggArgs,
      resolve: makeSelectAggregateResolver(table),
      description: `Aggregate rows from ${table.schema}.${table.name}`,
    };
  }

  // Add custom query fields to Query
  for (const [name, fieldConfig] of Object.entries(customFields.queryFields)) {
    queryFields[name] = fieldConfig;
  }

  // ── Step 5c: Build action fields ────────────────────────────────────────
  const actionFields = (options?.actions?.length && options?.actionsGraphql)
    ? buildActionFields(options.actions, options.actionsGraphql, {
        tables,
        tableTypeRegistry: typeRegistry,
      })
    : { queryFields: {}, mutationFields: {}, types: [] };

  // Add action query fields to Query
  for (const [name, fieldConfig] of Object.entries(actionFields.queryFields)) {
    queryFields[name] = fieldConfig;
  }

  const queryType = new GraphQLObjectType({
    name: 'Query',
    fields: queryFields,
  });

  // ── Step 7: Build Mutation type ────────────────────────────────────────
  const mutationFields: GraphQLFieldConfigMap<unknown, ResolverContext> = {};

  for (const table of tables) {
    const key = tableKey(table.schema, table.name);
    const objectType = typeRegistry.get(key)!;
    const filterType = filterTypes.get(key);
    const mutInputs = mutationInputsByTable.get(key)!;
    const names = getRootFieldNames(table);

    // insert (batch)
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

    // insert_one
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

    // update (batch)
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

    // update_by_pk
    if (table.primaryKey.length > 0 && mutInputs.pkColumnsInput) {
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
    if (mutInputs.updateManyInput) {
      mutationFields[names.updateMany] = {
        type: mutInputs.mutationResponse,
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

    // delete_by_pk
    if (table.primaryKey.length > 0 && mutInputs.pkColumnsInput) {
      const pkArgs: GraphQLFieldConfigArgumentMap = {};
      for (const pkColName of table.primaryKey) {
        const column = table.columns.find((c) => c.name === pkColName);
        if (!column) continue;
        const fieldName = toCamelCase(column.name);
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

  // Add custom mutation fields to Mutation
  for (const [name, fieldConfig] of Object.entries(customFields.mutationFields)) {
    mutationFields[name] = fieldConfig;
  }

  // Add action mutation fields to Mutation
  for (const [name, fieldConfig] of Object.entries(actionFields.mutationFields)) {
    mutationFields[name] = fieldConfig;
  }

  const mutationType = new GraphQLObjectType({
    name: 'Mutation',
    fields: mutationFields,
  });

  // ── Step 8: Build Subscription type ────────────────────────────────────
  const subscriptionFields: GraphQLFieldConfigMap<unknown, ResolverContext> = {};

  for (const table of tables) {
    const key = tableKey(table.schema, table.name);
    const objectType = typeRegistry.get(key)!;
    const filterType = filterTypes.get(key);
    const mutInputs = mutationInputsByTable.get(key)!;
    const names = getRootFieldNames(table);

    // subscribe to select (list)
    const subSelectArgs: GraphQLFieldConfigArgumentMap = {};
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

    // subscribe to select_by_pk
    if (table.primaryKey.length > 0 && mutInputs.pkColumnsInput) {
      const pkArgs: GraphQLFieldConfigArgumentMap = {};
      for (const pkColName of table.primaryKey) {
        const column = table.columns.find((c) => c.name === pkColName);
        if (!column) continue;
        const fieldName = toCamelCase(column.name);
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
  }

  // Only create subscription type if there are subscription fields
  const subscriptionType = Object.keys(subscriptionFields).length > 0
    ? new GraphQLObjectType({
        name: 'Subscription',
        fields: subscriptionFields,
      })
    : undefined;

  // ── Step 9: Assemble schema ────────────────────────────────────────────
  return new GraphQLSchema({
    query: queryType,
    mutation: Object.keys(mutationFields).length > 0 ? mutationType : undefined,
    subscription: subscriptionType,
    // Register custom scalars + custom query output types so they appear in the schema
    types: [
      ...Object.values(customScalars),
      ...enumTypes.values(),
      OrderByDirection,
      ...customFields.outputTypes,
      // Note: action types are NOT included here because they are reachable
      // through the query/mutation field graph. Including them would cause
      // ESM/CJS dual-module issues when Mercurius rebuilds the schema via SDL.
    ],
  });
}
