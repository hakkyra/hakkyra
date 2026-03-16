/**
 * Connection pool manager.
 *
 * Creates and manages pg.Pool instances for the primary database and
 * optional read replicas. Provides read/write routing with round-robin
 * selection across replicas.
 */

import pg from 'pg';
import pino from 'pino';
import type { DatabasesConfig, PoolConfig, SessionVariables } from '../types.js';
import { createConsistencyTracker } from './consistency.js';
import type { ConsistencyTracker } from './consistency.js';
import { createPreparedStatementManager } from './prepared-statements.js';
import type { PreparedStatementManager } from './prepared-statements.js';

const { Pool } = pg;
type PoolInstance = InstanceType<typeof pg.Pool>;

const defaultLogger = pino({ name: 'hakkyra:connections' });

// ─── ConnectionManager interface ─────────────────────────────────────────────

export interface ConnectionManager {
  /** Get a pool for the given intent. 'read' round-robins across replicas, 'write' uses primary. */
  getPool(intent: 'read' | 'write'): PoolInstance;
  /**
   * Execute a query within a transaction that first injects session variables
   * as PostgreSQL SET LOCAL settings. This allows SQL functions to access the
   * authenticated user via current_setting('hasura.user'), etc.
   */
  queryWithSession(
    sql: string,
    params: unknown[],
    session: SessionVariables,
    intent: 'read' | 'write',
  ): Promise<{ rows: unknown[]; rowCount: number }>;
  /**
   * Execute multiple queries within a single transaction with session variable injection.
   * Each step receives the results of all prior steps, enabling FK value propagation
   * for nested inserts.
   */
  transactionalQueryWithSession(
    queries: Array<{ sql: string; params: unknown[] }>,
    session: SessionVariables,
  ): Promise<Array<{ rows: unknown[]; rowCount: number }>>;
  /** Check that all pools can connect successfully. */
  healthCheck(): Promise<boolean>;
  /** Gracefully close all pool connections. */
  shutdown(): Promise<void>;
  /**
   * Get the connection string for LISTEN/NOTIFY operations.
   * Returns the dedicated session connection string if configured,
   * otherwise falls back to the primary connection string.
   * This enables PgBouncer transaction-mode compatibility by routing
   * LISTEN/NOTIFY through a separate session-mode connection.
   */
  getSessionConnectionString(): string;
}

// ─── Pool creation helpers ───────────────────────────────────────────────────

function resolveConnectionString(urlEnv: string): string {
  const url = process.env[urlEnv];
  if (!url) {
    throw new Error(
      `Environment variable "${urlEnv}" is not set. Cannot connect to database.`,
    );
  }
  return url;
}

function createPool(urlEnv: string, poolConfig?: PoolConfig): PoolInstance {
  const connectionString = resolveConnectionString(urlEnv);

  return new Pool({
    connectionString,
    max: poolConfig?.max,
    idleTimeoutMillis: poolConfig ? poolConfig.idleTimeout * 1000 : undefined,
    connectionTimeoutMillis: poolConfig ? poolConfig.connectionTimeout * 1000 : undefined,
    ...(poolConfig?.maxLifetime != null && {
      maxLifetimeMillis: poolConfig.maxLifetime * 1000,
    }),
    ...(poolConfig?.allowExitOnIdle != null && {
      allowExitOnIdle: poolConfig.allowExitOnIdle,
    }),
  });
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a connection manager from the database configuration.
 *
 * The manager provides:
 * - `getPool('write')` — always returns the primary pool
 * - `getPool('read')` — round-robins across replicas, falls back to primary
 * - `healthCheck()` — validates connectivity for all pools
 * - `shutdown()` — gracefully ends all connections
 */
export function createConnectionManager(
  config: DatabasesConfig,
  logger?: pino.Logger,
  schemaName: string = 'hakkyra',
): ConnectionManager {
  const log = logger ?? defaultLogger;

  // Primary pool (always required)
  const primaryPool = createPool(config.primary.urlEnv, config.primary.pool);

  // Session connection string for LISTEN/NOTIFY (separate from pool for PgBouncer compat)
  // Falls back to primary connection string when not configured
  const sessionConnectionString = config.session
    ? resolveConnectionString(config.session.urlEnv)
    : resolveConnectionString(config.primary.urlEnv);

  // Prepared statement manager (optional)
  const psConfig = config.preparedStatements;
  const stmtManager: PreparedStatementManager | null =
    psConfig?.enabled
      ? createPreparedStatementManager(psConfig.maxCached)
      : null;

  // Replica pools (optional)
  const replicaPools: PoolInstance[] = [];
  if (config.replicas && config.replicas.length > 0) {
    for (const replica of config.replicas) {
      try {
        replicaPools.push(createPool(replica.urlEnv, replica.pool));
      } catch (err) {
        // If a replica env var is missing, log and skip rather than failing startup
        log.warn({ err }, 'Skipping replica due to configuration error');
      }
    }
  }

  // Read-your-writes consistency tracker (optional)
  let consistencyTracker: ConsistencyTracker | undefined;
  if (config.readYourWrites?.enabled && replicaPools.length > 0) {
    const windowMs = config.readYourWrites.windowSeconds * 1000;
    consistencyTracker = createConsistencyTracker(windowMs);
  }

  // Round-robin index for read routing
  let readIndex = 0;

  // All pools for health checks and shutdown
  const allPools = [primaryPool, ...replicaPools];

  function selectPool(intent: 'read' | 'write', userId?: string): PoolInstance {
    if (intent === 'write') {
      return primaryPool;
    }
    if (replicaPools.length === 0) {
      return primaryPool;
    }
    // Read-your-writes: route to primary if user recently performed a mutation
    if (userId && consistencyTracker?.shouldReadFromPrimary(userId)) {
      return primaryPool;
    }
    const pool = replicaPools[readIndex % replicaPools.length];
    readIndex = (readIndex + 1) % replicaPools.length;
    return pool;
  }

  return {
    getPool(intent: 'read' | 'write'): PoolInstance {
      return selectPool(intent);
    },

    async queryWithSession(
      sql: string,
      params: unknown[],
      session: SessionVariables,
      intent: 'read' | 'write',
    ): Promise<{ rows: unknown[]; rowCount: number }> {
      const pool = selectPool(intent, session.userId);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Inject session variables so SQL functions can access them via current_setting()
        // Use set_config() instead of SET LOCAL because SET doesn't support parameterized queries
        const sessionJson = JSON.stringify(session.claims);
        await client.query(`SELECT set_config('hasura.user', $1, true)`, [sessionJson]);
        if (session.userId) {
          await client.query(`SELECT set_config('${schemaName}.user_id', $1, true)`, [session.userId]);
        }
        await client.query(`SELECT set_config('${schemaName}.role', $1, true)`, [session.role]);

        const result = stmtManager
          ? await client.query(stmtManager.prepare(sql, params))
          : await client.query(sql, params);
        await client.query('COMMIT');

        // Read-your-writes: after a successful write, mark the user so
        // subsequent reads within the window go to primary
        if (intent === 'write' && session.userId && consistencyTracker) {
          consistencyTracker.markMutation(session.userId);
        }

        return { rows: result.rows as unknown[], rowCount: result.rowCount ?? 0 };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {
          // Ignore rollback errors
        });
        throw err;
      } finally {
        client.release();
      }
    },

    async transactionalQueryWithSession(
      queries: Array<{ sql: string; params: unknown[] }>,
      session: SessionVariables,
    ): Promise<Array<{ rows: unknown[]; rowCount: number }>> {
      const pool = selectPool('write', session.userId);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const sessionJson = JSON.stringify(session.claims);
        await client.query(`SELECT set_config('hasura.user', $1, true)`, [sessionJson]);
        if (session.userId) {
          await client.query(`SELECT set_config('${schemaName}.user_id', $1, true)`, [session.userId]);
        }
        await client.query(`SELECT set_config('${schemaName}.role', $1, true)`, [session.role]);

        const results: Array<{ rows: unknown[]; rowCount: number }> = [];
        for (const q of queries) {
          const result = stmtManager
            ? await client.query(stmtManager.prepare(q.sql, q.params))
            : await client.query(q.sql, q.params);
          results.push({ rows: result.rows as unknown[], rowCount: result.rowCount ?? 0 });
        }

        await client.query('COMMIT');

        if (session.userId && consistencyTracker) {
          consistencyTracker.markMutation(session.userId);
        }

        return results;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },

    async healthCheck(): Promise<boolean> {
      try {
        const checks = allPools.map(async (pool) => {
          const client = await pool.connect();
          try {
            await client.query('SELECT 1');
          } finally {
            client.release();
          }
        });
        await Promise.all(checks);
        return true;
      } catch {
        return false;
      }
    },

    async shutdown(): Promise<void> {
      consistencyTracker?.destroy();
      const endPromises = allPools.map((pool) => pool.end());
      await Promise.all(endPromises);
    },

    getSessionConnectionString(): string {
      return sessionConnectionString;
    },
  };
}
