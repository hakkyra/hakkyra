/**
 * Tests for action relationship mapping.
 *
 * Verifies that action output types can include relationship fields that
 * resolve to linked database records via configured field mappings.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { MockWebhookServer } from './helpers/mock-webhook.js';
import {
  TEST_DB_URL,
  METADATA_DIR,
  SERVER_CONFIG_PATH,
  ADMIN_SECRET,
  ALICE_ID,
  BOB_ID,
  INVOICE_ALICE_ID,
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
): Promise<{
  status: number;
  body: {
    data?: unknown;
    errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
  };
}> {
  const res = await fetch(`${serverAddress}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await res.json()) as {
    data?: unknown;
    errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
  };
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

describe('Action Relationships', () => {
  describe('config loading', () => {
    it('parses action with relationships correctly', async () => {
      const { loadConfig } = await import('../src/config/loader.js');
      const config = await loadConfig(METADATA_DIR, SERVER_CONFIG_PATH);

      const createPayment = config.actions.find((a) => a.name === 'createPayment');
      expect(createPayment).toBeDefined();
      expect(createPayment!.relationships).toBeDefined();
      expect(createPayment!.relationships).toHaveLength(1);
      expect(createPayment!.relationships![0]).toEqual({
        name: 'invoice',
        type: 'object',
        remoteTable: { schema: 'public', name: 'invoice' },
        fieldMapping: { invoiceId: 'id' },
      });

      const adjustAccount = config.actions.find((a) => a.name === 'adjustAccount');
      expect(adjustAccount).toBeDefined();
      expect(adjustAccount!.relationships).toBeDefined();
      expect(adjustAccount!.relationships).toHaveLength(1);
      expect(adjustAccount!.relationships![0]).toEqual({
        name: 'ledgerEntries',
        type: 'array',
        remoteTable: { schema: 'public', name: 'ledger_entry' },
        fieldMapping: { clientId: 'client_id' },
      });
    });

    it('actions without relationships have undefined relationships field', async () => {
      const { loadConfig } = await import('../src/config/loader.js');
      const config = await loadConfig(METADATA_DIR, SERVER_CONFIG_PATH);

      const checkDiscount = config.actions.find((a) => a.name === 'checkDiscountEligibility');
      expect(checkDiscount).toBeDefined();
      expect(checkDiscount!.relationships).toBeUndefined();
    });
  });

  describe('schema generation', () => {
    let sdl: string;

    beforeAll(async () => {
      const res = await fetch(`${serverAddress}/sdl`);
      sdl = await res.text();
    });

    it('action output type includes object relationship field', () => {
      // PaymentResult should include an invoice field
      expect(sdl).toMatch(/type PaymentResult\s*\{[^}]*invoice:\s*Invoice/);
    });

    it('action output type includes array relationship field', () => {
      // AdjustAccountResult should include a ledgerEntries field returning a list
      expect(sdl).toMatch(
        /type AdjustAccountResult\s*\{[^}]*ledgerEntries:\s*\[LedgerEntry!\]!/,
      );
    });

    it('action output types without relationships are unchanged', () => {
      // DiscountEligibilityResult should not have any relationship fields
      expect(sdl).toMatch(/type DiscountEligibilityResult\s*\{/);
      expect(sdl).not.toMatch(
        /type DiscountEligibilityResult\s*\{[^}]*(invoice|client|ledger)/i,
      );
    });
  });

  describe('object relationship resolution', () => {
    it('resolves linked DB record via object relationship', async () => {
      const token = await createJWT({
        role: 'client',
        userId: ALICE_ID,
        allowedRoles: ['client'],
      });

      // Return a real invoice ID from the seed data
      webhook.onPath('/actions/create-payment', () => ({
        code: 200,
        body: {
          invoiceId: INVOICE_ALICE_ID,
          redirectUrl: 'https://pay.example.com/checkout/123',
          status: 'pending',
        },
      }));

      const { body } = await gql(
        `mutation($input: CreatePaymentInput!) {
          createPayment(input: $input) {
            invoiceId
            status
            invoice {
              id
              amount
              state
            }
          }
        }`,
        {
          input: {
            amount: 99.99,
            currencyId: 'usd',
          },
        },
        { authorization: `Bearer ${token}` },
      );

      expect(body.errors).toBeUndefined();
      const data = (body.data as any).createPayment;
      expect(data.invoiceId).toBe(INVOICE_ALICE_ID);
      expect(data.status).toBe('pending');

      // The invoice relationship should have resolved to the DB record
      expect(data.invoice).toBeDefined();
      expect(data.invoice.id).toBe(INVOICE_ALICE_ID);
      expect(data.invoice.amount).toBeDefined();
      expect(data.invoice.state).toBeDefined();
    });
  });

  describe('array relationship resolution', () => {
    it('resolves linked DB records via array relationship', async () => {
      // adjustAccount returns clientId; ledgerEntries maps clientId -> ledger_entry.client_id
      // Alice has 3 ledger entries in seed data

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
          adjustAccount(input: $input) {
            success
            newBalance
            ledgerEntries {
              id
              type
              amount
            }
          }
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
      const data = (body.data as any).adjustAccount;
      expect(data.success).toBe(true);
      expect(data.newBalance).toBe(150.0);

      // Alice has ledger entries in seed data
      expect(data.ledgerEntries).toBeDefined();
      expect(Array.isArray(data.ledgerEntries)).toBe(true);
      expect(data.ledgerEntries.length).toBeGreaterThanOrEqual(3);

      // Each entry should have basic fields
      for (const entry of data.ledgerEntries) {
        expect(entry.id).toBeDefined();
        expect(entry.type).toBeDefined();
        expect(entry.amount).toBeDefined();
      }
    });
  });

  describe('permission enforcement', () => {
    it('relationship query respects role permissions on remote table', async () => {
      // The client role on invoice only allows: id, client_id, currency_id, amount, state, type, provider, created_at
      // and filters by client_id = X-Hasura-User-Id
      // So if Alice queries her own invoice, she should see it
      // but she should NOT see fields like external_id or metadata
      const token = await createJWT({
        role: 'client',
        userId: ALICE_ID,
        allowedRoles: ['client'],
      });

      webhook.onPath('/actions/create-payment', () => ({
        code: 200,
        body: {
          invoiceId: INVOICE_ALICE_ID,
          status: 'pending',
        },
      }));

      const { body } = await gql(
        `mutation($input: CreatePaymentInput!) {
          createPayment(input: $input) {
            invoiceId
            invoice {
              id
              amount
              state
              clientId
            }
          }
        }`,
        {
          input: {
            amount: 10,
            currencyId: 'usd',
          },
        },
        { authorization: `Bearer ${token}` },
      );

      expect(body.errors).toBeUndefined();
      const data = (body.data as any).createPayment;
      // Should resolve the invoice because it belongs to Alice
      expect(data.invoice).toBeDefined();
      expect(data.invoice.id).toBe(INVOICE_ALICE_ID);
      expect(data.invoice.clientId).toBe(ALICE_ID);
    });

    it('relationship returns null when permission filter excludes the record', async () => {
      // Alice tries to get an invoice that belongs to Bob
      // Bob's invoice: f0000000-0000-0000-0000-000000000003
      const token = await createJWT({
        role: 'client',
        userId: ALICE_ID,
        allowedRoles: ['client'],
      });

      webhook.onPath('/actions/create-payment', () => ({
        code: 200,
        body: {
          invoiceId: 'f0000000-0000-0000-0000-000000000003',
          status: 'pending',
        },
      }));

      const { body } = await gql(
        `mutation($input: CreatePaymentInput!) {
          createPayment(input: $input) {
            invoiceId
            invoice {
              id
              amount
            }
          }
        }`,
        {
          input: {
            amount: 10,
            currencyId: 'usd',
          },
        },
        { authorization: `Bearer ${token}` },
      );

      expect(body.errors).toBeUndefined();
      const data = (body.data as any).createPayment;
      // The invoice belongs to Bob, and Alice's permission filter (client_id = Alice's ID)
      // should exclude it, so the relationship should return null
      expect(data.invoice).toBeNull();
    });
  });

  describe('missing join key handling', () => {
    it('returns null for object relationship when join key is null', async () => {
      const token = await createJWT({
        role: 'client',
        userId: ALICE_ID,
        allowedRoles: ['client'],
      });

      // Return null for invoiceId
      webhook.onPath('/actions/create-payment', () => ({
        code: 200,
        body: {
          invoiceId: null,
          status: 'no-invoice',
        },
      }));

      const { body } = await gql(
        `mutation($input: CreatePaymentInput!) {
          createPayment(input: $input) {
            status
            invoice {
              id
            }
          }
        }`,
        {
          input: {
            amount: 10,
            currencyId: 'usd',
          },
        },
        { authorization: `Bearer ${token}` },
      );

      expect(body.errors).toBeUndefined();
      const data = (body.data as any).createPayment;
      expect(data.status).toBe('no-invoice');
      expect(data.invoice).toBeNull();
    });

    it('returns empty array for array relationship when join key is null', async () => {
      webhook.onPath('/actions/adjust-account', () => ({
        code: 200,
        body: {
          ledgerEntryId: 'e0000000-0000-0000-0000-000000000099',
          clientId: null,
          newBalance: 0,
          success: true,
        },
      }));

      const { body } = await gql(
        `mutation($input: AdjustAccountInput!) {
          adjustAccount(input: $input) {
            success
            ledgerEntries {
              id
            }
          }
        }`,
        {
          input: {
            clientId: ALICE_ID,
            amount: 0,
            currencyId: 'usd',
            reason: 'Test null',
            type: 'adjustment',
          },
        },
        { 'x-hasura-admin-secret': ADMIN_SECRET },
      );

      expect(body.errors).toBeUndefined();
      const data = (body.data as any).adjustAccount;
      expect(data.success).toBe(true);
      expect(data.ledgerEntries).toEqual([]);
    });
  });

  describe('backward compatibility', () => {
    it('actions without relationships work unchanged', async () => {
      const token = await createJWT({
        role: 'client',
        userId: ALICE_ID,
        allowedRoles: ['client'],
      });

      webhook.onPath('/actions/check-discount-eligibility', () => ({
        code: 200,
        body: {
          eligible: true,
          reason: 'VIP',
          planName: 'Gold',
          discountType: 'percentage',
          discountValue: 20,
        },
      }));

      const { body } = await gql(
        `query($input: CheckDiscountEligibilityInput!) {
          checkDiscountEligibility(input: $input) {
            eligible
            reason
            planName
          }
        }`,
        { input: { servicePlanId: 'b0000000-0000-0000-0000-000000000001' } },
        { authorization: `Bearer ${token}` },
      );

      expect(body.errors).toBeUndefined();
      expect((body.data as any).checkDiscountEligibility).toEqual({
        eligible: true,
        reason: 'VIP',
        planName: 'Gold',
      });
    });

    it('relationship fields are optional - not querying them still works', async () => {
      const token = await createJWT({
        role: 'client',
        userId: ALICE_ID,
        allowedRoles: ['client'],
      });

      webhook.onPath('/actions/create-payment', () => ({
        code: 200,
        body: {
          invoiceId: INVOICE_ALICE_ID,
          status: 'ok',
        },
      }));

      // Query WITHOUT the invoice relationship field
      const { body } = await gql(
        `mutation($input: CreatePaymentInput!) {
          createPayment(input: $input) {
            invoiceId
            status
          }
        }`,
        {
          input: {
            amount: 10,
            currencyId: 'usd',
          },
        },
        { authorization: `Bearer ${token}` },
      );

      expect(body.errors).toBeUndefined();
      const data = (body.data as any).createPayment;
      expect(data.invoiceId).toBe(INVOICE_ALICE_ID);
      expect(data.status).toBe('ok');
      // No invoice field should be present since we didn't query it
      expect(data.invoice).toBeUndefined();
    });
  });
});
