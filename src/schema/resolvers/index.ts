/**
 * Resolver factory functions for GraphQL query/mutation/subscription fields.
 *
 * Each factory produces a resolver that:
 * 1. Extracts auth context (SessionVariables) from the request
 * 2. Looks up permissions for the active role
 * 3. Delegates to the SQL compiler to build a parameterized query
 * 4. Executes the query with session variable injection
 * 5. Returns the result
 *
 * This barrel module re-exports everything from the individual resolver modules
 * and the shared helpers, maintaining backward compatibility with imports from
 * the original monolithic resolvers.ts file.
 */

// Helpers (types + utility functions)
export type { ResolverContext, ResolverPermissionLookup } from './helpers.js';
export {
  permissionDenied,
  isQueryRootFieldAllowed,
  isSubscriptionRootFieldAllowed,
  camelToColumnMap,
  camelToColumnAndCFMap,
  remapKeys,
  remapBoolExp,
  remapOrderBy,
  getAllowedColumns,
  getReturningColumns,
  resolveLimit,
  NUMERIC_PG_TYPES,
  isNumericColumn,
  buildComputedFieldSelections,
  buildSetReturningComputedFieldSelections,
  remapRowToCamel,
  remapRowsToCamel,
} from './helpers.js';

// Select resolvers
export { makeSelectResolver, makeSelectByPkResolver, makeSelectAggregateResolver } from './select.js';

// Insert resolvers
export { makeInsertResolver, makeInsertOneResolver } from './insert.js';

// Update resolvers
export { makeUpdateResolver, makeUpdateByPkResolver, makeUpdateManyResolver } from './update.js';

// Delete resolvers
export { makeDeleteResolver, makeDeleteByPkResolver } from './delete.js';
