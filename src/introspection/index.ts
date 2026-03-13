/**
 * PostgreSQL Introspection Module
 *
 * Public API for introspecting a PostgreSQL database and merging the
 * results with YAML configuration to produce a unified SchemaModel.
 */

export { introspectDatabase } from './introspector.js';
export type { IntrospectedTable, IntrospectionResult } from './introspector.js';

export { mergeSchemaModel } from './merger.js';
export type { MergeResult, MergeWarning } from './merger.js';

export { pgTypeToGraphQL, pgEnumToGraphQLName, getCustomScalarNames } from './type-map.js';
export type { GraphQLScalarName, GraphQLTypeName } from './type-map.js';
