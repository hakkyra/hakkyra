/**
 * Read-your-writes consistency tracker.
 *
 * After a mutation, tracks the user ID so that subsequent read queries
 * within a configurable time window are routed to the primary database
 * instead of read replicas. This ensures users see their own writes
 * immediately.
 *
 * Uses an in-memory Map — suitable for single-instance deployments.
 */

export interface ConsistencyTracker {
  /** Record that a user just performed a mutation. */
  markMutation(userId: string): void;

  /** Check whether a user's reads should be routed to primary. */
  shouldReadFromPrimary(userId: string): boolean;

  /** Remove all expired entries. */
  cleanup(): void;

  /** Stop the periodic cleanup timer. */
  destroy(): void;
}

/**
 * Create a consistency tracker with the given time window.
 *
 * @param windowMs - Duration in milliseconds after a mutation during which
 *   reads for that user are routed to primary. Default: 5000 (5 seconds).
 * @param cleanupIntervalMs - How often to sweep expired entries. Default: 60000 (60 seconds).
 */
export function createConsistencyTracker(
  windowMs: number = 5000,
  cleanupIntervalMs: number = 60000,
): ConsistencyTracker {
  // Map from userId to expiry timestamp (epoch ms)
  const mutations = new Map<string, number>();

  const cleanupTimer = setInterval(() => {
    cleanup();
  }, cleanupIntervalMs);

  // Allow the timer to not prevent process exit
  if (cleanupTimer.unref) {
    cleanupTimer.unref();
  }

  function markMutation(userId: string): void {
    mutations.set(userId, Date.now() + windowMs);
  }

  function shouldReadFromPrimary(userId: string): boolean {
    const expiry = mutations.get(userId);
    if (expiry === undefined) return false;
    if (Date.now() > expiry) {
      mutations.delete(userId);
      return false;
    }
    return true;
  }

  function cleanup(): void {
    const now = Date.now();
    for (const [userId, expiry] of mutations) {
      if (now > expiry) {
        mutations.delete(userId);
      }
    }
  }

  function destroy(): void {
    clearInterval(cleanupTimer);
    mutations.clear();
  }

  return {
    markMutation,
    shouldReadFromPrimary,
    cleanup,
    destroy,
  };
}
