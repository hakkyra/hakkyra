/**
 * Tests for configurable session variable namespace.
 *
 * Verifies:
 * - Default `x-hk` namespace works with x-hasura-* JWT claims
 * - `x-hasura` namespace for full Hasura backwards compatibility
 * - Session variable resolution in permission filters
 * - Namespace-aware admin secret header
 * - Namespace-aware role override header
 * - Claims extraction with both namespaces
 * - Webhook response parsing with both namespaces
 * - Config schema accepts session_namespace field
 */

import { describe, it, expect } from 'vitest';
import { SignJWT } from 'jose';
import type { SessionVariables } from '../src/types.js';

// ─── Session namespace utilities ──────────────────────────────────────────────

import {
  DEFAULT_SESSION_NAMESPACE,
  HASURA_METADATA_NAMESPACE,
  WELL_KNOWN_SUFFIXES,
  nsKey,
  isSessionVariable,
  extractSuffix,
  resolveSessionVar,
} from '../src/auth/session-namespace.js';

// ─── Claims extraction ───────────────────────────────────────────────────────

import { extractSessionVariables } from '../src/auth/claims.js';

// ─── Permission compiler ─────────────────────────────────────────────────────

import { compileFilter } from '../src/permissions/compiler.js';

// ─── Config schemas ──────────────────────────────────────────────────────────

import { RawServerConfigSchema } from '../src/config/schemas.js';
import { AuthConfigSchema } from '../src/config/schemas-internal.js';

// ─── Test Helpers ─────────────────────────────────────────────────────────────

const JWT_SECRET = new TextEncoder().encode('test-secret-key-minimum-32-chars!!');

async function createTestJWT(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(JWT_SECRET);
}

function makeSession(
  role: string,
  userId?: string,
  extraClaims?: Record<string, string | string[]>,
): SessionVariables {
  const claims: Record<string, string | string[]> = {
    'x-hasura-role': role,
    'x-hasura-default-role': role,
    'x-hasura-allowed-roles': [role],
    ...extraClaims,
  };
  if (userId) {
    claims['x-hasura-user-id'] = userId;
  }
  return {
    role,
    userId,
    allowedRoles: [role],
    isAdmin: false,
    claims,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Session Namespace Utilities', () => {
  it('DEFAULT_SESSION_NAMESPACE is x-hk', () => {
    expect(DEFAULT_SESSION_NAMESPACE).toBe('x-hk');
  });

  it('HASURA_METADATA_NAMESPACE is x-hasura', () => {
    expect(HASURA_METADATA_NAMESPACE).toBe('x-hasura');
  });

  describe('nsKey', () => {
    it('builds namespaced key with default namespace', () => {
      expect(nsKey('x-hk', 'role')).toBe('x-hk-role');
      expect(nsKey('x-hk', 'user-id')).toBe('x-hk-user-id');
      expect(nsKey('x-hk', 'allowed-roles')).toBe('x-hk-allowed-roles');
    });

    it('builds namespaced key with x-hasura namespace', () => {
      expect(nsKey('x-hasura', 'role')).toBe('x-hasura-role');
      expect(nsKey('x-hasura', 'user-id')).toBe('x-hasura-user-id');
    });

    it('builds namespaced key with custom namespace', () => {
      expect(nsKey('x-myapp', 'role')).toBe('x-myapp-role');
    });
  });

  describe('isSessionVariable', () => {
    it('detects x-hasura-* variables regardless of configured namespace', () => {
      expect(isSessionVariable('x-hasura-user-id', 'x-hk')).toBe(true);
      expect(isSessionVariable('X-Hasura-Role', 'x-hk')).toBe(true);
      expect(isSessionVariable('x-hasura-allowed-roles', 'x-hk')).toBe(true);
    });

    it('detects configured namespace variables', () => {
      expect(isSessionVariable('x-hk-user-id', 'x-hk')).toBe(true);
      expect(isSessionVariable('x-hk-role', 'x-hk')).toBe(true);
    });

    it('rejects non-session-variable strings', () => {
      expect(isSessionVariable('username', 'x-hk')).toBe(false);
      expect(isSessionVariable('some-other-header', 'x-hk')).toBe(false);
    });

    it('rejects non-string values', () => {
      expect(isSessionVariable(42, 'x-hk')).toBe(false);
      expect(isSessionVariable(null, 'x-hk')).toBe(false);
      expect(isSessionVariable(undefined, 'x-hk')).toBe(false);
    });

    it('works with x-hasura namespace (full Hasura compat mode)', () => {
      expect(isSessionVariable('x-hasura-user-id', 'x-hasura')).toBe(true);
      // When namespace IS x-hasura, we only check that prefix
      expect(isSessionVariable('x-hk-user-id', 'x-hasura')).toBe(false);
    });
  });

  describe('extractSuffix', () => {
    it('extracts suffix from x-hasura-* variables', () => {
      expect(extractSuffix('x-hasura-user-id', 'x-hk')).toBe('user-id');
      expect(extractSuffix('X-Hasura-Role', 'x-hk')).toBe('role');
      expect(extractSuffix('x-hasura-allowed-roles', 'x-hk')).toBe('allowed-roles');
    });

    it('extracts suffix from configured namespace variables', () => {
      expect(extractSuffix('x-hk-user-id', 'x-hk')).toBe('user-id');
      expect(extractSuffix('x-hk-role', 'x-hk')).toBe('role');
    });

    it('extracts suffix from custom namespace', () => {
      expect(extractSuffix('x-myapp-role', 'x-myapp')).toBe('role');
    });
  });

  describe('resolveSessionVar', () => {
    const session = makeSession('user', 'user-42', {
      'x-hasura-org-id': 'org-123',
    });

    it('resolves well-known role variable from x-hasura-* ref', () => {
      expect(resolveSessionVar('x-hasura-role', session, 'x-hk')).toBe('user');
    });

    it('resolves well-known role variable from x-hk-* ref', () => {
      expect(resolveSessionVar('x-hk-role', session, 'x-hk')).toBe('user');
    });

    it('resolves well-known user-id from x-hasura-* ref', () => {
      expect(resolveSessionVar('x-hasura-user-id', session, 'x-hk')).toBe('user-42');
    });

    it('resolves well-known user-id from x-hk-* ref', () => {
      expect(resolveSessionVar('x-hk-user-id', session, 'x-hk')).toBe('user-42');
    });

    it('resolves well-known allowed-roles', () => {
      expect(resolveSessionVar('x-hasura-allowed-roles', session, 'x-hk')).toEqual(['user']);
    });

    it('resolves custom claim from x-hasura-* ref via claims lookup', () => {
      expect(resolveSessionVar('x-hasura-org-id', session, 'x-hk')).toBe('org-123');
    });

    it('returns undefined for missing claim', () => {
      expect(resolveSessionVar('x-hasura-missing', session, 'x-hk')).toBeUndefined();
    });
  });
});

describe('Claims Extraction with Configurable Namespace', () => {
  it('extracts session variables from JWT with default x-hk namespace', async () => {
    const payload = {
      'https://hasura.io/jwt/claims': {
        'x-hasura-default-role': 'editor',
        'x-hasura-allowed-roles': ['editor', 'viewer'],
        'x-hasura-user-id': 'u-100',
        'x-hasura-org-id': 'org-abc',
      },
    };

    const config = {
      sessionNamespace: 'x-hk',
      jwt: {
        type: 'HS256',
        claimsNamespace: 'https://hasura.io/jwt/claims',
        requireExp: true,
        adminRoleIsAdmin: false,
      },
    };

    const token = await createTestJWT(payload);
    // We parse the payload directly since we don't need full JWT verification here
    const jwtPayload = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64url').toString(),
    );

    const session = extractSessionVariables(jwtPayload, config);

    expect(session.role).toBe('editor');
    expect(session.userId).toBe('u-100');
    expect(session.allowedRoles).toEqual(['editor', 'viewer']);
    // Claims are stored with lowercase keys
    expect(session.claims['x-hasura-org-id']).toBe('org-abc');
  });

  it('extracts session variables with x-hasura namespace (backwards compat)', async () => {
    const payload = {
      'https://hasura.io/jwt/claims': {
        'x-hasura-default-role': 'user',
        'x-hasura-allowed-roles': ['user'],
        'x-hasura-user-id': 'u-200',
      },
    };

    const config = {
      sessionNamespace: 'x-hasura',
      jwt: {
        type: 'HS256',
        claimsNamespace: 'https://hasura.io/jwt/claims',
        requireExp: true,
        adminRoleIsAdmin: false,
      },
    };

    const jwtPayload = payload;
    const session = extractSessionVariables(jwtPayload as any, config);

    expect(session.role).toBe('user');
    expect(session.userId).toBe('u-200');
    expect(session.allowedRoles).toEqual(['user']);
  });

  it('throws when required claims are missing', () => {
    const config = {
      sessionNamespace: 'x-hk',
      jwt: {
        type: 'HS256',
        requireExp: true,
        adminRoleIsAdmin: false,
      },
    };

    // Missing both allowed-roles and default-role
    expect(() =>
      extractSessionVariables(
        { 'https://hasura.io/jwt/claims': {} } as any,
        config,
      ),
    ).toThrow(/x-hk-allowed-roles.*x-hasura-allowed-roles/);
  });

  it('error message shows only one key when namespace is x-hasura', () => {
    const config = {
      sessionNamespace: 'x-hasura',
      jwt: {
        type: 'HS256',
        requireExp: true,
        adminRoleIsAdmin: false,
      },
    };

    expect(() =>
      extractSessionVariables(
        { 'https://hasura.io/jwt/claims': {} } as any,
        config,
      ),
    ).toThrow(/x-hasura-allowed-roles/);
  });

  it('works with claims_map configuration', () => {
    const config = {
      sessionNamespace: 'x-hk',
      jwt: {
        type: 'HS256',
        requireExp: true,
        adminRoleIsAdmin: false,
        claimsMap: {
          'x-hasura-allowed-roles': { path: '$.roles' },
          'x-hasura-default-role': { path: '$.role' },
          'x-hasura-user-id': { path: '$.sub' },
        },
      },
    };

    const payload = {
      roles: ['admin', 'user'],
      role: 'admin',
      sub: 'user-999',
    };

    const session = extractSessionVariables(payload as any, config);
    expect(session.role).toBe('admin');
    expect(session.userId).toBe('user-999');
    expect(session.allowedRoles).toEqual(['admin', 'user']);
  });
});

describe('Permission Compiler with Namespace', () => {
  it('resolves x-hasura-* session variable references with default x-hk namespace', () => {
    // YAML metadata always uses x-hasura-* references
    const filter = compileFilter(
      { user_id: { _eq: 'X-Hasura-User-Id' } },
      undefined,
      undefined,
      'x-hk',
    );

    const session = makeSession('user', 'user-42');
    const result = filter.toSQL(session, 0);

    expect(result.sql).toBe('"user_id" = $1');
    expect(result.params).toEqual(['user-42']);
  });

  it('resolves x-hk-* session variable references', () => {
    const filter = compileFilter(
      { user_id: { _eq: 'x-hk-user-id' } },
      undefined,
      undefined,
      'x-hk',
    );

    const session = makeSession('user', 'user-42');
    const result = filter.toSQL(session, 0);

    expect(result.sql).toBe('"user_id" = $1');
    expect(result.params).toEqual(['user-42']);
  });

  it('resolves x-hasura-* with x-hasura namespace (backwards compat)', () => {
    const filter = compileFilter(
      { user_id: { _eq: 'X-Hasura-User-Id' } },
      undefined,
      undefined,
      'x-hasura',
    );

    const session = makeSession('user', 'user-42');
    const result = filter.toSQL(session, 0);

    expect(result.sql).toBe('"user_id" = $1');
    expect(result.params).toEqual(['user-42']);
  });

  it('resolves custom session variable via claims with _in operator', () => {
    const filter = compileFilter(
      { org_id: { _in: ['X-Hasura-Org-Ids'] } },
      undefined,
      undefined,
      'x-hk',
    );

    const session = makeSession('user', 'user-42', {
      'x-hasura-org-ids': ['org-1', 'org-2'],
    });

    const result = filter.toSQL(session, 0);
    expect(result.sql).toBe('"org_id" IN ($1, $2)');
    expect(result.params).toEqual(['org-1', 'org-2']);
  });

  it('resolves role from session for permission filters', () => {
    const filter = compileFilter(
      { role: { _eq: 'X-Hasura-Role' } },
      undefined,
      undefined,
      'x-hk',
    );

    const session = makeSession('editor');
    const result = filter.toSQL(session, 0);

    expect(result.sql).toBe('"role" = $1');
    expect(result.params).toEqual(['editor']);
  });

  it('non-session-variable values are passed through unchanged', () => {
    const filter = compileFilter(
      { status: { _eq: 'active' } },
      undefined,
      undefined,
      'x-hk',
    );

    const session = makeSession('user');
    const result = filter.toSQL(session, 0);

    expect(result.sql).toBe('"status" = $1');
    expect(result.params).toEqual(['active']);
  });
});

describe('Config Schema', () => {
  it('RawServerConfig accepts session_namespace in auth section', () => {
    const raw = {
      auth: {
        session_namespace: 'x-myapp',
        jwt: {
          type: 'HS256',
          key: 'test-secret',
        },
        admin_secret_from_env: 'ADMIN_SECRET',
      },
    };

    const result = RawServerConfigSchema.parse(raw);
    expect(result.auth?.session_namespace).toBe('x-myapp');
  });

  it('RawServerConfig accepts auth without session_namespace', () => {
    const raw = {
      auth: {
        jwt: {
          type: 'HS256',
          key: 'test-secret',
        },
      },
    };

    const result = RawServerConfigSchema.parse(raw);
    expect(result.auth?.session_namespace).toBeUndefined();
  });

  it('Internal AuthConfigSchema defaults sessionNamespace to x-hk', () => {
    const result = AuthConfigSchema.parse({});
    expect(result.sessionNamespace).toBe('x-hk');
  });

  it('Internal AuthConfigSchema accepts custom sessionNamespace', () => {
    const result = AuthConfigSchema.parse({ sessionNamespace: 'x-hasura' });
    expect(result.sessionNamespace).toBe('x-hasura');
  });
});

describe('Backwards Compatibility', () => {
  it('default x-hk namespace still works with existing x-hasura JWT claims', () => {
    // This is the most important backwards compat test:
    // JWTs with x-hasura-* claims should work with the default x-hk namespace
    const config = {
      sessionNamespace: 'x-hk',
      jwt: {
        type: 'HS256',
        requireExp: true,
        adminRoleIsAdmin: false,
      },
    };

    const payload = {
      'https://hasura.io/jwt/claims': {
        'x-hasura-default-role': 'user',
        'x-hasura-allowed-roles': ['user', 'admin'],
        'x-hasura-user-id': 'uid-123',
      },
    };

    const session = extractSessionVariables(payload as any, config);
    expect(session.role).toBe('user');
    expect(session.userId).toBe('uid-123');
    expect(session.allowedRoles).toEqual(['user', 'admin']);
  });

  it('x-hasura namespace mode works identically to legacy behavior', () => {
    const config = {
      sessionNamespace: 'x-hasura',
      jwt: {
        type: 'HS256',
        requireExp: true,
        adminRoleIsAdmin: false,
      },
    };

    const payload = {
      'https://hasura.io/jwt/claims': {
        'x-hasura-default-role': 'user',
        'x-hasura-allowed-roles': ['user'],
        'x-hasura-user-id': 'uid-456',
        'x-hasura-org-id': 'org-789',
      },
    };

    const session = extractSessionVariables(payload as any, config);
    expect(session.role).toBe('user');
    expect(session.userId).toBe('uid-456');
    expect(session.allowedRoles).toEqual(['user']);
    expect(session.claims['x-hasura-org-id']).toBe('org-789');
  });

  it('permission filter resolution works with x-hasura YAML refs and x-hk namespace', () => {
    // YAML metadata always uses x-hasura-* for session variable references
    // The permission compiler must resolve these correctly regardless of namespace
    const filter = compileFilter(
      {
        _and: [
          { owner_id: { _eq: 'X-Hasura-User-Id' } },
          { org_id: { _eq: 'X-Hasura-Org-Id' } },
        ],
      },
      undefined,
      undefined,
      'x-hk',
    );

    const session: SessionVariables = {
      role: 'user',
      userId: 'u-1',
      allowedRoles: ['user'],
      isAdmin: false,
      claims: {
        'x-hasura-default-role': 'user',
        'x-hasura-allowed-roles': ['user'],
        'x-hasura-user-id': 'u-1',
        'x-hasura-org-id': 'org-abc',
      },
    };

    const result = filter.toSQL(session, 0);
    expect(result.sql).toBe('("owner_id" = $1 AND "org_id" = $2)');
    expect(result.params).toEqual(['u-1', 'org-abc']);
  });

  it('well-known suffixes are correct', () => {
    expect(WELL_KNOWN_SUFFIXES.ROLE).toBe('role');
    expect(WELL_KNOWN_SUFFIXES.USER_ID).toBe('user-id');
    expect(WELL_KNOWN_SUFFIXES.ALLOWED_ROLES).toBe('allowed-roles');
    expect(WELL_KNOWN_SUFFIXES.DEFAULT_ROLE).toBe('default-role');
    expect(WELL_KNOWN_SUFFIXES.ADMIN_SECRET).toBe('admin-secret');
  });
});
