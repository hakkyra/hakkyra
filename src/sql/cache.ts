/**
 * Query cache for compiled SQL templates.
 *
 * Caches compiled SQL by (queryHash, role) so repeated identical GraphQL
 * queries skip the SQL compilation step. Only the parameter values change
 * between requests with the same query shape.
 */

import { createHash } from 'crypto';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface CachedQuery {
  sql: string;
  params: unknown[];
}

export interface QueryCache {
  get(key: string): CachedQuery | undefined;
  set(key: string, query: CachedQuery): void;
  clear(): void;
  size(): number;
}

// ─── Cache Key Building ────────────────────────────────────────────────────

/**
 * Build a cache key from the GraphQL query hash and active role.
 */
export function buildCacheKey(queryHash: string, role: string): string {
  return `${role}:${queryHash}`;
}

/**
 * Hash a GraphQL query string for use as a cache key component.
 * Uses SHA-256 truncated to 16 hex chars for fast, collision-resistant keys.
 */
export function hashQuery(query: string): string {
  return createHash('sha256').update(query).digest('hex').slice(0, 16);
}

// ─── LRU Query Cache ──────────────────────────────────────────────────────

/**
 * Create an LRU query cache with a maximum number of entries.
 *
 * Uses Map insertion order for LRU eviction: on access, entries are
 * moved to the end; on eviction, the first (oldest) entry is removed.
 */
export function createQueryCache(maxSize: number = 1000): QueryCache {
  const cache = new Map<string, CachedQuery>();

  return {
    get(key: string): CachedQuery | undefined {
      const entry = cache.get(key);
      if (entry) {
        // Move to end (most recently used)
        cache.delete(key);
        cache.set(key, entry);
      }
      return entry;
    },

    set(key: string, query: CachedQuery): void {
      if (cache.has(key)) {
        cache.delete(key);
      } else if (cache.size >= maxSize) {
        // Evict oldest (first entry in Map)
        const firstKey = cache.keys().next().value;
        if (firstKey !== undefined) cache.delete(firstKey);
      }
      cache.set(key, query);
    },

    clear(): void {
      cache.clear();
    },

    size(): number {
      return cache.size;
    },
  };
}
