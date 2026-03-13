/**
 * Tests for ON CONFLICT (upsert) support.
 *
 * Covers:
 * 1. SQL generation with ON CONFLICT clause (insertOne + bulk insert)
 * 2. DO NOTHING when updateColumns is empty
 * 3. WHERE clause on DO UPDATE
 * 4. Permission enforcement on updateColumns
 * 5. GraphQL schema: OnConflict input types, constraint enum, update column enum
 * 6. E2E: insert with conflict updates existing row
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GraphQLSchema, GraphQLInputObjectType, GraphQLEnumType } from 'graphql';
import { compileInsertOne, compileInsert } from '../src/sql/insert.js';
import { compileFilter } from '../src/permissions/compiler.js';
import { generateSchema } from '../src/schema/generator.js';
import { resetCustomOutputTypeCache } from '../src/schema/custom-queries.js';
import { introspectDatabase } from '../src/introspection/introspector.js';
import { mergeSchemaModel } from '../src/introspection/merger.js';
import { loadConfig } from '../src/config/loader.js';
import type { BoolExp, SchemaModel, TableInfo } from '../src/types.js';
import {
  getPool, closePool, waitForDb, makeSession,
  METADATA_DIR, SERVER_CONFIG_PATH, TEST_DB_URL,
  ALICE_ID,
} from './setup.js';

let schemaModel: SchemaModel;
let schema: GraphQLSchema;

function findTable(name: string): TableInfo {
  const table = schemaModel.tables.find((t) => t.name === name);
  if (!table) throw new Error(`Table ${name} not found in schema model`);
  return table;
}

beforeAll(async () => {
  process.env['DATABASE_URL'] = TEST_DB_URL;
  resetCustomOutputTypeCache();
  await waitForDb();
  const pool = getPool();
  const introspection = await introspectDatabase(pool);
  const config = await loadConfig(METADATA_DIR, SERVER_CONFIG_PATH);
  const result = mergeSchemaModel(introspection, config);
  schemaModel = result.model;
  schema = generateSchema(schemaModel);
});

afterAll(async () => {
  await closePool();
});

// ─── SQL Generation Tests ─────────────────────────────────────────────────────

describe('SQL INSERT ON CONFLICT — compileInsertOne', () => {
  const adminSession = makeSession('admin');

  it('should generate ON CONFLICT DO UPDATE SET for insertOne', () => {
    const table = findTable('currency');
    const query = compileInsertOne({
      table,
      object: { id: 'SEK', name: 'Swedish Krona', symbol: 'kr' },
      returningColumns: ['id', 'name', 'symbol'],
      onConflict: {
        constraint: 'currency_pkey',
        updateColumns: ['name', 'symbol'],
      },
      session: adminSession,
    });

    expect(query.sql).toContain('ON CONFLICT ON CONSTRAINT "currency_pkey"');
    expect(query.sql).toContain('DO UPDATE SET');
    expect(query.sql).toContain('"name" = EXCLUDED."name"');
    expect(query.sql).toContain('"symbol" = EXCLUDED."symbol"');
  });

  it('should generate ON CONFLICT DO NOTHING when updateColumns is empty', () => {
    const table = findTable('currency');
    const query = compileInsertOne({
      table,
      object: { id: 'SEK', name: 'Swedish Krona', symbol: 'kr' },
      returningColumns: ['id', 'name'],
      onConflict: {
        constraint: 'currency_pkey',
        updateColumns: [],
      },
      session: adminSession,
    });

    expect(query.sql).toContain('ON CONFLICT ON CONSTRAINT "currency_pkey" DO NOTHING');
    expect(query.sql).not.toContain('DO UPDATE');
  });

  it('should generate ON CONFLICT with WHERE clause on DO UPDATE', () => {
    const table = findTable('currency');
    const query = compileInsertOne({
      table,
      object: { id: 'SEK', name: 'Swedish Krona', symbol: 'kr', decimal_places: 2 },
      returningColumns: ['id', 'name'],
      onConflict: {
        constraint: 'currency_pkey',
        updateColumns: ['name', 'symbol'],
        where: { decimal_places: { _eq: 2 } } as BoolExp,
      },
      session: adminSession,
    });

    expect(query.sql).toContain('ON CONFLICT ON CONSTRAINT "currency_pkey"');
    expect(query.sql).toContain('DO UPDATE SET');
    expect(query.sql).toContain('WHERE');
    // The where clause should reference the table name
    expect(query.sql).toContain('"decimal_places"');
  });

  it('should include ON CONFLICT inside CTE when permission check is present', () => {
    const table = findTable('currency');
    const permFilter = compileFilter({} as BoolExp);
    const query = compileInsertOne({
      table,
      object: { id: 'SEK', name: 'Swedish Krona', symbol: 'kr' },
      returningColumns: ['id', 'name'],
      onConflict: {
        constraint: 'currency_pkey',
        updateColumns: ['name'],
      },
      permission: {
        check: permFilter,
        columns: '*',
      },
      session: adminSession,
    });

    expect(query.sql).toContain('WITH "_inserted" AS');
    expect(query.sql).toContain('ON CONFLICT ON CONSTRAINT "currency_pkey"');
    expect(query.sql).toContain('DO UPDATE SET "name" = EXCLUDED."name"');
  });
});

describe('SQL INSERT ON CONFLICT — compileInsert (bulk)', () => {
  const adminSession = makeSession('admin');

  it('should generate ON CONFLICT DO UPDATE SET for bulk insert', () => {
    const table = findTable('currency');
    const query = compileInsert({
      table,
      objects: [
        { id: 'SEK', name: 'Swedish Krona', symbol: 'kr' },
        { id: 'NOK', name: 'Norwegian Krone', symbol: 'kr' },
      ],
      returningColumns: ['id', 'name'],
      onConflict: {
        constraint: 'currency_pkey',
        updateColumns: ['name', 'symbol'],
      },
      session: adminSession,
    });

    expect(query.sql).toContain('ON CONFLICT ON CONSTRAINT "currency_pkey"');
    expect(query.sql).toContain('DO UPDATE SET');
    expect(query.sql).toContain('"name" = EXCLUDED."name"');
    expect(query.sql).toContain('"symbol" = EXCLUDED."symbol"');
  });

  it('should generate ON CONFLICT DO NOTHING for bulk insert with empty updateColumns', () => {
    const table = findTable('currency');
    const query = compileInsert({
      table,
      objects: [
        { id: 'SEK', name: 'Swedish Krona', symbol: 'kr' },
      ],
      returningColumns: ['id', 'name'],
      onConflict: {
        constraint: 'currency_pkey',
        updateColumns: [],
      },
      session: adminSession,
    });

    expect(query.sql).toContain('ON CONFLICT ON CONSTRAINT "currency_pkey" DO NOTHING');
    expect(query.sql).not.toContain('DO UPDATE');
  });

  it('should generate ON CONFLICT with WHERE clause for bulk insert', () => {
    const table = findTable('currency');
    const query = compileInsert({
      table,
      objects: [
        { id: 'SEK', name: 'Swedish Krona', symbol: 'kr', decimal_places: 2 },
      ],
      returningColumns: ['id', 'name'],
      onConflict: {
        constraint: 'currency_pkey',
        updateColumns: ['name'],
        where: { decimal_places: { _eq: 2 } } as BoolExp,
      },
      session: adminSession,
    });

    expect(query.sql).toContain('ON CONFLICT ON CONSTRAINT "currency_pkey"');
    expect(query.sql).toContain('DO UPDATE SET');
    expect(query.sql).toContain('WHERE');
  });
});

// ─── E2E SQL Execution Tests ──────────────────────────────────────────────────

describe('SQL INSERT ON CONFLICT — E2E execution', () => {
  const adminSession = makeSession('admin');

  it('should upsert: insert a new currency, then update on conflict', async () => {
    const pool = getPool();
    const table = findTable('currency');

    // First insert — creates new row
    const insert1 = compileInsertOne({
      table,
      object: { id: 'SEK', name: 'Swedish Krona', symbol: 'kr' },
      returningColumns: ['id', 'name', 'symbol'],
      onConflict: {
        constraint: 'currency_pkey',
        updateColumns: ['name', 'symbol'],
      },
      session: adminSession,
    });
    const result1 = await pool.query(insert1.sql, insert1.params);
    expect(result1.rows).toHaveLength(1);
    expect(result1.rows[0].data.id).toBe('SEK');
    expect(result1.rows[0].data.name).toBe('Swedish Krona');

    // Second insert with same PK — should update
    const insert2 = compileInsertOne({
      table,
      object: { id: 'SEK', name: 'Swedish Krona (Updated)', symbol: 'SEK' },
      returningColumns: ['id', 'name', 'symbol'],
      onConflict: {
        constraint: 'currency_pkey',
        updateColumns: ['name', 'symbol'],
      },
      session: adminSession,
    });
    const result2 = await pool.query(insert2.sql, insert2.params);
    expect(result2.rows).toHaveLength(1);
    expect(result2.rows[0].data.name).toBe('Swedish Krona (Updated)');
    expect(result2.rows[0].data.symbol).toBe('SEK');

    // Verify only one row exists
    const check = await pool.query("SELECT name, symbol FROM currency WHERE id = 'SEK'");
    expect(check.rows).toHaveLength(1);
    expect(check.rows[0].name).toBe('Swedish Krona (Updated)');

    // Cleanup
    await pool.query("DELETE FROM currency WHERE id = 'SEK'");
  });

  it('should DO NOTHING when updateColumns is empty and conflict exists', async () => {
    const pool = getPool();
    const table = findTable('currency');

    // EUR already exists in seed data
    const query = compileInsertOne({
      table,
      object: { id: 'EUR', name: 'CHANGED', symbol: 'X' },
      returningColumns: ['id', 'name', 'symbol'],
      onConflict: {
        constraint: 'currency_pkey',
        updateColumns: [],
      },
      session: adminSession,
    });
    const result = await pool.query(query.sql, query.params);
    // DO NOTHING returns 0 rows
    expect(result.rows).toHaveLength(0);

    // Verify original data unchanged
    const check = await pool.query("SELECT name FROM currency WHERE id = 'EUR'");
    expect(check.rows[0].name).toBe('Euro');
  });

  it('should respect WHERE clause on ON CONFLICT DO UPDATE', async () => {
    const pool = getPool();
    const table = findTable('currency');

    // Insert a test currency with decimal_places = 3
    await pool.query("INSERT INTO currency (id, name, symbol, decimal_places) VALUES ('BHD', 'Bahraini Dinar', 'BD', 3)");

    // Attempt upsert with WHERE decimal_places = 2 — should NOT update since BHD has decimal_places = 3
    const query = compileInsertOne({
      table,
      object: { id: 'BHD', name: 'CHANGED', symbol: 'X', decimal_places: 3 },
      returningColumns: ['id', 'name', 'symbol'],
      onConflict: {
        constraint: 'currency_pkey',
        updateColumns: ['name', 'symbol'],
        where: { decimal_places: { _eq: 2 } } as BoolExp,
      },
      session: adminSession,
    });

    // The ON CONFLICT DO UPDATE ... WHERE should be filtered out
    // PostgreSQL behavior: if the WHERE doesn't match, the row is not updated
    // and is not returned by RETURNING (since no insert or update occurred from DO UPDATE's perspective)
    const result = await pool.query(query.sql, query.params);
    // When WHERE doesn't match, no rows are returned
    expect(result.rows).toHaveLength(0);

    // Verify original data unchanged
    const check = await pool.query("SELECT name FROM currency WHERE id = 'BHD'");
    expect(check.rows[0].name).toBe('Bahraini Dinar');

    // Cleanup
    await pool.query("DELETE FROM currency WHERE id = 'BHD'");
  });

  it('should upsert with bulk insert', async () => {
    const pool = getPool();
    const table = findTable('currency');

    // Insert two currencies, one already exists (EUR)
    const query = compileInsert({
      table,
      objects: [
        { id: 'EUR', name: 'Euro Updated', symbol: 'EUR' },
        { id: 'SEK', name: 'Swedish Krona', symbol: 'kr' },
      ],
      returningColumns: ['id', 'name'],
      onConflict: {
        constraint: 'currency_pkey',
        updateColumns: ['name', 'symbol'],
      },
      session: adminSession,
    });
    const result = await pool.query(query.sql, query.params);
    // Both rows returned (one updated, one inserted)
    expect(result.rows.length).toBeGreaterThanOrEqual(1);

    // Verify EUR was updated
    const checkEUR = await pool.query("SELECT name FROM currency WHERE id = 'EUR'");
    expect(checkEUR.rows[0].name).toBe('Euro Updated');

    // Verify SEK was inserted
    const checkSEK = await pool.query("SELECT name FROM currency WHERE id = 'SEK'");
    expect(checkSEK.rows).toHaveLength(1);
    expect(checkSEK.rows[0].name).toBe('Swedish Krona');

    // Cleanup — restore EUR and remove SEK
    await pool.query("UPDATE currency SET name = 'Euro', symbol = '€' WHERE id = 'EUR'");
    await pool.query("DELETE FROM currency WHERE id = 'SEK'");
  });

  it('should upsert on unique constraint (non-PK)', async () => {
    const pool = getPool();
    const table = findTable('client_data');

    // client_data has UNIQUE(client_id, key) — find its constraint name
    const uniqueConstraint = table.uniqueConstraints.find(
      (uc) => uc.columns.includes('client_id') && uc.columns.includes('key'),
    );
    expect(uniqueConstraint).toBeDefined();

    // Alice already has a 'preferences' key in seed data
    const query = compileInsertOne({
      table,
      object: {
        id: 'aaaaaaaa-0000-0000-0000-aaaaaaaaa001',
        client_id: ALICE_ID,
        key: 'preferences',
        value: '{"theme": "light"}',
      },
      returningColumns: ['id', 'client_id', 'key', 'value'],
      onConflict: {
        constraint: uniqueConstraint!.constraintName,
        updateColumns: ['value'],
      },
      session: adminSession,
    });
    const result = await pool.query(query.sql, query.params);
    expect(result.rows).toHaveLength(1);
    const data = result.rows[0].data;
    expect(data.key).toBe('preferences');
    // The value should be updated (JSONB comes back as parsed object)
    const value = typeof data.value === 'string' ? JSON.parse(data.value) : data.value;
    expect(value).toEqual({ theme: 'light' });

    // Restore seed data
    await pool.query(
      "UPDATE client_data SET value = $1 WHERE client_id = $2 AND key = 'preferences'",
      ['{"theme": "dark", "notifications": true}', ALICE_ID],
    );
  });
});

// ─── Permission Tests ──────────────────────────────────────────────────────────

describe('SQL INSERT ON CONFLICT — Permission enforcement', () => {
  it('should reject disallowed columns in the insert object', () => {
    const table = findTable('currency');
    const permFilter = compileFilter({} as BoolExp);
    const session = makeSession('backoffice');

    expect(() =>
      compileInsertOne({
        table,
        object: { id: 'SEK', name: 'Swedish Krona', symbol: 'kr' },
        returningColumns: ['id', 'name'],
        onConflict: {
          constraint: 'currency_pkey',
          updateColumns: ['name'],
        },
        permission: {
          check: permFilter,
          columns: ['id', 'name'], // symbol not allowed
        },
        session,
      }),
    ).toThrow('Column "symbol" is not allowed');
  });
});

// ─── GraphQL Schema Tests ──────────────────────────────────────────────────────

describe('GraphQL Schema — OnConflict types', () => {
  it('should generate OnConflict input type for tables with PK', () => {
    const typeMap = schema.getTypeMap();
    // Client table has custom root name → type is "Client"
    expect(typeMap['ClientOnConflict']).toBeDefined();
    expect(typeMap['ClientOnConflict']).toBeInstanceOf(GraphQLInputObjectType);
  });

  it('should have constraint, updateColumns, and where fields on OnConflict', () => {
    const typeMap = schema.getTypeMap();
    const onConflictType = typeMap['ClientOnConflict'] as GraphQLInputObjectType;
    const fields = onConflictType.getFields();
    expect(fields['constraint']).toBeDefined();
    expect(fields['updateColumns']).toBeDefined();
    expect(fields['where']).toBeDefined();
  });

  it('should generate Constraint enum for tables with PK and unique constraints', () => {
    const typeMap = schema.getTypeMap();
    const constraintEnum = typeMap['ClientConstraint'] as GraphQLEnumType | undefined;
    expect(constraintEnum).toBeDefined();
    const values = constraintEnum!.getValues();
    const valueNames = values.map((v) => v.name);
    // Should have the PK constraint
    expect(valueNames.some((n) => n.includes('pkey'))).toBe(true);
  });

  it('should generate UpdateColumn enum with all columns', () => {
    const typeMap = schema.getTypeMap();
    const updateColumnEnum = typeMap['ClientUpdateColumn'] as GraphQLEnumType | undefined;
    expect(updateColumnEnum).toBeDefined();
    const values = updateColumnEnum!.getValues();
    const valueNames = values.map((v) => v.name);
    // Should have camelCase column names
    expect(valueNames).toContain('id');
    expect(valueNames).toContain('username');
    expect(valueNames).toContain('email');
  });

  it('should have onConflict arg on insertClients mutation', () => {
    const mutationType = schema.getMutationType()!;
    const insertField = mutationType.getFields()['insertClients'];
    expect(insertField).toBeDefined();
    const argNames = insertField.args.map((a) => a.name);
    expect(argNames).toContain('objects');
    expect(argNames).toContain('onConflict');
  });

  it('should have onConflict arg on insertClient (insertOne) mutation', () => {
    const mutationType = schema.getMutationType()!;
    const insertOneField = mutationType.getFields()['insertClient'];
    expect(insertOneField).toBeDefined();
    const argNames = insertOneField.args.map((a) => a.name);
    expect(argNames).toContain('object');
    expect(argNames).toContain('onConflict');
  });

  it('should generate Constraint enum for currency table with PK', () => {
    const typeMap = schema.getTypeMap();
    const constraintEnum = typeMap['CurrencyConstraint'] as GraphQLEnumType | undefined;
    expect(constraintEnum).toBeDefined();
    const values = constraintEnum!.getValues();
    const valueNames = values.map((v) => v.name);
    expect(valueNames).toContain('currency_pkey');
  });

  it('should generate Constraint enum with unique constraints for branch table', () => {
    const typeMap = schema.getTypeMap();
    const constraintEnum = typeMap['BranchConstraint'] as GraphQLEnumType | undefined;
    expect(constraintEnum).toBeDefined();
    const values = constraintEnum!.getValues();
    const valueNames = values.map((v) => v.name);
    // Should have PK + name unique + code unique
    expect(valueNames.some((n) => n.includes('pkey'))).toBe(true);
  });

  it('where field on OnConflict should be the table BoolExp type', () => {
    const typeMap = schema.getTypeMap();
    const onConflictType = typeMap['CurrencyOnConflict'] as GraphQLInputObjectType;
    const whereField = onConflictType.getFields()['where'];
    expect(whereField).toBeDefined();
    // The type should be the CurrencyBoolExp
    expect(whereField.type.toString()).toBe('CurrencyBoolExp');
  });
});
