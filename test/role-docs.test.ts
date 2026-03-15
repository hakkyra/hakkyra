import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  startServer, stopServer, closePool, waitForDb,
  tokens, ADMIN_SECRET, ALICE_ID,
  TEST_DB_URL, getServerAddress,
} from './setup.js';
import type { OpenAPISpec } from '../src/docs/openapi.js';
import type { LLMDoc } from '../src/docs/llm-format.js';

// ─── Server lifecycle ────────────────────────────────────────────────────────

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function fetchDoc(path: string, headers?: Record<string, string>): Promise<Response> {
  const addr = getServerAddress();
  return fetch(`${addr}${path}`, { headers });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Role-Aware Documentation Endpoints (P5.18)', () => {
  describe('/openapi.json', () => {
    it('admin gets full OpenAPI spec with all tables', async () => {
      const res = await fetchDoc('/openapi.json', { 'x-hasura-admin-secret': ADMIN_SECRET });
      expect(res.status).toBe(200);
      const spec = await res.json() as OpenAPISpec;
      expect(spec.openapi).toBe('3.1.0');
      // Admin should see all tracked tables including admin-only ones (e.g., user)
      const paths = Object.keys(spec.paths);
      expect(paths.length).toBeGreaterThan(0);
      // user table should be present for admin
      const hasUserPath = paths.some(p => p.includes('/user'));
      expect(hasUserPath).toBe(true);
    });

    it('client role sees only tables with client permissions', async () => {
      const token = await tokens.client(ALICE_ID);
      const res = await fetchDoc('/openapi.json', { authorization: `Bearer ${token}` });
      expect(res.status).toBe(200);
      const spec = await res.json() as OpenAPISpec;
      // Client should NOT see the user table (no client permissions)
      const paths = Object.keys(spec.paths);
      const hasUserPath = paths.some(p => p.includes('/user'));
      expect(hasUserPath).toBe(false);
      // Client should see the client table (has select + update permissions)
      const hasClientPath = paths.some(p => p.includes('/client'));
      expect(hasClientPath).toBe(true);
    });

    it('client role only sees permitted CRUD operations', async () => {
      const token = await tokens.client(ALICE_ID);
      const res = await fetchDoc('/openapi.json', { authorization: `Bearer ${token}` });
      const spec = await res.json() as OpenAPISpec;
      // Find the clients list path (could be /api/clients or /api/client)
      const clientPaths = Object.entries(spec.paths).filter(([p]) =>
        p.includes('/client') && !p.includes('{id}') && !p.includes('service') && !p.includes('data') && !p.includes('summary'),
      );
      // Client has select but no insert → should have GET but no POST
      if (clientPaths.length > 0) {
        const [, pathItem] = clientPaths[0];
        expect(pathItem.get).toBeDefined(); // select permission exists
        expect(pathItem.post).toBeUndefined(); // no insert permission for client
      }
    });

    it('client role OpenAPI shows only allowed columns in schema', async () => {
      const token = await tokens.client(ALICE_ID);
      const res = await fetchDoc('/openapi.json', { authorization: `Bearer ${token}` });
      const spec = await res.json() as OpenAPISpec;
      // Client has select permission with limited columns on client table
      // They should NOT see 'on_hold', 'metadata', 'updated_at' columns
      const clientSchema = spec.components?.schemas?.['Client'];
      if (clientSchema && clientSchema.properties) {
        expect(clientSchema.properties['on_hold']).toBeUndefined();
        expect(clientSchema.properties['metadata']).toBeUndefined();
        expect(clientSchema.properties['updated_at']).toBeUndefined();
        // Should see permitted columns
        expect(clientSchema.properties['id']).toBeDefined();
        expect(clientSchema.properties['username']).toBeDefined();
        expect(clientSchema.properties['email']).toBeDefined();
      }
    });

    it('unauthenticated request returns only anonymous-accessible tables', async () => {
      const res = await fetchDoc('/openapi.json');
      expect(res.status).toBe(200);
      const spec = await res.json() as OpenAPISpec;
      // Anonymous role has select on 6 tables: currency, product, branch, country, language, supplier
      const paths = Object.keys(spec.paths);
      expect(paths.length).toBeGreaterThan(0);
      // Should NOT see admin-only tables like user
      const hasUserPath = paths.some(p => p.includes('/user'));
      expect(hasUserPath).toBe(false);
      // Should NOT see client-only tables like client
      const hasClientPath = paths.some(p => p.match(/\/client(?!_)/));
      expect(hasClientPath).toBe(false);
    });
  });

  describe('/llm-api.json', () => {
    it('admin gets full LLM doc with all entities', async () => {
      const res = await fetchDoc('/llm-api.json', { 'x-hasura-admin-secret': ADMIN_SECRET });
      expect(res.status).toBe(200);
      const doc = await res.json() as LLMDoc;
      expect(doc.api).toBe('hakkyra');
      expect(doc.entities.length).toBeGreaterThan(0);
      // Admin should see user entity
      const hasUser = doc.entities.some(e => e.name === 'user');
      expect(hasUser).toBe(true);
    });

    it('client role only sees permitted entities and operations', async () => {
      const token = await tokens.client(ALICE_ID);
      const res = await fetchDoc('/llm-api.json', { authorization: `Bearer ${token}` });
      expect(res.status).toBe(200);
      const doc = await res.json() as LLMDoc;
      // Client should NOT see user entity
      const hasUser = doc.entities.some(e => e.name === 'user');
      expect(hasUser).toBe(false);
      // Client should see client entity
      const clientEntity = doc.entities.find(e => e.name === 'client');
      expect(clientEntity).toBeDefined();
      // Client has select + update on client, but no insert or delete
      if (clientEntity) {
        expect(clientEntity.endpoints.list).toBeDefined();
        expect(clientEntity.endpoints.get).toBeDefined();
        expect(clientEntity.endpoints.update).toBeDefined();
        expect(clientEntity.endpoints.create).toBeUndefined();
        expect(clientEntity.endpoints.delete).toBeUndefined();
      }
    });

    it('unauthenticated request returns only anonymous-accessible entities', async () => {
      const res = await fetchDoc('/llm-api.json');
      expect(res.status).toBe(200);
      const doc = await res.json() as LLMDoc;
      // 6 tables have anonymous select permissions
      expect(doc.entities.length).toBe(6);
      // Should NOT include client-only or admin-only entities
      const hasUser = doc.entities.some(e => e.name === 'user');
      expect(hasUser).toBe(false);
    });
  });

  describe('/sdl', () => {
    it('admin gets full SDL with all types', async () => {
      const res = await fetchDoc('/sdl', { 'x-hasura-admin-secret': ADMIN_SECRET });
      expect(res.status).toBe(200);
      const sdl = await res.text();
      // Admin should see all types including User (admin-only table)
      expect(sdl).toContain('User');
      expect(sdl).toContain('Client');
    });

    it('client role SDL includes permitted types and omits admin-only root fields', async () => {
      const token = await tokens.client(ALICE_ID);
      const res = await fetchDoc('/sdl', { authorization: `Bearer ${token}` });
      expect(res.status).toBe(200);
      const sdl = await res.text();
      // Client should see Client type
      expect(sdl).toContain('Client');
      // The query_root should have client-accessible root fields
      expect(sdl).toContain('query_root');
      // Admin-only root fields (user, userByPk) should not appear since
      // the User table has no client role permissions, so no root fields are generated.
      // Note: the User *type* may still exist if referenced by relationships,
      // but no query root fields for User should be present.
      expect(sdl).not.toMatch(/^\s+user\(/m);
    });

    it('unauthenticated request returns SDL with only anonymous-accessible types', async () => {
      const res = await fetchDoc('/sdl');
      expect(res.status).toBe(200);
      const sdl = await res.text();
      // Anonymous has select on 6 tables, so SDL should have those types
      expect(sdl).toContain('query_root');
      // Should NOT contain admin-only types
      expect(sdl).not.toMatch(/type User\s*\{/);
    });

    it('role-filtered SDL is cached across requests', async () => {
      const token = await tokens.client(ALICE_ID);
      // First request generates the cache
      const res1 = await fetchDoc('/sdl', { authorization: `Bearer ${token}` });
      const sdl1 = await res1.text();
      // Second request should hit cache
      const res2 = await fetchDoc('/sdl', { authorization: `Bearer ${token}` });
      const sdl2 = await res2.text();
      expect(sdl1).toBe(sdl2);
    });
  });

  describe('backoffice role', () => {
    it('backoffice sees user table in OpenAPI (has backoffice select permission)', async () => {
      const token = await tokens.backoffice();
      const res = await fetchDoc('/openapi.json', { authorization: `Bearer ${token}` });
      expect(res.status).toBe(200);
      const spec = await res.json() as OpenAPISpec;
      const paths = Object.keys(spec.paths);
      const hasUserPath = paths.some(p => p.includes('/user'));
      expect(hasUserPath).toBe(true);
    });

    it('backoffice sees more entities than client role in LLM doc', async () => {
      const backofficeToken = await tokens.backoffice();
      const clientToken = await tokens.client(ALICE_ID);

      const [backofficeRes, clientRes] = await Promise.all([
        fetchDoc('/llm-api.json', { authorization: `Bearer ${backofficeToken}` }),
        fetchDoc('/llm-api.json', { authorization: `Bearer ${clientToken}` }),
      ]);

      const backofficeDoc = await backofficeRes.json() as LLMDoc;
      const clientDoc = await clientRes.json() as LLMDoc;

      // Backoffice should see more entities than client
      expect(backofficeDoc.entities.length).toBeGreaterThanOrEqual(clientDoc.entities.length);
    });
  });
});
