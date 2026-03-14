import { describe, it, expect } from 'vitest';
import { parseRESTFilters } from '../src/rest/filters.js';
import type { ColumnOperators } from '../src/types.js';

describe('REST Filter Parsing', () => {
  describe('simple comparison operators', () => {
    it('should parse eq operator: name=eq.Alice', () => {
      const result = parseRESTFilters({ name: 'eq.Alice' });
      const where = result.where as Record<string, ColumnOperators>;
      expect(where.name._eq).toBe('Alice');
    });

    it('should parse gt operator: amount=gt.100', () => {
      const result = parseRESTFilters({ amount: 'gt.100' });
      const where = result.where as Record<string, ColumnOperators>;
      expect(where.amount._gt).toBe(100);
    });

    it('should parse gte operator', () => {
      const result = parseRESTFilters({ amount: 'gte.50' });
      const where = result.where as Record<string, ColumnOperators>;
      expect(where.amount._gte).toBe(50);
    });

    it('should parse lt operator', () => {
      const result = parseRESTFilters({ amount: 'lt.200' });
      const where = result.where as Record<string, ColumnOperators>;
      expect(where.amount._lt).toBe(200);
    });

    it('should parse lte operator', () => {
      const result = parseRESTFilters({ amount: 'lte.500' });
      const where = result.where as Record<string, ColumnOperators>;
      expect(where.amount._lte).toBe(500);
    });

    it('should parse neq operator', () => {
      const result = parseRESTFilters({ status: 'neq.on_hold' });
      const where = result.where as Record<string, ColumnOperators>;
      expect(where.status._neq).toBe('on_hold');
    });
  });

  describe('in operator', () => {
    it('should parse in operator: status=in.(active,on_hold)', () => {
      const result = parseRESTFilters({ status: 'in.(active,on_hold)' });
      const where = result.where as Record<string, ColumnOperators>;
      expect(where.status._in).toEqual(['active', 'on_hold']);
    });

    it('should parse nin operator: status=nin.(archived)', () => {
      const result = parseRESTFilters({ status: 'nin.(archived)' });
      const where = result.where as Record<string, ColumnOperators>;
      expect(where.status._nin).toEqual(['archived']);
    });
  });

  describe('text operators', () => {
    it('should parse like operator: username=like.%ali%', () => {
      const result = parseRESTFilters({ username: 'like.%ali%' });
      const where = result.where as Record<string, ColumnOperators>;
      expect(where.username._like).toBe('%ali%');
    });

    it('should parse ilike operator: email=ilike.*test*', () => {
      const result = parseRESTFilters({ email: 'ilike.*test*' });
      const where = result.where as Record<string, ColumnOperators>;
      expect(where.email._ilike).toBe('*test*');
    });
  });

  describe('is operator (null/boolean)', () => {
    it('should parse is.true as _eq: true', () => {
      const result = parseRESTFilters({ active: 'is.true' });
      const where = result.where as Record<string, ColumnOperators>;
      expect(where.active._eq).toBe(true);
    });

    it('should parse is.false as _eq: false', () => {
      const result = parseRESTFilters({ active: 'is.false' });
      const where = result.where as Record<string, ColumnOperators>;
      expect(where.active._eq).toBe(false);
    });

    it('should parse is.null as _isNull: true', () => {
      const result = parseRESTFilters({ country_id: 'is.null' });
      const where = result.where as Record<string, ColumnOperators>;
      expect(where.country_id._isNull).toBe(true);
    });
  });

  describe('not prefix', () => {
    it('should parse not.eq.on_hold', () => {
      const result = parseRESTFilters({ status: 'not.eq.on_hold' });
      const where = result.where as Record<string, ColumnOperators>;
      expect(where.status._neq).toBe('on_hold');
    });

    it('should parse not.in.(archived,on_hold)', () => {
      const result = parseRESTFilters({ status: 'not.in.(archived,on_hold)' });
      const where = result.where as Record<string, ColumnOperators>;
      expect(where.status._nin).toEqual(['archived', 'on_hold']);
    });
  });

  describe('numeric coercion', () => {
    it('should coerce integer strings to numbers', () => {
      const result = parseRESTFilters({ trust_level: 'eq.2' });
      const where = result.where as Record<string, ColumnOperators>;
      expect(where.trust_level._eq).toBe(2);
    });

    it('should coerce decimal strings to numbers', () => {
      const result = parseRESTFilters({ balance: 'gt.99.50' });
      const where = result.where as Record<string, ColumnOperators>;
      expect(where.balance._gt).toBe(99.5);
    });
  });

  describe('order parsing', () => {
    it('should parse single column order', () => {
      const result = parseRESTFilters({ order: 'username.asc' });
      expect(result.orderBy).toHaveLength(1);
      expect(result.orderBy[0].column).toBe('username');
      expect(result.orderBy[0].direction).toBe('asc');
    });

    it('should parse descending order', () => {
      const result = parseRESTFilters({ order: 'created_at.desc' });
      expect(result.orderBy).toHaveLength(1);
      expect(result.orderBy[0].direction).toBe('desc');
    });

    it('should parse multi-column order', () => {
      const result = parseRESTFilters({ order: 'status.asc,username.desc' });
      expect(result.orderBy).toHaveLength(2);
      expect(result.orderBy[0].column).toBe('status');
      expect(result.orderBy[0].direction).toBe('asc');
      expect(result.orderBy[1].column).toBe('username');
      expect(result.orderBy[1].direction).toBe('desc');
    });

    it('should parse order with nulls first/last', () => {
      const result = parseRESTFilters({ order: 'country_id.asc.nullslast' });
      expect(result.orderBy[0].nulls).toBe('last');
    });
  });

  describe('limit and offset parsing', () => {
    it('should parse limit parameter', () => {
      const result = parseRESTFilters({ limit: '10' });
      expect(result.limit).toBe(10);
    });

    it('should parse offset parameter', () => {
      const result = parseRESTFilters({ offset: '20' });
      expect(result.offset).toBe(20);
    });

    it('should parse both limit and offset', () => {
      const result = parseRESTFilters({ limit: '5', offset: '10' });
      expect(result.limit).toBe(5);
      expect(result.offset).toBe(10);
    });

    it('should ignore negative limit', () => {
      const result = parseRESTFilters({ limit: '-1' });
      expect(result.limit).toBeUndefined();
    });
  });

  describe('select column parsing', () => {
    it('should parse select parameter', () => {
      const result = parseRESTFilters({ select: 'id,username,email' });
      expect(result.select).toEqual(['id', 'username', 'email']);
    });

    it('should handle select with spaces', () => {
      const result = parseRESTFilters({ select: 'id, username, email' });
      expect(result.select).toEqual(['id', 'username', 'email']);
    });
  });

  describe('multiple filters', () => {
    it('should combine multiple column filters', () => {
      const result = parseRESTFilters({
        status: 'eq.active',
        trust_level: 'gte.1',
      });
      const where = result.where as Record<string, ColumnOperators>;
      expect(where.status._eq).toBe('active');
      expect(where.trust_level._gte).toBe(1);
    });

    it('should combine filters with order and limit', () => {
      const result = parseRESTFilters({
        status: 'eq.active',
        order: 'username.asc',
        limit: '2',
        offset: '0',
      });
      const where = result.where as Record<string, ColumnOperators>;
      expect(where.status._eq).toBe('active');
      expect(result.orderBy).toHaveLength(1);
      expect(result.limit).toBe(2);
      expect(result.offset).toBe(0);
    });
  });

  describe('empty input', () => {
    it('should handle empty query object', () => {
      const result = parseRESTFilters({});
      expect(Object.keys(result.where as object)).toHaveLength(0);
      expect(result.orderBy).toHaveLength(0);
      expect(result.limit).toBeUndefined();
      expect(result.offset).toBeUndefined();
    });
  });
});
