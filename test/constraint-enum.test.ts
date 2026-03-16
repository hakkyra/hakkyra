/**
 * Unit tests for Constraint enum generation (P12.17).
 *
 * Verifies that unique indexes (not just unique constraints) are included
 * in the Constraint enums, matching Hasura's behavior.
 */

import { describe, it, expect } from 'vitest';
import { GraphQLObjectType, GraphQLString, GraphQLEnumType } from 'graphql';
import { buildMutationInputTypes } from '../src/schema/inputs.js';
import type { TableInfo } from '../src/types.js';

// Helper: minimal GraphQL object type for buildMutationInputTypes
function dummyObjectType(name: string): GraphQLObjectType {
  return new GraphQLObjectType({
    name,
    fields: { id: { type: GraphQLString } },
  });
}

// Helper: minimal TableInfo for testing constraint enum generation
function makeTable(overrides: Partial<TableInfo> = {}): TableInfo {
  return {
    name: 'test_table',
    schema: 'public',
    columns: [
      { name: 'id', type: 'uuid', udtName: 'uuid', isNullable: false, hasDefault: true, isPrimaryKey: true, isArray: false },
      { name: 'name', type: 'text', udtName: 'text', isNullable: false, hasDefault: false, isPrimaryKey: false, isArray: false },
      { name: 'email', type: 'text', udtName: 'text', isNullable: false, hasDefault: false, isPrimaryKey: false, isArray: false },
      { name: 'code', type: 'text', udtName: 'text', isNullable: true, hasDefault: false, isPrimaryKey: false, isArray: false },
    ],
    primaryKey: ['id'],
    primaryKeyConstraintName: 'test_table_pkey',
    foreignKeys: [],
    uniqueConstraints: [],
    indexes: [],
    relationships: [],
    permissions: { select: {}, insert: {}, update: {}, delete: {} },
    eventTriggers: [],
    ...overrides,
  };
}

describe('Constraint enum — unique index inclusion (P12.17)', () => {
  it('should include unique indexes not backed by constraints', () => {
    const table = makeTable({
      indexes: [
        { name: 'idx_test_table_email', columns: ['email'], isUnique: true },
        { name: 'idx_test_table_name', columns: ['name'], isUnique: false },
      ],
    });

    const result = buildMutationInputTypes(
      table,
      dummyObjectType('TestTable'),
      new Map(),
      new Set(),
    );

    expect(result.constraintEnum).toBeDefined();
    const values = result.constraintEnum!.getValues();

    // PK constraint
    const pk = values.find((v) => v.value === 'test_table_pkey');
    expect(pk).toBeDefined();
    expect(pk!.name).toBe('testTablePkey');

    // Unique index should be included
    const idx = values.find((v) => v.value === 'idx_test_table_email');
    expect(idx).toBeDefined();
    expect(idx!.name).toBe('idxTestTableEmail');

    // Non-unique index should NOT be included
    const nonUnique = values.find((v) => v.value === 'idx_test_table_name');
    expect(nonUnique).toBeUndefined();
  });

  it('should not duplicate indexes that back a unique constraint', () => {
    const table = makeTable({
      uniqueConstraints: [
        { constraintName: 'test_table_email_key', columns: ['email'] },
      ],
      indexes: [
        // This index backs the unique constraint — same name or different but same columns
        { name: 'test_table_email_key', columns: ['email'], isUnique: true },
        // A different unique index
        { name: 'idx_test_table_code', columns: ['code'], isUnique: true },
      ],
    });

    const result = buildMutationInputTypes(
      table,
      dummyObjectType('TestTable2'),
      new Map(),
      new Set(),
    );

    expect(result.constraintEnum).toBeDefined();
    const values = result.constraintEnum!.getValues();

    // PK constraint
    expect(values.find((v) => v.value === 'test_table_pkey')).toBeDefined();

    // Unique constraint
    expect(values.find((v) => v.value === 'test_table_email_key')).toBeDefined();

    // The backing index (same name as the constraint) should NOT create a duplicate
    const emailValues = values.filter((v) => v.value === 'test_table_email_key');
    expect(emailValues.length).toBe(1);

    // The separate unique index should be included
    expect(values.find((v) => v.value === 'idx_test_table_code')).toBeDefined();
    expect(values.find((v) => v.name === 'idxTestTableCode')).toBeDefined();

    // Total: PK + unique constraint + one extra unique index = 3
    expect(values.length).toBe(3);
  });

  it('should create constraint enum from unique indexes alone (no PK, no unique constraints)', () => {
    // Simulates a materialized view with only a unique index
    const table = makeTable({
      primaryKey: [],
      primaryKeyConstraintName: undefined,
      uniqueConstraints: [],
      indexes: [
        { name: 'idx_mv_client_id', columns: ['id'], isUnique: true },
      ],
    });

    const result = buildMutationInputTypes(
      table,
      dummyObjectType('TestMV'),
      new Map(),
      new Set(),
    );

    expect(result.constraintEnum).toBeDefined();
    const values = result.constraintEnum!.getValues();
    expect(values.length).toBe(1);
    expect(values[0].value).toBe('idx_mv_client_id');
    expect(values[0].name).toBe('idxMvClientId');
  });

  it('should return null constraint enum when no PK, no constraints, and no unique indexes', () => {
    const table = makeTable({
      primaryKey: [],
      primaryKeyConstraintName: undefined,
      uniqueConstraints: [],
      indexes: [
        { name: 'idx_some_regular', columns: ['name'], isUnique: false },
      ],
    });

    const result = buildMutationInputTypes(
      table,
      dummyObjectType('TestNoConstraint'),
      new Map(),
      new Set(),
    );

    expect(result.constraintEnum).toBeNull();
  });

  it('should handle multiple unique indexes on the same table', () => {
    const table = makeTable({
      indexes: [
        { name: 'idx_test_email_unique', columns: ['email'], isUnique: true },
        { name: 'idx_test_code_unique', columns: ['code'], isUnique: true },
        { name: 'idx_test_name_regular', columns: ['name'], isUnique: false },
      ],
    });

    const result = buildMutationInputTypes(
      table,
      dummyObjectType('TestMulti'),
      new Map(),
      new Set(),
    );

    expect(result.constraintEnum).toBeDefined();
    const values = result.constraintEnum!.getValues();

    // PK + 2 unique indexes = 3
    expect(values.length).toBe(3);
    expect(values.find((v) => v.value === 'test_table_pkey')).toBeDefined();
    expect(values.find((v) => v.value === 'idx_test_email_unique')).toBeDefined();
    expect(values.find((v) => v.value === 'idx_test_code_unique')).toBeDefined();
    // Non-unique should not be included
    expect(values.find((v) => v.value === 'idx_test_name_regular')).toBeUndefined();
  });

  it('should camelCase unique index names correctly', () => {
    const table = makeTable({
      indexes: [
        { name: 'bonus_name_idx', columns: ['name'], isUnique: true },
        { name: 'campaign_checking_group_idx', columns: ['code'], isUnique: true },
      ],
    });

    const result = buildMutationInputTypes(
      table,
      dummyObjectType('TestCasing'),
      new Map(),
      new Set(),
    );

    expect(result.constraintEnum).toBeDefined();
    const values = result.constraintEnum!.getValues();
    expect(values.find((v) => v.name === 'bonusNameIdx')).toBeDefined();
    expect(values.find((v) => v.name === 'campaignCheckingGroupIdx')).toBeDefined();
  });
});
