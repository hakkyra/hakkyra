/**
 * Tests for native query subscription support (P12.7).
 *
 * Verifies that native queries are exposed as subscription root fields
 * and receive updates when the underlying tables change.
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
  BRANCH_TEST_ID,
  createJWT,
  startServer,
  getServerAddress,
  stopServer,
  waitForDb,
} from './setup.js';
import { extractReferencedTables } from '../src/schema/native-queries.js';

const { Pool } = pg;

// ─── Test State ──────────────────────────────────────────────────────────────

let wsUrl: string;
let httpUrl: string;
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
          if (value.errors) {
            clearTimeout(timer);
            unsubscribe();
            reject(new Error(value.errors.map((e: { message: string }) => e.message).join(', ')));
            return;
          }
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
  await startServer();
  const serverAddress = getServerAddress();
  wsUrl = serverAddress.replace(/^http/, 'ws') + '/graphql';
  httpUrl = serverAddress;
  pool = new Pool({ connectionString: TEST_DB_URL, max: 3 });
  await wait(500);
}, 30_000);

afterAll(async () => {
  if (pool) await pool.end();
  await stopServer();
}, 15_000);

// ─── Unit Tests: extractReferencedTables ─────────────────────────────────────

describe('extractReferencedTables', () => {
  it('extracts a single table from a simple SELECT', () => {
    const tables = extractReferencedTables('SELECT count(*) FROM client WHERE branch_id = $1');
    expect(tables).toEqual(['public.client']);
  });

  it('extracts schema-qualified table names', () => {
    const tables = extractReferencedTables('SELECT * FROM myschema.my_table WHERE id = $1');
    expect(tables).toEqual(['myschema.my_table']);
  });

  it('extracts multiple tables from JOIN', () => {
    const tables = extractReferencedTables(
      'SELECT c.id, b.name FROM client c JOIN branch b ON c.branch_id = b.id',
    );
    expect(tables).toContain('public.client');
    expect(tables).toContain('public.branch');
  });

  it('extracts quoted table names', () => {
    const tables = extractReferencedTables('SELECT * FROM "client" WHERE id = $1');
    expect(tables).toEqual(['public.client']);
  });

  it('skips subqueries', () => {
    const tables = extractReferencedTables('SELECT * FROM (SELECT 1 AS x) AS subq');
    // Should not match the subquery alias
    expect(tables).not.toContain('public.subq');
  });

  it('returns empty array for SQL with no FROM', () => {
    const tables = extractReferencedTables('SELECT 1 + 1');
    expect(tables).toEqual([]);
  });
});

// ─── E2E Tests: Native Query Subscriptions ───────────────────────────────────

describe('Native query subscriptions', () => {
  it('schema exposes native queries as subscription fields', async () => {
    const res = await fetch(`${httpUrl}/sdl`, {
      headers: { 'x-hasura-admin-secret': ADMIN_SECRET },
    });
    const sdl = await res.text();
    // The SDL should contain subscription fields for native queries
    expect(sdl).toContain('branchClientCount');
    expect(sdl).toContain('clientNamesByBranch');
    // Verify they're in the subscription_root type
    const subRootMatch = sdl.match(/type subscription_root \{[\s\S]*?\}/);
    expect(subRootMatch).not.toBeNull();
    expect(subRootMatch![0]).toContain('branchClientCount');
    expect(subRootMatch![0]).toContain('clientNamesByBranch');
  });

  it('receives initial data from native query subscription (admin)', async () => {
    const client = createWsClient({ 'x-hasura-admin-secret': ADMIN_SECRET });

    try {
      const data = await firstResult<{ clientNamesByBranch: unknown[] }>(
        client,
        `subscription {
          clientNamesByBranch(args: { branchId: "${BRANCH_TEST_ID}" }) {
            id
            name
          }
        }`,
      );
      expect(data.clientNamesByBranch).toBeDefined();
      expect(Array.isArray(data.clientNamesByBranch)).toBe(true);
      // Verify results have the expected fields
      if (data.clientNamesByBranch.length > 0) {
        const first = data.clientNamesByBranch[0] as Record<string, unknown>;
        expect(first).toHaveProperty('id');
        expect(first).toHaveProperty('name');
      }
    } finally {
      await client.dispose();
    }
  });

  it('receives updates when underlying table changes', async () => {
    const client = createWsClient({ 'x-hasura-admin-secret': ADMIN_SECRET });
    const uniqueUsername = `sub_test_${Date.now()}`;
    const newClientId = `d0000000-0000-0000-0000-${Date.now().toString(16).padStart(12, '0')}`;

    try {
      // Subscribe and collect 2 results: initial + update
      const resultPromise = collectResults<{ branchClientCount: { count: unknown }[] }>(
        client,
        `subscription {
          branchClientCount(args: { branchId: "${BRANCH_TEST_ID}" }) {
            count
          }
        }`,
        undefined,
        2,
        15000,
      );

      // Wait for subscription to be established
      await wait(1000);

      // Insert a new client in the test branch to trigger a change
      await pool.query(
        `INSERT INTO client (id, branch_id, username, email, trust_level, currency_id)
         VALUES ($1, $2, $3, $4, 3, 'EUR')`,
        [newClientId, BRANCH_TEST_ID, uniqueUsername, `${uniqueUsername}@test.com`],
      );

      const results = await resultPromise;
      expect(results.length).toBe(2);
      // Both results should have the branchClientCount field
      expect(results[0].branchClientCount).toBeDefined();
      expect(results[1].branchClientCount).toBeDefined();
    } finally {
      await client.dispose();
      await pool.query('DELETE FROM client WHERE id = $1', [newClientId]);
    }
  });

  it('enforces permissions on native query subscriptions', async () => {
    // backoffice role has access to clientNamesByBranch
    const backofficeToken = await createJWT({ role: 'backoffice', userId: ALICE_ID, allowedRoles: ['backoffice'] });
    const client = createWsClient({ Authorization: `Bearer ${backofficeToken}` });

    try {
      const data = await firstResult<{ clientNamesByBranch: unknown[] }>(
        client,
        `subscription {
          clientNamesByBranch(args: { branchId: "${BRANCH_TEST_ID}" }) {
            id
            name
          }
        }`,
      );
      expect(data.clientNamesByBranch).toBeDefined();
      expect(Array.isArray(data.clientNamesByBranch)).toBe(true);
    } finally {
      await client.dispose();
    }
  });

  it('denies access for roles without permission', async () => {
    // anonymous/unauthorized role should not have access
    const token = await createJWT({ role: 'anonymous', userId: ALICE_ID, allowedRoles: ['anonymous'] });
    const client = createWsClient({ Authorization: `Bearer ${token}` });

    try {
      await expect(
        firstResult(
          client,
          `subscription {
            clientNamesByBranch(args: { branchId: "${BRANCH_TEST_ID}" }) {
              id
              name
            }
          }`,
          undefined,
          5000,
        ),
      ).rejects.toThrow();
    } finally {
      await client.dispose();
    }
  });
});
