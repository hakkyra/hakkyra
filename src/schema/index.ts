/**
 * GraphQL schema generation module.
 *
 * Re-exports the public API for schema generation from a SchemaModel.
 */

// Main entry point
export { generateSchema } from './generator.js';

// Custom scalars
export {
  GraphQLUUID,
  GraphQLDateTime,
  GraphQLTimestamptz,
  GraphQLDate,
  GraphQLTime,
  GraphQLJSON,
  GraphQLJSONB,
  GraphQLBigInt,
  GraphQLBigDecimal,
  GraphQLInterval,
  GraphQLBytea,
  GraphQLInet,
  customScalars,
} from './scalars.js';

// Type builder utilities
export {
  buildObjectType,
  toPascalCase,
  toCamelCase,
  getTypeName,
  tableKey,
} from './type-builder.js';
export type { TypeRegistry } from './type-builder.js';

// Filter types
export { buildFilterTypes, resetComparisonTypeCache } from './filters.js';

// Mutation input types
export {
  buildMutationInputTypes,
  OrderByDirection,
} from './inputs.js';
export type { MutationInputTypes } from './inputs.js';

// Resolver factories
export {
  makeSelectResolver,
  makeSelectByPkResolver,
  makeSelectAggregateResolver,
  makeInsertResolver,
  makeInsertOneResolver,
  makeUpdateResolver,
  makeUpdateByPkResolver,
  makeDeleteResolver,
  makeDeleteByPkResolver,
} from './resolvers.js';
export type { ResolverContext, ResolverPermissionLookup } from './resolvers.js';

// Custom queries
export {
  buildCustomQueryFields,
  resetCustomOutputTypeCache,
} from './custom-queries.js';
export type { CustomQueryFields } from './custom-queries.js';
