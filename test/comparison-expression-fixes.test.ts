/**
 * Tests for P12.12 and P12.21 — Comparison expression operator fixes.
 *
 * P12.12: Table-based enum comparison types (from is_enum: true tables) should
 *   NOT include _gt/_gte/_lt/_lte ordering operators. Only _eq, _neq, _in, _nin,
 *   _isNull are valid. PG native enum comparison types should still have them.
 *
 * P12.21: InetComparisonExp and IntervalComparisonExp should include
 *   _gt/_gte/_lt/_lte ordering operators (matching Hasura).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  GraphQLSchema,
  GraphQLInputObjectType,
} from 'graphql';
import { generateSchema } from '../src/schema/generator.js';
import { resetComparisonTypeCache } from '../src/schema/filters.js';
import { introspectDatabase } from '../src/introspection/introspector.js';
import { mergeSchemaModel, resolveTableEnums } from '../src/introspection/merger.js';
import { loadConfig } from '../src/config/loader.js';
import {
  closePool, waitForDb,
  METADATA_DIR, SERVER_CONFIG_PATH, TEST_DB_URL,
  getPool,
} from './setup.js';

// ── Ensure inet and interval columns exist ──────────────────────────────────

async function ensureInetAndIntervalColumns(): Promise<void> {
  const pool = getPool();
  await pool.query(`ALTER TABLE client ADD COLUMN IF NOT EXISTS ip_address inet`);
  await pool.query(`ALTER TABLE client ADD COLUMN IF NOT EXISTS session_duration interval`);
}

// ── Schema-Level Tests ────────────────────────────────────────────────────────

describe('Comparison Expression Fixes (P12.12 + P12.21) — Schema', () => {
  let schema: GraphQLSchema;

  beforeAll(async () => {
    process.env['DATABASE_URL'] = TEST_DB_URL;
    resetComparisonTypeCache();

    await waitForDb();
    await ensureInetAndIntervalColumns();
    const pool = getPool();
    const introspection = await introspectDatabase(pool);
    const config = await loadConfig(METADATA_DIR, SERVER_CONFIG_PATH);
    const result = mergeSchemaModel(introspection, config);
    await resolveTableEnums(result.model, pool);
    schema = generateSchema(result.model);
  });

  afterAll(async () => {
    await closePool();
  });

  // ── P12.12: Table-based enum comparison types ─────────────────────────────

  describe('P12.12 — Table-based enum comparison types should NOT have ordering operators', () => {
    it('PriorityTypeEnumComparisonExp should exist', () => {
      const typeMap = schema.getTypeMap();
      expect(typeMap['PriorityTypeEnumComparisonExp']).toBeDefined();
    });

    it('should include base comparison fields (_eq, _neq, _in, _nin, _isNull)', () => {
      const typeMap = schema.getTypeMap();
      const compType = typeMap['PriorityTypeEnumComparisonExp'] as GraphQLInputObjectType;
      const fields = Object.keys(compType.getFields());
      expect(fields).toContain('_eq');
      expect(fields).toContain('_neq');
      expect(fields).toContain('_in');
      expect(fields).toContain('_nin');
      expect(fields).toContain('_isNull');
    });

    it('should NOT include ordering operators _gt, _gte, _lt, _lte', () => {
      const typeMap = schema.getTypeMap();
      const compType = typeMap['PriorityTypeEnumComparisonExp'] as GraphQLInputObjectType;
      const fields = Object.keys(compType.getFields());
      expect(fields).not.toContain('_gt');
      expect(fields).not.toContain('_gte');
      expect(fields).not.toContain('_lt');
      expect(fields).not.toContain('_lte');
    });

    it('should have exactly 5 fields (no extra operators)', () => {
      const typeMap = schema.getTypeMap();
      const compType = typeMap['PriorityTypeEnumComparisonExp'] as GraphQLInputObjectType;
      const fields = Object.keys(compType.getFields());
      expect(fields).toHaveLength(5);
      expect(fields.sort()).toEqual(['_eq', '_in', '_isNull', '_neq', '_nin']);
    });
  });

  describe('P12.12 — PG native enum comparison types should still have ordering operators', () => {
    const pgEnumComparisonTypes = [
      'ClientStatusComparisonExp',
      'InvoiceStateComparisonExp',
      'LedgerTypeComparisonExp',
    ];

    for (const typeName of pgEnumComparisonTypes) {
      it(`${typeName} should include _gt, _gte, _lt, _lte`, () => {
        const typeMap = schema.getTypeMap();
        const compType = typeMap[typeName] as GraphQLInputObjectType;
        expect(compType).toBeDefined();
        const fields = Object.keys(compType.getFields());
        expect(fields).toContain('_gt');
        expect(fields).toContain('_gte');
        expect(fields).toContain('_lt');
        expect(fields).toContain('_lte');
        // Plus the base fields
        expect(fields).toContain('_eq');
        expect(fields).toContain('_neq');
        expect(fields).toContain('_in');
        expect(fields).toContain('_nin');
        expect(fields).toContain('_isNull');
      });
    }
  });

  // ── P12.21: Inet and Interval comparison types ────────────────────────────

  describe('P12.21 — InetComparisonExp should include ordering operators', () => {
    it('InetComparisonExp should exist', () => {
      const typeMap = schema.getTypeMap();
      expect(typeMap['InetComparisonExp']).toBeDefined();
    });

    it('should include base comparison fields', () => {
      const typeMap = schema.getTypeMap();
      const compType = typeMap['InetComparisonExp'] as GraphQLInputObjectType;
      const fields = Object.keys(compType.getFields());
      expect(fields).toContain('_eq');
      expect(fields).toContain('_neq');
      expect(fields).toContain('_in');
      expect(fields).toContain('_nin');
      expect(fields).toContain('_isNull');
    });

    it('should include ordering operators _gt, _gte, _lt, _lte', () => {
      const typeMap = schema.getTypeMap();
      const compType = typeMap['InetComparisonExp'] as GraphQLInputObjectType;
      const fields = Object.keys(compType.getFields());
      expect(fields).toContain('_gt');
      expect(fields).toContain('_gte');
      expect(fields).toContain('_lt');
      expect(fields).toContain('_lte');
    });

    it('should have exactly 9 fields (base + ordering)', () => {
      const typeMap = schema.getTypeMap();
      const compType = typeMap['InetComparisonExp'] as GraphQLInputObjectType;
      const fields = Object.keys(compType.getFields());
      expect(fields).toHaveLength(9);
    });
  });

  describe('P12.21 — IntervalComparisonExp should include ordering operators', () => {
    it('IntervalComparisonExp should exist', () => {
      const typeMap = schema.getTypeMap();
      expect(typeMap['IntervalComparisonExp']).toBeDefined();
    });

    it('should include base comparison fields', () => {
      const typeMap = schema.getTypeMap();
      const compType = typeMap['IntervalComparisonExp'] as GraphQLInputObjectType;
      const fields = Object.keys(compType.getFields());
      expect(fields).toContain('_eq');
      expect(fields).toContain('_neq');
      expect(fields).toContain('_in');
      expect(fields).toContain('_nin');
      expect(fields).toContain('_isNull');
    });

    it('should include ordering operators _gt, _gte, _lt, _lte', () => {
      const typeMap = schema.getTypeMap();
      const compType = typeMap['IntervalComparisonExp'] as GraphQLInputObjectType;
      const fields = Object.keys(compType.getFields());
      expect(fields).toContain('_gt');
      expect(fields).toContain('_gte');
      expect(fields).toContain('_lt');
      expect(fields).toContain('_lte');
    });

    it('should have exactly 9 fields (base + ordering)', () => {
      const typeMap = schema.getTypeMap();
      const compType = typeMap['IntervalComparisonExp'] as GraphQLInputObjectType;
      const fields = Object.keys(compType.getFields());
      expect(fields).toHaveLength(9);
    });
  });
});
