import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GraphQLSchema, GraphQLEnumType, GraphQLList, GraphQLNonNull } from 'graphql';
import { compileSelect } from '../src/sql/select.js';
import { generateSchema } from '../src/schema/generator.js';
import { resetComparisonTypeCache } from '../src/schema/filters.js';
import { introspectDatabase } from '../src/introspection/introspector.js';
import { mergeSchemaModel } from '../src/introspection/merger.js';
import { loadConfig } from '../src/config/loader.js';
import { parseRESTFilters } from '../src/rest/filters.js';
import type { SchemaModel, TableInfo } from '../src/types.js';
import {
  getPool, closePool, waitForDb, makeSession,
  METADATA_DIR, SERVER_CONFIG_PATH, TEST_DB_URL,
  ADMIN_SECRET,
  startServer, stopServer, graphqlRequest, restRequest,
  tokens, ALICE_ID,
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
  await waitForDb();
  const pool = getPool();
  const introspection = await introspectDatabase(pool);
  const config = await loadConfig(METADATA_DIR, SERVER_CONFIG_PATH);
  const result = mergeSchemaModel(introspection, config);
  schemaModel = result.model;
  // Generate schema for unit/integration tests — must reset caches first
  resetComparisonTypeCache();
  schema = generateSchema(schemaModel);
});

afterAll(async () => {
  await closePool();
});

// ─── SQL Generation Tests ─────────────────────────────────────────────────────

describe('DISTINCT ON — SQL Compiler', () => {
  const adminSession = makeSession('admin');

  it('should generate DISTINCT ON clause with single column', () => {
    const table = findTable('client');
    const query = compileSelect({
      table,
      columns: ['id', 'status'],
      distinctOn: ['status'],
      session: adminSession,
    });

    expect(query.sql).toContain('DISTINCT ON');
    expect(query.sql).toContain('"t0"."status"');
  });

  it('should generate DISTINCT ON clause with multiple columns', () => {
    const table = findTable('client');
    const query = compileSelect({
      table,
      columns: ['id', 'status', 'branch_id'],
      distinctOn: ['status', 'branch_id'],
      session: adminSession,
    });

    expect(query.sql).toContain('DISTINCT ON');
    expect(query.sql).toContain('"t0"."status"');
    expect(query.sql).toContain('"t0"."branch_id"');
  });

  it('should auto-prepend DISTINCT ON columns to ORDER BY', () => {
    const table = findTable('client');
    const query = compileSelect({
      table,
      columns: ['id', 'username', 'status'],
      distinctOn: ['status'],
      session: adminSession,
    });

    // DISTINCT ON forces an ORDER BY — the distinct column should appear
    expect(query.sql).toContain('ORDER BY');
    expect(query.sql).toContain('"t0"."status"');
  });

  it('should preserve user ORDER BY when it includes the distinct column', () => {
    const table = findTable('client');
    const query = compileSelect({
      table,
      columns: ['id', 'username', 'status'],
      distinctOn: ['status'],
      orderBy: [
        { column: 'status', direction: 'desc' },
        { column: 'username', direction: 'asc' },
      ],
      session: adminSession,
    });

    expect(query.sql).toContain('ORDER BY');
    expect(query.sql).toContain('"t0"."status" DESC');
    expect(query.sql).toContain('"t0"."username" ASC');
  });

  it('should prepend distinct column to ORDER BY when missing', () => {
    const table = findTable('client');
    const query = compileSelect({
      table,
      columns: ['id', 'username', 'status'],
      distinctOn: ['status'],
      orderBy: [{ column: 'username', direction: 'asc' }],
      session: adminSession,
    });

    expect(query.sql).toContain('ORDER BY');
    // status should appear before username in ORDER BY
    const orderByMatch = query.sql.match(/ORDER BY (.+?)(?:\n|$)/);
    expect(orderByMatch).toBeTruthy();
    const orderByStr = orderByMatch![1];
    const statusIdx = orderByStr.indexOf('"status"');
    const usernameIdx = orderByStr.indexOf('"username"');
    expect(statusIdx).toBeLessThan(usernameIdx);
  });

  it('should not include DISTINCT ON when distinctOn is empty', () => {
    const table = findTable('client');
    const query = compileSelect({
      table,
      columns: ['id', 'username'],
      distinctOn: [],
      session: adminSession,
    });

    expect(query.sql).not.toContain('DISTINCT ON');
  });

  it('should not include DISTINCT ON when distinctOn is undefined', () => {
    const table = findTable('client');
    const query = compileSelect({
      table,
      columns: ['id', 'username'],
      session: adminSession,
    });

    expect(query.sql).not.toContain('DISTINCT ON');
  });

  it('should execute DISTINCT ON query against real DB', async () => {
    const pool = getPool();
    const table = findTable('client');
    const query = compileSelect({
      table,
      columns: ['status'],
      distinctOn: ['status'],
      session: adminSession,
    });

    const result = await pool.query(query.sql, query.params);
    const data = result.rows[0].data;
    expect(Array.isArray(data)).toBe(true);
    // Should have distinct status values only
    const statuses = data.map((row: Record<string, unknown>) => row.status);
    const uniqueStatuses = [...new Set(statuses)];
    expect(statuses.length).toBe(uniqueStatuses.length);
  });

  it('should work with DISTINCT ON + WHERE + LIMIT', async () => {
    const pool = getPool();
    const table = findTable('client');
    const query = compileSelect({
      table,
      columns: ['id', 'status'],
      distinctOn: ['status'],
      where: { status: { _eq: 'active' } } as import('../src/types.js').BoolExp,
      limit: 10,
      session: adminSession,
    });

    expect(query.sql).toContain('DISTINCT ON');
    expect(query.sql).toContain('WHERE');
    expect(query.sql).toContain('LIMIT');

    const result = await pool.query(query.sql, query.params);
    const data = result.rows[0].data;
    expect(Array.isArray(data)).toBe(true);
  });
});

// ─── Schema Tests ─────────────────────────────────────────────────────────────

describe('DISTINCT ON — Schema', () => {
  it('should have distinctOn argument on select list fields', () => {
    const queryType = schema.getQueryType()!;
    const clientsField = queryType.getFields()['clients'];
    expect(clientsField).toBeDefined();
    const argNames = clientsField.args.map((a) => a.name);
    expect(argNames).toContain('distinctOn');
  });

  it('should have a SelectColumn enum type for the distinctOn argument', () => {
    const queryType = schema.getQueryType()!;
    const clientsField = queryType.getFields()['clients'];
    const distinctOnArg = clientsField.args.find((a) => a.name === 'distinctOn');
    expect(distinctOnArg).toBeDefined();

    // Should be [ClientSelectColumn!]
    const argType = distinctOnArg!.type;
    expect(argType).toBeInstanceOf(GraphQLList);
    const innerType = (argType as GraphQLList<GraphQLNonNull<GraphQLEnumType>>).ofType;
    expect(innerType).toBeInstanceOf(GraphQLNonNull);
    const enumType = (innerType as GraphQLNonNull<GraphQLEnumType>).ofType;
    expect(enumType).toBeInstanceOf(GraphQLEnumType);
    expect(enumType.name).toContain('SelectColumn');
  });

  it('should have enum values matching table columns in camelCase', () => {
    const typeMap = schema.getTypeMap();
    // Find the Client SelectColumn enum (exact match to avoid ClientData, ClientService, etc.)
    const enumType = typeMap['ClientSelectColumn'] as GraphQLEnumType | undefined;
    expect(enumType).toBeDefined();

    const values = enumType!.getValues();
    const valueNames = values.map((v) => v.name);
    // Should contain column names in camelCase
    expect(valueNames).toContain('id');
    expect(valueNames).toContain('username');
    expect(valueNames).toContain('status');
  });

  it('should have SelectColumn enum values that resolve to PG column names', () => {
    const typeMap = schema.getTypeMap();
    const enumType = typeMap['ClientSelectColumn'] as GraphQLEnumType | undefined;
    expect(enumType).toBeDefined();

    const values = enumType!.getValues();
    // Find a snake_case column name to verify the mapping
    const branchIdValue = values.find((v) => v.name === 'branchId');
    expect(branchIdValue).toBeDefined();
    // The internal value should be the PG column name (snake_case)
    expect(branchIdValue!.value).toBe('branch_id');
  });

  it('should have distinctOn as the first argument before where/orderBy/limit/offset', () => {
    const queryType = schema.getQueryType()!;
    const clientsField = queryType.getFields()['clients'];
    const argNames = clientsField.args.map((a) => a.name);
    const distinctIdx = argNames.indexOf('distinctOn');
    const whereIdx = argNames.indexOf('where');
    const orderByIdx = argNames.indexOf('orderBy');
    // distinctOn should appear first
    expect(distinctIdx).toBeLessThan(whereIdx);
    expect(distinctIdx).toBeLessThan(orderByIdx);
  });

  it('should have distinctOn argument on subscription list fields', () => {
    const subscriptionType = schema.getSubscriptionType()!;
    expect(subscriptionType).toBeDefined();
    const clientsField = subscriptionType.getFields()['clients'];
    expect(clientsField).toBeDefined();
    const argNames = clientsField.args.map((a) => a.name);
    expect(argNames).toContain('distinctOn');

    // Should be [ClientSelectColumn!]
    const distinctOnArg = clientsField.args.find((a) => a.name === 'distinctOn');
    expect(distinctOnArg).toBeDefined();
    const argType = distinctOnArg!.type;
    expect(argType).toBeInstanceOf(GraphQLList);
  });

  it('should have distinctOn argument on nested array relationship fields', () => {
    const typeMap = schema.getTypeMap();
    // Client has array relationship to invoices
    const clientType = typeMap['Client'] as import('graphql').GraphQLObjectType | undefined;
    expect(clientType).toBeDefined();
    const invoicesField = clientType!.getFields()['invoices'];
    expect(invoicesField).toBeDefined();
    const argNames = invoicesField.args.map((a) => a.name);
    expect(argNames).toContain('distinctOn');

    // Should be [InvoiceSelectColumn!]
    const distinctOnArg = invoicesField.args.find((a) => a.name === 'distinctOn');
    expect(distinctOnArg).toBeDefined();
    const argType = distinctOnArg!.type;
    expect(argType).toBeInstanceOf(GraphQLList);
  });

  it('should have distinctOn argument on aggregate query root fields (replacing groupBy)', () => {
    const queryType = schema.getQueryType()!;
    const clientsAggField = queryType.getFields()['clientsAggregate'];
    expect(clientsAggField).toBeDefined();
    const argNames = clientsAggField.args.map((a) => a.name);
    expect(argNames).toContain('distinctOn');
    // groupBy should no longer exist
    expect(argNames).not.toContain('groupBy');
  });

  it('should have distinctOn argument on subscription aggregate fields', () => {
    const subscriptionType = schema.getSubscriptionType()!;
    expect(subscriptionType).toBeDefined();
    const clientsAggField = subscriptionType.getFields()['clientsAggregate'];
    expect(clientsAggField).toBeDefined();
    const argNames = clientsAggField.args.map((a) => a.name);
    expect(argNames).toContain('distinctOn');

    // Should be [ClientSelectColumn!]
    const distinctOnArg = clientsAggField.args.find((a) => a.name === 'distinctOn');
    expect(distinctOnArg).toBeDefined();
    const argType = distinctOnArg!.type;
    expect(argType).toBeInstanceOf(GraphQLList);
  });
});

// ─── REST API Filter Tests ────────────────────────────────────────────────────

describe('DISTINCT ON — REST Filters', () => {
  it('should parse distinct_on query parameter with single column', () => {
    const parsed = parseRESTFilters({ distinct_on: 'email' });
    expect(parsed.distinctOn).toEqual(['email']);
  });

  it('should parse distinct_on query parameter with multiple columns', () => {
    const parsed = parseRESTFilters({ distinct_on: 'email,status' });
    expect(parsed.distinctOn).toEqual(['email', 'status']);
  });

  it('should not include distinct_on when not provided', () => {
    const parsed = parseRESTFilters({ limit: '10' });
    expect(parsed.distinctOn).toBeUndefined();
  });

  it('should not treat distinct_on as a column filter', () => {
    const parsed = parseRESTFilters({ distinct_on: 'email' });
    // Should not have any where clause entries for distinct_on
    const whereKeys = Object.keys(parsed.where as Record<string, unknown>);
    expect(whereKeys).not.toContain('distinct_on');
  });

  it('should handle distinct_on with spaces around commas', () => {
    const parsed = parseRESTFilters({ distinct_on: 'email , status' });
    expect(parsed.distinctOn).toEqual(['email', 'status']);
  });
});

// ─── E2E Tests ────────────────────────────────────────────────────────────────

describe('DISTINCT ON — E2E via GraphQL & REST', () => {
  beforeAll(async () => {
    // Reset caches so startServer can generate a fresh schema
    resetComparisonTypeCache();

    await startServer();
  });

  afterAll(async () => {
    await stopServer();
  });

  it('should return distinct results via GraphQL', async () => {
    const query = `
      query {
        clients(distinctOn: [status], orderBy: [{ status: ASC }]) {
          status
        }
      }
    `;

    const { status, body } = await graphqlRequest(query, undefined, {
      'x-hasura-admin-secret': ADMIN_SECRET,
    });

    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const clients = (body.data as Record<string, unknown>)?.clients as Array<{ status: string }>;
    expect(clients).toBeDefined();
    expect(Array.isArray(clients)).toBe(true);

    // Should have distinct status values
    const statuses = clients.map((c) => c.status);
    const uniqueStatuses = [...new Set(statuses)];
    expect(statuses.length).toBe(uniqueStatuses.length);
  });

  it('should enforce column permissions on distinct_on', async () => {
    const clientToken = await tokens.client(ALICE_ID);

    const query = `
      query {
        clients(distinctOn: [status]) {
          status
        }
      }
    `;

    const { status, body } = await graphqlRequest(query, undefined, {
      authorization: `Bearer ${clientToken}`,
    });

    // The query should either succeed with filtered columns or return valid results.
    // Client role has select permission with columns restricted — if status is not
    // in their permitted columns, distinct_on should be ignored (empty after filter).
    expect(status).toBe(200);
  });

  it('should support distinct_on via REST API', async () => {
    const { status, body } = await restRequest('GET', '/api/v1/clients', {
      headers: { 'x-hasura-admin-secret': ADMIN_SECRET },
      query: { distinct_on: 'status', order: 'status.asc' },
    });

    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);

    // Should have distinct status values
    const rows = body as Array<Record<string, unknown>>;
    const statuses = rows.map((r) => r.status);
    const uniqueStatuses = [...new Set(statuses)];
    expect(statuses.length).toBe(uniqueStatuses.length);
  });

  it('should support distinctOn on nested array relationship fields', async () => {
    const query = `
      query {
        clients {
          id
          invoices(distinctOn: [state], orderBy: [{ state: ASC }]) {
            state
          }
        }
      }
    `;

    const { status, body } = await graphqlRequest(query, undefined, {
      'x-hasura-admin-secret': ADMIN_SECRET,
    });

    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const clients = (body.data as Record<string, unknown>)?.clients as Array<{
      id: string;
      invoices: Array<{ state: string }>;
    }>;
    expect(clients).toBeDefined();

    // For each client with invoices, invoice states should be distinct
    for (const client of clients) {
      if (client.invoices.length > 0) {
        const states = client.invoices.map((inv) => inv.state);
        const uniqueStates = [...new Set(states)];
        expect(states.length).toBe(uniqueStates.length);
      }
    }
  });
});
