/**
 * Tests for P10.9 — Enum comparison types should include _gt/_gte/_lt/_lte operators.
 *
 * PostgreSQL enums have a natural ordering based on their declaration order,
 * so ordering operators are valid. Hasura provides these operators on enum
 * comparison types, and we should too.
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
} from './setup.js';

type AnyRow = Record<string, unknown>;

// ── Schema-Level Tests ────────────────────────────────────────────────────────

describe('Enum Comparison Ordering Operators (P10.9) — Schema', () => {
  let schema: GraphQLSchema;

  beforeAll(async () => {
    process.env['DATABASE_URL'] = TEST_DB_URL;
    resetComparisonTypeCache();

    await waitForDb();
    const pool = (await import('./setup.js')).getPool();
    const introspection = await introspectDatabase(pool);
    const config = await loadConfig(METADATA_DIR, SERVER_CONFIG_PATH);
    const result = mergeSchemaModel(introspection, config);
    schema = generateSchema(result.model);
  });

  afterAll(async () => {
    await closePool();
  });

  const enumComparisonTypes = [
    'ClientStatusComparisonExp',
    'InvoiceStateComparisonExp',
    'LedgerTypeComparisonExp',
    'PlanStateComparisonExp',
    'ServiceStatusComparisonExp',
  ];

  for (const typeName of enumComparisonTypes) {
    describe(typeName, () => {
      it('should exist in schema', () => {
        const typeMap = schema.getTypeMap();
        expect(typeMap[typeName]).toBeDefined();
      });

      it('should include base comparison fields (_eq, _neq, _in, _nin, _isNull)', () => {
        const typeMap = schema.getTypeMap();
        const compType = typeMap[typeName] as GraphQLInputObjectType;
        const fields = Object.keys(compType.getFields());
        expect(fields).toContain('_eq');
        expect(fields).toContain('_neq');
        expect(fields).toContain('_in');
        expect(fields).toContain('_nin');
        expect(fields).toContain('_isNull');
      });

      it('should include ordering operators _gt, _gte, _lt, _lte', () => {
        const typeMap = schema.getTypeMap();
        const compType = typeMap[typeName] as GraphQLInputObjectType;
        const fields = Object.keys(compType.getFields());
        expect(fields).toContain('_gt');
        expect(fields).toContain('_gte');
        expect(fields).toContain('_lt');
        expect(fields).toContain('_lte');
      });

      it('should NOT include string-like operators (_like, _ilike, etc.)', () => {
        const typeMap = schema.getTypeMap();
        const compType = typeMap[typeName] as GraphQLInputObjectType;
        const fields = Object.keys(compType.getFields());
        expect(fields).not.toContain('_like');
        expect(fields).not.toContain('_ilike');
        expect(fields).not.toContain('_similar');
        expect(fields).not.toContain('_regex');
      });
    });
  }
});

// ── E2E Tests ────────────────────────────────────────────────────────────────

describe('Enum Comparison Ordering Operators (P10.9) — E2E', () => {
  beforeAll(async () => {
    process.env['DATABASE_URL'] = TEST_DB_URL;
    process.env['HAKKYRA_ADMIN_SECRET'] = ADMIN_SECRET;
    resetComparisonTypeCache();

    await waitForDb();
    await startServer();
  }, 30_000);

  afterAll(async () => {
    await stopServer();
    await closePool();
  });

  // client_status enum order: 'active', 'on_hold', 'inactive', 'archived'
  // Test data: alice=active, bob=active, charlie=on_hold, diana=active

  describe('_gt on enum column', () => {
    it('should return clients with status > active (i.e. on_hold, inactive, archived)', async () => {
      const { status, body } = await graphqlRequest(
        `query {
          clients(where: { status: { _gt: ACTIVE } }, orderBy: [{ username: ASC }]) {
            username status
          }
        }`,
        undefined,
        { 'x-hasura-admin-secret': ADMIN_SECRET },
      );
      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();
      const clients = (body.data as { clients: AnyRow[] }).clients;
      // Only charlie has on_hold which is > active in enum ordering
      expect(clients.length).toBe(1);
      expect(clients[0]['username']).toBe('charlie');
      expect(clients[0]['status']).toBe('ON_HOLD');
    });
  });

  describe('_gte on enum column', () => {
    it('should return clients with status >= on_hold', async () => {
      const { status, body } = await graphqlRequest(
        `query {
          clients(where: { status: { _gte: ON_HOLD } }, orderBy: [{ username: ASC }]) {
            username status
          }
        }`,
        undefined,
        { 'x-hasura-admin-secret': ADMIN_SECRET },
      );
      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();
      const clients = (body.data as { clients: AnyRow[] }).clients;
      // charlie=on_hold, which is >= on_hold
      expect(clients.length).toBe(1);
      expect(clients[0]['username']).toBe('charlie');
    });
  });

  describe('_lt on enum column', () => {
    it('should return clients with status < on_hold (i.e. only active)', async () => {
      const { status, body } = await graphqlRequest(
        `query {
          clients(where: { status: { _lt: ON_HOLD } }, orderBy: [{ username: ASC }]) {
            username status
          }
        }`,
        undefined,
        { 'x-hasura-admin-secret': ADMIN_SECRET },
      );
      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();
      const clients = (body.data as { clients: AnyRow[] }).clients;
      // alice, bob, diana all have active which is < on_hold
      expect(clients.length).toBe(3);
      const usernames = clients.map((c) => c['username']);
      expect(usernames).toContain('alice');
      expect(usernames).toContain('bob');
      expect(usernames).toContain('diana');
    });
  });

  describe('_lte on enum column', () => {
    it('should return clients with status <= active', async () => {
      const { status, body } = await graphqlRequest(
        `query {
          clients(where: { status: { _lte: ACTIVE } }, orderBy: [{ username: ASC }]) {
            username status
          }
        }`,
        undefined,
        { 'x-hasura-admin-secret': ADMIN_SECRET },
      );
      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();
      const clients = (body.data as { clients: AnyRow[] }).clients;
      // alice, bob, diana all have active which is <= active; charlie has on_hold which is > active
      expect(clients.length).toBe(3);
      const usernames = clients.map((c) => c['username']);
      expect(usernames).toContain('alice');
      expect(usernames).toContain('bob');
      expect(usernames).toContain('diana');
      expect(usernames).not.toContain('charlie');
    });
  });

  describe('combined ordering operators on enum column', () => {
    it('should support combining _gte and _lte for range filtering', async () => {
      const { status, body } = await graphqlRequest(
        `query {
          clients(where: { status: { _gte: ACTIVE, _lte: ON_HOLD } }, orderBy: [{ username: ASC }]) {
            username status
          }
        }`,
        undefined,
        { 'x-hasura-admin-secret': ADMIN_SECRET },
      );
      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();
      const clients = (body.data as { clients: AnyRow[] }).clients;
      // active <= status <= on_hold, should include all 4 test clients
      expect(clients.length).toBe(4);
    });
  });
});
