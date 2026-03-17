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
import type { GraphQLInputType } from 'graphql';
import type { TableInfo, ColumnInfo, FunctionInfo } from '../types.js';
import { pgTypeToGraphQL } from '../introspection/type-map.js';
import { customScalars, asScalar } from './scalars.js';
import { getTypeName, toCamelCase, getColumnFieldName, tableKey, getRelFieldName, getVisibleColumns, type TypeRegistry } from './type-builder.js';

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
    _neq: { type: scalarType },
    _in: { type: new GraphQLList(new GraphQLNonNull(scalarType)) },
    _nin: { type: new GraphQLList(new GraphQLNonNull(scalarType)) },
    _isNull: { type: GraphQLBoolean },
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
    _like: { type: scalarType },
    _nlike: { type: scalarType },
    _ilike: { type: scalarType },
    _nilike: { type: scalarType },
    _similar: { type: scalarType },
    _nsimilar: { type: scalarType },
    _regex: { type: scalarType },
    _nregex: { type: scalarType },
    _iregex: { type: scalarType },
    _niregex: { type: scalarType },
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
    ...orderedComparisonFields(scalarType),
    _cast: { type: getJsonbCastExpType() },
    _contains: { type: scalarType },
    _containedIn: { type: scalarType },
    _hasKey: { type: GraphQLString },
    _hasKeysAny: { type: new GraphQLList(new GraphQLNonNull(asScalar(GraphQLString))) },
    _hasKeysAll: { type: new GraphQLList(new GraphQLNonNull(asScalar(GraphQLString))) },
  };
}

/** Map of GraphQL scalar name to the function that produces its comparison fields. */
type ComparisonFieldsFactory = (scalarType: GraphQLInputType) => Record<string, { type: GraphQLInputType }>;

const COMPARISON_FACTORIES: Record<string, ComparisonFieldsFactory> = {
  String: stringComparisonFields,
  Int: orderedComparisonFields,
  Smallint: orderedComparisonFields,
  Float: orderedComparisonFields,
  Boolean: orderedComparisonFields,
  Bigint: orderedComparisonFields,
  Numeric: orderedComparisonFields,
  Uuid: orderedComparisonFields,
  Timestamptz: orderedComparisonFields,
  Timestamp: orderedComparisonFields,
  Date: orderedComparisonFields,
  Time: orderedComparisonFields,
  Interval: orderedComparisonFields,
  json: jsonbComparisonFields,
  Jsonb: jsonbComparisonFields,
  Bytea: baseComparisonFields,
  Inet: orderedComparisonFields,
  Bpchar: stringComparisonFields,
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
    builtinScalars[scalarName] ?? customScalars[scalarName] ?? asScalar(GraphQLString);

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
 * PG native enums use orderedComparisonFields because PostgreSQL enums have a
 * natural ordering based on their declaration order, supporting >, >=, <, <=.
 * Table-based enums (is_enum: true) only get baseComparisonFields — Hasura does
 * not expose ordering operators for table-based enum comparison types.
 */
function getEnumComparisonType(
  enumType: GraphQLEnumType,
  isTableEnum?: boolean,
): GraphQLInputObjectType {
  const name = `${enumType.name}ComparisonExp`;
  const cached = comparisonTypeCache.get(name);
  if (cached) return cached;

  const factory = isTableEnum ? baseComparisonFields : orderedComparisonFields;
  const compType = new GraphQLInputObjectType({
    name,
    description: `Comparison operators for the ${enumType.name} enum.`,
    fields: factory(enumType),
  });

  comparisonTypeCache.set(name, compType);
  return compType;
}

// ─── Array Comparison Input Types ────────────────────────────────────────────

/**
 * Build comparison fields for PostgreSQL array columns.
 * Array comparison uses PG array operators (@>, <@) and standard
 * comparison operators that work on arrays.
 */
function arrayComparisonFields(scalarType: GraphQLInputType): Record<string, { type: GraphQLInputType }> {
  const arrayType = new GraphQLList(new GraphQLNonNull(scalarType));
  const arrayOfArraysType = new GraphQLList(new GraphQLNonNull(arrayType));
  return {
    _eq: { type: arrayType },
    _neq: { type: arrayType },
    _gt: { type: arrayType },
    _gte: { type: arrayType },
    _lt: { type: arrayType },
    _lte: { type: arrayType },
    _contains: { type: arrayType },
    _containedIn: { type: arrayType },
    _in: { type: arrayOfArraysType },
    _nin: { type: arrayOfArraysType },
    _isNull: { type: GraphQLBoolean },
  };
}

/**
 * Get (or create and cache) the array comparison input type for a given scalar name.
 * Creates types like `StringArrayComparisonExp`, `IntArrayComparisonExp`, etc.
 */
function getArrayComparisonType(scalarName: string): GraphQLInputObjectType {
  const typeName = `${scalarName}ArrayComparisonExp`;
  const cached = comparisonTypeCache.get(typeName);
  if (cached) return cached;

  // Resolve the actual GraphQL scalar type
  const builtinScalars: Record<string, GraphQLInputType> = {
    Int: GraphQLInt,
    Float: GraphQLFloat,
    String: GraphQLString,
    Boolean: GraphQLBoolean,
  };
  const scalarType: GraphQLInputType =
    builtinScalars[scalarName] ?? customScalars[scalarName] ?? asScalar(GraphQLString);

  const compType = new GraphQLInputObjectType({
    name: typeName,
    description: `Comparison operators for ${scalarName} array columns.`,
    fields: arrayComparisonFields(scalarType),
  });

  comparisonTypeCache.set(typeName, compType);
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
  tableEnumGraphQLNames?: Set<string>,
): GraphQLInputObjectType {
  const mapping = pgTypeToGraphQL(column.udtName, false, enumNames);

  // Array columns get a dedicated array comparison type
  if (column.isArray) {
    // Check if it's an enum array
    const enumType = enumTypes.get(mapping.name);
    if (enumType) {
      return getArrayComparisonType(enumType.name);
    }
    return getArrayComparisonType(mapping.name);
  }

  // Check if it's an enum
  const enumType = enumTypes.get(mapping.name);
  if (enumType) {
    const isTableEnum = tableEnumGraphQLNames?.has(enumType.name) ?? false;
    return getEnumComparisonType(enumType, isTableEnum);
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
 * - Aggregate filter fields for array relationships (e.g., accountsAggregate)
 *
 * @param selectColumnEnums - Optional map of select column enums, populated lazily by generator.ts.
 *   Used by aggregate BoolExp count types for the `arguments` field. Because BoolExp types use
 *   thunks, the map will be populated by the time the thunks execute.
 *
 * Returns a Map keyed by "schema.table" for easy lookup.
 */
export function buildFilterTypes(
  tables: TableInfo[],
  _typeRegistry: TypeRegistry,
  enumTypes: Map<string, GraphQLEnumType>,
  enumNames: Set<string>,
  selectColumnEnums?: Map<string, GraphQLEnumType>,
  functions?: FunctionInfo[],
  tableEnumGraphQLNames?: Set<string>,
): Map<string, GraphQLInputObjectType> {
  const filterTypes = new Map<string, GraphQLInputObjectType>();
  const aggregateBoolExpTypes = new Map<string, GraphQLInputObjectType>();

  // Determine which tables are targets of array relationships
  const arrayRelTargets = new Set<string>();
  for (const table of tables) {
    for (const rel of table.relationships) {
      if (rel.type === 'array') {
        arrayRelTargets.add(tableKey(rel.remoteTable.schema, rel.remoteTable.name));
      }
    }
  }

  // Build AggregateBoolExp types for tables that are targets of array relationships
  for (const table of tables) {
    const key = tableKey(table.schema, table.name);
    if (!arrayRelTargets.has(key)) continue;

    const typeName = getTypeName(table);
    // Lowercase-start naming: GameIntegrationCurrency -> gameIntegrationCurrency
    const lcTypeName = typeName[0].toLowerCase() + typeName.slice(1);

    // Build the count helper type (lowercase-start name per Hasura convention)
    const countType = new GraphQLInputObjectType({
      name: `${lcTypeName}AggregateBoolExpCount`,
      description: `Count aggregate filter for ${typeName}.`,
      fields: () => {
        const fields: Record<string, { type: GraphQLInputType }> = {};

        // arguments: [SelectColumn!] (optional)
        if (selectColumnEnums) {
          const selectEnum = selectColumnEnums.get(key);
          if (selectEnum) {
            fields['arguments'] = {
              type: new GraphQLList(new GraphQLNonNull(selectEnum)),
            };
          }
        }

        // distinct: Boolean (optional)
        fields['distinct'] = { type: GraphQLBoolean };

        // filter: BoolExp (optional) -- references the remote table's BoolExp
        const remoteBoolExp = filterTypes.get(key);
        if (remoteBoolExp) {
          fields['filter'] = { type: remoteBoolExp };
        }

        // predicate: IntComparisonExp! (required)
        fields['predicate'] = {
          type: new GraphQLNonNull(getComparisonType('Int')),
        };

        return fields;
      },
    });

    // Identify boolean columns (visible) for bool_and / bool_or aggregate types
    const visibleCols = getVisibleColumns(table);
    const booleanColumns = table.columns.filter((col) => {
      if (visibleCols && !visibleCols.has(col.name)) return false;
      const mapping = pgTypeToGraphQL(col.udtName, false, enumNames);
      return mapping.name === 'Boolean' && !col.isArray;
    });

    // Build bool_and / bool_or types only when the table has boolean columns
    let boolAndType: GraphQLInputObjectType | undefined;
    let boolOrType: GraphQLInputObjectType | undefined;

    if (booleanColumns.length > 0) {
      // Build the arguments column enums for bool_and and bool_or
      // Enum keys are the camelCase field names (matching Hasura's graphql-default convention)
      const boolAndEnumValues: Record<string, { value: string }> = {};
      const boolOrEnumValues: Record<string, { value: string }> = {};
      for (const col of booleanColumns) {
        const fieldName = getColumnFieldName(table, col.name);
        boolAndEnumValues[fieldName] = { value: col.name };
        boolOrEnumValues[fieldName] = { value: col.name };
      }

      const boolAndArgsEnum = new GraphQLEnumType({
        name: `${typeName}SelectColumn${typeName}AggregateBoolExpBool_andArgumentsColumns`,
        description: `Boolean column arguments for ${typeName} bool_and aggregate.`,
        values: boolAndEnumValues,
      });

      const boolOrArgsEnum = new GraphQLEnumType({
        name: `${typeName}SelectColumn${typeName}AggregateBoolExpBool_orArgumentsColumns`,
        description: `Boolean column arguments for ${typeName} bool_or aggregate.`,
        values: boolOrEnumValues,
      });

      // Build the bool_and helper type (lowercase-start name per Hasura convention)
      boolAndType = new GraphQLInputObjectType({
        name: `${lcTypeName}AggregateBoolExpBool_and`,
        description: `Bool_and aggregate filter for ${typeName}.`,
        fields: () => {
          const fields: Record<string, { type: GraphQLInputType }> = {};

          // arguments: SelectColumn...Bool_andArgumentsColumns! (required)
          fields['arguments'] = {
            type: new GraphQLNonNull(boolAndArgsEnum),
          };

          // distinct: Boolean (optional)
          fields['distinct'] = { type: GraphQLBoolean };

          // filter: BoolExp (optional)
          const remoteBoolExp = filterTypes.get(key);
          if (remoteBoolExp) {
            fields['filter'] = { type: remoteBoolExp };
          }

          // predicate: BooleanComparisonExp! (required)
          fields['predicate'] = {
            type: new GraphQLNonNull(getComparisonType('Boolean')),
          };

          return fields;
        },
      });

      // Build the bool_or helper type (lowercase-start name per Hasura convention)
      boolOrType = new GraphQLInputObjectType({
        name: `${lcTypeName}AggregateBoolExpBool_or`,
        description: `Bool_or aggregate filter for ${typeName}.`,
        fields: () => {
          const fields: Record<string, { type: GraphQLInputType }> = {};

          // arguments: SelectColumn...Bool_orArgumentsColumns! (required)
          fields['arguments'] = {
            type: new GraphQLNonNull(boolOrArgsEnum),
          };

          // distinct: Boolean (optional)
          fields['distinct'] = { type: GraphQLBoolean };

          // filter: BoolExp (optional)
          const remoteBoolExp = filterTypes.get(key);
          if (remoteBoolExp) {
            fields['filter'] = { type: remoteBoolExp };
          }

          // predicate: BooleanComparisonExp! (required)
          fields['predicate'] = {
            type: new GraphQLNonNull(getComparisonType('Boolean')),
          };

          return fields;
        },
      });
    }

    // Build the aggregate BoolExp wrapper type with count and optional bool_and/bool_or
    const aggBoolExpFields: Record<string, { type: GraphQLInputType }> = {
      count: { type: countType },
    };
    if (boolAndType) {
      aggBoolExpFields['bool_and'] = { type: boolAndType };
    }
    if (boolOrType) {
      aggBoolExpFields['bool_or'] = { type: boolOrType };
    }

    const aggBoolExpType = new GraphQLInputObjectType({
      name: `${typeName}AggregateBoolExp`,
      description: `Aggregate boolean expression filter for ${typeName}.`,
      fields: aggBoolExpFields,
    });

    aggregateBoolExpTypes.set(key, aggBoolExpType);
  }

  // Phase 1: Create all BoolExp types with lazy field resolution.
  // This is necessary because tables can reference each other's BoolExp
  // via relationships (circular references).
  for (const table of tables) {
    const typeName = getTypeName(table);
    const key = tableKey(table.schema, table.name);

    const visibleColumns = getVisibleColumns(table);

    const boolExpType = new GraphQLInputObjectType({
      name: `${typeName}BoolExp`,
      description: `Boolean expression filter for ${typeName}.`,
      fields: () => {
        const fields: Record<string, { type: GraphQLInputType }> = {};

        // Column comparison fields (camelCase per graphql-default naming convention)
        for (const column of table.columns) {
          if (visibleColumns && !visibleColumns.has(column.name)) continue;
          const compType = columnComparisonType(column, enumTypes, enumNames, tableEnumGraphQLNames);
          const fieldName = getColumnFieldName(table, column.name);
          fields[fieldName] = { type: compType };
        }

        // Scalar computed field comparison fields
        if (table.computedFields && functions) {
          for (const cf of table.computedFields) {
            const fnSchema = cf.function.schema ?? 'public';
            const fn = functions.find(
              (f) => f.name === cf.function.name && f.schema === fnSchema,
            );
            // Only add scalar (non-SETOF) computed fields to BoolExp
            if (!fn || fn.isSetReturning) continue;

            const mapping = pgTypeToGraphQL(fn.returnType, false, enumNames);
            const compType = getComparisonType(mapping.name);
            const fieldName = toCamelCase(cf.name);
            // Don't overwrite column fields if names collide
            if (!(fieldName in fields)) {
              fields[fieldName] = { type: compType };
            }
          }
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

        // Relationship traversal filters + aggregate filters for array relationships
        for (const rel of table.relationships) {
          const relKey = tableKey(rel.remoteTable.schema, rel.remoteTable.name);
          const relBoolExp = filterTypes.get(relKey);
          if (relBoolExp) {
            fields[getRelFieldName(rel)] = { type: relBoolExp };
          }

          // Aggregate filter for array relationships
          if (rel.type === 'array') {
            const aggBoolExp = aggregateBoolExpTypes.get(relKey);
            if (aggBoolExp) {
              fields[`${getRelFieldName(rel)}Aggregate`] = { type: aggBoolExp };
            }
          }
        }

        // Computed fields that return a tracked table type get relationship-like
        // BoolExp filters (overwriting any scalar comparison that may have been
        // added above). This matches Hasura's behavior: e.g. Player.data returning
        // SETOF json_result gets JsonResultBoolExp, not StringComparisonExp.
        if (table.computedFields && functions) {
          for (const cf of table.computedFields) {
            const fnSchema = cf.function.schema ?? 'public';
            const fn = functions.find(
              (f) => f.name === cf.function.name && f.schema === fnSchema,
            );
            if (!fn) continue;

            // Check if the function returns a tracked table type
            let returnTableKey: string | undefined;
            const sameSchemaKey = tableKey(fnSchema, fn.returnType);
            if (filterTypes.has(sameSchemaKey)) {
              returnTableKey = sameSchemaKey;
            } else {
              for (const key of filterTypes.keys()) {
                if (key.endsWith(`.${fn.returnType}`)) {
                  returnTableKey = key;
                  break;
                }
              }
            }

            if (returnTableKey) {
              const relBoolExp = filterTypes.get(returnTableKey);
              if (relBoolExp) {
                const fieldName = toCamelCase(cf.name);
                fields[fieldName] = { type: relBoolExp };
              }
            }
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
