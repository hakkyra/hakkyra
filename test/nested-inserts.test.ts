import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  startServer, stopServer, closePool, waitForDb,
  graphqlRequest,
  tokens, ADMIN_SECRET,
  TEST_DB_URL, getPool,
  BRANCH_TEST_ID,
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

// Clean up test data after each test
afterEach(async () => {
  const pool = getPool();
  // Clean up any test-inserted data (we use specific usernames/emails to identify test data)
  await pool.query(`DELETE FROM account WHERE client_id IN (SELECT id FROM client WHERE username LIKE 'nested_test_%')`);
  await pool.query(`DELETE FROM client_data WHERE client_id IN (SELECT id FROM client WHERE username LIKE 'nested_test_%')`);
  await pool.query(`DELETE FROM client WHERE username LIKE 'nested_test_%'`);
  await pool.query(`DELETE FROM branch WHERE name LIKE 'NestedTest_%'`);
});

describe('Nested Insert Ordering (insertion_order)', () => {

  // ── before_parent: Object relationship with FK on parent ─────────────────
  // The "branch" relationship on client has FK branch_id on the client table.
  // Default insertion_order is before_parent: insert branch first, then client.

  describe('before_parent (default): object relationship', () => {
    it('inserts related object before parent via insert_one', async () => {
      const { status, body } = await graphqlRequest(
        `mutation InsertClientWithBranch($object: ClientInsertInput!) {
          insertClient(object: $object) {
            id
            username
            branchId
            branch {
              id
              name
            }
          }
        }`,
        {
          object: {
            username: 'nested_test_before_parent',
            email: 'nested_before@test.com',
            currencyId: 'EUR',
            branch: {
              data: {
                name: 'NestedTest_BeforeParent',
                code: 'NESTED_BP',
              },
            },
          },
        },
        { 'x-hasura-admin-secret': ADMIN_SECRET },
      );

      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();
      expect(body.data).toBeDefined();

      const client = (body.data as { insertClient: AnyRow }).insertClient;
      expect(client).toBeDefined();
      expect(client.username).toBe('nested_test_before_parent');

      // The branch should have been created
      const branch = client.branch as AnyRow;
      expect(branch).toBeDefined();
      expect(branch.name).toBe('NestedTest_BeforeParent');

      // The client's branchId should match the created branch
      expect(client.branchId).toBe(branch.id);
    });
  });

  // ── after_parent: Object relationship with insertion_order: after_parent ──
  // The "primaryAccount" relationship on client is configured with
  // manual_configuration + insertion_order: after_parent.
  // This means: insert client first, then insert account with client_id = client.id.

  describe('after_parent: object relationship with insertion_order', () => {
    it('inserts related object after parent via insert_one', async () => {
      const { status, body } = await graphqlRequest(
        `mutation InsertClientWithAccount($object: ClientInsertInput!) {
          insertClient(object: $object) {
            id
            username
            primaryAccount {
              id
              clientId
              currencyId
              balance
            }
          }
        }`,
        {
          object: {
            username: 'nested_test_after_parent',
            email: 'nested_after@test.com',
            branchId: BRANCH_TEST_ID,
            currencyId: 'EUR',
            primaryAccount: {
              data: {
                currencyId: 'EUR',
                balance: 1000,
              },
            },
          },
        },
        { 'x-hasura-admin-secret': ADMIN_SECRET },
      );

      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();
      expect(body.data).toBeDefined();

      const client = (body.data as { insertClient: AnyRow }).insertClient;
      expect(client).toBeDefined();
      expect(client.username).toBe('nested_test_after_parent');

      // Verify the account was created with the correct client_id
      const pool = getPool();
      const accountResult = await pool.query(
        `SELECT * FROM account WHERE client_id = $1 AND currency_id = 'EUR' AND balance = 1000`,
        [client.id],
      );
      expect(accountResult.rows.length).toBe(1);
      expect(accountResult.rows[0].client_id).toBe(client.id);
    });
  });

  // ── Array relationship: always after_parent ──────────────────────────────
  // Array relationships always insert parent first, then children with FK set.

  describe('array relationship: nested insert (always after_parent)', () => {
    it('inserts parent with nested array relationship children via insert_one', async () => {
      const { status, body } = await graphqlRequest(
        `mutation InsertClientWithData($object: ClientInsertInput!) {
          insertClient(object: $object) {
            id
            username
            clientData {
              key
              value
            }
          }
        }`,
        {
          object: {
            username: 'nested_test_array',
            email: 'nested_array@test.com',
            branchId: BRANCH_TEST_ID,
            currencyId: 'EUR',
            clientData: {
              data: [
                { key: 'pref1', value: '{"theme": "light"}' },
                { key: 'pref2', value: '{"lang": "fi"}' },
              ],
            },
          },
        },
        { 'x-hasura-admin-secret': ADMIN_SECRET },
      );

      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();
      expect(body.data).toBeDefined();

      const client = (body.data as { insertClient: AnyRow }).insertClient;
      expect(client).toBeDefined();
      expect(client.username).toBe('nested_test_array');

      // Verify the child rows were created
      const pool = getPool();
      const dataResult = await pool.query(
        `SELECT * FROM client_data WHERE client_id = $1 ORDER BY key`,
        [client.id],
      );
      expect(dataResult.rows.length).toBe(2);
      expect(dataResult.rows[0].key).toBe('pref1');
      expect(dataResult.rows[1].key).toBe('pref2');
    });
  });

  // ── Combined: before_parent + after_parent in same insert ────────────────

  describe('combined: before_parent + after_parent in same insert', () => {
    it('inserts branch (before) and account (after) with client', async () => {
      const { status, body } = await graphqlRequest(
        `mutation InsertClientCombined($object: ClientInsertInput!) {
          insertClient(object: $object) {
            id
            username
            branch {
              id
              name
            }
          }
        }`,
        {
          object: {
            username: 'nested_test_combined',
            email: 'nested_combined@test.com',
            currencyId: 'EUR',
            // before_parent: create branch first
            branch: {
              data: {
                name: 'NestedTest_Combined',
                code: 'NESTED_COMB',
              },
            },
            // after_parent: create account after client
            primaryAccount: {
              data: {
                currencyId: 'USD',
                balance: 500,
              },
            },
          },
        },
        { 'x-hasura-admin-secret': ADMIN_SECRET },
      );

      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();
      expect(body.data).toBeDefined();

      const client = (body.data as { insertClient: AnyRow }).insertClient;
      expect(client).toBeDefined();
      expect(client.username).toBe('nested_test_combined');

      // Branch should be created and linked
      const branch = client.branch as AnyRow;
      expect(branch).toBeDefined();
      expect(branch.name).toBe('NestedTest_Combined');

      // Account should be created with client_id
      const pool = getPool();
      const accountResult = await pool.query(
        `SELECT * FROM account WHERE client_id = $1 AND currency_id = 'USD'`,
        [client.id],
      );
      expect(accountResult.rows.length).toBe(1);
      expect(accountResult.rows[0].balance).toBe('500.0000');
    });
  });

  // ── Rollback on nested insert failure ─────────────────────────────────────

  describe('transaction rollback on nested insert failure', () => {
    it('rolls back all inserts when after_parent insert fails', async () => {
      const pool = getPool();

      // Count existing clients before the failed insert
      const beforeCount = await pool.query(`SELECT count(*) FROM client`);

      const { status, body } = await graphqlRequest(
        `mutation InsertClientWithBadAccount($object: ClientInsertInput!) {
          insertClient(object: $object) {
            id
          }
        }`,
        {
          object: {
            username: 'nested_test_rollback',
            email: 'nested_rollback@test.com',
            branchId: BRANCH_TEST_ID,
            currencyId: 'EUR',
            // This account insert will fail because currency_id is required but not provided
            primaryAccount: {
              data: {
                balance: 1000,
              },
            },
          },
        },
        { 'x-hasura-admin-secret': ADMIN_SECRET },
      );

      // Should have an error
      expect(body.errors).toBeDefined();
      expect(body.errors!.length).toBeGreaterThan(0);

      // Client should not have been created (transaction rolled back)
      const afterCount = await pool.query(`SELECT count(*) FROM client`);
      expect(afterCount.rows[0].count).toBe(beforeCount.rows[0].count);
    });
  });
});
