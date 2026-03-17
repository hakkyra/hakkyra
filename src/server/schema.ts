/**
 * Schema generation, CJS/ESM reconciliation, and introspection control.
 *
 * Handles the schema bridge between ESM-imported graphql and the CJS
 * graphql instance that Mercurius uses internally, plus introspection
 * blocking for disabled roles and role-scoped introspection filtering.
 */

import { createRequire } from 'node:module';
import { printSchema, execute } from 'graphql';
import type { GraphQLSchema, DocumentNode } from 'graphql';
import mercurius from 'mercurius';
import type { FastifyInstance } from 'fastify';
import type { HookContext } from './types.js';
import type { TableInfo, SchemaModel, HakkyraConfig } from '../types.js';
import type { PermissionLookup } from '../permissions/lookup.js';
import { filterTablesForRole } from '../docs/role-filter.js';
import { generateSchema } from '../schema/generator.js';
import { resetComparisonTypeCache } from '../schema/filters.js';

// ─── CJS/ESM schema reconciliation ──────────────────────────────────────────

/** Cached CJS graphql module (loaded once). */
let _cjsGraphql: typeof import('graphql') | undefined;

function getCjsGraphql(): typeof import('graphql') {
  if (!_cjsGraphql) {
    const _require = createRequire(import.meta.url);
    _cjsGraphql = _require('graphql') as typeof import('graphql');
  }
  return _cjsGraphql;
}

/**
 * Work around ESM/CJS dual-package hazard: Mercurius does require('graphql')
 * which may create a different module instance than our ESM import, causing
 * instanceof GraphQLSchema to fail. We rebuild the schema using the CJS
 * graphql instance that Mercurius will use, and copy our resolvers over.
 */
export function buildCjsSchema(esmSchema: GraphQLSchema): GraphQLSchema {
  const cjsGraphql = getCjsGraphql();
  const sdl = printSchema(esmSchema);
  const cjsSchema = cjsGraphql.buildSchema(sdl);

  copyEsmToCjs(esmSchema, cjsSchema);
  applyStringCoercion(cjsSchema, cjsGraphql);

  return cjsSchema;
}

/**
 * Copy resolvers, subscribe functions, scalar methods, and enum values
 * from an ESM-built schema to a CJS-built schema.
 */
function copyEsmToCjs(esmSchema: GraphQLSchema, cjsSchema: GraphQLSchema): void {
  const esmTypeMap = esmSchema.getTypeMap();
  const cjsTypeMap = cjsSchema.getTypeMap();

  for (const [typeName, cjsType] of Object.entries(cjsTypeMap)) {
    const esmType = esmTypeMap[typeName];
    if (!esmType) continue;

    // Copy field resolvers and subscribe functions for object types
    if ('getFields' in cjsType && 'getFields' in esmType) {
      const cjsFields = (cjsType as import('graphql').GraphQLObjectType).getFields();
      const esmFields = (esmType as import('graphql').GraphQLObjectType).getFields();
      for (const [fieldName, cjsField] of Object.entries(cjsFields)) {
        const esmField = esmFields[fieldName];
        if (esmField?.resolve) {
          cjsField.resolve = esmField.resolve as typeof cjsField.resolve;
        }
        if (esmField?.subscribe) {
          cjsField.subscribe = esmField.subscribe as typeof cjsField.subscribe;
        }
      }
    }

    // Copy serialize/parseValue/parseLiteral for custom scalars
    if ('serialize' in cjsType && 'serialize' in esmType) {
      const cjsScalar = cjsType as import('graphql').GraphQLScalarType;
      const esmScalar = esmType as import('graphql').GraphQLScalarType;
      cjsScalar.serialize = esmScalar.serialize as typeof cjsScalar.serialize;
      cjsScalar.parseValue = esmScalar.parseValue as typeof cjsScalar.parseValue;
      cjsScalar.parseLiteral = esmScalar.parseLiteral as typeof cjsScalar.parseLiteral;
    }

    // Copy enum internal values (buildSchema loses value mappings from SDL)
    if ('getValues' in cjsType && 'getValues' in esmType) {
      const cjsEnum = cjsType as import('graphql').GraphQLEnumType;
      const esmEnum = esmType as import('graphql').GraphQLEnumType;
      const esmValues = esmEnum.getValues();
      const cjsValues = cjsEnum.getValues();
      for (const cjsVal of cjsValues) {
        const esmVal = esmValues.find(v => v.name === cjsVal.name);
        if (esmVal && esmVal.value !== cjsVal.value) {
          cjsVal.value = esmVal.value;
        }
      }
    }
  }
}

/**
 * Hasura compatibility: coerce numeric literals to String-typed arguments.
 * (Hasura accepts e.g. `playerid: 213` for String args)
 */
function applyStringCoercion(
  cjsSchema: GraphQLSchema,
  cjsGraphql: typeof import('graphql'),
): void {
  const cjsTypeMap = cjsSchema.getTypeMap();
  const cjsStringScalar = cjsTypeMap['String'] as import('graphql').GraphQLScalarType | undefined;
  if (!cjsStringScalar) return;

  const { Kind: CjsKind } = cjsGraphql;
  cjsStringScalar.parseLiteral = (ast) => {
    if (ast.kind === CjsKind.STRING) return ast.value;
    if (ast.kind === CjsKind.INT || ast.kind === CjsKind.FLOAT) return (ast as { value: string }).value;
    throw new cjsGraphql.GraphQLError(
      `String cannot represent a non string value: ${(ast as { value?: string }).value ?? ast.kind}`,
    );
  };
  const origParseValue = cjsStringScalar.parseValue.bind(cjsStringScalar);
  cjsStringScalar.parseValue = (value: unknown) => {
    if (typeof value === 'number') return String(value);
    return origParseValue(value);
  };
}

// ─── Introspection control ───────────────────────────────────────────────────

/**
 * Register a Mercurius preExecution hook that blocks introspection queries
 * for specified roles.
 */
export function registerIntrospectionControl(
  server: FastifyInstance,
  disabledForRoles: string[],
): void {
  if (disabledForRoles.length === 0) return;

  const disabledRoles = new Set(disabledForRoles);
  server.graphql.addHook<HookContext>('preExecution', async (_schema, document, context) => {
    const role = context.auth?.role;
    if (role && disabledRoles.has(role)) {
      for (const definition of document.definitions) {
        if (definition.kind === 'OperationDefinition' && definition.selectionSet) {
          for (const selection of definition.selectionSet.selections) {
            if (
              selection.kind === 'Field' &&
              (selection.name.value === '__schema' || selection.name.value === '__type')
            ) {
              throw new mercurius.ErrorWithProps(
                'GraphQL introspection is not allowed for the current role',
                { code: 'INTROSPECTION_DISABLED' },
                400,
              );
            }
          }
        }
      }
    }
  });
}

// ─── Role-scoped introspection (P12.22) ──────────────────────────────────────

/**
 * Check if a GraphQL document is an introspection query
 * (contains __schema or __type root fields).
 */
function isIntrospectionQuery(document: DocumentNode): boolean {
  for (const definition of document.definitions) {
    if (definition.kind === 'OperationDefinition' && definition.selectionSet) {
      for (const selection of definition.selectionSet.selections) {
        if (
          selection.kind === 'Field' &&
          (selection.name.value === '__schema' || selection.name.value === '__type')
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Expand tables to include all transitively referenced relationship targets.
 * This ensures the role schema can resolve relationship types even for
 * tables the role doesn't have direct root-field access to.
 */
function expandTablesWithRelationships(
  filteredTables: TableInfo[],
  allTables: TableInfo[],
): TableInfo[] {
  const includedNames = new Set(filteredTables.map(t => t.name));
  const expandedTables = [...filteredTables];
  const queue = [...filteredTables];
  while (queue.length > 0) {
    const t = queue.pop()!;
    for (const rel of t.relationships) {
      if (!includedNames.has(rel.remoteTable.name)) {
        const remoteTable = allTables.find(
          at => at.name === rel.remoteTable.name && at.schema === rel.remoteTable.schema,
        );
        if (remoteTable) {
          expandedTables.push(remoteTable);
          includedNames.add(remoteTable.name);
          queue.push(remoteTable);
        }
      }
    }
  }
  return expandedTables;
}

export interface RoleScopedIntrospectionDeps {
  server: FastifyInstance;
  schemaModel: SchemaModel;
  config: HakkyraConfig;
  permissionLookup: PermissionLookup;
}

/**
 * Register Mercurius hooks that scope GraphQL introspection results by role.
 *
 * For admin requests, the full schema is returned. For non-admin roles,
 * introspection queries are re-executed against a cached per-role schema
 * that only contains types/fields accessible to that role.
 *
 * Returns the role schema cache (for invalidation on hot reload).
 */
export function registerRoleScopedIntrospection(
  deps: RoleScopedIntrospectionDeps,
): Map<string, GraphQLSchema> {
  const { server, schemaModel, config, permissionLookup } = deps;
  const allTables = schemaModel.tables;
  const roleSchemaCache = new Map<string, GraphQLSchema>();

  function getOrBuildRoleSchema(role: string): GraphQLSchema | null {
    const cached = roleSchemaCache.get(role);
    if (cached) return cached;

    const { tables } = filterTablesForRole(allTables, role, permissionLookup, false);
    if (tables.length === 0) return null;

    const expandedTables = expandTablesWithRelationships(tables, allTables);
    const filteredModel: SchemaModel = { ...schemaModel, tables: expandedTables };
    const rootFieldTables = new Set(tables.map(t => t.name));

    try {
      resetComparisonTypeCache();
      const esmSchema = generateSchema(filteredModel, {
        actions: config.actions,
        actionsGraphql: config.actionsGraphql,
        trackedFunctions: config.trackedFunctions,
        rootFieldTables,
      });
      // Keep the ESM schema — we execute introspection using the ESM graphql
      // `execute()` function, which avoids the CJS/ESM instanceof mismatch
      // that Mercurius triggers with its CJS graphql instance.
      roleSchemaCache.set(role, esmSchema);
      return esmSchema;
    } catch (err) {
      server.log.warn({ err, role }, 'Failed to build role-scoped schema for introspection');
      return null;
    }
  }

  // preExecution: detect introspection queries from non-admin roles and
  // store the document on the context for the onResolution hook.
  // Also handles admin + x-hasura-role override (treat as the overridden role).
  server.graphql.addHook<HookContext>('preExecution', async (_schema, document, context) => {
    if (!isIntrospectionQuery(document)) return;

    const isAdmin = context.auth?.isAdmin;
    // Check for admin + role override: admin key with x-hasura-role header
    const roleHeader = context.clientHeaders?.['x-hasura-role'];
    const hasRoleOverride = isAdmin && roleHeader && roleHeader.toLowerCase() !== 'admin';

    // Pure admin (no role override) gets the full schema
    if (isAdmin && !hasRoleOverride) return;

    // Store document for re-execution in onResolution
    context._introspectionDocument = document;
  });

  // onResolution: re-execute introspection against the role-scoped schema.
  server.graphql.addHook<Record<string, unknown>, HookContext>(
    'onResolution',
    async (execution, context) => {
      const document = context._introspectionDocument;
      if (!document) return;

      // Resolve the effective role (handles admin + x-hasura-role override)
      const roleHeader = context.clientHeaders?.['x-hasura-role'];
      const isAdmin = context.auth?.isAdmin;
      const role = (isAdmin && roleHeader && roleHeader.toLowerCase() !== 'admin')
        ? roleHeader.toLowerCase()
        : context.auth?.role;
      if (!role) return;

      const roleSchema = getOrBuildRoleSchema(role);
      if (!roleSchema) {
        // No accessible types — return empty introspection
        execution.data = {};
        return;
      }

      // Re-execute the introspection query against the role-scoped ESM schema
      // using the ESM graphql execute(). This avoids the CJS/ESM instanceof
      // mismatch that causes "Cannot use GraphQLObjectType from another module"
      // errors when Mercurius introspects the CJS-bridged schema.
      // The document AST from Mercurius is CJS-parsed but AST nodes are plain
      // objects compatible with the ESM execute().
      const result = await execute({ schema: roleSchema, document });
      execution.data = (result.data ?? {}) as Record<string, unknown>;
      // Replace errors with those from the role-scoped execution (if any)
      execution.errors = result.errors as typeof execution.errors ?? [];
    },
  );

  return roleSchemaCache;
}
