/**
 * Shared test setup: PostgreSQL pool, JWT helpers, server bootstrap.
 */

import pg from 'pg';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { SignJWT } from 'jose';
import type { FastifyInstance } from 'fastify';
import type { SessionVariables } from '../src/types.js';

const { Pool } = pg;

// ─── Constants ────────────────────────────────────────────────────────────────

export const TEST_DB_URL = 'postgresql://hakkyra:hakkyra_test@localhost:5433/hakkyra_test';
export const JWT_SECRET = 'test-secret-key-minimum-32-chars!!';
export const ADMIN_SECRET = 'test-admin-secret-hakkyra';
export const METADATA_DIR = path.resolve(import.meta.dirname, 'fixtures/metadata');
export const SERVER_CONFIG_PATH = path.resolve(import.meta.dirname, 'fixtures/hakkyra.yaml');

// Well-known test IDs from init.sql
export const ALICE_ID = 'd0000000-0000-0000-0000-000000000001';
export const BOB_ID = 'd0000000-0000-0000-0000-000000000002';
export const CHARLIE_ID = 'd0000000-0000-0000-0000-000000000003';
export const DIANA_ID = 'd0000000-0000-0000-0000-000000000004';

export const BRANCH_TEST_ID = 'a0000000-0000-0000-0000-000000000001';
export const BRANCH_OTHER_ID = 'a0000000-0000-0000-0000-000000000002';

export const ACCOUNT_ALICE_ID = 'e0000000-0000-0000-0000-000000000001';
export const ACCOUNT_BOB_ID = 'e0000000-0000-0000-0000-000000000002';

export const INVOICE_ALICE_ID = 'f0000000-0000-0000-0000-000000000001';

// ─── PostgreSQL Pool ──────────────────────────────────────────────────────────

let _pool: InstanceType<typeof Pool> | undefined;

export function getPool(): InstanceType<typeof Pool> {
  if (!_pool) {
    _pool = new Pool({ connectionString: TEST_DB_URL, max: 5 });
  }
  return _pool;
}

export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = undefined;
  }
}

export async function waitForDb(retries = 20, intervalMs = 500): Promise<void> {
  const pool = getPool();
  for (let i = 0; i < retries; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch {
      if (i === retries - 1) throw new Error('Database not available after retries');
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

// ─── JWT Token Helpers ────────────────────────────────────────────────────────

const secretKey = new TextEncoder().encode(JWT_SECRET);

export async function createJWT(claims: {
  role: string;
  userId?: string;
  allowedRoles?: string[];
  extra?: Record<string, unknown>;
  expiresIn?: string;
}): Promise<string> {
  const hasuraClaims: Record<string, unknown> = {
    'x-hasura-default-role': claims.role,
    'x-hasura-allowed-roles': claims.allowedRoles ?? [claims.role],
  };

  if (claims.userId) {
    hasuraClaims['x-hasura-user-id'] = claims.userId;
  }

  if (claims.extra) {
    for (const [k, v] of Object.entries(claims.extra)) {
      hasuraClaims[k] = v;
    }
  }

  const builder = new SignJWT({
    'https://hasura.io/jwt/claims': hasuraClaims,
    sub: claims.userId ?? 'test-subject',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setAudience('hakkyra-test')
    .setIssuer('hakkyra-test-suite');

  if (claims.expiresIn) {
    builder.setExpirationTime(claims.expiresIn);
  } else {
    builder.setExpirationTime('1h');
  }

  return builder.sign(secretKey);
}

export async function createExpiredJWT(): Promise<string> {
  return new SignJWT({
    'https://hasura.io/jwt/claims': {
      'x-hasura-default-role': 'client',
      'x-hasura-allowed-roles': ['client'],
      'x-hasura-user-id': ALICE_ID,
    },
    sub: ALICE_ID,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
    .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
    .setAudience('hakkyra-test')
    .setIssuer('hakkyra-test-suite')
    .sign(secretKey);
}

export const tokens = {
  async client(userId: string = ALICE_ID): Promise<string> {
    return createJWT({ role: 'client', userId, allowedRoles: ['client'] });
  },
  async backoffice(): Promise<string> {
    return createJWT({ role: 'backoffice', allowedRoles: ['backoffice', 'client'] });
  },
  async administrator(): Promise<string> {
    return createJWT({ role: 'administrator', allowedRoles: ['administrator', 'backoffice', 'client'] });
  },
  async function_(clientId: string = ALICE_ID): Promise<string> {
    return createJWT({
      role: 'function',
      allowedRoles: ['function'],
      extra: { 'x-hasura-client-id': clientId },
    });
  },
  async backofficeAdmin(): Promise<string> {
    return createJWT({ role: 'backoffice_admin', allowedRoles: ['backoffice_admin', 'backoffice', 'administrator'] });
  },
  async support(): Promise<string> {
    return createJWT({ role: 'support', allowedRoles: ['support', 'backoffice'] });
  },
  async auditor(): Promise<string> {
    return createJWT({ role: 'auditor', allowedRoles: ['auditor', 'backoffice', 'function'] });
  },
};

// ─── Clean Metadata Directory ──────────────────────────────────────────────────

const UNSUPPORTED_METADATA_FILES = [
  'remote_schemas.yaml', 'remote_schemas.yml',
  'allowlist.yaml', 'allowlist.yml',
  'api_limits.yaml', 'api_limits.yml',
  'opentelemetry.yaml', 'opentelemetry.yml',
  'network.yaml', 'network.yml',
  'backend_configs.yaml', 'backend_configs.yml',
];

let _cleanMetadataDir: string | undefined;

/**
 * Returns a copy of METADATA_DIR with unsupported Hasura metadata files removed.
 * The original fixture directory is untouched. Cached across calls.
 */
export async function getCleanMetadataDir(): Promise<string> {
  if (_cleanMetadataDir) return _cleanMetadataDir;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hakkyra-test-'));
  await fs.cp(METADATA_DIR, tmpDir, { recursive: true });
  for (const f of UNSUPPORTED_METADATA_FILES) {
    try { await fs.unlink(path.join(tmpDir, f)); } catch {}
  }
  _cleanMetadataDir = tmpDir;
  return tmpDir;
}

// ─── Server Bootstrap ─────────────────────────────────────────────────────────

let _server: FastifyInstance | undefined;
let _serverAddress: string | undefined;

export async function startServer(): Promise<FastifyInstance> {
  if (_server) return _server;

  process.env['DATABASE_URL'] = TEST_DB_URL;
  process.env['HAKKYRA_ADMIN_SECRET'] = ADMIN_SECRET;
  process.env['LOG_LEVEL'] = 'error';
  process.env['NODE_ENV'] = 'test';

  const { loadConfig } = await import('../src/config/loader.js');
  const { createServer } = await import('../src/server.js');

  const cleanDir = await getCleanMetadataDir();
  const config = await loadConfig(cleanDir, SERVER_CONFIG_PATH);
  _server = await createServer(config);
  _serverAddress = await _server.listen({ port: 0, host: '127.0.0.1' });

  return _server;
}

export function getServerAddress(): string {
  if (!_serverAddress) throw new Error('Server not started');
  return _serverAddress;
}

export function getServer(): FastifyInstance {
  if (!_server) throw new Error('Server not started');
  return _server;
}

export async function stopServer(): Promise<void> {
  if (_server) {
    await _server.close();
    _server = undefined;
    _serverAddress = undefined;
  }
}

// ─── HTTP Helpers ─────────────────────────────────────────────────────────────

export interface GraphQLResponse {
  data?: unknown;
  errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
}

export async function graphqlRequest(
  query: string,
  variables?: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<{ status: number; body: GraphQLResponse }> {
  const addr = getServerAddress();
  const res = await fetch(`${addr}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await res.json()) as GraphQLResponse;
  return { status: res.status, body };
}

export async function restRequest(
  method: string,
  urlPath: string,
  options?: {
    headers?: Record<string, string>;
    body?: unknown;
    query?: Record<string, string>;
  },
): Promise<{ status: number; body: unknown }> {
  const addr = getServerAddress();
  let url = `${addr}${urlPath}`;
  if (options?.query) {
    const params = new URLSearchParams(options.query);
    url += `?${params.toString()}`;
  }
  const fetchOpts: RequestInit = {
    method,
    headers: { 'content-type': 'application/json', ...options?.headers },
  };
  if (options?.body !== undefined) {
    fetchOpts.body = JSON.stringify(options.body);
  }
  const res = await fetch(url, fetchOpts);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

// ─── Session Helpers ──────────────────────────────────────────────────────────

export function makeSession(role: string, userId?: string): SessionVariables {
  const claims: Record<string, string | string[]> = {
    'x-hasura-role': role,
    'x-hasura-default-role': role,
    'x-hasura-allowed-roles': [role],
  };
  if (userId) {
    claims['x-hasura-user-id'] = userId;
  }
  return {
    role,
    userId,
    allowedRoles: [role],
    isAdmin: role === 'admin',
    claims,
  };
}
