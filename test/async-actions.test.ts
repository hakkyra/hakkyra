/**
 * Integration tests for Async Actions.
 *
 * Tests the full async action pipeline:
 * GraphQL mutation → enqueue → job worker → webhook → result storage → query
 *
 * Uses real PostgreSQL + pg-boss and a mock webhook server.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool as PoolType } from 'pg';
import pg from 'pg';
import { MockWebhookServer } from './helpers/mock-webhook.js';
import {
  TEST_DB_URL,
  METADATA_DIR,
  SERVER_CONFIG_PATH,
  ADMIN_SECRET,
  ALICE_ID,
  BOB_ID,
  waitForDb,
  createJWT,
} from './setup.js';

const { Pool } = pg;

// ─── Test State ──────────────────────────────────────────────────────────────

let server: FastifyInstance;
let serverAddress: string;
let webhook: MockWebhookServer;
let pool: PoolType;

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function gql(
  query: string,
  variables?: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<{ status: number; body: { data?: unknown; errors?: Array<{ message: string; extensions?: Record<string, unknown> }> } }> {
  const res = await fetch(`${serverAddress}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json() as { data?: unknown; errors?: Array<{ message: string; extensions?: Record<string, unknown> }> };
  return { status: res.status, body };
}

/**
 * Wait for an async action to reach a specific status, polling the DB.
 */
async function waitForActionStatus(
  actionId: string,
  targetStatus: string,
  timeoutMs: number = 15000,
  pollMs: number = 200,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await pool.query(
      `SELECT status FROM hakkyra.async_action_log WHERE id = $1`,
      [actionId],
    );
    if (result.rows.length > 0 && result.rows[0].status === targetStatus) {
      return;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`Action ${actionId} did not reach status "${targetStatus}" within ${timeoutMs}ms`);
}

// ─── Setup / Teardown ────────────────────────────────────────────────────────

beforeAll(async () => {
  await waitForDb();

  // Create a pool for direct DB queries in tests
  pool = new Pool({ connectionString: TEST_DB_URL, max: 3 });

  // Start mock webhook server
  webhook = new MockWebhookServer();
  await webhook.start();

  // Set env vars
  process.env['DATABASE_URL'] = TEST_DB_URL;
  process.env['HAKKYRA_ADMIN_SECRET'] = ADMIN_SECRET;
  process.env['LOG_LEVEL'] = 'error';
  process.env['NODE_ENV'] = 'test';
  process.env['ACTION_SECRET'] = 'test-action-secret';
  process.env['SERVICE_PROVIDER_KEY'] = 'test-service-key';

  // Load config and override action handler URLs to point at mock
  const { loadConfig } = await import('../src/config/loader.js');
  const config = await loadConfig(METADATA_DIR, SERVER_CONFIG_PATH);

  for (const action of config.actions) {
    action.definition.handler = action.definition.handler.replace(
      '{{TEST_SERVER_URL}}',
      webhook.baseUrl,
    );
  }

  // Start server with modified config
  const { createServer } = await import('../src/server.js');
  server = await createServer(config);
  serverAddress = await server.listen({ port: 0, host: '127.0.0.1' });
}, 30_000);

afterAll(async () => {
  if (server) await server.close();
  if (webhook) await webhook.stop();
  if (pool) await pool.end();
}, 15_000);

beforeEach(() => {
  webhook.reset();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Async Actions', () => {
  describe('schema integration', () => {
    let sdl: string;

    beforeAll(async () => {
      const res = await fetch(`${serverAddress}/sdl`, { headers: { 'x-hasura-admin-secret': ADMIN_SECRET } });
      sdl = await res.text();
    });

    it('registers async action mutation with uuid! return type (Hasura-compatible)', () => {
      // requestVerification is configured as async in actions.yaml
      // Hasura returns uuid! for async mutations, not a wrapper type
      expect(sdl).toContain('requestVerification(input: RequestVerificationInput!): Uuid!');
    });

    it('registers async action result query with handler return type (Hasura-compatible)', () => {
      // Hasura uses the action's handler return type directly, not a wrapper
      expect(sdl).toContain('requestVerification(id: Uuid!): VerificationRequestResult');
    });

    it('does not generate AsyncActionId wrapper type', () => {
      expect(sdl).not.toContain('type AsyncActionId');
    });

    it('does not generate per-action AsyncResult wrapper type', () => {
      expect(sdl).not.toContain('type RequestVerificationAsyncResult');
    });

    it('keeps sync actions unchanged', () => {
      // createPayment is synchronous — should still have its normal return type
      expect(sdl).toContain('createPayment(input: CreatePaymentInput!): PaymentResult');
      // Should NOT have a result query for sync actions
      expect(sdl).not.toContain('createPayment(id: Uuid!)');
    });

    it('does not generate AsyncActionStatus enum', () => {
      expect(sdl).not.toContain('enum AsyncActionStatus');
    });
  });

  describe('async mutation execution', () => {
    it('returns action ID (uuid) immediately without calling webhook', async () => {
      const token = await createJWT({ role: 'client', userId: ALICE_ID, allowedRoles: ['client'] });

      // Do NOT register a webhook handler — the mutation should return before the webhook is called
      const { body } = await gql(
        `mutation($input: RequestVerificationInput!) {
          requestVerification(input: $input)
        }`,
        {
          input: {
            documentType: 'passport',
            documentCountry: 'FI',
          },
        },
        { authorization: `Bearer ${token}` },
      );

      expect(body.errors).toBeUndefined();
      const data = body.data as any;
      expect(data.requestVerification).toBeDefined();
      // Returns UUID string directly (Hasura-compatible)
      expect(data.requestVerification).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });

    it('stores action input and session variables in the database', async () => {
      const token = await createJWT({ role: 'client', userId: ALICE_ID, allowedRoles: ['client'] });

      // Set up webhook to succeed (will be called by worker)
      webhook.onPath('/actions/request-verification', () => ({
        code: 200,
        body: {
          requestId: 'a0000000-0000-0000-0000-000000000099',
          status: 'pending',
          verificationUrl: 'https://verify.example.com/123',
        },
      }));

      const { body } = await gql(
        `mutation($input: RequestVerificationInput!) {
          requestVerification(input: $input)
        }`,
        {
          input: {
            documentType: 'id_card',
            documentCountry: 'SE',
          },
        },
        { authorization: `Bearer ${token}` },
      );

      const actionId = (body.data as any).requestVerification;

      // Check the DB row
      const row = await pool.query(
        `SELECT action_name, input, session_variables, status
         FROM hakkyra.async_action_log WHERE id = $1`,
        [actionId],
      );

      expect(row.rows.length).toBe(1);
      expect(row.rows[0].action_name).toBe('requestVerification');
      expect(row.rows[0].input).toEqual({
        documentType: 'id_card',
        documentCountry: 'SE',
      });
      expect(row.rows[0].session_variables['x-hasura-role']).toBe('client');
      expect(row.rows[0].session_variables['x-hasura-user-id']).toBe(ALICE_ID);
    });
  });

  describe('worker processing', () => {
    it('worker calls webhook and stores successful result', async () => {
      const token = await createJWT({ role: 'client', userId: ALICE_ID, allowedRoles: ['client'] });

      // Use a unique country code to identify this test's webhook call
      const uniqueCountry = 'US';
      const expectedOutput = {
        requestId: 'a0000000-0000-0000-0000-000000000001',
        status: 'pending',
        verificationUrl: 'https://verify.example.com/abc',
      };

      webhook.onPath('/actions/request-verification', () => ({
        code: 200,
        body: expectedOutput,
      }));

      const { body } = await gql(
        `mutation($input: RequestVerificationInput!) {
          requestVerification(input: $input)
        }`,
        {
          input: {
            documentType: 'passport',
            documentCountry: uniqueCountry,
          },
        },
        { authorization: `Bearer ${token}` },
      );

      const actionId = (body.data as any).requestVerification;

      // Wait for the worker to process the job
      await waitForActionStatus(actionId, 'completed');

      // Verify the webhook was called with a payload for this action
      await webhook.waitForRequests(1);
      const reqs = webhook.requests.filter((r) => r.url === '/actions/request-verification');
      expect(reqs.length).toBeGreaterThanOrEqual(1);

      // Find the request that matches our specific action by checking the input
      const matchingReq = reqs.find((r) => {
        const p = r.body as any;
        return p?.input?.documentCountry === uniqueCountry;
      });
      expect(matchingReq).toBeDefined();

      // Verify the payload sent to the webhook is Hasura-compatible
      const payload = matchingReq!.body as any;
      expect(payload.action.name).toBe('requestVerification');
      expect(payload.session_variables['x-hasura-role']).toBe('client');

      // Verify result stored in DB
      const row = await pool.query(
        `SELECT status, output FROM hakkyra.async_action_log WHERE id = $1`,
        [actionId],
      );
      expect(row.rows[0].status).toBe('completed');
      expect(row.rows[0].output).toEqual(expectedOutput);
    });

    it('worker stores failure when webhook returns error', async () => {
      const token = await createJWT({ role: 'backoffice', allowedRoles: ['backoffice', 'client'] });

      webhook.onPath('/actions/request-verification', () => ({
        code: 500,
        body: { message: 'Verification service unavailable' },
      }));

      const { body } = await gql(
        `mutation($input: RequestVerificationInput!) {
          requestVerification(input: $input)
        }`,
        {
          input: {
            documentType: 'driver_license',
            documentCountry: 'UK',
          },
        },
        { authorization: `Bearer ${token}` },
      );

      const actionId = (body.data as any).requestVerification;

      // Wait for the worker to process (it will fail)
      await waitForActionStatus(actionId, 'failed', 20000);

      // Verify failure stored in DB
      const row = await pool.query(
        `SELECT status, errors FROM hakkyra.async_action_log WHERE id = $1`,
        [actionId],
      );
      expect(row.rows[0].status).toBe('failed');
      expect(row.rows[0].errors).toBeDefined();
      expect(row.rows[0].errors.message).toBeDefined();
    }, 25_000);
  });

  describe('result query', () => {
    it('queries completed action result via GraphQL', async () => {
      const token = await createJWT({ role: 'client', userId: ALICE_ID, allowedRoles: ['client'] });

      webhook.onPath('/actions/request-verification', () => ({
        code: 200,
        body: {
          requestId: 'a0000000-0000-0000-0000-000000000002',
          status: 'verified',
          verificationUrl: 'https://verify.example.com/done',
        },
      }));

      // Enqueue the async action
      const { body: mutBody } = await gql(
        `mutation($input: RequestVerificationInput!) {
          requestVerification(input: $input)
        }`,
        {
          input: {
            documentType: 'passport',
            documentCountry: 'DE',
          },
        },
        { authorization: `Bearer ${token}` },
      );

      const actionId = (mutBody.data as any).requestVerification;

      // Wait for completion
      await waitForActionStatus(actionId, 'completed');

      // Query the result — returns the action's output type directly (Hasura-compatible)
      const { body: queryBody } = await gql(
        `query($id: Uuid!) {
          requestVerification(id: $id) {
            requestId
            status
            verificationUrl
          }
        }`,
        { id: actionId },
        { authorization: `Bearer ${token}` },
      );

      expect(queryBody.errors).toBeUndefined();
      const result = (queryBody.data as any).requestVerification;
      expect(result).toBeDefined();
      expect(result).toEqual({
        requestId: 'a0000000-0000-0000-0000-000000000002',
        status: 'verified',
        verificationUrl: 'https://verify.example.com/done',
      });
    });

    it('returns null for non-existent action ID', async () => {
      const token = await createJWT({ role: 'client', userId: ALICE_ID, allowedRoles: ['client'] });

      const { body } = await gql(
        `query($id: Uuid!) {
          requestVerification(id: $id) {
            requestId
            status
          }
        }`,
        { id: '00000000-0000-0000-0000-000000000000' },
        { authorization: `Bearer ${token}` },
      );

      expect(body.errors).toBeUndefined();
      expect((body.data as any).requestVerification).toBeNull();
    });
  });

  describe('permission enforcement', () => {
    it('denies async action mutation for non-permitted roles', async () => {
      // requestVerification allows 'client' and 'backoffice' — 'administrator' is not listed
      const token = await createJWT({ role: 'administrator', allowedRoles: ['administrator'] });

      const { body } = await gql(
        `mutation($input: RequestVerificationInput!) {
          requestVerification(input: $input)
        }`,
        {
          input: {
            documentType: 'passport',
            documentCountry: 'FI',
          },
        },
        { authorization: `Bearer ${token}` },
      );

      expect(body.errors).toBeDefined();
      expect(body.errors![0].message).toContain('Not authorized');
      expect(body.errors![0].extensions?.code).toBe('FORBIDDEN');
    });

    it('denies result query for non-permitted roles', async () => {
      const token = await createJWT({ role: 'administrator', allowedRoles: ['administrator'] });

      const { body } = await gql(
        `query($id: Uuid!) {
          requestVerification(id: $id) {
            requestId
            status
          }
        }`,
        { id: '00000000-0000-0000-0000-000000000000' },
        { authorization: `Bearer ${token}` },
      );

      expect(body.errors).toBeDefined();
      expect(body.errors![0].extensions?.code).toBe('FORBIDDEN');
    });

    it('allows admin to execute async action and query result', async () => {
      webhook.onPath('/actions/request-verification', () => ({
        code: 200,
        body: {
          requestId: 'a0000000-0000-0000-0000-000000000003',
          status: 'ok',
        },
      }));

      const { body } = await gql(
        `mutation($input: RequestVerificationInput!) {
          requestVerification(input: $input)
        }`,
        {
          input: {
            documentType: 'passport',
            documentCountry: 'FI',
          },
        },
        { 'x-hasura-admin-secret': ADMIN_SECRET },
      );

      expect(body.errors).toBeUndefined();
      const actionId = (body.data as any).requestVerification;
      expect(actionId).toBeDefined();

      // Wait for completion
      await waitForActionStatus(actionId, 'completed');

      // Query result as admin — returns the action's output type directly
      const { body: queryBody } = await gql(
        `query($id: Uuid!) {
          requestVerification(id: $id) {
            requestId
            status
          }
        }`,
        { id: actionId },
        { 'x-hasura-admin-secret': ADMIN_SECRET },
      );

      expect(queryBody.errors).toBeUndefined();
      expect((queryBody.data as any).requestVerification.status).toBe('ok');
    });
  });

  describe('REST status endpoint', () => {
    it('returns action status via REST API', async () => {
      const token = await createJWT({ role: 'client', userId: ALICE_ID, allowedRoles: ['client'] });

      webhook.onPath('/actions/request-verification', () => ({
        code: 200,
        body: {
          requestId: 'a0000000-0000-0000-0000-000000000004',
          status: 'ok',
          verificationUrl: null,
        },
      }));

      // Enqueue an async action
      const { body } = await gql(
        `mutation($input: RequestVerificationInput!) {
          requestVerification(input: $input)
        }`,
        {
          input: {
            documentType: 'passport',
            documentCountry: 'NO',
          },
        },
        { authorization: `Bearer ${token}` },
      );

      const actionId = (body.data as any).requestVerification;

      // Wait for completion
      await waitForActionStatus(actionId, 'completed');

      // Query status via REST
      const res = await fetch(`${serverAddress}/v1/actions/${actionId}/status`, {
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(200);
      const statusBody = await res.json() as any;
      expect(statusBody.id).toBe(actionId);
      expect(statusBody.action_name).toBe('requestVerification');
      expect(statusBody.status).toBe('completed');
      expect(statusBody.output).toBeDefined();
    });

    it('returns 404 for non-existent action ID', async () => {
      const token = await createJWT({ role: 'client', userId: ALICE_ID, allowedRoles: ['client'] });

      const res = await fetch(
        `${serverAddress}/v1/actions/00000000-0000-0000-0000-000000000000/status`,
        { headers: { authorization: `Bearer ${token}` } },
      );

      expect(res.status).toBe(404);
    });

    it('returns 404 for unauthenticated requests with non-existent action (anonymous role)', async () => {
      // The server has `unauthorized_role: anonymous` configured, so
      // unauthenticated requests get a session with role 'anonymous'.
      // The action ID doesn't exist, so 404 is returned before permission check.
      const res = await fetch(
        `${serverAddress}/v1/actions/00000000-0000-0000-0000-000000000000/status`,
      );

      expect(res.status).toBe(404);
    });
  });

  describe('REST status endpoint authorization', () => {
    let sharedActionId: string;

    // Create a shared async action (as 'client' role) that authorization tests query against
    beforeAll(async () => {
      const token = await createJWT({ role: 'client', userId: ALICE_ID, allowedRoles: ['client'] });

      webhook.onPath('/actions/request-verification', () => ({
        code: 200,
        body: {
          requestId: 'a0000000-0000-0000-0000-000000000099',
          status: 'ok',
          verificationUrl: null,
        },
      }));

      const { body } = await gql(
        `mutation($input: RequestVerificationInput!) {
          requestVerification(input: $input)
        }`,
        {
          input: {
            documentType: 'passport',
            documentCountry: 'JP',
          },
        },
        { authorization: `Bearer ${token}` },
      );

      sharedActionId = (body.data as any).requestVerification;
      await waitForActionStatus(sharedActionId, 'completed');
    });

    it('user with permitted role can see action status', async () => {
      // requestVerification permits 'client' and 'backoffice' roles
      const token = await createJWT({ role: 'client', userId: BOB_ID, allowedRoles: ['client'] });

      const res = await fetch(`${serverAddress}/v1/actions/${sharedActionId}/status`, {
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(200);
      const statusBody = await res.json() as any;
      expect(statusBody.id).toBe(sharedActionId);
      expect(statusBody.status).toBe('completed');
    });

    it('user with different permitted role can also see action status', async () => {
      // 'backoffice' is also in requestVerification permissions
      const token = await createJWT({ role: 'backoffice', allowedRoles: ['backoffice'] });

      const res = await fetch(`${serverAddress}/v1/actions/${sharedActionId}/status`, {
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(200);
      const statusBody = await res.json() as any;
      expect(statusBody.id).toBe(sharedActionId);
      expect(statusBody.status).toBe('completed');
    });

    it('user without any permitted role gets 403', async () => {
      // 'administrator' is NOT in requestVerification permissions (only 'client' and 'backoffice')
      const token = await createJWT({ role: 'administrator', allowedRoles: ['administrator'] });

      const res = await fetch(`${serverAddress}/v1/actions/${sharedActionId}/status`, {
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(403);
      const errorBody = await res.json() as any;
      expect(errorBody.error).toBe('forbidden');
    });

    it('admin can see any action status', async () => {
      const res = await fetch(`${serverAddress}/v1/actions/${sharedActionId}/status`, {
        headers: { 'x-hasura-admin-secret': ADMIN_SECRET },
      });

      expect(res.status).toBe(200);
      const statusBody = await res.json() as any;
      expect(statusBody.id).toBe(sharedActionId);
      expect(statusBody.status).toBe('completed');
    });

    it('unauthenticated request to existing action gets 403 (anonymous role)', async () => {
      // With unauthorized_role: anonymous, the request gets a session but
      // 'anonymous' is not in requestVerification's permissions.
      const res = await fetch(`${serverAddress}/v1/actions/${sharedActionId}/status`);

      expect(res.status).toBe(403);
      const errorBody = await res.json() as any;
      expect(errorBody.error).toBe('forbidden');
    });
  });
});
