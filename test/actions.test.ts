/**
 * Integration tests for the Actions system.
 *
 * Tests the full action pipeline:
 * GraphQL query/mutation → permission check → webhook proxy → response parsing
 *
 * Uses real PostgreSQL and a mock webhook server.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { MockWebhookServer } from './helpers/mock-webhook.js';
import {
  TEST_DB_URL,
  METADATA_DIR,
  SERVER_CONFIG_PATH,
  ADMIN_SECRET,
  ALICE_ID,
  waitForDb,
  createJWT,
} from './setup.js';

// ─── Test State ──────────────────────────────────────────────────────────────

let server: FastifyInstance;
let serverAddress: string;
let webhook: MockWebhookServer;

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

// ─── Setup / Teardown ────────────────────────────────────────────────────────

beforeAll(async () => {
  await waitForDb();

  // Start mock webhook server first
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
    // Replace {{TEST_SERVER_URL}} placeholder with real mock server URL
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
}, 15_000);

beforeEach(() => {
  webhook.reset();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Actions', () => {
  describe('schema integration', () => {
    // Use the /sdl endpoint to verify schema structure, avoiding the ESM/CJS
    // dual graphql module issue that affects __schema introspection via Mercurius.

    let sdl: string;

    beforeAll(async () => {
      const res = await fetch(`${serverAddress}/sdl`);
      sdl = await res.text();
    });

    it('registers action mutations in the schema', () => {
      expect(sdl).toContain('createPayment(input: CreatePaymentInput!): PaymentResult');
      expect(sdl).toContain('adjustAccount(input: AdjustAccountInput!): AdjustAccountResult');
      expect(sdl).toContain('requestVerification(input: RequestVerificationInput!): AsyncActionId!');
      expect(sdl).toContain('scheduleConsultation(input: ScheduleConsultationInput!): ScheduleConsultationResult');
      expect(sdl).toContain('processService(input: ProcessServiceInput!): ProcessServiceResult');
    });

    it('registers action queries in the schema', () => {
      expect(sdl).toContain('checkDiscountEligibility(input: CheckDiscountEligibilityInput!): DiscountEligibilityResult');
    });

    it('generates correct input types from actions.graphql', () => {
      expect(sdl).toContain('input CreatePaymentInput');
      expect(sdl).toMatch(/input CreatePaymentInput\s*\{[^}]*amount:\s*Float!/);
      expect(sdl).toMatch(/input CreatePaymentInput\s*\{[^}]*currencyId:\s*String!/);
      expect(sdl).toMatch(/input CreatePaymentInput\s*\{[^}]*provider:\s*String/);
      expect(sdl).toMatch(/input CreatePaymentInput\s*\{[^}]*returnUrl:\s*String/);
    });

    it('generates correct output types from actions.graphql', () => {
      expect(sdl).toContain('type PaymentResult');
      expect(sdl).toMatch(/type PaymentResult\s*\{[^}]*invoiceId:\s*Uuid!/);
      expect(sdl).toMatch(/type PaymentResult\s*\{[^}]*redirectUrl:\s*String/);
      expect(sdl).toMatch(/type PaymentResult\s*\{[^}]*status:\s*String!/);
    });
  });

  describe('mutation execution', () => {
    it('executes a sync mutation and returns webhook response', async () => {
      const token = await createJWT({ role: 'client', userId: ALICE_ID, allowedRoles: ['client'] });

      webhook.onPath('/actions/create-payment', () => ({
        code: 200,
        body: {
          invoiceId: 'f0000000-0000-0000-0000-000000000099',
          redirectUrl: 'https://pay.example.com/checkout/123',
          status: 'pending',
        },
      }));

      const { body } = await gql(
        `mutation($input: CreatePaymentInput!) {
          createPayment(input: $input) {
            invoiceId
            redirectUrl
            status
          }
        }`,
        {
          input: {
            amount: 99.99,
            currencyId: 'usd',
            provider: 'stripe',
            returnUrl: 'https://app.example.com/done',
          },
        },
        { authorization: `Bearer ${token}` },
      );

      expect(body.errors).toBeUndefined();
      expect((body.data as any).createPayment).toEqual({
        invoiceId: 'f0000000-0000-0000-0000-000000000099',
        redirectUrl: 'https://pay.example.com/checkout/123',
        status: 'pending',
      });
    });

    it('sends Hasura-compatible webhook payload', async () => {
      const token = await createJWT({ role: 'client', userId: ALICE_ID, allowedRoles: ['client'] });

      webhook.onPath('/actions/create-payment', () => ({
        code: 200,
        body: {
          invoiceId: 'f0000000-0000-0000-0000-000000000001',
          status: 'ok',
        },
      }));

      await gql(
        `mutation($input: CreatePaymentInput!) {
          createPayment(input: $input) { status }
        }`,
        { input: { amount: 10, currencyId: 'usd' } },
        { authorization: `Bearer ${token}` },
      );

      const [req] = webhook.requests;
      expect(req).toBeDefined();
      expect(req.url).toBe('/actions/create-payment');

      const payload = req.body as any;
      expect(payload.action).toEqual({ name: 'createPayment' });
      expect(payload.input).toEqual({ amount: 10, currencyId: 'usd' });
      expect(payload.session_variables).toBeDefined();
      expect(payload.session_variables['x-hasura-role']).toBe('client');
      expect(payload.session_variables['x-hasura-user-id']).toBe(ALICE_ID);
    });

    it('forwards configured headers to webhook', async () => {
      const token = await createJWT({ role: 'client', userId: ALICE_ID, allowedRoles: ['client'] });

      webhook.onPath('/actions/create-payment', () => ({
        code: 200,
        body: { invoiceId: 'f0000000-0000-0000-0000-000000000001', status: 'ok' },
      }));

      await gql(
        `mutation($input: CreatePaymentInput!) {
          createPayment(input: $input) { status }
        }`,
        { input: { amount: 10, currencyId: 'usd' } },
        { authorization: `Bearer ${token}` },
      );

      const [req] = webhook.requests;
      // ACTION_SECRET env var is set to 'test-action-secret'
      expect(req.headers['x-internal-secret']).toBe('test-action-secret');
    });
  });

  describe('query execution', () => {
    it('executes an action query', async () => {
      const token = await createJWT({ role: 'client', userId: ALICE_ID, allowedRoles: ['client'] });

      webhook.onPath('/actions/check-discount-eligibility', () => ({
        code: 200,
        body: {
          eligible: true,
          reason: 'Loyalty discount',
          planName: 'Premium',
          discountType: 'percentage',
          discountValue: 15,
        },
      }));

      const { body } = await gql(
        `query($input: CheckDiscountEligibilityInput!) {
          checkDiscountEligibility(input: $input) {
            eligible
            reason
            planName
            discountType
            discountValue
          }
        }`,
        { input: { servicePlanId: 'b0000000-0000-0000-0000-000000000001' } },
        { authorization: `Bearer ${token}` },
      );

      expect(body.errors).toBeUndefined();
      expect((body.data as any).checkDiscountEligibility).toEqual({
        eligible: true,
        reason: 'Loyalty discount',
        planName: 'Premium',
        discountType: 'percentage',
        discountValue: 15,
      });
    });
  });

  describe('permission enforcement', () => {
    it('allows permitted roles to execute an action', async () => {
      const token = await createJWT({ role: 'client', userId: ALICE_ID, allowedRoles: ['client'] });

      webhook.onPath('/actions/create-payment', () => ({
        code: 200,
        body: { invoiceId: 'f0000000-0000-0000-0000-000000000001', status: 'ok' },
      }));

      const { body } = await gql(
        `mutation($input: CreatePaymentInput!) {
          createPayment(input: $input) { status }
        }`,
        { input: { amount: 10, currencyId: 'usd' } },
        { authorization: `Bearer ${token}` },
      );

      expect(body.errors).toBeUndefined();
    });

    it('denies non-permitted roles', async () => {
      // createPayment only allows 'client' role; 'backoffice' should be denied
      const token = await createJWT({ role: 'backoffice', allowedRoles: ['backoffice', 'client'] });

      const { body } = await gql(
        `mutation($input: CreatePaymentInput!) {
          createPayment(input: $input) { status }
        }`,
        { input: { amount: 10, currencyId: 'usd' } },
        { authorization: `Bearer ${token}` },
      );

      expect(body.errors).toBeDefined();
      expect(body.errors![0].message).toContain('Not authorized');
      expect(body.errors![0].extensions?.code).toBe('FORBIDDEN');
      // Webhook should not have been called
      expect(webhook.requests.length).toBe(0);
    });

    it('allows admin to execute any action', async () => {
      webhook.onPath('/actions/adjust-account', () => ({
        code: 200,
        body: {
          ledgerEntryId: 'e0000000-0000-0000-0000-000000000099',
          clientId: ALICE_ID,
          newBalance: 150.0,
          success: true,
        },
      }));

      const { body } = await gql(
        `mutation($input: AdjustAccountInput!) {
          adjustAccount(input: $input) { success newBalance }
        }`,
        {
          input: {
            clientId: ALICE_ID,
            amount: 50,
            currencyId: 'usd',
            reason: 'Refund',
            type: 'credit',
          },
        },
        { 'x-hasura-admin-secret': ADMIN_SECRET },
      );

      expect(body.errors).toBeUndefined();
      expect((body.data as any).adjustAccount.success).toBe(true);
    });

    it('enforces multi-role permissions correctly', async () => {
      // adjustAccount allows 'administrator' and 'backoffice'
      const adminToken = await createJWT({
        role: 'administrator',
        allowedRoles: ['administrator', 'backoffice', 'client'],
      });
      const backofficeToken = await createJWT({
        role: 'backoffice',
        allowedRoles: ['backoffice', 'client'],
      });
      const clientToken = await createJWT({
        role: 'client',
        userId: ALICE_ID,
        allowedRoles: ['client'],
      });

      webhook.onPath('/actions/adjust-account', () => ({
        code: 200,
        body: { ledgerEntryId: 'e0000000-0000-0000-0000-000000000001', clientId: ALICE_ID, newBalance: 100, success: true },
      }));

      const mutation = `mutation($input: AdjustAccountInput!) {
        adjustAccount(input: $input) { success }
      }`;
      const input = {
        input: { clientId: ALICE_ID, amount: 10, currencyId: 'usd', reason: 'Test', type: 'credit' },
      };

      // administrator should succeed
      const r1 = await gql(mutation, input, { authorization: `Bearer ${adminToken}` });
      expect(r1.body.errors).toBeUndefined();

      // backoffice should succeed
      const r2 = await gql(mutation, input, { authorization: `Bearer ${backofficeToken}` });
      expect(r2.body.errors).toBeUndefined();

      // client should be denied
      const r3 = await gql(mutation, input, { authorization: `Bearer ${clientToken}` });
      expect(r3.body.errors).toBeDefined();
      expect(r3.body.errors![0].extensions?.code).toBe('FORBIDDEN');
    });
  });

  describe('error handling', () => {
    it('returns error when webhook returns 4xx', async () => {
      const token = await createJWT({ role: 'client', userId: ALICE_ID, allowedRoles: ['client'] });

      webhook.onPath('/actions/create-payment', () => ({
        code: 400,
        body: { message: 'Invalid payment amount' },
      }));

      const { body } = await gql(
        `mutation($input: CreatePaymentInput!) {
          createPayment(input: $input) { status }
        }`,
        { input: { amount: -10, currencyId: 'usd' } },
        { authorization: `Bearer ${token}` },
      );

      expect(body.errors).toBeDefined();
      expect(body.errors![0].message).toBe('Invalid payment amount');
    });

    it('returns error when webhook returns 5xx', async () => {
      const token = await createJWT({ role: 'client', userId: ALICE_ID, allowedRoles: ['client'] });

      webhook.onPath('/actions/create-payment', () => ({
        code: 500,
        body: { error: 'Internal server error' },
      }));

      const { body } = await gql(
        `mutation($input: CreatePaymentInput!) {
          createPayment(input: $input) { status }
        }`,
        { input: { amount: 10, currencyId: 'usd' } },
        { authorization: `Bearer ${token}` },
      );

      expect(body.errors).toBeDefined();
      expect(body.errors![0].extensions?.code).toBe('ACTION_HANDLER_ERROR');
    });

    it('returns error for unauthenticated requests', async () => {
      const { body } = await gql(
        `mutation($input: CreatePaymentInput!) {
          createPayment(input: $input) { status }
        }`,
        { input: { amount: 10, currencyId: 'usd' } },
        // No auth header — unauthorized role doesn't have action permissions
      );

      expect(body.errors).toBeDefined();
    });
  });

  describe('session variables', () => {
    it('forwards session variables to webhook handler', async () => {
      const token = await createJWT({
        role: 'client',
        userId: ALICE_ID,
        allowedRoles: ['client'],
      });

      webhook.onPath('/actions/create-payment', () => ({
        code: 200,
        body: { invoiceId: 'f0000000-0000-0000-0000-000000000001', status: 'ok' },
      }));

      await gql(
        `mutation($input: CreatePaymentInput!) {
          createPayment(input: $input) { status }
        }`,
        { input: { amount: 10, currencyId: 'usd' } },
        { authorization: `Bearer ${token}` },
      );

      const [req] = webhook.requests;
      const payload = req.body as any;
      expect(payload.session_variables['x-hasura-user-id']).toBe(ALICE_ID);
      expect(payload.session_variables['x-hasura-role']).toBe('client');
      expect(payload.session_variables['x-hasura-default-role']).toBe('client');
      expect(payload.session_variables['x-hasura-allowed-roles']).toBeDefined();
    });
  });
});
