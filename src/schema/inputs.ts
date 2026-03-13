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
 * - <Type>AggregateFields   — { count, sum, avg, min, max }
 * - <Type>SumFields / AvgFields / MinFields / MaxFields
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
  GraphQLScalarType,
} from 'graphql';
import type { TableInfo, ColumnInfo } from '../types.js';
import { pgTypeToGraphQL } from '../introspection/type-map.js';
import { customScalars } from './scalars.js';
import { toCamelCase, getTypeName, tableKey } from './type-builder.js';

// ─── OrderBy Direction Enum ─────────────────────────────────────────────────

/** Ordering direction enum, shared across all tables. */
export const OrderByDirection = new GraphQLEnumType({
  name: 'OrderBy',
  description: 'Column ordering direction.',
  values: {
    asc: { value: 'asc' },
    asc_nulls_first: { value: 'asc_nulls_first' },
    asc_nulls_last: { value: 'asc_nulls_last' },
    desc: { value: 'desc' },
    desc_nulls_first: { value: 'desc_nulls_first' },
    desc_nulls_last: { value: 'desc_nulls_last' },
  },
});

// ─── Constraint Enum (for on_conflict) ──────────────────────────────────────

function buildConstraintEnum(table: TableInfo, typeName: string): GraphQLEnumType | null {
  const values: Record<string, { value: string }> = {};

  // Primary key constraint
  if (table.primaryKey.length > 0) {
    // Convention: use pk_<table>
    const pkName = `${table.name}_pkey`;
    values[pkName] = { value: pkName };
  }

  // Unique constraints
  for (const uc of table.uniqueConstraints) {
    values[uc.constraintName] = { value: uc.constraintName };
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
    // camelCase enum value names per graphql-default naming convention
    // Internal value stays as the PG column name for SQL compilation
    const fieldName = toCamelCase(col.name);
    values[fieldName] = { value: col.name };
  }
  return new GraphQLEnumType({
    name: `${typeName}UpdateColumn`,
    description: `Updatable columns for ${typeName}.`,
    values,
  });
}

function buildSelectColumnEnum(table: TableInfo, typeName: string): GraphQLEnumType {
  const values: Record<string, { value: string }> = {};
  for (const col of table.columns) {
    // camelCase enum value names — internal value is the PG column name
    const fieldName = toCamelCase(col.name);
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
    ? new GraphQLList(new GraphQLNonNull(GraphQLString as unknown as GraphQLScalarType))
    : (GraphQLString as unknown as GraphQLScalarType);
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
  return BUILTIN_OUTPUT_SCALARS[graphqlName] ?? customScalars[graphqlName] ?? (GraphQLString as unknown as GraphQLScalarType);
}

// ─── Numeric Check ──────────────────────────────────────────────────────────

const NUMERIC_GRAPHQL_TYPES = new Set(['Int', 'Float', 'BigInt', 'BigDecimal']);

function isNumericColumn(column: ColumnInfo, enumNames: Set<string>): boolean {
  const mapping = pgTypeToGraphQL(column.udtName, false, enumNames);
  return NUMERIC_GRAPHQL_TYPES.has(mapping.name);
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

// ─── Builder ────────────────────────────────────────────────────────────────

/**
 * Build all mutation input types, ordering, and aggregate types for a table.
 */
export function buildMutationInputTypes(
  table: TableInfo,
  objectType: GraphQLObjectType,
  enumTypes: Map<string, GraphQLEnumType>,
  enumNames: Set<string>,
  filterType?: GraphQLInputObjectType,
): MutationInputTypes {
  const typeName = getTypeName(table);

  // ── InsertInput ────────────────────────────────────────────────────────
  const insertInput = new GraphQLInputObjectType({
    name: `${typeName}InsertInput`,
    description: `Input type for inserting a row into ${typeName}.`,
    fields: () => {
      const fields: GraphQLInputFieldConfigMap = {};
      for (const column of table.columns) {
        const fieldName = toCamelCase(column.name);
        let fieldType = columnToInputType(column, enumTypes, enumNames);

        // For insert: columns without defaults and not nullable are required
        if (!column.isNullable && !column.hasDefault) {
          fieldType = new GraphQLNonNull(fieldType);
        }

        fields[fieldName] = {
          type: fieldType,
          description: column.comment,
        };
      }
      return fields;
    },
  });

  // ── Constraint, UpdateColumn, and SelectColumn enums ─────────────────
  const constraintEnum = buildConstraintEnum(table, typeName);
  const updateColumnEnum = buildUpdateColumnEnum(table, typeName);
  const selectColumnEnum = buildSelectColumnEnum(table, typeName);

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
        const fieldName = toCamelCase(column.name);
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
          const fieldName = toCamelCase(column.name);
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
        const fieldName = toCamelCase(column.name);
        fields[fieldName] = { type: OrderByDirection };
      }
      return fields;
    },
  });

  // ── Aggregate Sub-Fields (Sum, Avg, Min, Max) ─────────────────────────
  const numericColumns = table.columns.filter((c) => isNumericColumn(c, enumNames));

  const sumFields = new GraphQLObjectType({
    name: `${typeName}SumFields`,
    description: `Sum aggregate fields for ${typeName}.`,
    fields: () => {
      const fields: GraphQLFieldConfigMap<unknown, unknown> = {};
      for (const column of numericColumns) {
        const fieldName = toCamelCase(column.name);
        const mapping = pgTypeToGraphQL(column.udtName, false, enumNames);
        fields[fieldName] = { type: resolveOutputScalarType(mapping.name) };
      }
      // Must have at least one field — add a dummy if no numeric columns
      if (numericColumns.length === 0) {
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
        const fieldName = toCamelCase(column.name);
        // AVG always returns float/numeric
        fields[fieldName] = { type: GraphQLFloat };
      }
      if (numericColumns.length === 0) {
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
        // Min/Max work on any ordered type
        const mapping = pgTypeToGraphQL(column.udtName, false, enumNames);
        if (NUMERIC_GRAPHQL_TYPES.has(mapping.name) || ['String', 'DateTime', 'Date', 'Time'].includes(mapping.name)) {
          const fieldName = toCamelCase(column.name);
          fields[fieldName] = { type: resolveOutputScalarType(mapping.name) };
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
        const mapping = pgTypeToGraphQL(column.udtName, false, enumNames);
        if (NUMERIC_GRAPHQL_TYPES.has(mapping.name) || ['String', 'DateTime', 'Date', 'Time'].includes(mapping.name)) {
          const fieldName = toCamelCase(column.name);
          fields[fieldName] = { type: resolveOutputScalarType(mapping.name) };
        }
      }
      if (Object.keys(fields).length === 0) {
        fields['_dummy'] = { type: GraphQLString, description: 'Placeholder — no orderable columns' };
      }
      return fields;
    },
  });

  // ── AggregateFields ───────────────────────────────────────────────────
  const aggregateFields = new GraphQLObjectType({
    name: `${typeName}AggregateFields`,
    description: `Aggregate fields for ${typeName}.`,
    fields: {
      count: { type: new GraphQLNonNull(GraphQLInt) },
      sum: { type: sumFields },
      avg: { type: avgFields },
      min: { type: minFields },
      max: { type: maxFields },
    },
  });

  // ── GroupByKeys ─────────────────────────────────────────────────────────
  const groupByKeys = new GraphQLObjectType({
    name: `${typeName}GroupByKeys`,
    description: `Group-by key columns for ${typeName}.`,
    fields: () => {
      const fields: GraphQLFieldConfigMap<unknown, unknown> = {};
      for (const column of table.columns) {
        const fieldName = toCamelCase(column.name);
        const mapping = pgTypeToGraphQL(column.udtName, column.isArray, enumNames);
        fields[fieldName] = { type: resolveOutputScalarType(mapping.name) };
      }
      return fields;
    },
  });

  // ── GroupedAggregate ────────────────────────────────────────────────────
  const groupedAggregate = new GraphQLObjectType({
    name: `${typeName}GroupedAggregate`,
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
