/**
 * Prepared statement manager for PostgreSQL.
 *
 * Maintains an LRU cache that maps SQL strings to stable statement names.
 * When used with node-postgres `client.query({ name, text, values })`,
 * the driver creates a server-side prepared statement on first use and
 * reuses the plan on subsequent calls with the same name.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PreparedStatementManager {
  /** Get a named query descriptor for the given SQL, suitable for pg client.query(). */
  prepare(sql: string, params: unknown[]): { name: string; text: string; values: unknown[] };
  /** Number of statements currently cached. */
  size(): number;
  /** Clear all cached statement names. */
  clear(): void;
}

// ─── Hash function ──────────────────────────────────────────────────────────

/**
 * Simple numeric hash (djb2) of a string, returned as a hex suffix.
 * This is fast and sufficient for statement naming — collisions are
 * extremely unlikely within a bounded LRU cache of typical size.
 */
function hashSQL(sql: string): string {
  let hash = 5381;
  for (let i = 0; i < sql.length; i++) {
    // hash * 33 + charCode
    hash = ((hash << 5) + hash + sql.charCodeAt(i)) | 0;
  }
  // Convert to unsigned 32-bit hex
  return (hash >>> 0).toString(16);
}

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Create a prepared statement manager with LRU eviction.
 *
 * @param maxSize - Maximum number of statement names to cache (default 500).
 */
export function createPreparedStatementManager(maxSize: number = 500): PreparedStatementManager {
  const cache = new Map<string, string>(); // sql -> statement name

  function getOrCreate(sql: string): string {
    const existing = cache.get(sql);
    if (existing !== undefined) {
      // Move to end (most recently used)
      cache.delete(sql);
      cache.set(sql, existing);
      return existing;
    }

    // Evict oldest if at capacity
    if (cache.size >= maxSize) {
      const firstKey = cache.keys().next().value;
      if (firstKey !== undefined) cache.delete(firstKey);
    }

    const name = `hakkyra_${hashSQL(sql)}`;
    cache.set(sql, name);
    return name;
  }

  return {
    prepare(sql: string, params: unknown[]): { name: string; text: string; values: unknown[] } {
      const name = getOrCreate(sql);
      return { name, text: sql, values: params };
    },

    size(): number {
      return cache.size;
    },

    clear(): void {
      cache.clear();
    },
  };
}
