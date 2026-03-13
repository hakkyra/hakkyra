import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { compileFilter } from '../src/permissions/compiler.js';
import { buildPermissionLookup } from '../src/permissions/lookup.js';
import { loadConfig } from '../src/config/loader.js';
import { introspectDatabase } from '../src/introspection/introspector.js';
import { mergeSchemaModel } from '../src/introspection/merger.js';
import type { BoolExp, SchemaModel } from '../src/types.js';
import {
  getPool, closePool, waitForDb, makeSession,
  METADATA_DIR, SERVER_CONFIG_PATH, TEST_DB_URL, ALICE_ID,
} from './setup.js';

let schemaModel: SchemaModel;

beforeAll(async () => {
  process.env['DATABASE_URL'] = TEST_DB_URL;
  await waitForDb();
  const pool = getPool();
  const introspection = await introspectDatabase(pool);
  const config = await loadConfig(METADATA_DIR, SERVER_CONFIG_PATH);
  const result = mergeSchemaModel(introspection, config);
  schemaModel = result.model;
});

afterAll(async () => {
  await closePool();
});

describe('Permission Filter Compiler', () => {
  const session = makeSession('client', ALICE_ID);

  describe('simple operators', () => {
    it('should compile _eq filter', () => {
      const filter = compileFilter({ status: { _eq: 'active' } } as BoolExp);
      const result = filter.toSQL(session, 0);
      expect(result.sql).toContain('=');
      expect(result.sql).toContain('$1');
      expect(result.params).toEqual(['active']);
    });

    it('should compile _gt filter', () => {
      const filter = compileFilter({ trust_level: { _gt: 1 } } as BoolExp);
      const result = filter.toSQL(session, 0);
      expect(result.sql).toContain('>');
      expect(result.params).toEqual([1]);
    });

    it('should compile _lt filter', () => {
      const filter = compileFilter({ trust_level: { _lt: 3 } } as BoolExp);
      const result = filter.toSQL(session, 0);
      expect(result.sql).toContain('<');
      expect(result.params).toEqual([3]);
    });

    it('should compile _gte filter', () => {
      const filter = compileFilter({ trust_level: { _gte: 2 } } as BoolExp);
      const result = filter.toSQL(session, 0);
      expect(result.sql).toContain('>=');
      expect(result.params).toEqual([2]);
    });

    it('should compile _lte filter', () => {
      const filter = compileFilter({ trust_level: { _lte: 2 } } as BoolExp);
      const result = filter.toSQL(session, 0);
      expect(result.sql).toContain('<=');
      expect(result.params).toEqual([2]);
    });

    it('should compile _in filter', () => {
      const filter = compileFilter({ status: { _in: ['active', 'on_hold'] } } as BoolExp);
      const result = filter.toSQL(session, 0);
      expect(result.sql).toContain('IN');
      expect(result.params).toEqual(['active', 'on_hold']);
    });

    it('should compile _nin filter', () => {
      const filter = compileFilter({ status: { _nin: ['archived'] } } as BoolExp);
      const result = filter.toSQL(session, 0);
      expect(result.sql).toContain('NOT IN');
      expect(result.params).toEqual(['archived']);
    });
  });

  describe('null check', () => {
    it('should compile _is_null: true', () => {
      const filter = compileFilter({ country_id: { _is_null: true } } as BoolExp);
      const result = filter.toSQL(session, 0);
      expect(result.sql).toContain('IS NULL');
      expect(result.params).toHaveLength(0);
    });

    it('should compile _is_null: false', () => {
      const filter = compileFilter({ country_id: { _is_null: false } } as BoolExp);
      const result = filter.toSQL(session, 0);
      expect(result.sql).toContain('IS NOT NULL');
      expect(result.params).toHaveLength(0);
    });
  });

  describe('text operators', () => {
    it('should compile _like filter', () => {
      const filter = compileFilter({ username: { _like: '%alice%' } } as BoolExp);
      const result = filter.toSQL(session, 0);
      expect(result.sql).toContain('LIKE');
      expect(result.params).toEqual(['%alice%']);
    });

    it('should compile _ilike filter', () => {
      const filter = compileFilter({ email: { _ilike: '%TEST%' } } as BoolExp);
      const result = filter.toSQL(session, 0);
      expect(result.sql).toContain('ILIKE');
      expect(result.params).toEqual(['%TEST%']);
    });
  });

  describe('JSONB operators', () => {
    it('should compile _contains filter', () => {
      const filter = compileFilter({ tags: { _contains: ['vip'] } } as BoolExp);
      const result = filter.toSQL(session, 0);
      expect(result.sql).toContain('@>');
      expect(result.params.length).toBe(1);
    });

    it('should compile _has_key filter', () => {
      const filter = compileFilter({ metadata: { _has_key: 'theme' } } as BoolExp);
      const result = filter.toSQL(session, 0);
      expect(result.sql).toContain('?');
      expect(result.params).toEqual(['theme']);
    });
  });

  describe('logical operators', () => {
    it('should compile _and filter', () => {
      const filter = compileFilter({
        _and: [
          { status: { _eq: 'active' } },
          { trust_level: { _gte: 1 } },
        ],
      } as BoolExp);
      const result = filter.toSQL(session, 0);
      expect(result.sql).toContain('AND');
      expect(result.params).toEqual(['active', 1]);
    });

    it('should compile _or filter', () => {
      const filter = compileFilter({
        _or: [
          { status: { _eq: 'active' } },
          { status: { _eq: 'inactive' } },
        ],
      } as BoolExp);
      const result = filter.toSQL(session, 0);
      expect(result.sql).toContain('OR');
      expect(result.params).toEqual(['active', 'inactive']);
    });

    it('should compile _not filter', () => {
      const filter = compileFilter({
        _not: { status: { _eq: 'on_hold' } },
      } as BoolExp);
      const result = filter.toSQL(session, 0);
      expect(result.sql).toContain('NOT');
      expect(result.params).toEqual(['on_hold']);
    });

    it('should compile nested _and/_or combinations', () => {
      const filter = compileFilter({
        _and: [
          { _or: [{ status: { _eq: 'active' } }, { status: { _eq: 'inactive' } }] },
          { trust_level: { _gte: 1 } },
        ],
      } as BoolExp);
      const result = filter.toSQL(session, 0);
      expect(result.sql).toContain('AND');
      expect(result.sql).toContain('OR');
      expect(result.params).toEqual(['active', 'inactive', 1]);
    });
  });

  describe('_exists subquery', () => {
    it('should compile _exists filter', () => {
      const filter = compileFilter({
        _exists: {
          _table: { name: 'account', schema: 'public' },
          _where: { balance: { _gt: 0 } },
        },
      } as BoolExp);
      const result = filter.toSQL(session, 0);
      expect(result.sql).toContain('EXISTS');
      expect(result.sql).toContain('SELECT 1');
      expect(result.params).toEqual([0]);
    });
  });

  describe('session variable resolution', () => {
    it('should resolve X-Hasura-User-Id from session', () => {
      const filter = compileFilter({ id: { _eq: 'X-Hasura-User-Id' } } as BoolExp);
      const result = filter.toSQL(session, 0);
      expect(result.params).toEqual([ALICE_ID]);
    });

    it('should resolve session variables case-insensitively', () => {
      const filter = compileFilter({ id: { _eq: 'x-hasura-user-id' } } as BoolExp);
      const result = filter.toSQL(session, 0);
      expect(result.params).toEqual([ALICE_ID]);
    });
  });

  describe('empty filter', () => {
    it('should compile empty filter as TRUE', () => {
      const filter = compileFilter({} as BoolExp);
      const result = filter.toSQL(session, 0);
      expect(result.sql).toBe('TRUE');
      expect(result.params).toHaveLength(0);
    });
  });

  describe('parameter offset', () => {
    it('should respect paramOffset when generating placeholders', () => {
      const filter = compileFilter({ status: { _eq: 'active' } } as BoolExp);
      const result = filter.toSQL(session, 3);
      expect(result.sql).toContain('$4');
      expect(result.params).toEqual(['active']);
    });
  });
});

describe('Permission Lookup', () => {
  it('should build a lookup from schema model tables', () => {
    const lookup = buildPermissionLookup(schemaModel.tables);
    expect(lookup).toBeDefined();
  });

  it('should find select permission for client role on client table', () => {
    const lookup = buildPermissionLookup(schemaModel.tables);
    const perm = lookup.get('client', 'public', 'client', 'select');
    expect(perm).not.toBeNull();
    expect(perm!.select).toBeDefined();
    expect(perm!.select!.columns).toContain('id');
    expect(perm!.select!.columns).toContain('username');
  });

  it('should find insert permission for backoffice on client table', () => {
    const lookup = buildPermissionLookup(schemaModel.tables);
    const perm = lookup.get('client', 'public', 'backoffice', 'insert');
    expect(perm).not.toBeNull();
    expect(perm!.insert).toBeDefined();
  });

  it('should return null for missing permission', () => {
    const lookup = buildPermissionLookup(schemaModel.tables);
    const perm = lookup.get('client', 'public', 'anonymous', 'delete');
    expect(perm).toBeNull();
  });

  it('should return admin permission for admin role', () => {
    const lookup = buildPermissionLookup(schemaModel.tables);
    const perm = lookup.get('client', 'public', 'admin', 'select');
    expect(perm).not.toBeNull();
    expect(perm!.select!.columns).toBe('*');
    expect(perm!.select!.allowAggregations).toBe(true);
  });

  it('should return admin permission for any table and operation', () => {
    const lookup = buildPermissionLookup(schemaModel.tables);
    const selectPerm = lookup.get('account', 'public', 'admin', 'select');
    expect(selectPerm).not.toBeNull();
    const deletePerm = lookup.get('account', 'public', 'admin', 'delete');
    expect(deletePerm).not.toBeNull();
    expect(deletePerm!.delete).toBeDefined();
  });

  it('should compile permission filters that produce valid SQL', () => {
    const lookup = buildPermissionLookup(schemaModel.tables);
    const perm = lookup.get('client', 'public', 'client', 'select');
    const session = makeSession('client', ALICE_ID);
    const filterResult = perm!.select!.filter.toSQL(session, 0);
    expect(filterResult.sql).toBeTruthy();
    expect(filterResult.sql).not.toBe('TRUE'); // client has a filter
  });

  it('should have allowAggregations flag set for backoffice', () => {
    const lookup = buildPermissionLookup(schemaModel.tables);
    const perm = lookup.get('client', 'public', 'backoffice', 'select');
    expect(perm!.select!.allowAggregations).toBe(true);
  });

  it('should include insert presets from config', () => {
    const lookup = buildPermissionLookup(schemaModel.tables);
    const perm = lookup.get('client', 'public', 'backoffice', 'insert');
    expect(perm!.insert!.presets).toBeDefined();
    // Backoffice insert preset sets status to 'active'
    expect(perm!.insert!.presets['status']).toBe('active');
  });
});
