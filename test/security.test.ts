/**
 * Security tests for Hakkyra.
 *
 * Verifies existing protections against:
 * - SQL injection via WHERE / ORDER BY arguments
 * - JWT algorithm confusion (alg: none)
 * - REST ORDER BY invalid column validation
 * - WebSocket auth edge cases (empty admin secret, invalid JWT)
 * - Large array inputs (_in operator)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient } from 'graphql-ws';
import type { Client as GqlWsClient } from 'graphql-ws';
import WebSocket from 'ws';
import {
  startServer, stopServer, closePool, waitForDb,
  graphqlRequest, restRequest,
  tokens, ADMIN_SECRET,
  ALICE_ID, TEST_DB_URL,
  getServerAddress, getPool,
} from './setup.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createWsClient(connectionParams: Record<string, unknown>): GqlWsClient {
  const addr = getServerAddress();
  const wsUrl = addr.replace(/^http/, 'ws') + '/graphql';
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
  timeoutMs = 5000,
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
          reject(new Error('Subscription completed without emitting a value'));
        },
      },
    );
  });
}

/**
 * Build a JWT-like token with alg:none (unsigned).
 * This crafts the raw Base64url segments manually since jose refuses
 * to produce an unsigned token.
 */
function buildAlgNoneToken(payload: Record<string, unknown>): string {
  const header = { alg: 'none', typ: 'JWT' };
  const encode = (obj: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(obj)).toString('base64url');
  // alg:none tokens have an empty signature segment
  return `${encode(header)}.${encode(payload)}.`;
}

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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Security', () => {

  // ── 1. SQL Injection via WHERE / ORDER BY ──────────────────────────────

  describe('SQL injection prevention', () => {
    it('parameterises WHERE _eq values — DROP TABLE injection returns no rows', async () => {
      const token = await tokens.backoffice();
      const { status, body } = await graphqlRequest(
        `query { clients(where: { username: { _eq: "'; DROP TABLE client; --" } }) { id } }`,
        undefined,
        { authorization: `Bearer ${token}` },
      );

      expect(status).toBe(200);
      // The injection string is treated as a literal value, so no rows match
      expect(body.errors).toBeUndefined();
      const clients = (body.data as { clients: unknown[] }).clients;
      expect(clients).toHaveLength(0);

      // Verify the client table still exists and has data
      const pool = getPool();
      const check = await pool.query('SELECT count(*)::int AS cnt FROM client');
      expect(check.rows[0].cnt).toBeGreaterThan(0);
    });

    it('parameterises WHERE _eq values — UNION SELECT injection returns no rows', async () => {
      const token = await tokens.backoffice();
      const { status, body } = await graphqlRequest(
        `query { clients(where: { username: { _eq: "' UNION SELECT id FROM branch --" } }) { id } }`,
        undefined,
        { authorization: `Bearer ${token}` },
      );

      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();
      const clients = (body.data as { clients: unknown[] }).clients;
      expect(clients).toHaveLength(0);
    });

    it('parameterises WHERE _like values — injection via pattern matching', async () => {
      const token = await tokens.backoffice();
      const { status, body } = await graphqlRequest(
        `query { clients(where: { username: { _like: "'; DELETE FROM client; --%" } }) { id } }`,
        undefined,
        { authorization: `Bearer ${token}` },
      );

      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();
      const clients = (body.data as { clients: unknown[] }).clients;
      expect(clients).toHaveLength(0);

      // Table still intact
      const pool = getPool();
      const check = await pool.query('SELECT count(*)::int AS cnt FROM client');
      expect(check.rows[0].cnt).toBeGreaterThan(0);
    });

    it('parameterises _in array values — injection via array element', async () => {
      const token = await tokens.backoffice();
      const { status, body } = await graphqlRequest(
        `query {
          clients(where: { username: { _in: ["alice", "'; DROP TABLE client; --"] } }) { id username }
        }`,
        undefined,
        { authorization: `Bearer ${token}` },
      );

      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();
      const clients = (body.data as { clients: unknown[] }).clients;
      // Only alice matches; the injection string is treated as a literal
      expect(clients.length).toBeLessThanOrEqual(1);

      // Table still intact
      const pool = getPool();
      const check = await pool.query('SELECT count(*)::int AS cnt FROM client');
      expect(check.rows[0].cnt).toBeGreaterThan(0);
    });

    it('rejects invalid order_by column via GraphQL — nonexistent field', async () => {
      const token = await tokens.backoffice();
      const { body } = await graphqlRequest(
        `query { clients(orderBy: { nonexistent_column: asc }) { id } }`,
        undefined,
        { authorization: `Bearer ${token}` },
      );
      // GraphQL schema validation should reject unknown fields in orderBy input
      expect(body.errors).toBeDefined();
      expect(body.errors!.length).toBeGreaterThan(0);
    });
  });

  // ── 2. JWT Algorithm Confusion ─────────────────────────────────────────

  describe('JWT algorithm confusion', () => {
    it('rejects a token with alg:none via HTTP', async () => {
      const payload = {
        'https://hasura.io/jwt/claims': {
          'x-hasura-default-role': 'backoffice',
          'x-hasura-allowed-roles': ['backoffice'],
        },
        sub: 'attacker',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
        aud: 'hakkyra-test',
        iss: 'hakkyra-test-suite',
      };
      const fakeToken = buildAlgNoneToken(payload);

      const { status, body } = await graphqlRequest(
        `query { clients { id } }`,
        undefined,
        { authorization: `Bearer ${fakeToken}` },
      );

      // Must reject — either 401 or return GraphQL errors
      expect(status === 401 || (body.errors !== undefined && body.errors.length > 0)).toBe(true);
    });

    it('rejects a token with alg:none via REST', async () => {
      const payload = {
        'https://hasura.io/jwt/claims': {
          'x-hasura-default-role': 'backoffice',
          'x-hasura-allowed-roles': ['backoffice'],
        },
        sub: 'attacker',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
        aud: 'hakkyra-test',
        iss: 'hakkyra-test-suite',
      };
      const fakeToken = buildAlgNoneToken(payload);

      const { status } = await restRequest('GET', '/api/v1/clients', {
        headers: { authorization: `Bearer ${fakeToken}` },
      });

      expect(status).toBe(401);
    });

    it('rejects a token signed with wrong secret', async () => {
      // Craft a valid HS256 token but with a different secret
      const wrongSecret = new TextEncoder().encode('wrong-secret-key-minimum-32-chars!!');
      const { SignJWT } = await import('jose');
      const token = await new SignJWT({
        'https://hasura.io/jwt/claims': {
          'x-hasura-default-role': 'backoffice',
          'x-hasura-allowed-roles': ['backoffice'],
        },
        sub: 'attacker',
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('1h')
        .setAudience('hakkyra-test')
        .setIssuer('hakkyra-test-suite')
        .sign(wrongSecret);

      const { status } = await graphqlRequest(
        `query { clients { id } }`,
        undefined,
        { authorization: `Bearer ${token}` },
      );

      expect(status).toBe(401);
    });
  });

  // ── 3. REST ORDER BY Column Validation ─────────────────────────────────

  describe('REST ORDER BY column validation', () => {
    it('silently ignores non-existent order column (filtered by allowed columns)', async () => {
      // The REST router filters order_by columns against allowedColumns.
      // A nonexistent column is simply dropped, resulting in no ORDER BY clause.
      const { status, body } = await restRequest('GET', '/api/v1/clients', {
        headers: { 'x-hasura-admin-secret': ADMIN_SECRET },
        query: { order: 'nonexistent_column.asc', limit: '2' },
      });

      // Should succeed — the invalid column is silently filtered out
      expect(status).toBe(200);
      expect(Array.isArray(body)).toBe(true);
    });

    it('accepts valid order column', async () => {
      const { status, body } = await restRequest('GET', '/api/v1/clients', {
        headers: { 'x-hasura-admin-secret': ADMIN_SECRET },
        query: { order: 'username.asc', limit: '2' },
      });

      expect(status).toBe(200);
      const clients = body as Array<{ username: string }>;
      expect(clients.length).toBeLessThanOrEqual(2);
      // Verify ascending order
      for (let i = 1; i < clients.length; i++) {
        expect(clients[i - 1].username.localeCompare(clients[i].username)).toBeLessThanOrEqual(0);
      }
    });

    it('rejects SQL injection via order parameter column name', async () => {
      const { status, body } = await restRequest('GET', '/api/v1/clients', {
        headers: { 'x-hasura-admin-secret': ADMIN_SECRET },
        query: { order: '1; DROP TABLE client; --.asc' },
      });

      // The invalid column name is filtered out by allowedColumns check;
      // the query still succeeds but with no ORDER BY
      expect(status).toBe(200);
      expect(Array.isArray(body)).toBe(true);

      // Table still intact
      const pool = getPool();
      const check = await pool.query('SELECT count(*)::int AS cnt FROM client');
      expect(check.rows[0].cnt).toBeGreaterThan(0);
    });
  });

  // ── 4. WebSocket Auth Edge Cases ───────────────────────────────────────

  describe('WebSocket auth edge cases', () => {
    it('empty admin secret does not grant admin access', async () => {
      // An empty string is treated as "no secret provided" and falls back
      // to the unauthorized role. It should NOT grant admin privileges.
      // We test this by querying a table that has no anonymous select permission.
      const client = createWsClient({ 'x-hasura-admin-secret': '' });

      try {
        await expect(
          firstResult(client, `subscription { clients(limit: 1) { id username } }`, undefined, 3000),
        ).rejects.toThrow();
      } finally {
        await client.dispose();
      }
    });

    it('rejects invalid JWT on WebSocket connection', async () => {
      const payload = {
        'https://hasura.io/jwt/claims': {
          'x-hasura-default-role': 'backoffice',
          'x-hasura-allowed-roles': ['backoffice'],
        },
        sub: 'attacker',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      };
      const fakeToken = buildAlgNoneToken(payload);
      const client = createWsClient({ Authorization: `Bearer ${fakeToken}` });

      try {
        await expect(
          firstResult(client, `subscription { branch(limit: 1) { id name } }`, undefined, 3000),
        ).rejects.toThrow();
      } finally {
        await client.dispose();
      }
    });

    it('rejects token signed with wrong secret on WebSocket', async () => {
      const wrongSecret = new TextEncoder().encode('wrong-secret-key-minimum-32-chars!!');
      const { SignJWT } = await import('jose');
      const token = await new SignJWT({
        'https://hasura.io/jwt/claims': {
          'x-hasura-default-role': 'client',
          'x-hasura-allowed-roles': ['client'],
          'x-hasura-user-id': ALICE_ID,
        },
        sub: ALICE_ID,
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('1h')
        .setAudience('hakkyra-test')
        .setIssuer('hakkyra-test-suite')
        .sign(wrongSecret);

      const client = createWsClient({ Authorization: `Bearer ${token}` });

      try {
        await expect(
          firstResult(client, `subscription { branch(limit: 1) { id name } }`, undefined, 3000),
        ).rejects.toThrow();
      } finally {
        await client.dispose();
      }
    });

    it('rejects completely garbage token on WebSocket', async () => {
      const client = createWsClient({ Authorization: 'Bearer not.a.valid.jwt.token' });

      try {
        await expect(
          firstResult(client, `subscription { branch(limit: 1) { id name } }`, undefined, 3000),
        ).rejects.toThrow();
      } finally {
        await client.dispose();
      }
    });
  });

  // ── 5. Large Array Inputs (_in operator) ───────────────────────────────

  describe('large array inputs', () => {
    it('handles _in operator with 1000 UUIDs without crashing', async () => {
      const token = await tokens.backoffice();
      // Generate 1000 random-looking UUIDs
      const uuids: string[] = [];
      for (let i = 0; i < 1000; i++) {
        const hex = i.toString(16).padStart(12, '0');
        uuids.push(`00000000-0000-0000-0000-${hex}`);
      }

      const { status, body } = await graphqlRequest(
        `query($ids: [Uuid!]!) { clients(where: { id: { _in: $ids } }) { id } }`,
        { ids: uuids },
        { authorization: `Bearer ${token}` },
      );

      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();
      const clients = (body.data as { clients: unknown[] }).clients;
      // None of the generated UUIDs match real data
      expect(clients).toHaveLength(0);
    });

    it('handles _in with large array including matching IDs', async () => {
      const token = await tokens.backoffice();
      // 999 fake UUIDs + 1 real one
      const uuids: string[] = [ALICE_ID];
      for (let i = 0; i < 999; i++) {
        const hex = i.toString(16).padStart(12, '0');
        uuids.push(`99999999-0000-0000-0000-${hex}`);
      }

      const { status, body } = await graphqlRequest(
        `query($ids: [Uuid!]!) { clients(where: { id: { _in: $ids } }) { id username } }`,
        { ids: uuids },
        { authorization: `Bearer ${token}` },
      );

      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();
      const clients = (body.data as { clients: Array<{ id: string }> }).clients;
      expect(clients).toHaveLength(1);
      expect(clients[0].id).toBe(ALICE_ID);
    });

    it('handles _in with large string array', async () => {
      const token = await tokens.backoffice();
      // Generate 500 fake usernames
      const usernames: string[] = [];
      for (let i = 0; i < 500; i++) {
        usernames.push(`nonexistent_user_${i}`);
      }
      // Add a real username
      usernames.push('alice');

      const { status, body } = await graphqlRequest(
        `query($names: [String!]!) { clients(where: { username: { _in: $names } }) { id username } }`,
        { names: usernames },
        { authorization: `Bearer ${token}` },
      );

      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();
      const clients = (body.data as { clients: Array<{ username: string }> }).clients;
      expect(clients).toHaveLength(1);
      expect(clients[0].username).toBe('alice');
    });
  });
});
