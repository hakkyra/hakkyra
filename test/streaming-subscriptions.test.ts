/**
 * Tests for streaming subscriptions ({table}Stream).
 *
 * Schema tests: CursorOrdering enum, StreamCursorInput types, {table}Stream fields.
 * E2E tests: streaming subscription delivery via WebSocket.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLInputObjectType,
  GraphQLEnumType,
  GraphQLNonNull,
  GraphQLList,
  GraphQLInt,
} from 'graphql';
import { createClient } from 'graphql-ws';
import type { Client as GqlWsClient } from 'graphql-ws';
import WebSocket from 'ws';
import pg from 'pg';
import { generateSchema } from '../src/schema/generator.js';
import { introspectDatabase } from '../src/introspection/introspector.js';
import { mergeSchemaModel } from '../src/introspection/merger.js';
import { loadConfig } from '../src/config/loader.js';
import {
  TEST_DB_URL,
  ADMIN_SECRET,
  getPool,
  closePool,
  waitForDb,
  METADATA_DIR,
  SERVER_CONFIG_PATH,
  startServer,
  getServerAddress,
  stopServer,
} from './setup.js';

const { Pool } = pg;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Schema Tests ────────────────────────────────────────────────────────────

describe('Streaming Subscriptions — Schema', () => {
  let schema: GraphQLSchema;

  beforeAll(async () => {
    process.env['DATABASE_URL'] = TEST_DB_URL;
    await waitForDb();

    const schemaPool = getPool();
    const introspection = await introspectDatabase(schemaPool);
    const config = await loadConfig(METADATA_DIR, SERVER_CONFIG_PATH);
    const result = mergeSchemaModel(introspection, config);
    schema = generateSchema(result.model);
  }, 30_000);

  afterAll(async () => {
    await closePool();
  });

  describe('CursorOrdering enum', () => {
    it('should exist in the schema type map', () => {
      const typeMap = schema.getTypeMap();
      expect(typeMap['CursorOrdering']).toBeDefined();
    });

    it('should have ASC and DESC values', () => {
      const typeMap = schema.getTypeMap();
      const cursorOrderingType = typeMap['CursorOrdering'] as GraphQLEnumType;
      expect(cursorOrderingType).toBeDefined();
      const values = cursorOrderingType.getValues();
      const valueNames = values.map((v) => v.name);
      expect(valueNames).toContain('ASC');
      expect(valueNames).toContain('DESC');
      expect(valueNames).toHaveLength(2);
    });
  });

  describe('StreamCursorInput types', () => {
    it('should generate StreamCursorValueInput for branch table', () => {
      const typeMap = schema.getTypeMap();
      expect(typeMap['BranchStreamCursorValueInput']).toBeDefined();
    });

    it('should have all branch columns as optional fields on StreamCursorValueInput', () => {
      const typeMap = schema.getTypeMap();
      const valueType = typeMap['BranchStreamCursorValueInput'] as GraphQLInputObjectType;
      expect(valueType).toBeDefined();
      const fields = valueType.getFields();
      expect(fields['id']).toBeDefined();
      expect(fields['name']).toBeDefined();
      expect(fields['code']).toBeDefined();
      expect(fields['active']).toBeDefined();
      expect(fields['createdAt']).toBeDefined();
      // All fields should be nullable (not wrapped in NonNull)
      for (const field of Object.values(fields)) {
        expect(field.type).not.toBeInstanceOf(GraphQLNonNull);
      }
    });

    it('should generate StreamCursorInput for branch table', () => {
      const typeMap = schema.getTypeMap();
      expect(typeMap['BranchStreamCursorInput']).toBeDefined();
    });

    it('should have initialValue (non-null) and ordering fields on StreamCursorInput', () => {
      const typeMap = schema.getTypeMap();
      const cursorType = typeMap['BranchStreamCursorInput'] as GraphQLInputObjectType;
      expect(cursorType).toBeDefined();
      const fields = cursorType.getFields();

      // initialValue should be non-null
      expect(fields['initialValue']).toBeDefined();
      expect(fields['initialValue'].type).toBeInstanceOf(GraphQLNonNull);

      // ordering should be nullable CursorOrdering
      expect(fields['ordering']).toBeDefined();
      expect(fields['ordering'].type).not.toBeInstanceOf(GraphQLNonNull);
    });

    it('should generate StreamCursorInput for client table', () => {
      const typeMap = schema.getTypeMap();
      expect(typeMap['ClientStreamCursorInput']).toBeDefined();
      expect(typeMap['ClientStreamCursorValueInput']).toBeDefined();
    });
  });

  describe('{table}Stream subscription field', () => {
    it('should have branchStream subscription field', () => {
      const subscriptionType = schema.getSubscriptionType()!;
      const fields = subscriptionType.getFields();
      expect(fields['branchStream']).toBeDefined();
    });

    it('should have clientStream subscription field', () => {
      const subscriptionType = schema.getSubscriptionType()!;
      const fields = subscriptionType.getFields();
      // base = toCamelCase('client') = 'client', so stream is 'clientStream'
      expect(fields['clientStream']).toBeDefined();
    });

    it('should have correct args on stream subscription', () => {
      const subscriptionType = schema.getSubscriptionType()!;
      const streamField = subscriptionType.getFields()['branchStream'];
      expect(streamField).toBeDefined();

      const argNames = streamField.args.map((a) => a.name);
      expect(argNames).toContain('batchSize');
      expect(argNames).toContain('cursor');
      expect(argNames).toContain('where');
    });

    it('should have batchSize as non-null Int', () => {
      const subscriptionType = schema.getSubscriptionType()!;
      const streamField = subscriptionType.getFields()['branchStream'];
      const batchSizeArg = streamField.args.find((a) => a.name === 'batchSize');
      expect(batchSizeArg).toBeDefined();
      expect(batchSizeArg!.type).toBeInstanceOf(GraphQLNonNull);
      expect((batchSizeArg!.type as GraphQLNonNull<typeof GraphQLInt>).ofType).toBe(GraphQLInt);
    });

    it('should have cursor as non-null list of StreamCursorInput', () => {
      const subscriptionType = schema.getSubscriptionType()!;
      const streamField = subscriptionType.getFields()['branchStream'];
      const cursorArg = streamField.args.find((a) => a.name === 'cursor');
      expect(cursorArg).toBeDefined();
      expect(cursorArg!.type).toBeInstanceOf(GraphQLNonNull);
    });

    it('should return [Branch!]! type', () => {
      const subscriptionType = schema.getSubscriptionType()!;
      const streamField = subscriptionType.getFields()['branchStream'];
      // Return type: [Branch!]!
      expect(streamField.type).toBeInstanceOf(GraphQLNonNull);
      const innerType = (streamField.type as GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLObjectType>>>).ofType;
      expect(innerType).toBeInstanceOf(GraphQLList);
    });
  });
});
