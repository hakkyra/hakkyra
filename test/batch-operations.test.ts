import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  compileInsert,
  compileInsertBatch,
  PG_MAX_PARAMS,
  UNNEST_THRESHOLD,
} from '../src/sql/insert.js';
import { compileUpdate, compileUpdateMany } from '../src/sql/update.js';
import { compileDelete } from '../src/sql/delete.js';
import { compileFilter } from '../src/permissions/compiler.js';
import { introspectDatabase } from '../src/introspection/introspector.js';
import { mergeSchemaModel } from '../src/introspection/merger.js';
import { loadConfig } from '../src/config/loader.js';
import type { BoolExp, SchemaModel, TableInfo } from '../src/types.js';
import {
  getPool, closePool, waitForDb, makeSession,
  METADATA_DIR, SERVER_CONFIG_PATH, TEST_DB_URL,
  ALICE_ID, BOB_ID, BRANCH_TEST_ID,
} from './setup.js';

let schemaModel: SchemaModel;

function findTable(name: string): TableInfo {
  const table = schemaModel.tables.find((t) => t.name === name);
  if (!table) throw new Error(`Table ${name} not found in schema model`);
  return table;
}

beforeAll(async () => {
  process.env['DATABASE_URL'] = TEST_DB_URL;
  await waitForDb();
  const pool = getPool();
  const introspection = await introspectDatabase(pool);
  const config = await loadConfig(METADATA_DIR, SERVER_CONFIG_PATH);
  const result = mergeSchemaModel(introspection, config);
  schemaModel = result.model;
});

afterAll(async () => {
  await closePool();
});

// ─── INSERT: Multi-row VALUES Correctness ───────────────────────────────────

describe('INSERT: multi-row VALUES correctness', () => {
  const adminSession = makeSession('admin');

  it('should compile and execute multi-row INSERT', async () => {
    const pool = getPool();
    const table = findTable('currency');
    const query = compileInsert({
      table,
      objects: [
        { id: 'SEK', name: 'Swedish Krona', symbol: 'kr' },
        { id: 'NOK', name: 'Norwegian Krone', symbol: 'kr' },
        { id: 'DKK', name: 'Danish Krone', symbol: 'kr' },
      ],
      returningColumns: ['id', 'name', 'symbol'],
      session: adminSession,
    });

    expect(query.sql).toContain('VALUES');
    expect(query.sql).toContain('INSERT INTO');
    // Should have 9 params (3 rows x 3 columns)
    expect(query.params).toHaveLength(9);

    const result = await pool.query(query.sql, query.params);
    expect(result.rows).toHaveLength(3);
    const ids = result.rows.map((r: Record<string, unknown>) => (r.data as Record<string, unknown>).id);
    expect(ids).toContain('SEK');
    expect(ids).toContain('NOK');
    expect(ids).toContain('DKK');

    // Cleanup
    await pool.query("DELETE FROM currency WHERE id IN ('SEK', 'NOK', 'DKK')");
  });

  it('should handle heterogeneous objects with DEFAULT', () => {
    const table = findTable('currency');
    const query = compileInsert({
      table,
      objects: [
        { id: 'SEK', name: 'Swedish Krona' },
        { id: 'NOK', name: 'Norwegian Krone', symbol: 'kr' },
      ],
      returningColumns: ['id', 'name'],
      session: adminSession,
    });

    // The SQL should contain DEFAULT for missing columns
    expect(query.sql).toContain('DEFAULT');
  });
});

// ─── INSERT: Parameter Limit Chunking ────────────────────────────────────────

describe('INSERT: parameter limit chunking', () => {
  const adminSession = makeSession('admin');

  it('compileInsertBatch should chunk large batches into multiple queries', () => {
    const table = findTable('currency');
    // Create many objects that would exceed the param limit
    // 3 columns per row, chunk size default 100 => 100 rows per chunk
    const objects = Array.from({ length: 250 }, (_, i) => ({
      id: `BATCH_${String(i).padStart(4, '0')}`,
      name: `Currency ${i}`,
      symbol: `$${i}`,
    }));

    const queries = compileInsertBatch({
      table,
      objects,
      returningColumns: ['id', 'name'],
      session: adminSession,
      unnestThreshold: Infinity, // Disable UNNEST to test chunking
    });

    // Should split into 3 chunks: 100 + 100 + 50
    expect(queries).toHaveLength(3);
    expect(queries[0].params).toHaveLength(300); // 100 rows * 3 columns
    expect(queries[1].params).toHaveLength(300);
    expect(queries[2].params).toHaveLength(150); // 50 rows * 3 columns
  });

  it('compileInsertBatch should produce a single query for small batches', () => {
    const table = findTable('currency');
    const objects = [
      { id: 'SEK', name: 'Swedish Krona', symbol: 'kr' },
      { id: 'NOK', name: 'Norwegian Krone', symbol: 'kr' },
    ];

    const queries = compileInsertBatch({
      table,
      objects,
      returningColumns: ['id', 'name'],
      session: adminSession,
      unnestThreshold: Infinity,
    });

    expect(queries).toHaveLength(1);
    expect(queries[0].params).toHaveLength(6); // 2 rows * 3 columns
  });

  it('compileInsert should still return a single query for small batches', () => {
    const table = findTable('currency');
    const query = compileInsert({
      table,
      objects: [
        { id: 'SEK', name: 'Swedish Krona', symbol: 'kr' },
        { id: 'NOK', name: 'Norwegian Krone', symbol: 'kr' },
      ],
      returningColumns: ['id', 'name'],
      session: adminSession,
    });

    expect(query.sql).toContain('VALUES');
    expect(query.params).toHaveLength(6);
  });

  it('compileInsertBatch should respect custom chunk size', () => {
    const table = findTable('currency');
    const objects = Array.from({ length: 10 }, (_, i) => ({
      id: `BATCH_${i}`,
      name: `Currency ${i}`,
      symbol: `$${i}`,
    }));

    const queries = compileInsertBatch({
      table,
      objects,
      returningColumns: ['id', 'name'],
      session: adminSession,
      chunkSize: 3,
      unnestThreshold: Infinity,
    });

    // 10 rows / 3 per chunk = 4 chunks (3+3+3+1)
    expect(queries).toHaveLength(4);
    expect(queries[0].params).toHaveLength(9);  // 3 * 3
    expect(queries[3].params).toHaveLength(3);  // 1 * 3
  });

  it('should enforce PostgreSQL parameter limit per chunk', () => {
    const table = findTable('currency');
    // 3 columns -> max rows per chunk = floor(65535 / 3) = 21845
    const chunkSize = Math.floor(PG_MAX_PARAMS / 3);

    const objects = Array.from({ length: chunkSize + 10 }, (_, i) => ({
      id: `X${i}`,
      name: `N${i}`,
      symbol: `S${i}`,
    }));

    const queries = compileInsertBatch({
      table,
      objects,
      returningColumns: ['id'],
      session: adminSession,
      chunkSize: 100000, // Very large chunk size, should be constrained by param limit
      unnestThreshold: Infinity,
    });

    // First chunk should have exactly chunkSize rows
    expect(queries[0].params.length).toBeLessThanOrEqual(PG_MAX_PARAMS);
    expect(queries.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── INSERT: UNNEST Optimization ─────────────────────────────────────────────

describe('INSERT: UNNEST optimization for large batches', () => {
  const adminSession = makeSession('admin');

  it('should use UNNEST for large homogeneous batches', () => {
    const table = findTable('currency');
    const objects = Array.from({ length: 600 }, (_, i) => ({
      id: `UN_${String(i).padStart(4, '0')}`,
      name: `Currency ${i}`,
      symbol: `$${i}`,
    }));

    const query = compileInsert({
      table,
      objects,
      returningColumns: ['id', 'name'],
      session: adminSession,
    });

    // UNNEST query uses array parameters instead of individual row values
    expect(query.sql).toContain('UNNEST');
    expect(query.sql).not.toContain('VALUES');
    // Only 3 params (one array per column) instead of 1800
    expect(query.params).toHaveLength(3);
    // Each param should be an array of 600 values
    expect(Array.isArray(query.params[0])).toBe(true);
    expect((query.params[0] as unknown[]).length).toBe(600);
  });

  it('should not use UNNEST for small batches', () => {
    const table = findTable('currency');
    const query = compileInsert({
      table,
      objects: [
        { id: 'SEK', name: 'Swedish Krona', symbol: 'kr' },
        { id: 'NOK', name: 'Norwegian Krone', symbol: 'kr' },
      ],
      returningColumns: ['id', 'name'],
      session: adminSession,
    });

    expect(query.sql).toContain('VALUES');
    expect(query.sql).not.toContain('UNNEST');
  });

  it('should not use UNNEST for heterogeneous batches (even if large)', () => {
    const table = findTable('currency');
    const objects: Record<string, unknown>[] = Array.from({ length: 600 }, (_, i) => {
      // Alternate between objects with and without 'symbol'
      if (i % 2 === 0) {
        return { id: `HET_${i}`, name: `Currency ${i}`, symbol: `$${i}` };
      }
      return { id: `HET_${i}`, name: `Currency ${i}` };
    });

    const query = compileInsert({
      table,
      objects,
      returningColumns: ['id', 'name'],
      session: adminSession,
    });

    // Heterogeneous objects cannot use UNNEST (some missing columns)
    expect(query.sql).not.toContain('UNNEST');
  });

  it('should include proper type casts in UNNEST', () => {
    const table = findTable('currency');
    const objects = Array.from({ length: 600 }, (_, i) => ({
      id: `CAST_${i}`,
      name: `Currency ${i}`,
      symbol: `$${i}`,
    }));

    const query = compileInsert({
      table,
      objects,
      returningColumns: ['id'],
      session: adminSession,
    });

    // Should contain type casts for each column array
    expect(query.sql).toContain('::text[]');
  });

  it('UNNEST query should execute correctly against DB', async () => {
    const pool = getPool();
    const table = findTable('currency');
    // Use a smaller batch with unnestThreshold override to test execution
    const objects = Array.from({ length: 5 }, (_, i) => ({
      id: `UNE_${i}`,
      name: `UNNEST Currency ${i}`,
      symbol: `$${i}`,
    }));

    const query = compileInsert({
      table,
      objects,
      returningColumns: ['id', 'name'],
      session: adminSession,
      unnestThreshold: 3, // Force UNNEST with small batch for testing
    });

    expect(query.sql).toContain('UNNEST');

    const result = await pool.query(query.sql, query.params);
    expect(result.rows).toHaveLength(5);

    // Cleanup
    await pool.query("DELETE FROM currency WHERE id LIKE 'UNE_%'");
  });

  it('compileInsertBatch should return single UNNEST query for large batches', () => {
    const table = findTable('currency');
    const objects = Array.from({ length: 600 }, (_, i) => ({
      id: `UNB_${i}`,
      name: `Currency ${i}`,
      symbol: `$${i}`,
    }));

    const queries = compileInsertBatch({
      table,
      objects,
      returningColumns: ['id'],
      session: adminSession,
    });

    // UNNEST can handle any size in a single query
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain('UNNEST');
  });
});

// ─── UPDATE MANY ─────────────────────────────────────────────────────────────

describe('UPDATE MANY: batch updates with different values', () => {
  const adminSession = makeSession('admin');

  it('should compile multiple update queries', () => {
    const table = findTable('client');
    const queries = compileUpdateMany({
      table,
      updates: [
        {
          where: { id: { _eq: ALICE_ID } } as BoolExp,
          _set: { trust_level: 10 },
        },
        {
          where: { id: { _eq: BOB_ID } } as BoolExp,
          _set: { trust_level: 20 },
        },
      ],
      returningColumns: ['id', 'trust_level'],
      session: adminSession,
    });

    expect(queries).toHaveLength(2);
    expect(queries[0].sql).toContain('UPDATE');
    expect(queries[0].sql).toContain('SET');
    expect(queries[1].sql).toContain('UPDATE');
  });

  it('should return empty array for no updates', () => {
    const table = findTable('client');
    const queries = compileUpdateMany({
      table,
      updates: [],
      returningColumns: ['id'],
      session: adminSession,
    });

    expect(queries).toHaveLength(0);
  });

  it('should execute multiple updates against DB', async () => {
    const pool = getPool();
    const table = findTable('client');

    // Get original values
    const originalAlice = await pool.query('SELECT trust_level FROM client WHERE id = $1', [ALICE_ID]);
    const originalBob = await pool.query('SELECT trust_level FROM client WHERE id = $1', [BOB_ID]);
    const origAliceTrust = originalAlice.rows[0].trust_level;
    const origBobTrust = originalBob.rows[0].trust_level;

    const queries = compileUpdateMany({
      table,
      updates: [
        {
          where: { id: { _eq: ALICE_ID } } as BoolExp,
          _set: { trust_level: 77 },
        },
        {
          where: { id: { _eq: BOB_ID } } as BoolExp,
          _set: { trust_level: 88 },
        },
      ],
      returningColumns: ['id', 'trust_level'],
      session: adminSession,
    });

    // Execute each query
    for (const q of queries) {
      await pool.query(q.sql, q.params);
    }

    // Verify results
    const aliceResult = await pool.query('SELECT trust_level FROM client WHERE id = $1', [ALICE_ID]);
    const bobResult = await pool.query('SELECT trust_level FROM client WHERE id = $1', [BOB_ID]);
    expect(aliceResult.rows[0].trust_level).toBe(77);
    expect(bobResult.rows[0].trust_level).toBe(88);

    // Restore
    await pool.query('UPDATE client SET trust_level = $1 WHERE id = $2', [origAliceTrust, ALICE_ID]);
    await pool.query('UPDATE client SET trust_level = $1 WHERE id = $2', [origBobTrust, BOB_ID]);
  });

  it('should enforce permission filters on each update', () => {
    const table = findTable('client');
    const permFilter = compileFilter({ id: { _eq: 'X-Hasura-User-Id' } } as BoolExp);
    const clientSession = makeSession('client', ALICE_ID);

    const queries = compileUpdateMany({
      table,
      updates: [
        {
          where: { id: { _eq: ALICE_ID } } as BoolExp,
          _set: { trust_level: 10 },
        },
        {
          where: { id: { _eq: BOB_ID } } as BoolExp,
          _set: { trust_level: 20 },
        },
      ],
      returningColumns: ['id', 'trust_level'],
      permission: {
        filter: permFilter,
        columns: ['trust_level'],
      },
      session: clientSession,
    });

    // Both queries should contain the permission filter
    for (const q of queries) {
      expect(q.sql).toContain('WHERE');
    }
  });

  it('should compile with RETURNING clause', () => {
    const table = findTable('client');
    const queries = compileUpdateMany({
      table,
      updates: [
        {
          where: { id: { _eq: ALICE_ID } } as BoolExp,
          _set: { trust_level: 10 },
        },
      ],
      returningColumns: ['id', 'trust_level', 'username'],
      session: adminSession,
    });

    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain('json_build_object');
    expect(queries[0].sql).toContain("'id'");
    expect(queries[0].sql).toContain("'trust_level'");
    expect(queries[0].sql).toContain("'username'");
  });
});

// ─── DELETE: Array Parameter Optimization ────────────────────────────────────

describe('DELETE: array parameter optimization for large IN lists', () => {
  const adminSession = makeSession('admin');

  it('should use = ANY() for large IN lists in WHERE', () => {
    const table = findTable('client');
    // Create a large IN list (> 20 items to trigger optimization)
    const ids = Array.from({ length: 25 }, (_, i) => `id_${i}`);
    const query = compileDelete({
      table,
      where: { id: { _in: ids } } as BoolExp,
      returningColumns: ['id'],
      session: adminSession,
    });

    // Should use = ANY($N) instead of IN ($1, $2, ...)
    expect(query.sql).toContain('= ANY(');
    // Only 1 parameter for the array instead of 25
    expect(query.params).toHaveLength(1);
    expect(Array.isArray(query.params[0])).toBe(true);
  });

  it('should use regular IN for small lists', () => {
    const table = findTable('client');
    const ids = ['id_1', 'id_2', 'id_3'];
    const query = compileDelete({
      table,
      where: { id: { _in: ids } } as BoolExp,
      returningColumns: ['id'],
      session: adminSession,
    });

    // Should use regular IN ($1, $2, $3)
    expect(query.sql).toContain('IN (');
    expect(query.sql).not.toContain('= ANY(');
    expect(query.params).toHaveLength(3);
  });

  it('should use != ALL() for large NOT IN lists', () => {
    const table = findTable('client');
    const ids = Array.from({ length: 25 }, (_, i) => `id_${i}`);
    const query = compileDelete({
      table,
      where: { id: { _nin: ids } } as BoolExp,
      returningColumns: ['id'],
      session: adminSession,
    });

    expect(query.sql).toContain('!= ALL(');
    expect(query.params).toHaveLength(1);
  });

  it('should optimize _in in UPDATE WHERE clauses too', () => {
    const table = findTable('client');
    const ids = Array.from({ length: 25 }, (_, i) => `id_${i}`);
    const query = compileUpdate({
      table,
      where: { id: { _in: ids } } as BoolExp,
      _set: { trust_level: 5 },
      returningColumns: ['id'],
      session: adminSession,
    });

    expect(query.sql).toContain('= ANY(');
    expect(query.params).toHaveLength(2); // 1 for SET value + 1 for array
  });
});

// ─── Backward Compatibility ──────────────────────────────────────────────────

describe('Backward compatibility: existing mutations work unchanged', () => {
  const adminSession = makeSession('admin');

  it('compileInsert still works for normal-sized batches', async () => {
    const pool = getPool();
    const table = findTable('currency');
    const query = compileInsert({
      table,
      objects: [
        { id: 'BWC1', name: 'Backward Compat 1', symbol: 'B1' },
        { id: 'BWC2', name: 'Backward Compat 2', symbol: 'B2' },
      ],
      returningColumns: ['id', 'name'],
      session: adminSession,
    });

    expect(query.sql).toContain('VALUES');
    expect(query.params).toHaveLength(6);

    const result = await pool.query(query.sql, query.params);
    expect(result.rows).toHaveLength(2);

    await pool.query("DELETE FROM currency WHERE id IN ('BWC1', 'BWC2')");
  });

  it('compileUpdate still works with simple WHERE + _set', async () => {
    const pool = getPool();
    const table = findTable('client');

    const original = await pool.query('SELECT trust_level FROM client WHERE id = $1', [ALICE_ID]);
    const origTrust = original.rows[0].trust_level;

    const query = compileUpdate({
      table,
      where: { id: { _eq: ALICE_ID } } as BoolExp,
      _set: { trust_level: 42 },
      returningColumns: ['id', 'trust_level'],
      session: adminSession,
    });

    const result = await pool.query(query.sql, query.params);

    // CTE path returns json_agg
    const data = (result.rows[0] as Record<string, unknown>)?.data;
    if (Array.isArray(data)) {
      expect(data.length).toBe(1);
      expect(data[0].trust_level).toBe(42);
    } else {
      // Non-CTE path
      expect(result.rows).toHaveLength(1);
    }

    await pool.query('UPDATE client SET trust_level = $1 WHERE id = $2', [origTrust, ALICE_ID]);
  });

  it('compileDelete still works with simple WHERE', async () => {
    const pool = getPool();
    const table = findTable('currency');

    // Insert a row to delete
    await pool.query("INSERT INTO currency (id, name, symbol) VALUES ('BWD1', 'Delete Me', 'DM')");

    const query = compileDelete({
      table,
      where: { id: { _eq: 'BWD1' } } as BoolExp,
      returningColumns: ['id', 'name'],
      session: adminSession,
    });

    const result = await pool.query(query.sql, query.params);
    const data = (result.rows[0] as Record<string, unknown>)?.data;
    expect(data).toBeDefined();

    // Verify deletion
    const check = await pool.query("SELECT id FROM currency WHERE id = 'BWD1'");
    expect(check.rows).toHaveLength(0);
  });

  it('compileInsert with permission check still works', async () => {
    const pool = getPool();
    const table = findTable('currency');
    const permFilter = compileFilter({} as BoolExp);

    const query = compileInsert({
      table,
      objects: [
        { id: 'BWP1', name: 'Perm Test 1', symbol: 'P1' },
      ],
      returningColumns: ['id', 'name'],
      permission: {
        check: permFilter,
        columns: '*',
      },
      session: adminSession,
    });

    expect(query.sql).toContain('WITH "_inserted" AS');
    const result = await pool.query(query.sql, query.params);
    const data = (result.rows[0] as Record<string, unknown>)?.data;
    expect(Array.isArray(data)).toBe(true);

    await pool.query("DELETE FROM currency WHERE id = 'BWP1'");
  });
});
