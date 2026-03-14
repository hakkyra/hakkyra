import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { compileSelect, compileSelectByPk, compileSelectAggregate } from '../src/sql/select.js';
import { configureStringifyNumericTypes } from '../src/introspection/type-map.js';
import { compileInsertOne, compileInsert } from '../src/sql/insert.js';
import { compileUpdateByPk } from '../src/sql/update.js';
import { compileDeleteByPk } from '../src/sql/delete.js';
import { compileFilter } from '../src/permissions/compiler.js';
import { introspectDatabase } from '../src/introspection/introspector.js';
import { mergeSchemaModel } from '../src/introspection/merger.js';
import { loadConfig } from '../src/config/loader.js';
import type { BoolExp, SchemaModel, TableInfo } from '../src/types.js';
import {
  getPool, closePool, waitForDb, makeSession,
  METADATA_DIR, SERVER_CONFIG_PATH, TEST_DB_URL,
  ALICE_ID, BOB_ID, BRANCH_TEST_ID, ACCOUNT_ALICE_ID,
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

describe('SQL SELECT Compiler', () => {
  const adminSession = makeSession('admin');

  it('should compile basic SELECT with column selection', () => {
    const table = findTable('client');
    const query = compileSelect({
      table,
      columns: ['id', 'username', 'email'],
      session: adminSession,
    });
    expect(query.sql).toContain('SELECT');
    expect(query.sql).toContain('json_build_object');
    expect(query.sql).toContain('"id"');
    expect(query.sql).toContain('"username"');
  });

  it('should execute SELECT against real DB and return data', async () => {
    const pool = getPool();
    const table = findTable('client');
    const query = compileSelect({
      table,
      columns: ['id', 'username', 'status'],
      session: adminSession,
    });
    const result = await pool.query(query.sql, query.params);
    expect(result.rows).toHaveLength(1);
    const data = result.rows[0].data;
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(4); // 4 clients seeded
    expect(data[0]).toHaveProperty('id');
    expect(data[0]).toHaveProperty('username');
  });

  it('should compile SELECT with WHERE filter', () => {
    const table = findTable('client');
    const query = compileSelect({
      table,
      columns: ['id', 'username'],
      where: { status: { _eq: 'active' } } as BoolExp,
      session: adminSession,
    });
    expect(query.sql).toContain('WHERE');
    expect(query.params).toContain('active');
  });

  it('should execute SELECT with WHERE filter against DB', async () => {
    const pool = getPool();
    const table = findTable('client');
    const query = compileSelect({
      table,
      columns: ['id', 'username', 'status'],
      where: { status: { _eq: 'active' } } as BoolExp,
      session: adminSession,
    });
    const result = await pool.query(query.sql, query.params);
    const data = result.rows[0].data;
    // Only active clients (alice, bob, diana)
    expect(data.length).toBe(3);
    for (const row of data) {
      expect(row.status).toBe('active');
    }
  });

  it('should compile SELECT with ORDER BY, LIMIT, OFFSET', () => {
    const table = findTable('client');
    const query = compileSelect({
      table,
      columns: ['id', 'username'],
      orderBy: [{ column: 'username', direction: 'asc' }],
      limit: 2,
      offset: 1,
      session: adminSession,
    });
    expect(query.sql).toContain('ORDER BY');
    expect(query.sql).toContain('ASC');
    expect(query.sql).toContain('LIMIT');
    expect(query.sql).toContain('OFFSET');
  });

  it('should execute SELECT with ORDER BY + LIMIT against DB', async () => {
    const pool = getPool();
    const table = findTable('client');
    const query = compileSelect({
      table,
      columns: ['id', 'username'],
      orderBy: [{ column: 'username', direction: 'asc' }],
      limit: 2,
      session: adminSession,
    });
    const result = await pool.query(query.sql, query.params);
    const data = result.rows[0].data;
    expect(data.length).toBe(2);
    expect(data[0].username).toBe('alice');
    expect(data[1].username).toBe('bob');
  });

  it('should compile SELECT with permission filter injection', () => {
    const table = findTable('client');
    const permFilter = compileFilter({ id: { _eq: 'X-Hasura-User-Id' } } as BoolExp);
    const clientSession = makeSession('client', ALICE_ID);
    const query = compileSelect({
      table,
      columns: ['id', 'username'],
      permission: {
        filter: permFilter,
        columns: ['id', 'username', 'email', 'status'],
      },
      session: clientSession,
    });
    expect(query.sql).toContain('WHERE');
  });

  it('should execute SELECT with permission filter - client sees only own record', async () => {
    const pool = getPool();
    const table = findTable('client');
    const permFilter = compileFilter({ id: { _eq: 'X-Hasura-User-Id' } } as BoolExp);
    const clientSession = makeSession('client', ALICE_ID);
    const query = compileSelect({
      table,
      columns: ['id', 'username'],
      permission: {
        filter: permFilter,
        columns: ['id', 'username'],
      },
      session: clientSession,
    });
    const result = await pool.query(query.sql, query.params);
    const data = result.rows[0].data;
    expect(data.length).toBe(1);
    expect(data[0].id).toBe(ALICE_ID);
  });
});

describe('SQL SELECT BY PK', () => {
  const adminSession = makeSession('admin');

  it('should compile and execute SELECT by PK', async () => {
    const pool = getPool();
    const table = findTable('client');
    const query = compileSelectByPk({
      table,
      pkValues: { id: ALICE_ID },
      columns: ['id', 'username', 'email', 'status'],
      session: adminSession,
    });
    const result = await pool.query(query.sql, query.params);
    expect(result.rows).toHaveLength(1);
    const data = result.rows[0].data;
    expect(data.id).toBe(ALICE_ID);
    expect(data.username).toBe('alice');
  });

  it('should return null for non-existent PK', async () => {
    const pool = getPool();
    const table = findTable('client');
    const query = compileSelectByPk({
      table,
      pkValues: { id: '00000000-0000-0000-0000-000000000000' },
      columns: ['id', 'username'],
      session: adminSession,
    });
    const result = await pool.query(query.sql, query.params);
    expect(result.rows).toHaveLength(0);
  });
});

describe('SQL SELECT with Relationships', () => {
  const adminSession = makeSession('admin');

  it('should compile and execute SELECT with object relationship', async () => {
    const pool = getPool();
    const clientTable = findTable('client');
    const branchTable = findTable('branch');
    const branchRel = clientTable.relationships.find((r) => r.name === 'branch')!;

    const query = compileSelect({
      table: clientTable,
      columns: ['id', 'username'],
      where: { id: { _eq: ALICE_ID } } as BoolExp,
      relationships: [{
        relationship: branchRel,
        remoteTable: branchTable,
        columns: ['id', 'name', 'code'],
      }],
      session: adminSession,
    });
    const result = await pool.query(query.sql, query.params);
    const data = result.rows[0].data;
    expect(data.length).toBe(1);
    expect(data[0].branch).toBeDefined();
    expect(data[0].branch.name).toBe('TestBranch');
  });

  it('should compile and execute SELECT with array relationship', async () => {
    const pool = getPool();
    const clientTable = findTable('client');
    const accountTable = findTable('account');
    const accountsRel = clientTable.relationships.find((r) => r.name === 'accounts')!;

    const query = compileSelect({
      table: clientTable,
      columns: ['id', 'username'],
      where: { id: { _eq: ALICE_ID } } as BoolExp,
      relationships: [{
        relationship: accountsRel,
        remoteTable: accountTable,
        columns: ['id', 'balance', 'currency_id'],
      }],
      session: adminSession,
    });
    const result = await pool.query(query.sql, query.params);
    const data = result.rows[0].data;
    expect(data.length).toBe(1);
    expect(data[0].accounts).toBeDefined();
    expect(Array.isArray(data[0].accounts)).toBe(true);
    expect(data[0].accounts.length).toBeGreaterThan(0);
  });

  it('should compile and execute SELECT with nested relationships', async () => {
    const pool = getPool();
    const clientTable = findTable('client');
    const accountTable = findTable('account');
    const currencyTable = findTable('currency');

    const accountsRel = clientTable.relationships.find((r) => r.name === 'accounts')!;
    const currencyRel = accountTable.relationships.find((r) => r.name === 'currency')!;

    const query = compileSelect({
      table: clientTable,
      columns: ['id', 'username'],
      where: { id: { _eq: ALICE_ID } } as BoolExp,
      relationships: [{
        relationship: accountsRel,
        remoteTable: accountTable,
        columns: ['id', 'balance'],
        relationships: [{
          relationship: currencyRel,
          remoteTable: currencyTable,
          columns: ['id', 'name', 'symbol'],
        }],
      }],
      session: adminSession,
    });
    const result = await pool.query(query.sql, query.params);
    const data = result.rows[0].data;
    expect(data[0].accounts[0].currency).toBeDefined();
    expect(data[0].accounts[0].currency.id).toBe('EUR');
  });
});

describe('stringify_numeric_types', () => {
  const adminSession = makeSession('admin');

  it('should preserve numeric precision when stringify_numeric_types is enabled', async () => {
    const pool = getPool();
    const table = findTable('account');

    // Enable stringify_numeric_types
    configureStringifyNumericTypes(true);
    try {
      const query = compileSelect({
        table,
        columns: ['id', 'balance'],
        limit: 1,
        session: adminSession,
      });

      // The SQL should cast numeric columns to text
      expect(query.sql).toContain('::text');

      const result = await pool.query(query.sql, query.params);
      const row = result.rows[0].data[0];

      // balance is NUMERIC(20,4) — the value should be a string preserving decimal places
      expect(typeof row.balance).toBe('string');
      expect(row.balance).toMatch(/\.\d{4}$/);
    } finally {
      // Restore default
      configureStringifyNumericTypes(false);
    }
  });

  it('should NOT cast numeric columns to text when stringify_numeric_types is disabled', () => {
    const table = findTable('account');

    configureStringifyNumericTypes(false);
    const query = compileSelect({
      table,
      columns: ['id', 'balance'],
      session: adminSession,
    });

    // Should not have ::text cast for balance
    expect(query.sql).not.toMatch(/"balance"\)::text/);
  });
});

describe('JSONB _cast operator', () => {
  const adminSession = makeSession('admin');

  it('should compile _cast String with _like to (col)::text LIKE $N', () => {
    const table = findTable('client_data');
    const query = compileSelect({
      table,
      columns: ['id', 'key', 'value'],
      where: { value: { _cast: { String: { _like: '%dark%' } } } } as BoolExp,
      session: adminSession,
    });
    expect(query.sql).toContain('::text');
    expect(query.sql).toContain('LIKE');
    expect(query.params).toContain('%dark%');
  });

  it('should execute _cast String _like filter against real DB', async () => {
    const pool = getPool();
    const table = findTable('client_data');
    const query = compileSelect({
      table,
      columns: ['id', 'key', 'value'],
      where: { value: { _cast: { String: { _like: '%dark%' } } } } as BoolExp,
      session: adminSession,
    });
    const result = await pool.query(query.sql, query.params);
    const data = result.rows[0].data;
    // The preferences row has {"theme": "dark", "notifications": true}
    expect(data.length).toBeGreaterThanOrEqual(1);
    for (const row of data) {
      expect(row.key).toBe('preferences');
    }
  });

  it('should compile _cast String with _ilike', () => {
    const table = findTable('client_data');
    const query = compileSelect({
      table,
      columns: ['id', 'key'],
      where: { value: { _cast: { String: { _ilike: '%HELSINKI%' } } } } as BoolExp,
      session: adminSession,
    });
    expect(query.sql).toContain('::text');
    expect(query.sql).toContain('ILIKE');
    expect(query.params).toContain('%HELSINKI%');
  });

  it('should combine _cast with other JSONB operators', () => {
    const table = findTable('client_data');
    const query = compileSelect({
      table,
      columns: ['id', 'key'],
      where: {
        value: {
          _cast: { String: { _like: '%dark%' } },
          _hasKey: 'theme',
        },
      } as BoolExp,
      session: adminSession,
    });
    expect(query.sql).toContain('::text');
    expect(query.sql).toContain('LIKE');
    expect(query.sql).toContain('?');
  });
});

describe('SQL SELECT Aggregate', () => {
  const adminSession = makeSession('admin');

  it('should compile and execute count aggregate', async () => {
    const pool = getPool();
    const table = findTable('client');
    const query = compileSelectAggregate({
      table,
      aggregate: { count: {} },
      session: adminSession,
    });
    const result = await pool.query(query.sql, query.params);
    expect(result.rows).toHaveLength(1);
    const agg = result.rows[0].aggregate;
    expect(agg.count).toBe(4);
  });

  it('should compile and execute sum aggregate', async () => {
    const pool = getPool();
    const table = findTable('account');
    const query = compileSelectAggregate({
      table,
      aggregate: { sum: ['balance'] },
      session: adminSession,
    });
    const result = await pool.query(query.sql, query.params);
    const agg = result.rows[0].aggregate;
    expect(agg.sum).toBeDefined();
    expect(Number(agg.sum.balance)).toBeGreaterThan(0);
  });

  it('should compile aggregate with WHERE filter', async () => {
    const pool = getPool();
    const table = findTable('client');
    const query = compileSelectAggregate({
      table,
      where: { status: { _eq: 'active' } } as BoolExp,
      aggregate: { count: {} },
      session: adminSession,
    });
    const result = await pool.query(query.sql, query.params);
    const agg = result.rows[0].aggregate;
    expect(agg.count).toBe(3); // alice, bob, diana are active
  });
});

describe('SQL INSERT Compiler', () => {
  const adminSession = makeSession('admin');

  it('should compile and execute INSERT single row with RETURNING', async () => {
    const pool = getPool();
    const table = findTable('client');
    const newId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee01';
    const query = compileInsertOne({
      table,
      object: {
        id: newId,
        username: 'test_insert_user',
        email: 'insert@test.com',
        branch_id: BRANCH_TEST_ID,
        currency_id: 'EUR',
        status: 'active',
      },
      returningColumns: ['id', 'username', 'status'],
      session: adminSession,
    });
    const result = await pool.query(query.sql, query.params);
    expect(result.rows).toHaveLength(1);
    const data = result.rows[0].data;
    expect(data.id).toBe(newId);
    expect(data.username).toBe('test_insert_user');

    // Cleanup
    await pool.query('DELETE FROM client WHERE id = $1', [newId]);
  });

  it('should compile INSERT with column presets', async () => {
    const pool = getPool();
    const table = findTable('client');
    const newId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee02';
    const permFilter = compileFilter({} as BoolExp);
    const backofficeSession = makeSession('backoffice');

    const query = compileInsertOne({
      table,
      object: {
        id: newId,
        username: 'test_preset_user',
        email: 'preset@test.com',
        branch_id: BRANCH_TEST_ID,
        currency_id: 'EUR',
      },
      returningColumns: ['id', 'username', 'status'],
      permission: {
        check: permFilter,
        columns: '*',
        presets: { status: 'active' },
      },
      session: backofficeSession,
    });
    const result = await pool.query(query.sql, query.params);
    const data = result.rows[0].data;
    expect(data.status).toBe('active');

    // Cleanup
    await pool.query('DELETE FROM client WHERE id = $1', [newId]);
  });

  it('should compile and execute bulk INSERT', async () => {
    const pool = getPool();
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
    const result = await pool.query(query.sql, query.params);
    expect(result.rows.length).toBeGreaterThanOrEqual(1);

    // Cleanup
    await pool.query("DELETE FROM currency WHERE id IN ('SEK', 'NOK')");
  });
});

describe('SQL UPDATE Compiler', () => {
  const adminSession = makeSession('admin');

  it('should compile and execute UPDATE by PK', async () => {
    const pool = getPool();
    const table = findTable('client');
    const query = compileUpdateByPk({
      table,
      pkValues: { id: ALICE_ID },
      _set: { trust_level: 99 },
      returningColumns: ['id', 'trust_level'],
      session: adminSession,
    });
    const result = await pool.query(query.sql, query.params);
    expect(result.rows).toHaveLength(1);
    const data = result.rows[0].data;
    expect(data.trust_level).toBe(99);

    // Reset
    await pool.query('UPDATE client SET trust_level = 2 WHERE id = $1', [ALICE_ID]);
  });

  it('should compile UPDATE with permission filter', async () => {
    const pool = getPool();
    const table = findTable('client');
    const permFilter = compileFilter({ id: { _eq: 'X-Hasura-User-Id' } } as BoolExp);
    const clientSession = makeSession('client', ALICE_ID);

    const query = compileUpdateByPk({
      table,
      pkValues: { id: ALICE_ID },
      _set: { language_id: 'fi' },
      returningColumns: ['id', 'language_id'],
      permission: {
        filter: permFilter,
        columns: ['language_id', 'currency_id'],
      },
      session: clientSession,
    });
    const result = await pool.query(query.sql, query.params);
    expect(result.rows).toHaveLength(1);
    const data = result.rows[0].data;
    expect(data.language_id).toBe('fi');

    // Reset
    await pool.query("UPDATE client SET language_id = 'en' WHERE id = $1", [ALICE_ID]);
  });

  it('should return no rows when permission filter blocks update', async () => {
    const pool = getPool();
    const table = findTable('client');
    const permFilter = compileFilter({ id: { _eq: 'X-Hasura-User-Id' } } as BoolExp);
    const clientSession = makeSession('client', ALICE_ID);

    // Try to update Bob's record as Alice
    const query = compileUpdateByPk({
      table,
      pkValues: { id: BOB_ID },
      _set: { language_id: 'fi' },
      returningColumns: ['id'],
      permission: {
        filter: permFilter,
        columns: ['language_id'],
      },
      session: clientSession,
    });
    const result = await pool.query(query.sql, query.params);
    expect(result.rows).toHaveLength(0);
  });
});

describe('SQL DELETE Compiler', () => {
  const adminSession = makeSession('admin');

  it('should compile and execute DELETE by PK', async () => {
    const pool = getPool();
    const table = findTable('currency');
    // Insert a row to delete
    await pool.query("INSERT INTO currency (id, name, symbol) VALUES ('DKK', 'Danish Krone', 'kr')");

    const query = compileDeleteByPk({
      table,
      pkValues: { id: 'DKK' },
      returningColumns: ['id', 'name'],
      session: adminSession,
    });
    const result = await pool.query(query.sql, query.params);
    expect(result.rows).toHaveLength(1);
    const data = result.rows[0].data;
    expect(data.id).toBe('DKK');

    // Verify deletion
    const check = await pool.query("SELECT id FROM currency WHERE id = 'DKK'");
    expect(check.rows).toHaveLength(0);
  });

  it('should compile DELETE with permission filter', async () => {
    const pool = getPool();
    const table = findTable('client_data');
    const permFilter = compileFilter({ client_id: { _eq: 'X-Hasura-User-Id' } } as BoolExp);
    const clientSession = makeSession('client', ALICE_ID);

    // Insert a test row
    await pool.query(
      "INSERT INTO client_data (id, client_id, key, value) VALUES ('aaaaaaaa-0000-0000-0000-000000000099', $1, 'test_key', '\"test_value\"')",
      [ALICE_ID],
    );

    const query = compileDeleteByPk({
      table,
      pkValues: { id: 'aaaaaaaa-0000-0000-0000-000000000099' },
      returningColumns: ['id', 'key'],
      permission: { filter: permFilter },
      session: clientSession,
    });
    const result = await pool.query(query.sql, query.params);
    expect(result.rows).toHaveLength(1);
  });
});
