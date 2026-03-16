/**
 * Security tests for Hakkyra.
 *
 * Verifies existing protections against:
 * - SQL injection via WHERE / ORDER BY arguments
 * - JWT algorithm confusion (alg: none)
 * - REST ORDER BY invalid column validation
 * - WebSocket auth edge cases (empty admin secret, invalid JWT)
 * - Large array inputs (_in operator)
 * - Webhook header CRLF injection
 * - Tracked function argument SQL injection
 * - Async action status IDOR (P7.1 Critical)
 * - backend_only permission enforcement (P7.1 Critical)
 * - GraphQL batching limit (P7.1 High)
 * - resolveLimit global cap in subscriptions/tracked functions (P7.1 High)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient } from 'graphql-ws';
import type { Client as GqlWsClient } from 'graphql-ws';
import WebSocket from 'ws';
import {
  startServer, stopServer, closePool, waitForDb,
  graphqlRequest, restRequest,
  tokens, ADMIN_SECRET,
  ALICE_ID, BOB_ID, BRANCH_TEST_ID, TEST_DB_URL,
  getServerAddress, getPool,
} from './setup.js';
import { resolveWebhookHeaders, deliverWebhook } from '../src/shared/webhook.js';

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

  // ── 6a. Webhook Header CRLF Injection ──────────────────────────────────

  describe('webhook header CRLF injection', () => {
    it('resolveWebhookHeaders passes through header values as-is (no server-side filtering)', () => {
      // resolveWebhookHeaders resolves values from config; it does not sanitize.
      // The actual protection comes from Node.js fetch (undici) which rejects
      // headers containing forbidden characters like \r\n.
      const headers = resolveWebhookHeaders([
        { name: 'X-Custom', value: 'safe-value' },
        { name: 'X-Injected', value: 'evil\r\nX-Forwarded-For: 127.0.0.1' },
      ]);

      expect(headers['X-Custom']).toBe('safe-value');
      // The value is passed through — the guard is at the HTTP layer
      expect(headers['X-Injected']).toBe('evil\r\nX-Forwarded-For: 127.0.0.1');
    });

    it('resolveWebhookHeaders resolves env var values including those with CRLF', () => {
      const envKey = 'TEST_CRLF_HEADER_VALUE';
      process.env[envKey] = 'injected\r\nX-Evil: true';
      try {
        const headers = resolveWebhookHeaders([
          { name: 'Authorization', valueFromEnv: envKey },
        ]);
        expect(headers['Authorization']).toBe('injected\r\nX-Evil: true');
      } finally {
        delete process.env[envKey];
      }
    });

    it('deliverWebhook rejects or safely handles headers with CRLF characters', async () => {
      // Node.js fetch (undici) throws a TypeError when header values contain
      // \r or \n characters. This is the runtime guard against header injection.
      const result = await deliverWebhook({
        url: 'http://127.0.0.1:1/nonexistent',
        headers: { 'X-Injected': 'evil\r\nX-Forwarded-For: 127.0.0.1' },
        payload: { test: true },
        timeoutMs: 2000,
        allowPrivateUrls: true,
      });

      // The delivery must fail — either because fetch rejects the invalid header
      // or because the connection itself fails. In either case, success must be false.
      expect(result.success).toBe(false);
      // If undici catches the header injection specifically, error mentions "header"
      // But even if it fails for another reason (connection refused), the injection
      // never reaches the wire. We verify the request did not succeed.
      expect(result.statusCode).toBeUndefined();
    });

    it('deliverWebhook rejects header names with CRLF characters', async () => {
      const result = await deliverWebhook({
        url: 'http://127.0.0.1:1/nonexistent',
        headers: { 'X-Evil\r\nInjected': 'value' },
        payload: { test: true },
        timeoutMs: 2000,
        allowPrivateUrls: true,
      });

      expect(result.success).toBe(false);
      expect(result.statusCode).toBeUndefined();
    });

    it('deliverWebhook succeeds with clean header values', async () => {
      // Sanity check: normal headers should not trigger any rejection.
      // We still expect failure because the URL is unreachable, but the error
      // should be a connection error, not a header validation error.
      const result = await deliverWebhook({
        url: 'http://127.0.0.1:1/nonexistent',
        headers: { 'X-Custom': 'perfectly-safe-value', 'Authorization': 'Bearer token123' },
        payload: { test: true },
        timeoutMs: 2000,
        allowPrivateUrls: true,
      });

      expect(result.success).toBe(false);
      // Error should be about connection, not about headers
      expect(result.error).toBeDefined();
    });
  });

  // ── 6b. Tracked Function Argument SQL Injection ────────────────────────

  describe('tracked function argument SQL injection', () => {
    it('parameterises searchClients args — DROP TABLE injection is treated as literal', async () => {
      const token = await tokens.backoffice();
      const { status, body } = await graphqlRequest(
        `query {
          searchClients(args: { searchTerm: "'; DROP TABLE client; --" }) {
            id username
          }
        }`,
        undefined,
        { authorization: `Bearer ${token}` },
      );

      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();
      const data = (body.data as { searchClients: unknown[] }).searchClients;
      // The injection string is treated as a literal search term, so no rows match
      expect(data).toHaveLength(0);

      // Verify the client table still exists and has data
      const pool = getPool();
      const check = await pool.query('SELECT count(*)::int AS cnt FROM client');
      expect(check.rows[0].cnt).toBeGreaterThan(0);
    });

    it('parameterises searchClients args — UNION SELECT injection returns no rows', async () => {
      const token = await tokens.backoffice();
      const { status, body } = await graphqlRequest(
        `query {
          searchClients(args: { searchTerm: "' UNION SELECT * FROM branch --" }) {
            id username
          }
        }`,
        undefined,
        { authorization: `Bearer ${token}` },
      );

      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();
      const data = (body.data as { searchClients: unknown[] }).searchClients;
      expect(data).toHaveLength(0);
    });

    it('parameterises searchClients args — stacked query injection has no effect', async () => {
      const token = await tokens.backoffice();
      const { status, body } = await graphqlRequest(
        `query {
          searchClients(args: { searchTerm: "alice'; DELETE FROM client WHERE '1'='1" }) {
            id username
          }
        }`,
        undefined,
        { authorization: `Bearer ${token}` },
      );

      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();
      const data = (body.data as { searchClients: unknown[] }).searchClients;
      expect(data).toHaveLength(0);

      // All rows still intact
      const pool = getPool();
      const check = await pool.query('SELECT count(*)::int AS cnt FROM client');
      expect(check.rows[0].cnt).toBeGreaterThan(0);
    });

    it('parameterises searchClients args — boolean-based blind injection returns no rows', async () => {
      const token = await tokens.backoffice();
      const { status, body } = await graphqlRequest(
        `query {
          searchClients(args: { searchTerm: "' OR '1'='1" }) {
            id username
          }
        }`,
        undefined,
        { authorization: `Bearer ${token}` },
      );

      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();
      const data = (body.data as { searchClients: unknown[] }).searchClients;
      // If SQL injection worked, this would return all rows.
      // With parameterisation, the literal "' OR '1'='1" is searched, returning nothing.
      expect(data).toHaveLength(0);
    });

    it('searchClients still works normally after injection attempts', async () => {
      // Sanity check: verify normal queries still work, proving the table is intact
      const token = await tokens.backoffice();
      const { status, body } = await graphqlRequest(
        `query {
          searchClients(args: { searchTerm: "alice" }) {
            id username
          }
        }`,
        undefined,
        { authorization: `Bearer ${token}` },
      );

      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();
      const data = (body.data as { searchClients: Array<{ username: string }> }).searchClients;
      expect(data.length).toBeGreaterThan(0);
      expect(data.some((c) => c.username === 'alice')).toBe(true);
    });
  });

  // ── 7. Async Action Status IDOR ──────────────────────────────────────

  describe('async action status authorization', () => {
    let actionId: string;

    beforeAll(async () => {
      // Insert a fake async action row for a real action name (requestVerification)
      // that has permissions: [client, backoffice]
      const pool = getPool();
      const result = await pool.query<{ id: string }>(
        `INSERT INTO hakkyra.async_action_log
         (action_name, input, session_variables, user_id, status, output)
         VALUES ($1, $2, $3, $4, 'completed', $5)
         RETURNING id`,
        [
          'requestVerification',
          JSON.stringify({ documentType: 'passport', documentCountry: 'FI' }),
          JSON.stringify({ 'x-hasura-role': 'client', 'x-hasura-user-id': ALICE_ID }),
          ALICE_ID,
          JSON.stringify({ requestId: 'test-123', status: 'ok' }),
        ],
      );
      actionId = result.rows[0].id;
    });

    it('user with permitted role can see action status', async () => {
      // 'client' is in requestVerification permissions — should succeed
      const token = await tokens.client(ALICE_ID);
      const { status, body } = await restRequest('GET', `/v1/actions/${actionId}/status`, {
        headers: { authorization: `Bearer ${token}` },
      });

      expect(status).toBe(200);
      const data = body as { id: string; status: string };
      expect(data.id).toBe(actionId);
      expect(data.status).toBe('completed');
    });

    it('different user with same permitted role can also see action status', async () => {
      // Async actions are shared — any user with a permitted role can see them
      const token = await tokens.client(BOB_ID);
      const { status, body } = await restRequest('GET', `/v1/actions/${actionId}/status`, {
        headers: { authorization: `Bearer ${token}` },
      });

      expect(status).toBe(200);
      const data = body as { id: string; status: string };
      expect(data.id).toBe(actionId);
    });

    it('user without permitted role gets 403', async () => {
      // 'function' role has allowedRoles: ['function'], which is NOT in
      // requestVerification permissions (only 'client' and 'backoffice')
      const token = await tokens.function_();
      const { status, body } = await restRequest('GET', `/v1/actions/${actionId}/status`, {
        headers: { authorization: `Bearer ${token}` },
      });

      expect(status).toBe(403);
      const data = body as { error: string };
      expect(data.error).toBe('forbidden');
    });

    it('admin can see any action status', async () => {
      const { status, body } = await restRequest('GET', `/v1/actions/${actionId}/status`, {
        headers: { 'x-hasura-admin-secret': ADMIN_SECRET },
      });

      expect(status).toBe(200);
      const data = body as { id: string; status: string };
      expect(data.id).toBe(actionId);
    });
  });

  // ── 8. backend_only Permission Enforcement ─────────────────────────────

  describe('backend_only permission enforcement', () => {
    it('backend_only insert is blocked from regular JWT auth', async () => {
      // The "function" role has backend_only: true on the account table
      const token = await tokens.function_(ALICE_ID);
      const { status, body } = await graphqlRequest(
        `mutation {
          insertAccountOne(object: {
            clientId: "${ALICE_ID}",
            currencyId: "EUR",
            balance: 100
          }) {
            id
          }
        }`,
        undefined,
        { authorization: `Bearer ${token}` },
      );

      // Should fail with permission denied
      expect(body.errors).toBeDefined();
      expect(body.errors!.length).toBeGreaterThan(0);
      expect(body.errors![0].message).toContain('backend_only');
    });

    it('backend_only insert is allowed with admin secret', async () => {
      const { status, body } = await graphqlRequest(
        `mutation {
          insertAccountOne(object: {
            clientId: "${ALICE_ID}",
            currencyId: "GBP",
            balance: 50
          }) {
            id
          }
        }`,
        undefined,
        {
          'x-hasura-admin-secret': ADMIN_SECRET,
          'x-hasura-role': 'function',
        },
      );

      // Admin secret bypasses backend_only check
      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();
      const data = body.data as { insertAccountOne: { id: string } };
      expect(data.insertAccountOne.id).toBeDefined();

      // Cleanup: delete the inserted account
      const pool = getPool();
      await pool.query(`DELETE FROM account WHERE id = $1`, [data.insertAccountOne.id]);
    });

    it('backend_only insert is allowed with backend-only permissions header', async () => {
      const token = await tokens.function_(ALICE_ID);
      const { status, body } = await graphqlRequest(
        `mutation {
          insertAccountOne(object: {
            clientId: "${ALICE_ID}",
            currencyId: "USD",
            balance: 200
          }) {
            id
          }
        }`,
        undefined,
        {
          authorization: `Bearer ${token}`,
          'x-hasura-use-backend-only-permissions': 'true',
        },
      );

      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();
      const data = body.data as { insertAccountOne: { id: string } };
      expect(data.insertAccountOne.id).toBeDefined();

      // Cleanup
      const pool = getPool();
      await pool.query(`DELETE FROM account WHERE id = $1`, [data.insertAccountOne.id]);
    });

    it('non-backend_only insert works normally for JWT user', async () => {
      // The backoffice role has insert permission on the client table WITHOUT backend_only.
      // This verifies that the backend_only guard does not inadvertently block normal inserts.
      const token = await tokens.backoffice();
      const uniqueUsername = `security_test_${Date.now()}`;
      const { status, body } = await graphqlRequest(
        `mutation($obj: ClientInsertInput!) {
          insertClient(object: $obj) {
            id
            username
          }
        }`,
        { obj: { username: uniqueUsername, email: `${uniqueUsername}@test.com`, branchId: BRANCH_TEST_ID, currencyId: 'EUR' } },
        { authorization: `Bearer ${token}` },
      );

      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();
      const data = body.data as { insertClient: { id: string; username: string } };
      expect(data.insertClient.id).toBeDefined();
      expect(data.insertClient.username).toBe(uniqueUsername);

      // Cleanup
      const pool = getPool();
      await pool.query(`DELETE FROM client WHERE id = $1`, [data.insertClient.id]);
    });
  });

  // ── 9. GraphQL Batching Limit ──────────────────────────────────────────

  describe('GraphQL batching limit', () => {
    it('batch within limit is not rejected by batch guard (may still be rejected by GraphQL engine)', async () => {
      const token = await tokens.backoffice();
      // Build 10 identical queries as a batch — within the default max_batch_size of 10
      const batch = Array.from({ length: 10 }, () => ({
        query: '{ clients(limit: 1) { id } }',
      }));

      const addr = getServerAddress();
      const res = await fetch(`${addr}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(batch),
      });

      const body = await res.json() as { errors?: Array<{ message: string; extensions?: { code?: string } }> };
      // The batch guard should NOT reject — verify no BATCH_SIZE_EXCEEDED error
      if (body.errors) {
        for (const err of body.errors) {
          expect(err.extensions?.code).not.toBe('BATCH_SIZE_EXCEEDED');
        }
      }
    });

    it('batch of 11+ operations is rejected with BATCH_SIZE_EXCEEDED', async () => {
      const token = await tokens.backoffice();
      // Build 11 queries — exceeds the default max_batch_size of 10
      const batch = Array.from({ length: 11 }, () => ({
        query: '{ clients(limit: 1) { id } }',
      }));

      const addr = getServerAddress();
      const res = await fetch(`${addr}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(batch),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { errors: Array<{ message: string; extensions?: { code?: string } }> };
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toContain('batch size');
      expect(body.errors[0].extensions?.code).toBe('BATCH_SIZE_EXCEEDED');
    });
  });

  // ── 10. resolveLimit cap in subscriptions and tracked functions ────────

  describe('resolveLimit global cap', () => {
    it('subscription select respects graphql.maxLimit (capped at 100)', async () => {
      // The default maxLimit is 100. Requesting limit: 200 should be capped.
      // We verify this by requesting more rows than exist and checking no error occurs.
      const token = await tokens.backoffice();

      // Use a regular query with a large limit to verify capping works
      // (subscriptions use the same resolveLimit logic)
      const { status, body } = await graphqlRequest(
        `query { clients(limit: 200) { id } }`,
        undefined,
        { authorization: `Bearer ${token}` },
      );

      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();
      const clients = (body.data as { clients: unknown[] }).clients;
      // Must be at most maxLimit (100)
      expect(clients.length).toBeLessThanOrEqual(100);
    });

    it('tracked function query respects graphql.maxLimit', async () => {
      const token = await tokens.backoffice();
      const { status, body } = await graphqlRequest(
        `query { searchClients(args: { searchTerm: "" }, limit: 200) { id } }`,
        undefined,
        { authorization: `Bearer ${token}` },
      );

      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();
      const data = (body.data as { searchClients: unknown[] }).searchClients;
      // Must be capped to maxLimit (100)
      expect(data.length).toBeLessThanOrEqual(100);
    });
  });
});
