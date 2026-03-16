/**
 * Tests for P9.16 — Schema column visibility.
 *
 * Verifies that object types, SelectColumn enums, OrderBy inputs,
 * BoolExp inputs, and aggregate types only expose columns that appear
 * in at least one role's select permission.
 */

import { describe, it, expect } from 'vitest';
import {
  GraphQLObjectType,
  GraphQLInputObjectType,
  GraphQLEnumType,
} from 'graphql';
import { generateSchema } from '../src/schema/generator.js';
import type { SchemaModel, TableInfo, ColumnInfo } from '../src/types.js';
import { getVisibleColumns } from '../src/schema/type-builder.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeColumn(name: string, opts?: Partial<ColumnInfo>): ColumnInfo {
  return {
    name,
    type: 'text',
    udtName: 'text',
    isNullable: true,
    hasDefault: false,
    isPrimaryKey: false,
    isArray: false,
    ...opts,
  };
}

function makeNumericColumn(name: string, opts?: Partial<ColumnInfo>): ColumnInfo {
  return makeColumn(name, { type: 'integer', udtName: 'int4', ...opts });
}

function makeTable(overrides: Partial<TableInfo> & { name: string }): TableInfo {
  return {
    schema: 'public',
    columns: [],
    primaryKey: [],
    foreignKeys: [],
    uniqueConstraints: [],
    indexes: [],
    relationships: [],
    permissions: { select: {}, insert: {}, update: {}, delete: {} },
    eventTriggers: [],
    ...overrides,
  };
}

function makeModel(tables: TableInfo[]): SchemaModel {
  return {
    tables,
    enums: [],
    functions: [],
    trackedFunctions: [],
    nativeQueries: [],
    logicalModels: [],
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('getVisibleColumns', () => {
  it('returns null when no select permissions exist', () => {
    const table = makeTable({
      name: 'empty',
      columns: [makeColumn('id'), makeColumn('secret')],
    });
    expect(getVisibleColumns(table)).toBeNull();
  });

  it('returns null when any role has wildcard columns', () => {
    const table = makeTable({
      name: 'wildcard',
      columns: [makeColumn('id'), makeColumn('secret')],
      permissions: {
        select: {
          user: { columns: ['id'], filter: {} },
          admin: { columns: '*', filter: {} },
        },
        insert: {},
        update: {},
        delete: {},
      },
    });
    expect(getVisibleColumns(table)).toBeNull();
  });

  it('returns union of columns from all roles', () => {
    const table = makeTable({
      name: 'restricted',
      columns: [
        makeColumn('id'),
        makeColumn('name'),
        makeColumn('email'),
        makeColumn('secret'),
      ],
      permissions: {
        select: {
          user: { columns: ['id', 'name'], filter: {} },
          manager: { columns: ['id', 'email'], filter: {} },
        },
        insert: {},
        update: {},
        delete: {},
      },
    });
    const visible = getVisibleColumns(table);
    expect(visible).toEqual(new Set(['id', 'name', 'email']));
  });
});

describe('Schema column visibility (P9.16)', () => {
  /**
   * Build a schema with one table that has restricted select permissions.
   * Columns: id, name, email, secret, score
   * Role "user" can select: id, name
   * Role "manager" can select: id, name, email, score
   * Expected visible columns: id, name, email, score (NOT secret)
   */
  function buildTestSchema() {
    const table = makeTable({
      name: 'person',
      columns: [
        makeColumn('id', { isNullable: false, isPrimaryKey: true }),
        makeColumn('name', { isNullable: false }),
        makeColumn('email'),
        makeColumn('secret'),
        makeNumericColumn('score'),
      ],
      primaryKey: ['id'],
      permissions: {
        select: {
          user: { columns: ['id', 'name'], filter: {} },
          manager: { columns: ['id', 'name', 'email', 'score'], filter: {} },
        },
        insert: {},
        update: {},
        delete: {},
      },
    });

    const model = makeModel([table]);
    const schema = generateSchema(model);
    return { schema, table };
  }

  it('object type should only have visible columns', () => {
    const { schema } = buildTestSchema();
    const personType = schema.getType('Person') as GraphQLObjectType;
    expect(personType).toBeDefined();
    const fields = Object.keys(personType.getFields());
    expect(fields).toContain('id');
    expect(fields).toContain('name');
    expect(fields).toContain('email');
    expect(fields).toContain('score');
    expect(fields).not.toContain('secret');
  });

  it('SelectColumn enum should only have visible columns', () => {
    const { schema } = buildTestSchema();
    const selectEnum = schema.getType('PersonSelectColumn') as GraphQLEnumType;
    expect(selectEnum).toBeDefined();
    const values = Object.keys(selectEnum.getValues().reduce(
      (acc, v) => ({ ...acc, [v.name]: true }), {} as Record<string, boolean>,
    ));
    expect(values).toContain('id');
    expect(values).toContain('name');
    expect(values).toContain('email');
    expect(values).toContain('score');
    expect(values).not.toContain('secret');
  });

  it('OrderBy input should only have visible columns', () => {
    const { schema } = buildTestSchema();
    const orderByType = schema.getType('PersonOrderBy') as GraphQLInputObjectType;
    expect(orderByType).toBeDefined();
    const fields = Object.keys(orderByType.getFields());
    expect(fields).toContain('id');
    expect(fields).toContain('name');
    expect(fields).toContain('email');
    expect(fields).toContain('score');
    expect(fields).not.toContain('secret');
  });

  it('BoolExp input should only have visible columns', () => {
    const { schema } = buildTestSchema();
    const boolExpType = schema.getType('PersonBoolExp') as GraphQLInputObjectType;
    expect(boolExpType).toBeDefined();
    const fields = Object.keys(boolExpType.getFields());
    expect(fields).toContain('id');
    expect(fields).toContain('name');
    expect(fields).toContain('email');
    expect(fields).toContain('score');
    expect(fields).not.toContain('secret');
    // Should still have logical combinators
    expect(fields).toContain('_and');
    expect(fields).toContain('_or');
    expect(fields).toContain('_not');
  });

  it('MinFields should only have visible orderable columns', () => {
    const { schema } = buildTestSchema();
    const minType = schema.getType('PersonMinFields') as GraphQLObjectType;
    expect(minType).toBeDefined();
    const fields = Object.keys(minType.getFields());
    // name, email, id are String/orderable; score is numeric/orderable
    expect(fields).toContain('id');
    expect(fields).toContain('name');
    expect(fields).toContain('email');
    expect(fields).toContain('score');
    expect(fields).not.toContain('secret');
  });

  it('MaxFields should only have visible orderable columns', () => {
    const { schema } = buildTestSchema();
    const maxType = schema.getType('PersonMaxFields') as GraphQLObjectType;
    expect(maxType).toBeDefined();
    const fields = Object.keys(maxType.getFields());
    expect(fields).toContain('id');
    expect(fields).toContain('name');
    expect(fields).toContain('email');
    expect(fields).toContain('score');
    expect(fields).not.toContain('secret');
  });

  it('SumFields should only have visible numeric columns', () => {
    const { schema } = buildTestSchema();
    const sumType = schema.getType('PersonSumFields') as GraphQLObjectType;
    expect(sumType).toBeDefined();
    const fields = Object.keys(sumType.getFields());
    expect(fields).toContain('score');
    expect(fields).not.toContain('secret');
  });

  it('AvgFields should only have visible numeric columns', () => {
    const { schema } = buildTestSchema();
    const avgType = schema.getType('PersonAvgFields') as GraphQLObjectType;
    expect(avgType).toBeDefined();
    const fields = Object.keys(avgType.getFields());
    expect(fields).toContain('score');
    expect(fields).not.toContain('secret');
  });

  it('GroupByKeys should only have visible columns', () => {
    const { schema } = buildTestSchema();
    const groupByType = schema.getType('PersonGroupByKeys') as GraphQLObjectType;
    expect(groupByType).toBeDefined();
    const fields = Object.keys(groupByType.getFields());
    expect(fields).toContain('id');
    expect(fields).toContain('name');
    expect(fields).toContain('email');
    expect(fields).toContain('score');
    expect(fields).not.toContain('secret');
  });

  it('StreamCursorValueInput should only have visible columns', () => {
    const { schema } = buildTestSchema();
    const cursorType = schema.getType('PersonStreamCursorValueInput') as GraphQLInputObjectType;
    expect(cursorType).toBeDefined();
    const fields = Object.keys(cursorType.getFields());
    expect(fields).toContain('id');
    expect(fields).toContain('name');
    expect(fields).toContain('email');
    expect(fields).toContain('score');
    expect(fields).not.toContain('secret');
  });

  it('InsertInput should still include ALL columns (not filtered)', () => {
    const { schema } = buildTestSchema();
    const insertType = schema.getType('PersonInsertInput') as GraphQLInputObjectType;
    expect(insertType).toBeDefined();
    const fields = Object.keys(insertType.getFields());
    // InsertInput is not filtered by select permissions — it's governed by insert permissions at runtime
    expect(fields).toContain('id');
    expect(fields).toContain('name');
    expect(fields).toContain('email');
    expect(fields).toContain('secret');
    expect(fields).toContain('score');
  });

  it('SetInput should still include ALL columns (not filtered)', () => {
    const { schema } = buildTestSchema();
    const setType = schema.getType('PersonSetInput') as GraphQLInputObjectType;
    expect(setType).toBeDefined();
    const fields = Object.keys(setType.getFields());
    // SetInput is not filtered by select permissions
    expect(fields).toContain('id');
    expect(fields).toContain('name');
    expect(fields).toContain('email');
    expect(fields).toContain('secret');
    expect(fields).toContain('score');
  });

  describe('wildcard permissions expose all columns', () => {
    it('should expose all columns when any role has columns: "*"', () => {
      const table = makeTable({
        name: 'item',
        columns: [
          makeColumn('id', { isNullable: false, isPrimaryKey: true }),
          makeColumn('name'),
          makeColumn('hidden'),
        ],
        primaryKey: ['id'],
        permissions: {
          select: {
            user: { columns: ['id', 'name'], filter: {} },
            admin: { columns: '*', filter: {} },
          },
          insert: {},
          update: {},
          delete: {},
        },
      });

      const model = makeModel([table]);
      const schema = generateSchema(model);
      const itemType = schema.getType('Item') as GraphQLObjectType;
      const fields = Object.keys(itemType.getFields());
      expect(fields).toContain('id');
      expect(fields).toContain('name');
      expect(fields).toContain('hidden');
    });
  });

  describe('no select permissions exposes all columns', () => {
    it('should expose all columns when table has no select permissions', () => {
      const table = makeTable({
        name: 'internal',
        columns: [
          makeColumn('id', { isNullable: false, isPrimaryKey: true }),
          makeColumn('data'),
        ],
        primaryKey: ['id'],
      });

      const model = makeModel([table]);
      const schema = generateSchema(model);
      const internalType = schema.getType('Internal') as GraphQLObjectType;
      const fields = Object.keys(internalType.getFields());
      expect(fields).toContain('id');
      expect(fields).toContain('data');
    });
  });
});
