import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { compileSelectAggregate } from '../src/sql/select.js';
import { introspectDatabase } from '../src/introspection/introspector.js';
import { mergeSchemaModel } from '../src/introspection/merger.js';
import { loadConfig } from '../src/config/loader.js';
import type { SchemaModel, TableInfo } from '../src/types.js';
import {
  startServer, stopServer, closePool, waitForDb,
  graphqlRequest,
  tokens, ADMIN_SECRET,
  getPool, makeSession,
  METADATA_DIR, SERVER_CONFIG_PATH, TEST_DB_URL,
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

// ─── SQL Compiler: Statistical Aggregates ────────────────────────────────

describe('SQL Compiler: Statistical Aggregates', () => {
  const adminSession = makeSession('admin');

  it('compiles and executes stddev aggregate', async () => {
    const pool = getPool();
    const table = findTable('account');
    const query = compileSelectAggregate({
      table,
      aggregate: { stddev: ['balance'] },
      session: adminSession,
    });

    expect(query.sql).toContain('stddev(');
    const result = await pool.query(query.sql, query.params);
    expect(result.rows).toHaveLength(1);
    const agg = result.rows[0].aggregate;
    expect(agg.stddev).toBeDefined();
    expect(agg.stddev.balance).toBeDefined();
  });

  it('compiles and executes stddev_pop aggregate', async () => {
    const pool = getPool();
    const table = findTable('account');
    const query = compileSelectAggregate({
      table,
      aggregate: { stddevPop: ['balance'] },
      session: adminSession,
    });

    expect(query.sql).toContain('stddev_pop(');
    const result = await pool.query(query.sql, query.params);
    const agg = result.rows[0].aggregate;
    expect(agg.stddevPop).toBeDefined();
    expect(agg.stddevPop.balance).toBeDefined();
  });

  it('compiles and executes stddev_samp aggregate', async () => {
    const pool = getPool();
    const table = findTable('account');
    const query = compileSelectAggregate({
      table,
      aggregate: { stddevSamp: ['balance'] },
      session: adminSession,
    });

    expect(query.sql).toContain('stddev_samp(');
    const result = await pool.query(query.sql, query.params);
    const agg = result.rows[0].aggregate;
    expect(agg.stddevSamp).toBeDefined();
    expect(agg.stddevSamp.balance).toBeDefined();
  });

  it('compiles and executes variance aggregate', async () => {
    const pool = getPool();
    const table = findTable('account');
    const query = compileSelectAggregate({
      table,
      aggregate: { variance: ['balance'] },
      session: adminSession,
    });

    expect(query.sql).toContain('variance(');
    const result = await pool.query(query.sql, query.params);
    const agg = result.rows[0].aggregate;
    expect(agg.variance).toBeDefined();
    expect(agg.variance.balance).toBeDefined();
  });

  it('compiles and executes var_pop aggregate', async () => {
    const pool = getPool();
    const table = findTable('account');
    const query = compileSelectAggregate({
      table,
      aggregate: { varPop: ['balance'] },
      session: adminSession,
    });

    expect(query.sql).toContain('var_pop(');
    const result = await pool.query(query.sql, query.params);
    const agg = result.rows[0].aggregate;
    expect(agg.varPop).toBeDefined();
    expect(agg.varPop.balance).toBeDefined();
  });

  it('compiles and executes var_samp aggregate', async () => {
    const pool = getPool();
    const table = findTable('account');
    const query = compileSelectAggregate({
      table,
      aggregate: { varSamp: ['balance'] },
      session: adminSession,
    });

    expect(query.sql).toContain('var_samp(');
    const result = await pool.query(query.sql, query.params);
    const agg = result.rows[0].aggregate;
    expect(agg.varSamp).toBeDefined();
    expect(agg.varSamp.balance).toBeDefined();
  });

  it('compiles multiple statistical aggregates together', async () => {
    const pool = getPool();
    const table = findTable('account');
    const query = compileSelectAggregate({
      table,
      aggregate: {
        count: {},
        avg: ['balance'],
        stddev: ['balance'],
        variance: ['balance'],
      },
      session: adminSession,
    });

    const result = await pool.query(query.sql, query.params);
    const agg = result.rows[0].aggregate;
    expect(agg.count).toBeDefined();
    expect(agg.avg).toBeDefined();
    expect(agg.stddev).toBeDefined();
    expect(agg.variance).toBeDefined();
  });

  it('compiles statistical aggregates with GROUP BY', async () => {
    const pool = getPool();
    const table = findTable('account');
    const query = compileSelectAggregate({
      table,
      aggregate: {
        count: {},
        stddev: ['balance'],
        variance: ['balance'],
      },
      groupBy: ['currency_id'],
      session: adminSession,
    });

    expect(query.sql).toContain('GROUP BY');
    expect(query.sql).toContain('stddev(');
    expect(query.sql).toContain('variance(');

    const result = await pool.query(query.sql, query.params);
    const grouped = result.rows[0].groupedAggregates;
    expect(Array.isArray(grouped)).toBe(true);
    expect(grouped.length).toBeGreaterThan(0);

    for (const group of grouped) {
      expect(group.keys.currency_id).toBeDefined();
      expect(typeof group.count).toBe('number');
      // stddev and variance may be null for single-row groups
      expect(group.stddev).toBeDefined();
      expect(group.variance).toBeDefined();
    }
  });
});

// ─── GraphQL E2E: Statistical Aggregates ─────────────────────────────────

describe('GraphQL Statistical Aggregates', () => {
  it('returns stddev of account balance (admin)', async () => {
    const { status, body } = await graphqlRequest(
      `query {
        accountAggregate {
          aggregate {
            stddev { balance }
          }
        }
      }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();

    const agg = (body.data as { accountAggregate: AnyRow }).accountAggregate;
    const aggregate = agg.aggregate as AnyRow;
    expect(aggregate.stddev).toBeDefined();
  });

  it('returns stddevPop of account balance (admin)', async () => {
    const { status, body } = await graphqlRequest(
      `query {
        accountAggregate {
          aggregate {
            stddevPop { balance }
          }
        }
      }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();

    const agg = (body.data as { accountAggregate: AnyRow }).accountAggregate;
    const aggregate = agg.aggregate as AnyRow;
    expect(aggregate.stddevPop).toBeDefined();
  });

  it('returns variance of account balance (admin)', async () => {
    const { status, body } = await graphqlRequest(
      `query {
        accountAggregate {
          aggregate {
            variance { balance }
            varPop { balance }
            varSamp { balance }
          }
        }
      }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();

    const agg = (body.data as { accountAggregate: AnyRow }).accountAggregate;
    const aggregate = agg.aggregate as AnyRow;
    expect(aggregate.variance).toBeDefined();
    expect(aggregate.varPop).toBeDefined();
    expect(aggregate.varSamp).toBeDefined();
  });

  it('returns all statistical aggregates together (admin)', async () => {
    const { status, body } = await graphqlRequest(
      `query {
        accountAggregate {
          aggregate {
            count
            avg { balance }
            stddev { balance }
            stddevPop { balance }
            stddevSamp { balance }
            variance { balance }
            varPop { balance }
            varSamp { balance }
          }
        }
      }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();

    const agg = (body.data as { accountAggregate: AnyRow }).accountAggregate;
    const aggregate = agg.aggregate as AnyRow;
    expect(aggregate.count).toBeDefined();
    expect(aggregate.avg).toBeDefined();
    expect(aggregate.stddev).toBeDefined();
    expect(aggregate.stddevPop).toBeDefined();
    expect(aggregate.stddevSamp).toBeDefined();
    expect(aggregate.variance).toBeDefined();
    expect(aggregate.varPop).toBeDefined();
    expect(aggregate.varSamp).toBeDefined();
  });

  it('denies statistical aggregation to role without allow_aggregations', async () => {
    const token = await tokens.client(ADMIN_SECRET);
    const { body } = await graphqlRequest(
      `query {
        clientsAggregate {
          aggregate {
            stddev { trustLevel }
          }
        }
      }`,
      undefined,
      { authorization: `Bearer ${token}` },
    );
    // client role lacks allow_aggregations on client table
    expect(body.errors).toBeDefined();
  });

  it('returns statistical aggregates in grouped query (admin)', async () => {
    const { status, body } = await graphqlRequest(
      `query {
        accountAggregate(distinctOn: [currencyId]) {
          groupedAggregates {
            keys { currencyId }
            count
            stddev { balance }
            variance { balance }
          }
        }
      }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();

    const agg = (body.data as { accountAggregate: AnyRow }).accountAggregate;
    expect(agg.groupedAggregates).toBeDefined();
    const groups = agg.groupedAggregates as AnyRow[];
    expect(groups.length).toBeGreaterThan(0);

    for (const group of groups) {
      expect((group.keys as AnyRow).currencyId).toBeDefined();
      expect(typeof group.count).toBe('number');
    }
  });

  it('returns statistical aggregates with backoffice role', async () => {
    const token = await tokens.backoffice();
    const { status, body } = await graphqlRequest(
      `query {
        accountAggregate {
          aggregate {
            stddev { balance }
            variance { balance }
          }
        }
      }`,
      undefined,
      { authorization: `Bearer ${token}` },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();

    const agg = (body.data as { accountAggregate: AnyRow }).accountAggregate;
    const aggregate = agg.aggregate as AnyRow;
    expect(aggregate.stddev).toBeDefined();
    expect(aggregate.variance).toBeDefined();
  });
});
