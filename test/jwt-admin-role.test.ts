/**
 * Tests for the JWT admin_role_is_admin feature.
 *
 * When `auth.jwt.admin_role_is_admin` is enabled, JWT users whose active role
 * is `admin` are treated as `isAdmin: true`, bypassing permission checks.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SignJWT } from 'jose';
import type { AuthConfig } from '../src/types.js';
import { extractSessionVariables } from '../src/auth/claims.js';
import {
  startServer, stopServer, closePool, waitForDb,
  graphqlRequest, restRequest,
  ADMIN_SECRET, TEST_DB_URL,
  getServerAddress, getPool, createJWT,
  JWT_SECRET,
} from './setup.js';

// ─── JWT helpers for unit tests ──────────────────────────────────────────────

const secretKey = new TextEncoder().encode(JWT_SECRET);

async function createAdminJWT(opts?: { allowedRoles?: string[] }): Promise<string> {
  return createJWT({
    role: 'admin',
    allowedRoles: opts?.allowedRoles ?? ['admin', 'user'],
  });
}

function makeJWTPayload(role: string, allowedRoles: string[]) {
  return {
    'https://hasura.io/jwt/claims': {
      'x-hasura-default-role': role,
      'x-hasura-allowed-roles': allowedRoles,
      'x-hasura-user-id': 'test-user-id',
    },
    sub: 'test-user-id',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
}

// ─── Unit Tests ──────────────────────────────────────────────────────────────

describe('JWT admin_role_is_admin — unit tests', () => {
  const configOff: AuthConfig = {
    jwt: {
      type: 'HS256',
      key: JWT_SECRET,
      requireExp: true,
      adminRoleIsAdmin: false,
    },
  };

  const configOn: AuthConfig = {
    jwt: {
      type: 'HS256',
      key: JWT_SECRET,
      requireExp: true,
      adminRoleIsAdmin: true,
    },
  };

  const configDefault: AuthConfig = {
    jwt: {
      type: 'HS256',
      key: JWT_SECRET,
      requireExp: true,
    },
  };

  it('extractSessionVariables returns isAdmin: false when role is admin but config option is off', () => {
    const payload = makeJWTPayload('admin', ['admin', 'user']);
    const session = extractSessionVariables(payload, configOff);

    expect(session.role).toBe('admin');
    expect(session.isAdmin).toBe(false);
  });

  it('extractSessionVariables returns isAdmin: false when config option is not set (default)', () => {
    const payload = makeJWTPayload('admin', ['admin', 'user']);
    const session = extractSessionVariables(payload, configDefault);

    expect(session.role).toBe('admin');
    expect(session.isAdmin).toBe(false);
  });

  it('extractSessionVariables returns isAdmin: true when config option is on and role is admin', () => {
    const payload = makeJWTPayload('admin', ['admin', 'user']);
    const session = extractSessionVariables(payload, configOn);

    expect(session.role).toBe('admin');
    expect(session.isAdmin).toBe(true);
  });

  it('non-admin roles still get isAdmin: false even when config is on', () => {
    const payload = makeJWTPayload('user', ['admin', 'user']);
    const session = extractSessionVariables(payload, configOn);

    expect(session.role).toBe('user');
    expect(session.isAdmin).toBe(false);
  });

  it('non-admin roles still get isAdmin: false when config is off', () => {
    const payload = makeJWTPayload('user', ['admin', 'user']);
    const session = extractSessionVariables(payload, configOff);

    expect(session.role).toBe('user');
    expect(session.isAdmin).toBe(false);
  });
});

// ─── E2E Tests ───────────────────────────────────────────────────────────────

describe('JWT admin_role_is_admin — E2E', () => {
  /**
   * E2E tests require a running server. The default test fixture config has
   * `admin_role_is_admin` unset (i.e. false). We test the "config off" scenario.
   *
   * Note: the permission lookup already grants ADMIN_PERMISSION for role === 'admin',
   * so table-level queries succeed regardless of isAdmin. The isAdmin flag controls
   * access to tracked functions (which have explicit permission lists), actions, and
   * computed fields. We test tracked function access because searchClients has
   * permissions only for backoffice and administrator — not admin.
   */

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

  it('JWT user with admin role is denied tracked function when config is off (default)', async () => {
    // The test fixture does not set admin_role_is_admin, so it defaults to false.
    // With isAdmin: false, the admin role is subject to function-level permission checks.
    // searchClients only allows backoffice and administrator, not admin.
    const token = await createAdminJWT();

    const { status, body } = await graphqlRequest(
      `query { searchClients(args: { searchTerm: "alice" }) { id username } }`,
      undefined,
      { authorization: `Bearer ${token}` },
    );

    expect(status).toBe(200);
    expect(body.errors).toBeDefined();
    expect(body.errors!.length).toBeGreaterThan(0);
    expect(body.errors![0].message).toContain('Permission denied');
  });

  it('admin-secret user can always access tracked functions (baseline)', async () => {
    // Baseline: verify admin secret grants isAdmin: true and bypasses function perms
    const { status, body } = await graphqlRequest(
      `query { searchClients(args: { searchTerm: "alice" }) { id username } }`,
      undefined,
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );

    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const data = (body.data as { searchClients: unknown[] }).searchClients;
    expect(data.length).toBeGreaterThan(0);
  });

  it('role override via x-hasura-role to admin does not grant isAdmin for tracked functions when config is off', async () => {
    // Even if a user overrides their role to admin via x-hasura-role header,
    // isAdmin remains false when admin_role_is_admin is off.
    const token = await createJWT({
      role: 'backoffice',
      allowedRoles: ['admin', 'backoffice'],
    });

    const { status, body } = await graphqlRequest(
      `query { searchClients(args: { searchTerm: "alice" }) { id username } }`,
      undefined,
      {
        authorization: `Bearer ${token}`,
        'x-hasura-role': 'admin',
      },
    );

    // With config off, overriding to admin role should not bypass function perms
    expect(status).toBe(200);
    expect(body.errors).toBeDefined();
    expect(body.errors!.length).toBeGreaterThan(0);
    expect(body.errors![0].message).toContain('Permission denied');
  });

  it('non-admin JWT roles with function permissions work normally', async () => {
    // A "backoffice" user has explicit permission on searchClients
    const token = await createJWT({
      role: 'backoffice',
      allowedRoles: ['backoffice', 'client'],
    });

    const { status, body } = await graphqlRequest(
      `query { searchClients(args: { searchTerm: "alice" }) { id username } }`,
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
