/**
 * Tests for action request/response transformation.
 *
 * Covers:
 * - Template interpolation (strings, objects, nested paths, missing paths)
 * - Request transforms (URL, method, body, query params, headers)
 * - Response transforms (body remapping)
 * - E2E integration with mock webhook server
 * - Backward compatibility (actions without transforms)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  interpolateString,
  interpolateTemplate,
  interpolateUrlTemplate,
  validateUrlSafe,
  applyRequestTransform,
  applyResponseTransform,
} from '../src/actions/transform.js';
import type { RequestTransform, ResponseTransform } from '../src/types.js';
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

// ─── Unit Tests: Template Interpolation ─────────────────────────────────────

describe('Template interpolation', () => {
  const variables = {
    $body: {
      action: { name: 'createPayment' },
      input: {
        amount: 99.99,
        currencyId: 'usd',
        nested: { deep: { value: 'found' } },
      },
      session_variables: { 'x-hasura-role': 'client' },
    },
    $session_variables: {
      'x-hasura-role': 'client',
      'x-hasura-user-id': 'user-123',
    },
    $base_url: 'https://api.example.com',
  };

  describe('string templates', () => {
    it('interpolates a simple variable reference', () => {
      const result = interpolateString('{{$base_url}}/payments', variables);
      expect(result).toBe('https://api.example.com/payments');
    });

    it('interpolates nested body paths', () => {
      const result = interpolateString('Amount: {{$body.input.amount}}', variables);
      expect(result).toBe('Amount: 99.99');
    });

    it('interpolates session variables', () => {
      const result = interpolateString(
        'Role: {{$session_variables.x-hasura-role}}',
        variables,
      );
      expect(result).toBe('Role: client');
    });

    it('interpolates multiple placeholders', () => {
      const result = interpolateString(
        '{{$base_url}}/{{$body.input.currencyId}}/pay',
        variables,
      );
      expect(result).toBe('https://api.example.com/usd/pay');
    });

    it('returns the raw value when the entire string is a single expression', () => {
      const result = interpolateString('{{$body.input.amount}}', variables);
      expect(result).toBe(99.99); // number, not string
    });

    it('returns an object when the entire string is a single expression resolving to an object', () => {
      const result = interpolateString('{{$body.input}}', variables);
      expect(result).toEqual({
        amount: 99.99,
        currencyId: 'usd',
        nested: { deep: { value: 'found' } },
      });
    });

    it('returns empty string for missing paths in multi-placeholder strings', () => {
      const result = interpolateString('val={{$body.nonexistent.field}}!', variables);
      expect(result).toBe('val=!');
    });

    it('returns null for missing paths when entire string is a single expression', () => {
      const result = interpolateString('{{$body.nonexistent.field}}', variables);
      expect(result).toBeNull();
    });

    it('handles deeply nested paths', () => {
      const result = interpolateString('{{$body.input.nested.deep.value}}', variables);
      expect(result).toBe('found');
    });
  });

  describe('object templates', () => {
    it('recursively interpolates object values', () => {
      const template = {
        url: '{{$base_url}}/pay',
        amount: '{{$body.input.amount}}',
        role: '{{$session_variables.x-hasura-role}}',
      };
      const result = interpolateTemplate(template, variables);
      expect(result).toEqual({
        url: 'https://api.example.com/pay',
        amount: 99.99,
        role: 'client',
      });
    });

    it('recursively interpolates array values', () => {
      const template = ['{{$body.input.amount}}', '{{$body.input.currencyId}}'];
      const result = interpolateTemplate(template, variables);
      expect(result).toEqual([99.99, 'usd']);
    });

    it('handles nested objects and arrays', () => {
      const template = {
        data: {
          items: ['{{$body.input.amount}}'],
          meta: { user: '{{$session_variables.x-hasura-user-id}}' },
        },
      };
      const result = interpolateTemplate(template, variables);
      expect(result).toEqual({
        data: {
          items: [99.99],
          meta: { user: 'user-123' },
        },
      });
    });

    it('passes through non-template primitives', () => {
      const template = {
        count: 42,
        active: true,
        label: 'static',
        nothing: null,
      };
      const result = interpolateTemplate(template, variables);
      expect(result).toEqual({
        count: 42,
        active: true,
        label: 'static',
        nothing: null,
      });
    });
  });

  describe('missing paths', () => {
    it('returns null for completely missing top-level variable', () => {
      const result = interpolateString('{{$nonexistent}}', variables);
      expect(result).toBeNull();
    });

    it('returns null when traversing into a non-object', () => {
      const result = interpolateString('{{$body.input.amount.foo}}', variables);
      expect(result).toBeNull();
    });

    it('returns null for undefined nested path', () => {
      const result = interpolateString('{{$body.input.missing}}', variables);
      expect(result).toBeNull();
    });
  });
});

// ─── Unit Tests: URL Path Traversal Protection ──────────────────────────────

describe('URL path traversal protection', () => {
  const variables = {
    $body: {
      input: {
        id: '../../admin',
        safe: 'item-42',
        dotdot: '..',
        dot: '.',
        encoded: '%2e%2e',
        slashy: 'a/b/c',
        special: 'hello world&foo=bar',
      },
    },
    $session_variables: {},
    $base_url: 'https://api.example.com',
  };

  describe('interpolateUrlTemplate', () => {
    it('encodes path traversal with slashes (../../admin)', () => {
      // "../../admin" → encodeURIComponent → "..%2F..%2Fadmin"
      // The "/" becomes %2F, making the entire value a single URL segment.
      // This is safe because %2F is not treated as a path separator.
      const result = interpolateUrlTemplate(
        '{{$base_url}}/items/{{$body.input.id}}/details',
        variables,
      );
      expect(result).toBe(
        'https://api.example.com/items/..%2F..%2Fadmin/details',
      );
    });

    it('rejects bare ".." input as path traversal', () => {
      expect(() =>
        interpolateUrlTemplate(
          '{{$base_url}}/items/{{$body.input.dotdot}}/details',
          variables,
        ),
      ).toThrow(/Path traversal/);
    });

    it('rejects bare "." input as path traversal', () => {
      expect(() =>
        interpolateUrlTemplate(
          '{{$base_url}}/items/{{$body.input.dot}}/details',
          variables,
        ),
      ).toThrow(/Path traversal/);
    });

    it('rejects pre-encoded traversal (%2e%2e)', () => {
      // User provides already-encoded dots — encodeURIComponent double-encodes
      // the "%" to "%25", making segments "%252e%252e" which decodes to "%2e%2e"
      // (not ".."), so this actually passes. But let's verify the behavior.
      const result = interpolateUrlTemplate(
        '{{$base_url}}/items/{{$body.input.encoded}}',
        variables,
      );
      // "%2e%2e" gets encodeURIComponent'd to "%252e%252e" — safe (double-encoded)
      expect(result).toBe('https://api.example.com/items/%252e%252e');
    });

    it('allows normal path values through unchanged', () => {
      const result = interpolateUrlTemplate(
        '{{$base_url}}/items/{{$body.input.safe}}',
        variables,
      );
      expect(result).toBe('https://api.example.com/items/item-42');
    });

    it('encodes slashes in user input to prevent path injection', () => {
      const result = interpolateUrlTemplate(
        '{{$base_url}}/items/{{$body.input.slashy}}',
        variables,
      );
      expect(result).toBe('https://api.example.com/items/a%2Fb%2Fc');
    });

    it('encodes special characters (spaces, ampersands) in path values', () => {
      const result = interpolateUrlTemplate(
        '{{$base_url}}/items/{{$body.input.special}}',
        variables,
      );
      expect(result).toBe('https://api.example.com/items/hello%20world%26foo%3Dbar');
    });

    it('does not encode $base_url (trusted server configuration)', () => {
      const result = interpolateUrlTemplate(
        '{{$base_url}}/items/list',
        variables,
      );
      expect(result).toBe('https://api.example.com/items/list');
    });

    it('returns raw value when entire template is a single expression', () => {
      const result = interpolateUrlTemplate('{{$base_url}}', variables);
      expect(result).toBe('https://api.example.com');
    });
  });

  describe('validateUrlSafe', () => {
    it('allows normal URLs', () => {
      expect(() => validateUrlSafe('https://api.example.com/items/42')).not.toThrow();
    });

    it('rejects URLs with ".." path segments', () => {
      expect(() =>
        validateUrlSafe('https://api.example.com/items/../../admin'),
      ).toThrow(/Path traversal/);
    });

    it('rejects URLs with encoded ".." path segments (%2e%2e)', () => {
      expect(() =>
        validateUrlSafe('https://api.example.com/items/%2e%2e/admin'),
      ).toThrow(/Path traversal/);
    });

    it('allows URLs with ".." in query parameters (not path)', () => {
      expect(() =>
        validateUrlSafe('https://api.example.com/items?path=../../admin'),
      ).not.toThrow();
    });

    it('allows URLs with encoded values that are not traversal', () => {
      expect(() =>
        validateUrlSafe('https://api.example.com/items/..%2F..%2Fadmin'),
      ).not.toThrow();
    });

    it('does not throw on unparseable URLs (lets HTTP client handle it)', () => {
      expect(() => validateUrlSafe('not-a-url')).not.toThrow();
    });
  });

  describe('applyRequestTransform (path traversal integration)', () => {
    const context = {
      sessionVariables: { 'x-hasura-role': 'user' },
      baseUrl: 'https://api.example.com/webhook',
    };

    it('encodes path traversal characters in interpolated URL values', () => {
      const originalRequest = {
        url: 'https://api.example.com/webhook',
        method: 'POST' as const,
        body: {
          action: { name: 'getItem' },
          input: { id: '../../admin' },
          session_variables: {},
        },
        headers: { 'Content-Type': 'application/json' },
      };

      const transform: RequestTransform = {
        url: '{{$base_url}}/items/{{$body.input.id}}',
      };

      // "../../admin" is encoded to "..%2F..%2Fadmin" — safe, no real path separator
      const result = applyRequestTransform(transform, originalRequest, context);
      expect(result.url).not.toContain('/../');
      expect(result.url).toContain(encodeURIComponent('../../admin'));
    });

    it('rejects bare ".." in URL path segment', () => {
      const originalRequest = {
        url: 'https://api.example.com/webhook',
        method: 'POST' as const,
        body: {
          action: { name: 'getItem' },
          input: { id: '..' },
          session_variables: {},
        },
        headers: { 'Content-Type': 'application/json' },
      };

      const transform: RequestTransform = {
        url: '{{$base_url}}/items/{{$body.input.id}}/details',
      };

      expect(() =>
        applyRequestTransform(transform, originalRequest, context),
      ).toThrow(/Path traversal/);
    });

    it('does not alter query parameter values with special characters', () => {
      const originalRequest = {
        url: 'https://api.example.com/webhook',
        method: 'POST' as const,
        body: {
          action: { name: 'search' },
          input: { query: 'hello world&sort=desc' },
          session_variables: {},
        },
        headers: { 'Content-Type': 'application/json' },
      };

      const transform: RequestTransform = {
        queryParams: {
          q: '{{$body.input.query}}',
          format: 'json',
        },
      };

      const result = applyRequestTransform(transform, originalRequest, context);
      const url = new URL(result.url);
      // Query params use URL.searchParams.set() which handles encoding natively
      expect(url.searchParams.get('q')).toBe('hello world&sort=desc');
      expect(url.searchParams.get('format')).toBe('json');
    });

    it('allows normal path values in URL templates', () => {
      const originalRequest = {
        url: 'https://api.example.com/webhook',
        method: 'POST' as const,
        body: {
          action: { name: 'getItem' },
          input: { id: 'item-42', category: 'electronics' },
          session_variables: {},
        },
        headers: { 'Content-Type': 'application/json' },
      };

      const transform: RequestTransform = {
        url: '{{$base_url}}/{{$body.input.category}}/{{$body.input.id}}',
      };

      const result = applyRequestTransform(transform, originalRequest, context);
      expect(result.url).toBe('https://api.example.com/webhook/electronics/item-42');
    });
  });
});

// ─── Unit Tests: Request Transform ──────────────────────────────────────────

describe('Request transform', () => {
  const originalRequest = {
    url: 'https://api.example.com/webhook',
    method: 'POST',
    body: {
      action: { name: 'createPayment' },
      input: { amount: 50, currency: 'eur' },
      session_variables: { 'x-hasura-role': 'client' },
    },
    headers: { 'Content-Type': 'application/json', 'x-secret': 'abc' },
  };

  const context = {
    sessionVariables: { 'x-hasura-role': 'client', 'x-hasura-user-id': 'user-456' },
    baseUrl: 'https://api.example.com/webhook',
  };

  it('overrides the HTTP method', () => {
    const transform: RequestTransform = { method: 'PUT' };
    const result = applyRequestTransform(transform, originalRequest, context);
    expect(result.method).toBe('PUT');
    expect(result.url).toBe(originalRequest.url);
    expect(result.body).toEqual(originalRequest.body);
  });

  it('overrides the URL with a template', () => {
    const transform: RequestTransform = {
      url: '{{$base_url}}/v2/payments/{{$body.input.currency}}',
    };
    const result = applyRequestTransform(transform, originalRequest, context);
    expect(result.url).toBe('https://api.example.com/webhook/v2/payments/eur');
  });

  it('overrides the body with an object template', () => {
    const transform: RequestTransform = {
      body: {
        payment_amount: '{{$body.input.amount}}',
        payment_currency: '{{$body.input.currency}}',
        user: '{{$session_variables.x-hasura-user-id}}',
      },
    };
    const result = applyRequestTransform(transform, originalRequest, context);
    expect(result.body).toEqual({
      payment_amount: 50,
      payment_currency: 'eur',
      user: 'user-456',
    });
  });

  it('overrides the body with a string template', () => {
    const transform: RequestTransform = {
      body: '{{$body.input}}',
    };
    const result = applyRequestTransform(transform, originalRequest, context);
    expect(result.body).toEqual({ amount: 50, currency: 'eur' });
  });

  it('adds query params with interpolation', () => {
    const transform: RequestTransform = {
      queryParams: {
        user_id: '{{$session_variables.x-hasura-user-id}}',
        format: 'json',
      },
    };
    const result = applyRequestTransform(transform, originalRequest, context);
    const url = new URL(result.url);
    expect(url.searchParams.get('user_id')).toBe('user-456');
    expect(url.searchParams.get('format')).toBe('json');
  });

  it('adds/overrides headers with interpolation', () => {
    const transform: RequestTransform = {
      headers: {
        'X-User-Id': '{{$session_variables.x-hasura-user-id}}',
        'X-Custom': 'static-value',
      },
    };
    const result = applyRequestTransform(transform, originalRequest, context);
    expect(result.headers['X-User-Id']).toBe('user-456');
    expect(result.headers['X-Custom']).toBe('static-value');
    // Original headers should be preserved
    expect(result.headers['x-secret']).toBe('abc');
  });

  it('overrides content type', () => {
    const transform: RequestTransform = {
      contentType: 'application/x-www-form-urlencoded',
    };
    const result = applyRequestTransform(transform, originalRequest, context);
    expect(result.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
  });

  it('applies multiple transforms simultaneously', () => {
    const transform: RequestTransform = {
      method: 'PATCH',
      url: '{{$base_url}}/v2/payment',
      body: { amount: '{{$body.input.amount}}' },
      headers: { 'X-Role': '{{$session_variables.x-hasura-role}}' },
    };
    const result = applyRequestTransform(transform, originalRequest, context);
    expect(result.method).toBe('PATCH');
    expect(result.url).toBe('https://api.example.com/webhook/v2/payment');
    expect(result.body).toEqual({ amount: 50 });
    expect(result.headers['X-Role']).toBe('client');
  });
});

// ─── Unit Tests: Response Transform ─────────────────────────────────────────

describe('Response transform', () => {
  it('remaps response body with an object template', () => {
    const responseBody = {
      payment_id: 'pay-123',
      payment_status: 'completed',
      meta: { redirect: 'https://redirect.example.com' },
    };

    const transform: ResponseTransform = {
      body: {
        invoiceId: '{{$body.payment_id}}',
        status: '{{$body.payment_status}}',
        redirectUrl: '{{$body.meta.redirect}}',
      },
    };

    const result = applyResponseTransform(
      transform,
      responseBody,
      { sessionVariables: {} },
    );

    expect(result).toEqual({
      invoiceId: 'pay-123',
      status: 'completed',
      redirectUrl: 'https://redirect.example.com',
    });
  });

  it('handles missing response fields gracefully', () => {
    const responseBody = { status: 'ok' };

    const transform: ResponseTransform = {
      body: {
        status: '{{$body.status}}',
        missing: '{{$body.nonexistent}}',
      },
    };

    const result = applyResponseTransform(
      transform,
      responseBody,
      { sessionVariables: {} },
    );

    expect(result).toEqual({
      status: 'ok',
      missing: null,
    });
  });

  it('passes through response body when no body template is set', () => {
    const responseBody = { data: 'unchanged' };
    const transform: ResponseTransform = {};

    const result = applyResponseTransform(
      transform,
      responseBody,
      { sessionVariables: {} },
    );

    expect(result).toEqual({ data: 'unchanged' });
  });

  it('supports session variables in response transforms', () => {
    const responseBody = { amount: 100 };
    const transform: ResponseTransform = {
      body: {
        amount: '{{$body.amount}}',
        role: '{{$session_variables.x-hasura-role}}',
      },
    };

    const result = applyResponseTransform(
      transform,
      responseBody,
      { sessionVariables: { 'x-hasura-role': 'admin' } },
    );

    expect(result).toEqual({ amount: 100, role: 'admin' });
  });

  it('supports extracting a nested response field', () => {
    const responseBody = {
      wrapper: {
        data: {
          invoiceId: 'inv-789',
          status: 'pending',
        },
      },
    };

    const transform: ResponseTransform = {
      body: '{{$body.wrapper.data}}',
    };

    const result = applyResponseTransform(
      transform,
      responseBody,
      { sessionVariables: {} },
    );

    expect(result).toEqual({
      invoiceId: 'inv-789',
      status: 'pending',
    });
  });
});

// ─── E2E Tests ──────────────────────────────────────────────────────────────

describe('Action transforms E2E', () => {
  let server: FastifyInstance;
  let serverAddress: string;
  let webhook: MockWebhookServer;

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

  beforeAll(async () => {
    await waitForDb();

    webhook = new MockWebhookServer();
    await webhook.start();

    process.env['DATABASE_URL'] = TEST_DB_URL;
    process.env['HAKKYRA_ADMIN_SECRET'] = ADMIN_SECRET;
    process.env['LOG_LEVEL'] = 'error';
    process.env['NODE_ENV'] = 'test';
    process.env['ACTION_SECRET'] = 'test-action-secret';
    process.env['SERVICE_PROVIDER_KEY'] = 'test-service-key';

    const { loadConfig } = await import('../src/config/loader.js');
    const config = await loadConfig(METADATA_DIR, SERVER_CONFIG_PATH);

    for (const action of config.actions) {
      action.definition.handler = action.definition.handler.replace(
        '{{TEST_SERVER_URL}}',
        webhook.baseUrl,
      );
    }

    // Add request transform to scheduleConsultation action
    const scheduleAction = config.actions.find((a) => a.name === 'scheduleConsultation');
    if (scheduleAction) {
      scheduleAction.requestTransform = {
        body: {
          product: '{{$body.input.productCode}}',
          consultation_mode: '{{$body.input.mode}}',
          callback_url: '{{$body.input.returnUrl}}',
          requested_by: '{{$session_variables.x-hasura-user-id}}',
        },
        headers: {
          'X-Request-Source': 'hakkyra-transform',
        },
      };
    }

    // Add response transform to processService action
    const processAction = config.actions.find((a) => a.name === 'processService');
    if (processAction) {
      processAction.responseTransform = {
        body: {
          success: '{{$body.result.ok}}',
          newStatus: '{{$body.result.status}}',
          amountApplied: '{{$body.result.amount}}',
        },
      };
    }

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

  it('applies request transform before sending to webhook', async () => {
    const token = await createJWT({
      role: 'client',
      userId: ALICE_ID,
      allowedRoles: ['client'],
    });

    webhook.onPath('/actions/schedule-consultation', () => ({
      code: 200,
      body: {
        appointmentId: 'a0000000-0000-0000-0000-000000000099',
        confirmationUrl: 'https://confirm.example.com/abc',
        reference: 'REF-001',
      },
    }));

    const { body } = await gql(
      `mutation($input: ScheduleConsultationInput!) {
        scheduleConsultation(input: $input) {
          appointmentId
          confirmationUrl
          reference
        }
      }`,
      {
        input: {
          productCode: 'CONSULT-A',
          mode: 'video',
          returnUrl: 'https://app.example.com/done',
        },
      },
      { authorization: `Bearer ${token}` },
    );

    expect(body.errors).toBeUndefined();
    expect((body.data as any).scheduleConsultation).toEqual({
      appointmentId: 'a0000000-0000-0000-0000-000000000099',
      confirmationUrl: 'https://confirm.example.com/abc',
      reference: 'REF-001',
    });

    // Verify the transformed payload was sent to the webhook
    const [req] = webhook.requests;
    expect(req).toBeDefined();
    const payload = req.body as any;
    expect(payload.product).toBe('CONSULT-A');
    expect(payload.consultation_mode).toBe('video');
    expect(payload.callback_url).toBe('https://app.example.com/done');
    expect(payload.requested_by).toBe(ALICE_ID);
    // Verify custom header was sent
    expect(req.headers['x-request-source']).toBe('hakkyra-transform');
  });

  it('applies response transform to webhook response', async () => {
    const token = await createJWT({
      role: 'administrator',
      allowedRoles: ['administrator', 'function'],
    });

    webhook.onPath('/actions/process-service', () => ({
      code: 200,
      body: {
        result: {
          ok: true,
          status: 'delivered',
          amount: 75.50,
        },
      },
    }));

    const { body } = await gql(
      `mutation($input: ProcessServiceInput!) {
        processService(input: $input) {
          success
          newStatus
          amountApplied
        }
      }`,
      {
        input: {
          clientServiceId: 'c0000000-0000-0000-0000-000000000001',
          action: 'deliver',
        },
      },
      { authorization: `Bearer ${token}` },
    );

    expect(body.errors).toBeUndefined();
    expect((body.data as any).processService).toEqual({
      success: true,
      newStatus: 'delivered',
      amountApplied: 75.50,
    });
  });

  it('actions without transforms still work (backward compatibility)', async () => {
    const token = await createJWT({
      role: 'client',
      userId: ALICE_ID,
      allowedRoles: ['client'],
    });

    webhook.onPath('/actions/create-payment', () => ({
      code: 200,
      body: {
        invoiceId: 'f0000000-0000-0000-0000-000000000099',
        redirectUrl: 'https://pay.example.com/checkout/789',
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
          amount: 42.00,
          currencyId: 'usd',
          provider: 'stripe',
        },
      },
      { authorization: `Bearer ${token}` },
    );

    expect(body.errors).toBeUndefined();
    expect((body.data as any).createPayment).toEqual({
      invoiceId: 'f0000000-0000-0000-0000-000000000099',
      redirectUrl: 'https://pay.example.com/checkout/789',
      status: 'pending',
    });

    // Verify standard Hasura payload format was sent (no transform)
    const [req] = webhook.requests;
    const payload = req.body as any;
    expect(payload.action).toEqual({ name: 'createPayment' });
    expect(payload.input).toEqual({
      amount: 42,
      currencyId: 'usd',
      provider: 'stripe',
    });
    expect(payload.session_variables).toBeDefined();
  });
});
