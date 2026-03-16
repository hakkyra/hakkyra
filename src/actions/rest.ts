/**
 * Async action REST endpoint.
 *
 * Provides a GET /v1/actions/:actionId/status endpoint that returns
 * the current status and result of an async action.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import { getAsyncActionResult } from './async.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface AsyncActionStatusDeps {
  pool: Pool;
}

// ─── Route registration ────────────────────────────────────────────────────

/**
 * Register the async action status endpoint.
 *
 * GET /v1/actions/:actionId/status
 *
 * Returns the current status, output, and errors for an async action.
 * Requires authentication (any authenticated user can query).
 */
export function registerAsyncActionStatusRoute(
  fastify: FastifyInstance,
  deps: AsyncActionStatusDeps,
): void {
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

      // ── 3. Query action status (with authorization) ──────────────────
      try {
        const result = await getAsyncActionResult(deps.pool, actionId, session);

        if (!result) {
          void reply.code(404).send({
            error: 'not_found',
            message: `Async action "${actionId}" not found`,
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
