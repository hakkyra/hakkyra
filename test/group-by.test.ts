import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { compileSelectAggregate } from '../src/sql/select.js';
import { compileFilter } from '../src/permissions/compiler.js';
import { introspectDatabase } from '../src/introspection/introspector.js';
import { mergeSchemaModel } from '../src/introspection/merger.js';
import { loadConfig } from '../src/config/loader.js';
import type { BoolExp, SchemaModel, TableInfo } from '../src/types.js';
import {
  startServer, stopServer, closePool, waitForDb,
  graphqlRequest, restRequest,
  tokens, ADMIN_SECRET,
  getPool, makeSession,
  METADATA_DIR, SERVER_CONFIG_PATH, TEST_DB_URL,
  ALICE_ID, BRANCH_TEST_ID,
} from './setup.js';

type AnyRow = Record<string, unknown>;

let schemaModel: SchemaModel;

function findTable(name: string): TableInfo {
  const table = schemaModel.tables.find((t) => t.name === name);
  if (!table) throw new Error(`Table ${name} not found in schema model`);
  return table;
}

// ─── Server + Schema lifecycle ────────────────────────────────────────────

beforeAll(async () => {
  process.env['DATABASE_URL'] = TEST_DB_URL;
  process.env['HAKKYRA_ADMIN_SECRET'] = ADMIN_SECRET;
  await waitForDb();

  // Load schema model for SQL compiler tests
  const pool = getPool();
  const introspection = await introspectDatabase(pool);
  const config = await loadConfig(METADATA_DIR, SERVER_CONFIG_PATH);
  const result = mergeSchemaModel(introspection, config);
  schemaModel = result.model;

  // Start server for E2E tests
  await startServer();
}, 30_000);

afterAll(async () => {
  await stopServer();
  await closePool();
});

// ─── SQL Compiler: GROUP BY ──────────────────────────────────────────────

describe('SQL Compiler: GROUP BY', () => {
  const adminSession = makeSession('admin');

  it('compiles GROUP BY single column with count', async () => {
    const pool = getPool();
    const table = findTable('client');
    const query = compileSelectAggregate({
      table,
      aggregate: { count: {} },
      groupBy: ['status'],
      session: adminSession,
    });

    expect(query.sql).toContain('GROUP BY');
    expect(query.sql).toContain('"status"');
    expect(query.sql).toContain('groupedAggregates');

    const result = await pool.query(query.sql, query.params);
    expect(result.rows).toHaveLength(1);
    const grouped = result.rows[0].groupedAggregates;
    expect(Array.isArray(grouped)).toBe(true);
    expect(grouped.length).toBeGreaterThan(0);

    // Each group should have keys and count
    for (const group of grouped) {
      expect(group.keys).toBeDefined();
      expect(group.keys.status).toBeDefined();
      expect(typeof group.count).toBe('number');
      expect(group.count).toBeGreaterThan(0);
    }

    // Verify: active=3, on_hold=1
    const activeGroup = grouped.find((g: AnyRow) => (g.keys as AnyRow).status === 'active');
    const onHoldGroup = grouped.find((g: AnyRow) => (g.keys as AnyRow).status === 'on_hold');
    expect(activeGroup?.count).toBe(3);
    expect(onHoldGroup?.count).toBe(1);
  });

  it('compiles GROUP BY multiple columns', async () => {
    const pool = getPool();
    const table = findTable('invoice');
    const query = compileSelectAggregate({
      table,
      aggregate: { count: {}, sum: ['amount'] },
      groupBy: ['state', 'type'],
      session: adminSession,
    });

    expect(query.sql).toContain('GROUP BY');

    const result = await pool.query(query.sql, query.params);
    const grouped = result.rows[0].groupedAggregates;
    expect(Array.isArray(grouped)).toBe(true);
    expect(grouped.length).toBeGreaterThan(0);

    for (const group of grouped) {
      expect(group.keys.state).toBeDefined();
      expect(group.keys.type).toBeDefined();
      expect(typeof group.count).toBe('number');
      if (group.sum) {
        expect(group.sum.amount).toBeDefined();
      }
    }
  });

  it('compiles GROUP BY with WHERE filter', async () => {
    const pool = getPool();
    const table = findTable('client');
    const query = compileSelectAggregate({
      table,
      where: { status: { _eq: 'active' } } as BoolExp,
      aggregate: { count: {} },
      groupBy: ['branch_id'],
      session: adminSession,
    });

    const result = await pool.query(query.sql, query.params);
    const grouped = result.rows[0].groupedAggregates;
    expect(Array.isArray(grouped)).toBe(true);

    // Only active clients grouped by branch
    let totalCount = 0;
    for (const group of grouped) {
      totalCount += group.count;
    }
    expect(totalCount).toBe(3); // alice, bob, diana are active
  });

  it('compiles GROUP BY with sum/avg aggregates', async () => {
    const pool = getPool();
    const table = findTable('account');
    const query = compileSelectAggregate({
      table,
      aggregate: { count: {}, sum: ['balance'], avg: ['balance'] },
      groupBy: ['currency_id'],
      session: adminSession,
    });

    const result = await pool.query(query.sql, query.params);
    const grouped = result.rows[0].groupedAggregates;
    expect(Array.isArray(grouped)).toBe(true);

    for (const group of grouped) {
      expect(group.keys.currency_id).toBeDefined();
      expect(typeof group.count).toBe('number');
      expect(group.sum).toBeDefined();
      expect(group.avg).toBeDefined();
    }
  });

  it('compiles GROUP BY with permission restriction on columns', async () => {
    const pool = getPool();
    const table = findTable('client');
    const permFilter = compileFilter({} as BoolExp);

    const query = compileSelectAggregate({
      table,
      aggregate: { count: {} },
      groupBy: ['status', 'trust_level'], // trust_level not in allowed columns
      permission: {
        filter: permFilter,
        columns: ['id', 'username', 'status'], // trust_level excluded
      },
      session: makeSession('client', ALICE_ID),
    });

    const result = await pool.query(query.sql, query.params);
    const grouped = result.rows[0].groupedAggregates;
    expect(Array.isArray(grouped)).toBe(true);

    // trust_level should be filtered out, only status should appear in keys
    for (const group of grouped) {
      expect(group.keys.status).toBeDefined();
      // trust_level should NOT appear in keys because it's not in allowed columns
      expect(group.keys.trust_level).toBeUndefined();
    }
  });

  it('falls back to standard aggregate when groupBy is empty', async () => {
    const pool = getPool();
    const table = findTable('client');
    const query = compileSelectAggregate({
      table,
      aggregate: { count: {} },
      groupBy: [],
      session: adminSession,
    });

    // Should not contain GROUP BY
    expect(query.sql).not.toContain('GROUP BY');
    expect(query.sql).toContain('aggregate');

    const result = await pool.query(query.sql, query.params);
    const agg = result.rows[0].aggregate;
    expect(agg.count).toBe(4);
  });
});

// ─── Backward Compatibility ──────────────────────────────────────────────

describe('GROUP BY backward compatibility', () => {
  const adminSession = makeSession('admin');

  it('existing aggregate queries work without groupBy', async () => {
    const pool = getPool();
    const table = findTable('client');
    const query = compileSelectAggregate({
      table,
      aggregate: { count: {} },
      nodes: {
        columns: ['id', 'username', 'status'],
      },
      session: adminSession,
    });

    // Should not contain GROUP BY
    expect(query.sql).not.toContain('GROUP BY');
    expect(query.sql).not.toContain('groupedAggregates');

    const result = await pool.query(query.sql, query.params);
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row.aggregate).toBeDefined();
    expect(row.aggregate.count).toBe(4);
    expect(row.nodes).toBeDefined();
    expect(Array.isArray(row.nodes)).toBe(true);
    expect(row.nodes.length).toBe(4);
  });

  it('aggregate with WHERE still works without groupBy', async () => {
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
    expect(agg.count).toBe(3);
  });
});

// ─── GraphQL E2E: GROUP BY ──────────────────────────────────────────────

describe('GraphQL GROUP BY', () => {
  it('groups clients by status with count (backoffice)', async () => {
    const token = await tokens.backoffice();
    const { status, body } = await graphqlRequest(
      `query {
        clientsAggregate(groupBy: [status]) {
          groupedAggregates {
            keys { status }
            count
          }
        }
      }`,
      undefined,
      { authorization: `Bearer ${token}` },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();

    const agg = (body.data as { clientsAggregate: AnyRow }).clientsAggregate;
    expect(agg.groupedAggregates).toBeDefined();
    const groups = agg.groupedAggregates as AnyRow[];
    expect(groups.length).toBeGreaterThan(0);

    // Find the active group
    const activeGroup = groups.find((g) => (g.keys as AnyRow).status === 'ACTIVE');
    // Status comes through as enum (uppercase) from GraphQL
    // But the raw SQL returns the PG value. Check both.
    const activeGroupAlt = groups.find((g) => (g.keys as AnyRow).status === 'active');
    const found = activeGroup ?? activeGroupAlt;
    expect(found).toBeDefined();
    expect(found!.count).toBe(3);
  });

  it('groups invoices by state with sum (admin)', async () => {
    const { status, body } = await graphqlRequest(
      `query {
        invoiceAggregate(groupBy: [state]) {
          groupedAggregates {
            keys { state }
            count
            sum { amount }
          }
        }
      }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();

    const agg = (body.data as { invoiceAggregate: AnyRow }).invoiceAggregate;
    expect(agg.groupedAggregates).toBeDefined();
    const groups = agg.groupedAggregates as AnyRow[];
    expect(groups.length).toBeGreaterThan(0);

    for (const group of groups) {
      expect((group.keys as AnyRow).state).toBeDefined();
      expect(typeof group.count).toBe('number');
    }
  });

  it('groups with WHERE filter', async () => {
    const token = await tokens.backoffice();
    const { status, body } = await graphqlRequest(
      `query($branchId: Uuid!) {
        clientsAggregate(
          where: { branchId: { _eq: $branchId } }
          groupBy: [status]
        ) {
          groupedAggregates {
            keys { status }
            count
          }
        }
      }`,
      { branchId: BRANCH_TEST_ID },
      { authorization: `Bearer ${token}` },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();

    const agg = (body.data as { clientsAggregate: AnyRow }).clientsAggregate;
    const groups = agg.groupedAggregates as AnyRow[];

    // BRANCH_TEST_ID has alice (active) and bob (active), so all in that branch are active
    let totalCount = 0;
    for (const group of groups) {
      totalCount += group.count as number;
    }
    expect(totalCount).toBe(2);
  });

  it('existing aggregate query still works without groupBy', async () => {
    const token = await tokens.backoffice();
    const { status, body } = await graphqlRequest(
      `query { clientsAggregate { aggregate { count } nodes { id } } }`,
      undefined,
      { authorization: `Bearer ${token}` },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();

    const agg = (body.data as {
      clientsAggregate: { aggregate: { count: number }; nodes: AnyRow[] };
    }).clientsAggregate;
    expect(agg.aggregate.count).toBe(4);
    expect(agg.nodes).toHaveLength(4);
  });

  it('denies grouped aggregation to role without allow_aggregations', async () => {
    const token = await tokens.client(ALICE_ID);
    const { body } = await graphqlRequest(
      `query {
        clientsAggregate(groupBy: [status]) {
          groupedAggregates {
            keys { status }
            count
          }
        }
      }`,
      undefined,
      { authorization: `Bearer ${token}` },
    );
    // client role lacks allow_aggregations on client table
    expect(body.errors).toBeDefined();
  });

  it('groups by multiple columns', async () => {
    const { status, body } = await graphqlRequest(
      `query {
        invoiceAggregate(groupBy: [state, type]) {
          groupedAggregates {
            keys { state type }
            count
          }
        }
      }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();

    const agg = (body.data as { invoiceAggregate: AnyRow }).invoiceAggregate;
    const groups = agg.groupedAggregates as AnyRow[];
    expect(groups.length).toBeGreaterThan(0);

    for (const group of groups) {
      expect((group.keys as AnyRow).state).toBeDefined();
      expect((group.keys as AnyRow).type).toBeDefined();
    }
  });
});

// ─── REST API: Aggregate endpoint ────────────────────────────────────────

describe('REST Aggregate API', () => {
  it('returns aggregate count without group_by', async () => {
    const { status, body } = await restRequest('GET', '/api/v1/client/aggregate', {
      headers: { 'x-hasura-admin-secret': ADMIN_SECRET },
    });
    expect(status).toBe(200);
    const data = body as { aggregate: { count: number } };
    expect(data.aggregate).toBeDefined();
    expect(data.aggregate.count).toBe(4);
  });

  it('returns grouped aggregates with group_by', async () => {
    const { status, body } = await restRequest('GET', '/api/v1/client/aggregate', {
      headers: { 'x-hasura-admin-secret': ADMIN_SECRET },
      query: { group_by: 'status' },
    });
    expect(status).toBe(200);
    const groups = body as AnyRow[];
    expect(Array.isArray(groups)).toBe(true);
    expect(groups.length).toBeGreaterThan(0);

    for (const group of groups) {
      expect(group.keys).toBeDefined();
      expect((group.keys as AnyRow).status).toBeDefined();
      expect(typeof group.count).toBe('number');
    }
  });

  it('returns grouped aggregates with WHERE filter', async () => {
    const { status, body } = await restRequest('GET', '/api/v1/client/aggregate', {
      headers: { 'x-hasura-admin-secret': ADMIN_SECRET },
      query: { group_by: 'branch_id', status: 'eq.active' },
    });
    expect(status).toBe(200);
    const groups = body as AnyRow[];
    expect(Array.isArray(groups)).toBe(true);

    let totalCount = 0;
    for (const group of groups) {
      totalCount += (group.count as number);
    }
    expect(totalCount).toBe(3); // 3 active clients
  });

  it('returns 403 for role without select permission', async () => {
    const { status } = await restRequest('GET', '/api/v1/client/aggregate');
    // No auth headers => anonymous, which has no select on client table
    expect(status).toBe(403);
  });
});
