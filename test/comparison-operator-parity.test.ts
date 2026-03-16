/**
 * Tests for P9.7b — Remaining Comparison Operator Parity.
 *
 * Verifies that BooleanComparisonExp, UuidComparisonExp, and JsonbComparisonExp
 * include _gt, _gte, _lt, _lte operators (matching Hasura), and that
 * FloatComparisonExp is generated when float columns exist.
 *
 * Also runs E2E queries to confirm the operators work end-to-end.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  GraphQLSchema,
  GraphQLInputObjectType,
} from 'graphql';
import { generateSchema } from '../src/schema/generator.js';
import { resetComparisonTypeCache } from '../src/schema/filters.js';
import { introspectDatabase } from '../src/introspection/introspector.js';
import { mergeSchemaModel } from '../src/introspection/merger.js';
import { loadConfig } from '../src/config/loader.js';
import {
  startServer, stopServer, closePool, waitForDb,
  graphqlRequest,
  tokens,
  ADMIN_SECRET,
  METADATA_DIR, SERVER_CONFIG_PATH, TEST_DB_URL,
  getPool,
} from './setup.js';

type AnyRow = Record<string, unknown>;

// ── Ensure float column exists ────────────────────────────────────────────────

async function ensureFloatColumn(): Promise<void> {
  const pool = getPool();
  await pool.query(`ALTER TABLE product ADD COLUMN IF NOT EXISTS weight real DEFAULT 0`);
  await pool.query(`UPDATE product SET weight = 15.5 WHERE code = 'premium-casket' AND weight = 0`);
  await pool.query(`UPDATE product SET weight = 2.3 WHERE code = 'memorial-wreath' AND weight = 0`);
}

// ── Schema-Level Tests ────────────────────────────────────────────────────────

describe('Comparison Operator Parity (P9.7b) — Schema', () => {
  let schema: GraphQLSchema;

  beforeAll(async () => {
    process.env['DATABASE_URL'] = TEST_DB_URL;
    resetComparisonTypeCache();

    await waitForDb();
    await ensureFloatColumn();
    const pool = getPool();
    const introspection = await introspectDatabase(pool);
    const config = await loadConfig(METADATA_DIR, SERVER_CONFIG_PATH);
    const result = mergeSchemaModel(introspection, config);
    schema = generateSchema(result.model);
  });

  afterAll(async () => {
    await closePool();
  });

  describe('BooleanComparisonExp', () => {
    it('should exist in schema', () => {
      const typeMap = schema.getTypeMap();
      expect(typeMap['BooleanComparisonExp']).toBeDefined();
    });

    it('should include base comparison fields', () => {
      const typeMap = schema.getTypeMap();
      const compType = typeMap['BooleanComparisonExp'] as GraphQLInputObjectType;
      const fields = Object.keys(compType.getFields());
      expect(fields).toContain('_eq');
      expect(fields).toContain('_neq');
      expect(fields).toContain('_in');
      expect(fields).toContain('_nin');
      expect(fields).toContain('_isNull');
    });

    it('should include ordering operators _gt, _gte, _lt, _lte', () => {
      const typeMap = schema.getTypeMap();
      const compType = typeMap['BooleanComparisonExp'] as GraphQLInputObjectType;
      const fields = Object.keys(compType.getFields());
      expect(fields).toContain('_gt');
      expect(fields).toContain('_gte');
      expect(fields).toContain('_lt');
      expect(fields).toContain('_lte');
    });
  });

  describe('UuidComparisonExp', () => {
    it('should exist in schema', () => {
      const typeMap = schema.getTypeMap();
      expect(typeMap['UuidComparisonExp']).toBeDefined();
    });

    it('should include base comparison fields', () => {
      const typeMap = schema.getTypeMap();
      const compType = typeMap['UuidComparisonExp'] as GraphQLInputObjectType;
      const fields = Object.keys(compType.getFields());
      expect(fields).toContain('_eq');
      expect(fields).toContain('_neq');
      expect(fields).toContain('_in');
      expect(fields).toContain('_nin');
      expect(fields).toContain('_isNull');
    });

    it('should include ordering operators _gt, _gte, _lt, _lte', () => {
      const typeMap = schema.getTypeMap();
      const compType = typeMap['UuidComparisonExp'] as GraphQLInputObjectType;
      const fields = Object.keys(compType.getFields());
      expect(fields).toContain('_gt');
      expect(fields).toContain('_gte');
      expect(fields).toContain('_lt');
      expect(fields).toContain('_lte');
    });
  });

  describe('JsonbComparisonExp', () => {
    it('should exist in schema', () => {
      const typeMap = schema.getTypeMap();
      expect(typeMap['JsonbComparisonExp']).toBeDefined();
    });

    it('should include base comparison fields', () => {
      const typeMap = schema.getTypeMap();
      const compType = typeMap['JsonbComparisonExp'] as GraphQLInputObjectType;
      const fields = Object.keys(compType.getFields());
      expect(fields).toContain('_eq');
      expect(fields).toContain('_neq');
      expect(fields).toContain('_in');
      expect(fields).toContain('_nin');
      expect(fields).toContain('_isNull');
    });

    it('should include ordering operators _gt, _gte, _lt, _lte', () => {
      const typeMap = schema.getTypeMap();
      const compType = typeMap['JsonbComparisonExp'] as GraphQLInputObjectType;
      const fields = Object.keys(compType.getFields());
      expect(fields).toContain('_gt');
      expect(fields).toContain('_gte');
      expect(fields).toContain('_lt');
      expect(fields).toContain('_lte');
    });

    it('should still include JSONB-specific operators', () => {
      const typeMap = schema.getTypeMap();
      const compType = typeMap['JsonbComparisonExp'] as GraphQLInputObjectType;
      const fields = Object.keys(compType.getFields());
      expect(fields).toContain('_cast');
      expect(fields).toContain('_contains');
      expect(fields).toContain('_containedIn');
      expect(fields).toContain('_hasKey');
      expect(fields).toContain('_hasKeysAny');
      expect(fields).toContain('_hasKeysAll');
    });
  });

  describe('FloatComparisonExp', () => {
    it('should be generated when float columns exist', () => {
      const typeMap = schema.getTypeMap();
      expect(typeMap['FloatComparisonExp']).toBeDefined();
    });

    it('should include ordering operators', () => {
      const typeMap = schema.getTypeMap();
      const compType = typeMap['FloatComparisonExp'] as GraphQLInputObjectType;
      const fields = Object.keys(compType.getFields());
      expect(fields).toContain('_eq');
      expect(fields).toContain('_neq');
      expect(fields).toContain('_gt');
      expect(fields).toContain('_gte');
      expect(fields).toContain('_lt');
      expect(fields).toContain('_lte');
      expect(fields).toContain('_in');
      expect(fields).toContain('_nin');
      expect(fields).toContain('_isNull');
    });
  });
});

// ── E2E Tests ────────────────────────────────────────────────────────────────

describe('Comparison Operator Parity (P9.7b) — E2E', () => {
  beforeAll(async () => {
    process.env['DATABASE_URL'] = TEST_DB_URL;
    process.env['HAKKYRA_ADMIN_SECRET'] = ADMIN_SECRET;
    resetComparisonTypeCache();

    await waitForDb();
    await ensureFloatColumn();
    await startServer();
  }, 30_000);

  afterAll(async () => {
    await stopServer();
    await closePool();
  });

  describe('Boolean _gt/_gte/_lt/_lte', () => {
    it('should filter with _gt on boolean column', async () => {
      const token = await tokens.backoffice();
      // In PostgreSQL: false < true, so _gt: false should return rows where active = true
      const { status, body } = await graphqlRequest(
        `query { branch(where: { active: { _gt: false } }) { id name active } }`,
        undefined,
        { authorization: `Bearer ${token}` },
      );
      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();
      const branches = (body.data as { branch: AnyRow[] }).branch;
      // All test branches have active=true
      expect(branches.length).toBeGreaterThan(0);
      for (const branch of branches) {
        expect(branch['active']).toBe(true);
      }
    });

    it('should filter with _lte on boolean column', async () => {
      const token = await tokens.backoffice();
      // _lte: false should return only rows where active = false
      const { status, body } = await graphqlRequest(
        `query { branch(where: { active: { _lte: false } }) { id name active } }`,
        undefined,
        { authorization: `Bearer ${token}` },
      );
      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();
      const branches = (body.data as { branch: AnyRow[] }).branch;
      for (const branch of branches) {
        expect(branch['active']).toBe(false);
      }
    });

    it('should filter with _gte on boolean column', async () => {
      const token = await tokens.backoffice();
      // _gte: true should return only active branches
      const { status, body } = await graphqlRequest(
        `query { branch(where: { active: { _gte: true } }) { id name active } }`,
        undefined,
        { authorization: `Bearer ${token}` },
      );
      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();
      const branches = (body.data as { branch: AnyRow[] }).branch;
      for (const branch of branches) {
        expect(branch['active']).toBe(true);
      }
    });
  });

  describe('UUID _gt/_gte/_lt/_lte', () => {
    it('should filter with _gt on UUID column', async () => {
      // UUIDs are comparable in PG by lexicographic order
      // Use a low UUID so _gt returns results
      const { status, body } = await graphqlRequest(
        `query {
          clients(where: { id: { _gt: "00000000-0000-0000-0000-000000000000" } }) {
            id username
          }
        }`,
        undefined,
        { 'x-hasura-admin-secret': ADMIN_SECRET },
      );
      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();
      const clients = (body.data as { clients: AnyRow[] }).clients;
      expect(clients.length).toBeGreaterThan(0);
    });

    it('should filter with _lt on UUID column', async () => {
      // Use a high UUID so _lt returns results
      const { status, body } = await graphqlRequest(
        `query {
          clients(where: { id: { _lt: "ffffffff-ffff-ffff-ffff-ffffffffffff" } }) {
            id username
          }
        }`,
        undefined,
        { 'x-hasura-admin-secret': ADMIN_SECRET },
      );
      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();
      const clients = (body.data as { clients: AnyRow[] }).clients;
      expect(clients.length).toBeGreaterThan(0);
    });

    it('should filter with _gte on UUID column returning exact match', async () => {
      const { status, body } = await graphqlRequest(
        `query {
          clients(where: { id: { _gte: "d0000000-0000-0000-0000-000000000004" } }) {
            id username
          }
        }`,
        undefined,
        { 'x-hasura-admin-secret': ADMIN_SECRET },
      );
      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();
      const clients = (body.data as { clients: AnyRow[] }).clients;
      // Should include diana (exact match) and any with higher UUIDs
      expect(clients.length).toBeGreaterThanOrEqual(1);
      const ids = clients.map((c) => c['id']);
      expect(ids).toContain('d0000000-0000-0000-0000-000000000004');
    });

    it('should filter with _lte on UUID column excluding higher values', async () => {
      const { status, body } = await graphqlRequest(
        `query {
          clients(where: { id: { _lte: "d0000000-0000-0000-0000-000000000002" } }) {
            id username
          }
        }`,
        undefined,
        { 'x-hasura-admin-secret': ADMIN_SECRET },
      );
      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();
      const clients = (body.data as { clients: AnyRow[] }).clients;
      // Should include alice and bob (exact match), not charlie or diana
      expect(clients.length).toBe(2);
      const usernames = clients.map((c) => c['username']);
      expect(usernames).toContain('alice');
      expect(usernames).toContain('bob');
    });
  });

  describe('JSONB _gt/_gte/_lt/_lte', () => {
    it('should accept _gt operator on JSONB column without error', async () => {
      // JSONB comparison in PG: jsonb comparisons follow GIN ordering rules.
      // The query should be accepted and not produce a GraphQL validation error.
      const { status, body } = await graphqlRequest(
        `query {
          clients(where: { tags: { _gt: "[]" } }) {
            id username tags
          }
        }`,
        undefined,
        { 'x-hasura-admin-secret': ADMIN_SECRET },
      );
      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();
    });

    it('should accept _lte operator on JSONB column without error', async () => {
      const { status, body } = await graphqlRequest(
        `query {
          clientData(where: { value: { _lte: "{}" } }) {
            id key
          }
        }`,
        undefined,
        { 'x-hasura-admin-secret': ADMIN_SECRET },
      );
      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();
    });
  });

  describe('Float comparison (verification)', () => {
    it('should filter with _gt on float column', async () => {
      const token = await tokens.backoffice();
      const { status, body } = await graphqlRequest(
        `query { product(where: { weight: { _gt: 10.0 } }) { id name weight } }`,
        undefined,
        { authorization: `Bearer ${token}` },
      );
      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();
      const products = (body.data as { product: AnyRow[] }).product;
      expect(products.length).toBeGreaterThanOrEqual(1);
      for (const p of products) {
        expect((p['weight'] as number)).toBeGreaterThan(10.0);
      }
    });

    it('should filter with _lte on float column', async () => {
      const token = await tokens.backoffice();
      const { status, body } = await graphqlRequest(
        `query { product(where: { weight: { _lte: 5.0 } }) { id name weight } }`,
        undefined,
        { authorization: `Bearer ${token}` },
      );
      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();
      const products = (body.data as { product: AnyRow[] }).product;
      for (const p of products) {
        expect((p['weight'] as number)).toBeLessThanOrEqual(5.0);
      }
    });
  });
});
