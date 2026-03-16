/**
 * Tests for P9.10 and P9.15 — Type parity fixes.
 *
 * P9.10: BpcharComparisonExp pattern operators should accept Bpchar, not String.
 * P9.15: MaxOrderBy/MinOrderBy aggregate types should include all orderable columns,
 *        not just numeric/PK/FK columns.
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
  getPool, closePool, waitForDb,
  METADATA_DIR, SERVER_CONFIG_PATH, TEST_DB_URL,
} from './setup.js';

let schema: GraphQLSchema;

async function ensureBpcharColumn(): Promise<void> {
  const pool = getPool();
  await pool.query(`ALTER TABLE product ADD COLUMN IF NOT EXISTS sku char(10) DEFAULT 'SKU0000000'`);
}

beforeAll(async () => {
  process.env['DATABASE_URL'] = TEST_DB_URL;
  resetComparisonTypeCache();

  await waitForDb();
  await ensureBpcharColumn();
  const pool = getPool();
  const introspection = await introspectDatabase(pool);
  const config = await loadConfig(METADATA_DIR, SERVER_CONFIG_PATH);
  const result = mergeSchemaModel(introspection, config);
  schema = generateSchema(result.model);
});

afterAll(async () => {
  await closePool();
});

// ── P9.10: BpcharComparisonExp ──────────────────────────────────────────────

describe('P9.10 — BpcharComparisonExp pattern operators accept Bpchar', () => {
  it('should have BpcharComparisonExp in schema', () => {
    const typeMap = schema.getTypeMap();
    expect(typeMap['BpcharComparisonExp']).toBeDefined();
  });

  it('should use Bpchar scalar for pattern-matching operators', () => {
    const compType = schema.getType('BpcharComparisonExp') as GraphQLInputObjectType;
    const fields = compType.getFields();

    const patternOps = [
      '_like', '_nlike', '_ilike', '_nilike',
      '_similar', '_nsimilar',
      '_regex', '_nregex', '_iregex', '_niregex',
    ];

    for (const op of patternOps) {
      expect(fields[op]).toBeDefined();
      expect(fields[op].type.toString()).toBe('Bpchar');
    }
  });

  it('should use Bpchar scalar for base comparison operators too', () => {
    const compType = schema.getType('BpcharComparisonExp') as GraphQLInputObjectType;
    const fields = compType.getFields();

    expect(fields['_eq'].type.toString()).toBe('Bpchar');
    expect(fields['_neq'].type.toString()).toBe('Bpchar');
    expect(fields['_gt'].type.toString()).toBe('Bpchar');
    expect(fields['_lt'].type.toString()).toBe('Bpchar');
    expect(fields['_gte'].type.toString()).toBe('Bpchar');
    expect(fields['_lte'].type.toString()).toBe('Bpchar');
  });

  it('StringComparisonExp pattern operators should still use String', () => {
    const compType = schema.getType('StringComparisonExp') as GraphQLInputObjectType;
    const fields = compType.getFields();

    expect(fields['_like'].type.toString()).toBe('String');
    expect(fields['_ilike'].type.toString()).toBe('String');
    expect(fields['_regex'].type.toString()).toBe('String');
  });
});

// ── P9.15: MaxOrderBy/MinOrderBy field parity ──────────────────────────────

describe('P9.15 — MaxOrderBy/MinOrderBy include all orderable columns', () => {
  it('should include non-numeric orderable columns in MaxOrderBy types', () => {
    // Client table has string columns (username, email) and date columns (createdAt)
    const clientMaxOrderBy = schema.getType('ClientMaxOrderBy') as GraphQLInputObjectType;
    if (!clientMaxOrderBy) return; // Skip if table has no orderable columns generating this type

    const fields = clientMaxOrderBy.getFields();

    // Should include string/date columns, not just numeric
    expect(fields['username']).toBeDefined();
    expect(fields['email']).toBeDefined();
    expect(fields['createdAt']).toBeDefined();
  });

  it('should include non-numeric orderable columns in MinOrderBy types', () => {
    const clientMinOrderBy = schema.getType('ClientMinOrderBy') as GraphQLInputObjectType;
    if (!clientMinOrderBy) return;

    const fields = clientMinOrderBy.getFields();

    expect(fields['username']).toBeDefined();
    expect(fields['email']).toBeDefined();
    expect(fields['createdAt']).toBeDefined();
  });

  it('AvgOrderBy should still only include numeric columns', () => {
    const accountAvgOrderBy = schema.getType('AccountAvgOrderBy') as GraphQLInputObjectType;
    if (!accountAvgOrderBy) return;

    const fields = accountAvgOrderBy.getFields();

    // Account has numeric columns: balance, creditBalance, pendingBalance
    expect(fields['balance']).toBeDefined();

    // Should NOT include non-numeric columns like createdAt, id (uuid), etc.
    expect(fields['createdAt']).toBeUndefined();
  });

  it('SumOrderBy should still only include numeric columns', () => {
    const accountSumOrderBy = schema.getType('AccountSumOrderBy') as GraphQLInputObjectType;
    if (!accountSumOrderBy) return;

    const fields = accountSumOrderBy.getFields();

    expect(fields['balance']).toBeDefined();
    expect(fields['createdAt']).toBeUndefined();
  });

  it('InvoiceMaxOrderBy should include non-numeric orderable columns', () => {
    const invoiceMaxOrderBy = schema.getType('InvoiceMaxOrderBy') as GraphQLInputObjectType;
    if (!invoiceMaxOrderBy) return;

    const fields = invoiceMaxOrderBy.getFields();

    // Invoice has numeric (amount) AND date (createdAt) columns
    expect(fields['amount']).toBeDefined();
    expect(fields['createdAt']).toBeDefined();
  });

  it('MaxOrderBy/MinOrderBy should not include jsonb columns', () => {
    // Client has a jsonb column (tags) — it should not be in MaxOrderBy
    const clientMaxOrderBy = schema.getType('ClientMaxOrderBy') as GraphQLInputObjectType;
    if (!clientMaxOrderBy) return;

    const fields = clientMaxOrderBy.getFields();
    expect(fields['tags']).toBeUndefined();
  });
});
