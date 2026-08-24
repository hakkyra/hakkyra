/**
 * P13.19 — Insert with an empty object compiles to DEFAULT VALUES.
 *
 * `insert_<table>_one(object: {})` is the idiomatic Hasura way to insert an
 * all-defaults row. The compiler must emit:
 *   - single row:  INSERT INTO t DEFAULT VALUES
 *   - batch:       INSERT INTO t SELECT FROM generate_series(1, n)
 *
 * The "No columns to insert" error stays for the case it was written for — a
 * non-empty object whose every column was stripped must still be an error,
 * not a row of defaults.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { compileInsertOne, compileInsert, compileInsertBatch } from '../src/sql/insert.js';
import { compileFilter } from '../src/permissions/compiler.js';
import type { BoolExp, TableInfo } from '../src/types.js';
import { waitForDb, getPool, closePool, makeSession } from './setup.js';

const TABLE_NAME = 'public.default_values_test';

const table: TableInfo = {
  name: 'default_values_test',
  schema: 'public',
  columns: [
    { name: 'id', type: 'integer', udtName: 'int4', isNullable: false, hasDefault: true, isPrimaryKey: true, isArray: false },
    { name: 'active', type: 'boolean', udtName: 'bool', isNullable: false, hasDefault: true, isPrimaryKey: false, isArray: false },
    { name: 'created_at', type: 'timestamp with time zone', udtName: 'timestamptz', isNullable: false, hasDefault: true, isPrimaryKey: false, isArray: false },
  ],
  primaryKey: ['id'],
  foreignKeys: [],
  uniqueConstraints: [],
  indexes: [],
  relationships: [],
  permissions: {},
  eventTriggers: [],
};

const adminSession = makeSession('admin');

beforeAll(async () => {
  await waitForDb();
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
      id serial PRIMARY KEY,
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
});

beforeEach(async () => {
  await getPool().query(`TRUNCATE ${TABLE_NAME}`);
});

afterAll(async () => {
  await getPool().query(`DROP TABLE IF EXISTS ${TABLE_NAME}`);
  await closePool();
});

describe('compileInsertOne with an empty object', () => {
  it('emits DEFAULT VALUES and inserts a row of defaults', async () => {
    const query = compileInsertOne({
      table,
      object: {},
      returningColumns: ['id', 'active'],
      session: adminSession,
    });
    expect(query.sql).toContain('DEFAULT VALUES');
    const result = await getPool().query(query.sql, query.params);
    expect(result.rows).toHaveLength(1);
    const data = result.rows[0].data;
    expect(data.id).toBeDefined();
    expect(data.active).toBe(true);
  });

  it('works with a permission check (CTE path)', async () => {
    const query = compileInsertOne({
      table,
      object: {},
      returningColumns: ['id', 'active'],
      permission: {
        check: compileFilter({} as BoolExp),
        columns: '*',
      },
      session: makeSession('backoffice'),
    });
    expect(query.sql).toContain('DEFAULT VALUES');
    const result = await getPool().query(query.sql, query.params);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].data.active).toBe(true);
  });

  it('still rejects a non-empty object whose every column was stripped', () => {
    expect(() =>
      compileInsertOne({
        table,
        object: { not_a_column: 1 },
        returningColumns: ['id'],
        session: adminSession,
      }),
    ).toThrow(/No columns to insert/);
  });
});

describe('compileInsert with all-empty objects', () => {
  it('emits generate_series and inserts n rows of defaults', async () => {
    const query = compileInsert({
      table,
      objects: [{}, {}, {}],
      returningColumns: ['id'],
      session: adminSession,
    });
    expect(query.sql).toContain('generate_series');
    const result = await getPool().query(query.sql, query.params);
    expect(result.rows).toHaveLength(3);
    const count = await getPool().query(`SELECT count(*)::int AS n FROM ${TABLE_NAME}`);
    expect(count.rows[0].n).toBe(3);
  });

  it('works with a permission check (CTE path)', async () => {
    const query = compileInsert({
      table,
      objects: [{}, {}],
      returningColumns: ['id', 'active'],
      permission: {
        check: compileFilter({} as BoolExp),
        columns: '*',
      },
      session: makeSession('backoffice'),
    });
    expect(query.sql).toContain('generate_series');
    const result = await getPool().query(query.sql, query.params);
    const rows = result.rows[0].data;
    expect(rows).toHaveLength(2);
  });

  it('mixed empty and non-empty objects still uses column DEFAULTs', async () => {
    const query = compileInsert({
      table,
      objects: [{}, { active: false }],
      returningColumns: ['id', 'active'],
      session: adminSession,
    });
    const result = await getPool().query(query.sql, query.params);
    expect(result.rows).toHaveLength(2);
    const actives = result.rows.map((r) => r.data.active).sort();
    expect(actives).toEqual([false, true]);
  });

  it('still rejects when a non-empty object was stripped to nothing', () => {
    expect(() =>
      compileInsert({
        table,
        objects: [{}, { not_a_column: 1 }],
        returningColumns: ['id'],
        session: adminSession,
      }),
    ).toThrow(/No columns to insert/);
  });
});

describe('compileInsertBatch with all-empty objects', () => {
  it('emits a single generate_series query and inserts n rows', async () => {
    const queries = compileInsertBatch({
      table,
      objects: [{}, {}],
      returningColumns: ['id'],
      session: adminSession,
    });
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain('generate_series');
    const result = await getPool().query(queries[0].sql, queries[0].params);
    expect(result.rows).toHaveLength(2);
  });

  it('still rejects when a non-empty object was stripped to nothing', () => {
    expect(() =>
      compileInsertBatch({
        table,
        objects: [{ not_a_column: 1 }],
        returningColumns: ['id'],
        session: adminSession,
      }),
    ).toThrow(/No columns to insert/);
  });
});
