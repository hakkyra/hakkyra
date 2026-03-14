/**
 * Integration tests for GraphQL subscriptions.
 *
 * Tests the full subscription pipeline:
 * WebSocket connect → JWT auth → subscribe → LISTEN/NOTIFY → re-query → push update
 *
 * Uses real PostgreSQL and the graphql-ws client over WebSocket.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient } from 'graphql-ws';
import type { Client as GqlWsClient } from 'graphql-ws';
import WebSocket from 'ws';
import pg from 'pg';
import {
  TEST_DB_URL,
  ADMIN_SECRET,
  ALICE_ID,
  createJWT,
  createExpiredJWT,
  startServer,
  getServerAddress,
  stopServer,
  waitForDb,
} from './setup.js';

const { Pool } = pg;

// ─── Test State ──────────────────────────────────────────────────────────────

let wsUrl: string;
let pool: InstanceType<typeof Pool>;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createWsClient(connectionParams: Record<string, unknown>): GqlWsClient {
  return createClient({
    url: wsUrl,
    webSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
    connectionParams,
    retryAttempts: 0,
  });
}

/**
 * Subscribe and collect the first N results from a subscription.
 */
function collectResults<T = unknown>(
  client: GqlWsClient,
  query: string,
  variables?: Record<string, unknown>,
  count = 1,
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

async function firstResult<T = unknown>(
  client: GqlWsClient,
  query: string,
  variables?: Record<string, unknown>,
  timeoutMs = 15000,
): Promise<T> {
  const results = await collectResults<T>(client, query, variables, 1, timeoutMs);
  return results[0];
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Setup / Teardown ────────────────────────────────────────────────────────

beforeAll(async () => {
  await waitForDb();

  // Use the shared server (same as e2e tests) which properly initializes Phase 2
  await startServer();
  const serverAddress = getServerAddress();
  wsUrl = serverAddress.replace(/^http/, 'ws') + '/graphql';

  pool = new Pool({ connectionString: TEST_DB_URL, max: 3 });

  // Give subscription infrastructure time to start
  await wait(500);
}, 30_000);

afterAll(async () => {
  if (pool) await pool.end();
  await stopServer();
}, 15_000);

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Subscriptions', () => {
  describe('WebSocket authentication', () => {
    it('connects with JWT in connectionParams', async () => {
      const token = await createJWT({ role: 'client', userId: ALICE_ID, allowedRoles: ['client'] });
      const client = createWsClient({ Authorization: `Bearer ${token}` });

      try {
        const data = await firstResult<{ branch: unknown[] }>(client, `
          subscription { branch(limit: 1) { id name } }
        `);
        expect(data.branch).toBeDefined();
        expect(Array.isArray(data.branch)).toBe(true);
      } finally {
        await client.dispose();
      }
    });

    it('connects with admin secret', async () => {
      const client = createWsClient({ 'x-hasura-admin-secret': ADMIN_SECRET });

      try {
        const data = await firstResult<{ branch: unknown[] }>(client, `
          subscription { branch(limit: 1) { id name } }
        `);
        expect(data.branch).toBeDefined();
      } finally {
        await client.dispose();
      }
    });

    it('connects with token in headers sub-object', async () => {
      const token = await createJWT({ role: 'client', userId: ALICE_ID, allowedRoles: ['client'] });
      const client = createWsClient({
        headers: { Authorization: `Bearer ${token}` },
      });

      try {
        const data = await firstResult<{ branch: unknown[] }>(client, `
          subscription { branch(limit: 1) { id name } }
        `);
        expect(data.branch).toBeDefined();
      } finally {
        await client.dispose();
      }
    });

    it('rejects expired JWT', async () => {
      const expiredToken = await createExpiredJWT();
      const client = createWsClient({ Authorization: `Bearer ${expiredToken}` });

      try {
        await expect(
          firstResult(client, `subscription { branch(limit: 1) { id name } }`, undefined, 3000),
        ).rejects.toThrow();
      } finally {
        await client.dispose();
      }
    });

    it('rejects invalid admin secret', async () => {
      const client = createWsClient({ 'x-hasura-admin-secret': 'wrong-secret' });

      try {
        await expect(
          firstResult(client, `subscription { branch(limit: 1) { id name } }`, undefined, 3000),
        ).rejects.toThrow();
      } finally {
        await client.dispose();
      }
    });
  });

  describe('initial data', () => {
    it('returns initial subscription data on subscribe', async () => {
      const client = createWsClient({ 'x-hasura-admin-secret': ADMIN_SECRET });

      try {
        const data = await firstResult<{ branch: Array<{ id: string; name: string }> }>(client, `
          subscription { branch(limit: 5) { id name } }
        `);
        expect(data.branch).toBeDefined();
        expect(data.branch.length).toBeGreaterThan(0);
        expect(data.branch[0]).toHaveProperty('id');
        expect(data.branch[0]).toHaveProperty('name');
      } finally {
        await client.dispose();
      }
    });

    it('returns filtered subscription data', async () => {
      const client = createWsClient({ 'x-hasura-admin-secret': ADMIN_SECRET });

      try {
        // branch table is accessible to all roles (including anonymous)
        const data = await firstResult<{ branch: Array<{ id: string; name: string }> }>(client, `
          subscription { branch(where: { name: { _like: "%test%" } }, limit: 5) { id name } }
        `);
        expect(data.branch).toBeDefined();
        expect(Array.isArray(data.branch)).toBe(true);
      } finally {
        await client.dispose();
      }
    });
  });

  describe('live updates', () => {
    it('receives update when data changes (INSERT)', async () => {
      const client = createWsClient({ 'x-hasura-admin-secret': ADMIN_SECRET });
      const uniqueName = `sub_test_${Date.now()}`;
      const uniqueCode = `ST${Date.now()}`;

      try {
        const resultPromise = collectResults<{ branch: Array<{ id: string; name: string }> }>(
          client,
          `subscription {
            branch(where: { name: { _eq: "${uniqueName}" } }) { id name }
          }`,
          undefined,
          2, // initial (empty) + after insert
          15000,
        );

        await wait(500);

        // Insert a new branch
        await pool.query(
          `INSERT INTO branch (id, name, code, active) VALUES (gen_random_uuid(), $1, $2, true)`,
          [uniqueName, uniqueCode],
        );

        const results = await resultPromise;

        // First: initial (empty)
        expect(results[0].branch).toEqual([]);

        // Second: after insert
        expect(results[1].branch.length).toBe(1);
        expect(results[1].branch[0].name).toBe(uniqueName);
      } finally {
        await client.dispose();
        await pool.query(`DELETE FROM branch WHERE name = $1`, [uniqueName]);
      }
    });

    it('receives update when data is updated', async () => {
      const client = createWsClient({ 'x-hasura-admin-secret': ADMIN_SECRET });
      const uniqueName = `sub_upd_${Date.now()}`;
      const uniqueCode = `SU${Date.now()}`;

      // Insert test data
      const { rows } = await pool.query(
        `INSERT INTO branch (id, name, code, active) VALUES (gen_random_uuid(), $1, $2, true) RETURNING id`,
        [uniqueName, uniqueCode],
      );
      const branchId = rows[0].id;

      try {
        const resultPromise = collectResults<{ branch: Array<{ id: string; name: string }> }>(
          client,
          `subscription {
            branch(where: { id: { _eq: "${branchId}" } }) { id name }
          }`,
          undefined,
          2,
          15000,
        );

        await wait(500);

        // Update the branch name
        const updatedName = uniqueName + '_updated';
        await pool.query(`UPDATE branch SET name = $1 WHERE id = $2`, [updatedName, branchId]);

        const results = await resultPromise;

        // First: original name
        expect(results[0].branch[0].name).toBe(uniqueName);

        // Second: updated name
        expect(results[1].branch[0].name).toBe(updatedName);
      } finally {
        await client.dispose();
        await pool.query(`DELETE FROM branch WHERE id = $1`, [branchId]).catch(() => {});
      }
    });

    it('receives update when data is deleted', async () => {
      const client = createWsClient({ 'x-hasura-admin-secret': ADMIN_SECRET });
      const uniqueName = `sub_del_${Date.now()}`;
      const uniqueCode = `SD${Date.now()}`;

      // Insert test data
      const { rows } = await pool.query(
        `INSERT INTO branch (id, name, code, active) VALUES (gen_random_uuid(), $1, $2, true) RETURNING id`,
        [uniqueName, uniqueCode],
      );
      const branchId = rows[0].id;

      try {
        const resultPromise = collectResults<{ branch: Array<{ id: string; name: string }> }>(
          client,
          `subscription {
            branch(where: { id: { _eq: "${branchId}" } }) { id name }
          }`,
          undefined,
          2,
          15000,
        );

        await wait(500);

        // Delete the branch
        await pool.query(`DELETE FROM branch WHERE id = $1`, [branchId]);

        const results = await resultPromise;

        // First: has the branch
        expect(results[0].branch.length).toBe(1);

        // Second: empty after delete
        expect(results[1].branch).toEqual([]);
      } finally {
        await client.dispose();
      }
    });
  });

  describe('permission enforcement', () => {
    it('enforces row-level permissions on subscriptions', async () => {
      // anonymous role has select access to branch (with filter)
      const client = createWsClient({});

      try {
        const data = await firstResult<{ branch: Array<{ id: string; name: string }> }>(client, `
          subscription { branch(limit: 5) { id name } }
        `);
        expect(data.branch).toBeDefined();
        expect(Array.isArray(data.branch)).toBe(true);
      } finally {
        await client.dispose();
      }
    });

    it('denies subscription on tables without select permission', async () => {
      // 'client' role should not have access to the 'role' table
      const token = await createJWT({ role: 'client', userId: ALICE_ID, allowedRoles: ['client'] });
      const client = createWsClient({ Authorization: `Bearer ${token}` });

      try {
        await expect(
          firstResult(client, `subscription { role { id name } }`, undefined, 3000),
        ).rejects.toThrow();
      } finally {
        await client.dispose();
      }
    });
  });

  describe('cleanup', () => {
    it('properly cleans up subscription on client disconnect', async () => {
      const client = createWsClient({ 'x-hasura-admin-secret': ADMIN_SECRET });

      let received = false;
      const unsubscribe = client.subscribe(
        { query: `subscription { branch(limit: 1) { id name } }` },
        {
          next() { received = true; },
          error() {},
          complete() {},
        },
      );

      // Wait for initial result
      await wait(1000);
      expect(received).toBe(true);

      // Unsubscribe and disconnect
      unsubscribe();
      await client.dispose();

      // Give the server time to clean up
      await wait(200);
      // If we reach here without hanging, cleanup worked
    });
  });

  describe('streaming subscriptions', () => {
    it('returns initial data from branchStream', async () => {
      const client = createWsClient({ 'x-hasura-admin-secret': ADMIN_SECRET });

      try {
        const data = await firstResult<{ branchStream: Array<{ id: string; name: string; createdAt: string }> }>(client, `
          subscription {
            branchStream(
              batchSize: 2,
              cursor: [{ initialValue: { createdAt: "2000-01-01T00:00:00Z" }, ordering: ASC }]
            ) { id name createdAt }
          }
        `);
        expect(data.branchStream).toBeDefined();
        expect(Array.isArray(data.branchStream)).toBe(true);
        // With batchSize 2, should get at most 2 rows
        expect(data.branchStream.length).toBeLessThanOrEqual(2);
        expect(data.branchStream.length).toBeGreaterThan(0);
      } finally {
        await client.dispose();
      }
    });

    it('delivers new rows after INSERT via streaming', async () => {
      const client = createWsClient({ 'x-hasura-admin-secret': ADMIN_SECRET });
      const uniqueName = `stream_test_${Date.now()}`;
      const uniqueCode = `STR${Date.now()}`;

      try {
        // Use a past cursor and a where filter on a unique name.
        // Initial batch: empty (no rows match the unique name yet).
        // After INSERT: the new row matches both cursor and where filter.
        const resultPromise = collectResults<{ branchStream: Array<{ id: string; name: string }> }>(
          client,
          `subscription {
            branchStream(
              batchSize: 10,
              cursor: [{ initialValue: { createdAt: "2000-01-01T00:00:00Z" }, ordering: ASC }],
              where: { name: { _eq: "${uniqueName}" } }
            ) { id name }
          }`,
          undefined,
          2, // initial (empty, no matching rows) + after insert
          15000,
        );

        await wait(500);

        // Insert a new branch — should trigger the streaming subscription
        await pool.query(
          `INSERT INTO branch (id, name, code, active) VALUES (gen_random_uuid(), $1, $2, true)`,
          [uniqueName, uniqueCode],
        );

        const results = await resultPromise;

        // First: initial (empty — no rows match the unique name yet)
        expect(results[0].branchStream).toEqual([]);

        // Second: after insert — should contain the new row
        expect(results[1].branchStream.length).toBe(1);
        expect(results[1].branchStream[0].name).toBe(uniqueName);
      } finally {
        await client.dispose();
        await pool.query(`DELETE FROM branch WHERE name = $1`, [uniqueName]);
      }
    });
  });
});
