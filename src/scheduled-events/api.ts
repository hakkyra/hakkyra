/**
 * Hasura-compatible metadata RPC for one-off scheduled events.
 *
 * POST /v1/metadata with { type, args } — admin only. Supported commands:
 *   - create_scheduled_event            → { message: 'success', event_id }
 *   - delete_scheduled_event            → { message: 'success' }
 *   - get_scheduled_event_invocations   → { invocations: [...] }
 *
 * Hakkyra intentionally has no metadata-apply API (metadata is read from
 * YAML at startup); only the scheduled-event commands are served here, and
 * any other type returns a Hasura-style parse-failed error.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import { quoteIdentifier as quoteIdent } from '../sql/utils.js';
import type { ScheduledEventHeader, ScheduledEventRetryConf } from './delivery.js';

export interface ScheduledEventApiDeps {
  pool: Pool;
  schemaName?: string;
}

interface MetadataRpcBody {
  type?: string;
  args?: Record<string, unknown>;
}

interface CreateScheduledEventArgs {
  webhook?: string;
  schedule_at?: string;
  payload?: unknown;
  headers?: ScheduledEventHeader[];
  retry_conf?: ScheduledEventRetryConf;
  comment?: string;
}

export function registerScheduledEventRoutes(
  fastify: FastifyInstance,
  deps: ScheduledEventApiDeps,
): void {
  const schemaName = deps.schemaName ?? 'hakkyra';
  const { pool } = deps;

  fastify.post('/v1/metadata', async (request: FastifyRequest, reply: FastifyReply) => {
    // Hasura's metadata API is admin-only
    if (!request.session?.isAdmin) {
      void reply.code(403).send({
        error: 'restricted access : admin only',
        path: '$',
        code: 'access-denied',
      });
      return;
    }

    const body = (request.body ?? {}) as MetadataRpcBody;
    const args = (body.args ?? {}) as Record<string, unknown>;

    switch (body.type) {
      case 'create_scheduled_event': {
        const { webhook, schedule_at, payload, headers, retry_conf, comment } =
          args as CreateScheduledEventArgs;

        if (!webhook || !schedule_at) {
          void reply.code(400).send({
            error: 'the key "webhook" and "schedule_at" are required',
            path: '$.args',
            code: 'parse-failed',
          });
          return;
        }
        const scheduledTime = new Date(schedule_at);
        if (Number.isNaN(scheduledTime.getTime())) {
          void reply.code(400).send({
            error: `could not parse "${schedule_at}" as a timestamp`,
            path: '$.args.schedule_at',
            code: 'parse-failed',
          });
          return;
        }

        const result = await pool.query<{ id: string }>(
          `INSERT INTO ${quoteIdent(schemaName)}.scheduled_events
             (webhook_conf, scheduled_time, payload, header_conf, retry_conf, comment)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id`,
          [
            webhook,
            scheduledTime.toISOString(),
            payload !== undefined ? JSON.stringify(payload) : null,
            headers !== undefined ? JSON.stringify(headers) : null,
            retry_conf !== undefined ? JSON.stringify(retry_conf) : null,
            comment ?? null,
          ],
        );

        void reply.code(200).send({ message: 'success', event_id: result.rows[0].id });
        return;
      }

      case 'delete_scheduled_event': {
        const eventId = args.event_id as string | undefined;
        if (!eventId) {
          void reply.code(400).send({
            error: 'the key "event_id" is required',
            path: '$.args',
            code: 'parse-failed',
          });
          return;
        }
        const result = await pool.query(
          `DELETE FROM ${quoteIdent(schemaName)}.scheduled_events WHERE id = $1`,
          [eventId],
        );
        if (result.rowCount === 0) {
          void reply.code(400).send({
            error: `scheduled event with id "${eventId}" not found`,
            path: '$.args.event_id',
            code: 'not-found',
          });
          return;
        }
        void reply.code(200).send({ message: 'success' });
        return;
      }

      case 'get_scheduled_event_invocations': {
        const eventId = args.event_id as string | undefined;
        const result = eventId
          ? await pool.query(
              `SELECT id, event_id, status, request, response, created_at
               FROM ${quoteIdent(schemaName)}.scheduled_event_invocations
               WHERE event_id = $1 ORDER BY created_at DESC`,
              [eventId],
            )
          : await pool.query(
              `SELECT id, event_id, status, request, response, created_at
               FROM ${quoteIdent(schemaName)}.scheduled_event_invocations
               ORDER BY created_at DESC LIMIT 100`,
            );
        void reply.code(200).send({ invocations: result.rows });
        return;
      }

      default: {
        void reply.code(400).send({
          error: `unknown metadata command "${body.type ?? ''}"`,
          path: '$',
          code: 'parse-failed',
        });
      }
    }
  });
}
