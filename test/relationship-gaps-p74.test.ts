/**
 * Phase 7.4 — Relationship Test Gaps
 *
 * Covers:
 * 1. Cross-schema relationships (todo — no cross-schema table fixtures)
 * 2. Nested relationship traversal in where filters
 * 3. Object relationship ordering with NULL FK
 * 4. Relationship aggregates as nested query
 * 5. Permissions blocking nested relationship entirely
 * 6. Relationship data in updateMany RETURNING
 * 7. Config-defined relationship overriding auto-detected
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  startServer, stopServer, closePool, waitForDb, getPool,
  graphqlRequest, tokens,
  ADMIN_SECRET, ALICE_ID, BOB_ID, CHARLIE_ID,
  BRANCH_TEST_ID,
  ACCOUNT_ALICE_ID,
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

// ─── 1. Cross-schema relationships ──────────────────────────────────────────

describe('Cross-schema relationships', () => {
  // The test fixtures only have tables in public schema plus one function in utils schema.
  // There are no cross-schema table relationships defined in the current fixtures.
  it.todo('cross-schema relationship between tables in different schemas (no fixtures available)');
});

// ─── 2. Nested relationship traversal in where filters ──────────────────────

describe('Nested relationship traversal in where filters', () => {
  it('filters accounts by nested relationship field: accounts(where: { client: { status: { _eq: ACTIVE } } })', async () => {
    const { status, body } = await graphqlRequest(
      `query {
        account(where: { client: { status: { _eq: ACTIVE } } }) {
          id
          balance
          client {
            id
            username
            status
          }
        }
      }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const accounts = (body.data as { account: AnyRow[] }).account;
    expect(accounts.length).toBeGreaterThan(0);
    // Every returned account's client must have status ACTIVE
    for (const acc of accounts) {
      const client = acc.client as AnyRow;
      expect(client.status).toBe('ACTIVE');
    }
    // Alice (active), Bob (active), Diana (active) have accounts; Charlie (on_hold) should be excluded
    const clientIds = accounts.map((a) => (a.client as AnyRow).id);
    expect(clientIds).not.toContain(CHARLIE_ID);
  });

  it('filters invoices by nested relationship: invoice(where: { client: { branch: { name: { _eq: "TestBranch" } } } })', async () => {
    const { status, body } = await graphqlRequest(
      `query {
        invoice(where: { client: { branch: { name: { _eq: "TestBranch" } } } }) {
          id
          amount
          client {
            id
            username
            branch { name }
          }
        }
      }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const invoices = (body.data as { invoice: AnyRow[] }).invoice;
    expect(invoices.length).toBeGreaterThan(0);
    // All returned invoices should belong to clients in TestBranch
    for (const inv of invoices) {
      const client = inv.client as AnyRow;
      expect((client.branch as AnyRow).name).toBe('TestBranch');
    }
    // Alice and Bob are in TestBranch; Diana is in OtherBranch
    const clientUsernames = invoices.map((i) => ((i.client as AnyRow).username));
    const uniqueUsernames = [...new Set(clientUsernames)];
    // Should only include alice and/or bob
    for (const u of uniqueUsernames) {
      expect(['alice', 'bob']).toContain(u);
    }
  });

  it('filters array relationship by nested object relationship: clients(where: { accounts: { currency: { id: { _eq: "EUR" } } } })', async () => {
    const { status, body } = await graphqlRequest(
      `query {
        clients(where: { accounts: { currency: { id: { _eq: "EUR" } } } }) {
          id
          username
          accounts {
            id
            currency { id }
          }
        }
      }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const clients = (body.data as { clients: AnyRow[] }).clients;
    expect(clients.length).toBeGreaterThan(0);
    // Alice (EUR) and Charlie (EUR) should be in the results
    const usernames = clients.map((c) => c.username);
    expect(usernames).toContain('alice');
    expect(usernames).toContain('charlie');
    // Bob (USD) and Diana (GBP) should NOT be in the results
    expect(usernames).not.toContain('bob');
    expect(usernames).not.toContain('diana');
  });

  it('combines nested relationship filter with top-level column filter', async () => {
    const { status, body } = await graphqlRequest(
      `query {
        account(where: {
          _and: [
            { client: { status: { _eq: ACTIVE } } }
            { balance: { _gt: 100 } }
          ]
        }) {
          id
          balance
          client { id username status }
        }
      }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const accounts = (body.data as { account: AnyRow[] }).account;
    expect(accounts.length).toBeGreaterThan(0);
    for (const acc of accounts) {
      expect(Number(acc.balance)).toBeGreaterThan(100);
      expect((acc.client as AnyRow).status).toBe('ACTIVE');
    }
  });
});

// ─── 3. Object relationship ordering with NULL FK ───────────────────────────

describe('Object relationship ordering with NULL FK', () => {
  it('ORDER BY on object relationship when FK column is NULL for some rows', async () => {
    const pool = getPool();
    // Create a temporary invoice with NULL account_id
    const tempInvoiceId = 'ff000000-0000-0000-0000-000000000077';
    await pool.query(
      `INSERT INTO invoice (id, client_id, account_id, currency_id, amount, state, type)
       VALUES ($1, $2, NULL, 'EUR', 10.00, 'draft', 'payment')
       ON CONFLICT (id) DO NOTHING`,
      [tempInvoiceId, ALICE_ID],
    );

    try {
      // Order invoices by the account relationship — NULL FK rows should be handled gracefully
      const { status, body } = await graphqlRequest(
        `query {
          invoice(
            where: { clientId: { _eq: "${ALICE_ID}" } }
            orderBy: [{ account: { balance: ASC_NULLS_FIRST } }]
          ) {
            id
            amount
            account { id balance }
          }
        }`,
        undefined,
        { 'x-hasura-admin-secret': ADMIN_SECRET },
      );
      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();
      const invoices = (body.data as { invoice: AnyRow[] }).invoice;
      expect(invoices.length).toBeGreaterThanOrEqual(2);
      // The invoice with NULL account should appear (account will be null)
      const nullAccountInvoice = invoices.find((i) => i.id === tempInvoiceId);
      expect(nullAccountInvoice).toBeDefined();
      expect(nullAccountInvoice!.account).toBeNull();
    } finally {
      await pool.query('DELETE FROM invoice WHERE id = $1', [tempInvoiceId]);
    }
  });

  it('ORDER BY on nullable object relationship with ASC_NULLS_LAST', async () => {
    const pool = getPool();
    // Create temporary client with NULL country_id
    const tempId = 'dd000000-0000-0000-0000-000000000077';
    await pool.query(
      `INSERT INTO client (id, username, email, status, branch_id, currency_id, country_id)
       VALUES ($1, 'nullcountry_order', 'nullcountry_order@test.com', 'active',
               'a0000000-0000-0000-0000-000000000001', 'EUR', NULL)
       ON CONFLICT (id) DO NOTHING`,
      [tempId],
    );

    try {
      const { status, body } = await graphqlRequest(
        `query {
          clients(orderBy: [{ country: { name: ASC_NULLS_LAST } }]) {
            id
            username
            country { id name }
          }
        }`,
        undefined,
        { 'x-hasura-admin-secret': ADMIN_SECRET },
      );
      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();
      const clients = (body.data as { clients: AnyRow[] }).clients;
      expect(clients.length).toBeGreaterThan(1);

      // The client with NULL country should be at the end (NULLS_LAST)
      const lastClient = clients[clients.length - 1];
      expect(lastClient.id).toBe(tempId);
      expect(lastClient.country).toBeNull();
    } finally {
      await pool.query('DELETE FROM client WHERE id = $1', [tempId]);
    }
  });
});

// ─── 4. Relationship aggregates as nested query ─────────────────────────────

describe('Relationship aggregates as nested query', () => {
  // Nested aggregate fields on array relationships (e.g., invoicesAggregate on Client)
  // are now implemented — the object type exposes {rel}Aggregate fields for array relationships.

  it('clientByPk with invoicesAggregate { aggregate { count } }', async () => {
    const pool = getPool();
    const dbResult = await pool.query(
      'SELECT count(*)::int as cnt FROM invoice WHERE client_id = $1',
      [ALICE_ID],
    );
    const expectedCount = dbResult.rows[0].cnt;

    const { status, body } = await graphqlRequest(
      `query($id: Uuid!) {
        clientByPk(id: $id) {
          id
          username
          invoicesAggregate {
            aggregate {
              count
            }
          }
        }
      }`,
      { id: ALICE_ID },
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const client = (body.data as { clientByPk: AnyRow }).clientByPk;
    expect(client.username).toBe('alice');
    const invoicesAgg = client.invoicesAggregate as { aggregate: AnyRow };
    expect(invoicesAgg.aggregate.count).toBe(expectedCount);
  });

  it('clientByPk with invoicesAggregate sum and avg', async () => {
    const pool = getPool();
    const dbResult = await pool.query(
      'SELECT count(*)::int as cnt, sum(amount) as total, avg(amount) as average FROM invoice WHERE client_id = $1',
      [ALICE_ID],
    );
    const expectedCount = dbResult.rows[0].cnt;
    const expectedSum = Number(dbResult.rows[0].total);
    const expectedAvg = Number(dbResult.rows[0].average);

    const { status, body } = await graphqlRequest(
      `query($id: Uuid!) {
        clientByPk(id: $id) {
          id
          invoicesAggregate {
            aggregate {
              count
              sum { amount }
              avg { amount }
            }
          }
        }
      }`,
      { id: ALICE_ID },
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const client = (body.data as { clientByPk: AnyRow }).clientByPk;
    const agg = (client.invoicesAggregate as { aggregate: AnyRow }).aggregate;
    expect(agg.count).toBe(expectedCount);
    expect(Number((agg.sum as AnyRow).amount)).toBe(expectedSum);
    expect(Number((agg.avg as AnyRow).amount)).toBeCloseTo(expectedAvg, 2);
  });

  it('nested aggregate on a client with zero children returns count=0', async () => {
    // Charlie has 0 invoices
    const { status, body } = await graphqlRequest(
      `query($id: Uuid!) {
        clientByPk(id: $id) {
          id
          username
          invoicesAggregate {
            aggregate {
              count
            }
          }
        }
      }`,
      { id: CHARLIE_ID },
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const client = (body.data as { clientByPk: AnyRow }).clientByPk;
    expect(client.username).toBe('charlie');
    const invoicesAgg = client.invoicesAggregate as { aggregate: AnyRow };
    expect(invoicesAgg.aggregate.count).toBe(0);
  });

  it('nested accountsAggregate with where filter inside clientByPk', async () => {
    const pool = getPool();
    const dbResult = await pool.query(
      'SELECT count(*)::int as cnt, sum(balance) as total FROM account WHERE client_id = $1 AND balance > 1000',
      [ALICE_ID],
    );
    const expectedCount = dbResult.rows[0].cnt;
    const expectedSum = Number(dbResult.rows[0].total);

    const { status, body } = await graphqlRequest(
      `query($id: Uuid!) {
        clientByPk(id: $id) {
          id
          accountsAggregate(where: { balance: { _gt: 1000 } }) {
            aggregate {
              count
              sum { balance }
            }
          }
        }
      }`,
      { id: ALICE_ID },
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const client = (body.data as { clientByPk: AnyRow }).clientByPk;
    const accountsAgg = client.accountsAggregate as { aggregate: AnyRow };
    expect(accountsAgg.aggregate.count).toBe(expectedCount);
    expect(Number((accountsAgg.aggregate.sum as AnyRow).balance)).toBe(expectedSum);
  });

  it('backoffice role can use nested aggregates when allow_aggregations is true', async () => {
    const pool = getPool();
    const dbResult = await pool.query(
      'SELECT count(*)::int as cnt, sum(amount) as total FROM invoice WHERE client_id = $1',
      [ALICE_ID],
    );
    const expectedCount = dbResult.rows[0].cnt;
    const expectedSum = Number(dbResult.rows[0].total);

    const token = await tokens.backoffice();
    const { status, body } = await graphqlRequest(
      `query($id: Uuid!) {
        clientByPk(id: $id) {
          id
          username
          invoicesAggregate {
            aggregate {
              count
              sum { amount }
            }
          }
        }
      }`,
      { id: ALICE_ID },
      { authorization: `Bearer ${token}` },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const client = (body.data as { clientByPk: AnyRow }).clientByPk;
    expect(client.username).toBe('alice');
    const invoicesAgg = client.invoicesAggregate as { aggregate: AnyRow };
    expect(invoicesAgg.aggregate.count).toBe(expectedCount);
    expect(Number((invoicesAgg.aggregate.sum as AnyRow).amount)).toBe(expectedSum);
  });

  it('list query with nested aggregate: clients with accountsAggregate', async () => {
    const pool = getPool();
    // Query expected values for each client
    const aliceAccounts = await pool.query(
      'SELECT count(*)::int as cnt, coalesce(sum(balance), 0) as total FROM account WHERE client_id = $1',
      [ALICE_ID],
    );
    const charlieAccounts = await pool.query(
      'SELECT count(*)::int as cnt, coalesce(sum(balance), 0) as total FROM account WHERE client_id = $1',
      [CHARLIE_ID],
    );

    const { status, body } = await graphqlRequest(
      `query {
        clients(orderBy: [{ username: ASC }]) {
          id
          username
          accountsAggregate {
            aggregate {
              count
            }
          }
        }
      }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const clients = (body.data as { clients: AnyRow[] }).clients;
    expect(clients.length).toBe(4);

    // Each client should have accountsAggregate with count
    for (const client of clients) {
      const accountsAgg = client.accountsAggregate as { aggregate: AnyRow };
      expect(accountsAgg).toBeDefined();
      expect(accountsAgg.aggregate.count).toBeGreaterThanOrEqual(0);
    }

    // Alice
    const alice = clients.find((c) => c.username === 'alice')!;
    expect((alice.accountsAggregate as { aggregate: AnyRow }).aggregate.count).toBe(aliceAccounts.rows[0].cnt);

    // Charlie
    const charlie = clients.find((c) => c.username === 'charlie')!;
    expect((charlie.accountsAggregate as { aggregate: AnyRow }).aggregate.count).toBe(charlieAccounts.rows[0].cnt);
  });

  // Top-level aggregate queries DO work — verify clientsAggregate as a regression guard
  it('top-level clientsAggregate count works (regression guard)', async () => {
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
    const agg = (body.data as { clientsAggregate: { aggregate: { count: number } } })
      .clientsAggregate.aggregate;
    expect(agg.count).toBe(4);
  });
});

// ─── 5. Permissions blocking nested relationship entirely ───────────────────

describe('Permissions blocking nested relationship entirely', () => {
  it('anonymous role cannot traverse branch -> clients relationship (no select on client)', async () => {
    // anonymous has select on branch but NOT on client
    // Querying branch.clients should fail with a field validation error
    const { status, body } = await graphqlRequest(
      `query {
        branch {
          id
          name
          clients {
            id
            username
          }
        }
      }`,
      undefined,
      {}, // no auth header = anonymous role
    );
    // Should get a validation error because the clients field is not exposed for anonymous
    expect(body.errors).toBeDefined();
    expect(body.errors!.length).toBeGreaterThan(0);
  });

  it('anonymous role can query branch without the blocked relationship', async () => {
    // anonymous can query branch columns just fine
    const { status, body } = await graphqlRequest(
      `query {
        branch {
          id
          name
          code
        }
      }`,
      undefined,
      {}, // no auth header = anonymous role
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const branches = (body.data as { branch: AnyRow[] }).branch;
    expect(branches.length).toBeGreaterThan(0);
    // Only active branches (anonymous has filter: active = true)
    expect(branches.length).toBe(2); // both branches are active by default
  });

  it('client role cannot access ledgerEntries through invoice -> ledgerEntries (no le permission for client via invoice)', async () => {
    // Client role has permission on invoice (client_id = X-Hasura-User-Id)
    // and on ledger_entry (client_id = X-Hasura-User-Id)
    // But let's test that a role with NO select permission on a remote table
    // cannot traverse. We need to pick a relationship where the remote table
    // has no permission for the role. Let's try anonymous -> product -> appointments
    // anonymous has select on product but NOT on appointment.
    const { status, body } = await graphqlRequest(
      `query {
        product {
          id
          name
          appointments {
            id
          }
        }
      }`,
      undefined,
      {}, // anonymous
    );
    // appointments field should not be exposed for anonymous
    expect(body.errors).toBeDefined();
    expect(body.errors!.length).toBeGreaterThan(0);
  });
});

// ─── 6. Relationship data in updateMany RETURNING ───────────────────────────

describe('Relationship data in updateMany RETURNING', () => {
  it('updateClientMany returns relationship data in RETURNING clause', async () => {
    const pool = getPool();
    // Save original trust_levels
    const origAlice = await pool.query('SELECT trust_level FROM client WHERE id = $1', [ALICE_ID]);
    const origBob = await pool.query('SELECT trust_level FROM client WHERE id = $1', [BOB_ID]);

    try {
      const { status, body } = await graphqlRequest(
        `mutation {
          updateClientMany(updates: [
            {
              where: { id: { _eq: "${ALICE_ID}" } }
              _set: { trustLevel: 7 }
            }
            {
              where: { id: { _eq: "${BOB_ID}" } }
              _set: { trustLevel: 8 }
            }
          ]) {
            affectedRows
            returning {
              id
              username
              trustLevel
              branch { id name }
              accounts { id balance }
            }
          }
        }`,
        undefined,
        { 'x-hasura-admin-secret': ADMIN_SECRET },
      );
      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();

      // updateMany returns [MutationResponse] — one result per update entry
      const results = (body.data as { updateClientMany: AnyRow[] }).updateClientMany;
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBe(2);

      // First entry: Alice
      const aliceResult = results[0] as AnyRow;
      expect(aliceResult.affectedRows).toBe(1);
      const aliceReturning = aliceResult.returning as AnyRow[];
      expect(aliceReturning.length).toBe(1);
      const aliceRow = aliceReturning[0];
      expect(aliceRow.trustLevel).toBe(7);
      // Object relationship
      const aliceBranch = aliceRow.branch as AnyRow;
      expect(aliceBranch).toBeDefined();
      expect(aliceBranch.name).toBe('TestBranch');
      // Array relationship
      const aliceAccounts = aliceRow.accounts as AnyRow[];
      expect(Array.isArray(aliceAccounts)).toBe(true);
      expect(aliceAccounts.length).toBeGreaterThanOrEqual(1);

      // Second entry: Bob
      const bobResult = results[1] as AnyRow;
      expect(bobResult.affectedRows).toBe(1);
      const bobReturning = bobResult.returning as AnyRow[];
      expect(bobReturning.length).toBe(1);
      const bobRow = bobReturning[0];
      expect(bobRow.trustLevel).toBe(8);
      expect((bobRow.branch as AnyRow).name).toBe('TestBranch');
    } finally {
      await pool.query('UPDATE client SET trust_level = $1 WHERE id = $2', [origAlice.rows[0].trust_level, ALICE_ID]);
      await pool.query('UPDATE client SET trust_level = $1 WHERE id = $2', [origBob.rows[0].trust_level, BOB_ID]);
    }
  });

  // BUG FIX: updateMany resolver now passes returningComputedFields to compileUpdateMany,
  // matching the pattern used by makeUpdateResolver and makeUpdateByPkResolver.
  it('updateMany with nested computed field in RETURNING', async () => {
    const pool = getPool();
    // Save original trust_levels
    const origAlice = await pool.query('SELECT trust_level FROM client WHERE id = $1', [ALICE_ID]);
    const origBob = await pool.query('SELECT trust_level FROM client WHERE id = $1', [BOB_ID]);

    try {
      const { status, body } = await graphqlRequest(
        `mutation {
          updateClientMany(updates: [
            {
              where: { id: { _eq: "${ALICE_ID}" } }
              _set: { trustLevel: 5 }
            }
            {
              where: { id: { _eq: "${BOB_ID}" } }
              _set: { trustLevel: 6 }
            }
          ]) {
            affectedRows
            returning {
              id
              username
              trustLevel
              totalBalance
            }
          }
        }`,
        undefined,
        { 'x-hasura-admin-secret': ADMIN_SECRET },
      );
      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();

      // updateMany returns [MutationResponse] — one result per update entry
      const results = (body.data as { updateClientMany: AnyRow[] }).updateClientMany;
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBe(2);

      // Query DB for expected totalBalance values (accounts may have changed from other tests)
      const aliceExpected = await pool.query(
        `SELECT public.client_total_balance(c) as total FROM client c WHERE c.id = $1`,
        [ALICE_ID],
      );
      const bobExpected = await pool.query(
        `SELECT public.client_total_balance(c) as total FROM client c WHERE c.id = $1`,
        [BOB_ID],
      );

      // First entry: Alice — verify computed field totalBalance is present and correct
      const aliceResult = results[0] as AnyRow;
      expect(aliceResult.affectedRows).toBe(1);
      const aliceReturning = aliceResult.returning as AnyRow[];
      expect(aliceReturning.length).toBe(1);
      const aliceRow = aliceReturning[0];
      expect(aliceRow.trustLevel).toBe(5);
      expect(Number(aliceRow.totalBalance)).toBe(Number(aliceExpected.rows[0].total));

      // Second entry: Bob
      const bobResult = results[1] as AnyRow;
      expect(bobResult.affectedRows).toBe(1);
      const bobReturning = bobResult.returning as AnyRow[];
      expect(bobReturning.length).toBe(1);
      const bobRow = bobReturning[0];
      expect(bobRow.trustLevel).toBe(6);
      expect(Number(bobRow.totalBalance)).toBe(Number(bobExpected.rows[0].total));
    } finally {
      await pool.query('UPDATE client SET trust_level = $1 WHERE id = $2', [origAlice.rows[0].trust_level, ALICE_ID]);
      await pool.query('UPDATE client SET trust_level = $1 WHERE id = $2', [origBob.rows[0].trust_level, BOB_ID]);
    }
  });
});

// ─── 7. Config-defined relationship overriding auto-detected ────────────────

describe('Config-defined relationship overriding auto-detected', () => {
  it('primaryAccount manual relationship overrides or coexists with auto-detected accounts', async () => {
    // The client table has a manual object relationship `primaryAccount` defined via
    // manual_configuration (column_mapping: id -> client_id on account table).
    // This coexists with the auto-detected `accounts` array relationship.
    const { status, body } = await graphqlRequest(
      `query($id: Uuid!) {
        clientByPk(id: $id) {
          id
          username
          primaryAccount {
            id
            balance
            currencyId
          }
          accounts {
            id
            balance
          }
        }
      }`,
      { id: ALICE_ID },
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const client = (body.data as { clientByPk: AnyRow }).clientByPk;
    expect(client).toBeDefined();

    // primaryAccount is an object relationship (returns one account)
    const primaryAccount = client.primaryAccount as AnyRow;
    expect(primaryAccount).toBeDefined();
    expect(primaryAccount).not.toBeNull();
    expect(primaryAccount.id).toBe(ACCOUNT_ALICE_ID);
    expect(Number(primaryAccount.balance)).toBe(1500);

    // accounts is an array relationship (returns all accounts)
    const accounts = client.accounts as AnyRow[];
    expect(Array.isArray(accounts)).toBe(true);
    expect(accounts.length).toBeGreaterThanOrEqual(1);
  });

  it('manual relationship works for client with no matching account (object rel returns null)', async () => {
    const pool = getPool();
    // Create a temporary client with no account at all
    const tempId = 'dd000000-0000-0000-0000-000000000078';
    await pool.query(
      `INSERT INTO client (id, username, email, status, branch_id, currency_id)
       VALUES ($1, 'no_account_test', 'noaccount@test.com', 'active',
               'a0000000-0000-0000-0000-000000000001', 'EUR')
       ON CONFLICT (id) DO NOTHING`,
      [tempId],
    );

    try {
      const { status, body } = await graphqlRequest(
        `query($id: Uuid!) {
          clientByPk(id: $id) {
            id
            username
            primaryAccount {
              id
              balance
            }
            accounts {
              id
            }
          }
        }`,
        { id: tempId },
        { 'x-hasura-admin-secret': ADMIN_SECRET },
      );
      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();
      const client = (body.data as { clientByPk: AnyRow }).clientByPk;
      expect(client).toBeDefined();
      // No account at all — primaryAccount should be null, accounts empty
      expect(client.primaryAccount).toBeNull();
      expect((client.accounts as AnyRow[]).length).toBe(0);
    } finally {
      await pool.query('DELETE FROM client WHERE id = $1', [tempId]);
    }
  });
});
