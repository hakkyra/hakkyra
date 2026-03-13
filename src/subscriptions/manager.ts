/**
 * Subscription manager.
 *
 * Tracks active GraphQL subscriptions, receives change notifications,
 * re-queries affected subscriptions, and pushes updates when results change.
 *
 * Uses a hash-diff approach: after re-querying, the result is hashed and
 * compared with the last sent hash. Only pushes if the result has changed.
 */

import { createHash } from 'crypto';
import type { Logger } from 'pino';
import type { ConnectionManager } from '../connections/manager.js';
import type { SessionVariables, CompiledQuery } from '../types.js';
import type { ChangeNotification } from './listener.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface SubscriptionEntry {
  id: string;
  /** The table this subscription queries */
  tableKey: string; // "schema.table"
  /** Compiled SQL query to re-execute */
  query: CompiledQuery;
  /** Session variables for query execution */
  session: SessionVariables;
  /** Hash of the last result sent to the client */
  lastHash: string;
  /** Callback to push new data to the client */
  push: (data: unknown) => void;
}

export interface SubscriptionManager {
  /**
   * Register a new subscription and execute the initial query.
   * Returns the initial data.
   */
  register(entry: Omit<SubscriptionEntry, 'lastHash'>): Promise<unknown>;

  /**
   * Unregister a subscription by ID.
   */
  unregister(id: string): void;

  /**
   * Handle a change notification from pg-listen.
   * Re-queries all subscriptions that involve the changed table.
   */
  handleChange(notification: ChangeNotification): Promise<void>;

  /** Number of active subscriptions. */
  activeCount(): number;
}

// ─── Hash utility ──────────────────────────────────────────────────────────

function hashResult(data: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(data))
    .digest('hex');
}

// ─── Factory ───────────────────────────────────────────────────────────────

/**
 * Create a subscription manager.
 */
export function createSubscriptionManager(
  connectionManager: ConnectionManager,
  logger: Logger,
): SubscriptionManager {
  /** All active subscriptions by ID */
  const subscriptions = new Map<string, SubscriptionEntry>();

  /** Index: tableKey → Set of subscription IDs for fast lookup */
  const tableIndex = new Map<string, Set<string>>();

  /** Debounce timers per table to batch rapid changes */
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const DEBOUNCE_MS = 50;

  function addToTableIndex(tableKey: string, subId: string): void {
    let set = tableIndex.get(tableKey);
    if (!set) {
      set = new Set();
      tableIndex.set(tableKey, set);
    }
    set.add(subId);
  }

  function removeFromTableIndex(tableKey: string, subId: string): void {
    const set = tableIndex.get(tableKey);
    if (set) {
      set.delete(subId);
      if (set.size === 0) {
        tableIndex.delete(tableKey);
      }
    }
  }

  async function executeQuery(entry: SubscriptionEntry): Promise<unknown> {
    const result = await connectionManager.queryWithSession(
      entry.query.sql,
      entry.query.params,
      entry.session,
      'read',
    );
    // Return the raw row data — the resolver will format it
    const data = (result.rows[0] as Record<string, unknown> | undefined)?.data;
    return data ?? [];
  }

  async function reQueryTable(tableKey: string): Promise<void> {
    const subIds = tableIndex.get(tableKey);
    if (!subIds || subIds.size === 0) return;

    const promises: Promise<void>[] = [];

    for (const subId of subIds) {
      const entry = subscriptions.get(subId);
      if (!entry) continue;

      promises.push(
        (async () => {
          try {
            const data = await executeQuery(entry);
            const newHash = hashResult(data);

            if (newHash !== entry.lastHash) {
              entry.lastHash = newHash;
              entry.push(data);
            }
          } catch (err) {
            logger.error(
              { err, subscriptionId: subId, tableKey },
              'Error re-querying subscription',
            );
          }
        })(),
      );
    }

    await Promise.all(promises);
  }

  return {
    async register(entry): Promise<unknown> {
      // Execute initial query
      const data = await executeQuery(entry as SubscriptionEntry);
      const hash = hashResult(data);

      const fullEntry: SubscriptionEntry = {
        ...entry,
        lastHash: hash,
      };

      subscriptions.set(entry.id, fullEntry);
      addToTableIndex(entry.tableKey, entry.id);

      logger.debug(
        { subscriptionId: entry.id, tableKey: entry.tableKey },
        'Subscription registered',
      );

      return data;
    },

    unregister(id): void {
      const entry = subscriptions.get(id);
      if (entry) {
        removeFromTableIndex(entry.tableKey, id);
        subscriptions.delete(id);
        logger.debug({ subscriptionId: id }, 'Subscription unregistered');
      }
    },

    async handleChange(notification): Promise<void> {
      const tableKey = `${notification.schema}.${notification.table}`;
      const subIds = tableIndex.get(tableKey);
      if (!subIds || subIds.size === 0) return;

      // Debounce: if multiple changes to the same table arrive within
      // DEBOUNCE_MS, batch them into a single re-query round
      const existing = debounceTimers.get(tableKey);
      if (existing) {
        clearTimeout(existing);
      }

      debounceTimers.set(
        tableKey,
        setTimeout(() => {
          debounceTimers.delete(tableKey);
          reQueryTable(tableKey).catch((err) => {
            logger.error({ err, tableKey }, 'Error in debounced re-query');
          });
        }, DEBOUNCE_MS),
      );
    },

    activeCount(): number {
      return subscriptions.size;
    },
  };
}
