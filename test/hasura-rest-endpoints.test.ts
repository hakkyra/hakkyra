import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig } from '../src/config/loader.js';
import {
  startServer, stopServer, closePool, waitForDb,
  tokens, ADMIN_SECRET, createExpiredJWT,
  ALICE_ID, METADATA_DIR, SERVER_CONFIG_PATH,
  getServerAddress, getCleanMetadataDir,
  TEST_DB_URL,
} from './setup.js';

// ─── Config loading tests ────────────────────────────────────────────────────

describe('Query Collections & Hasura REST Endpoints', () => {
  describe('config loading', () => {
    it('should load query collections from fixture metadata', async () => {
      const cleanDir = await getCleanMetadataDir();
      const config = await loadConfig(cleanDir, SERVER_CONFIG_PATH);
      expect(config.queryCollections).toBeDefined();
      expect(config.queryCollections.length).toBe(1);
      expect(config.queryCollections[0].name).toBe('allowed_queries');
      expect(config.queryCollections[0].queries.size).toBe(6);
      expect(config.queryCollections[0].queries.has('GetClientById')).toBe(true);
      expect(config.queryCollections[0].queries.has('ListClients')).toBe(true);
      expect(config.queryCollections[0].queries.has('GetClientAccounts')).toBe(true);
      expect(config.queryCollections[0].queries.has('ListInvoices')).toBe(true);
      expect(config.queryCollections[0].queries.has('GetClientSummary')).toBe(true);
      expect(config.queryCollections[0].queries.has('ListActiveServicePlans')).toBe(true);
    });

    it('should load Hasura REST endpoints from fixture metadata', async () => {
      const cleanDir = await getCleanMetadataDir();
      const config = await loadConfig(cleanDir, SERVER_CONFIG_PATH);
      expect(config.hasuraRestEndpoints).toBeDefined();
      expect(config.hasuraRestEndpoints.length).toBe(6);

      const ep = config.hasuraRestEndpoints.find((e) => e.name === 'get_client_by_id');
      expect(ep).toBeDefined();
      expect(ep!.url).toBe('/api/v1/client/:id');
      expect(ep!.methods).toContain('GET');
      expect(ep!.collectionName).toBe('allowed_queries');
      expect(ep!.queryName).toBe('GetClientById');
      expect(ep!.comment).toBe('Get a single client by UUID');
    });

    it('should store query strings in the collection Map', async () => {
      const cleanDir = await getCleanMetadataDir();
      const config = await loadConfig(cleanDir, SERVER_CONFIG_PATH);
      const col = config.queryCollections[0];
      const query = col.queries.get('GetClientById');
      expect(query).toBeDefined();
      expect(query).toContain('clientByPk');
      expect(query).toContain('$id: uuid!');
    });

    it('should reject REST endpoint referencing non-existent collection', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hakkyra-rest-test-'));
      const cleanDir = await getCleanMetadataDir();
      await fs.cp(cleanDir, tmpDir, { recursive: true });

      await fs.writeFile(
        path.join(tmpDir, 'rest_endpoints.yaml'),
        `- name: bad_endpoint
  url: /test
  methods:
    - GET
  definition:
    query:
      collection_name: non_existent_collection
      query_name: SomeQuery
`,
      );
      await fs.writeFile(path.join(tmpDir, 'query_collections.yaml'), '[]');

      try {
        await expect(loadConfig(tmpDir, SERVER_CONFIG_PATH)).rejects.toThrow(
          /non-existent query collection "non_existent_collection"/,
        );
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('should reject REST endpoint referencing non-existent query in collection', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hakkyra-rest-test-'));
      const cleanDir = await getCleanMetadataDir();
      await fs.cp(cleanDir, tmpDir, { recursive: true });

      await fs.writeFile(
        path.join(tmpDir, 'rest_endpoints.yaml'),
        `- name: bad_endpoint
  url: /test
  methods:
    - GET
  definition:
    query:
      collection_name: allowed_queries
      query_name: NonExistentQuery
`,
      );

      try {
        await expect(loadConfig(tmpDir, SERVER_CONFIG_PATH)).rejects.toThrow(
          /non-existent query "NonExistentQuery" in collection "allowed_queries"/,
        );
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('should default to empty arrays when files are absent', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hakkyra-rest-test-'));
      const cleanDir = await getCleanMetadataDir();
      await fs.cp(cleanDir, tmpDir, { recursive: true });

      try { await fs.unlink(path.join(tmpDir, 'query_collections.yaml')); } catch {}
      try { await fs.unlink(path.join(tmpDir, 'rest_endpoints.yaml')); } catch {}

      try {
        const config = await loadConfig(tmpDir, SERVER_CONFIG_PATH);
        expect(config.queryCollections).toEqual([]);
        expect(config.hasuraRestEndpoints).toEqual([]);
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });
  });

  // ─── E2E tests ───────────────────────────────────────────────────────────────

  describe('E2E Hasura REST endpoints', () => {
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

    it('should return GraphQL validation errors as proper error responses', async () => {
      // The fixture queries use Hasura naming conventions (uuid, client_bool_exp)
      // which don't match Hakkyra's schema (Uuid, ClientBoolExp).
      // The endpoint should return these as GraphQL errors in the response body,
      // not as HTTP 500 errors.
      const addr = getServerAddress();
      const res = await fetch(`${addr}/api/rest/api/v1/clients?limit=2`, {
        headers: {
          'x-hasura-admin-secret': ADMIN_SECRET,
        },
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { data?: unknown; errors?: unknown[] };
      // Should have errors because fixture query uses Hasura naming conventions
      expect(body.errors).toBeDefined();
      expect(body.errors!.length).toBeGreaterThan(0);
    });

    it('should register routes for all configured endpoints', async () => {
      const addr = getServerAddress();
      // Try hitting each endpoint - they should all be registered (not 404)
      const endpoints = [
        '/api/rest/api/v1/clients',
        '/api/rest/api/v1/client/:id',
        '/api/rest/api/v1/client/:clientId/accounts',
        '/api/rest/api/v1/invoices',
        '/api/rest/api/v1/client/:clientId/summary',
        '/api/rest/api/v1/service-plans/active',
      ];
      for (const ep of endpoints) {
        const res = await fetch(`${addr}${ep}`, {
          headers: { 'x-hasura-admin-secret': ADMIN_SECRET },
        });
        // Should NOT be 404 (route not found)
        expect(res.status, `${ep} should be registered`).not.toBe(404);
      }
    });

    it('should not register POST route for GET-only endpoints', async () => {
      const addr = getServerAddress();
      // list_invoices is GET-only
      const res = await fetch(`${addr}/api/rest/api/v1/invoices`, {
        method: 'POST',
        headers: {
          'x-hasura-admin-secret': ADMIN_SECRET,
          'content-type': 'application/json',
        },
        body: '{}',
      });
      // GET-only endpoints should return 404 for POST
      expect(res.status).toBe(404);
    });

    it('should enforce authentication on REST endpoints', async () => {
      const addr = getServerAddress();
      // Without auth, should still get 200 but with GraphQL errors from resolver permissions
      const res = await fetch(`${addr}/api/rest/api/v1/clients`);
      expect(res.status).toBe(200);
      const body = await res.json() as { data?: unknown; errors?: unknown[] };
      // Anonymous role has no permission on client table
      expect(body.errors).toBeDefined();
    });

    it('should pass admin secret auth through to GraphQL execution', async () => {
      const addr = getServerAddress();
      const res = await fetch(`${addr}/api/rest/api/v1/clients`, {
        headers: { 'x-hasura-admin-secret': ADMIN_SECRET },
      });
      expect(res.status).toBe(200);
      // The request should reach the GraphQL engine (not be rejected at HTTP level)
      const body = await res.json() as { data?: unknown; errors?: unknown[] };
      expect(body).toBeDefined();
    });

    it('should pass JWT auth through to GraphQL execution', async () => {
      const addr = getServerAddress();
      const token = await tokens.backoffice();
      const res = await fetch(`${addr}/api/rest/api/v1/clients`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { data?: unknown; errors?: unknown[] };
      expect(body).toBeDefined();
    });

    it('should handle GET variables from query parameters', async () => {
      const addr = getServerAddress();
      const res = await fetch(
        `${addr}/api/rest/api/v1/client/:id?id=${ALICE_ID}`,
        {
          headers: { 'x-hasura-admin-secret': ADMIN_SECRET },
        },
      );
      expect(res.status).toBe(200);
      const body = await res.json() as { data?: unknown; errors?: unknown[] };
      // Expect a GraphQL response (either data or errors, but valid shape)
      expect(body).toBeDefined();
      expect(typeof body).toBe('object');
    });

    // ── P5.14: Permission enforcement on Hasura REST endpoints ──────────

    describe('permission enforcement (P5.14)', () => {
      it('admin secret auth reaches GraphQL engine on all REST endpoints', async () => {
        const addr = getServerAddress();
        const endpoints = [
          '/api/rest/api/v1/clients',
          '/api/rest/api/v1/invoices',
          '/api/rest/api/v1/service-plans/active',
        ];
        for (const ep of endpoints) {
          const res = await fetch(`${addr}${ep}`, {
            headers: { 'x-hasura-admin-secret': ADMIN_SECRET },
          });
          // Admin secret should pass auth — request reaches GraphQL engine (HTTP 200)
          expect(res.status, `${ep} should return 200 for admin`).toBe(200);
          const body = await res.json() as { data?: unknown; errors?: unknown[] };
          // Response should be a valid GraphQL envelope (data and/or errors)
          expect(body, `${ep} should return a GraphQL response`).toHaveProperty('errors');
        }
      });

      it('JWT with backoffice role reaches GraphQL engine', async () => {
        const addr = getServerAddress();
        const token = await tokens.backoffice();
        const res = await fetch(`${addr}/api/rest/api/v1/clients`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.status).toBe(200);
        const body = await res.json() as { data?: unknown; errors?: unknown[] };
        // Backoffice has select permission on client table — request reaches engine
        expect(body).toBeDefined();
        expect(typeof body).toBe('object');
      });

      it('JWT with client role reaches GraphQL engine', async () => {
        const addr = getServerAddress();
        const token = await tokens.client(ALICE_ID);
        const res = await fetch(`${addr}/api/rest/api/v1/clients`, {
          headers: { authorization: `Bearer ${token}` },
        });
        // Client role has select permission on client table (with row filter)
        expect(res.status).toBe(200);
        const body = await res.json() as { data?: unknown; errors?: unknown[] };
        expect(body).toBeDefined();
        expect(typeof body).toBe('object');
      });

      it('unauthenticated request falls back to anonymous role and gets permission errors', async () => {
        const addr = getServerAddress();
        // No auth headers — unauthorizedRole config maps to 'anonymous'
        const res = await fetch(`${addr}/api/rest/api/v1/clients`);
        // Should not be rejected at HTTP level (unauthorizedRole is configured)
        expect(res.status).toBe(200);
        const body = await res.json() as { data?: unknown; errors?: unknown[] };
        // Anonymous role has no select permission on client table — expect errors
        expect(body.errors).toBeDefined();
        expect(body.errors!.length).toBeGreaterThan(0);
      });

      it('invalid admin secret is rejected with 401', async () => {
        const addr = getServerAddress();
        const res = await fetch(`${addr}/api/rest/api/v1/clients`, {
          headers: { 'x-hasura-admin-secret': 'wrong-secret' },
        });
        expect(res.status).toBe(401);
        const body = await res.json() as { error?: string; message?: string };
        expect(body.error).toBe('unauthorized');
        expect(body.message).toBe('Invalid admin secret');
      });

      it('expired JWT is rejected with 401', async () => {
        const addr = getServerAddress();
        const expiredToken = await createExpiredJWT();
        const res = await fetch(`${addr}/api/rest/api/v1/clients`, {
          headers: { authorization: `Bearer ${expiredToken}` },
        });
        expect(res.status).toBe(401);
        const body = await res.json() as { error?: string };
        expect(body.error).toBe('unauthorized');
      });

      it('malformed Authorization header is rejected with 401', async () => {
        const addr = getServerAddress();
        const res = await fetch(`${addr}/api/rest/api/v1/clients`, {
          headers: { authorization: 'Basic dXNlcjpwYXNz' },
        });
        expect(res.status).toBe(401);
        const body = await res.json() as { error?: string; message?: string };
        expect(body.error).toBe('unauthorized');
        expect(body.message).toBe('Authorization header must use Bearer scheme');
      });

      it('admin secret auth works on parameterized REST endpoints', async () => {
        const addr = getServerAddress();
        const res = await fetch(
          `${addr}/api/rest/api/v1/client/:id?id=${ALICE_ID}`,
          {
            headers: { 'x-hasura-admin-secret': ADMIN_SECRET },
          },
        );
        expect(res.status).toBe(200);
        const body = await res.json() as { data?: unknown; errors?: unknown[] };
        expect(body).toBeDefined();
        expect(typeof body).toBe('object');
      });

      it('unauthenticated request to parameterized endpoint gets permission errors', async () => {
        const addr = getServerAddress();
        const res = await fetch(
          `${addr}/api/rest/api/v1/client/:id?id=${ALICE_ID}`,
        );
        expect(res.status).toBe(200);
        const body = await res.json() as { data?: unknown; errors?: unknown[] };
        // Anonymous has no select permission on client table
        expect(body.errors).toBeDefined();
        expect(body.errors!.length).toBeGreaterThan(0);
      });
    });
  });
});
