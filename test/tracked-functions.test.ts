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
  startServer, stopServer, graphqlRequest, tokens, createJWT,
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

  it('should execute aggregate sum on a SETOF function', async () => {
    const { body } = await graphqlRequest(
      `query {
        searchClientsAggregate(args: { searchTerm: "" }) {
          aggregate {
            sum { trustLevel }
          }
        }
      }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );

    expect(body.errors).toBeUndefined();
    const data = body.data as { searchClientsAggregate: { aggregate: { sum: { trustLevel: number } } } };
    expect(data.searchClientsAggregate.aggregate.sum).toBeDefined();
    // alice=2, bob=1, charlie=0, diana=3 => sum=6
    expect(Number(data.searchClientsAggregate.aggregate.sum.trustLevel)).toBe(6);
  });

  it('should execute aggregate avg on a SETOF function', async () => {
    const { body } = await graphqlRequest(
      `query {
        searchClientsAggregate(args: { searchTerm: "" }) {
          aggregate {
            avg { trustLevel }
          }
        }
      }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );

    expect(body.errors).toBeUndefined();
    const data = body.data as { searchClientsAggregate: { aggregate: { avg: { trustLevel: number } } } };
    expect(data.searchClientsAggregate.aggregate.avg).toBeDefined();
    // alice=2, bob=1, charlie=0, diana=3 => avg=1.5
    expect(Number(data.searchClientsAggregate.aggregate.avg.trustLevel)).toBe(1.5);
  });

  it('should execute aggregate min on a SETOF function', async () => {
    const { body } = await graphqlRequest(
      `query {
        searchClientsAggregate(args: { searchTerm: "" }) {
          aggregate {
            min { trustLevel }
          }
        }
      }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );

    expect(body.errors).toBeUndefined();
    const data = body.data as { searchClientsAggregate: { aggregate: { min: { trustLevel: number } } } };
    expect(data.searchClientsAggregate.aggregate.min).toBeDefined();
    // charlie has trust_level=0 => min=0
    expect(Number(data.searchClientsAggregate.aggregate.min.trustLevel)).toBe(0);
  });

  it('should execute aggregate max on a SETOF function', async () => {
    const { body } = await graphqlRequest(
      `query {
        searchClientsAggregate(args: { searchTerm: "" }) {
          aggregate {
            max { trustLevel }
          }
        }
      }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );

    expect(body.errors).toBeUndefined();
    const data = body.data as { searchClientsAggregate: { aggregate: { max: { trustLevel: number } } } };
    expect(data.searchClientsAggregate.aggregate.max).toBeDefined();
    // diana has trust_level=3 => max=3
    expect(Number(data.searchClientsAggregate.aggregate.max.trustLevel)).toBe(3);
  });

  it('should execute multiple aggregate functions together on a SETOF function', async () => {
    const { body } = await graphqlRequest(
      `query {
        searchClientsAggregate(args: { searchTerm: "" }) {
          aggregate {
            count
            sum { trustLevel }
            avg { trustLevel }
            min { trustLevel }
            max { trustLevel }
          }
        }
      }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );

    expect(body.errors).toBeUndefined();
    const agg = (body.data as { searchClientsAggregate: { aggregate: AnyRow } })
      .searchClientsAggregate.aggregate;
    expect(agg.count).toBeGreaterThanOrEqual(4);
    expect(Number((agg.sum as AnyRow).trustLevel)).toBe(6);
    expect(Number((agg.avg as AnyRow).trustLevel)).toBe(1.5);
    expect(Number((agg.min as AnyRow).trustLevel)).toBe(0);
    expect(Number((agg.max as AnyRow).trustLevel)).toBe(3);
  });
});

// ─── Empty / Null Results (P6.5g) ────────────────────────────────────────

describe('Tracked Functions — Empty/Null Results', () => {
  it('SETOF function returns empty array when nothing matches', async () => {
    const { body } = await graphqlRequest(
      `query {
        searchClients(args: { searchTerm: "zzzzznonexistent" }) {
          id
          username
        }
      }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );

    expect(body.errors).toBeUndefined();
    const data = body.data as { searchClients: AnyRow[] };
    expect(Array.isArray(data.searchClients)).toBe(true);
    expect(data.searchClients.length).toBe(0);
  });

  it('mutation function returns null for non-existent UUID', async () => {
    const nonExistentId = '00000000-0000-0000-0000-000000000099';
    const { body } = await graphqlRequest(
      `mutation {
        deactivateClient(args: { clientUuid: "${nonExistentId}" }) {
          id
          username
          status
        }
      }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );

    // Non-SETOF function returning no rows produces a GraphQL error
    // because the return type is non-nullable Client!
    expect(body.errors).toBeDefined();
    expect(body.errors.length).toBeGreaterThan(0);
  });
});

// ─── Mutation Functions with Relationships (P6.5h) ──────────────────────

describe('Tracked Functions — Mutation with Relationships', () => {
  it('mutation function resolves relationships in RETURNING', async () => {
    // Ensure charlie is active first
    const pool = getPool();
    await pool.query(`UPDATE client SET status = 'active' WHERE id = $1`, [CHARLIE_ID]);

    const { body } = await graphqlRequest(
      `mutation {
        deactivateClient(args: { clientUuid: "${CHARLIE_ID}" }) {
          id
          username
          status
          branch {
            name
          }
        }
      }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );

    expect(body.errors).toBeUndefined();
    const data = body.data as { deactivateClient: AnyRow };
    expect(data.deactivateClient).toBeDefined();
    expect(data.deactivateClient.username).toBe('charlie');
    expect(data.deactivateClient.status).toBe('INACTIVE');
    expect(data.deactivateClient.branch).toBeDefined();
    // Charlie is in OtherBranch (branch_id = a0...0002)
    expect((data.deactivateClient.branch as AnyRow).name).toBe('OtherBranch');

    // Restore charlie
    await pool.query(`UPDATE client SET status = 'on_hold' WHERE id = $1`, [CHARLIE_ID]);
  });

  it('mutation function resolves array relationships in RETURNING', async () => {
    // Ensure charlie is active first
    const pool = getPool();
    await pool.query(`UPDATE client SET status = 'active' WHERE id = $1`, [CHARLIE_ID]);

    const { body } = await graphqlRequest(
      `mutation {
        deactivateClient(args: { clientUuid: "${CHARLIE_ID}" }) {
          id
          username
          accounts {
            balance
            currencyId
          }
        }
      }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );

    expect(body.errors).toBeUndefined();
    const data = body.data as { deactivateClient: AnyRow };
    expect(data.deactivateClient).toBeDefined();
    expect(data.deactivateClient.username).toBe('charlie');
    expect(Array.isArray(data.deactivateClient.accounts)).toBe(true);
    // Charlie has one account with balance=0
    const accounts = data.deactivateClient.accounts as AnyRow[];
    expect(accounts.length).toBe(1);
    expect(Number(accounts[0].balance)).toBe(0);

    // Restore charlie
    await pool.query(`UPDATE client SET status = 'on_hold' WHERE id = $1`, [CHARLIE_ID]);
  });

  it('SETOF query function resolves nested relationships', async () => {
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
            creditBalance
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
    const accounts = alice!.accounts as AnyRow[];
    expect(accounts.length).toBe(1);
    expect(Number(accounts[0].balance)).toBe(1500);
    expect(Number(accounts[0].creditBalance)).toBe(200);
  });
});

// ─── Diverse Argument Types (P6.5a) ──────────────────────────────────────

describe('Tracked Functions — Diverse Argument Types', () => {
  it('should call searchClientsByDate with a date in the past and return clients', async () => {
    const { body } = await graphqlRequest(
      `query {
        searchClientsByDate(args: { since: "2000-01-01T00:00:00Z" }) {
          id
          username
          createdAt
        }
      }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );

    expect(body.errors).toBeUndefined();
    const data = body.data as { searchClientsByDate: AnyRow[] };
    expect(Array.isArray(data.searchClientsByDate)).toBe(true);
    // All 4 seed clients were created after 2000-01-01
    expect(data.searchClientsByDate.length).toBeGreaterThanOrEqual(4);
    const usernames = data.searchClientsByDate.map((c) => c.username);
    expect(usernames).toContain('alice');
    expect(usernames).toContain('bob');
    expect(usernames).toContain('charlie');
    expect(usernames).toContain('diana');
  });

  it('should call searchClientsByTrust with minLevel=2 and return alice and diana', async () => {
    const { body } = await graphqlRequest(
      `query {
        searchClientsByTrust(args: { minLevel: 2 }) {
          id
          username
          trustLevel
        }
      }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );

    expect(body.errors).toBeUndefined();
    const data = body.data as { searchClientsByTrust: AnyRow[] };
    expect(Array.isArray(data.searchClientsByTrust)).toBe(true);
    const usernames = data.searchClientsByTrust.map((c) => c.username);
    // alice has trust_level=2, diana has trust_level=3
    expect(usernames).toContain('alice');
    expect(usernames).toContain('diana');
    // bob (trust=1) and charlie (trust=0) should NOT be returned
    expect(usernames).not.toContain('bob');
    expect(usernames).not.toContain('charlie');
  });

  it('should call searchClientsByTrust with minLevel=0, maxLevel=1 and return bob and charlie', async () => {
    const { body } = await graphqlRequest(
      `query {
        searchClientsByTrust(args: { minLevel: 0, maxLevel: 1 }) {
          id
          username
          trustLevel
        }
      }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );

    expect(body.errors).toBeUndefined();
    const data = body.data as { searchClientsByTrust: AnyRow[] };
    expect(Array.isArray(data.searchClientsByTrust)).toBe(true);
    const usernames = data.searchClientsByTrust.map((c) => c.username);
    // bob has trust_level=1, charlie has trust_level=0
    expect(usernames).toContain('bob');
    expect(usernames).toContain('charlie');
    // alice (trust=2) and diana (trust=3) should NOT be returned
    expect(usernames).not.toContain('alice');
    expect(usernames).not.toContain('diana');
  });
});

// ─── Default Parameter Values (P6.5b) ────────────────────────────────────

describe('Tracked Functions — Default Parameter Values', () => {
  it('should use DEFAULT 10 for maxLevel when only minLevel is provided', async () => {
    const { body } = await graphqlRequest(
      `query {
        searchClientsByTrust(args: { minLevel: 2 }) {
          id
          username
          trustLevel
        }
      }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );

    expect(body.errors).toBeUndefined();
    const data = body.data as { searchClientsByTrust: AnyRow[] };
    expect(Array.isArray(data.searchClientsByTrust)).toBe(true);
    const usernames = data.searchClientsByTrust.map((c) => c.username);
    // With DEFAULT max_level=10, alice (trust=2) and diana (trust=3) should be returned
    expect(usernames).toContain('alice');
    expect(usernames).toContain('diana');
    expect(usernames).not.toContain('bob');
    expect(usernames).not.toContain('charlie');
  });

  it('should use explicit maxLevel when both minLevel and maxLevel are provided', async () => {
    const { body } = await graphqlRequest(
      `query {
        searchClientsByTrust(args: { minLevel: 0, maxLevel: 1 }) {
          id
          username
          trustLevel
        }
      }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );

    expect(body.errors).toBeUndefined();
    const data = body.data as { searchClientsByTrust: AnyRow[] };
    expect(Array.isArray(data.searchClientsByTrust)).toBe(true);
    const usernames = data.searchClientsByTrust.map((c) => c.username);
    // Explicit maxLevel=1 limits results to bob (trust=1) and charlie (trust=0)
    expect(usernames).toContain('bob');
    expect(usernames).toContain('charlie');
    expect(usernames).not.toContain('alice');
    expect(usernames).not.toContain('diana');
  });
});

// ─── Session Variable Injection (P6.5d) ──────────────────────────────────

describe('Tracked Functions — Session Variable Injection', () => {
  it('should return only the calling client row when called as alice', async () => {
    const token = await tokens.client(ALICE_ID);
    const { body } = await graphqlRequest(
      `query {
        myClients {
          id
          username
        }
      }`,
      undefined,
      { authorization: `Bearer ${token}` },
    );

    expect(body.errors).toBeUndefined();
    const data = body.data as { myClients: AnyRow[] };
    expect(Array.isArray(data.myClients)).toBe(true);
    expect(data.myClients.length).toBe(1);
    expect(data.myClients[0].username).toBe('alice');
    expect(data.myClients[0].id).toBe(ALICE_ID);
  });

  it('should return the row matching the backoffice user ID (or empty if no user-id claim)', async () => {
    const token = await tokens.backoffice();
    const { body } = await graphqlRequest(
      `query {
        myClients {
          id
          username
        }
      }`,
      undefined,
      { authorization: `Bearer ${token}` },
    );

    expect(body.errors).toBeUndefined();
    const data = body.data as { myClients: AnyRow[] };
    expect(Array.isArray(data.myClients)).toBe(true);
    // backoffice token has no x-hasura-user-id, so the cast to uuid will fail
    // or return no matching rows
    expect(data.myClients.length).toBe(0);
  });
});

// ─── Non-public Schema Functions (P6.5i) ─────────────────────────────────

describe('Tracked Functions — Non-public Schema', () => {
  it.todo(
    'should support calling utils.countActiveClients from non-public schema ' +
    '(currently skipped: server only introspects the public schema by default, ' +
    'so "utils.count_active_clients" is not found in introspection)'
  );
});

// ─── Inherited Role Permissions on Functions (P6.5f) ─────────────────────

describe('Tracked Functions — Inherited Role Permissions', () => {
  it('backoffice_admin can call searchClients (backoffice has permission)', async () => {
    const token = await createJWT({
      role: 'backoffice_admin',
      allowedRoles: ['backoffice_admin', 'backoffice', 'administrator'],
    });
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
    expect(data.searchClients.length).toBeGreaterThan(0);
  });

  it('backoffice_admin can call deactivateClient (administrator has permission)', async () => {
    const pool = getPool();
    await pool.query(`UPDATE client SET status = 'active' WHERE id = $1`, [CHARLIE_ID]);

    const token = await createJWT({
      role: 'backoffice_admin',
      allowedRoles: ['backoffice_admin', 'backoffice', 'administrator'],
    });
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
    expect(data.deactivateClient).toBeDefined();
    expect(data.deactivateClient.username).toBe('charlie');
    expect(data.deactivateClient.status).toBe('INACTIVE');

    // Restore charlie
    await pool.query(`UPDATE client SET status = 'on_hold' WHERE id = $1`, [CHARLIE_ID]);
  });

  it('support can call searchClients (backoffice has permission)', async () => {
    const token = await createJWT({
      role: 'support',
      allowedRoles: ['support', 'backoffice'],
    });
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
    expect(data.searchClients.length).toBeGreaterThan(0);
  });

  it('support CANNOT call deactivateClient (only administrator has permission)', async () => {
    const token = await createJWT({
      role: 'support',
      allowedRoles: ['support', 'backoffice'],
    });
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
});
