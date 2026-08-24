/**
 * P13.2 — stringify_numeric_types applied to aggregate output and
 * native query / logical model fields.
 *
 * With `server.stringify_numeric_types: true`, Hasura returns aggregate
 * results as JSON strings (count → "3", sum(numeric) → "3000.0000").
 * Hakkyra builds aggregate JSON in SQL, so the casts must happen there,
 * and the built-in Int/Float serializers must let those strings through.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { compileSelectAggregate } from '../src/sql/select.js';
import { configureStringifyNumericTypes } from '../src/introspection/type-map.js';
import { introspectDatabase } from '../src/introspection/introspector.js';
import { mergeSchemaModel } from '../src/introspection/merger.js';
import { loadConfig } from '../src/config/loader.js';
import type { SchemaModel, TableInfo } from '../src/types.js';
import {
  TEST_DB_URL,
  METADATA_DIR,
  SERVER_CONFIG_PATH,
  ADMIN_SECRET,
  waitForDb,
  getPool,
  closePool,
  makeSession,
} from './setup.js';

type AnyRow = Record<string, unknown>;

let schemaModel: SchemaModel;
let server: FastifyInstance;
let serverAddress: string;

function findTable(name: string): TableInfo {
  const table = schemaModel.tables.find((t) => t.name === name);
  if (!table) throw new Error(`Table ${name} not found in schema model`);
  return table;
}

async function gql(query: string, variables?: Record<string, unknown>): Promise<{ data?: AnyRow; errors?: AnyRow[] }> {
  const res = await fetch(`${serverAddress}/graphql`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hasura-admin-secret': ADMIN_SECRET,
    },
    body: JSON.stringify({ query, variables }),
  });
  return await res.json() as { data?: AnyRow; errors?: AnyRow[] };
}

beforeAll(async () => {
  process.env['DATABASE_URL'] = TEST_DB_URL;
  process.env['HAKKYRA_ADMIN_SECRET'] = ADMIN_SECRET;
  process.env['LOG_LEVEL'] = 'error';
  await waitForDb();

  const pool = getPool();
  const introspection = await introspectDatabase(pool);
  const config = await loadConfig(METADATA_DIR, SERVER_CONFIG_PATH);
  const result = mergeSchemaModel(introspection, config);
  schemaModel = result.model;

  // Boot a dedicated server with stringify_numeric_types enabled.
  // (This also flips the module-level stringify state used by the SQL compiler.)
  config.server.stringifyNumericTypes = true;
  const { createServer } = await import('../src/server.js');
  server = await createServer(config);
  serverAddress = await server.listen({ port: 0, host: '127.0.0.1' });
}, 30_000);

afterAll(async () => {
  if (server) await server.close();
  configureStringifyNumericTypes(false);
  await closePool();
});

// ─── SQL Compiler ────────────────────────────────────────────────────────────

describe('SQL compiler: aggregate stringification', () => {
  const adminSession = makeSession('admin');

  it('casts count and numeric aggregates to text when stringify is enabled', () => {
    configureStringifyNumericTypes(true);
    const table = findTable('account');
    const query = compileSelectAggregate({
      table,
      aggregate: {
        count: {},
        sum: ['balance'],
        avg: ['balance'],
        min: ['balance'],
        max: ['balance'],
        stddev: ['balance'],
      },
      session: adminSession,
    });

    expect(query.sql).toContain(`(count(*))::text`);
    expect(query.sql).toContain(`(sum("t0"."balance"))::text`);
    expect(query.sql).toContain(`(avg("t0"."balance"))::text`);
    expect(query.sql).toContain(`(min("t0"."balance"))::text`);
    expect(query.sql).toContain(`(max("t0"."balance"))::text`);
    expect(query.sql).toContain(`(stddev("t0"."balance"))::text`);
  });

  it('does not cast non-stringified types (timestamptz min/max)', () => {
    configureStringifyNumericTypes(true);
    const table = findTable('account');
    const query = compileSelectAggregate({
      table,
      aggregate: { min: ['created_at'] },
      session: adminSession,
    });
    expect(query.sql).toContain(`'created_at', min("t0"."created_at")`);
  });

  it('does not cast when stringify is disabled', () => {
    configureStringifyNumericTypes(false);
    try {
      const table = findTable('account');
      const query = compileSelectAggregate({
        table,
        aggregate: { count: {}, sum: ['balance'] },
        session: adminSession,
      });
      expect(query.sql).toContain(`'count', count(*)`);
      expect(query.sql).not.toContain('::text');
    } finally {
      configureStringifyNumericTypes(true);
    }
  });

  it('casts aggregates in the GROUP BY path', () => {
    configureStringifyNumericTypes(true);
    const table = findTable('account');
    const query = compileSelectAggregate({
      table,
      aggregate: { count: {}, sum: ['balance'] },
      groupBy: ['currency_id'],
      session: adminSession,
    });
    expect(query.sql).toContain(`(count(*))::text AS "_count_"`);
    expect(query.sql).toContain(`(sum("t0"."balance"))::text AS "_sum_balance_"`);
  });

  it('executes and returns strings from PG', async () => {
    configureStringifyNumericTypes(true);
    const pool = getPool();
    const table = findTable('account');
    const query = compileSelectAggregate({
      table,
      aggregate: { count: {}, sum: ['balance'] },
      session: adminSession,
    });
    const result = await pool.query(query.sql, query.params);
    const agg = result.rows[0].aggregate as AnyRow;
    expect(typeof agg.count).toBe('string');
    expect(typeof (agg.sum as AnyRow).balance).toBe('string');
  });
});

// ─── E2E through GraphQL ─────────────────────────────────────────────────────

describe('E2E: stringified aggregates', () => {
  it('root aggregate returns count and sum as strings', async () => {
    const body = await gql(`query {
      accountAggregate {
        aggregate {
          count
          sum { balance }
          avg { balance }
        }
      }
    }`);
    expect(body.errors).toBeUndefined();
    const agg = (body.data!.accountAggregate as AnyRow).aggregate as AnyRow;
    expect(typeof agg.count).toBe('string');
    expect(typeof (agg.sum as AnyRow).balance).toBe('string');
    expect(typeof (agg.avg as AnyRow).balance).toBe('string');
  });

  it('nested relationship aggregate returns strings', async () => {
    const body = await gql(`query {
      clients(limit: 1) {
        accountsAggregate {
          aggregate {
            count
            sum { balance }
          }
        }
      }
    }`);
    expect(body.errors).toBeUndefined();
    const clients = body.data!.clients as AnyRow[];
    const agg = (clients[0].accountsAggregate as AnyRow).aggregate as AnyRow;
    expect(typeof agg.count).toBe('string');
    expect(typeof (agg.sum as AnyRow).balance).toBe('string');
  });

  it('native query bigint field returns a string', async () => {
    const pool = getPool();
    const { rows } = await pool.query(`SELECT branch_id FROM client WHERE branch_id IS NOT NULL LIMIT 1`);
    const branchId = rows[0].branch_id as string;

    const body = await gql(`query {
      branchClientCount(args: { branchId: "${branchId}" }) { count }
    }`);
    expect(body.errors).toBeUndefined();
    const result = body.data!.branchClientCount as AnyRow[];
    expect(result.length).toBeGreaterThan(0);
    expect(typeof result[0].count).toBe('string');
  });
});
