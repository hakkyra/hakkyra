/**
 * Action permission checking.
 *
 * Verifies that the session is allowed to execute an action
 * based on the action's permission configuration.
 */

import type { ActionConfig, SessionVariables } from '../types.js';

/**
 * Check if the active session is permitted to execute the given action.
 *
 * - Admin users always have access.
 * - If the action has no permissions defined, only admin can access (Hasura-compatible).
 * - Otherwise, any of the session's allowed roles must appear in the action's permissions list.
 */
export function checkActionPermission(action: ActionConfig, session: SessionVariables): boolean {
  if (session.isAdmin) return true;
  if (!action.permissions || action.permissions.length === 0) return false;
  return action.permissions.some((p) => session.allowedRoles.includes(p.role));
}
