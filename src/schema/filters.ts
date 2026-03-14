/**
 * Generates BoolExp filter input types for each table.
 *
 * Each table gets a `<Type>BoolExp` input that supports:
 * - Per-column comparison operators (type-specific)
 * - _and / _or / _not logical combinators
 * - Relationship traversal filters
 */

import {
  GraphQLInputObjectType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLString,
  GraphQLInt,
  GraphQLFloat,
  GraphQLBoolean,
  GraphQLEnumType,
} from 'graphql';
import type { GraphQLInputType, GraphQLScalarType } from 'graphql';
import type { TableInfo, ColumnInfo } from '../types.js';
import { pgTypeToGraphQL } from '../introspection/type-map.js';
import { customScalars } from './scalars.js';
import { getTypeName, toCamelCase, tableKey, type TypeRegistry } from './type-builder.js';

// ─── Scalar Comparison Input Types ──────────────────────────────────────────

/**
 * Builds a comparison input type for a given scalar type.
 * Caches types so the same comparison type is reused across tables.
 */
const comparisonTypeCache = new Map<string, GraphQLInputObjectType>();

/** Operators available for all types */
function baseComparisonFields(scalarType: GraphQLInputType): Record<string, { type: GraphQLInputType }> {
  return {
    _eq: { type: scalarType },
    _ne: { type: scalarType },
    _in: { type: new GraphQLList(new GraphQLNonNull(scalarType)) },
    _nin: { type: new GraphQLList(new GraphQLNonNull(scalarType)) },
    _is_null: { type: GraphQLBoolean },
  };
}

/** Operators for ordered types (numbers, dates, strings) */
function orderedComparisonFields(scalarType: GraphQLInputType): Record<string, { type: GraphQLInputType }> {
  return {
    ...baseComparisonFields(scalarType),
    _gt: { type: scalarType },
    _lt: { type: scalarType },
    _gte: { type: scalarType },
    _lte: { type: scalarType },
  };
}

/** Operators for string-like types (text, varchar, etc.) */
function stringComparisonFields(scalarType: GraphQLInputType): Record<string, { type: GraphQLInputType }> {
  return {
    ...orderedComparisonFields(scalarType),
    _like: { type: GraphQLString },
    _nlike: { type: GraphQLString },
    _ilike: { type: GraphQLString },
    _nilike: { type: GraphQLString },
    _similar: { type: GraphQLString },
    _nsimilar: { type: GraphQLString },
    _regex: { type: GraphQLString },
    _nregex: { type: GraphQLString },
    _iregex: { type: GraphQLString },
    _niregex: { type: GraphQLString },
  };
}

/** JSONB cast expression input type (singleton) */
let jsonbCastExpType: GraphQLInputObjectType | undefined;

function getJsonbCastExpType(): GraphQLInputObjectType {
  if (jsonbCastExpType) return jsonbCastExpType;
  jsonbCastExpType = new GraphQLInputObjectType({
    name: 'JsonbCastExp',
    description: 'Cast JSONB values to other types for comparison.',
    fields: () => ({
      String: { type: getComparisonType('String') },
    }),
  });
  return jsonbCastExpType;
}

/** Operators for JSONB types */
function jsonbComparisonFields(scalarType: GraphQLInputType): Record<string, { type: GraphQLInputType }> {
  return {
    ...baseComparisonFields(scalarType),
    _cast: { type: getJsonbCastExpType() },
    _contains: { type: scalarType },
    _contained_in: { type: scalarType },
    _has_key: { type: GraphQLString },
    _has_keys_any: { type: new GraphQLList(new GraphQLNonNull(GraphQLString as unknown as GraphQLScalarType)) },
    _has_keys_all: { type: new GraphQLList(new GraphQLNonNull(GraphQLString as unknown as GraphQLScalarType)) },
  };
}

/** Map of GraphQL scalar name to the function that produces its comparison fields. */
type ComparisonFieldsFactory = (scalarType: GraphQLInputType) => Record<string, { type: GraphQLInputType }>;

const COMPARISON_FACTORIES: Record<string, ComparisonFieldsFactory> = {
  String: stringComparisonFields,
  Int: orderedComparisonFields,
  Float: orderedComparisonFields,
  Boolean: baseComparisonFields,
  BigInt: orderedComparisonFields,
  BigDecimal: orderedComparisonFields,
  UUID: baseComparisonFields,
  DateTime: orderedComparisonFields,
  Timestamptz: orderedComparisonFields,
  Date: orderedComparisonFields,
  Time: orderedComparisonFields,
  Interval: baseComparisonFields,
  JSON: jsonbComparisonFields,
  JSONB: jsonbComparisonFields,
  Bytea: baseComparisonFields,
  Inet: baseComparisonFields,
};

/**
 * Get (or create and cache) the comparison input type for a given scalar name.
 */
function getComparisonType(scalarName: string): GraphQLInputObjectType {
  const cached = comparisonTypeCache.get(scalarName);
  if (cached) return cached;

  const factory = COMPARISON_FACTORIES[scalarName] ?? baseComparisonFields;

  // Resolve the actual GraphQL scalar type
  const builtinScalars: Record<string, GraphQLInputType> = {
    Int: GraphQLInt,
    Float: GraphQLFloat,
    String: GraphQLString,
    Boolean: GraphQLBoolean,
  };
  const scalarType: GraphQLInputType =
    builtinScalars[scalarName] ?? customScalars[scalarName] ?? (GraphQLString as unknown as GraphQLScalarType);

  const compType = new GraphQLInputObjectType({
    name: `${scalarName}ComparisonExp`,
    description: `Comparison operators for the ${scalarName} type.`,
    fields: factory(scalarType),
  });

  comparisonTypeCache.set(scalarName, compType);
  return compType;
}

/**
 * Get the comparison input type for an enum type.
 */
function getEnumComparisonType(
  enumType: GraphQLEnumType,
): GraphQLInputObjectType {
  const name = `${enumType.name}ComparisonExp`;
  const cached = comparisonTypeCache.get(name);
  if (cached) return cached;

  const compType = new GraphQLInputObjectType({
    name,
    description: `Comparison operators for the ${enumType.name} enum.`,
    fields: baseComparisonFields(enumType),
  });

  comparisonTypeCache.set(name, compType);
  return compType;
}

// ─── Column → Comparison Type Resolution ────────────────────────────────────

/**
 * Resolve the comparison input type for a column based on its PG type.
 */
function columnComparisonType(
  column: ColumnInfo,
  enumTypes: Map<string, GraphQLEnumType>,
  enumNames: Set<string>,
): GraphQLInputObjectType {
  const mapping = pgTypeToGraphQL(column.udtName, false, enumNames);

  // Check if it's an enum
  const enumType = enumTypes.get(mapping.name);
  if (enumType) {
    return getEnumComparisonType(enumType);
  }

  return getComparisonType(mapping.name);
}

// ─── BoolExp Builder ────────────────────────────────────────────────────────

/**
 * Build filter (BoolExp) input types for all tracked tables.
 *
 * Each table gets a `<TypeName>BoolExp` input type with:
 * - A field per column using the appropriate comparison input type
 * - _and: [<TypeName>BoolExp]
 * - _or: [<TypeName>BoolExp]
 * - _not: <TypeName>BoolExp
 * - Relationship fields referencing the related table's BoolExp
 *
 * Returns a Map keyed by "schema.table" for easy lookup.
 */
export function buildFilterTypes(
  tables: TableInfo[],
  _typeRegistry: TypeRegistry,
  enumTypes: Map<string, GraphQLEnumType>,
  enumNames: Set<string>,
): Map<string, GraphQLInputObjectType> {
  const filterTypes = new Map<string, GraphQLInputObjectType>();

  // Phase 1: Create all BoolExp types with lazy field resolution.
  // This is necessary because tables can reference each other's BoolExp
  // via relationships (circular references).
  for (const table of tables) {
    const typeName = getTypeName(table);
    const key = tableKey(table.schema, table.name);

    const boolExpType = new GraphQLInputObjectType({
      name: `${typeName}BoolExp`,
      description: `Boolean expression filter for ${typeName}.`,
      fields: () => {
        const fields: Record<string, { type: GraphQLInputType }> = {};

        // Column comparison fields (camelCase per graphql-default naming convention)
        for (const column of table.columns) {
          const compType = columnComparisonType(column, enumTypes, enumNames);
          const fieldName = toCamelCase(column.name);
          fields[fieldName] = { type: compType };
        }

        // Logical combinators (self-referential)
        fields['_and'] = {
          type: new GraphQLList(new GraphQLNonNull(boolExpType)),
        };
        fields['_or'] = {
          type: new GraphQLList(new GraphQLNonNull(boolExpType)),
        };
        fields['_not'] = {
          type: boolExpType,
        };

        // Relationship traversal filters
        for (const rel of table.relationships) {
          const relKey = tableKey(rel.remoteTable.schema, rel.remoteTable.name);
          const relBoolExp = filterTypes.get(relKey);
          if (relBoolExp) {
            fields[rel.name] = { type: relBoolExp };
          }
        }

        return fields;
      },
    });

    filterTypes.set(key, boolExpType);
  }

  return filterTypes;
}

/**
 * Reset the comparison type cache. Useful for testing.
 */
export function resetComparisonTypeCache(): void {
  comparisonTypeCache.clear();
  jsonbCastExpType = undefined;
}
