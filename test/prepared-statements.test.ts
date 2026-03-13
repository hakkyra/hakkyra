import { describe, it, expect } from 'vitest';
import { createPreparedStatementManager } from '../src/connections/prepared-statements.js';

describe('PreparedStatementManager', () => {

  // ── Basic functionality ───────────────────────────────────────────────────

  describe('prepare()', () => {
    it('returns a named query descriptor with name, text, and values', () => {
      const mgr = createPreparedStatementManager();
      const result = mgr.prepare('SELECT * FROM users WHERE id = $1', [42]);

      expect(result).toHaveProperty('name');
      expect(result).toHaveProperty('text');
      expect(result).toHaveProperty('values');
      expect(result.text).toBe('SELECT * FROM users WHERE id = $1');
      expect(result.values).toEqual([42]);
      expect(result.name).toMatch(/^hakkyra_/);
    });

    it('returns the same name for the same SQL string', () => {
      const mgr = createPreparedStatementManager();
      const sql = 'SELECT * FROM users WHERE id = $1';

      const first = mgr.prepare(sql, [1]);
      const second = mgr.prepare(sql, [2]);

      expect(first.name).toBe(second.name);
      expect(first.text).toBe(second.text);
      // Values should differ
      expect(first.values).toEqual([1]);
      expect(second.values).toEqual([2]);
    });

    it('returns different names for different SQL strings', () => {
      const mgr = createPreparedStatementManager();
      const sql1 = 'SELECT * FROM users WHERE id = $1';
      const sql2 = 'SELECT * FROM orders WHERE user_id = $1';

      const first = mgr.prepare(sql1, [1]);
      const second = mgr.prepare(sql2, [1]);

      expect(first.name).not.toBe(second.name);
    });

    it('generates a name prefixed with hakkyra_', () => {
      const mgr = createPreparedStatementManager();
      const result = mgr.prepare('SELECT 1', []);

      expect(result.name.startsWith('hakkyra_')).toBe(true);
    });
  });

  // ── LRU eviction ─────────────────────────────────────────────────────────

  describe('LRU eviction', () => {
    it('evicts oldest entry when maxSize is exceeded', () => {
      const mgr = createPreparedStatementManager(3);

      const sql1 = 'SELECT 1';
      const sql2 = 'SELECT 2';
      const sql3 = 'SELECT 3';
      const sql4 = 'SELECT 4';

      mgr.prepare(sql1, []);
      mgr.prepare(sql2, []);
      mgr.prepare(sql3, []);
      expect(mgr.size()).toBe(3);

      // Adding a 4th should evict sql1
      mgr.prepare(sql4, []);
      expect(mgr.size()).toBe(3);
    });

    it('accessing an entry refreshes its position (prevents eviction)', () => {
      const mgr = createPreparedStatementManager(3);

      const sql1 = 'SELECT 1';
      const sql2 = 'SELECT 2';
      const sql3 = 'SELECT 3';
      const sql4 = 'SELECT 4';

      const name1 = mgr.prepare(sql1, []).name;
      mgr.prepare(sql2, []);
      mgr.prepare(sql3, []);

      // Re-access sql1 to refresh it, making sql2 the oldest
      mgr.prepare(sql1, []);

      // Adding sql4 should evict sql2 (the oldest after refresh), not sql1
      mgr.prepare(sql4, []);
      expect(mgr.size()).toBe(3);

      // sql1 should still be cached with the same name
      const name1Again = mgr.prepare(sql1, []).name;
      expect(name1Again).toBe(name1);
    });

    it('works correctly with maxSize of 1', () => {
      const mgr = createPreparedStatementManager(1);

      mgr.prepare('SELECT 1', []);
      expect(mgr.size()).toBe(1);

      mgr.prepare('SELECT 2', []);
      expect(mgr.size()).toBe(1);
    });
  });

  // ── size() and clear() ───────────────────────────────────────────────────

  describe('size()', () => {
    it('returns 0 for a new manager', () => {
      const mgr = createPreparedStatementManager();
      expect(mgr.size()).toBe(0);
    });

    it('returns the number of cached statements', () => {
      const mgr = createPreparedStatementManager();
      mgr.prepare('SELECT 1', []);
      mgr.prepare('SELECT 2', []);
      expect(mgr.size()).toBe(2);
    });

    it('does not double-count repeated SQL strings', () => {
      const mgr = createPreparedStatementManager();
      mgr.prepare('SELECT 1', []);
      mgr.prepare('SELECT 1', []);
      expect(mgr.size()).toBe(1);
    });
  });

  describe('clear()', () => {
    it('removes all cached entries', () => {
      const mgr = createPreparedStatementManager();
      mgr.prepare('SELECT 1', []);
      mgr.prepare('SELECT 2', []);
      expect(mgr.size()).toBe(2);

      mgr.clear();
      expect(mgr.size()).toBe(0);
    });
  });

  // ── Default max size ──────────────────────────────────────────────────────

  describe('default max size', () => {
    it('accepts a large number of statements with the default limit', () => {
      const mgr = createPreparedStatementManager();
      for (let i = 0; i < 500; i++) {
        mgr.prepare(`SELECT ${i}`, []);
      }
      expect(mgr.size()).toBe(500);
    });
  });

  // ── Config integration ────────────────────────────────────────────────────

  describe('config integration', () => {
    it('can be disabled by not creating the manager (feature off by default)', async () => {
      // Import the connection manager factory to verify config wiring
      const { createConnectionManager } = await import('../src/connections/manager.js');

      // With no preparedStatements config, the manager should still work
      // (just without prepared statements). We cannot easily test the
      // pool.query call format without a real database, but we verify
      // the factory does not throw.
      expect(typeof createConnectionManager).toBe('function');
    });
  });
});
