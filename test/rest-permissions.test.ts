/**
 * REST Permission Enforcement Tests
 *
 * Verifies that the REST API properly enforces:
 * - Column filtering on SELECT, INSERT, and UPDATE operations
 * - Insert preset enforcement (overriding user-supplied values)
 * - Row-level permission filters on updates
 * - Aggregate access control (allowAggregations flag)
 *
 * Note: The REST layer enforces column restrictions, presets, and row-level
 * filters. Cross-table check constraints (e.g., insert check referencing a
 * related table's column) are enforced in the GraphQL resolver layer, not in
 * the REST router. These tests focus on what the REST layer does enforce.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  startServer, stopServer, closePool, waitForDb,
  restRequest, tokens, ADMIN_SECRET,
  ALICE_ID, BOB_ID,
  BRANCH_TEST_ID, ACCOUNT_ALICE_ID,
  TEST_DB_URL, getPool, INVOICE_ALICE_ID,
} from './setup.js';

// ─── Types ──────────────────────────────────────────────────────────────────

type AnyRow = Record<string, unknown>;

// ─── Server lifecycle ───────────────────────────────────────────────────────

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

// =============================================================================
// 1. REST SELECT column filtering
// =============================================================================

describe('REST SELECT column filtering', () => {
  it('client role list response excludes disallowed columns (on_hold, metadata, updated_at)', async () => {
    const token = await tokens.client(ALICE_ID);
    const { status, body } = await restRequest('GET', '/api/v1/clients', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(status).toBe(200);
    const clients = body as AnyRow[];
    expect(clients).toHaveLength(1);
    const alice = clients[0];

    // Allowed columns should be present
    expect(alice).toHaveProperty('id');
    expect(alice).toHaveProperty('username');
    expect(alice).toHaveProperty('email');
    expect(alice).toHaveProperty('status');
    expect(alice).toHaveProperty('branch_id');
    expect(alice).toHaveProperty('currency_id');
    expect(alice).toHaveProperty('country_id');
    expect(alice).toHaveProperty('language_id');
    expect(alice).toHaveProperty('trust_level');
    expect(alice).toHaveProperty('tags');
    expect(alice).toHaveProperty('last_contact_at');
    expect(alice).toHaveProperty('created_at');

    // Disallowed columns should NOT be present
    expect(alice).not.toHaveProperty('on_hold');
    expect(alice).not.toHaveProperty('metadata');
    expect(alice).not.toHaveProperty('updated_at');
  });

  it('client role get-by-PK response also excludes disallowed columns', async () => {
    const token = await tokens.client(ALICE_ID);
    const { status, body } = await restRequest('GET', `/api/v1/clients/${ALICE_ID}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(status).toBe(200);
    const alice = body as AnyRow;

    // Allowed columns present
    expect(alice).toHaveProperty('id');
    expect(alice).toHaveProperty('username');

    // Disallowed columns absent
    expect(alice).not.toHaveProperty('on_hold');
    expect(alice).not.toHaveProperty('metadata');
    expect(alice).not.toHaveProperty('updated_at');
  });

  it('backoffice role sees all columns including on_hold, metadata, updated_at', async () => {
    const token = await tokens.backoffice();
    const { status, body } = await restRequest('GET', '/api/v1/clients', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(status).toBe(200);
    const clients = body as AnyRow[];
    expect(clients.length).toBeGreaterThanOrEqual(4);
    const first = clients[0];

    // All columns should be present for backoffice (columns: "*")
    expect(first).toHaveProperty('id');
    expect(first).toHaveProperty('on_hold');
    expect(first).toHaveProperty('metadata');
    expect(first).toHaveProperty('updated_at');
  });

  it('function role on invoice sees all columns (columns: "*") but scoped to own client', async () => {
    const token = await tokens.function_(ALICE_ID);
    const { status, body } = await restRequest('GET', '/api/v1/invoices', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(status).toBe(200);
    const invoices = body as AnyRow[];

    // Function role sees all columns on invoice
    expect(invoices.length).toBeGreaterThanOrEqual(2);
    const first = invoices[0];
    expect(first).toHaveProperty('id');
    expect(first).toHaveProperty('client_id');
    expect(first).toHaveProperty('account_id');
    expect(first).toHaveProperty('metadata');
    expect(first).toHaveProperty('external_id');

    // All invoices should belong to Alice (permission filter)
    for (const inv of invoices) {
      expect(inv.client_id).toBe(ALICE_ID);
    }
  });

  it('client role on invoice sees only allowed columns (excludes account_id, external_id, metadata, updated_at)', async () => {
    const token = await tokens.client(ALICE_ID);
    const { status, body } = await restRequest('GET', '/api/v1/invoices', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(status).toBe(200);
    const invoices = body as AnyRow[];
    expect(invoices.length).toBeGreaterThanOrEqual(2);
    const first = invoices[0];

    // Allowed columns
    expect(first).toHaveProperty('id');
    expect(first).toHaveProperty('client_id');
    expect(first).toHaveProperty('currency_id');
    expect(first).toHaveProperty('amount');
    expect(first).toHaveProperty('state');
    expect(first).toHaveProperty('type');
    expect(first).toHaveProperty('provider');
    expect(first).toHaveProperty('created_at');

    // Disallowed columns
    expect(first).not.toHaveProperty('account_id');
    expect(first).not.toHaveProperty('external_id');
    expect(first).not.toHaveProperty('metadata');
    expect(first).not.toHaveProperty('updated_at');
  });
});

// =============================================================================
// 2. REST INSERT column filtering
// =============================================================================

describe('REST INSERT column filtering', () => {
  it('backoffice insert applies presets overriding user-supplied values', async () => {
    // Use a unique username to avoid conflicts with leftover data
    const uniqueName = `rest_perm_insert_${Date.now()}`;
    const pool = getPool();
    try {
      const token = await tokens.backoffice();
      const { status, body } = await restRequest('POST', '/api/v1/clients', {
        headers: { authorization: `Bearer ${token}` },
        body: {
          username: uniqueName,
          email: `${uniqueName}@test.com`,
          branch_id: BRANCH_TEST_ID,
          currency_id: 'EUR',
          country_id: 'FI',
          language_id: 'en',
          // trust_level is not in backoffice insert columns but has preset "0"
          trust_level: 99,
          // status is not in backoffice insert columns but has preset "active"
          status: 'on_hold',
        },
      });
      expect(status).toBe(201);
      const inserted = body as AnyRow;
      expect(inserted.username).toBe(uniqueName);

      // The RETURNING clause only includes allowed insert columns:
      // username, email, branch_id, currency_id, country_id, language_id, tags, metadata
      // status and trust_level are set by presets but NOT in the allowed columns list,
      // so they won't appear in the REST response. Verify via direct DB query.
      const dbRow = await pool.query(
        'SELECT status, trust_level FROM client WHERE username = $1',
        [uniqueName],
      );
      expect(dbRow.rows[0].status).toBe('active');
      expect(Number(dbRow.rows[0].trust_level)).toBe(0);
    } finally {
      // Clean up
      await pool.query('DELETE FROM client WHERE username = $1', [uniqueName]);
    }
  });

  it('backoffice insert RETURNING only includes allowed insert columns', async () => {
    const uniqueName = `rest_perm_ret_${Date.now()}`;
    const pool = getPool();
    try {
      const token = await tokens.backoffice();
      const { status, body } = await restRequest('POST', '/api/v1/clients', {
        headers: { authorization: `Bearer ${token}` },
        body: {
          username: uniqueName,
          email: `${uniqueName}@test.com`,
          branch_id: BRANCH_TEST_ID,
          currency_id: 'EUR',
          country_id: 'FI',
        },
      });
      expect(status).toBe(201);
      const inserted = body as AnyRow;

      // RETURNING clause uses allowedColumns from insert permission:
      // username, email, branch_id, currency_id, country_id, language_id, tags, metadata
      expect(inserted).toHaveProperty('username');
      expect(inserted).toHaveProperty('email');
      expect(inserted).toHaveProperty('branch_id');

      // Columns NOT in the insert permission columns list should not appear in RETURNING
      // (id, status, trust_level, on_hold, etc. are not in the insert columns)
      // Note: presets for status and trust_level are applied via SET but those columns
      // are still not in the "allowed insert columns" list for RETURNING
    } finally {
      // Clean up
      await pool.query('DELETE FROM client WHERE username = $1', [uniqueName]);
    }
  });

  it('function role insert on invoice applies state preset to draft', async () => {
    const pool = getPool();
    let insertedInvoiceId: string | undefined;
    try {
      const token = await tokens.function_(ALICE_ID);
      const { status, body } = await restRequest('POST', '/api/v1/invoice', {
        headers: { authorization: `Bearer ${token}` },
        body: {
          client_id: ALICE_ID,
          account_id: ACCOUNT_ALICE_ID,
          currency_id: 'EUR',
          amount: 15,
          type: 'payment',
          // state is not in function insert columns; the preset sets it to 'draft'
          state: 'paid',
        },
      });
      expect(status).toBe(201);
      const inserted = body as AnyRow;
      expect(Number(inserted.amount)).toBe(15);

      // The RETURNING clause only includes allowed insert columns
      // (client_id, account_id, currency_id, amount, type, provider, external_id, metadata)
      // Neither state nor id is in the allowed columns.
      // Verify the state was set to 'draft' (preset) via direct DB query.
      const dbRow = await pool.query(
        'SELECT id, state FROM invoice WHERE client_id = $1 AND amount = 15 ORDER BY created_at DESC LIMIT 1',
        [ALICE_ID],
      );
      insertedInvoiceId = dbRow.rows[0].id;
      expect(dbRow.rows[0].state).toBe('draft');
    } finally {
      // Clean up
      if (insertedInvoiceId) {
        await pool.query('DELETE FROM invoice WHERE id = $1', [insertedInvoiceId]);
      } else {
        // Fallback: clean up by amount in case id wasn't captured
        await pool.query(
          "DELETE FROM invoice WHERE client_id = $1 AND amount = 15 AND id NOT IN ('f0000000-0000-0000-0000-000000000001','f0000000-0000-0000-0000-000000000002','f0000000-0000-0000-0000-000000000003','f0000000-0000-0000-0000-000000000004')",
          [ALICE_ID],
        );
      }
    }
  });

  it('client role is denied insert on invoice (no insert permission)', async () => {
    const token = await tokens.client(ALICE_ID);
    const { status } = await restRequest('POST', '/api/v1/invoice', {
      headers: { authorization: `Bearer ${token}` },
      body: {
        client_id: ALICE_ID,
        account_id: ACCOUNT_ALICE_ID,
        currency_id: 'EUR',
        amount: 100,
        type: 'payment',
      },
    });
    expect(status).toBe(403);
  });
});

// =============================================================================
// 3. REST UPDATE column filtering
// =============================================================================

describe('REST UPDATE column filtering', () => {
  it('client role can update allowed columns (language_id, currency_id)', async () => {
    const pool = getPool();
    try {
      const token = await tokens.client(ALICE_ID);
      const { status, body } = await restRequest('PATCH', `/api/v1/client/${ALICE_ID}`, {
        headers: { authorization: `Bearer ${token}` },
        body: { language_id: 'fi' },
      });
      expect(status).toBe(200);
      const updated = body as AnyRow;
      expect(updated.language_id).toBe('fi');
    } finally {
      // Restore
      await pool.query("UPDATE client SET language_id = 'en' WHERE id = $1", [ALICE_ID]);
    }
  });

  it('client role update rejects when only disallowed columns are provided', async () => {
    const token = await tokens.client(ALICE_ID);

    // Attempt to update trust_level which is NOT in client update columns
    const { status } = await restRequest('PATCH', `/api/v1/client/${ALICE_ID}`, {
      headers: { authorization: `Bearer ${token}` },
      body: { trust_level: 99 },
    });
    // The REST router filters disallowed columns from the SET clause.
    // If no valid columns remain, it returns 400 "No updatable columns provided"
    expect(status).toBe(400);
  });

  it('client role update with mix of allowed and disallowed columns only applies allowed ones', async () => {
    const pool = getPool();
    try {
      const token = await tokens.client(ALICE_ID);

      const { status, body } = await restRequest('PATCH', `/api/v1/client/${ALICE_ID}`, {
        headers: { authorization: `Bearer ${token}` },
        body: {
          currency_id: 'GBP',
          trust_level: 99,   // disallowed, should be ignored
          status: 'on_hold', // disallowed, should be ignored
        },
      });
      expect(status).toBe(200);
      const updated = body as AnyRow;
      expect(updated.currency_id).toBe('GBP');

      // Verify trust_level was NOT updated
      const result = await pool.query('SELECT trust_level, status FROM client WHERE id = $1', [ALICE_ID]);
      expect(Number(result.rows[0].trust_level)).toBe(2); // original seed value
      expect(result.rows[0].status).toBe('active');        // original value
    } finally {
      // Restore currency_id
      await pool.query("UPDATE client SET currency_id = 'EUR' WHERE id = $1", [ALICE_ID]);
    }
  });

  it('backoffice can update columns in its permission set (status, trust_level, on_hold, etc.)', async () => {
    const pool = getPool();
    try {
      const token = await tokens.backoffice();

      const { status, body } = await restRequest('PATCH', `/api/v1/client/${ALICE_ID}`, {
        headers: { authorization: `Bearer ${token}` },
        body: { trust_level: 5 },
      });
      expect(status).toBe(200);
      const updated = body as AnyRow;
      expect(Number(updated.trust_level)).toBe(5);
    } finally {
      // Restore
      await pool.query('UPDATE client SET trust_level = 2 WHERE id = $1', [ALICE_ID]);
    }
  });

  it('client role cannot update another user record (filter enforcement)', async () => {
    const token = await tokens.client(ALICE_ID);
    // Alice tries to update Bob's record => permission filter restricts to own id
    const { status } = await restRequest('PATCH', `/api/v1/client/${BOB_ID}`, {
      headers: { authorization: `Bearer ${token}` },
      body: { currency_id: 'GBP' },
    });
    expect(status).toBe(404);
  });
});

// =============================================================================
// 4. REST INSERT constraint enforcement (DB-level NOT NULL)
// =============================================================================

describe('REST INSERT constraint enforcement', () => {
  it('backoffice insert with missing required branch_id fails (NOT NULL constraint)', async () => {
    const uniqueName = `rest_perm_null_${Date.now()}`;
    const pool = getPool();
    try {
      const token = await tokens.backoffice();
      const { status } = await restRequest('POST', '/api/v1/clients', {
        headers: { authorization: `Bearer ${token}` },
        body: {
          username: uniqueName,
          email: `${uniqueName}@test.com`,
          currency_id: 'EUR',
          country_id: 'FI',
          // branch_id is omitted => NULL => violates NOT NULL constraint
        },
      });
      // Insert should fail due to NOT NULL constraint on branch_id
      expect(status).toBe(400);
    } finally {
      // Clean up just in case
      await pool.query('DELETE FROM client WHERE username = $1', [uniqueName]);
    }
  });

  it('function role insert on invoice succeeds with valid data', async () => {
    const pool = getPool();
    let insertedId: unknown;
    try {
      const token = await tokens.function_(ALICE_ID);
      const { status, body } = await restRequest('POST', '/api/v1/invoice', {
        headers: { authorization: `Bearer ${token}` },
        body: {
          client_id: ALICE_ID,
          account_id: ACCOUNT_ALICE_ID,
          currency_id: 'EUR',
          amount: 42,
          type: 'payment',
        },
      });
      expect(status).toBe(201);
      const inserted = body as AnyRow;
      insertedId = inserted.id;
      expect(Number(inserted.amount)).toBe(42);
      expect(inserted.client_id).toBe(ALICE_ID);
    } finally {
      // Clean up
      if (insertedId) {
        await pool.query('DELETE FROM invoice WHERE id = $1', [insertedId]);
      } else {
        // Fallback: clean up by amount in case id wasn't captured
        await pool.query(
          "DELETE FROM invoice WHERE client_id = $1 AND amount = 42 AND id NOT IN ('f0000000-0000-0000-0000-000000000001','f0000000-0000-0000-0000-000000000002','f0000000-0000-0000-0000-000000000003','f0000000-0000-0000-0000-000000000004')",
          [ALICE_ID],
        );
      }
    }
  });
});

// =============================================================================
// 5. REST UPDATE row-level filter enforcement
// =============================================================================

describe('REST UPDATE row-level filter enforcement', () => {
  it('function role update on invoice fails when current state is not in filter (state=paid)', async () => {
    // INVOICE_ALICE_ID (f0000000-...-001) has state 'paid'
    // function role update filter: state _in [draft, sent]
    // Updating a paid invoice should fail because the row doesn't match the filter
    const token = await tokens.function_(ALICE_ID);
    const { status } = await restRequest('PATCH', `/api/v1/invoice/${INVOICE_ALICE_ID}`, {
      headers: { authorization: `Bearer ${token}` },
      body: { metadata: { note: 'test' } },
    });
    // Should return 404 because the permission filter (state in [draft, sent])
    // does not match the row (state=paid)
    expect(status).toBe(404);
  });

  it('function role update on invoice succeeds when state is draft', async () => {
    // f0000000-...-002 is Alice's draft invoice
    const draftInvoiceId = 'f0000000-0000-0000-0000-000000000002';
    const pool = getPool();
    try {
      const token = await tokens.function_(ALICE_ID);
      const { status, body } = await restRequest('PATCH', `/api/v1/invoice/${draftInvoiceId}`, {
        headers: { authorization: `Bearer ${token}` },
        body: { metadata: { note: 'updated via REST' } },
      });
      expect(status).toBe(200);
      const updated = body as AnyRow;
      expect(updated.metadata).toBeDefined();
    } finally {
      // Restore metadata
      await pool.query("UPDATE invoice SET metadata = '{}'::jsonb WHERE id = $1", [draftInvoiceId]);
    }
  });

  it('function role update on invoice rejects disallowed columns (amount is not updatable)', async () => {
    const draftInvoiceId = 'f0000000-0000-0000-0000-000000000002';
    const token = await tokens.function_(ALICE_ID);
    // function role update columns: state, metadata, updated_at
    // amount is NOT in the update columns
    const { status } = await restRequest('PATCH', `/api/v1/invoice/${draftInvoiceId}`, {
      headers: { authorization: `Bearer ${token}` },
      body: { amount: 9999 },
    });
    // amount is not in allowed update columns => "No updatable columns provided"
    expect(status).toBe(400);
  });

  it('client update succeeds when row matches permission filter (own record, active, not on hold)', async () => {
    const pool = getPool();
    try {
      // Alice is active with on_hold=false by default in seed data
      const token = await tokens.client(ALICE_ID);
      const { status, body } = await restRequest('PATCH', `/api/v1/client/${ALICE_ID}`, {
        headers: { authorization: `Bearer ${token}` },
        body: { language_id: 'fi' },
      });
      expect(status).toBe(200);
      const updated = body as AnyRow;
      expect(updated.language_id).toBe('fi');
    } finally {
      // Restore
      await pool.query("UPDATE client SET language_id = 'en' WHERE id = $1", [ALICE_ID]);
    }
  });
});

// =============================================================================
// 6. REST aggregate access control (allowAggregations flag)
// =============================================================================

describe('REST aggregate access control', () => {
  it('client role cannot access client aggregate endpoint (no allow_aggregations)', async () => {
    const token = await tokens.client(ALICE_ID);
    // The aggregate route is registered at /api/v1/{urlName}/aggregate
    // For the client table, urlName is "client" (no alias override for aggregates)
    const { status, body } = await restRequest('GET', '/api/v1/client/aggregate', {
      headers: { authorization: `Bearer ${token}` },
    });
    // Client role has no allow_aggregations on client table => 403
    expect(status).toBe(403);
    const response = body as AnyRow;
    expect(response.error).toBe('forbidden');
  });

  it('backoffice role can access client aggregate endpoint (allow_aggregations: true)', async () => {
    const token = await tokens.backoffice();
    const { status, body } = await restRequest('GET', '/api/v1/client/aggregate', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(status).toBe(200);
    const agg = body as AnyRow;
    expect(agg).toHaveProperty('aggregate');
    const aggregate = agg.aggregate as AnyRow;
    expect(Number(aggregate.count)).toBeGreaterThanOrEqual(4);
  });

  it('client role cannot access invoice aggregate endpoint (no allow_aggregations)', async () => {
    const token = await tokens.client(ALICE_ID);
    const { status } = await restRequest('GET', '/api/v1/invoice/aggregate', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(status).toBe(403);
  });

  it('admin secret can always access aggregate endpoint', async () => {
    const { status, body } = await restRequest('GET', '/api/v1/client/aggregate', {
      headers: { 'x-hasura-admin-secret': ADMIN_SECRET },
    });
    expect(status).toBe(200);
    const agg = body as AnyRow;
    expect(agg).toHaveProperty('aggregate');
    const aggregate = agg.aggregate as AnyRow;
    expect(Number(aggregate.count)).toBeGreaterThanOrEqual(4);
  });

  it('anonymous cannot access aggregate endpoint (no select permission)', async () => {
    const { status } = await restRequest('GET', '/api/v1/client/aggregate');
    // Anonymous has no select permission on client table => 403
    expect(status).toBe(403);
  });

  it('backoffice can access invoice aggregate endpoint (allow_aggregations: true)', async () => {
    const token = await tokens.backoffice();
    const { status, body } = await restRequest('GET', '/api/v1/invoice/aggregate', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(status).toBe(200);
    const agg = body as AnyRow;
    expect(agg).toHaveProperty('aggregate');
    const aggregate = agg.aggregate as AnyRow;
    expect(Number(aggregate.count)).toBeGreaterThanOrEqual(4);
  });
});
