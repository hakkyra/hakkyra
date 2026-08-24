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
 * - An allowed role that is an inherited role also grants the actions permitted
 *   to any of its constituent roles (Hasura-compatible).
 */
export function checkActionPermission(
  action: ActionConfig,
  session: SessionVariables,
  inheritedRoles?: Record<string, string[]>,
): boolean {
  if (session.isAdmin) return true;
  if (!action.permissions || action.permissions.length === 0) return false;
  const roles = new Set(session.allowedRoles);
  if (inheritedRoles) {
    for (const role of session.allowedRoles) {
      for (const constituent of inheritedRoles[role] ?? []) roles.add(constituent);
    }
  }
  return action.permissions.some((p) => roles.has(p.role));
}
