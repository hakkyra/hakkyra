/**
 * Tests for the Kriti template language evaluator (backed by kriti-lang).
 *
 * Covers:
 * - Variable interpolation (dot notation, bracket notation)
 * - Session variable access
 * - String templates (mixed literal + expression)
 * - Null coalescing (??)
 * - Conditionals (if/else/end)
 * - JSON value mode (typed returns)
 * - Object/array template evaluation
 * - Integration with request/response transforms via templateEngine: 'Kriti'
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateKritiString,
  evaluateKritiTemplate,
  evaluateKritiUrlTemplate,
} from '../src/actions/kriti.js';
import {
  applyRequestTransform,
  applyResponseTransform,
} from '../src/actions/transform.js';
import type { RequestTransform, ResponseTransform } from '../src/types.js';

// ─── Kriti String Evaluation ────────────────────────────────────────────────

describe('Kriti string evaluation', () => {
  const context = {
    $body: {
      input: {
        name: 'Alice',
        amount: 42,
        flag: true,
        nothing: null,
        nested: { deep: 'value' },
      },
    },
    $session_variables: {
      'x-hasura-role': 'admin',
      'x-hasura-user-id': 'user-456',
    },
    $base_url: 'https://api.example.com',
  };

  describe('variable interpolation', () => {
    it('resolves a single expression to its typed value', () => {
      expect(evaluateKritiString('{{$body.input.amount}}', context)).toBe(42);
    });

    it('resolves a single expression to an object', () => {
      expect(evaluateKritiString('{{$body.input.nested}}', context)).toEqual({
        deep: 'value',
      });
    });

    it('resolves a boolean value', () => {
      expect(evaluateKritiString('{{$body.input.flag}}', context)).toBe(true);
    });

    it('returns null for missing single expression (error fallback)', () => {
      expect(evaluateKritiString('{{$body.missing}}', context)).toBeNull();
    });

    it('interpolates within a string', () => {
      expect(
        evaluateKritiString(
          'Hello {{$body.input.name}}!',
          context,
        ),
      ).toBe('Hello Alice!');
    });

    it('interpolates multiple expressions in a string', () => {
      expect(
        evaluateKritiString(
          '{{$base_url}}/users/{{$body.input.name}}',
          context,
        ),
      ).toBe('https://api.example.com/users/Alice');
    });

    it('interpolates missing optional values as null in mixed templates', () => {
      expect(
        evaluateKritiString('val={{$body?.missing}}!', context),
      ).toBe('val=null!');
    });
  });

  describe('bracket notation for session variables', () => {
    it('accesses session variables with bracket notation', () => {
      expect(
        evaluateKritiString(
          "{{$session_variables['x-hasura-user-id']}}",
          context,
        ),
      ).toBe('user-456');
    });

    it('uses bracket notation in a mixed template', () => {
      expect(
        evaluateKritiString(
          "Role: {{$session_variables['x-hasura-role']}}",
          context,
        ),
      ).toBe('Role: admin');
    });
  });

  describe('null coalescing', () => {
    it('returns the left value when it exists', () => {
      expect(
        evaluateKritiString('{{$body.input.name ?? "default"}}', context),
      ).toBe('Alice');
    });

    it('returns the right value when left is missing (with optional chaining)', () => {
      expect(
        evaluateKritiString('{{$body?.missing ?? "fallback"}}', context),
      ).toBe('fallback');
    });

    it('returns numeric fallback', () => {
      expect(
        evaluateKritiString('{{$body?.missing ?? 0}}', context),
      ).toBe(0);
    });

    it('returns boolean fallback', () => {
      expect(
        evaluateKritiString('{{$body?.missing ?? false}}', context),
      ).toBe(false);
    });

    it('chains with bracket notation', () => {
      expect(
        evaluateKritiString(
          '{{$session_variables?["x-custom-header"] ?? "none"}}',
          context,
        ),
      ).toBe('none');
    });
  });

  describe('conditionals', () => {
    it('evaluates the then branch when condition is truthy', () => {
      expect(
        evaluateKritiString(
          '{{ if $body.input.flag }} "yes" {{ else }} "no" {{ end }}',
          context,
        ),
      ).toBe('yes');
    });

    it('evaluates the else branch when condition is falsy', () => {
      expect(
        evaluateKritiString(
          '{{ if $body.input.nothing }} "yes" {{ else }} "no" {{ end }}',
          context,
        ),
      ).toBe('no');
    });

    it('evaluates expressions within conditional branches', () => {
      expect(
        evaluateKritiString(
          '{{ if $body.input.flag }} {{$body.input.name}} {{ else }} "unknown" {{ end }}',
          context,
        ),
      ).toBe('Alice');
    });

    it('evaluates condition based on missing path (null = falsy)', () => {
      expect(
        evaluateKritiString(
          '{{ if $body?.missing }} "found" {{ else }} "not found" {{ end }}',
          context,
        ),
      ).toBe('not found');
    });
  });

  describe('literal values', () => {
    it('passes through non-template strings', () => {
      expect(evaluateKritiString('just a string', context)).toBe(
        'just a string',
      );
    });

    it('handles empty template expression', () => {
      expect(evaluateKritiString('', context)).toBe('');
    });
  });
});

// ─── Kriti Template (object/array) Evaluation ───────────────────────────────

describe('Kriti template evaluation', () => {
  const context = {
    $body: {
      input: { amount: 50, currency: 'eur' },
    },
    $session_variables: {
      'x-hasura-user-id': 'user-789',
    },
  };

  it('recursively evaluates object templates', () => {
    const template = {
      payment_amount: '{{$body.input.amount}}',
      user: "{{$session_variables['x-hasura-user-id']}}",
      static: 'unchanged',
    };
    expect(evaluateKritiTemplate(template, context)).toEqual({
      payment_amount: 50,
      user: 'user-789',
      static: 'unchanged',
    });
  });

  it('recursively evaluates array templates', () => {
    const template = ['{{$body.input.amount}}', '{{$body.input.currency}}'];
    expect(evaluateKritiTemplate(template, context)).toEqual([50, 'eur']);
  });

  it('handles nested objects', () => {
    const template = {
      data: {
        amount: '{{$body.input.amount}}',
        meta: { user: "{{$session_variables['x-hasura-user-id']}}" },
      },
    };
    expect(evaluateKritiTemplate(template, context)).toEqual({
      data: {
        amount: 50,
        meta: { user: 'user-789' },
      },
    });
  });

  it('passes through non-template primitives', () => {
    const template = { count: 42, active: true, label: 'static', nothing: null };
    expect(evaluateKritiTemplate(template, context)).toEqual({
      count: 42,
      active: true,
      label: 'static',
      nothing: null,
    });
  });

  it('evaluates null coalescing in object values', () => {
    const template = {
      name: '{{$body?.name ?? "anonymous"}}',
      amount: '{{$body.input.amount}}',
    };
    expect(evaluateKritiTemplate(template, context)).toEqual({
      name: 'anonymous',
      amount: 50,
    });
  });
});

// ─── Kriti URL Template ─────────────────────────────────────────────────────

describe('Kriti URL template', () => {
  const context = {
    $body: {
      input: { id: 'item-42', malicious: '../../admin' },
    },
    $base_url: 'https://api.example.com',
  };

  it('interpolates URL with safe values', () => {
    expect(
      evaluateKritiUrlTemplate(
        '{{$base_url}}/items/{{$body.input.id}}',
        context,
      ),
    ).toBe('https://api.example.com/items/item-42');
  });

  it('rejects path traversal attempts', () => {
    expect(() =>
      evaluateKritiUrlTemplate(
        '{{$base_url}}/items/{{$body.input.malicious}}',
        context,
      ),
    ).toThrow(/Path traversal/);
  });

  it('returns full URL for single expression', () => {
    expect(evaluateKritiUrlTemplate('{{$base_url}}', context)).toBe(
      'https://api.example.com',
    );
  });
});

// ─── Integration: Request Transform with Kriti ──────────────────────────────

describe('Request transform with Kriti engine', () => {
  const originalRequest = {
    url: 'https://api.example.com/webhook',
    method: 'POST',
    body: {
      action: { name: 'createPayment' },
      input: { amount: 50, currency: 'eur' },
      session_variables: { 'x-hasura-role': 'client' },
    },
    headers: { 'Content-Type': 'application/json' },
  };

  const transformContext = {
    sessionVariables: {
      'x-hasura-role': 'client',
      'x-hasura-user-id': 'user-456',
    },
    baseUrl: 'https://api.example.com/webhook',
  };

  it('uses Kriti engine when templateEngine is set', () => {
    const transform: RequestTransform = {
      templateEngine: 'Kriti',
      body: {
        payment_amount: '{{$body.input.amount}}',
        user: "{{$session_variables['x-hasura-user-id']}}",
      },
    };
    const result = applyRequestTransform(transform, originalRequest, transformContext);
    expect(result.body).toEqual({
      payment_amount: 50,
      user: 'user-456',
    });
  });

  it('supports null coalescing in Kriti body transforms', () => {
    const transform: RequestTransform = {
      templateEngine: 'Kriti',
      body: {
        name: '{{$body?.name ?? "anonymous"}}',
        amount: '{{$body.input.amount}}',
      },
    };
    const result = applyRequestTransform(transform, originalRequest, transformContext);
    expect(result.body).toEqual({
      name: 'anonymous',
      amount: 50,
    });
  });

  it('supports bracket notation in Kriti header transforms', () => {
    const transform: RequestTransform = {
      templateEngine: 'Kriti',
      headers: {
        'X-User-Id': "{{$session_variables['x-hasura-user-id']}}",
      },
    };
    const result = applyRequestTransform(transform, originalRequest, transformContext);
    expect(result.headers['X-User-Id']).toBe('user-456');
  });

  it('supports Kriti URL transforms', () => {
    const transform: RequestTransform = {
      templateEngine: 'Kriti',
      url: '{{$base_url}}/v2/payments/{{$body.input.currency}}',
    };
    const result = applyRequestTransform(transform, originalRequest, transformContext);
    expect(result.url).toBe(
      'https://api.example.com/webhook/v2/payments/eur',
    );
  });

  it('uses default engine when templateEngine is not set', () => {
    const transform: RequestTransform = {
      body: {
        payment_amount: '{{$body.input.amount}}',
      },
    };
    const result = applyRequestTransform(transform, originalRequest, transformContext);
    expect(result.body).toEqual({ payment_amount: 50 });
  });

  it('supports Kriti query params', () => {
    const transform: RequestTransform = {
      templateEngine: 'Kriti',
      queryParams: {
        user: "{{$session_variables['x-hasura-user-id']}}",
        amount: '{{$body.input.amount ?? 0}}',
      },
    };
    const result = applyRequestTransform(transform, originalRequest, transformContext);
    const url = new URL(result.url);
    expect(url.searchParams.get('user')).toBe('user-456');
    expect(url.searchParams.get('amount')).toBe('50');
  });
});

// ─── Integration: Response Transform with Kriti ─────────────────────────────

describe('Response transform with Kriti engine', () => {
  it('uses Kriti engine for response transforms', () => {
    const responseBody = {
      result: { ok: true, status: 'completed', amount: 75.5 },
    };
    const transform: ResponseTransform = {
      templateEngine: 'Kriti',
      body: {
        success: '{{$body.result.ok}}',
        status: '{{$body.result.status}}',
        amount: '{{$body.result.amount}}',
      },
    };
    const result = applyResponseTransform(transform, responseBody, {
      sessionVariables: {},
    });
    expect(result).toEqual({
      success: true,
      status: 'completed',
      amount: 75.5,
    });
  });

  it('supports bracket notation in response transforms', () => {
    const responseBody = { data: 'test' };
    const transform: ResponseTransform = {
      templateEngine: 'Kriti',
      body: {
        data: '{{$body.data}}',
        role: "{{$session_variables['x-hasura-role']}}",
      },
    };
    const result = applyResponseTransform(transform, responseBody, {
      sessionVariables: { 'x-hasura-role': 'admin' },
    });
    expect(result).toEqual({ data: 'test', role: 'admin' });
  });

  it('supports null coalescing in response transforms', () => {
    const responseBody = { status: 'ok' };
    const transform: ResponseTransform = {
      templateEngine: 'Kriti',
      body: {
        status: '{{$body.status}}',
        message: '{{$body?.message ?? "no message"}}',
      },
    };
    const result = applyResponseTransform(transform, responseBody, {
      sessionVariables: {},
    });
    expect(result).toEqual({ status: 'ok', message: 'no message' });
  });

  it('uses default engine when templateEngine is not set', () => {
    const responseBody = { status: 'ok' };
    const transform: ResponseTransform = {
      body: { status: '{{$body.status}}' },
    };
    const result = applyResponseTransform(transform, responseBody, {
      sessionVariables: {},
    });
    expect(result).toEqual({ status: 'ok' });
  });
});
