/**
 * Schema generation, CJS/ESM reconciliation, and introspection control.
 *
 * Handles the schema bridge between ESM-imported graphql and the CJS
 * graphql instance that Mercurius uses internally, plus introspection
 * blocking for disabled roles.
 */

import { createRequire } from 'node:module';
import { printSchema } from 'graphql';
import type { GraphQLSchema } from 'graphql';
import mercurius from 'mercurius';
import type { FastifyInstance } from 'fastify';

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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((esmField as any)?.subscribe) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (cjsField as any).subscribe = (esmField as any).subscribe;
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
  server.graphql.addHook('preExecution', async (_schema, document, context) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const auth = (context as any)?.auth;
    const role: string | undefined = auth?.role;
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
