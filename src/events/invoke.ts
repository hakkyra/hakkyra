/**
 * Manual event trigger invocation API.
 *
 * Provides a POST /v1/events/invoke/:trigger endpoint that allows admins
 * to manually fire event triggers, inserting a row into hakkyra.event_log
 * and enqueuing it for delivery via pg-boss.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import type { TableInfo, EventTriggerConfig } from '../types.js';
import type { JobQueue } from '../shared/job-queue/types.js';
import { buildEventPayload } from './delivery.js';
import type { EventLogRow } from './delivery.js';

// ─── Types ─────────────────────────────────────────────────────────────────

interface InvokeRequestBody {
  payload: {
    old?: Record<string, unknown> | null;
    new?: Record<string, unknown> | null;
  };
}

interface TriggerMatch {
  trigger: EventTriggerConfig;
  table: TableInfo;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Build a lookup map from trigger name to its config and parent table.
 */
function buildTriggerLookup(tables: TableInfo[]): Map<string, TriggerMatch> {
  const lookup = new Map<string, TriggerMatch>();
  for (const table of tables) {
    for (const trigger of table.eventTriggers) {
      lookup.set(trigger.name, { trigger, table });
    }
  }
  return lookup;
}

/**
 * Validate the request body for manual event invocation.
 * Returns an error message if invalid, or null if valid.
 */
function validateBody(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return 'Request body must be a JSON object';
  }

  const b = body as Record<string, unknown>;
  if (!('payload' in b) || !b.payload || typeof b.payload !== 'object' || Array.isArray(b.payload)) {
    return 'Request body must contain a "payload" object';
  }

  const payload = b.payload as Record<string, unknown>;

  // Validate old/new if present
  if ('old' in payload && payload.old !== null && (typeof payload.old !== 'object' || Array.isArray(payload.old))) {
    return '"payload.old" must be an object or null';
  }
  if ('new' in payload && payload.new !== null && (typeof payload.new !== 'object' || Array.isArray(payload.new))) {
    return '"payload.new" must be an object or null';
  }

  return null;
}

// ─── Route registration ────────────────────────────────────────────────────

export interface InvokeRouteDeps {
  pool: Pool;
  jobQueue: JobQueue | undefined;
  tables: TableInfo[];
}

/**
 * Register the manual event invocation route.
 *
 * POST /v1/events/invoke/:trigger
 *
 * Requires admin authentication. Inserts a MANUAL event into hakkyra.event_log
 * and enqueues it for delivery via pg-boss.
 */
export function registerInvokeRoute(
  fastify: FastifyInstance,
  deps: InvokeRouteDeps,
): void {
  const triggerLookup = buildTriggerLookup(deps.tables);

  fastify.post(
    '/v1/events/invoke/:trigger',
    async (request: FastifyRequest, reply: FastifyReply) => {
      // ── 1. Admin authentication check ──────────────────────────────────
      const session = request.session;
      if (!session?.isAdmin) {
        void reply.code(401).send({
          error: 'unauthorized',
          message: 'Admin authentication required',
        });
        return;
      }

      // ── 2. Check event system availability ─────────────────────────────
      if (!deps.jobQueue) {
        void reply.code(503).send({
          error: 'service_unavailable',
          message: 'Event system is not available',
        });
        return;
      }

      // ── 3. Look up trigger ─────────────────────────────────────────────
      const { trigger: triggerName } = request.params as { trigger: string };
      const match = triggerLookup.get(triggerName);

      if (!match) {
        void reply.code(404).send({
          error: 'not_found',
          message: `Event trigger "${triggerName}" not found`,
        });
        return;
      }

      const { trigger, table } = match;

      // ── 4. Check enableManual ──────────────────────────────────────────
      if (trigger.definition.enableManual === false) {
        void reply.code(400).send({
          error: 'bad_request',
          message: `Event trigger "${triggerName}" does not allow manual invocation`,
        });
        return;
      }

      // ── 5. Validate request body ───────────────────────────────────────
      const bodyError = validateBody(request.body);
      if (bodyError) {
        void reply.code(400).send({
          error: 'bad_request',
          message: bodyError,
        });
        return;
      }

      const { payload } = request.body as InvokeRequestBody;

      // ── 6. Insert into hakkyra.event_log ───────────────────────────────
      try {
        const result = await deps.pool.query<{ id: string; created_at: string }>(
          `INSERT INTO hakkyra.event_log
           (trigger_name, table_schema, table_name, operation, old_data, new_data, session_vars)
           VALUES ($1, $2, $3, 'MANUAL', $4, $5, $6)
           RETURNING id, created_at`,
          [
            triggerName,
            table.schema,
            table.name,
            payload.old ?? null,
            payload.new ?? null,
            session.claims ? JSON.stringify(session.claims) : null,
          ],
        );

        const row = result.rows[0];
        const eventId = row.id;

        // ── 7. Build payload and enqueue to pg-boss ──────────────────────
        const eventLogRow: EventLogRow = {
          id: eventId,
          trigger_name: triggerName,
          table_schema: table.schema,
          table_name: table.name,
          operation: 'MANUAL',
          old_data: payload.old ?? null,
          new_data: payload.new ?? null,
          session_vars: session.claims as Record<string, string> | null,
          created_at: row.created_at,
        };

        const eventPayload = buildEventPayload(eventLogRow);

        await deps.jobQueue.send(`event/${triggerName}`, {
          eventId,
          payload: eventPayload,
        });

        // Mark as processing since it's been enqueued
        await deps.pool.query(
          `UPDATE hakkyra.event_log SET status = 'processing' WHERE id = $1`,
          [eventId],
        );

        void reply.code(200).send({
          event_id: eventId,
          message: `Event for trigger "${triggerName}" has been created and enqueued for delivery`,
        });
      } catch (err) {
        request.log.error({ err, trigger: triggerName }, 'Failed to invoke event trigger');
        void reply.code(500).send({
          error: 'internal_error',
          message: 'Failed to create and enqueue event',
        });
      }
    },
  );
}
