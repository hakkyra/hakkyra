import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resetCustomOutputTypeCache } from '../src/schema/custom-queries.js';
import { introspectDatabase } from '../src/introspection/introspector.js';
import { mergeSchemaModel } from '../src/introspection/merger.js';
import { loadConfig } from '../src/config/loader.js';
import { configureStringifyNumericTypes } from '../src/introspection/type-map.js';
import type { SchemaModel, TableInfo, FunctionInfo, TrackedFunctionConfig } from '../src/types.js';
import { resolveTrackedFunctions } from '../src/schema/tracked-functions.js';
import {
  getPool, closePool, waitForDb, makeSession,
  startServer, stopServer, graphqlRequest, tokens,
  METADATA_DIR, SERVER_CONFIG_PATH, TEST_DB_URL,
  ALICE_ID, BOB_ID, CHARLIE_ID, DIANA_ID, ADMIN_SECRET,
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

beforeAll(async () => {
  process.env['DATABASE_URL'] = TEST_DB_URL;
  process.env['HAKKYRA_ADMIN_SECRET'] = ADMIN_SECRET;
  resetCustomOutputTypeCache();
  configureStringifyNumericTypes(false);
  await waitForDb();

  // Create the test database functions BEFORE starting the server
  // (the server introspects on startup, so functions must exist first)
  const pool = getPool();

  // Verify the client table exists first
  const tableCheck = await pool.query("SELECT 1 FROM pg_class WHERE relname = 'client'");
  if (tableCheck.rows.length === 0) {
    throw new Error('client table does not exist — is the database initialized?');
  }

  // Create functions in the PUBLIC schema explicitly (the test pool user might have
  // a different default schema)
  await pool.query(
    "CREATE OR REPLACE FUNCTION public.search_clients(search_term text) " +
    "RETURNS SETOF client AS $fn$ " +
    "SELECT * FROM client WHERE username ILIKE '%' || search_term || '%' OR email ILIKE '%' || search_term || '%' " +
    "$fn$ LANGUAGE SQL STABLE;"
  );
  await pool.query(
    "CREATE OR REPLACE FUNCTION public.deactivate_client(client_uuid uuid) " +
    "RETURNS client AS $fn$ " +
    "UPDATE client SET status = 'inactive' WHERE id = client_uuid RETURNING * " +
    "$fn$ LANGUAGE SQL VOLATILE;"
  );

  // Stop any existing cached server (from other test files) so we get a fresh
  // server that introspects including our newly-created functions.
  await stopServer();

  // Start the server (will introspect the DB including our new functions)
  await startServer();

  // Build our own schemaModel for direct tests
  const introspection = await introspectDatabase(pool);
  const config = await loadConfig(METADATA_DIR, SERVER_CONFIG_PATH);
  const result = mergeSchemaModel(introspection, config);
  schemaModel = result.model;
}, 30_000);

afterAll(async () => {
  // Restore charlie's status that may be changed by mutation tests
  try {
    const pool = getPool();
    await pool.query(`UPDATE client SET status = 'on_hold' WHERE id = $1`, [CHARLIE_ID]);
  } catch { /* ignore */ }
  await stopServer();
  await closePool();
});

// ─── Config Loading Tests ───────────────────────────────────────────────

describe('Tracked Functions — Config Loading', () => {
  it('should load tracked functions from functions.yaml', () => {
    expect(schemaModel.trackedFunctions).toBeDefined();
    expect(schemaModel.trackedFunctions.length).toBeGreaterThanOrEqual(2);
  });

  it('should parse search_clients as a query function', () => {
    const fn = schemaModel.trackedFunctions.find((f) => f.name === 'search_clients');
    expect(fn).toBeDefined();
    expect(fn!.schema).toBe('public');
    expect(fn!.exposedAs).toBeUndefined(); // resolved later based on volatility
    expect(fn!.permissions).toBeDefined();
    expect(fn!.permissions!.some((p) => p.role === 'backoffice')).toBe(true);
    expect(fn!.permissions!.some((p) => p.role === 'administrator')).toBe(true);
  });

  it('should parse deactivate_client as a mutation function', () => {
    const fn = schemaModel.trackedFunctions.find((f) => f.name === 'deactivate_client');
    expect(fn).toBeDefined();
    expect(fn!.schema).toBe('public');
    expect(fn!.exposedAs).toBe('mutation'); // explicitly set in metadata
    expect(fn!.permissions).toBeDefined();
    expect(fn!.permissions!.some((p) => p.role === 'administrator')).toBe(true);
  });
});


// ─── Schema Generation Tests ────────────────────────────────────────────

describe('Tracked Functions — Schema Generation', () => {
  it('should register searchClients in the schema model trackedFunctions', () => {
    expect(schemaModel.trackedFunctions.length).toBeGreaterThanOrEqual(2);
    const searchFn = schemaModel.trackedFunctions.find((f) => f.name === 'search_clients');
    expect(searchFn).toBeDefined();
    expect(searchFn!.exposedAs).toBeUndefined(); // resolved later based on volatility
  });

  it('should register deactivateClient as a mutation in the schema model', () => {
    const deactivateFn = schemaModel.trackedFunctions.find((f) => f.name === 'deactivate_client');
    expect(deactivateFn).toBeDefined();
    expect(deactivateFn!.exposedAs).toBe('mutation');
  });

  it('should have introspected functions include search_clients', () => {
    const fn = schemaModel.functions.find((f) => f.name === 'search_clients');
    expect(fn).toBeDefined();
    expect(fn!.isSetReturning).toBe(true);
    expect(fn!.volatility).toBe('stable');
    expect(fn!.returnType).toBe('client');
  });

  it('should have introspected functions include deactivate_client', () => {
    const fn = schemaModel.functions.find((f) => f.name === 'deactivate_client');
    expect(fn).toBeDefined();
    expect(fn!.isSetReturning).toBe(false);
    expect(fn!.volatility).toBe('volatile');
    expect(fn!.returnType).toBe('client');
  });

  it('should resolve tracked functions with return tables', () => {
    const resolved = resolveTrackedFunctions(
      schemaModel.trackedFunctions,
      schemaModel.functions,
      schemaModel.tables,
    );
    expect(resolved.length).toBeGreaterThanOrEqual(2);

    const search = resolved.find((r) => r.config.name === 'search_clients');
    expect(search!.returnTable!.name).toBe('client');
    expect(search!.userArgs.length).toBe(1);
    expect(search!.userArgs[0].name).toBe('search_term');

    const deactivate = resolved.find((r) => r.config.name === 'deactivate_client');
    expect(deactivate!.returnTable!.name).toBe('client');
    expect(deactivate!.userArgs.length).toBe(1);
    expect(deactivate!.userArgs[0].name).toBe('client_uuid');
  });
});

// ─── E2E Resolver Tests ─────────────────────────────────────────────────

describe('Tracked Functions — E2E Query Resolution', () => {
  it('should execute a SETOF function with admin secret', async () => {
    const { body } = await graphqlRequest(
      `query {
        searchClients(args: { searchTerm: "alice" }) {
          id
          username
          email
        }
      }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );

    expect(body.errors).toBeUndefined();
    expect(body.data).toBeDefined();
    const data = body.data as { searchClients: AnyRow[] };
    expect(Array.isArray(data.searchClients)).toBe(true);
    expect(data.searchClients.length).toBeGreaterThan(0);
    // Should find alice
    const alice = data.searchClients.find((c) => c.username === 'alice');
    expect(alice).toBeDefined();
    expect(alice!.email).toBe('alice@test.com');
  });

  it('should apply where filter on SETOF function results', async () => {
    const { body } = await graphqlRequest(
      `query {
        searchClients(
          args: { searchTerm: "" }
          where: { status: { _eq: ACTIVE } }
        ) {
          id
          username
          status
        }
      }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );

    expect(body.errors).toBeUndefined();
    const data = body.data as { searchClients: AnyRow[] };
    expect(Array.isArray(data.searchClients)).toBe(true);
    // All returned clients should have active status (enum returns uppercase)
    for (const client of data.searchClients) {
      expect(client.status).toBe('ACTIVE');
    }
  });

  it('should apply limit on SETOF function results', async () => {
    const { body } = await graphqlRequest(
      `query {
        searchClients(
          args: { searchTerm: "" }
          limit: 2
        ) {
          id
          username
        }
      }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );

    expect(body.errors).toBeUndefined();
    const data = body.data as { searchClients: AnyRow[] };
    expect(data.searchClients.length).toBeLessThanOrEqual(2);
  });

  it('should apply orderBy on SETOF function results', async () => {
    const { body } = await graphqlRequest(
      `query {
        searchClients(
          args: { searchTerm: "" }
          orderBy: [{ username: ASC }]
        ) {
          username
        }
      }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );

    expect(body.errors).toBeUndefined();
    const data = body.data as { searchClients: AnyRow[] };
    expect(data.searchClients.length).toBeGreaterThan(1);
    // Verify ordering
    for (let i = 1; i < data.searchClients.length; i++) {
      expect(
        (data.searchClients[i].username as string) >= (data.searchClients[i - 1].username as string)
      ).toBe(true);
    }
  });

  it('should include relationships on SETOF function results', async () => {
    const { body } = await graphqlRequest(
      `query {
        searchClients(args: { searchTerm: "alice" }) {
          id
          username
          branch {
            name
          }
          accounts {
            balance
          }
        }
      }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );

    expect(body.errors).toBeUndefined();
    const data = body.data as { searchClients: AnyRow[] };
    expect(data.searchClients.length).toBeGreaterThan(0);
    const alice = data.searchClients.find((c) => c.username === 'alice');
    expect(alice).toBeDefined();
    expect(alice!.branch).toBeDefined();
    expect((alice!.branch as AnyRow).name).toBe('TestBranch');
    expect(Array.isArray(alice!.accounts)).toBe(true);
  });
});

describe('Tracked Functions — E2E Mutation Resolution', () => {
  it('should execute a mutation function with admin secret', async () => {
    // First, ensure charlie has a non-inactive status
    const pool = getPool();
    await pool.query(`UPDATE client SET status = 'active' WHERE id = $1`, [CHARLIE_ID]);

    const { body } = await graphqlRequest(
      `mutation {
        deactivateClient(args: { clientUuid: "${CHARLIE_ID}" }) {
          id
          username
          status
        }
      }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );

    expect(body.errors).toBeUndefined();
    expect(body.data).toBeDefined();
    const data = body.data as { deactivateClient: AnyRow };
    expect(data.deactivateClient).toBeDefined();
    expect(data.deactivateClient.username).toBe('charlie');
    expect(data.deactivateClient.status).toBe('INACTIVE');

    // Restore charlie
    await pool.query(`UPDATE client SET status = 'on_hold' WHERE id = $1`, [CHARLIE_ID]);
  });
});

describe('Tracked Functions — Permissions', () => {
  it('should allow backoffice role to access search_clients', async () => {
    const token = await tokens.backoffice();
    const { body } = await graphqlRequest(
      `query {
        searchClients(args: { searchTerm: "" }) {
          id
          username
        }
      }`,
      undefined,
      { authorization: `Bearer ${token}` },
    );

    expect(body.errors).toBeUndefined();
    const data = body.data as { searchClients: AnyRow[] };
    expect(Array.isArray(data.searchClients)).toBe(true);
  });

  it('should deny client role access to search_clients', async () => {
    const token = await tokens.client();
    const { body } = await graphqlRequest(
      `query {
        searchClients(args: { searchTerm: "alice" }) {
          id
          username
        }
      }`,
      undefined,
      { authorization: `Bearer ${token}` },
    );

    expect(body.errors).toBeDefined();
    expect(body.errors![0].message).toContain('Permission denied');
  });

  it('should deny backoffice role access to deactivate_client mutation', async () => {
    const token = await tokens.backoffice();
    const { body } = await graphqlRequest(
      `mutation {
        deactivateClient(args: { clientUuid: "${ALICE_ID}" }) {
          id
        }
      }`,
      undefined,
      { authorization: `Bearer ${token}` },
    );

    expect(body.errors).toBeDefined();
    expect(body.errors![0].message).toContain('Permission denied');
  });

  it('should allow administrator role to access deactivate_client mutation', async () => {
    // Ensure charlie is active first
    const pool = getPool();
    await pool.query(`UPDATE client SET status = 'active' WHERE id = $1`, [CHARLIE_ID]);

    const token = await tokens.administrator();
    const { body } = await graphqlRequest(
      `mutation {
        deactivateClient(args: { clientUuid: "${CHARLIE_ID}" }) {
          id
          username
          status
        }
      }`,
      undefined,
      { authorization: `Bearer ${token}` },
    );

    expect(body.errors).toBeUndefined();
    const data = body.data as { deactivateClient: AnyRow };
    expect(data.deactivateClient.status).toBe('INACTIVE');

    // Restore charlie
    await pool.query(`UPDATE client SET status = 'on_hold' WHERE id = $1`, [CHARLIE_ID]);
  });

  it('should apply return table select permissions for backoffice role', async () => {
    const token = await tokens.backoffice();
    const { body } = await graphqlRequest(
      `query {
        searchClients(args: { searchTerm: "alice" }) {
          id
          username
          email
          status
        }
      }`,
      undefined,
      { authorization: `Bearer ${token}` },
    );

    expect(body.errors).toBeUndefined();
    const data = body.data as { searchClients: AnyRow[] };
    expect(data.searchClients.length).toBeGreaterThan(0);
    // backoffice has `columns: "*"` on client, so all columns should be accessible
    const alice = data.searchClients.find((c) => c.username === 'alice');
    expect(alice).toBeDefined();
  });
});

describe('Tracked Functions — camelCase remapping', () => {
  it('should remap snake_case columns to camelCase in SETOF results', async () => {
    // Query multi-word columns (snake_case in PG → camelCase in GraphQL)
    const { body } = await graphqlRequest(
      `query {
        searchClients(args: { searchTerm: "alice" }) {
          id
          username
          branchId
          currencyId
          trustLevel
          createdAt
        }
      }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );

    expect(body.errors).toBeUndefined();
    const data = body.data as { searchClients: AnyRow[] };
    expect(data.searchClients.length).toBeGreaterThan(0);
    const alice = data.searchClients.find((c) => c.username === 'alice');
    expect(alice).toBeDefined();
    // Multi-word columns should be accessible via camelCase
    expect(alice!.branchId).toBeDefined();
    expect(alice!.currencyId).toBeDefined();
    expect(alice!.createdAt).toBeDefined();
    // trustLevel has a default of 0 so it should be a number
    expect(typeof alice!.trustLevel).toBe('number');
  });

  it('should remap snake_case columns to camelCase for non-SETOF results', async () => {
    // Ensure charlie is active first
    const pool = getPool();
    await pool.query(`UPDATE client SET status = 'active' WHERE id = $1`, [CHARLIE_ID]);

    const { body } = await graphqlRequest(
      `mutation {
        deactivateClient(args: { clientUuid: "${CHARLIE_ID}" }) {
          id
          username
          branchId
          currencyId
          trustLevel
        }
      }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );

    expect(body.errors).toBeUndefined();
    const data = body.data as { deactivateClient: AnyRow };
    expect(data.deactivateClient).toBeDefined();
    expect(data.deactivateClient.branchId).toBeDefined();
    expect(data.deactivateClient.currencyId).toBeDefined();
    expect(typeof data.deactivateClient.trustLevel).toBe('number');

    // Restore charlie
    await pool.query(`UPDATE client SET status = 'on_hold' WHERE id = $1`, [CHARLIE_ID]);
  });
});

describe('Tracked Functions — Optional args', () => {
  it('should accept a SETOF function call without args argument', async () => {
    const { body } = await graphqlRequest(
      `query {
        searchClients {
          id
          username
        }
      }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );

    // Should not get a validation error — args is optional
    expect(body.errors).toBeUndefined();
    expect(body.data).toBeDefined();
    const data = body.data as { searchClients: AnyRow[] };
    expect(Array.isArray(data.searchClients)).toBe(true);
  });

  it('should accept an aggregate function call without args argument', async () => {
    const { body } = await graphqlRequest(
      `query {
        searchClientsAggregate {
          aggregate {
            count
          }
        }
      }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );

    expect(body.errors).toBeUndefined();
    const data = body.data as { searchClientsAggregate: { aggregate: { count: number } } };
    expect(data.searchClientsAggregate.aggregate).toBeDefined();
    expect(typeof data.searchClientsAggregate.aggregate.count).toBe('number');
  });
});

describe('Tracked Functions — Aggregate', () => {
  it('should execute aggregate on a SETOF function', async () => {
    const { body } = await graphqlRequest(
      `query {
        searchClientsAggregate(args: { searchTerm: "" }) {
          aggregate {
            count
          }
        }
      }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );

    expect(body.errors).toBeUndefined();
    const data = body.data as { searchClientsAggregate: { aggregate: { count: number } } };
    expect(data.searchClientsAggregate).toBeDefined();
    expect(data.searchClientsAggregate.aggregate).toBeDefined();
    expect(data.searchClientsAggregate.aggregate.count).toBeGreaterThan(0);
  });
});
