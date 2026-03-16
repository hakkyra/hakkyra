/**
 * Tests for P8.1 security fixes:
 * 1. Action webhook error sanitization
 * 2. REST error response PG internals leak prevention
 * 3. URL template path traversal protection in action transforms
 * 4. DNS rebinding prevention for webhook SSRF (P7.1)
 * 5. URL-safe interpolation for path traversal prevention (P8.1 enhancement)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sanitizeWebhookError } from '../src/actions/proxy.js';
import {
  applyRequestTransform,
  interpolateUrlTemplate,
  validateUrlSafe,
} from '../src/actions/transform.js';
import {
  isPrivateIP,
  resolveAndValidateDns,
} from '../src/shared/webhook.js';
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

    it('encodes path traversal characters in interpolated URL values', () => {
      const transform: RequestTransform = {
        url: '{{$base_url}}/{{$body.input.path}}/endpoint',
      };

      // With URL-safe interpolation, the ".." is encoded to "%2E%2E" and "/" to "%2F",
      // neutralizing the path traversal without throwing.
      const result = applyRequestTransform(transform, originalRequest, context);
      expect(result.url).not.toContain('/../');
      expect(result.url).toContain(encodeURIComponent('../../admin'));
    });

    it('encodes slashes in user-controlled path segments', () => {
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

      // The "/" in "users/123" gets encoded to prevent path injection
      const result = applyRequestTransform(transform, safeRequest, context);
      expect(result.url).toBe('https://api.example.com/webhook/users%2F123/details');
    });

    it('allows a plain string value without special characters', () => {
      const safeRequest = {
        ...originalRequest,
        body: {
          ...originalRequest.body,
          input: { path: 'user-123' },
        },
      };

      const transform: RequestTransform = {
        url: '{{$base_url}}/{{$body.input.path}}/details',
      };

      const result = applyRequestTransform(transform, safeRequest, context);
      expect(result.url).toBe('https://api.example.com/webhook/user-123/details');
    });
  });
});

// ─── 4. DNS Rebinding Prevention (P7.1) ─────────────────────────────────────

describe('DNS rebinding prevention for webhook SSRF (P7.1)', () => {
  describe('resolveAndValidateDns', () => {
    it('returns null for raw IPv4 addresses (no DNS rebinding possible)', async () => {
      const result = await resolveAndValidateDns('https://93.184.216.34/webhook');
      expect(result).toBeNull();
    });

    it('rejects private IPv4 addresses', async () => {
      await expect(resolveAndValidateDns('https://127.0.0.1/webhook'))
        .rejects.toThrow('private/reserved');
    });

    it('rejects 10.x.x.x private range', async () => {
      await expect(resolveAndValidateDns('https://10.0.0.1/webhook'))
        .rejects.toThrow('private/reserved');
    });

    it('rejects 192.168.x.x private range', async () => {
      await expect(resolveAndValidateDns('https://192.168.1.1/webhook'))
        .rejects.toThrow('private/reserved');
    });

    it('rejects 172.16-31.x.x private range', async () => {
      await expect(resolveAndValidateDns('https://172.16.0.1/webhook'))
        .rejects.toThrow('private/reserved');
    });

    it('rejects link-local addresses', async () => {
      await expect(resolveAndValidateDns('https://169.254.1.1/webhook'))
        .rejects.toThrow('private/reserved');
    });

    it('rejects IPv6 loopback', async () => {
      await expect(resolveAndValidateDns('https://[::1]/webhook'))
        .rejects.toThrow('private/reserved');
    });

    it('throws on invalid URL', async () => {
      await expect(resolveAndValidateDns('not-a-url'))
        .rejects.toThrow('Invalid webhook URL');
    });

    it('returns resolvedUrl and hostHeader when hostname resolves to public IP', async () => {
      const fakeLookup = async () => [{ address: '93.184.216.34', family: 4 }];

      const result = await resolveAndValidateDns('https://example.com/webhook', fakeLookup);
      expect(result).not.toBeNull();
      expect(result!.resolvedUrl).toContain('93.184.216.34');
      expect(result!.hostHeader).toBe('example.com');
    });

    it('rejects when hostname resolves to a private IP (DNS rebinding scenario)', async () => {
      // Simulate a DNS rebinding attack: hostname resolves to a private IP
      const fakeLookup = async () => [{ address: '127.0.0.1', family: 4 }];

      await expect(resolveAndValidateDns('https://evil-rebind.attacker.com/webhook', fakeLookup))
        .rejects.toThrow('private/reserved');
    });

    it('rejects when any resolved address is private (multi-address)', async () => {
      // DNS returns multiple IPs: one public, one private
      const fakeLookup = async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.1', family: 4 },
      ];

      await expect(resolveAndValidateDns('https://dual-stack.attacker.com/webhook', fakeLookup))
        .rejects.toThrow('private/reserved');
    });

    it('preserves port in resolved URL', async () => {
      const fakeLookup = async () => [{ address: '93.184.216.34', family: 4 }];

      const result = await resolveAndValidateDns('https://example.com:8443/webhook', fakeLookup);
      expect(result).not.toBeNull();
      expect(result!.resolvedUrl).toContain('93.184.216.34');
      expect(result!.resolvedUrl).toContain('8443');
      expect(result!.hostHeader).toBe('example.com:8443');
    });

    it('preserves path and query in resolved URL', async () => {
      const fakeLookup = async () => [{ address: '93.184.216.34', family: 4 }];

      const result = await resolveAndValidateDns('https://example.com/api/v2/hook?token=abc', fakeLookup);
      expect(result).not.toBeNull();
      expect(result!.resolvedUrl).toContain('/api/v2/hook');
      expect(result!.resolvedUrl).toContain('token=abc');
    });

    it('propagates DNS resolution errors instead of falling back to unpinned fetch (TOCTOU fix)', async () => {
      // Previously, DNS errors caused a fallback to validateWebhookUrl() + return null,
      // meaning deliverWebhook would call fetch() with the original hostname. An attacker
      // could exploit this by having DNS fail during validation but succeed during fetch
      // with a private IP. Now DNS errors propagate directly, preventing any unpinned request.
      const failingLookup = async () => {
        throw new Error('getaddrinfo ENOTFOUND evil.example.com');
      };

      await expect(resolveAndValidateDns('https://evil.example.com/webhook', failingLookup))
        .rejects.toThrow('ENOTFOUND');
    });

    it('resolved IP is embedded in URL to prevent second DNS lookup', async () => {
      // Verify the critical property: the returned URL contains the IP, not the hostname.
      // This ensures fetch() connects to the validated IP directly, with no second DNS lookup.
      const fakeLookup = async () => [{ address: '203.0.113.50', family: 4 }];

      const result = await resolveAndValidateDns('https://webhook.example.com:443/path', fakeLookup);
      expect(result).not.toBeNull();
      // The resolved URL must contain the IP address, NOT the hostname
      expect(result!.resolvedUrl).toContain('203.0.113.50');
      expect(result!.resolvedUrl).not.toContain('webhook.example.com');
      // The original host is preserved in the Host header value
      expect(result!.hostHeader).toBe('webhook.example.com');
    });

    it('handles IPv6 resolved address with brackets in URL', async () => {
      const fakeLookup = async () => [{ address: '2001:db8::1', family: 6 }];

      const result = await resolveAndValidateDns('https://example.com/webhook', fakeLookup);
      expect(result).not.toBeNull();
      // IPv6 addresses must be wrapped in brackets in the URL
      expect(result!.resolvedUrl).toContain('[2001:db8::1]');
      expect(result!.hostHeader).toBe('example.com');
    });
  });

  describe('isPrivateIP coverage', () => {
    it('detects IPv4-mapped IPv6 private addresses', () => {
      expect(isPrivateIP('::ffff:127.0.0.1')).toBe(true);
      expect(isPrivateIP('::ffff:10.0.0.1')).toBe(true);
      expect(isPrivateIP('::ffff:192.168.1.1')).toBe(true);
      expect(isPrivateIP('::ffff:172.16.0.1')).toBe(true);
    });

    it('allows IPv4-mapped IPv6 public addresses', () => {
      expect(isPrivateIP('::ffff:93.184.216.34')).toBe(false);
      expect(isPrivateIP('::ffff:8.8.8.8')).toBe(false);
    });

    it('detects IPv6 unique local addresses (fc00::/7)', () => {
      expect(isPrivateIP('fc00::1')).toBe(true);
      expect(isPrivateIP('fd12:3456:789a::1')).toBe(true);
    });

    it('detects IPv6 link-local addresses (fe80::/10)', () => {
      expect(isPrivateIP('fe80::1')).toBe(true);
    });

    it('allows public IPv4 addresses', () => {
      expect(isPrivateIP('8.8.8.8')).toBe(false);
      expect(isPrivateIP('93.184.216.34')).toBe(false);
      expect(isPrivateIP('1.1.1.1')).toBe(false);
    });

    it('detects 0.0.0.0 as private', () => {
      expect(isPrivateIP('0.0.0.0')).toBe(true);
    });

    it('detects :: as private', () => {
      expect(isPrivateIP('::')).toBe(true);
    });
  });
});

// ─── 5. URL-Safe Template Interpolation (P8.1 Enhancement) ──────────────────

describe('URL-safe template interpolation (P8.1)', () => {
  describe('interpolateUrlTemplate', () => {
    const variables = {
      $base_url: 'https://api.example.com',
      $body: {
        input: {
          id: 'user-123',
          malicious: '../../admin',
          withSlash: 'a/b/c',
          withSpecial: 'hello world&foo=bar',
          numeric: 42,
        },
      },
      $session_variables: {
        'x-hasura-user-id': 'uid-456',
      },
    };

    it('returns raw value for single-expression templates (full URL from variable)', () => {
      const result = interpolateUrlTemplate('{{$base_url}}', variables);
      expect(result).toBe('https://api.example.com');
    });

    it('encodes interpolated values in mixed templates', () => {
      const result = interpolateUrlTemplate(
        '{{$base_url}}/users/{{$body.input.malicious}}/profile',
        variables,
      );
      // The ".." and "/" in the malicious value should be encoded
      expect(result).not.toContain('/../');
      expect(result).toContain(encodeURIComponent('../../admin'));
      expect(result).toBe('https://api.example.com/users/..%2F..%2Fadmin/profile');
    });

    it('encodes slashes in interpolated path values', () => {
      const result = interpolateUrlTemplate(
        '{{$base_url}}/resource/{{$body.input.withSlash}}',
        variables,
      );
      expect(result).toBe('https://api.example.com/resource/a%2Fb%2Fc');
    });

    it('encodes special URL characters in interpolated values', () => {
      const result = interpolateUrlTemplate(
        '{{$base_url}}/search/{{$body.input.withSpecial}}',
        variables,
      );
      expect(result).toBe('https://api.example.com/search/hello%20world%26foo%3Dbar');
    });

    it('preserves safe characters in non-template parts', () => {
      const result = interpolateUrlTemplate(
        '{{$base_url}}/v2/users/{{$body.input.id}}',
        variables,
      );
      // "user-123" has no special characters, encodeURIComponent preserves "-"
      expect(result).toBe('https://api.example.com/v2/users/user-123');
    });

    it('handles numeric values', () => {
      const result = interpolateUrlTemplate(
        '{{$base_url}}/items/{{$body.input.numeric}}',
        variables,
      );
      expect(result).toBe('https://api.example.com/items/42');
    });

    it('handles null/undefined values as empty string', () => {
      const result = interpolateUrlTemplate(
        '{{$base_url}}/items/{{$body.input.nonexistent}}/details',
        variables,
      );
      expect(result).toBe('https://api.example.com/items//details');
    });

    it('encodes session variables used in URL path', () => {
      const result = interpolateUrlTemplate(
        '{{$base_url}}/users/{{$session_variables.x-hasura-user-id}}/data',
        variables,
      );
      expect(result).toBe('https://api.example.com/users/uid-456/data');
    });
  });
});
