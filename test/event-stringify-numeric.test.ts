/**
 * Tests for stringify_numeric_types applied to event trigger payloads (P13.14).
 *
 * With stringify_numeric_types enabled, int8/numeric/float8/money columns must
 * reach event_log new_data / old_data as JSON strings — matching Hasura, and
 * preserving precision for values outside the IEEE-754 safe range.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import pg from 'pg';
import { configureStringifyNumericTypes } from '../src/introspection/type-map.js';
import {
  generateEventTriggerSQL,
  installEventTriggers,
  removeEventTriggers,
} from '../src/events/triggers.js';
import { ensureEventSchema } from '../src/events/schema.js';
import { TEST_DB_URL, waitForDb } from './setup.js';
import type { TableInfo, ColumnInfo, EventTriggerConfig, TablePermissions } from '../src/types.js';

const { Pool } = pg;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function emptyPermissions(): TablePermissions {
  return { select: {}, insert: {}, update: {}, delete: {} };
}

function makeColumn(name: string, udtName: string, isArray = false): ColumnInfo {
  return {
    name,
    type: udtName,
    udtName,
    isNullable: true,
    hasDefault: false,
    isPrimaryKey: false,
    isArray,
  };
}

function makeTrigger(webhook: string): EventTriggerConfig {
  return {
    name: 'stringify_test_trigger',
    definition: {
      insert: { columns: '*' },
      update: { columns: '*' },
      delete: { columns: '*' },
    },
    retryConf: { intervalSec: 1, numRetries: 1, timeoutSec: 10 },
    webhook,
  };
}

function makeTableInfo(columns: ColumnInfo[]): TableInfo {
  return {
    name: 'stringify_event_test',
    schema: 'public',
    columns,
    primaryKey: ['id'],
    foreignKeys: [],
    uniqueConstraints: [],
    indexes: [],
    relationships: [],
    permissions: emptyPermissions(),
    eventTriggers: [makeTrigger('http://localhost:1/never-called')],
  };
}

const testColumns = [
  makeColumn('id', 'int8'),
  makeColumn('amount', 'numeric'),
  makeColumn('note', 'text'),
  makeColumn('big_ids', '_int8', true),
];

// ─── Generated trigger SQL ──────────────────────────────────────────────────

describe('generateEventTriggerSQL with stringify_numeric_types', () => {
  afterEach(() => {
    configureStringifyNumericTypes(false);
  });

  it('casts int8 and numeric columns to text in new_data when enabled', () => {
    configureStringifyNumericTypes(true);
    const gen = generateEventTriggerSQL(makeTableInfo(testColumns), [makeTrigger('http://x')]);

    expect(gen.createFunctionSQL).toContain('(NEW."id")::text');
    expect(gen.createFunctionSQL).toContain('(NEW."amount")::text');
  });

  it('casts columns to text in old_data for UPDATE and DELETE when enabled', () => {
    configureStringifyNumericTypes(true);
    const gen = generateEventTriggerSQL(makeTableInfo(testColumns), [makeTrigger('http://x')]);

    expect(gen.createFunctionSQL).toContain('(OLD."id")::text');
    expect(gen.createFunctionSQL).toContain('(OLD."amount")::text');
  });

  it('converts numeric array columns to arrays of strings when enabled', () => {
    configureStringifyNumericTypes(true);
    const gen = generateEventTriggerSQL(makeTableInfo(testColumns), [makeTrigger('http://x')]);

    expect(gen.createFunctionSQL).toContain('to_jsonb((NEW."big_ids")::text[])');
  });

  it('does not cast non-numeric columns', () => {
    configureStringifyNumericTypes(true);
    const gen = generateEventTriggerSQL(makeTableInfo(testColumns), [makeTrigger('http://x')]);

    expect(gen.createFunctionSQL).not.toContain('(NEW."note")::text');
  });

  it('generates plain to_jsonb(NEW) when disabled', () => {
    const gen = generateEventTriggerSQL(makeTableInfo(testColumns), [makeTrigger('http://x')]);

    expect(gen.createFunctionSQL).toContain('to_jsonb(NEW)');
    expect(gen.createFunctionSQL).not.toContain('(NEW."id")::text');
    expect(gen.createFunctionSQL).not.toContain('(NEW."amount")::text');
    expect(gen.createFunctionSQL).not.toContain('jsonb_build_object');
  });
});

// ─── Live trigger behavior (real PG) ────────────────────────────────────────

describe('event_log payload stringification (integration)', () => {
  let pool: InstanceType<typeof Pool>;
  let testTable: TableInfo;

  beforeAll(async () => {
    await waitForDb();
    pool = new Pool({ connectionString: TEST_DB_URL, max: 3 });

    await pool.query('DROP TABLE IF EXISTS public.stringify_event_test');
    await pool.query(`
      CREATE TABLE public.stringify_event_test (
        id BIGINT PRIMARY KEY,
        amount NUMERIC(20,4),
        note TEXT,
        big_ids BIGINT[]
      )
    `);

    await ensureEventSchema(pool);

    configureStringifyNumericTypes(true);
    testTable = makeTableInfo(testColumns);
    await installEventTriggers(pool, [testTable]);
  }, 30_000);

  afterAll(async () => {
    configureStringifyNumericTypes(false);
    if (pool) {
      await removeEventTriggers(pool, [testTable]);
      await pool.query(
        "DELETE FROM hakkyra.event_log WHERE table_name = 'stringify_event_test'",
      );
      await pool.query('DROP TABLE IF EXISTS public.stringify_event_test');
      await pool.end();
    }
  }, 15_000);

  async function fetchEvents(operation: string): Promise<Array<{ old_data: any; new_data: any }>> {
    const result = await pool.query(
      `SELECT old_data, new_data FROM hakkyra.event_log
       WHERE table_name = 'stringify_event_test' AND operation = $1
       ORDER BY created_at ASC`,
      [operation],
    );
    return result.rows;
  }

  it('stores int8 and numeric INSERT values as strings, preserving precision', async () => {
    // 9007199254740993 is not representable as a JS number (2^53 + 1)
    await pool.query(
      `INSERT INTO public.stringify_event_test (id, amount, note, big_ids)
       VALUES (9007199254740993, 42.5000, 'hello', ARRAY[9007199254740993, 2]::bigint[])`,
    );

    const [event] = await fetchEvents('INSERT');
    expect(event).toBeDefined();
    expect(event.new_data.id).toBe('9007199254740993');
    expect(event.new_data.amount).toBe('42.5000');
    expect(event.new_data.note).toBe('hello');
    expect(event.new_data.big_ids).toEqual(['9007199254740993', '2']);
  });

  it('stores UPDATE old_data and new_data numeric values as strings', async () => {
    await pool.query(
      `UPDATE public.stringify_event_test SET amount = 100.0000 WHERE id = 9007199254740993`,
    );

    const [event] = await fetchEvents('UPDATE');
    expect(event).toBeDefined();
    expect(event.old_data.amount).toBe('42.5000');
    expect(event.new_data.amount).toBe('100.0000');
    expect(event.old_data.id).toBe('9007199254740993');
  });

  it('stores DELETE old_data numeric values as strings', async () => {
    await pool.query(`DELETE FROM public.stringify_event_test WHERE id = 9007199254740993`);

    const [event] = await fetchEvents('DELETE');
    expect(event).toBeDefined();
    expect(event.old_data.id).toBe('9007199254740993');
    expect(event.old_data.amount).toBe('100.0000');
  });

  it('stores NULL numeric columns as JSON null, not the string "null"', async () => {
    await pool.query(`INSERT INTO public.stringify_event_test (id, amount, note) VALUES (2, NULL, NULL)`);

    const events = await fetchEvents('INSERT');
    const event = events.find((e) => e.new_data.id === '2' || e.new_data.id === 2);
    expect(event).toBeDefined();
    expect(event!.new_data.amount).toBeNull();
    expect(event!.new_data.big_ids).toBeNull();
  });
});
