/**
 * GraphQL SDL (Schema Definition Language) export.
 *
 * Generates a complete SDL string from the GraphQL schema, including
 * type descriptions and deprecation notices.
 */

import { type GraphQLSchema, printSchema } from 'graphql';

/**
 * Generate a GraphQL SDL string from the schema.
 *
 * Uses graphql-js's `printSchema` which outputs a complete SDL
 * with type definitions, field descriptions, and directives.
 */
export function generateGraphQLSDL(schema: GraphQLSchema): string {
  return printSchema(schema);
}
