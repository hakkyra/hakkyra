/**
 * Shared session variable resolution.
 *
 * Resolves x-hasura-* session variable references from SessionVariables.
 * Used by the SQL WHERE compiler, INSERT/UPDATE preset handling, and the
 * permission filter compiler to avoid duplicated claim lookup logic.
 */

import type { SessionVariables } from '../types.js';

/**
 * Resolve a value that may be a session variable reference (x-hasura-*).
 *
 * Resolution order for x-hasura-* keys:
 * 1. Well-known variables: x-hasura-role, x-hasura-user-id, x-hasura-allowed-roles
 * 2. Claims map lookup: first by exact suffix match, then case-insensitive
 *
 * Non-session-variable values are returned as-is.
 *
 * @param value   - The value to resolve (only strings starting with x-hasura- are resolved)
 * @param session - Session variables to resolve against
 * @returns The resolved value, or undefined if the session variable is not found
 */
export function resolveSessionValue(value: unknown, session?: SessionVariables): unknown {
  if (typeof value !== 'string') return value;

  const lower = value.toLowerCase();
  if (!lower.startsWith('x-hasura-')) return value;

  // Well-known session variables
  if (lower === 'x-hasura-role') return session?.role;
  if (lower === 'x-hasura-user-id') return session?.userId;
  if (lower === 'x-hasura-allowed-roles') return session?.allowedRoles;

  // Look up in claims map (try exact suffix match first, then case-insensitive)
  const claimKey = lower.slice('x-hasura-'.length);
  if (session?.claims) {
    // Try the full lowercase key (e.g. "x-hasura-org-id") — used by permission compiler
    if (lower in session.claims) return session.claims[lower];

    // Try the suffix key (e.g. "org-id")
    if (claimKey in session.claims) return session.claims[claimKey];

    // Fall back to case-insensitive search on suffix
    for (const [k, v] of Object.entries(session.claims)) {
      if (k.toLowerCase() === claimKey) return v;
    }
  }

  return undefined;
}
