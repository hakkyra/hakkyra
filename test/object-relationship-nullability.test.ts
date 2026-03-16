/**
 * Unit tests for object relationship nullability logic in buildObjectType.
 *
 * P12.9 — Verifies the five nullability rules:
 * 1. Forward FK with NOT NULL columns → non-null
 * 2. Forward FK with nullable columns → nullable
 * 3. Reverse FK → always nullable
 * 4. Manual configuration (columnMapping) → always nullable
 * 5. Manual configuration that shares a name with auto-detected FK → always nullable
 *
 * Uses synthetic TableInfo objects — no database required.
 */

import { describe, it, expect } from 'vitest';
import {
  GraphQLObjectType,
  GraphQLNonNull,
  GraphQLList,
  GraphQLString,
} from 'graphql';
import { buildObjectType, tableKey } from '../src/schema/type-builder.js';
import type { TypeRegistry } from '../src/schema/type-builder.js';
import type { TableInfo, ColumnInfo, ForeignKeyInfo, RelationshipConfig } from '../src/types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeColumn(overrides: Partial<ColumnInfo> & { name: string }): ColumnInfo {
  return {
    type: 'uuid',
    udtName: 'uuid',
    isNullable: false,
    hasDefault: false,
    isPrimaryKey: false,
    isArray: false,
    ...overrides,
  };
}

function makeTable(overrides: Partial<TableInfo> & { name: string }): TableInfo {
  return {
    schema: 'public',
    columns: [],
    primaryKey: ['id'],
    foreignKeys: [],
    uniqueConstraints: [],
    indexes: [],
    relationships: [],
    permissions: { select: {}, insert: {}, update: {}, delete: {} },
    eventTriggers: [],
    ...overrides,
  };
}

function makeRegistry(types: [string, string][]): TypeRegistry {
  const registry: TypeRegistry = new Map();
  for (const [schema, name] of types) {
    const key = tableKey(schema, name);
    registry.set(
      key,
      new GraphQLObjectType({ name: name.charAt(0).toUpperCase() + name.slice(1), fields: { id: { type: GraphQLString } } }),
    );
  }
  return registry;
}

function getFieldNullability(
  table: TableInfo,
  fieldName: string,
  registry?: TypeRegistry,
): { exists: boolean; isNonNull: boolean; isList: boolean } {
  const reg = registry ?? makeRegistry([['public', 'remote']]);
  const enumTypes = new Map();
  const enumNames = new Set<string>();
  const objType = buildObjectType(table, reg, enumTypes, enumNames);
  const fields = objType.getFields();
  const field = fields[fieldName];
  if (!field) return { exists: false, isNonNull: false, isList: false };
  return {
    exists: true,
    isNonNull: field.type instanceof GraphQLNonNull,
    isList: field.type instanceof GraphQLList ||
      (field.type instanceof GraphQLNonNull && (field.type as GraphQLNonNull<any>).ofType instanceof GraphQLList),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Object relationship nullability (P12.9)', () => {
  describe('Forward FK relationships', () => {
    it('should be non-null when FK column is NOT NULL', () => {
      const table = makeTable({
        name: 'order',
        columns: [
          makeColumn({ name: 'id', isPrimaryKey: true }),
          makeColumn({ name: 'customer_id', isNullable: false }),
        ],
        foreignKeys: [
          {
            constraintName: 'order_customer_fk',
            columns: ['customer_id'],
            referencedSchema: 'public',
            referencedTable: 'customer',
            referencedColumns: ['id'],
          },
        ],
        relationships: [
          {
            name: 'customer',
            type: 'object',
            remoteTable: { name: 'customer', schema: 'public' },
            localColumns: ['customer_id'],
            remoteColumns: ['id'],
          },
        ],
      });

      const registry = makeRegistry([['public', 'customer']]);
      const result = getFieldNullability(table, 'customer', registry);
      expect(result.exists).toBe(true);
      expect(result.isNonNull).toBe(true);
    });

    it('should be nullable when FK column is nullable', () => {
      const table = makeTable({
        name: 'order',
        columns: [
          makeColumn({ name: 'id', isPrimaryKey: true }),
          makeColumn({ name: 'assignee_id', isNullable: true }),
        ],
        foreignKeys: [
          {
            constraintName: 'order_assignee_fk',
            columns: ['assignee_id'],
            referencedSchema: 'public',
            referencedTable: 'user',
            referencedColumns: ['id'],
          },
        ],
        relationships: [
          {
            name: 'assignee',
            type: 'object',
            remoteTable: { name: 'user', schema: 'public' },
            localColumns: ['assignee_id'],
            remoteColumns: ['id'],
          },
        ],
      });

      const registry = makeRegistry([['public', 'user']]);
      const result = getFieldNullability(table, 'assignee', registry);
      expect(result.exists).toBe(true);
      expect(result.isNonNull).toBe(false);
    });

    it('should be non-null for composite FK with all NOT NULL columns', () => {
      const table = makeTable({
        name: 'report',
        columns: [
          makeColumn({ name: 'id', isPrimaryKey: true }),
          makeColumn({ name: 'year', isNullable: false, udtName: 'int4', type: 'integer' }),
          makeColumn({ name: 'quarter', isNullable: false, udtName: 'int4', type: 'integer' }),
        ],
        foreignKeys: [
          {
            constraintName: 'report_period_fk',
            columns: ['year', 'quarter'],
            referencedSchema: 'public',
            referencedTable: 'period',
            referencedColumns: ['year', 'quarter'],
          },
        ],
        relationships: [
          {
            name: 'period',
            type: 'object',
            remoteTable: { name: 'period', schema: 'public' },
            localColumns: ['year', 'quarter'],
            remoteColumns: ['year', 'quarter'],
          },
        ],
      });

      const registry = makeRegistry([['public', 'period']]);
      const result = getFieldNullability(table, 'period', registry);
      expect(result.exists).toBe(true);
      expect(result.isNonNull).toBe(true);
    });

    it('should be nullable for composite FK where one column is nullable', () => {
      const table = makeTable({
        name: 'report',
        columns: [
          makeColumn({ name: 'id', isPrimaryKey: true }),
          makeColumn({ name: 'year', isNullable: false, udtName: 'int4', type: 'integer' }),
          makeColumn({ name: 'quarter', isNullable: true, udtName: 'int4', type: 'integer' }),
        ],
        foreignKeys: [
          {
            constraintName: 'report_period_fk',
            columns: ['year', 'quarter'],
            referencedSchema: 'public',
            referencedTable: 'period',
            referencedColumns: ['year', 'quarter'],
          },
        ],
        relationships: [
          {
            name: 'period',
            type: 'object',
            remoteTable: { name: 'period', schema: 'public' },
            localColumns: ['year', 'quarter'],
            remoteColumns: ['year', 'quarter'],
          },
        ],
      });

      const registry = makeRegistry([['public', 'period']]);
      const result = getFieldNullability(table, 'period', registry);
      expect(result.exists).toBe(true);
      expect(result.isNonNull).toBe(false);
    });
  });

  describe('Reverse FK relationships', () => {
    it('should always be nullable even when local PK columns are NOT NULL', () => {
      // Simulates: Player.lock where FK is on player_lock.player_id → player.id
      // After merger post-process: localColumns = ['id'], remoteColumns = ['player_id']
      const table = makeTable({
        name: 'player',
        columns: [
          makeColumn({ name: 'id', isPrimaryKey: true, isNullable: false }),
          makeColumn({ name: 'name', udtName: 'text', type: 'text' }),
        ],
        // Player does NOT have a FK to player_lock — the FK is the other way
        foreignKeys: [],
        relationships: [
          {
            name: 'lock',
            type: 'object',
            remoteTable: { name: 'player_lock', schema: 'public' },
            localColumns: ['id'],       // inferred by post-process
            remoteColumns: ['player_id'], // from metadata config
          },
        ],
      });

      const registry = makeRegistry([['public', 'player_lock']]);
      const result = getFieldNullability(table, 'lock', registry);
      expect(result.exists).toBe(true);
      expect(result.isNonNull).toBe(false);
    });

    it('should be nullable even if local table has an unrelated FK to the same remote table', () => {
      // Edge case: table A has FK a.other_col → B.other_col (unrelated FK),
      // but the relationship is a reverse FK from B.a_id → A.id.
      // The isForwardFK check must not be confused by the unrelated FK.
      const table = makeTable({
        name: 'a_table',
        columns: [
          makeColumn({ name: 'id', isPrimaryKey: true }),
          makeColumn({ name: 'b_ref', isNullable: false }),
        ],
        foreignKeys: [
          {
            constraintName: 'a_b_ref_fk',
            columns: ['b_ref'],
            referencedSchema: 'public',
            referencedTable: 'b_table',
            referencedColumns: ['other_col'],
          },
        ],
        relationships: [
          {
            name: 'reverseB',
            type: 'object',
            remoteTable: { name: 'b_table', schema: 'public' },
            localColumns: ['id'],         // inferred as PK (reverse FK)
            remoteColumns: ['a_table_id'],
          },
        ],
      });

      const registry = makeRegistry([['public', 'b_table']]);
      const result = getFieldNullability(table, 'reverseB', registry);
      expect(result.exists).toBe(true);
      // localColumns=['id'] does not match FK columns=['b_ref'], so isForwardFK=false
      expect(result.isNonNull).toBe(false);
    });
  });

  describe('Manual configuration relationships', () => {
    it('should always be nullable when columnMapping is present', () => {
      const table = makeTable({
        name: 'summary_view',
        columns: [
          makeColumn({ name: 'id', isPrimaryKey: true }),
          makeColumn({ name: 'customer_id', isNullable: false }),
        ],
        // Views typically have no FK constraints
        foreignKeys: [],
        relationships: [
          {
            name: 'customer',
            type: 'object',
            remoteTable: { name: 'customer', schema: 'public' },
            columnMapping: { customer_id: 'id' },
          },
        ],
      });

      const registry = makeRegistry([['public', 'customer']]);
      const result = getFieldNullability(table, 'customer', registry);
      expect(result.exists).toBe(true);
      expect(result.isNonNull).toBe(false);
    });

    it('should be nullable even when columnMapping matches a real FK with NOT NULL columns', () => {
      // This is the key P12.9 edge case: a manual_configuration relationship
      // that happens to use the same columns as a real FK constraint.
      // After merger, it may inherit localColumns from the auto-detected rel.
      // Hasura treats manual_configuration as always nullable regardless.
      const table = makeTable({
        name: 'report',
        columns: [
          makeColumn({ name: 'id', isPrimaryKey: true }),
          makeColumn({ name: 'year', isNullable: false, udtName: 'int4', type: 'integer' }),
          makeColumn({ name: 'quarter', isNullable: false, udtName: 'int4', type: 'integer' }),
        ],
        foreignKeys: [
          {
            constraintName: 'report_period_fk',
            columns: ['year', 'quarter'],
            referencedSchema: 'public',
            referencedTable: 'period',
            referencedColumns: ['year', 'quarter'],
          },
        ],
        relationships: [
          {
            name: 'period',
            type: 'object',
            remoteTable: { name: 'period', schema: 'public' },
            // columnMapping from manual_configuration
            columnMapping: { year: 'year', quarter: 'quarter' },
            // localColumns inherited from auto-detected FK during merge
            localColumns: ['year', 'quarter'],
            remoteColumns: ['year', 'quarter'],
            fromMetadata: true,
          },
        ],
      });

      const registry = makeRegistry([['public', 'period']]);
      const result = getFieldNullability(table, 'period', registry);
      expect(result.exists).toBe(true);
      // Even though there's a real FK with NOT NULL columns, manual_configuration
      // relationships are always nullable in Hasura
      expect(result.isNonNull).toBe(false);
    });

    it('should be nullable when columnMapping matches a single-column FK with NOT NULL', () => {
      // Single-column version of the merge edge case
      const table = makeTable({
        name: 'wallet',
        columns: [
          makeColumn({ name: 'id', isPrimaryKey: true }),
          makeColumn({ name: 'balance_id', isNullable: false }),
        ],
        foreignKeys: [
          {
            constraintName: 'wallet_balance_fk',
            columns: ['balance_id'],
            referencedSchema: 'public',
            referencedTable: 'balance',
            referencedColumns: ['id'],
          },
        ],
        relationships: [
          {
            name: 'balance',
            type: 'object',
            remoteTable: { name: 'balance', schema: 'public' },
            columnMapping: { balance_id: 'id' },
            // localColumns inherited from auto-detected FK during merge
            localColumns: ['balance_id'],
            remoteColumns: ['id'],
            fromMetadata: true,
          },
        ],
      });

      const registry = makeRegistry([['public', 'balance']]);
      const result = getFieldNullability(table, 'balance', registry);
      expect(result.exists).toBe(true);
      expect(result.isNonNull).toBe(false);
    });
  });

  describe('Array relationships', () => {
    it('should always be [Type!]! (non-null list of non-null items)', () => {
      const table = makeTable({
        name: 'customer',
        columns: [
          makeColumn({ name: 'id', isPrimaryKey: true }),
        ],
        relationships: [
          {
            name: 'orders',
            type: 'array',
            remoteTable: { name: 'order', schema: 'public' },
            localColumns: ['id'],
            remoteColumns: ['customer_id'],
          },
        ],
      });

      const registry = makeRegistry([['public', 'order']]);
      const objType = buildObjectType(table, registry, new Map(), new Set());
      const fields = objType.getFields();
      const ordersField = fields['orders'];
      expect(ordersField).toBeDefined();
      // Outer: NonNull
      expect(ordersField.type).toBeInstanceOf(GraphQLNonNull);
      const outerNonNull = ordersField.type as GraphQLNonNull<any>;
      // Middle: List
      expect(outerNonNull.ofType).toBeInstanceOf(GraphQLList);
      const list = outerNonNull.ofType as GraphQLList<any>;
      // Inner: NonNull
      expect(list.ofType).toBeInstanceOf(GraphQLNonNull);
    });
  });

  describe('No localColumns (empty relationship)', () => {
    it('should be nullable when localColumns is undefined', () => {
      const table = makeTable({
        name: 'view_table',
        columns: [
          makeColumn({ name: 'id', isPrimaryKey: true }),
        ],
        foreignKeys: [],
        relationships: [
          {
            name: 'related',
            type: 'object',
            remoteTable: { name: 'remote', schema: 'public' },
            // No localColumns, no remoteColumns, no columnMapping
          },
        ],
      });

      const registry = makeRegistry([['public', 'remote']]);
      const result = getFieldNullability(table, 'related', registry);
      expect(result.exists).toBe(true);
      expect(result.isNonNull).toBe(false);
    });

    it('should be nullable when localColumns is empty array', () => {
      const table = makeTable({
        name: 'view_table',
        columns: [
          makeColumn({ name: 'id', isPrimaryKey: true }),
        ],
        foreignKeys: [],
        relationships: [
          {
            name: 'related',
            type: 'object',
            remoteTable: { name: 'remote', schema: 'public' },
            localColumns: [],
          },
        ],
      });

      const registry = makeRegistry([['public', 'remote']]);
      const result = getFieldNullability(table, 'related', registry);
      expect(result.exists).toBe(true);
      expect(result.isNonNull).toBe(false);
    });
  });

  describe('SETOF computed fields', () => {
    it('should be [Type!]! for set-returning computed fields', () => {
      const table = makeTable({
        name: 'customer',
        columns: [
          makeColumn({ name: 'id', isPrimaryKey: true }),
        ],
        computedFields: [
          {
            name: 'active_orders',
            function: { name: 'customer_active_orders', schema: 'public' },
          },
        ],
      });

      const registry = makeRegistry([['public', 'order']]);
      const functions = [
        {
          name: 'customer_active_orders',
          schema: 'public',
          returnType: 'order',
          argTypes: ['customer'],
          argNames: ['customer_row'],
          isSetReturning: true,
          volatility: 'stable' as const,
          numArgsWithDefaults: 0,
        },
      ];

      const objType = buildObjectType(table, registry, new Map(), new Set(), undefined, undefined, functions);
      const fields = objType.getFields();
      const computedField = fields['activeOrders'];
      expect(computedField).toBeDefined();
      // Should be [Order!]!
      expect(computedField.type).toBeInstanceOf(GraphQLNonNull);
      const outerNonNull = computedField.type as GraphQLNonNull<any>;
      expect(outerNonNull.ofType).toBeInstanceOf(GraphQLList);
      const list = outerNonNull.ofType as GraphQLList<any>;
      expect(list.ofType).toBeInstanceOf(GraphQLNonNull);
    });
  });
});
