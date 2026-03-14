import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GraphQLObjectType } from 'graphql';
import { generateSchema } from '../src/schema/generator.js';
import { resetCustomOutputTypeCache } from '../src/schema/custom-queries.js';
import { introspectDatabase } from '../src/introspection/introspector.js';
import { mergeSchemaModel } from '../src/introspection/merger.js';
import { loadConfig } from '../src/config/loader.js';
import { compileSelect, compileSelectByPk } from '../src/sql/select.js';
import { configureStringifyNumericTypes } from '../src/introspection/type-map.js';
import type { ComputedFieldSelection } from '../src/sql/select.js';
import type { SchemaModel, TableInfo, BoolExp, FunctionInfo } from '../src/types.js';
import {
  getPool, closePool, waitForDb, makeSession,
  startServer, stopServer, graphqlRequest, tokens,
  METADATA_DIR, SERVER_CONFIG_PATH, TEST_DB_URL,
  ALICE_ID, ACCOUNT_ALICE_ID, ADMIN_SECRET,
} from './setup.js';

type AnyRow = Record<string, unknown>;

let schemaModel: SchemaModel;

function findTable(name: string): TableInfo {
  const table = schemaModel.tables.find((t) => t.name === name);
  if (!table) throw new Error(`Table ${name} not found in schema model`);
  return table;
}

function findFunction(name: string, fnSchema = 'public'): FunctionInfo {
  const fn = schemaModel.functions.find((f) => f.name === name && f.schema === fnSchema);
  if (!fn) throw new Error(`Function ${name} not found in schema model`);
  return fn;
}

function buildCFSelection(table: TableInfo, cfName: string): ComputedFieldSelection {
  const cf = table.computedFields?.find((c) => c.name === cfName);
  if (!cf) throw new Error(`Computed field ${cfName} not found on table ${table.name}`);
  const fn = findFunction(cf.function.name, cf.function.schema ?? 'public');
  return { config: cf, functionInfo: fn };
}

beforeAll(async () => {
  process.env['DATABASE_URL'] = TEST_DB_URL;
  process.env['HAKKYRA_ADMIN_SECRET'] = ADMIN_SECRET;
  resetCustomOutputTypeCache();
  await waitForDb();
  // Start the server first (it calls generateSchema internally).
  // This also creates the schemaModel for us.
  await startServer();
  // Build our own schemaModel for SQL compiler tests
  const pool = getPool();
  const introspection = await introspectDatabase(pool);
  const config = await loadConfig(METADATA_DIR, SERVER_CONFIG_PATH);
  const result = mergeSchemaModel(introspection, config);
  schemaModel = result.model;
}, 30_000);

afterAll(async () => {
  await stopServer();
  await closePool();
});

// ─── Config Model Tests ───────────────────────────────────────────────────

describe('Computed Fields — Config Model', () => {
  it('should include computed fields in the config model for client table', () => {
    const clientTable = findTable('client');
    expect(clientTable.computedFields).toBeDefined();
    expect(clientTable.computedFields!.length).toBeGreaterThan(0);
    const totalBalance = clientTable.computedFields!.find((cf) => cf.name === 'total_balance');
    expect(totalBalance).toBeDefined();
    expect(totalBalance!.function.name).toBe('client_total_balance');
    expect(totalBalance!.function.schema).toBe('public');
  });

  it('should include computed fields in the config model for account table', () => {
    const accountTable = findTable('account');
    expect(accountTable.computedFields).toBeDefined();
    const total = accountTable.computedFields!.find((cf) => cf.name === 'total');
    expect(total).toBeDefined();
    expect(total!.function.name).toBe('account_total');
  });

  it('should include computed fields in the config model for client_service table', () => {
    const csTable = findTable('client_service');
    expect(csTable.computedFields).toBeDefined();
    const outcome = csTable.computedFields!.find((cf) => cf.name === 'outcome');
    expect(outcome).toBeDefined();
    expect(outcome!.function.name).toBe('client_service_outcome');
  });

  it('should carry computed_fields in select permissions', () => {
    const clientTable = findTable('client');
    const clientPerm = clientTable.permissions.select['client'];
    expect(clientPerm).toBeDefined();
    expect(clientPerm.computedFields).toBeDefined();
    expect(clientPerm.computedFields).toContain('total_balance');
  });
});

// ─── SQL Compiler Tests ──────────────────────────────────────────────────────

describe('Computed Fields — SQL Compiler', () => {
  const adminSession = makeSession('admin');

  it('should generate SQL with computed field function call in json_build_object', () => {
    const table = findTable('client');
    const cfSel = buildCFSelection(table, 'total_balance');

    const query = compileSelect({
      table,
      columns: ['id', 'username'],
      computedFields: [cfSel],
      session: adminSession,
    });

    expect(query.sql).toContain('"public"."client_total_balance"');
    expect(query.sql).toContain("'total_balance'");
  });

  it('should generate SQL with computed field in SELECT by PK', () => {
    const table = findTable('client');
    const cfSel = buildCFSelection(table, 'total_balance');

    const query = compileSelectByPk({
      table,
      pkValues: { id: ALICE_ID },
      columns: ['id', 'username'],
      computedFields: [cfSel],
      session: adminSession,
    });

    expect(query.sql).toContain('"public"."client_total_balance"');
    expect(query.sql).toContain("'total_balance'");
  });

  it('should execute SELECT with computed field and return data', async () => {
    const pool = getPool();
    const table = findTable('client');
    const cfSel = buildCFSelection(table, 'total_balance');

    const query = compileSelect({
      table,
      columns: ['id', 'username'],
      where: { id: { _eq: ALICE_ID } } as BoolExp,
      computedFields: [cfSel],
      session: adminSession,
    });

    const result = await pool.query(query.sql, query.params);
    const data = result.rows[0].data;
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(1);
    expect(data[0].id).toBe(ALICE_ID);
    // Alice has account with balance=1500 + credit_balance=200 => total_balance = 1700
    expect(Number(data[0].total_balance)).toBe(1700);
  });

  it('should execute SELECT by PK with computed field', async () => {
    const pool = getPool();
    const table = findTable('client');
    const cfSel = buildCFSelection(table, 'total_balance');

    const query = compileSelectByPk({
      table,
      pkValues: { id: ALICE_ID },
      columns: ['id', 'username'],
      computedFields: [cfSel],
      session: adminSession,
    });

    const result = await pool.query(query.sql, query.params);
    expect(result.rows.length).toBe(1);
    const data = result.rows[0].data;
    expect(data.id).toBe(ALICE_ID);
    expect(Number(data.total_balance)).toBe(1700);
  });

  it('should execute account_total computed field', async () => {
    const pool = getPool();
    const table = findTable('account');
    const cfSel = buildCFSelection(table, 'total');

    const query = compileSelect({
      table,
      columns: ['id', 'balance', 'credit_balance'],
      where: { client_id: { _eq: ALICE_ID } } as BoolExp,
      computedFields: [cfSel],
      session: adminSession,
    });

    const result = await pool.query(query.sql, query.params);
    const data = result.rows[0].data;
    expect(data.length).toBe(1);
    // Alice's account: balance=1500, credit_balance=200 => total=1700
    expect(Number(data[0].total)).toBe(1700);
  });

  it('should execute client_service_outcome computed field', async () => {
    const pool = getPool();
    const table = findTable('client_service');
    const cfSel = buildCFSelection(table, 'outcome');

    const query = compileSelect({
      table,
      columns: ['id', 'status'],
      where: { client_id: { _eq: ALICE_ID } } as BoolExp,
      computedFields: [cfSel],
      session: adminSession,
    });

    const result = await pool.query(query.sql, query.params);
    const data = result.rows[0].data;
    expect(data.length).toBeGreaterThan(0);
    expect(typeof data[0].outcome).toBe('string');
  });
});

// ─── E2E Tests ──────────────────────────────────────────────────────────────

describe('Computed Fields — E2E via GraphQL', () => {
  it('admin can query client with totalBalance computed field', async () => {
    const { status, body } = await graphqlRequest(
      `query($id: Uuid!) {
        clientByPk(id: $id) {
          id
          username
          totalBalance
        }
      }`,
      { id: ALICE_ID },
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const client = (body.data as { clientByPk: AnyRow }).clientByPk;
    expect(client).toBeDefined();
    expect(client.id).toBe(ALICE_ID);
    // Alice: balance=1500 + credit_balance=200 => 1700
    expect(Number(client.totalBalance)).toBe(1700);
  });

  it('backoffice role can query computed field (allowed in permissions)', async () => {
    const token = await tokens.backoffice();
    const { status, body } = await graphqlRequest(
      `query($id: Uuid!) {
        clientByPk(id: $id) {
          id
          username
          totalBalance
        }
      }`,
      { id: ALICE_ID },
      { authorization: `Bearer ${token}` },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const client = (body.data as { clientByPk: AnyRow }).clientByPk;
    expect(client).toBeDefined();
    expect(Number(client.totalBalance)).toBe(1700);
  });

  it('client role can query own totalBalance computed field', async () => {
    const token = await tokens.client(ALICE_ID);
    const { status, body } = await graphqlRequest(
      `query {
        clients {
          id
          username
          totalBalance
        }
      }`,
      undefined,
      { authorization: `Bearer ${token}` },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const clients = (body.data as { clients: AnyRow[] }).clients;
    expect(clients.length).toBe(1);
    expect(clients[0].id).toBe(ALICE_ID);
    expect(Number(clients[0].totalBalance)).toBe(1700);
  });

  it('admin can query account with total computed field', async () => {
    const { status, body } = await graphqlRequest(
      `query($id: Uuid!) {
        account(where: { id: { _eq: $id } }) {
          id
          balance
          creditBalance
          total
        }
      }`,
      { id: ACCOUNT_ALICE_ID },
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const accounts = (body.data as { account: AnyRow[] }).account;
    expect(accounts.length).toBe(1);
    expect(Number(accounts[0].total)).toBe(1700);
  });

  it('admin can query client_service with outcome computed field', async () => {
    const { status, body } = await graphqlRequest(
      `query {
        clientServices(where: { clientId: { _eq: "${ALICE_ID}" } }) {
          id
          status
          outcome
        }
      }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const services = (body.data as { clientServices: AnyRow[] }).clientServices;
    expect(services.length).toBeGreaterThan(0);
    expect(typeof services[0].outcome).toBe('string');
  });

  it('computed fields work alongside regular columns and relationships', async () => {
    const token = await tokens.backoffice();
    const { status, body } = await graphqlRequest(
      `query($id: Uuid!) {
        clientByPk(id: $id) {
          id
          username
          status
          totalBalance
          branch { id name }
          accounts { id balance }
        }
      }`,
      { id: ALICE_ID },
      { authorization: `Bearer ${token}` },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const client = (body.data as { clientByPk: AnyRow }).clientByPk;
    expect(client).toBeDefined();
    expect(client.username).toBe('alice');
    expect(Number(client.totalBalance)).toBe(1700);
    expect(client.branch).toBeDefined();
    expect(Array.isArray(client.accounts)).toBe(true);
  });

  it('computed fields preserve numeric precision with stringify_numeric_types', async () => {
    const pool = getPool();
    const table = findTable('account');
    const cfSel = buildCFSelection(table, 'total');

    configureStringifyNumericTypes(true);
    try {
      const query = compileSelect({
        table,
        columns: ['id'],
        where: { client_id: { _eq: ALICE_ID } } as BoolExp,
        computedFields: [cfSel],
        session: makeSession('admin'),
      });

      // The SQL should cast the computed field result to text
      expect(query.sql).toContain('::text');

      const result = await pool.query(query.sql, query.params);
      const data = result.rows[0].data;
      // The computed field should be a string preserving decimal places
      expect(typeof data[0].total).toBe('string');
      expect(data[0].total).toMatch(/\./);
    } finally {
      configureStringifyNumericTypes(false);
    }
  });

  it('queries without computed fields still work normally', async () => {
    const { status, body } = await graphqlRequest(
      `query($id: Uuid!) {
        clientByPk(id: $id) {
          id
          username
          email
        }
      }`,
      { id: ALICE_ID },
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const client = (body.data as { clientByPk: AnyRow }).clientByPk;
    expect(client.id).toBe(ALICE_ID);
    expect(client.username).toBe('alice');
  });
});
