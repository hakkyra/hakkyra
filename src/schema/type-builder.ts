/**
 * Builds GraphQLObjectType instances from TableInfo definitions.
 *
 * Handles:
 * - Column → field mapping with correct GraphQL types
 * - Object relationships (→ nullable related type)
 * - Array relationships (→ [RelatedType!] with where/orderBy/limit args)
 * - Circular reference resolution via TypeRegistry thunks
 * - PascalCase type names, camelCase field names
 */

import {
  GraphQLObjectType,
  GraphQLString,
  GraphQLInt,
  GraphQLFloat,
  GraphQLBoolean,
  GraphQLNonNull,
  GraphQLList,
  GraphQLEnumType,
  GraphQLInputObjectType,
} from 'graphql';
import type {
  GraphQLOutputType,
  GraphQLFieldConfigMap,
  GraphQLFieldConfigArgumentMap,
  GraphQLScalarType,
  GraphQLInputType,
} from 'graphql';
import type { TableInfo, ColumnInfo, FunctionInfo, ComputedFieldConfig } from '../types.js';
import { pgTypeToGraphQL } from '../introspection/type-map.js';
import { customScalars } from './scalars.js';
import { pgArgTypeToGraphQL } from './tracked-functions.js';
import { toCamelCase, toPascalCase } from '../shared/naming.js';

// Re-export naming utilities so existing consumers don't break
export { toCamelCase, toPascalCase } from '../shared/naming.js';

// ─── Type Registry ───────────────────────────────────────────────────────────

/**
 * A shared registry of all GraphQL object types, keyed by fully-qualified
 * table name ("schema.table"). Allows type-builder and filters to look up
 * types for relationships and avoids duplicates.
 */
export type TypeRegistry = Map<string, GraphQLObjectType>;

/**
 * Derive the GraphQL field name for a column.
 * Uses customColumnNames if available, otherwise falls back to toCamelCase.
 */
export function getColumnFieldName(table: TableInfo, columnName: string): string {
  return table.customColumnNames?.[columnName] ?? toCamelCase(columnName);
}

/**
 * Derive the GraphQL type name for a table.
 * Uses the alias if available, otherwise falls back to the table name.
 */
export function getTypeName(table: TableInfo): string {
  const base = table.alias ?? table.name;
  return toPascalCase(base);
}

/**
 * Fully-qualified table key for the registry: "schema.table"
 */
export function tableKey(schema: string, name: string): string {
  return `${schema}.${name}`;
}

// ─── GraphQL Type Resolution ────────────────────────────────────────────────

/** Built-in GraphQL scalars by name */
const BUILTIN_SCALARS: Record<string, GraphQLScalarType> = {
  Int: GraphQLInt as unknown as GraphQLScalarType,
  Float: GraphQLFloat as unknown as GraphQLScalarType,
  String: GraphQLString as unknown as GraphQLScalarType,
  Boolean: GraphQLBoolean as unknown as GraphQLScalarType,
};

/**
 * Resolve a GraphQL type name string (from pgTypeToGraphQL) to an actual
 * GraphQLOutputType, taking nullability and list wrapping into account.
 */
function resolveScalarType(
  graphqlName: string,
  isList: boolean,
  enumTypes: Map<string, GraphQLEnumType>,
): GraphQLOutputType {
  // Check built-in scalars
  const builtin = BUILTIN_SCALARS[graphqlName];
  if (builtin) {
    if (isList) {
      return new GraphQLList(new GraphQLNonNull(builtin));
    }
    return builtin;
  }

  // Check enums
  const enumType = enumTypes.get(graphqlName);
  if (enumType) {
    if (isList) {
      return new GraphQLList(new GraphQLNonNull(enumType));
    }
    return enumType;
  }

  // Check custom scalars
  const custom = customScalars[graphqlName];
  if (custom) {
    if (isList) {
      return new GraphQLList(new GraphQLNonNull(custom));
    }
    return custom;
  }

  // Fallback to String
  if (isList) {
    return new GraphQLList(new GraphQLNonNull(GraphQLString as unknown as GraphQLScalarType));
  }
  return GraphQLString as unknown as GraphQLScalarType;
}

/**
 * Map a single column to its GraphQL output type (without NonNull wrapping —
 * that is applied based on isNullable/hasDefault at the field level).
 */
export function columnToGraphQLType(
  column: ColumnInfo,
  enumTypes: Map<string, GraphQLEnumType>,
  enumNames?: Set<string>,
): GraphQLOutputType {
  const mapping = pgTypeToGraphQL(column.udtName, column.isArray, enumNames);
  return resolveScalarType(mapping.name, mapping.isList, enumTypes);
}

// ─── Object Type Builder ────────────────────────────────────────────────────

/**
 * Build a GraphQLObjectType for a table.
 *
 * Uses thunks (lazy field resolution) for all field configs to handle
 * circular references between types (e.g., User → Post → User).
 *
 * @param table         The introspected table information
 * @param typeRegistry  Shared registry for looking up related types
 * @param enumTypes     Map of GraphQL enum type name → GraphQLEnumType
 * @param enumNames     Set of PG enum type names (for column type resolution)
 * @param filterTypes   Map of table key → BoolExp input type (for where args on array rels)
 * @param orderByTypes  Map of table key → OrderBy input type (for orderBy args on array rels)
 * @param functions     List of introspected PG functions (for computed field return type resolution)
 * @param aggregateTypes Map of table key → {Table}Aggregate object type (for {rel}Aggregate fields)
 */
export function buildObjectType(
  table: TableInfo,
  typeRegistry: TypeRegistry,
  enumTypes: Map<string, GraphQLEnumType>,
  enumNames: Set<string>,
  filterTypes?: Map<string, GraphQLInputObjectType>,
  orderByTypes?: Map<string, GraphQLInputObjectType>,
  functions?: FunctionInfo[],
  aggregateTypes?: Map<string, GraphQLObjectType>,
): GraphQLObjectType {
  const typeName = getTypeName(table);

  const objectType = new GraphQLObjectType({
    name: typeName,
    description: table.comment ?? `Auto-generated type for ${table.schema}.${table.name}`,
    fields: () => {
      const fields: GraphQLFieldConfigMap<unknown, unknown> = {};

      // ── Column fields ────────────────────────────────────────────────
      for (const column of table.columns) {
        const fieldName = getColumnFieldName(table, column.name);
        let fieldType = columnToGraphQLType(column, enumTypes, enumNames);

        // Non-nullable columns that aren't primary keys with defaults
        // are wrapped in GraphQLNonNull
        if (!column.isNullable) {
          fieldType = new GraphQLNonNull(fieldType);
        }

        // Add path argument for JSONB/JSON scalar columns
        const fieldArgs: GraphQLFieldConfigArgumentMap | undefined =
          !column.isArray && (column.udtName === 'jsonb' || column.udtName === 'json')
            ? { path: { type: GraphQLString, description: 'JSON select path' } }
            : undefined;

        fields[fieldName] = {
          type: fieldType,
          description: column.comment,
          // Store the original PG column name for the SQL compiler
          extensions: { pgColumnName: column.name },
          ...(fieldArgs ? { args: fieldArgs } : {}),
        };
      }

      // ── Relationship fields ──────────────────────────────────────────
      for (const rel of table.relationships) {
        const relKey = tableKey(rel.remoteTable.schema, rel.remoteTable.name);
        const relatedType = typeRegistry.get(relKey);

        if (!relatedType) {
          // Related type not tracked — skip this relationship
          continue;
        }

        if (rel.type === 'object') {
          // Object relationship — nullable single related object
          fields[toCamelCase(rel.name)] = {
            type: relatedType,
            description: `Object relationship to ${rel.remoteTable.name}`,
            extensions: {
              isRelationship: true,
              relationshipType: 'object',
              remoteTable: rel.remoteTable,
              localColumns: rel.localColumns,
              remoteColumns: rel.remoteColumns,
              columnMapping: rel.columnMapping,
            },
          };
        } else {
          // Array relationship — [RelatedType!] with optional filtering/ordering
          const args: GraphQLFieldConfigArgumentMap = {};

          // where argument
          const relFilterType = filterTypes?.get(relKey);
          if (relFilterType) {
            args['where'] = { type: relFilterType };
          }

          // orderBy argument
          const relOrderByType = orderByTypes?.get(relKey);
          if (relOrderByType) {
            args['orderBy'] = {
              type: new GraphQLList(new GraphQLNonNull(relOrderByType)),
            };
          }

          // limit / offset arguments
          args['limit'] = { type: GraphQLInt };
          args['offset'] = { type: GraphQLInt };

          fields[toCamelCase(rel.name)] = {
            type: new GraphQLNonNull(
              new GraphQLList(new GraphQLNonNull(relatedType)),
            ),
            args,
            description: `Array relationship to ${rel.remoteTable.name}`,
            extensions: {
              isRelationship: true,
              relationshipType: 'array',
              remoteTable: rel.remoteTable,
              localColumns: rel.localColumns,
              remoteColumns: rel.remoteColumns,
              columnMapping: rel.columnMapping,
            },
          };

          // {rel}Aggregate field — aggregate the related table scoped to the parent row
          const aggType = aggregateTypes?.get(relKey);
          if (aggType) {
            const aggArgs: GraphQLFieldConfigArgumentMap = {};

            // where argument
            if (relFilterType) {
              aggArgs['where'] = { type: relFilterType };
            }

            fields[`${toCamelCase(rel.name)}Aggregate`] = {
              type: new GraphQLNonNull(aggType),
              args: aggArgs,
              description: `Aggregated array relationship to ${rel.remoteTable.name}`,
              extensions: {
                isAggregateRelationship: true,
                relationshipType: 'array',
                remoteTable: rel.remoteTable,
                localColumns: rel.localColumns,
                remoteColumns: rel.remoteColumns,
                columnMapping: rel.columnMapping,
                relationshipName: rel.name,
              },
            };
          }
        }
      }

      // ── Computed fields ─────────────────────────────────────────────
      if (table.computedFields && functions) {
        for (const cf of table.computedFields) {
          const fieldName = toCamelCase(cf.name);

          // Look up the PG function to determine the return type
          const fn = functions.find(
            (f) => f.name === cf.function.name && f.schema === (cf.function.schema ?? 'public'),
          );
          if (!fn) {
            console.warn(
              `[hakkyra:schema] Computed field "${cf.name}" on ${table.schema}.${table.name}: ` +
              `function ${cf.function.schema ?? 'public'}.${cf.function.name} not found in introspection — skipping`,
            );
            continue;
          }

          if (fn.isSetReturning) {
            // Set-returning computed field — look up return type as a tracked table
            const fnSchema = cf.function.schema ?? 'public';
            let returnTableKey: string | undefined;

            // Try same schema as the function first
            const sameSchemaKey = tableKey(fnSchema, fn.returnType);
            if (typeRegistry.has(sameSchemaKey)) {
              returnTableKey = sameSchemaKey;
            } else {
              // Search all tracked tables for a name match
              for (const key of typeRegistry.keys()) {
                if (key.endsWith(`.${fn.returnType}`)) {
                  returnTableKey = key;
                  break;
                }
              }
            }

            if (!returnTableKey) {
              console.warn(
                `[hakkyra:schema] Computed field "${cf.name}" on ${table.schema}.${table.name}: ` +
                `return table "${fn.returnType}" for set-returning function not tracked — skipping`,
              );
              continue;
            }

            const returnTableType = typeRegistry.get(returnTableKey)!;

            // Build array-like arguments (where, orderBy, limit, offset)
            const args: GraphQLFieldConfigArgumentMap = {};

            const relFilterType = filterTypes?.get(returnTableKey);
            if (relFilterType) {
              args['where'] = { type: relFilterType };
            }

            const relOrderByType = orderByTypes?.get(returnTableKey);
            if (relOrderByType) {
              args['orderBy'] = {
                type: new GraphQLList(new GraphQLNonNull(relOrderByType)),
              };
            }

            args['limit'] = { type: GraphQLInt };
            args['offset'] = { type: GraphQLInt };

            fields[fieldName] = {
              type: new GraphQLNonNull(
                new GraphQLList(new GraphQLNonNull(returnTableType)),
              ),
              args,
              description: cf.comment ?? `Computed field (set-returning) from ${cf.function.schema ?? 'public'}.${cf.function.name}`,
              extensions: {
                isComputedField: true,
                isSetReturning: true,
                computedFieldConfig: cf,
                functionInfo: fn,
                returnTableKey,
              },
            };
          } else {
            // Non-set-returning — check if return type is a tracked table (composite return)
            const fnSchema = cf.function.schema ?? 'public';
            let returnTableKey: string | undefined;

            const sameSchemaKey = tableKey(fnSchema, fn.returnType);
            if (typeRegistry.has(sameSchemaKey)) {
              returnTableKey = sameSchemaKey;
            } else {
              for (const key of typeRegistry.keys()) {
                if (key.endsWith(`.${fn.returnType}`)) {
                  returnTableKey = key;
                  break;
                }
              }
            }

            if (returnTableKey) {
              // Returns a tracked table type — treat like set-returning for schema purposes
              const returnTableType = typeRegistry.get(returnTableKey)!;

              const args: GraphQLFieldConfigArgumentMap = {};

              const relFilterType = filterTypes?.get(returnTableKey);
              if (relFilterType) {
                args['where'] = { type: relFilterType };
              }

              const relOrderByType = orderByTypes?.get(returnTableKey);
              if (relOrderByType) {
                args['orderBy'] = {
                  type: new GraphQLList(new GraphQLNonNull(relOrderByType)),
                };
              }

              args['limit'] = { type: GraphQLInt };
              args['offset'] = { type: GraphQLInt };

              fields[fieldName] = {
                type: new GraphQLNonNull(
                  new GraphQLList(new GraphQLNonNull(returnTableType)),
                ),
                args,
                description: cf.comment ?? `Computed field from ${cf.function.schema ?? 'public'}.${cf.function.name}`,
                extensions: {
                  isComputedField: true,
                  isSetReturning: true,
                  computedFieldConfig: cf,
                  functionInfo: fn,
                  returnTableKey,
                },
              };
            } else {
              // Scalar computed field — map PG return type to a GraphQL scalar
              const mapping = pgTypeToGraphQL(fn.returnType, false, enumNames);
              const fieldType = resolveScalarType(mapping.name, mapping.isList, enumTypes);

              // Check for extra user arguments (beyond the table row and session arg)
              const cfArgs: GraphQLFieldConfigArgumentMap = {};
              if (fn.argNames.length > 1) {
                // Identify which args are user-facing (not table row, not session)
                const tableArgName = cf.tableArgument;
                const sessionArgName = cf.sessionArgument;
                const userArgs: Array<{ name: string; pgType: string }> = [];
                for (let i = 0; i < fn.argNames.length; i++) {
                  const argName = fn.argNames[i];
                  if (argName === tableArgName) continue;
                  if (sessionArgName && argName === sessionArgName) continue;
                  userArgs.push({ name: argName, pgType: fn.argTypes[i] });
                }
                if (userArgs.length > 0) {
                  // Build an args input type like tracked functions do
                  const argsFields: Record<string, { type: GraphQLInputType }> = {};
                  for (const ua of userArgs) {
                    argsFields[toCamelCase(ua.name)] = {
                      type: pgArgTypeToGraphQL(ua.pgType),
                    };
                  }
                  const argsInputType = new GraphQLInputObjectType({
                    name: `${toPascalCase(cf.name)}Args`,
                    fields: argsFields,
                  });
                  cfArgs['args'] = { type: argsInputType };
                }
              }

              fields[fieldName] = {
                type: fieldType,
                description: cf.comment ?? `Computed field from ${cf.function.schema ?? 'public'}.${cf.function.name}`,
                extensions: {
                  isComputedField: true,
                  computedFieldConfig: cf,
                  functionInfo: fn,
                },
                ...(Object.keys(cfArgs).length > 0 ? { args: cfArgs } : {}),
              };
            }
          }
        }
      }

      return fields;
    },
  });

  return objectType;
}
