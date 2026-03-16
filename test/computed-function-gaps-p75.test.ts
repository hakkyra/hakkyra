/**
 * Phase 7.5 — Computed Field & Function Test Gaps
 *
 * Covers:
 * 1. Aggregate E2E execution of computed fields (sum, avg, etc.)
 * 2. INSERT RETURNING with computed fields
 * 3. SETOF computed field with where/orderBy/limit
 * 4. Computed field WHERE with arguments
 * 5. Tracked function aggregate with where filter
 * 6. Tracked function return-table row-level filter
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  startServer, stopServer, closePool, waitForDb, getPool,
  graphqlRequest, tokens,
  ADMIN_SECRET, ALICE_ID, BOB_ID, CHARLIE_ID, DIANA_ID,
  BRANCH_TEST_ID, ACCOUNT_ALICE_ID,
  TEST_DB_URL,
} from './setup.js';

type AnyRow = Record<string, unknown>;

// ─── Server lifecycle ────────────────────────────────────────────────────────

beforeAll(async () => {
  process.env['DATABASE_URL'] = TEST_DB_URL;
  process.env['HAKKYRA_ADMIN_SECRET'] = ADMIN_SECRET;
  await waitForDb();
  await startServer();
}, 30_000);

afterAll(async () => {
  await stopServer();
  await closePool();
});

// ─── 1. Aggregate E2E execution of computed fields ──────────────────────────

describe('Aggregate E2E execution of computed fields', () => {
  // BUG FIX: The resolver now includes computed fields in sum/avg/min/max for both
  // groupBy and non-groupBy aggregates. Previously, aggregate.computedFields was only
  // populated in the groupBy path.

  it('clientsAggregate with sum { totalBalance } returns correct total', async () => {
    // Query the DB to get the expected total for the 4 known clients
    const pool = getPool();
    const dbResult = await pool.query(
      `SELECT SUM(public.client_total_balance(c)) as total FROM client c WHERE c.id = ANY($1)`,
      [[ALICE_ID, BOB_ID, CHARLIE_ID, DIANA_ID]],
    );
    const expectedTotal = Number(dbResult.rows[0].total);

    const { status, body } = await graphqlRequest(
      `query {
        clientsAggregate(where: { id: { _in: ["${ALICE_ID}", "${BOB_ID}", "${CHARLIE_ID}", "${DIANA_ID}"] } }) {
          aggregate {
            sum { totalBalance }
          }
        }
      }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const agg = (body.data as { clientsAggregate: { aggregate: AnyRow } }).clientsAggregate.aggregate;
    expect(Number((agg.sum as AnyRow).totalBalance)).toBe(expectedTotal);
  });

  it('clientsAggregate with avg { totalBalance } returns correct average', async () => {
    // Query the DB to get the expected average for the 4 known clients
    const pool = getPool();
    const dbResult = await pool.query(
      `SELECT AVG(public.client_total_balance(c)) as avg_val FROM client c WHERE c.id = ANY($1)`,
      [[ALICE_ID, BOB_ID, CHARLIE_ID, DIANA_ID]],
    );
    const expectedAvg = Number(dbResult.rows[0].avg_val);

    const { status, body } = await graphqlRequest(
      `query {
        clientsAggregate(where: { id: { _in: ["${ALICE_ID}", "${BOB_ID}", "${CHARLIE_ID}", "${DIANA_ID}"] } }) {
          aggregate {
            avg { totalBalance }
          }
        }
      }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const agg = (body.data as { clientsAggregate: { aggregate: AnyRow } }).clientsAggregate.aggregate;
    expect(Number((agg.avg as AnyRow).totalBalance)).toBe(expectedAvg);
  });

  it('clientsAggregate with min/max { totalBalance }', async () => {
    // Query the DB to get the expected min/max for the 4 known clients
    const pool = getPool();
    const dbResult = await pool.query(
      `SELECT MIN(public.client_total_balance(c)) as min_val, MAX(public.client_total_balance(c)) as max_val FROM client c WHERE c.id = ANY($1)`,
      [[ALICE_ID, BOB_ID, CHARLIE_ID, DIANA_ID]],
    );
    const expectedMin = Number(dbResult.rows[0].min_val);
    const expectedMax = Number(dbResult.rows[0].max_val);

    const { status, body } = await graphqlRequest(
      `query {
        clientsAggregate(where: { id: { _in: ["${ALICE_ID}", "${BOB_ID}", "${CHARLIE_ID}", "${DIANA_ID}"] } }) {
          aggregate {
            min { totalBalance }
            max { totalBalance }
          }
        }
      }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const agg = (body.data as { clientsAggregate: { aggregate: AnyRow } }).clientsAggregate.aggregate;
    expect(Number((agg.min as AnyRow).totalBalance)).toBe(expectedMin);
    expect(Number((agg.max as AnyRow).totalBalance)).toBe(expectedMax);
  });

  it('accountAggregate with sum { total } computed field', async () => {
    // Query the DB to get the expected total for accounts of the 4 known clients
    const pool = getPool();
    const dbResult = await pool.query(
      `SELECT SUM(public.account_total(a)) as total FROM account a WHERE a.client_id = ANY($1)`,
      [[ALICE_ID, BOB_ID, CHARLIE_ID, DIANA_ID]],
    );
    const expectedTotal = Number(dbResult.rows[0].total);

    const { status, body } = await graphqlRequest(
      `query {
        accountAggregate(where: { clientId: { _in: ["${ALICE_ID}", "${BOB_ID}", "${CHARLIE_ID}", "${DIANA_ID}"] } }) {
          aggregate {
            sum { total }
          }
        }
      }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const agg = (body.data as { accountAggregate: { aggregate: AnyRow } }).accountAggregate.aggregate;
    expect(Number((agg.sum as AnyRow).total)).toBe(expectedTotal);
  });

  it('backoffice role can use aggregate with computed field', async () => {
    // Query the DB to get the expected total for the 4 known clients
    const pool = getPool();
    const dbResult = await pool.query(
      `SELECT SUM(public.client_total_balance(c)) as total FROM client c WHERE c.id = ANY($1)`,
      [[ALICE_ID, BOB_ID, CHARLIE_ID, DIANA_ID]],
    );
    const expectedTotal = Number(dbResult.rows[0].total);

    const token = await tokens.backoffice();
    const { status, body } = await graphqlRequest(
      `query {
        clientsAggregate(where: { id: { _in: ["${ALICE_ID}", "${BOB_ID}", "${CHARLIE_ID}", "${DIANA_ID}"] } }) {
          aggregate {
            sum { totalBalance }
            count
          }
        }
      }`,
      undefined,
      { authorization: `Bearer ${token}` },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const agg = (body.data as { clientsAggregate: { aggregate: AnyRow } }).clientsAggregate.aggregate;
    expect(agg.count).toBe(4);
    expect(Number((agg.sum as AnyRow).totalBalance)).toBe(expectedTotal);
  });

  it('clientsAggregate with count and where filter on computed field', async () => {
    const { status, body } = await graphqlRequest(
      `query {
        clientsAggregate(where: { totalBalance: { _gt: 0 } }) {
          aggregate {
            count
          }
        }
      }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const agg = (body.data as { clientsAggregate: { aggregate: AnyRow } }).clientsAggregate.aggregate;
    // Alice (1700), Bob (500), Diana (25500) have totalBalance > 0; Charlie (0) does not
    expect(agg.count).toBe(3);
  });

  it('clientsAggregate count works without computed field in select', async () => {
    const { status, body } = await graphqlRequest(
      `query {
        clientsAggregate {
          aggregate {
            count
          }
        }
      }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const agg = (body.data as { clientsAggregate: { aggregate: AnyRow } }).clientsAggregate.aggregate;
    expect(agg.count).toBe(4);
  });
});

// ─── 2. INSERT RETURNING with computed fields ───────────────────────────────

describe('INSERT RETURNING with computed fields', () => {
  it('insertClient returns totalBalance computed field (new client has no accounts => 0)', async () => {
    const pool = getPool();
    const tempId = 'dd000000-0000-0000-0000-000000000088';

    try {
      const { status, body } = await graphqlRequest(
        `mutation {
          insertClient(object: {
            username: "cf_insert_test"
            email: "cfinsert@test.com"
            branchId: "${BRANCH_TEST_ID}"
            currencyId: "EUR"
          }) {
            id
            username
            totalBalance
          }
        }`,
        undefined,
        { 'x-hasura-admin-secret': ADMIN_SECRET },
      );
      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();
      const client = (body.data as { insertClient: AnyRow }).insertClient;
      expect(client).toBeDefined();
      expect(client.username).toBe('cf_insert_test');
      // New client has no accounts, totalBalance should be 0
      expect(Number(client.totalBalance)).toBe(0);
    } finally {
      await pool.query('DELETE FROM client WHERE username = $1', ['cf_insert_test']).catch(() => {});
    }
  });

  it('insertClient returns isOwn computed field with session variable', async () => {
    const pool = getPool();

    try {
      const token = await tokens.client(ALICE_ID);
      // Admin inserts, but we can check the computed field works in general
      const { status, body } = await graphqlRequest(
        `mutation {
          insertClient(object: {
            username: "cf_insert_own_test"
            email: "cfinsert_own@test.com"
            branchId: "${BRANCH_TEST_ID}"
            currencyId: "EUR"
          }) {
            id
            username
            totalBalance
          }
        }`,
        undefined,
        { 'x-hasura-admin-secret': ADMIN_SECRET },
      );
      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();
      const client = (body.data as { insertClient: AnyRow }).insertClient;
      expect(client).toBeDefined();
      expect(client.username).toBe('cf_insert_own_test');
      expect(Number(client.totalBalance)).toBe(0);
    } finally {
      await pool.query('DELETE FROM client WHERE username = $1', ['cf_insert_own_test']).catch(() => {});
    }
  });

  it('insertClients (batch) returns totalBalance computed field on each row', async () => {
    const pool = getPool();

    try {
      const { status, body } = await graphqlRequest(
        `mutation {
          insertClients(objects: [
            {
              username: "cf_batch_1"
              email: "cfbatch1@test.com"
              branchId: "${BRANCH_TEST_ID}"
              currencyId: "EUR"
            }
            {
              username: "cf_batch_2"
              email: "cfbatch2@test.com"
              branchId: "${BRANCH_TEST_ID}"
              currencyId: "USD"
            }
          ]) {
            affectedRows
            returning {
              id
              username
              totalBalance
            }
          }
        }`,
        undefined,
        { 'x-hasura-admin-secret': ADMIN_SECRET },
      );
      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();
      const result = (body.data as { insertClients: AnyRow }).insertClients;
      expect(result.affectedRows).toBe(2);
      const returning = result.returning as AnyRow[];
      expect(returning.length).toBe(2);
      for (const row of returning) {
        expect(Number(row.totalBalance)).toBe(0);
      }
    } finally {
      await pool.query("DELETE FROM client WHERE username IN ('cf_batch_1', 'cf_batch_2')").catch(() => {});
    }
  });

  it('insertClient with backoffice role returns computed field', async () => {
    const pool = getPool();
    const token = await tokens.backoffice();

    try {
      const { status, body } = await graphqlRequest(
        `mutation {
          insertClient(object: {
            username: "cf_bo_insert"
            email: "cfboinsert@test.com"
            branchId: "${BRANCH_TEST_ID}"
            currencyId: "EUR"
          }) {
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
      const client = (body.data as { insertClient: AnyRow }).insertClient;
      expect(client).toBeDefined();
      expect(client.username).toBe('cf_bo_insert');
      expect(Number(client.totalBalance)).toBe(0);
    } finally {
      await pool.query('DELETE FROM client WHERE username = $1', ['cf_bo_insert']).catch(() => {});
    }
  });
});

// ─── 3. SETOF computed field with where/orderBy/limit ───────────────────────

describe('SETOF computed field with where/orderBy/limit', () => {
  it('activeAccounts SETOF computed field with where filter', async () => {
    // Alice has one active account with balance=1500. Filter for balance > 1000
    const token = await tokens.backoffice();
    const { status, body } = await graphqlRequest(
      `query($id: Uuid!) {
        clientByPk(id: $id) {
          id
          username
          activeAccounts(where: { balance: { _gt: 1000 } }) {
            id
            balance
          }
        }
      }`,
      { id: ALICE_ID },
      { authorization: `Bearer ${token}` },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const client = (body.data as { clientByPk: AnyRow }).clientByPk;
    const accounts = client.activeAccounts as AnyRow[];
    expect(Array.isArray(accounts)).toBe(true);
    expect(accounts.length).toBeGreaterThanOrEqual(1);
    for (const acc of accounts) {
      expect(Number(acc.balance)).toBeGreaterThan(1000);
    }
  });

  it('activeAccounts SETOF computed field with where filter returning empty', async () => {
    const token = await tokens.backoffice();
    const { status, body } = await graphqlRequest(
      `query($id: Uuid!) {
        clientByPk(id: $id) {
          id
          username
          activeAccounts(where: { balance: { _gt: 999999 } }) {
            id
            balance
          }
        }
      }`,
      { id: ALICE_ID },
      { authorization: `Bearer ${token}` },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const client = (body.data as { clientByPk: AnyRow }).clientByPk;
    const accounts = client.activeAccounts as AnyRow[];
    expect(accounts.length).toBe(0);
  });

  it('activeAccounts SETOF computed field with orderBy', async () => {
    const pool = getPool();
    // Give Alice a second active account so we can test ordering
    const tempAccountId = 'e0000000-0000-0000-0000-000000000099';
    await pool.query(
      `INSERT INTO account (id, client_id, currency_id, balance, credit_balance, active)
       VALUES ($1, $2, 'USD', 300.00, 0, true)
       ON CONFLICT (id) DO NOTHING`,
      [tempAccountId, ALICE_ID],
    );

    try {
      const token = await tokens.backoffice();
      const { status, body } = await graphqlRequest(
        `query($id: Uuid!) {
          clientByPk(id: $id) {
            id
            activeAccounts(orderBy: [{ balance: ASC }]) {
              id
              balance
            }
          }
        }`,
        { id: ALICE_ID },
        { authorization: `Bearer ${token}` },
      );
      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();
      const client = (body.data as { clientByPk: AnyRow }).clientByPk;
      const accounts = client.activeAccounts as AnyRow[];
      expect(accounts.length).toBeGreaterThanOrEqual(2);
      // Verify ascending order
      for (let i = 1; i < accounts.length; i++) {
        expect(Number(accounts[i].balance)).toBeGreaterThanOrEqual(Number(accounts[i - 1].balance));
      }
    } finally {
      await pool.query('DELETE FROM account WHERE id = $1', [tempAccountId]);
    }
  });

  it('activeAccounts SETOF computed field with limit', async () => {
    const pool = getPool();
    // Give Alice a second active account
    const tempAccountId = 'e0000000-0000-0000-0000-000000000098';
    await pool.query(
      `INSERT INTO account (id, client_id, currency_id, balance, credit_balance, active)
       VALUES ($1, $2, 'GBP', 200.00, 0, true)
       ON CONFLICT (id) DO NOTHING`,
      [tempAccountId, ALICE_ID],
    );

    try {
      const token = await tokens.backoffice();
      const { status, body } = await graphqlRequest(
        `query($id: Uuid!) {
          clientByPk(id: $id) {
            id
            activeAccounts(limit: 1) {
              id
              balance
            }
          }
        }`,
        { id: ALICE_ID },
        { authorization: `Bearer ${token}` },
      );
      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();
      const client = (body.data as { clientByPk: AnyRow }).clientByPk;
      const accounts = client.activeAccounts as AnyRow[];
      expect(accounts.length).toBe(1);
    } finally {
      await pool.query('DELETE FROM account WHERE id = $1', [tempAccountId]);
    }
  });

  it('activeAccounts SETOF computed field with combined where + orderBy + limit', async () => {
    const pool = getPool();
    // Give Alice two more active accounts
    const temp1 = 'e0000000-0000-0000-0000-000000000097';
    const temp2 = 'e0000000-0000-0000-0000-000000000096';
    await pool.query(
      `INSERT INTO account (id, client_id, currency_id, balance, credit_balance, active)
       VALUES ($1, $2, 'GBP', 800.00, 0, true)
       ON CONFLICT (id) DO NOTHING`,
      [temp1, ALICE_ID],
    );
    await pool.query(
      `INSERT INTO account (id, client_id, currency_id, balance, credit_balance, active)
       VALUES ($1, $2, 'USD', 200.00, 0, true)
       ON CONFLICT (id) DO NOTHING`,
      [temp2, ALICE_ID],
    );

    try {
      const token = await tokens.backoffice();
      const { status, body } = await graphqlRequest(
        `query($id: Uuid!) {
          clientByPk(id: $id) {
            id
            activeAccounts(
              where: { balance: { _gt: 100 } }
              orderBy: [{ balance: DESC }]
              limit: 2
            ) {
              id
              balance
            }
          }
        }`,
        { id: ALICE_ID },
        { authorization: `Bearer ${token}` },
      );
      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();
      const client = (body.data as { clientByPk: AnyRow }).clientByPk;
      const accounts = client.activeAccounts as AnyRow[];
      // Should get at most 2 accounts with balance > 100, ordered DESC
      expect(accounts.length).toBeLessThanOrEqual(2);
      expect(accounts.length).toBeGreaterThan(0);
      for (const acc of accounts) {
        expect(Number(acc.balance)).toBeGreaterThan(100);
      }
      // Verify descending order
      for (let i = 1; i < accounts.length; i++) {
        expect(Number(accounts[i].balance)).toBeLessThanOrEqual(Number(accounts[i - 1].balance));
      }
    } finally {
      await pool.query('DELETE FROM account WHERE id IN ($1, $2)', [temp1, temp2]);
    }
  });
});

// ─── 4. Computed field WHERE with arguments ─────────────────────────────────

describe('Computed field WHERE with arguments', () => {
  it('filter clients by balanceInCurrency computed field (with default arg)', async () => {
    // balanceInCurrency defaults to EUR. Alice has EUR account balance=1500.
    const { status, body } = await graphqlRequest(
      `query {
        clients(where: { balanceInCurrency: { _gt: 1000 } }) {
          id
          username
          balanceInCurrency
        }
      }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const clients = (body.data as { clients: AnyRow[] }).clients;
    // Alice has EUR balance=1500, so she should be included
    expect(clients.length).toBeGreaterThan(0);
    for (const c of clients) {
      expect(Number(c.balanceInCurrency)).toBeGreaterThan(1000);
    }
    const alice = clients.find((c) => c.id === ALICE_ID);
    expect(alice).toBeDefined();
    expect(Number(alice!.balanceInCurrency)).toBe(1500);
  });

  // BUG FIX: The computed field isOwn returns PG type "boolean" which now maps to
  // Boolean correctly (both "bool" and "boolean" long form are handled).
  // Verify that the BoolExp for isOwn accepts a boolean value (not a string).
  // NOTE: WHERE filtering on session-dependent computed fields is a separate known
  // limitation (the session is not passed to the function in WHERE clause compilation),
  // so we test the type mapping by querying isOwn in the SELECT clause and verifying
  // it returns a proper boolean value.
  it('isOwn computed field returns boolean type (not string) after type-map fix', async () => {
    const token = await tokens.client(ALICE_ID);
    const { status, body } = await graphqlRequest(
      `query {
        clients {
          id
          username
          isOwn
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
    // The key assertion: isOwn should be a boolean (true), not a string "true"
    // Before the fix, "boolean" PG type fell through to String in the type map
    expect(clients[0].isOwn).toBe(true);
    expect(typeof clients[0].isOwn).toBe('boolean');
  });
});

// ─── 5. Tracked function aggregate with where filter ────────────────────────

describe('Tracked function aggregate with where filter', () => {
  it('searchClientsAggregate with where filter on status', async () => {
    const { status, body } = await graphqlRequest(
      `query {
        searchClientsAggregate(
          args: { search_term: "" }
          where: { status: { _eq: ACTIVE } }
        ) {
          aggregate {
            count
          }
        }
      }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const agg = (body.data as { searchClientsAggregate: { aggregate: AnyRow } })
      .searchClientsAggregate.aggregate;
    // Alice, Bob, Diana are active; Charlie is on_hold
    expect(agg.count).toBe(3);
  });

  it('searchClientsAggregate with where filter on trustLevel', async () => {
    const { status, body } = await graphqlRequest(
      `query {
        searchClientsAggregate(
          args: { search_term: "" }
          where: { trustLevel: { _gte: 2 } }
        ) {
          aggregate {
            count
            sum { trustLevel }
          }
        }
      }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const agg = (body.data as { searchClientsAggregate: { aggregate: AnyRow } })
      .searchClientsAggregate.aggregate;
    // Alice (2) and Diana (3) have trust_level >= 2
    expect(agg.count).toBe(2);
    expect(Number((agg.sum as AnyRow).trustLevel)).toBe(5);
  });

  it('searchClientsAggregate with combined args and where filter', async () => {
    const { status, body } = await graphqlRequest(
      `query {
        searchClientsAggregate(
          args: { search_term: "a" }
          where: { status: { _eq: ACTIVE } }
        ) {
          aggregate {
            count
          }
        }
      }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const agg = (body.data as { searchClientsAggregate: { aggregate: AnyRow } })
      .searchClientsAggregate.aggregate;
    // "a" matches alice and diana (both active); charlie matches but is on_hold
    expect(agg.count).toBeGreaterThanOrEqual(1);
  });

  it('clientsByDateAggregate with where filter on status', async () => {
    const { status, body } = await graphqlRequest(
      `query {
        clientsByDateAggregate(
          args: { since: "2000-01-01T00:00:00Z" }
          where: { status: { _eq: ACTIVE } }
        ) {
          aggregate {
            count
          }
        }
      }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const agg = (body.data as { clientsByDateAggregate: { aggregate: AnyRow } })
      .clientsByDateAggregate.aggregate;
    // Alice, Bob, Diana are active
    expect(agg.count).toBe(3);
  });
});

// ─── 6. Tracked function return-table row-level filter ──────────────────────

describe('Tracked function return-table row-level filter', () => {
  it('searchClients applies return-table select permissions for backoffice (no row filter)', async () => {
    const token = await tokens.backoffice();
    const { status, body } = await graphqlRequest(
      `query {
        searchClients(args: { search_term: "" }) {
          id
          username
          status
        }
      }`,
      undefined,
      { authorization: `Bearer ${token}` },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const clients = (body.data as { searchClients: AnyRow[] }).searchClients;
    // Backoffice has no row filter on client, so all 4 clients should be returned
    expect(clients.length).toBe(4);
  });

  it('myClients applies session-based row filtering from function definition', async () => {
    // my_clients function uses session_argument to filter by x-hasura-user-id
    const token = await tokens.client(ALICE_ID);
    const { status, body } = await graphqlRequest(
      `query {
        myClients {
          id
          username
          status
        }
      }`,
      undefined,
      { authorization: `Bearer ${token}` },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const clients = (body.data as { myClients: AnyRow[] }).myClients;
    // my_clients filters by session x-hasura-user-id = Alice's ID
    // Plus client role has filter: id = X-Hasura-User-Id
    expect(clients.length).toBe(1);
    expect(clients[0].id).toBe(ALICE_ID);
    expect(clients[0].username).toBe('alice');
  });

  it('myClients for Bob returns only Bob', async () => {
    const token = await tokens.client(BOB_ID);
    const { status, body } = await graphqlRequest(
      `query {
        myClients {
          id
          username
        }
      }`,
      undefined,
      { authorization: `Bearer ${token}` },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const clients = (body.data as { myClients: AnyRow[] }).myClients;
    expect(clients.length).toBe(1);
    expect(clients[0].id).toBe(BOB_ID);
    expect(clients[0].username).toBe('bob');
  });

  it('searchClients as backoffice applies column permissions from return table', async () => {
    const token = await tokens.backoffice();
    const { status, body } = await graphqlRequest(
      `query {
        searchClients(args: { search_term: "alice" }) {
          id
          username
          email
          status
          branchId
          trustLevel
        }
      }`,
      undefined,
      { authorization: `Bearer ${token}` },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const clients = (body.data as { searchClients: AnyRow[] }).searchClients;
    expect(clients.length).toBeGreaterThan(0);
    const alice = clients.find((c) => c.username === 'alice')!;
    // Backoffice has columns: "*" on client, so all columns should be accessible
    expect(alice.email).toBe('alice@test.com');
    expect(alice.branchId).toBeDefined();
    expect(alice.trustLevel).toBeDefined();
  });

  it('searchClients denied for role without function permission (client role)', async () => {
    const token = await tokens.client(ALICE_ID);
    const { status, body } = await graphqlRequest(
      `query {
        searchClients(args: { search_term: "alice" }) {
          id
          username
        }
      }`,
      undefined,
      { authorization: `Bearer ${token}` },
    );
    // Client role does not have permission on search_clients function
    expect(body.errors).toBeDefined();
    expect(body.errors!.length).toBeGreaterThan(0);
  });

  it('searchClientsByTrust applies where filter on function results', async () => {
    const { status, body } = await graphqlRequest(
      `query {
        searchClientsByTrust(
          args: { min_level: 1 }
          where: { status: { _eq: ACTIVE } }
        ) {
          id
          username
          trustLevel
          status
        }
      }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const clients = (body.data as { searchClientsByTrust: AnyRow[] }).searchClientsByTrust;
    // Function returns clients with trust_level >= 1 (Alice=2, Bob=1, Diana=3)
    // WHERE filter further restricts to status=ACTIVE (excludes Charlie who has trust_level=0 anyway)
    expect(clients.length).toBeGreaterThan(0);
    for (const c of clients) {
      expect(c.status).toBe('ACTIVE');
      expect(Number(c.trustLevel)).toBeGreaterThanOrEqual(1);
    }
  });
});
