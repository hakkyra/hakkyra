/**
 * P12.2 — IncInput types for numeric column increments during updates.
 *
 * Tests:
 * 1. Schema generation: IncInput types exist with correct numeric fields
 * 2. Schema generation: _inc argument present on update mutations
 * 3. SQL compiler: _inc generates "column = column + $N" SQL
 * 4. SQL compiler: _inc + _set combined, _set takes precedence
 * 5. SQL compiler: _inc only (no _set)
 * 6. E2E: increment a numeric column and verify the value changed
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  GraphQLSchema,
  GraphQLInputObjectType,
  GraphQLNonNull,
  GraphQLList,
} from 'graphql';
import { generateSchema } from '../src/schema/generator.js';
import { resetComparisonTypeCache } from '../src/schema/filters.js';
import { introspectDatabase } from '../src/introspection/introspector.js';
import { mergeSchemaModel, resolveTableEnums } from '../src/introspection/merger.js';
import { loadConfig } from '../src/config/loader.js';
import { compileUpdateByPk, compileUpdate } from '../src/sql/update.js';
import type { SchemaModel, TableInfo, BoolExp } from '../src/types.js';
import {
  getPool,
  closePool,
  waitForDb,
  METADATA_DIR,
  SERVER_CONFIG_PATH,
  TEST_DB_URL,
  ACCOUNT_ALICE_ID,
} from './setup.js';

let schemaModel: SchemaModel;
let schema: GraphQLSchema;

function findTable(name: string): TableInfo {
  const table = schemaModel.tables.find((t) => t.name === name);
  if (!table) throw new Error(`Table ${name} not found in schema model`);
  return table;
}

function makeSession(role: string) {
  return {
    role,
    'x-hasura-role': role,
    isAdmin: role === 'admin',
  } as any;
}

beforeAll(async () => {
  process.env['DATABASE_URL'] = TEST_DB_URL;
  await waitForDb();
  const pool = getPool();
  const introspection = await introspectDatabase(pool);
  const config = await loadConfig(METADATA_DIR, SERVER_CONFIG_PATH);
  const result = mergeSchemaModel(introspection, config);
  schemaModel = result.model;
  await resolveTableEnums(schemaModel, pool);
  resetComparisonTypeCache();
  schema = generateSchema(schemaModel, {
    actions: config.actions,
    actionsGraphql: config.actionsGraphql,
  });
});

afterAll(async () => {
  await closePool();
});

// ─── Schema Generation Tests ─────────────────────────────────────────────────

describe('P12.2 — IncInput schema generation', () => {
  it('should generate AccountIncInput type with numeric fields only', () => {
    const typeMap = schema.getTypeMap();
    const incInput = typeMap['AccountIncInput'];
    expect(incInput).toBeDefined();
    expect(incInput).toBeInstanceOf(GraphQLInputObjectType);

    const fields = (incInput as GraphQLInputObjectType).getFields();
    const fieldNames = Object.keys(fields);

    // Account has: balance, credit_balance, pending_balance (all numeric)
    expect(fieldNames).toContain('balance');
    expect(fieldNames).toContain('creditBalance');
    expect(fieldNames).toContain('pendingBalance');

    // Non-numeric columns should NOT be present
    expect(fieldNames).not.toContain('id');
    expect(fieldNames).not.toContain('clientId');
    expect(fieldNames).not.toContain('currencyId');
    expect(fieldNames).not.toContain('active');
    expect(fieldNames).not.toContain('createdAt');
    expect(fieldNames).not.toContain('updatedAt');
  });

  it('should generate ClientIncInput with only the trustLevel numeric field', () => {
    const typeMap = schema.getTypeMap();
    const incInput = typeMap['ClientIncInput'];
    expect(incInput).toBeDefined();
    expect(incInput).toBeInstanceOf(GraphQLInputObjectType);

    const fields = (incInput as GraphQLInputObjectType).getFields();
    const fieldNames = Object.keys(fields);

    // Client has trust_level (int)
    expect(fieldNames).toContain('trustLevel');

    // Non-numeric columns should not appear
    expect(fieldNames).not.toContain('id');
    expect(fieldNames).not.toContain('username');
    expect(fieldNames).not.toContain('email');
    expect(fieldNames).not.toContain('status');
  });

  it('should NOT generate IncInput for tables with no numeric columns', () => {
    const typeMap = schema.getTypeMap();
    // Country table has only id (text PK) and name (text) — no numeric columns
    expect(typeMap['CountryIncInput']).toBeUndefined();
    // Language table: id (text PK), name (text) — no numeric columns
    expect(typeMap['LanguageIncInput']).toBeUndefined();
  });

  it('should add _inc argument to updateAccount mutation', () => {
    const mutationType = schema.getMutationType()!;
    const updateField = mutationType.getFields()['updateAccount'];
    expect(updateField).toBeDefined();

    const argNames = updateField.args.map((a) => a.name);
    expect(argNames).toContain('_inc');

    const incArg = updateField.args.find((a) => a.name === '_inc');
    expect(incArg).toBeDefined();
    // Should be optional (nullable), not NonNull
    expect(incArg!.type).not.toBeInstanceOf(GraphQLNonNull);
  });

  it('should add _inc argument to updateAccountByPk mutation', () => {
    const mutationType = schema.getMutationType()!;
    const updateByPkField = mutationType.getFields()['updateAccountByPk'];
    expect(updateByPkField).toBeDefined();

    const argNames = updateByPkField.args.map((a) => a.name);
    expect(argNames).toContain('_inc');
  });

  it('should add _inc field to updateAccountMany input type', () => {
    const typeMap = schema.getTypeMap();
    const updateManyInput = typeMap['AccountUpdateManyInput'];
    expect(updateManyInput).toBeDefined();
    expect(updateManyInput).toBeInstanceOf(GraphQLInputObjectType);

    const fields = (updateManyInput as GraphQLInputObjectType).getFields();
    expect(fields['_inc']).toBeDefined();
  });

  it('should NOT add _inc argument to update mutations on tables with no numeric columns', () => {
    const mutationType = schema.getMutationType()!;
    const updateCountry = mutationType.getFields()['updateCountry'];
    if (updateCountry) {
      const argNames = updateCountry.args.map((a) => a.name);
      expect(argNames).not.toContain('_inc');
    }
  });
});

// ─── SQL Compiler Tests ──────────────────────────────────────────────────────

describe('P12.2 — IncInput SQL compilation', () => {
  const adminSession = makeSession('admin');

  it('should compile _inc as "column = column + $N" in UPDATE BY PK', () => {
    const table = findTable('account');
    const compiled = compileUpdateByPk({
      table,
      pkValues: { id: ACCOUNT_ALICE_ID },
      _set: {},
      _inc: { balance: 100 },
      returningColumns: ['id', 'balance'],
      session: adminSession,
    });

    expect(compiled.sql).toContain('"balance" = "balance" + $');
    expect(compiled.params).toContain(100);
  });

  it('should compile _inc as "column = column + $N" in bulk UPDATE', () => {
    const table = findTable('account');
    const compiled = compileUpdate({
      table,
      where: { active: { _eq: true } } as BoolExp,
      _set: {},
      _inc: { credit_balance: 50 },
      returningColumns: ['id', 'credit_balance'],
      session: adminSession,
    });

    expect(compiled.sql).toContain('"credit_balance" = "credit_balance" + $');
    expect(compiled.params).toContain(50);
  });

  it('should combine _set and _inc in the same UPDATE', () => {
    const table = findTable('account');
    const compiled = compileUpdateByPk({
      table,
      pkValues: { id: ACCOUNT_ALICE_ID },
      _set: { active: false },
      _inc: { balance: 200 },
      returningColumns: ['id', 'balance', 'active'],
      session: adminSession,
    });

    // Both assignments should be present
    expect(compiled.sql).toContain('"active" = $');
    expect(compiled.sql).toContain('"balance" = "balance" + $');
    expect(compiled.params).toContain(false);
    expect(compiled.params).toContain(200);
  });

  it('should let _set take precedence when same column in both _set and _inc', () => {
    const table = findTable('account');
    const compiled = compileUpdateByPk({
      table,
      pkValues: { id: ACCOUNT_ALICE_ID },
      _set: { balance: 999 },
      _inc: { balance: 100 },
      returningColumns: ['id', 'balance'],
      session: adminSession,
    });

    // Should use direct assignment from _set, NOT increment
    expect(compiled.sql).toContain('"balance" = $');
    // The "= column + $" pattern should NOT appear for balance
    expect(compiled.sql).not.toContain('"balance" = "balance" + $');
    expect(compiled.params).toContain(999);
  });

  it('should handle _inc only (empty _set) without error', () => {
    const table = findTable('account');
    const compiled = compileUpdateByPk({
      table,
      pkValues: { id: ACCOUNT_ALICE_ID },
      _set: {},
      _inc: { pending_balance: 25.5 },
      returningColumns: ['id', 'pending_balance'],
      session: adminSession,
    });

    expect(compiled.sql).toContain('"pending_balance" = "pending_balance" + $');
    expect(compiled.params).toContain(25.5);
  });

  it('should support negative increments (decrement)', () => {
    const table = findTable('account');
    const compiled = compileUpdateByPk({
      table,
      pkValues: { id: ACCOUNT_ALICE_ID },
      _set: {},
      _inc: { balance: -50 },
      returningColumns: ['id', 'balance'],
      session: adminSession,
    });

    expect(compiled.sql).toContain('"balance" = "balance" + $');
    expect(compiled.params).toContain(-50);
  });
});

// ─── E2E: Execute against real DB ────────────────────────────────────────────

describe('P12.2 — IncInput E2E (real DB)', () => {
  const adminSession = makeSession('admin');

  it('should increment account balance via _inc and verify new value', async () => {
    const pool = getPool();
    const table = findTable('account');

    // Read current balance
    const before = await pool.query(
      'SELECT balance FROM account WHERE id = $1',
      [ACCOUNT_ALICE_ID],
    );
    const balanceBefore = parseFloat(before.rows[0].balance);

    // Compile and execute UPDATE with _inc
    const increment = 100;
    const compiled = compileUpdateByPk({
      table,
      pkValues: { id: ACCOUNT_ALICE_ID },
      _set: {},
      _inc: { balance: increment },
      returningColumns: ['id', 'balance'],
      session: adminSession,
    });

    await pool.query(compiled.sql, compiled.params);

    // Read balance after
    const after = await pool.query(
      'SELECT balance FROM account WHERE id = $1',
      [ACCOUNT_ALICE_ID],
    );
    const balanceAfter = parseFloat(after.rows[0].balance);

    expect(balanceAfter).toBeCloseTo(balanceBefore + increment, 2);

    // Reset balance to original value
    await pool.query(
      'UPDATE account SET balance = $1 WHERE id = $2',
      [balanceBefore, ACCOUNT_ALICE_ID],
    );
  });

  it('should decrement account balance via negative _inc', async () => {
    const pool = getPool();
    const table = findTable('account');

    // Read current balance
    const before = await pool.query(
      'SELECT balance FROM account WHERE id = $1',
      [ACCOUNT_ALICE_ID],
    );
    const balanceBefore = parseFloat(before.rows[0].balance);

    // Compile and execute UPDATE with negative _inc
    const decrement = -50;
    const compiled = compileUpdateByPk({
      table,
      pkValues: { id: ACCOUNT_ALICE_ID },
      _set: {},
      _inc: { balance: decrement },
      returningColumns: ['id', 'balance'],
      session: adminSession,
    });

    await pool.query(compiled.sql, compiled.params);

    // Read balance after
    const after = await pool.query(
      'SELECT balance FROM account WHERE id = $1',
      [ACCOUNT_ALICE_ID],
    );
    const balanceAfter = parseFloat(after.rows[0].balance);

    expect(balanceAfter).toBeCloseTo(balanceBefore + decrement, 2);

    // Reset balance to original value
    await pool.query(
      'UPDATE account SET balance = $1 WHERE id = $2',
      [balanceBefore, ACCOUNT_ALICE_ID],
    );
  });

  it('should combine _set and _inc in a single E2E update', async () => {
    const pool = getPool();
    const table = findTable('account');

    // Read current values
    const before = await pool.query(
      'SELECT balance, credit_balance FROM account WHERE id = $1',
      [ACCOUNT_ALICE_ID],
    );
    const balanceBefore = parseFloat(before.rows[0].balance);
    const creditBefore = parseFloat(before.rows[0].credit_balance);

    // _set: direct assign credit_balance, _inc: increment balance
    const compiled = compileUpdateByPk({
      table,
      pkValues: { id: ACCOUNT_ALICE_ID },
      _set: { credit_balance: 999.99 },
      _inc: { balance: 250 },
      returningColumns: ['id', 'balance', 'credit_balance'],
      session: adminSession,
    });

    await pool.query(compiled.sql, compiled.params);

    // Read values after
    const after = await pool.query(
      'SELECT balance, credit_balance FROM account WHERE id = $1',
      [ACCOUNT_ALICE_ID],
    );
    const balanceAfter = parseFloat(after.rows[0].balance);
    const creditAfter = parseFloat(after.rows[0].credit_balance);

    expect(balanceAfter).toBeCloseTo(balanceBefore + 250, 2);
    expect(creditAfter).toBeCloseTo(999.99, 2);

    // Reset to original values
    await pool.query(
      'UPDATE account SET balance = $1, credit_balance = $2 WHERE id = $3',
      [balanceBefore, creditBefore, ACCOUNT_ALICE_ID],
    );
  });
});
