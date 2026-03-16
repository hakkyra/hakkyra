/**
 * Async action REST endpoint.
 *
 * Provides a GET /v1/actions/:actionId/status endpoint that returns
 * the current status and result of an async action.
 *
 * Authorization is role-based: the requesting user must have at least one
 * allowedRole that appears in the action's permissions list, or be admin.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import type { ActionConfig } from '../types.js';
import { getAsyncActionResult } from './async.js';
import { checkActionPermission } from './permissions.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface AsyncActionStatusDeps {
  pool: Pool;
  actions: ActionConfig[];
}

// ─── Route registration ────────────────────────────────────────────────────

/**
 * Register the async action status endpoint.
 *
 * GET /v1/actions/:actionId/status
 *
 * Returns the current status, output, and errors for an async action.
 * Authorization: admin bypasses checks; non-admin users must have a role
 * that is permitted on the action (checked via the action's permissions list).
 */
export function registerAsyncActionStatusRoute(
  fastify: FastifyInstance,
  deps: AsyncActionStatusDeps,
): void {
  // Build a lookup map from action name → ActionConfig
  const actionMap = new Map<string, ActionConfig>();
  for (const action of deps.actions) {
    actionMap.set(action.name, action);
  }

  fastify.get(
    '/v1/actions/:actionId/status',
    async (request: FastifyRequest, reply: FastifyReply) => {
      // ── 1. Authentication check ───────────────────────────────────────
      const session = request.session;
      if (!session) {
        void reply.code(401).send({
          error: 'unauthorized',
          message: 'Authentication required',
        });
        return;
      }

      // ── 2. Extract action ID ──────────────────────────────────────────
      const { actionId } = request.params as { actionId: string };

      if (!actionId) {
        void reply.code(400).send({
          error: 'bad_request',
          message: 'Action ID is required',
        });
        return;
      }

      // ── 3. Query action status ────────────────────────────────────────
      try {
        const result = await getAsyncActionResult(deps.pool, actionId);

        if (!result) {
          void reply.code(404).send({
            error: 'not_found',
            message: `Async action "${actionId}" not found`,
          });
          return;
        }

        // ── 4. Authorization: check role-based permission ─────────────
        const actionConfig = actionMap.get(result.actionName);
        if (!actionConfig) {
          // Action config no longer exists (removed from metadata).
          // Admin can still see it; non-admin gets 404 to avoid leaking info.
          if (!session.isAdmin) {
            void reply.code(404).send({
              error: 'not_found',
              message: `Async action "${actionId}" not found`,
            });
            return;
          }
        } else if (!checkActionPermission(actionConfig, session)) {
          void reply.code(403).send({
            error: 'forbidden',
            message: 'Not authorized to view this action status',
          });
          return;
        }

        void reply.code(200).send({
          id: result.id,
          action_name: result.actionName,
          status: result.status,
          output: result.output ?? null,
          errors: result.errors ?? null,
          created_at: result.createdAt,
          updated_at: result.updatedAt,
        });
      } catch (err) {
        request.log.error({ err, actionId }, 'Failed to query async action status');
        void reply.code(500).send({
          error: 'internal_error',
          message: 'Failed to query action status',
        });
      }
    },
  );
}
