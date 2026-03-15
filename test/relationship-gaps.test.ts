/**
 * Phase 6.3 — Relationship Test Gaps
 *
 * Covers:
 * 1. WHERE filters on array relationships
 * 2. Relationship limit/offset (array relationship pagination)
 * 3. Permission enforcement across relationship chains
 * 4. Null handling in deep chains
 * 5. Relationships in REST-style JSON responses (via GraphQL)
 * 6. Circular relationship references (P6.3e)
 * 7. Relationships in subscriptions (P6.3c)
 * 8. Self-referential relationships (P6.3a)
 * 9. Multiple FKs to same table (P6.3d)
 * 10. Composite foreign keys (P6.3b)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  startServer, stopServer, closePool, waitForDb, getPool,
  getServerAddress,
  graphqlRequest, restRequest,
  tokens, createJWT, ADMIN_SECRET,
  ALICE_ID, CHARLIE_ID,
  TEST_DB_URL,
} from './setup.js';
import { createClient } from 'graphql-ws';
import type { Client as GqlWsClient } from 'graphql-ws';
import WebSocket from 'ws';
import pg from 'pg';

const { Pool } = pg;

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

// ─── 6. Circular Relationship References (P6.3e) ─────────────────────────────

describe('Circular relationship references', () => {
  it('traverses A → B → A: invoices { client { invoices { id } } }', async () => {
    const { body } = await graphqlRequest(
      `query {
        invoice(where: { clientId: { _eq: "${ALICE_ID}" } }, limit: 2) {
          id
          amount
          client {
            id
            username
            invoices {
              id
            }
          }
        }
      }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(body.errors).toBeUndefined();
    const invoices = (body.data as { invoice: AnyRow[] }).invoice;
    expect(invoices.length).toBeGreaterThanOrEqual(1);

    for (const inv of invoices) {
      const client = inv.client as AnyRow;
      expect(client).toBeDefined();
      expect(client).not.toBeNull();
      expect(client.id).toBe(ALICE_ID);

      // The nested invoices should include ALL of Alice's invoices (circular back)
      const nestedInvoices = client.invoices as AnyRow[];
      expect(nestedInvoices.length).toBeGreaterThanOrEqual(2);
      // The original invoice should appear in the nested list
      const ids = nestedInvoices.map((ni) => ni.id);
      expect(ids).toContain(inv.id);
    }
  });

  it('traverses multiple levels: invoices { client { invoices { client { id } } } }', async () => {
    const { body } = await graphqlRequest(
      `query {
        invoice(where: { clientId: { _eq: "${ALICE_ID}" } }, limit: 1) {
          id
          client {
            id
            invoices(limit: 1) {
              id
              client {
                id
                username
              }
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

    const client = invoices[0].client as AnyRow;
    expect(client.id).toBe(ALICE_ID);

    const nestedInvoices = client.invoices as AnyRow[];
    expect(nestedInvoices).toHaveLength(1);

    // The second-level client should be the same Alice
    const deepClient = nestedInvoices[0].client as AnyRow;
    expect(deepClient).not.toBeNull();
    expect(deepClient.id).toBe(ALICE_ID);
    expect(deepClient.username).toBe('alice');
  });

  it('traverses circular via branch: clients { branch { clients { id } } }', async () => {
    const { body } = await graphqlRequest(
      `query {
        clientByPk(id: "${ALICE_ID}") {
          id
          username
          branch {
            id
            name
            clients {
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
    const client = (body.data as { clientByPk: AnyRow }).clientByPk;
    expect(client).toBeDefined();
    expect(client.id).toBe(ALICE_ID);

    const branch = client.branch as AnyRow;
    expect(branch).toBeDefined();
    expect(branch.name).toBe('TestBranch');

    // Branch's clients array should include Alice (circular back)
    const branchClients = branch.clients as AnyRow[];
    expect(branchClients.length).toBeGreaterThanOrEqual(1);
    const aliceInBranch = branchClients.find((c) => c.id === ALICE_ID);
    expect(aliceInBranch).toBeDefined();
    expect(aliceInBranch!.username).toBe('alice');
  });

  it('rejects queries that exceed the depth limit', async () => {
    // Default depth limit is 10. Build a query that exceeds it by nesting
    // invoice -> client -> invoices -> client -> invoices -> client -> invoices -> client -> invoices -> client -> invoices -> client
    // That's 12 levels of nesting (each relationship adds a level)
    const { body } = await graphqlRequest(
      `query {
        invoice(limit: 1) {
          client {
            invoices(limit: 1) {
              client {
                invoices(limit: 1) {
                  client {
                    invoices(limit: 1) {
                      client {
                        invoices(limit: 1) {
                          client {
                            id
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    // Should have a depth limit error
    expect(body.errors).toBeDefined();
    expect(body.errors!.length).toBeGreaterThanOrEqual(1);
    // Mercurius returns a depth-related error message
    const errorMsg = body.errors![0].message.toLowerCase();
    expect(errorMsg).toMatch(/depth/);
  });

  it('allows moderate depth (depth 8) within the limit', async () => {
    // 4 round-trips through invoice->client is 8 object levels, within the default limit of 10
    const { body } = await graphqlRequest(
      `query {
        invoice(where: { clientId: { _eq: "${ALICE_ID}" } }, limit: 1) {
          client {
            invoices(limit: 1) {
              client {
                invoices(limit: 1) {
                  client {
                    invoices(limit: 1) {
                      id
                    }
                  }
                }
              }
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

    // Navigate through the chain and verify the deepest level returns data
    const c1 = invoices[0].client as AnyRow;
    expect(c1).toBeDefined();
    const inv2 = (c1.invoices as AnyRow[])[0];
    expect(inv2).toBeDefined();
    const c2 = inv2.client as AnyRow;
    expect(c2).toBeDefined();
    const inv3 = (c2.invoices as AnyRow[])[0];
    expect(inv3).toBeDefined();
    const c3 = inv3.client as AnyRow;
    expect(c3).toBeDefined();
    const deepInvoices = c3.invoices as AnyRow[];
    expect(deepInvoices).toHaveLength(1);
    expect(deepInvoices[0].id).toBeDefined();
  });
});

// ─── 8. Self-Referential Relationships (P6.3a) ──────────────────────────────

describe('Self-referential relationships (category)', () => {
  const CATEGORY_ROOT = 'ca000000-0000-0000-0000-000000000001';      // Funeral Services
  const CATEGORY_TRADITIONAL = 'ca000000-0000-0000-0000-000000000002'; // Traditional
  const CATEGORY_CREMATION = 'ca000000-0000-0000-0000-000000000003';   // Cremation
  const CATEGORY_FULL_CREM = 'ca000000-0000-0000-0000-000000000004';   // Full Service Cremation

  it('object relationship: child category resolves parent { name }', async () => {
    const { body } = await graphqlRequest(
      `query($id: Uuid!) {
        categoryByPk(id: $id) {
          id
          name
          parent {
            id
            name
          }
        }
      }`,
      { id: CATEGORY_TRADITIONAL },
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(body.errors).toBeUndefined();
    const cat = (body.data as { categoryByPk: AnyRow }).categoryByPk;
    expect(cat).toBeDefined();
    expect(cat.name).toBe('Traditional');
    const parent = cat.parent as AnyRow;
    expect(parent).not.toBeNull();
    expect(parent.name).toBe('Funeral Services');
    expect(parent.id).toBe(CATEGORY_ROOT);
  });

  it('array relationship: parent category resolves children { name } — self-referential array relationship FK filter not applied', async () => {
    const { body } = await graphqlRequest(
      `query($id: Uuid!) {
        categoryByPk(id: $id) {
          id
          name
          children {
            id
            name
          }
        }
      }`,
      { id: CATEGORY_ROOT },
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(body.errors).toBeUndefined();
    const cat = (body.data as { categoryByPk: AnyRow }).categoryByPk;
    expect(cat).toBeDefined();
    expect(cat.name).toBe('Funeral Services');
    const children = cat.children as AnyRow[];
    expect(children).toHaveLength(2);
    const names = children.map((c) => c.name).sort();
    expect(names).toEqual(['Cremation', 'Traditional']);
  });

  it('recursive nesting: root { children { children { name } } } resolves 3 levels — depends on self-referential fix', async () => {
    const { body } = await graphqlRequest(
      `query($id: Uuid!) {
        categoryByPk(id: $id) {
          id
          name
          children {
            id
            name
            children {
              id
              name
            }
          }
        }
      }`,
      { id: CATEGORY_ROOT },
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(body.errors).toBeUndefined();
    const root = (body.data as { categoryByPk: AnyRow }).categoryByPk;
    expect(root).toBeDefined();
    expect(root.name).toBe('Funeral Services');

    const level1 = root.children as AnyRow[];
    expect(level1).toHaveLength(2);

    // Cremation has one child: Full Service Cremation
    const cremation = level1.find((c) => c.name === 'Cremation')!;
    expect(cremation).toBeDefined();
    const level2 = cremation.children as AnyRow[];
    expect(level2).toHaveLength(1);
    expect(level2[0].name).toBe('Full Service Cremation');
    expect(level2[0].id).toBe(CATEGORY_FULL_CREM);

    // Traditional has no children
    const traditional = level1.find((c) => c.name === 'Traditional')!;
    expect(traditional).toBeDefined();
    expect(traditional.children as AnyRow[]).toHaveLength(0);
  });
});

// ─── 9. Multiple FKs to Same Table (P6.3d) ──────────────────────────────────

describe('Multiple FKs to same table (transfer)', () => {
  const TRANSFER_1 = 'cc000000-0000-0000-0000-000000000001'; // Alice EUR -> Bob USD
  const TRANSFER_2 = 'cc000000-0000-0000-0000-000000000002'; // Diana GBP -> Alice EUR

  it('resolves both fromAccount and toAccount to correct different accounts', async () => {
    const { body } = await graphqlRequest(
      `query($id: Uuid!) {
        transferByPk(id: $id) {
          id
          amount
          note
          fromAccount {
            id
            balance
          }
          toAccount {
            id
            balance
          }
        }
      }`,
      { id: TRANSFER_1 },
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(body.errors).toBeUndefined();
    const transfer = (body.data as { transferByPk: AnyRow }).transferByPk;
    expect(transfer).toBeDefined();

    const fromAccount = transfer.fromAccount as AnyRow;
    const toAccount = transfer.toAccount as AnyRow;

    expect(fromAccount).not.toBeNull();
    expect(toAccount).not.toBeNull();

    // fromAccount is Alice's EUR account (e...001, balance 1500)
    expect(fromAccount.id).toBe('e0000000-0000-0000-0000-000000000001');
    // toAccount is Bob's USD account (e...002, balance 500)
    expect(toAccount.id).toBe('e0000000-0000-0000-0000-000000000002');

    // They must be different records
    expect(fromAccount.id).not.toBe(toAccount.id);
  });

  it('second transfer resolves different from/to accounts', async () => {
    const { body } = await graphqlRequest(
      `query($id: Uuid!) {
        transferByPk(id: $id) {
          id
          amount
          note
          fromAccount {
            id
            balance
          }
          toAccount {
            id
            balance
          }
        }
      }`,
      { id: TRANSFER_2 },
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(body.errors).toBeUndefined();
    const transfer = (body.data as { transferByPk: AnyRow }).transferByPk;
    expect(transfer).toBeDefined();

    const fromAccount = transfer.fromAccount as AnyRow;
    const toAccount = transfer.toAccount as AnyRow;

    expect(fromAccount).not.toBeNull();
    expect(toAccount).not.toBeNull();

    // fromAccount is Diana's GBP account (e...004, balance 25000)
    expect(fromAccount.id).toBe('e0000000-0000-0000-0000-000000000004');
    // toAccount is Alice's EUR account (e...001, balance 1500)
    expect(toAccount.id).toBe('e0000000-0000-0000-0000-000000000001');

    // They must be different records
    expect(fromAccount.id).not.toBe(toAccount.id);
  });
});

// ─── 10. Composite Foreign Keys (P6.3b) ─────────────────────────────────────

describe('Composite foreign keys (fiscal_report → fiscal_period)', () => {
  const REPORT_Q1 = 'cd000000-0000-0000-0000-000000000001';
  const REPORT_Q2 = 'cd000000-0000-0000-0000-000000000002';

  it('object relationship: fiscal report resolves fiscalPeriod { name } via composite FK', async () => {
    const { body } = await graphqlRequest(
      `query {
        fiscalReports(orderBy: [{ fiscalQuarter: ASC }]) {
          id
          title
          fiscalYear
          fiscalQuarter
          fiscalPeriod {
            year
            quarter
            name
          }
        }
      }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(body.errors).toBeUndefined();
    const reports = (body.data as { fiscalReports: AnyRow[] }).fiscalReports;
    expect(reports).toHaveLength(2);

    // Q1 report
    const q1 = reports.find((r) => r.title === 'Revenue Report Q1')!;
    expect(q1).toBeDefined();
    const q1Period = q1.fiscalPeriod as AnyRow;
    expect(q1Period).not.toBeNull();
    expect(q1Period.name).toBe('Q1 2025');
    expect(q1Period.year).toBe(2025);
    expect(q1Period.quarter).toBe(1);

    // Q2 report
    const q2 = reports.find((r) => r.title === 'Revenue Report Q2')!;
    expect(q2).toBeDefined();
    const q2Period = q2.fiscalPeriod as AnyRow;
    expect(q2Period).not.toBeNull();
    expect(q2Period.name).toBe('Q2 2025');
    expect(q2Period.year).toBe(2025);
    expect(q2Period.quarter).toBe(2);
  });

  it('array relationship: fiscal period resolves reports { title } (reverse direction) — composite FK multi-column filter incomplete', async () => {
    const { body } = await graphqlRequest(
      `query {
        fiscalPeriods(orderBy: [{ quarter: ASC }]) {
          year
          quarter
          name
          reports {
            id
            title
            amount
          }
        }
      }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );
    expect(body.errors).toBeUndefined();
    const periods = (body.data as { fiscalPeriods: AnyRow[] }).fiscalPeriods;
    expect(periods).toHaveLength(3); // Q1, Q2, Q3

    // Q1 has 1 report
    const q1 = periods.find((p) => p.quarter === 1)!;
    expect(q1).toBeDefined();
    const q1Reports = q1.reports as AnyRow[];
    expect(q1Reports).toHaveLength(1);
    expect(q1Reports[0].title).toBe('Revenue Report Q1');

    // Q2 has 1 report
    const q2 = periods.find((p) => p.quarter === 2)!;
    expect(q2).toBeDefined();
    const q2Reports = q2.reports as AnyRow[];
    expect(q2Reports).toHaveLength(1);
    expect(q2Reports[0].title).toBe('Revenue Report Q2');

    // Q3 has 0 reports
    const q3 = periods.find((p) => p.quarter === 3)!;
    expect(q3).toBeDefined();
    expect(q3.reports as AnyRow[]).toHaveLength(0);
  });
});

// ─── 7. Relationships in Subscriptions (P6.3c) ──────────────────────────────

// NOTE: Subscription context does not propagate JWT/admin-secret session from
// onConnect to the resolver context (pre-existing bug). These tests are skipped
// until the subscription auth pipeline is fixed. The onConnect handler returns
// { session } but the context function fails to retrieve it, falling back to
// anonymous role which has no select access on the client table.
describe('Relationships in subscriptions', () => {
  let wsUrl: string;
  let subPool: InstanceType<typeof Pool>;

  function createWsClient(connectionParams: Record<string, unknown>): GqlWsClient {
    return createClient({
      url: wsUrl,
      webSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
      connectionParams,
      retryAttempts: 0,
    });
  }

  function firstResult<T = unknown>(
    client: GqlWsClient,
    query: string,
    variables?: Record<string, unknown>,
    timeoutMs = 15000,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Timed out waiting for subscription result'));
      }, timeoutMs);

      const unsubscribe = client.subscribe(
        { query, variables },
        {
          next(value) {
            clearTimeout(timer);
            unsubscribe();
            resolve(value.data as T);
          },
          error(err) {
            clearTimeout(timer);
            reject(err);
          },
          complete() {
            clearTimeout(timer);
            reject(new Error('Subscription completed without results'));
          },
        },
      );
    });
  }

  function collectResults<T = unknown>(
    client: GqlWsClient,
    query: string,
    variables: Record<string, unknown> | undefined,
    count: number,
    timeoutMs = 15000,
  ): Promise<T[]> {
    return new Promise<T[]>((resolve, reject) => {
      const results: T[] = [];
      const timer = setTimeout(() => {
        reject(new Error(`Timed out waiting for ${count} subscription result(s), got ${results.length}`));
      }, timeoutMs);

      const unsubscribe = client.subscribe(
        { query, variables },
        {
          next(value) {
            results.push(value.data as T);
            if (results.length >= count) {
              clearTimeout(timer);
              unsubscribe();
              resolve(results);
            }
          },
          error(err) {
            clearTimeout(timer);
            reject(err);
          },
          complete() {
            clearTimeout(timer);
            if (results.length >= count) {
              resolve(results);
            } else {
              reject(new Error(`Subscription completed early with ${results.length}/${count} results`));
            }
          },
        },
      );
    });
  }

  function wait(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  beforeAll(async () => {
    const serverAddress = getServerAddress();
    wsUrl = serverAddress.replace(/^http/, 'ws') + '/graphql';
    subPool = new Pool({ connectionString: TEST_DB_URL, max: 3 });
    await wait(300);
  });

  afterAll(async () => {
    if (subPool) await subPool.end();
  });

  it('subscription with nested object relationship: clients { branch { name } }', async () => {
    const token = await createJWT({ role: 'backoffice', allowedRoles: ['backoffice'] });
    const client = createWsClient({ Authorization: `Bearer ${token}` });

    try {
      const data = await firstResult<{
        clients: Array<{ id: string; username: string; branch: { name: string } }>;
      }>(client, `
        subscription {
          clients(where: { id: { _eq: "${ALICE_ID}" } }) {
            id
            username
            branch { name }
          }
        }
      `);

      expect(data.clients).toBeDefined();
      expect(data.clients).toHaveLength(1);
      expect(data.clients[0].username).toBe('alice');
      expect(data.clients[0].branch).toBeDefined();
      expect(data.clients[0].branch.name).toBe('TestBranch');
    } finally {
      await client.dispose();
    }
  });

  it('subscription with nested array relationship: clients { invoices { amount } }', async () => {
    const token = await createJWT({ role: 'backoffice', allowedRoles: ['backoffice'] });
    const client = createWsClient({ Authorization: `Bearer ${token}` });

    try {
      const data = await firstResult<{
        clients: Array<{ id: string; username: string; invoices: Array<{ id: string; amount: number }> }>;
      }>(client, `
        subscription {
          clients(where: { id: { _eq: "${ALICE_ID}" } }) {
            id
            username
            invoices { id amount }
          }
        }
      `);

      expect(data.clients).toBeDefined();
      expect(data.clients).toHaveLength(1);
      expect(data.clients[0].username).toBe('alice');
      const invoices = data.clients[0].invoices;
      expect(Array.isArray(invoices)).toBe(true);
      // Alice has at least 2 invoices in seed data
      expect(invoices.length).toBeGreaterThanOrEqual(2);
      for (const inv of invoices) {
        expect(inv.id).toBeDefined();
        expect(inv.amount).toBeDefined();
      }
    } finally {
      await client.dispose();
    }
  });

  it('subscription with both object and array relationships', async () => {
    const token = await createJWT({ role: 'backoffice', allowedRoles: ['backoffice'] });
    const client = createWsClient({ Authorization: `Bearer ${token}` });

    try {
      const data = await firstResult<{
        clients: Array<{
          id: string;
          username: string;
          branch: { name: string };
          currency: { id: string; symbol: string };
          invoices: Array<{ id: string; amount: number }>;
        }>;
      }>(client, `
        subscription {
          clients(where: { id: { _eq: "${ALICE_ID}" } }) {
            id
            username
            branch { name }
            currency { id symbol }
            invoices { id amount }
          }
        }
      `);

      expect(data.clients).toBeDefined();
      expect(data.clients).toHaveLength(1);
      const alice = data.clients[0];
      expect(alice.branch.name).toBe('TestBranch');
      expect(alice.currency.id).toBe('EUR');
      expect(alice.currency.symbol).toBe('\u20ac');
      expect(alice.invoices.length).toBeGreaterThanOrEqual(2);
    } finally {
      await client.dispose();
    }
  });

  it('subscription live update: inserting a related invoice triggers re-delivery with nested data', async () => {
    const token = await createJWT({ role: 'backoffice', allowedRoles: ['backoffice'] });
    const client = createWsClient({ Authorization: `Bearer ${token}` });
    // Use Charlie who has 0 invoices — inserting one is easy to detect
    const tempInvoiceId = 'ff000000-0000-0000-0000-0000000000aa';

    try {
      const resultPromise = collectResults<{
        clients: Array<{
          id: string;
          username: string;
          invoices: Array<{ id: string; amount: number }>;
        }>;
      }>(
        client,
        `subscription {
          clients(where: { id: { _eq: "${CHARLIE_ID}" } }) {
            id
            username
            invoices { id amount }
          }
        }`,
        undefined,
        2, // initial + after insert
        15000,
      );

      await wait(500);

      // Insert an invoice for Charlie
      await subPool.query(
        `INSERT INTO invoice (id, client_id, account_id, currency_id, amount, state, type)
         VALUES ($1, $2, $3, 'EUR', 42.00, 'draft', 'payment')
         ON CONFLICT (id) DO NOTHING`,
        [tempInvoiceId, CHARLIE_ID, 'e0000000-0000-0000-0000-000000000003'],
      );

      const results = await resultPromise;

      // First delivery: Charlie with 0 invoices
      expect(results[0].clients).toHaveLength(1);
      expect(results[0].clients[0].username).toBe('charlie');
      expect(results[0].clients[0].invoices).toHaveLength(0);

      // Second delivery: Charlie with 1 invoice (nested data present)
      expect(results[1].clients).toHaveLength(1);
      expect(results[1].clients[0].invoices).toHaveLength(1);
      expect(Number(results[1].clients[0].invoices[0].amount)).toBe(42);
    } finally {
      await client.dispose();
      await subPool.query('DELETE FROM invoice WHERE id = $1', [tempInvoiceId]).catch(() => {});
    }
  });
});
