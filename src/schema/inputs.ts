/**
 * Generates mutation input types, ordering types, aggregate types,
 * and mutation response types for each table.
 *
 * Types generated per table:
 * - <Type>InsertInput       — all insertable columns
 * - <Type>OnConflict        — conflict resolution for upserts
 * - <Type>SetInput          — all updatable columns (all nullable)
 * - <Type>PkColumnsInput    — primary key fields for by_pk operations
 * - <Type>OrderBy           — column ordering input
 * - <Type>MutationResponse  — { affectedRows, returning }
 * - <Type>AggregateFields   — { count, sum, avg, min, max, stddev, stddevPop, stddevSamp, variance, varPop, varSamp }
 * - <Type>SumFields / AvgFields / MinFields / MaxFields
 * - <Type>StddevFields / StddevPopFields / StddevSampFields
 * - <Type>VarianceFields / VarPopFields / VarSampFields
 */

import {
  GraphQLInputObjectType,
  GraphQLObjectType,
  GraphQLNonNull,
  GraphQLList,
  GraphQLInt,
  GraphQLFloat,
  GraphQLString,
  GraphQLBoolean,
  GraphQLEnumType,
} from 'graphql';
import type {
  GraphQLInputFieldConfigMap,
  GraphQLInputType,
  GraphQLOutputType,
  GraphQLFieldConfigMap,
} from 'graphql';
import type { TableInfo, ColumnInfo, RelationshipConfig, FunctionInfo } from '../types.js';
import { pgTypeToGraphQL } from '../introspection/type-map.js';
import { customScalars, asScalar } from './scalars.js';
import { toCamelCase, getTypeName, getColumnFieldName, tableKey, getRelFieldName, getVisibleColumns } from './type-builder.js';

// ─── CursorOrdering Enum ────────────────────────────────────────────────────

/** Cursor ordering direction for streaming subscriptions. */
export const CursorOrdering = new GraphQLEnumType({
  name: 'CursorOrdering',
  description: 'Ordering options for cursor-based streaming.',
  values: {
    ASC: { value: 'ASC' },
    DESC: { value: 'DESC' },
  },
});

// ─── OrderBy Direction Enum ─────────────────────────────────────────────────

/** Ordering direction enum, shared across all tables. */
export const OrderByDirection = new GraphQLEnumType({
  name: 'OrderBy',
  description: 'Column ordering direction.',
  values: {
    ASC: { value: 'asc' },
    ASC_NULLS_FIRST: { value: 'asc_nulls_first' },
    ASC_NULLS_LAST: { value: 'asc_nulls_last' },
    DESC: { value: 'desc' },
    DESC_NULLS_FIRST: { value: 'desc_nulls_first' },
    DESC_NULLS_LAST: { value: 'desc_nulls_last' },
  },
});

// ─── Constraint Enum (for on_conflict) ──────────────────────────────────────

function buildConstraintEnum(table: TableInfo, typeName: string): GraphQLEnumType | null {
  const values: Record<string, { value: string }> = {};

  // Primary key constraint — use the real introspected constraint name
  if (table.primaryKey.length > 0 && table.primaryKeyConstraintName) {
    const pgName = table.primaryKeyConstraintName;
    const enumKey = toCamelCase(pgName);
    values[enumKey] = { value: pgName };
  }

  // Unique constraints — camelCase the real PG constraint names
  for (const uc of table.uniqueConstraints) {
    const enumKey = toCamelCase(uc.constraintName);
    values[enumKey] = { value: uc.constraintName };
  }

  if (Object.keys(values).length === 0) {
    return null;
  }

  return new GraphQLEnumType({
    name: `${typeName}Constraint`,
    description: `Unique or primary key constraints on ${typeName}.`,
    values,
  });
}

function buildUpdateColumnEnum(table: TableInfo, typeName: string): GraphQLEnumType {
  const values: Record<string, { value: string }> = {};
  for (const col of table.columns) {
    // Use custom column name if available, otherwise camelCase
    // Internal value stays as the PG column name for SQL compilation
    const fieldName = getColumnFieldName(table, col.name);
    values[fieldName] = { value: col.name };
  }
  return new GraphQLEnumType({
    name: `${typeName}UpdateColumn`,
    description: `Updatable columns for ${typeName}.`,
    values,
  });
}

function buildSelectColumnEnum(table: TableInfo, typeName: string, visibleColumns: Set<string> | null): GraphQLEnumType {
  const values: Record<string, { value: string }> = {};
  for (const col of table.columns) {
    if (visibleColumns && !visibleColumns.has(col.name)) continue;
    // Use custom column name if available — internal value is the PG column name
    const fieldName = getColumnFieldName(table, col.name);
    values[fieldName] = { value: col.name };
  }
  return new GraphQLEnumType({
    name: `${typeName}SelectColumn`,
    description: `Select columns for ${typeName}. Used for distinct_on.`,
    values,
  });
}

// ─── Scalar Resolution (Input Types) ────────────────────────────────────────

const BUILTIN_INPUT_SCALARS: Record<string, GraphQLInputType> = {
  Int: GraphQLInt,
  Float: GraphQLFloat,
  String: GraphQLString,
  Boolean: GraphQLBoolean,
};

function resolveInputScalarType(
  graphqlName: string,
  isList: boolean,
  enumTypes: Map<string, GraphQLEnumType>,
): GraphQLInputType {
  const builtin = BUILTIN_INPUT_SCALARS[graphqlName];
  if (builtin) {
    return isList ? new GraphQLList(new GraphQLNonNull(builtin)) : builtin;
  }

  const enumType = enumTypes.get(graphqlName);
  if (enumType) {
    return isList ? new GraphQLList(new GraphQLNonNull(enumType)) : enumType;
  }

  const custom = customScalars[graphqlName];
  if (custom) {
    return isList ? new GraphQLList(new GraphQLNonNull(custom)) : custom;
  }

  return isList
    ? new GraphQLList(new GraphQLNonNull(asScalar(GraphQLString)))
    : asScalar(GraphQLString);
}

function columnToInputType(
  column: ColumnInfo,
  enumTypes: Map<string, GraphQLEnumType>,
  enumNames: Set<string>,
): GraphQLInputType {
  const mapping = pgTypeToGraphQL(column.udtName, column.isArray, enumNames);
  return resolveInputScalarType(mapping.name, mapping.isList, enumTypes);
}

// ─── Output Type Resolution (for aggregate fields) ─────────────────────────

const BUILTIN_OUTPUT_SCALARS: Record<string, GraphQLOutputType> = {
  Int: GraphQLInt,
  Float: GraphQLFloat,
  String: GraphQLString,
  Boolean: GraphQLBoolean,
};

function resolveOutputScalarType(
  graphqlName: string,
): GraphQLOutputType {
  return BUILTIN_OUTPUT_SCALARS[graphqlName] ?? customScalars[graphqlName] ?? asScalar(GraphQLString);
}

// ─── Numeric Check ──────────────────────────────────────────────────────────

const NUMERIC_GRAPHQL_TYPES = new Set(['Int', 'Smallint', 'Float', 'Bigint', 'Numeric']);

function isNumericColumn(column: ColumnInfo, enumNames: Set<string>): boolean {
  const mapping = pgTypeToGraphQL(column.udtName, false, enumNames);
  return NUMERIC_GRAPHQL_TYPES.has(mapping.name);
}

/** Orderable types: numeric + string-like + date/time (everything except arrays, json/jsonb, bytea, inet, interval) */
const ORDERABLE_GRAPHQL_TYPES = new Set([
  'Int', 'Smallint', 'Float', 'Bigint', 'Numeric',
  'String', 'Bpchar',
  'Timestamptz', 'Timestamp', 'Date', 'Time',
  'Uuid', 'Boolean',
]);

function isOrderableColumn(column: ColumnInfo, enumNames: Set<string>): boolean {
  if (column.isArray) return false;
  const mapping = pgTypeToGraphQL(column.udtName, false, enumNames);
  return ORDERABLE_GRAPHQL_TYPES.has(mapping.name);
}

// ─── Mutation Input Types Container ─────────────────────────────────────────

export interface MutationInputTypes {
  insertInput: GraphQLInputObjectType;
  onConflict: GraphQLInputObjectType | null;
  setInput: GraphQLInputObjectType;
  pkColumnsInput: GraphQLInputObjectType | null;
  orderBy: GraphQLInputObjectType;
  mutationResponse: GraphQLObjectType;
  aggregateFields: GraphQLObjectType;
  selectAggregateFields: GraphQLObjectType;
  constraintEnum: GraphQLEnumType | null;
  updateColumnEnum: GraphQLEnumType;
  selectColumnEnum: GraphQLEnumType;
  updateManyInput: GraphQLInputObjectType | null;
}

// ─── Stream Cursor Types ────────────────────────────────────────────────────

export interface StreamCursorTypes {
  streamCursorValueInput: GraphQLInputObjectType;
  streamCursorInput: GraphQLInputObjectType;
}

/**
 * Build streaming subscription cursor input types for a table.
 *
 * Creates:
 * - {Type}StreamCursorValueInput — all columns as optional fields (nullable scalars)
 * - {Type}StreamCursorInput — { initialValue: {Type}StreamCursorValueInput!, ordering: CursorOrdering }
 */
export function buildStreamCursorTypes(
  table: TableInfo,
  enumTypes: Map<string, GraphQLEnumType>,
  enumNames: Set<string>,
): StreamCursorTypes {
  const typeName = getTypeName(table);
  const visibleColumns = getVisibleColumns(table);

  // StreamCursorValueInput — visible columns as optional fields (same pattern as SetInput)
  const streamCursorValueInput = new GraphQLInputObjectType({
    name: `${typeName}StreamCursorValueInput`,
    description: `Initial value of the cursor for streaming subscription on ${typeName}.`,
    fields: () => {
      const fields: GraphQLInputFieldConfigMap = {};
      for (const column of table.columns) {
        if (visibleColumns && !visibleColumns.has(column.name)) continue;
        const fieldName = getColumnFieldName(table, column.name);
        fields[fieldName] = {
          type: columnToInputType(column, enumTypes, enumNames),
          description: column.comment,
        };
      }
      return fields;
    },
  });

  // StreamCursorInput — { initialValue: ..., ordering: CursorOrdering }
  const streamCursorInput = new GraphQLInputObjectType({
    name: `${typeName}StreamCursorInput`,
    description: `Streaming cursor input for ${typeName}.`,
    fields: {
      initialValue: {
        type: new GraphQLNonNull(streamCursorValueInput),
        description: 'Stream cursor initial value.',
      },
      ordering: {
        type: CursorOrdering,
        description: 'Cursor ordering, defaults to ASC.',
      },
    },
  });

  return { streamCursorValueInput, streamCursorInput };
}

// ─── Aggregate OrderBy Builders ─────────────────────────────────────────────

/** Aggregate function names for per-field order types */
const AGGREGATE_ORDER_FUNCTIONS = [
  'avg', 'max', 'min', 'sum',
  'stddev', 'stddevPop', 'stddevSamp',
  'varPop', 'varSamp', 'variance',
] as const;

/**
 * Build the AggregateOrderBy types for a table and register them in the orderByTypes map.
 *
 * Creates:
 * - {Type}AggregateOrderBy — top-level aggregate ordering (count + per-function types)
 * - {Type}AvgOrderBy, {Type}MaxOrderBy, etc. — per-function types with numeric columns
 *
 * Stored under key "{schema}.{table}.__aggregateOrderBy" in orderByTypes.
 */
function buildAggregateOrderByTypes(
  table: TableInfo,
  typeName: string,
  enumNames: Set<string>,
  orderByTypes: Map<string, GraphQLInputObjectType>,
): void {
  const key = tableKey(table.schema, table.name);
  const aggKey = `${key}.__aggregateOrderBy`;

  // Don't rebuild if already exists
  if (orderByTypes.has(aggKey)) return;

  const visibleColumns = getVisibleColumns(table);
  const numericColumns = table.columns.filter((c) =>
    isNumericColumn(c, enumNames) && (!visibleColumns || visibleColumns.has(c.name)),
  );
  const orderableColumns = table.columns.filter((c) =>
    isOrderableColumn(c, enumNames) && (!visibleColumns || visibleColumns.has(c.name)),
  );

  // Build per-aggregate-function order types
  const perFunctionTypes: Record<string, GraphQLInputObjectType> = {};

  for (const fn of AGGREGATE_ORDER_FUNCTIONS) {
    // Map function name to PascalCase for GraphQL type name
    const fnPascal = fn.charAt(0).toUpperCase() + fn.slice(1);

    // max, min apply to all orderable types (text, date, etc.)
    // avg, sum, stddev*, var*, variance only apply to numeric columns
    const applicableColumns = (fn === 'max' || fn === 'min') ? orderableColumns : numericColumns;

    if (applicableColumns.length === 0) continue;

    const fnType = new GraphQLInputObjectType({
      name: `${typeName}${fnPascal}OrderBy`,
      description: `Order by ${fn} aggregates of ${typeName}.`,
      fields: () => {
        const fields: GraphQLInputFieldConfigMap = {};
        for (const col of applicableColumns) {
          const fieldName = getColumnFieldName(table, col.name);
          fields[fieldName] = { type: OrderByDirection };
        }
        return fields;
      },
    });

    perFunctionTypes[fn] = fnType;
  }

  // Build the top-level AggregateOrderBy type
  const aggOrderBy = new GraphQLInputObjectType({
    name: `${typeName}AggregateOrderBy`,
    description: `Aggregate ordering options for ${typeName}.`,
    fields: () => {
      const fields: GraphQLInputFieldConfigMap = {
        count: { type: OrderByDirection },
      };

      for (const [fn, fnType] of Object.entries(perFunctionTypes)) {
        fields[fn] = { type: fnType };
      }

      return fields;
    },
  });

  orderByTypes.set(aggKey, aggOrderBy);
}

/**
 * Pre-build AggregateOrderBy types for all tables.
 * Must be called before building per-table OrderBy types so that parent
 * OrderBy thunks can reference child AggregateOrderBy types.
 */
export function buildAllAggregateOrderByTypes(
  tables: TableInfo[],
  enumNames: Set<string>,
  orderByTypes: Map<string, GraphQLInputObjectType>,
): void {
  for (const table of tables) {
    const typeName = getTypeName(table);
    buildAggregateOrderByTypes(table, typeName, enumNames, orderByTypes);
  }
}

// ─── Builder ────────────────────────────────────────────────────────────────

/**
 * Build all mutation input types, ordering, and aggregate types for a table.
 *
 * @param orderByTypes  Map of tableKey → OrderBy input type. Used by relationship ordering
 *                      to reference other tables' OrderBy types. Also used to store this
 *                      table's AggregateOrderBy types for use by parent tables.
 * @param allTables     All tracked tables, needed to find remote tables for relationships.
 */
export function buildMutationInputTypes(
  table: TableInfo,
  objectType: GraphQLObjectType,
  enumTypes: Map<string, GraphQLEnumType>,
  enumNames: Set<string>,
  filterType?: GraphQLInputObjectType,
  orderByTypes?: Map<string, GraphQLInputObjectType>,
  allTables?: TableInfo[],
  functions?: FunctionInfo[],
  insertInputTypes?: Map<string, GraphQLInputObjectType>,
): MutationInputTypes {
  const typeName = getTypeName(table);
  const visibleColumns = getVisibleColumns(table);
  // ── InsertInput ────────────────────────────────────────────────────────
  // All fields are optional in the schema because different roles have different
  // presets and allowed columns. Strict per-role validation happens at runtime.
  // Includes nested relationship fields for object and array relationships.
  const insertInput = new GraphQLInputObjectType({
    name: `${typeName}InsertInput`,
    description: `Input type for inserting a row into ${typeName}.`,
    fields: () => {
      const fields: GraphQLInputFieldConfigMap = {};
      for (const column of table.columns) {
        const fieldName = getColumnFieldName(table, column.name);
        const fieldType = columnToInputType(column, enumTypes, enumNames);

        fields[fieldName] = {
          type: fieldType,
          description: column.comment,
        };
      }

      // Add nested insert fields for relationships
      if (insertInputTypes) {
        for (const rel of table.relationships) {
          const relKey = tableKey(rel.remoteTable.schema, rel.remoteTable.name);
          const relInsertInput = insertInputTypes.get(relKey);
          if (relInsertInput) {
            const relFieldName = getRelFieldName(rel);
            if (rel.type === 'object') {
              // Object relationship: single nested object
              fields[relFieldName] = {
                type: relInsertInput,
                description: `Nested insert for ${rel.name} object relationship.`,
              };
            } else {
              // Array relationship: array of nested objects
              fields[relFieldName] = {
                type: new GraphQLList(new GraphQLNonNull(relInsertInput)),
                description: `Nested insert for ${rel.name} array relationship.`,
              };
            }
          }
        }
      }

      return fields;
    },
  });

  // Register this insert input type so other tables can reference it
  if (insertInputTypes) {
    const thisKey = tableKey(table.schema, table.name);
    insertInputTypes.set(thisKey, insertInput);
  }

  // ── Constraint, UpdateColumn, and SelectColumn enums ─────────────────
  const constraintEnum = buildConstraintEnum(table, typeName);
  const updateColumnEnum = buildUpdateColumnEnum(table, typeName);
  const selectColumnEnum = buildSelectColumnEnum(table, typeName, visibleColumns);

  // ── OnConflict ────────────────────────────────────────────────────────
  let onConflict: GraphQLInputObjectType | null = null;
  if (constraintEnum) {
    const onConflictFields: GraphQLInputFieldConfigMap = {
      constraint: { type: new GraphQLNonNull(constraintEnum) },
      updateColumns: {
        type: new GraphQLNonNull(
          new GraphQLList(new GraphQLNonNull(updateColumnEnum)),
        ),
      },
    };
    if (filterType) {
      onConflictFields['where'] = {
        type: filterType,
        description: 'Optional filter for the DO UPDATE SET clause.',
      };
    }
    onConflict = new GraphQLInputObjectType({
      name: `${typeName}OnConflict`,
      description: `Conflict resolution for ${typeName} upserts.`,
      fields: onConflictFields,
    });
  }

  // ── SetInput ──────────────────────────────────────────────────────────
  const setInput = new GraphQLInputObjectType({
    name: `${typeName}SetInput`,
    description: `Input type for updating columns in ${typeName}. All fields are optional.`,
    fields: () => {
      const fields: GraphQLInputFieldConfigMap = {};
      for (const column of table.columns) {
        const fieldName = getColumnFieldName(table, column.name);
        // All fields in SetInput are nullable (optional)
        fields[fieldName] = {
          type: columnToInputType(column, enumTypes, enumNames),
          description: column.comment,
        };
      }
      return fields;
    },
  });

  // ── PkColumnsInput ────────────────────────────────────────────────────
  let pkColumnsInput: GraphQLInputObjectType | null = null;
  if (table.primaryKey.length > 0) {
    pkColumnsInput = new GraphQLInputObjectType({
      name: `${typeName}PkColumnsInput`,
      description: `Primary key input for ${typeName}.`,
      fields: () => {
        const fields: GraphQLInputFieldConfigMap = {};
        for (const pkColName of table.primaryKey) {
          const column = table.columns.find((c) => c.name === pkColName);
          if (!column) continue;
          const fieldName = getColumnFieldName(table, column.name);
          fields[fieldName] = {
            type: new GraphQLNonNull(columnToInputType(column, enumTypes, enumNames)),
          };
        }
        return fields;
      },
    });
  }

  // ── OrderBy ───────────────────────────────────────────────────────────
  const orderBy = new GraphQLInputObjectType({
    name: `${typeName}OrderBy`,
    description: `Ordering options for ${typeName}.`,
    fields: () => {
      const fields: GraphQLInputFieldConfigMap = {};
      for (const column of table.columns) {
        if (visibleColumns && !visibleColumns.has(column.name)) continue;
        const fieldName = getColumnFieldName(table, column.name);
        fields[fieldName] = { type: OrderByDirection };
      }

      // Scalar computed field ordering
      if (table.computedFields && functions) {
        for (const cf of table.computedFields) {
          const fnSchema = cf.function.schema ?? 'public';
          const fn = functions.find(
            (f) => f.name === cf.function.name && f.schema === fnSchema,
          );
          // Only add scalar (non-SETOF) computed fields to OrderBy
          if (!fn || fn.isSetReturning) continue;
          const fieldName = toCamelCase(cf.name);
          // Don't overwrite column fields if names collide
          if (!(fieldName in fields)) {
            fields[fieldName] = { type: OrderByDirection };
          }
        }
      }

      // Object relationship fields — allow ordering by related table columns
      if (orderByTypes) {
        for (const rel of table.relationships) {
          if (rel.type === 'object') {
            const relKey = tableKey(rel.remoteTable.schema, rel.remoteTable.name);
            const relOrderBy = orderByTypes.get(relKey);
            if (relOrderBy) {
              fields[getRelFieldName(rel)] = {
                type: relOrderBy,
                description: `Order by ${rel.name} relationship fields.`,
              };
            }
          }
        }

        // Array relationship aggregate fields — allow ordering by aggregate of related table
        for (const rel of table.relationships) {
          if (rel.type === 'array') {
            const relKey = tableKey(rel.remoteTable.schema, rel.remoteTable.name);
            const aggOrderByKey = `${relKey}.__aggregateOrderBy`;
            const aggOrderBy = orderByTypes.get(aggOrderByKey);
            if (aggOrderBy) {
              fields[`${getRelFieldName(rel)}Aggregate`] = {
                type: aggOrderBy,
                description: `Order by aggregated values of the ${rel.name} array relationship.`,
              };
            }
          }
        }
      }

      return fields;
    },
  });

  // ── Aggregate Sub-Fields (Sum, Avg, Min, Max) ─────────────────────────
  const numericColumns = table.columns.filter((c) =>
    isNumericColumn(c, enumNames) && (!visibleColumns || visibleColumns.has(c.name)),
  );

  // Determine numeric scalar computed fields for aggregate types
  interface ScalarCFInfo { name: string; returnType: string; graphqlTypeName: string; functionName: string; schema: string }
  const numericComputedFields: ScalarCFInfo[] = [];
  const orderableComputedFields: ScalarCFInfo[] = [];
  if (table.computedFields && functions) {
    for (const cf of table.computedFields) {
      const fnSchema = cf.function.schema ?? 'public';
      const fn = functions.find(
        (f) => f.name === cf.function.name && f.schema === fnSchema,
      );
      if (!fn || fn.isSetReturning) continue;
      const mapping = pgTypeToGraphQL(fn.returnType, false, enumNames);
      const info: ScalarCFInfo = {
        name: cf.name,
        returnType: fn.returnType,
        graphqlTypeName: mapping.name,
        functionName: cf.function.name,
        schema: fnSchema,
      };
      if (NUMERIC_GRAPHQL_TYPES.has(mapping.name)) {
        numericComputedFields.push(info);
      }
      if (NUMERIC_GRAPHQL_TYPES.has(mapping.name) || ['String', 'Timestamptz', 'Timestamp', 'Date', 'Time', 'Bpchar'].includes(mapping.name)) {
        orderableComputedFields.push(info);
      }
    }
  }

  const sumFields = new GraphQLObjectType({
    name: `${typeName}SumFields`,
    description: `Sum aggregate fields for ${typeName}.`,
    fields: () => {
      const fields: GraphQLFieldConfigMap<unknown, unknown> = {};
      for (const column of numericColumns) {
        const fieldName = getColumnFieldName(table, column.name);
        const mapping = pgTypeToGraphQL(column.udtName, false, enumNames);
        fields[fieldName] = { type: resolveOutputScalarType(mapping.name) };
      }
      for (const cf of numericComputedFields) {
        const fieldName = toCamelCase(cf.name);
        if (!(fieldName in fields)) {
          fields[fieldName] = { type: resolveOutputScalarType(cf.graphqlTypeName) };
        }
      }
      // Must have at least one field — add a dummy if no numeric columns
      if (Object.keys(fields).length === 0) {
        fields['_dummy'] = { type: GraphQLInt, description: 'Placeholder — no numeric columns' };
      }
      return fields;
    },
  });

  const avgFields = new GraphQLObjectType({
    name: `${typeName}AvgFields`,
    description: `Average aggregate fields for ${typeName}.`,
    fields: () => {
      const fields: GraphQLFieldConfigMap<unknown, unknown> = {};
      for (const column of numericColumns) {
        const fieldName = getColumnFieldName(table, column.name);
        // AVG always returns float/numeric
        fields[fieldName] = { type: GraphQLFloat };
      }
      for (const cf of numericComputedFields) {
        const fieldName = toCamelCase(cf.name);
        if (!(fieldName in fields)) {
          fields[fieldName] = { type: GraphQLFloat };
        }
      }
      if (Object.keys(fields).length === 0) {
        fields['_dummy'] = { type: GraphQLFloat, description: 'Placeholder — no numeric columns' };
      }
      return fields;
    },
  });

  const minFields = new GraphQLObjectType({
    name: `${typeName}MinFields`,
    description: `Min aggregate fields for ${typeName}.`,
    fields: () => {
      const fields: GraphQLFieldConfigMap<unknown, unknown> = {};
      for (const column of table.columns) {
        if (visibleColumns && !visibleColumns.has(column.name)) continue;
        // Min/Max work on any ordered type
        const mapping = pgTypeToGraphQL(column.udtName, false, enumNames);
        if (NUMERIC_GRAPHQL_TYPES.has(mapping.name) || ['String', 'Timestamptz', 'Timestamp', 'Date', 'Time', 'Bpchar'].includes(mapping.name)) {
          const fieldName = getColumnFieldName(table, column.name);
          fields[fieldName] = { type: resolveOutputScalarType(mapping.name) };
        }
      }
      for (const cf of orderableComputedFields) {
        const fieldName = toCamelCase(cf.name);
        if (!(fieldName in fields)) {
          fields[fieldName] = { type: resolveOutputScalarType(cf.graphqlTypeName) };
        }
      }
      if (Object.keys(fields).length === 0) {
        fields['_dummy'] = { type: GraphQLString, description: 'Placeholder — no orderable columns' };
      }
      return fields;
    },
  });

  const maxFields = new GraphQLObjectType({
    name: `${typeName}MaxFields`,
    description: `Max aggregate fields for ${typeName}.`,
    fields: () => {
      const fields: GraphQLFieldConfigMap<unknown, unknown> = {};
      for (const column of table.columns) {
        if (visibleColumns && !visibleColumns.has(column.name)) continue;
        const mapping = pgTypeToGraphQL(column.udtName, false, enumNames);
        if (NUMERIC_GRAPHQL_TYPES.has(mapping.name) || ['String', 'Timestamptz', 'Timestamp', 'Date', 'Time', 'Bpchar'].includes(mapping.name)) {
          const fieldName = getColumnFieldName(table, column.name);
          fields[fieldName] = { type: resolveOutputScalarType(mapping.name) };
        }
      }
      for (const cf of orderableComputedFields) {
        const fieldName = toCamelCase(cf.name);
        if (!(fieldName in fields)) {
          fields[fieldName] = { type: resolveOutputScalarType(cf.graphqlTypeName) };
        }
      }
      if (Object.keys(fields).length === 0) {
        fields['_dummy'] = { type: GraphQLString, description: 'Placeholder — no orderable columns' };
      }
      return fields;
    },
  });

  // ── Statistical Aggregate Sub-Fields (Stddev, Variance family) ──────
  // Helper: build numeric fields (columns + computed fields) for statistical agg types
  function buildStatAggFields(): GraphQLFieldConfigMap<unknown, unknown> {
    const fields: GraphQLFieldConfigMap<unknown, unknown> = {};
    for (const column of numericColumns) {
      const fieldName = getColumnFieldName(table, column.name);
      fields[fieldName] = { type: GraphQLFloat };
    }
    for (const cf of numericComputedFields) {
      const fieldName = toCamelCase(cf.name);
      if (!(fieldName in fields)) {
        fields[fieldName] = { type: GraphQLFloat };
      }
    }
    if (Object.keys(fields).length === 0) {
      fields['_dummy'] = { type: GraphQLFloat, description: 'Placeholder — no numeric columns' };
    }
    return fields;
  }

  const stddevFields = new GraphQLObjectType({
    name: `${typeName}StddevFields`,
    description: `Sample standard deviation aggregate fields for ${typeName}.`,
    fields: () => buildStatAggFields(),
  });

  const stddevPopFields = new GraphQLObjectType({
    name: `${typeName}StddevPopFields`,
    description: `Population standard deviation aggregate fields for ${typeName}.`,
    fields: () => buildStatAggFields(),
  });

  const stddevSampFields = new GraphQLObjectType({
    name: `${typeName}StddevSampFields`,
    description: `Sample standard deviation (alias) aggregate fields for ${typeName}.`,
    fields: () => buildStatAggFields(),
  });

  const varianceFields = new GraphQLObjectType({
    name: `${typeName}VarianceFields`,
    description: `Sample variance aggregate fields for ${typeName}.`,
    fields: () => buildStatAggFields(),
  });

  const varPopFields = new GraphQLObjectType({
    name: `${typeName}VarPopFields`,
    description: `Population variance aggregate fields for ${typeName}.`,
    fields: () => buildStatAggFields(),
  });

  const varSampFields = new GraphQLObjectType({
    name: `${typeName}VarSampFields`,
    description: `Sample variance (alias) aggregate fields for ${typeName}.`,
    fields: () => buildStatAggFields(),
  });

  // ── AggregateFields ───────────────────────────────────────────────────
  const aggregateFields = new GraphQLObjectType({
    name: `${typeName}AggregateFields`,
    description: `Aggregate fields for ${typeName}.`,
    fields: {
      count: {
        type: new GraphQLNonNull(GraphQLInt),
        args: {
          columns: {
            type: new GraphQLList(new GraphQLNonNull(selectColumnEnum)),
            description: 'Select columns to count. If omitted, counts all rows.',
          },
          distinct: {
            type: GraphQLBoolean,
            description: 'If true, count only distinct values.',
          },
        },
      },
      sum: { type: sumFields },
      avg: { type: avgFields },
      min: { type: minFields },
      max: { type: maxFields },
      stddev: { type: stddevFields },
      stddevPop: { type: stddevPopFields },
      stddevSamp: { type: stddevSampFields },
      variance: { type: varianceFields },
      varPop: { type: varPopFields },
      varSamp: { type: varSampFields },
    },
  });

  // ── GroupByKeys ─────────────────────────────────────────────────────────
  const groupByKeys = new GraphQLObjectType({
    name: `${typeName}GroupByKeys`,
    description: `Group-by key columns for ${typeName}.`,
    fields: () => {
      const fields: GraphQLFieldConfigMap<unknown, unknown> = {};
      for (const column of table.columns) {
        if (visibleColumns && !visibleColumns.has(column.name)) continue;
        const fieldName = getColumnFieldName(table, column.name);
        const mapping = pgTypeToGraphQL(column.udtName, column.isArray, enumNames);
        fields[fieldName] = { type: resolveOutputScalarType(mapping.name) };
      }
      // Add scalar computed fields to group-by keys
      if (table.computedFields && functions) {
        for (const cf of table.computedFields) {
          const fnSchema = cf.function.schema ?? 'public';
          const fn = functions.find(
            (f) => f.name === cf.function.name && f.schema === fnSchema,
          );
          if (!fn || fn.isSetReturning) continue;
          const fieldName = toCamelCase(cf.name);
          if (!(fieldName in fields)) {
            const mapping = pgTypeToGraphQL(fn.returnType, false, enumNames);
            fields[fieldName] = { type: resolveOutputScalarType(mapping.name) };
          }
        }
      }
      return fields;
    },
  });

  // ── GroupedAggregate ────────────────────────────────────────────────────
  const groupedAggregate = new GraphQLObjectType({
    name: `${typeName}GroupByAggregate`,
    description: `A single grouped aggregate result for ${typeName}.`,
    fields: {
      keys: {
        type: new GraphQLNonNull(groupByKeys),
        description: 'The values of the grouped columns.',
      },
      count: { type: GraphQLInt },
      sum: { type: sumFields },
      avg: { type: avgFields },
      min: { type: minFields },
      max: { type: maxFields },
      stddev: { type: stddevFields },
      stddevPop: { type: stddevPopFields },
      stddevSamp: { type: stddevSampFields },
      variance: { type: varianceFields },
      varPop: { type: varPopFields },
      varSamp: { type: varSampFields },
    },
  });

  // ── SelectAggregate wrapper (aggregate + nodes + groupedAggregates) ───
  const selectAggregateFields = new GraphQLObjectType({
    name: `${typeName}Aggregate`,
    description: `Aggregated selection for ${typeName}.`,
    fields: {
      aggregate: { type: aggregateFields },
      nodes: {
        type: new GraphQLNonNull(
          new GraphQLList(new GraphQLNonNull(objectType)),
        ),
      },
      groupedAggregates: {
        type: new GraphQLList(new GraphQLNonNull(groupedAggregate)),
        description: 'Per-group aggregates. Only populated when groupBy argument is used.',
      },
    },
  });

  // ── UpdateManyInput ──────────────────────────────────────────────────
  let updateManyInput: GraphQLInputObjectType | null = null;
  if (filterType) {
    updateManyInput = new GraphQLInputObjectType({
      name: `${typeName}UpdateManyInput`,
      description: `Input type for updating multiple rows with different values in ${typeName}. Each entry specifies a WHERE clause and SET values.`,
      fields: () => ({
        where: { type: new GraphQLNonNull(filterType) },
        _set: { type: new GraphQLNonNull(setInput) },
      }),
    });
  }

  // ── MutationResponse ──────────────────────────────────────────────────
  const mutationResponse = new GraphQLObjectType({
    name: `${typeName}MutationResponse`,
    description: `Mutation response for ${typeName}.`,
    fields: {
      affectedRows: {
        type: new GraphQLNonNull(GraphQLInt),
        description: 'Number of rows affected by the mutation.',
      },
      returning: {
        type: new GraphQLNonNull(
          new GraphQLList(new GraphQLNonNull(objectType)),
        ),
        description: 'The rows affected by the mutation.',
      },
    },
  });

  return {
    insertInput,
    onConflict,
    setInput,
    pkColumnsInput,
    orderBy,
    mutationResponse,
    aggregateFields,
    selectAggregateFields,
    constraintEnum,
    updateColumnEnum,
    selectColumnEnum,
    updateManyInput,
  };
}
