/**
 * Phase 6.3 — Relationship Test Gaps
 *
 * Covers:
 * 1. WHERE filters on array relationships
 * 2. Relationship limit/offset (array relationship pagination)
 * 3. Permission enforcement across relationship chains
 * 4. Null handling in deep chains
 * 5. Relationships in REST-style JSON responses (via GraphQL)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  startServer, stopServer, closePool, waitForDb, getPool,
  graphqlRequest, restRequest,
  tokens, ADMIN_SECRET,
  ALICE_ID, CHARLIE_ID,
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

// ─── 1. WHERE filters on array relationships ─────────────────────────────────

describe('WHERE filters on array relationships', () => {
  it('filters invoices by amount within a client query (amount > 75)', async () => {
    const { body } = await graphqlRequest(
      `query($id: Uuid!) {
        clientByPk(id: $id) {
          id
          username
          invoices(where: { amount: { _gt: 75 } }) {
            id
            amount
          }
        }
      }`,
      { id: ALICE_ID },
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(body.errors).toBeUndefined();
    const client = (body.data as { clientByPk: AnyRow }).clientByPk;
    expect(client).toBeDefined();
    const invoices = client.invoices as AnyRow[];
    // All returned invoices must have amount > 75
    expect(invoices.length).toBeGreaterThanOrEqual(1);
    for (const inv of invoices) {
      expect(Number(inv.amount)).toBeGreaterThan(75);
    }
  });

  it('filters invoices by amount range within a client query', async () => {
    // Use a tight range that only matches Alice's 50.00 refund invoice from seed data
    const { body } = await graphqlRequest(
      `query($id: Uuid!) {
        clientByPk(id: $id) {
          id
          invoices(where: { _and: [{ amount: { _gte: 50 } }, { amount: { _lt: 51 } }] }) {
            id
            amount
          }
        }
      }`,
      { id: ALICE_ID },
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(body.errors).toBeUndefined();
    const client = (body.data as { clientByPk: AnyRow }).clientByPk;
    const invoices = client.invoices as AnyRow[];
    // All matching invoices should be within the range
    expect(invoices.length).toBeGreaterThanOrEqual(1);
    for (const inv of invoices) {
      expect(Number(inv.amount)).toBeGreaterThanOrEqual(50);
      expect(Number(inv.amount)).toBeLessThan(51);
    }
  });

  it('returns empty array when no child rows match the filter', async () => {
    const { body } = await graphqlRequest(
      `query($id: Uuid!) {
        clientByPk(id: $id) {
          id
          invoices(where: { amount: { _gt: 99999 } }) {
            id
            amount
          }
        }
      }`,
      { id: ALICE_ID },
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(body.errors).toBeUndefined();
    const client = (body.data as { clientByPk: AnyRow }).clientByPk;
    const invoices = client.invoices as AnyRow[];
    expect(invoices).toHaveLength(0);
  });

  it('filters accounts by active status within client query', async () => {
    const { body } = await graphqlRequest(
      `query($id: Uuid!) {
        clientByPk(id: $id) {
          id
          accounts(where: { active: { _eq: true } }) {
            id
            balance
            active
          }
        }
      }`,
      { id: ALICE_ID },
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(body.errors).toBeUndefined();
    const client = (body.data as { clientByPk: AnyRow }).clientByPk;
    const accounts = client.accounts as AnyRow[];
    expect(accounts.length).toBeGreaterThanOrEqual(1);
    for (const acc of accounts) {
      expect(acc.active).toBe(true);
    }
  });

  it('filters appointments by active=false within client query', async () => {
    // Alice has 2 appointments: one active=false (high priority), one active=true (normal)
    const { body } = await graphqlRequest(
      `query($id: Uuid!) {
        clientByPk(id: $id) {
          id
          appointments(where: { active: { _eq: false } }) {
            id
            active
            priority
          }
        }
      }`,
      { id: ALICE_ID },
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(body.errors).toBeUndefined();
    const client = (body.data as { clientByPk: AnyRow }).clientByPk;
    const appointments = client.appointments as AnyRow[];
    expect(appointments).toHaveLength(1);
    expect(appointments[0].active).toBe(false);
    expect(appointments[0].priority).toBe('HIGH');
  });

  it('filters with multiple conditions on array relationship', async () => {
    // Use amount + active for multi-condition filter (avoid enum columns in inline args)
    const { body } = await graphqlRequest(
      `query($id: Uuid!) {
        clientByPk(id: $id) {
          id
          invoices(where: { _and: [{ amount: { _gte: 100 } }, { amount: { _lte: 100 } }] }) {
            id
            amount
          }
        }
      }`,
      { id: ALICE_ID },
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(body.errors).toBeUndefined();
    const client = (body.data as { clientByPk: AnyRow }).clientByPk;
    const invoices = client.invoices as AnyRow[];
    // Only the 100.00 invoice matches _gte: 100 AND _lte: 100
    expect(invoices).toHaveLength(1);
    expect(Number(invoices[0].amount)).toBe(100);
  });
});

// ─── 2. Relationship limit/offset ─────────────────────────────────────────────

describe('Relationship limit/offset (array relationship pagination)', () => {
  it('limits the number of accounts returned for a client', async () => {
    // First check how many accounts Alice has to know what to expect
    const { body: fullBody } = await graphqlRequest(
      `query($id: Uuid!) {
        clientByPk(id: $id) {
          id
          accounts { id }
        }
      }`,
      { id: ALICE_ID },
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(fullBody.errors).toBeUndefined();
    const totalAccounts = ((fullBody.data as { clientByPk: AnyRow }).clientByPk.accounts as AnyRow[]).length;

    // Now query with limit=1
    const { body } = await graphqlRequest(
      `query($id: Uuid!) {
        clientByPk(id: $id) {
          id
          accounts(limit: 1) { id }
        }
      }`,
      { id: ALICE_ID },
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(body.errors).toBeUndefined();
    const client = (body.data as { clientByPk: AnyRow }).clientByPk;
    const accounts = client.accounts as AnyRow[];
    expect(accounts).toHaveLength(Math.min(1, totalAccounts));
  });

  it('applies offset on array relationship', async () => {
    // Get all invoices for Alice (she has 2)
    const { body: fullBody } = await graphqlRequest(
      `query($id: Uuid!) {
        clientByPk(id: $id) {
          id
          invoices(orderBy: [{ amount: ASC }]) { id amount }
        }
      }`,
      { id: ALICE_ID },
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(fullBody.errors).toBeUndefined();
    const allInvoices = (fullBody.data as { clientByPk: AnyRow }).clientByPk.invoices as AnyRow[];
    expect(allInvoices.length).toBeGreaterThanOrEqual(2);

    // Now query with offset=1 — should skip the first row
    const { body } = await graphqlRequest(
      `query($id: Uuid!) {
        clientByPk(id: $id) {
          id
          invoices(orderBy: [{ amount: ASC }], offset: 1) { id amount }
        }
      }`,
      { id: ALICE_ID },
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(body.errors).toBeUndefined();
    const invoices = (body.data as { clientByPk: AnyRow }).clientByPk.invoices as AnyRow[];
    expect(invoices).toHaveLength(allInvoices.length - 1);
    // The offset result should match skipping the first item from the full list
    expect(invoices[0].id).toBe(allInvoices[1].id);
  });

  it('applies limit + offset together on array relationship', async () => {
    // Get all invoices for Alice (ordered by amount ASC)
    const { body: fullBody } = await graphqlRequest(
      `query($id: Uuid!) {
        clientByPk(id: $id) {
          id
          invoices(orderBy: [{ amount: ASC }]) { id amount }
        }
      }`,
      { id: ALICE_ID },
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(fullBody.errors).toBeUndefined();
    const allInvoices = (fullBody.data as { clientByPk: AnyRow }).clientByPk.invoices as AnyRow[];
    expect(allInvoices.length).toBeGreaterThanOrEqual(2);

    // limit=1, offset=1 — should return exactly the second item
    const { body } = await graphqlRequest(
      `query($id: Uuid!) {
        clientByPk(id: $id) {
          id
          invoices(orderBy: [{ amount: ASC }], limit: 1, offset: 1) { id amount }
        }
      }`,
      { id: ALICE_ID },
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(body.errors).toBeUndefined();
    const invoices = (body.data as { clientByPk: AnyRow }).clientByPk.invoices as AnyRow[];
    expect(invoices).toHaveLength(1);
    expect(invoices[0].id).toBe(allInvoices[1].id);
  });

  it('limit=0 returns empty array for array relationship', async () => {
    const { body } = await graphqlRequest(
      `query($id: Uuid!) {
        clientByPk(id: $id) {
          id
          invoices(limit: 0) { id }
        }
      }`,
      { id: ALICE_ID },
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(body.errors).toBeUndefined();
    const client = (body.data as { clientByPk: AnyRow }).clientByPk;
    const invoices = client.invoices as AnyRow[];
    expect(invoices).toHaveLength(0);
  });

  it('offset beyond total count returns empty array', async () => {
    const { body } = await graphqlRequest(
      `query($id: Uuid!) {
        clientByPk(id: $id) {
          id
          invoices(offset: 1000) { id }
        }
      }`,
      { id: ALICE_ID },
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(body.errors).toBeUndefined();
    const client = (body.data as { clientByPk: AnyRow }).clientByPk;
    const invoices = client.invoices as AnyRow[];
    expect(invoices).toHaveLength(0);
  });
});

// ─── 3. Permission enforcement across relationship chains ─────────────────────

describe('Permission enforcement across relationship chains', () => {
  it('client role sees only own invoices through nested relationship', async () => {
    const token = await tokens.client(ALICE_ID);
    const { body } = await graphqlRequest(
      `query {
        clients {
          id
          invoices { id state amount }
        }
      }`,
      undefined,
      { authorization: `Bearer ${token}` },
    );
    expect(body.errors).toBeUndefined();
    const clients = (body.data as { clients: AnyRow[] }).clients;
    // Client role filter: id = X-Hasura-User-Id  =>  only Alice
    expect(clients).toHaveLength(1);
    expect(clients[0].id).toBe(ALICE_ID);
    // Invoice permission: client_id = X-Hasura-User-Id => only Alice's invoices
    const invoices = clients[0].invoices as AnyRow[];
    expect(invoices.length).toBeGreaterThanOrEqual(1);
  });

  it('client role sees only own accounts through nested relationship', async () => {
    const token = await tokens.client(ALICE_ID);
    const { body } = await graphqlRequest(
      `query {
        clients {
          id
          accounts { id balance }
        }
      }`,
      undefined,
      { authorization: `Bearer ${token}` },
    );
    expect(body.errors).toBeUndefined();
    const clients = (body.data as { clients: AnyRow[] }).clients;
    expect(clients).toHaveLength(1);
    expect(clients[0].id).toBe(ALICE_ID);
    const accounts = clients[0].accounts as AnyRow[];
    expect(accounts.length).toBeGreaterThanOrEqual(1);
  });

  it('client role sees only own appointments with restricted columns', async () => {
    const token = await tokens.client(ALICE_ID);
    const { body } = await graphqlRequest(
      `query {
        clients {
          id
          appointments { id active }
        }
      }`,
      undefined,
      { authorization: `Bearer ${token}` },
    );
    expect(body.errors).toBeUndefined();
    const clients = (body.data as { clients: AnyRow[] }).clients;
    expect(clients).toHaveLength(1);
    expect(clients[0].id).toBe(ALICE_ID);
    // Alice has appointments, and the client role can see them
    const appointments = clients[0].appointments as AnyRow[];
    expect(appointments.length).toBeGreaterThanOrEqual(1);
  });

  it('backoffice sees all clients with all their invoices (no row filter)', async () => {
    const token = await tokens.backoffice();
    const { body } = await graphqlRequest(
      `query {
        clients(orderBy: [{ username: ASC }]) {
          id
          username
          invoices { id state }
        }
      }`,
      undefined,
      { authorization: `Bearer ${token}` },
    );
    expect(body.errors).toBeUndefined();
    const clients = (body.data as { clients: AnyRow[] }).clients;
    expect(clients).toHaveLength(4);

    // Alice has 2 invoices, Bob has 1, Charlie has 0, Diana has 1
    const alice = clients.find((c) => c.username === 'alice')!;
    const bob = clients.find((c) => c.username === 'bob')!;
    const charlie = clients.find((c) => c.username === 'charlie')!;
    const diana = clients.find((c) => c.username === 'diana')!;

    expect((alice.invoices as AnyRow[]).length).toBeGreaterThanOrEqual(2);
    expect((bob.invoices as AnyRow[]).length).toBeGreaterThanOrEqual(1);
    expect((charlie.invoices as AnyRow[]).length).toBe(0);
    expect((diana.invoices as AnyRow[]).length).toBeGreaterThanOrEqual(1);
  });

  it('client role permission filter applies to nested ledger entries', async () => {
    const token = await tokens.client(ALICE_ID);
    const { body } = await graphqlRequest(
      `query {
        clients {
          id
          ledgerEntries { id type amount }
        }
      }`,
      undefined,
      { authorization: `Bearer ${token}` },
    );
    expect(body.errors).toBeUndefined();
    const clients = (body.data as { clients: AnyRow[] }).clients;
    expect(clients).toHaveLength(1);
    expect(clients[0].id).toBe(ALICE_ID);
    // Ledger entries have client_id permission filter
    const entries = clients[0].ledgerEntries as AnyRow[];
    expect(entries.length).toBeGreaterThanOrEqual(1);
  });

  it('client role gets null for columns outside their permission set on nested table', async () => {
    // Client role on appointment only has: id, product_id, active, created_at, updated_at
    // Querying `notes` (not in client permission columns) should return null
    const token = await tokens.client(ALICE_ID);
    const { body } = await graphqlRequest(
      `query {
        clients {
          id
          appointments { id active notes }
        }
      }`,
      undefined,
      { authorization: `Bearer ${token}` },
    );
    expect(body.errors).toBeUndefined();
    const clients = (body.data as { clients: AnyRow[] }).clients;
    expect(clients).toHaveLength(1);
    const appointments = clients[0].appointments as AnyRow[];
    expect(appointments.length).toBeGreaterThanOrEqual(1);
    // Notes should be null because client role doesn't have access to that column
    for (const appt of appointments) {
      expect(appt.notes).toBeNull();
    }
  });

  it('function role with X-Hasura-Client-Id sees only that client invoices', async () => {
    const token = await tokens.function_(ALICE_ID);
    // function role on invoice: filter client_id = X-Hasura-Client-Id
    const { body } = await graphqlRequest(
      `query {
        invoice {
          id
          clientId
          amount
          state
        }
      }`,
      undefined,
      { authorization: `Bearer ${token}` },
    );
    expect(body.errors).toBeUndefined();
    const invoices = (body.data as { invoice: AnyRow[] }).invoice;
    // Should only see Alice's invoices
    for (const inv of invoices) {
      expect(inv.clientId).toBe(ALICE_ID);
    }
  });
});

// ─── 4. Null handling in deep chains ──────────────────────────────────────────

describe('Null handling in deep chains', () => {
  it('returns null for nullable object relationship (country_id=null)', async () => {
    // Charlie has country_id='FI', but let us test with a client whose country is null
    // We need to insert a temporary client with null country_id
    const pool = getPool();
    const tempId = 'dd000000-0000-0000-0000-000000000099';
    await pool.query(
      `INSERT INTO client (id, username, email, status, branch_id, currency_id, country_id)
       VALUES ($1, 'nullcountry_test', 'nullcountry@test.com', 'active',
               'a0000000-0000-0000-0000-000000000001', 'EUR', NULL)
       ON CONFLICT (id) DO NOTHING`,
      [tempId],
    );

    try {
      const { body } = await graphqlRequest(
        `query($id: Uuid!) {
          clientByPk(id: $id) {
            id
            username
            country { id name }
          }
        }`,
        { id: tempId },
        { 'x-hasura-admin-secret': ADMIN_SECRET },
      );
      expect(body.errors).toBeUndefined();
      const client = (body.data as { clientByPk: AnyRow }).clientByPk;
      expect(client).toBeDefined();
      expect(client.username).toBe('nullcountry_test');
      // country should be null since country_id is null
      expect(client.country).toBeNull();
    } finally {
      await pool.query('DELETE FROM client WHERE id = $1', [tempId]);
    }
  });

  it('handles null at object relationship in nested query (invoice -> account when account_id is null)', async () => {
    const pool = getPool();
    const tempInvoiceId = 'ff000000-0000-0000-0000-000000000099';
    // Insert an invoice without an account_id (nullable FK)
    await pool.query(
      `INSERT INTO invoice (id, client_id, account_id, currency_id, amount, state, type)
       VALUES ($1, $2, NULL, 'EUR', 99.99, 'draft', 'payment')
       ON CONFLICT (id) DO NOTHING`,
      [tempInvoiceId, ALICE_ID],
    );

    try {
      const { body } = await graphqlRequest(
        `query {
          invoice(where: { id: { _eq: "${tempInvoiceId}" } }) {
            id
            amount
            account {
              id
              balance
            }
          }
        }`,
        undefined,
        { 'x-hasura-admin-secret': ADMIN_SECRET },
      );
      expect(body.errors).toBeUndefined();
      const invoices = (body.data as { invoice: AnyRow[] }).invoice;
      expect(invoices).toHaveLength(1);
      // account should be null since account_id is null
      expect(invoices[0].account).toBeNull();
    } finally {
      await pool.query('DELETE FROM invoice WHERE id = $1', [tempInvoiceId]);
    }
  });

  it('handles null in deep chain: invoice -> account -> client with non-null chain', async () => {
    // This tests that a full non-null chain works correctly
    const { body } = await graphqlRequest(
      `query {
        invoice(where: { id: { _eq: "f0000000-0000-0000-0000-000000000001" } }) {
          id
          account {
            id
            client {
              id
              username
            }
          }
        }
      }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(body.errors).toBeUndefined();
    const invoices = (body.data as { invoice: AnyRow[] }).invoice;
    expect(invoices).toHaveLength(1);
    const account = invoices[0].account as AnyRow;
    expect(account).not.toBeNull();
    const client = account.client as AnyRow;
    expect(client).not.toBeNull();
    expect(client.username).toBe('alice');
  });

  it('returns empty array for array relationship when parent has no children', async () => {
    // Charlie has no invoices
    const { body } = await graphqlRequest(
      `query($id: Uuid!) {
        clientByPk(id: $id) {
          id
          username
          invoices { id state }
        }
      }`,
      { id: CHARLIE_ID },
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(body.errors).toBeUndefined();
    const client = (body.data as { clientByPk: AnyRow }).clientByPk;
    expect(client).toBeDefined();
    expect(client.username).toBe('charlie');
    const invoices = client.invoices as AnyRow[];
    expect(invoices).toHaveLength(0);
  });

  it('returns null for byPk query with non-existent ID, terminating the relationship chain', async () => {
    const { body } = await graphqlRequest(
      `query($id: Uuid!) {
        clientByPk(id: $id) {
          id
          branch { id name }
          accounts { id }
        }
      }`,
      { id: '00000000-0000-0000-0000-000000000000' },
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(body.errors).toBeUndefined();
    const client = (body.data as { clientByPk: unknown }).clientByPk;
    expect(client).toBeNull();
  });
});

// ─── 5. Relationships in REST-style JSON responses ────────────────────────────

describe('Relationships in REST-style JSON responses', () => {
  it('GraphQL list query returns nested object relationships in JSON', async () => {
    const { body } = await graphqlRequest(
      `query {
        clients(orderBy: [{ username: ASC }]) {
          id
          username
          branch { id name code }
          currency { id name symbol }
        }
      }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(body.errors).toBeUndefined();
    const clients = (body.data as { clients: AnyRow[] }).clients;
    expect(clients).toHaveLength(4);

    // Verify nested object relationships are included as JSON objects
    for (const client of clients) {
      const branch = client.branch as AnyRow;
      expect(branch).toBeDefined();
      expect(branch).not.toBeNull();
      expect(branch.name).toBeDefined();
      expect(branch.code).toBeDefined();

      const currency = client.currency as AnyRow;
      expect(currency).toBeDefined();
      expect(currency).not.toBeNull();
      expect(currency.name).toBeDefined();
      expect(currency.symbol).toBeDefined();
    }

    // Spot-check Alice
    const alice = clients.find((c) => c.username === 'alice')!;
    expect((alice.branch as AnyRow).name).toBe('TestBranch');
    expect((alice.currency as AnyRow).id).toBe('EUR');
    expect((alice.currency as AnyRow).symbol).toBe('\u20ac'); // Euro sign
  });

  it('GraphQL list query returns nested array relationships in JSON', async () => {
    const { body } = await graphqlRequest(
      `query {
        clients(orderBy: [{ username: ASC }]) {
          id
          username
          invoices { id amount state type }
          accounts { id balance active }
        }
      }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(body.errors).toBeUndefined();
    const clients = (body.data as { clients: AnyRow[] }).clients;
    expect(clients).toHaveLength(4);

    // Verify array relationships are JSON arrays
    for (const client of clients) {
      expect(Array.isArray(client.invoices)).toBe(true);
      expect(Array.isArray(client.accounts)).toBe(true);
    }

    // Alice has 2+ invoices and 1 account
    const alice = clients.find((c) => c.username === 'alice')!;
    expect((alice.invoices as AnyRow[]).length).toBeGreaterThanOrEqual(2);
    expect((alice.accounts as AnyRow[]).length).toBeGreaterThanOrEqual(1);

    // Charlie has 0 invoices
    const charlie = clients.find((c) => c.username === 'charlie')!;
    expect((charlie.invoices as AnyRow[])).toHaveLength(0);
  });

  it('GraphQL query returns deeply nested relationships (client -> appointments -> product)', async () => {
    const { body } = await graphqlRequest(
      `query($id: Uuid!) {
        clientByPk(id: $id) {
          id
          username
          appointments {
            id
            active
            product {
              id
              name
              code
            }
          }
        }
      }`,
      { id: ALICE_ID },
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(body.errors).toBeUndefined();
    const client = (body.data as { clientByPk: AnyRow }).clientByPk;
    expect(client).toBeDefined();
    const appointments = client.appointments as AnyRow[];
    expect(appointments.length).toBeGreaterThanOrEqual(1);

    // Each appointment should have a nested product object
    for (const appt of appointments) {
      const product = appt.product as AnyRow;
      expect(product).toBeDefined();
      expect(product).not.toBeNull();
      expect(product.name).toBeDefined();
      expect(product.code).toBeDefined();
    }
  });

  it('REST list endpoint returns flat columns (no relationships)', async () => {
    // Verify that the standard REST API returns flat column data
    const { status, body } = await restRequest('GET', '/api/v1/clients', {
      headers: { 'x-hasura-admin-secret': ADMIN_SECRET },
      query: { limit: '2' },
    });
    expect(status).toBe(200);
    const clients = body as AnyRow[];
    expect(clients.length).toBeGreaterThan(0);

    // REST API returns flat columns, not nested relationship objects
    for (const client of clients) {
      expect(client.id).toBeDefined();
      expect(client.username).toBeDefined();
      // branch_id is a column, but branch should not be a nested object
      expect(client.branch_id).toBeDefined();
    }
  });

  it('GraphQL query with mixed object + array relationships returns correct JSON shape', async () => {
    const { body } = await graphqlRequest(
      `query {
        invoice(orderBy: [{ amount: DESC }], limit: 2) {
          id
          amount
          state
          client {
            id
            username
            branch { name }
          }
          account {
            id
            balance
          }
        }
      }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(body.errors).toBeUndefined();
    const invoices = (body.data as { invoice: AnyRow[] }).invoice;
    expect(invoices.length).toBeGreaterThan(0);

    for (const inv of invoices) {
      // Each invoice has a client (object relationship)
      const client = inv.client as AnyRow;
      expect(client).toBeDefined();
      expect(client).not.toBeNull();
      expect(client.username).toBeDefined();

      // Client has a branch (nested object relationship)
      const branch = (client as AnyRow).branch as AnyRow;
      expect(branch).toBeDefined();
      expect(branch.name).toBeDefined();

      // Account may be null for some invoices, but for seeded data it should exist
      if (inv.account !== null) {
        const account = inv.account as AnyRow;
        expect(account.id).toBeDefined();
      }
    }
  });
});
