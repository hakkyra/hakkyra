/**
 * Tests for P8.1 security fixes:
 * 1. Action webhook error sanitization
 * 2. REST error response PG internals leak prevention
 * 3. URL template path traversal protection in action transforms
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sanitizeWebhookError } from '../src/actions/proxy.js';
import {
  applyRequestTransform,
  validateUrlSafe,
} from '../src/actions/transform.js';
import type { RequestTransform } from '../src/types.js';

// ─── 1. Webhook Error Sanitization ──────────────────────────────────────────

describe('sanitizeWebhookError', () => {
  let originalNodeEnv: string | undefined;

  beforeEach(() => {
    originalNodeEnv = process.env['NODE_ENV'];
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env['NODE_ENV'];
    } else {
      process.env['NODE_ENV'] = originalNodeEnv;
    }
  });

  describe('in production mode', () => {
    beforeEach(() => {
      process.env['NODE_ENV'] = 'production';
    });

    it('preserves short, normal error messages', () => {
      const msg = 'Payment declined: insufficient funds';
      expect(sanitizeWebhookError(msg)).toBe(msg);
    });

    it('truncates error messages longer than 500 characters', () => {
      const msg = 'A'.repeat(600);
      const result = sanitizeWebhookError(msg);
      expect(result.length).toBe(500);
      expect(result.endsWith('...')).toBe(true);
    });

    it('strips stack trace patterns', () => {
      const msg = 'Error: something failed\n    at Module._compile (/app/src/handler.ts:42:10)\n    at Object.Module._extensions (/app/node_modules/ts-node/src/index.ts:1587:43)';
      const result = sanitizeWebhookError(msg);
      expect(result).not.toContain('/app/src/handler.ts');
      expect(result).not.toContain('Module._compile');
      expect(result).toContain('[redacted]');
    });

    it('strips absolute file paths', () => {
      const msg = 'Failed to read /home/deploy/app/config/secrets.json';
      const result = sanitizeWebhookError(msg);
      expect(result).not.toContain('/home/deploy/app/config/secrets.json');
      expect(result).toContain('[redacted]');
    });

    it('strips connection strings with credentials', () => {
      const msg = 'Cannot connect to postgres://admin:s3cret@db.internal:5432/mydb';
      const result = sanitizeWebhookError(msg);
      expect(result).not.toContain('admin:s3cret');
      expect(result).not.toContain('db.internal');
      expect(result).toContain('[redacted]');
    });

    it('strips HTTPS URLs with embedded credentials', () => {
      const msg = 'Upstream error at https://user:pass@api.internal.corp/v2/endpoint';
      const result = sanitizeWebhookError(msg);
      expect(result).not.toContain('user:pass');
      expect(result).toContain('[redacted]');
    });

    it('collapses multiple consecutive redactions', () => {
      const msg = 'Error at /a/b/c/d and /e/f/g/h and /i/j/k/l';
      const result = sanitizeWebhookError(msg);
      // Should not have three consecutive [redacted] markers
      expect(result).not.toMatch(/\[redacted\]\s*\[redacted\]\s*\[redacted\]/);
    });
  });

  describe('in non-production mode', () => {
    beforeEach(() => {
      process.env['NODE_ENV'] = 'development';
    });

    it('returns the full error message unchanged', () => {
      const msg = 'Error: something failed\n    at Module._compile (/app/src/handler.ts:42:10)\npostgres://admin:secret@localhost/db';
      expect(sanitizeWebhookError(msg)).toBe(msg);
    });

    it('does not truncate long messages', () => {
      const msg = 'X'.repeat(1000);
      expect(sanitizeWebhookError(msg)).toBe(msg);
    });
  });

  describe('in test mode (default)', () => {
    beforeEach(() => {
      process.env['NODE_ENV'] = 'test';
    });

    it('returns the full error message unchanged (non-production)', () => {
      const msg = 'Detailed error at /some/deep/path/file.ts:10:5';
      expect(sanitizeWebhookError(msg)).toBe(msg);
    });
  });
});

// ─── 2. REST SQL Error Sanitization ─────────────────────────────────────────

describe('REST SQL error sanitization', () => {
  let originalNodeEnv: string | undefined;
  // Lazy import so NODE_ENV is read at call time, not import time
  let sanitizeSQLError: (message: string, genericMessage: string) => string;
  let isDevMode: () => boolean;

  beforeEach(async () => {
    originalNodeEnv = process.env['NODE_ENV'];
    const mod = await import('../src/rest/router.js');
    sanitizeSQLError = mod.sanitizeSQLError;
    isDevMode = mod.isDevMode;
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env['NODE_ENV'];
    } else {
      process.env['NODE_ENV'] = originalNodeEnv;
    }
  });

  describe('isDevMode', () => {
    it('returns false when NODE_ENV is production', () => {
      process.env['NODE_ENV'] = 'production';
      expect(isDevMode()).toBe(false);
    });

    it('returns true when NODE_ENV is development', () => {
      process.env['NODE_ENV'] = 'development';
      expect(isDevMode()).toBe(true);
    });

    it('returns true when NODE_ENV is test', () => {
      process.env['NODE_ENV'] = 'test';
      expect(isDevMode()).toBe(true);
    });

    it('returns true when NODE_ENV is undefined', () => {
      delete process.env['NODE_ENV'];
      expect(isDevMode()).toBe(true);
    });
  });

  describe('in production mode', () => {
    beforeEach(() => {
      process.env['NODE_ENV'] = 'production';
    });

    it('returns generic message instead of PG error with column names', () => {
      const pgError = 'column "secret_column" of relation "users" does not exist';
      expect(sanitizeSQLError(pgError, 'Query failed')).toBe('Query failed');
    });

    it('returns generic message instead of PG type mismatch error', () => {
      const pgError = 'invalid input syntax for type integer: "abc" at column "internal_id"';
      expect(sanitizeSQLError(pgError, 'Query failed')).toBe('Query failed');
    });

    it('returns generic message instead of PG constraint violation', () => {
      const pgError = 'insert or update on table "orders" violates foreign key constraint "orders_user_id_fkey"';
      expect(sanitizeSQLError(pgError, 'Insert failed')).toBe('Insert failed');
    });

    it('returns generic message instead of PG permission error', () => {
      const pgError = 'permission denied for relation admin_secrets';
      expect(sanitizeSQLError(pgError, 'Query failed')).toBe('Query failed');
    });

    it('returns appropriate generic message for different operations', () => {
      const pgError = 'some internal error';
      expect(sanitizeSQLError(pgError, 'Query failed')).toBe('Query failed');
      expect(sanitizeSQLError(pgError, 'Insert failed')).toBe('Insert failed');
      expect(sanitizeSQLError(pgError, 'Update failed')).toBe('Update failed');
      expect(sanitizeSQLError(pgError, 'Delete failed')).toBe('Delete failed');
    });
  });

  describe('in non-production mode', () => {
    beforeEach(() => {
      process.env['NODE_ENV'] = 'development';
    });

    it('returns full PG error message for debugging', () => {
      const pgError = 'column "secret_column" of relation "users" does not exist';
      expect(sanitizeSQLError(pgError, 'Query failed')).toBe(pgError);
    });

    it('returns full constraint violation for debugging', () => {
      const pgError = 'insert or update on table "orders" violates foreign key constraint "orders_user_id_fkey"';
      expect(sanitizeSQLError(pgError, 'Insert failed')).toBe(pgError);
    });

    it('returns full type mismatch error for debugging', () => {
      const pgError = 'invalid input syntax for type integer: "abc" at column "internal_id"';
      expect(sanitizeSQLError(pgError, 'Query failed')).toBe(pgError);
    });
  });

  describe('in test mode', () => {
    beforeEach(() => {
      process.env['NODE_ENV'] = 'test';
    });

    it('returns full error message (non-production behavior)', () => {
      const pgError = 'permission denied for relation admin_secrets';
      expect(sanitizeSQLError(pgError, 'Query failed')).toBe(pgError);
    });
  });
});

// ─── 3. URL Template Path Traversal Protection ──────────────────────────────

describe('URL template path traversal protection', () => {
  describe('validateUrlSafe', () => {
    it('accepts a normal URL', () => {
      expect(() => validateUrlSafe('https://api.example.com/v2/payments')).not.toThrow();
    });

    it('accepts a URL with query parameters', () => {
      expect(() => validateUrlSafe('https://api.example.com/v2/payments?user=123')).not.toThrow();
    });

    it('accepts a URL with a single dot segment', () => {
      expect(() => validateUrlSafe('https://api.example.com/v2/./payments')).not.toThrow();
    });

    it('rejects a URL with .. path traversal', () => {
      expect(() => validateUrlSafe('https://api.example.com/v2/../admin/secret'))
        .toThrow('Path traversal detected');
    });

    it('rejects a URL with encoded .. traversal (%2e%2e)', () => {
      expect(() => validateUrlSafe('https://api.example.com/v2/%2e%2e/admin'))
        .toThrow('Path traversal detected');
    });

    it('rejects a URL with multiple .. segments', () => {
      expect(() => validateUrlSafe('https://api.example.com/a/b/../../etc/passwd'))
        .toThrow('Path traversal detected');
    });

    it('allows ".." in query parameters (not path)', () => {
      expect(() => validateUrlSafe('https://api.example.com/v2/search?q=..&limit=10')).not.toThrow();
    });

    it('allows ".." in fragment (not path)', () => {
      expect(() => validateUrlSafe('https://api.example.com/v2/docs#section/..')).not.toThrow();
    });
  });

  describe('applyRequestTransform with path traversal', () => {
    const originalRequest = {
      url: 'https://api.example.com/webhook',
      method: 'POST',
      body: {
        action: { name: 'test' },
        input: { path: '../../admin' },
        session_variables: {},
      },
      headers: { 'Content-Type': 'application/json' },
    };

    const context = {
      sessionVariables: {},
      baseUrl: 'https://api.example.com/webhook',
    };

    it('throws on path traversal in interpolated URL', () => {
      const transform: RequestTransform = {
        url: '{{$base_url}}/{{$body.input.path}}/endpoint',
      };

      expect(() => applyRequestTransform(transform, originalRequest, context))
        .toThrow('Path traversal detected');
    });

    it('allows a normal interpolated URL', () => {
      const safeRequest = {
        ...originalRequest,
        body: {
          ...originalRequest.body,
          input: { path: 'users/123' },
        },
      };

      const transform: RequestTransform = {
        url: '{{$base_url}}/{{$body.input.path}}/details',
      };

      const result = applyRequestTransform(transform, safeRequest, context);
      expect(result.url).toBe('https://api.example.com/webhook/users/123/details');
    });
  });
});
