/**
 * Event trigger webhook delivery.
 *
 * Listens for new events via pg-listen NOTIFY, fetches pending events
 * from the event_log table, and delivers them via webhook with retry.
 */

import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { TableInfo } from '../types.js';
import type { JobQueue } from '../shared/job-queue/types.js';
import {
  resolveWebhookUrl,
  resolveWebhookHeaders,
} from '../shared/webhook.js';
import { registerWebhookWorker } from '../shared/webhook-worker.js';
import { quoteIdentifier as quoteIdent } from '../sql/utils.js';
import { buildTriggerLookup } from './shared.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface EventLogRow {
  id: string;
  trigger_name: string;
  table_schema: string;
  table_name: string;
  operation: string;
  old_data: unknown;
  new_data: unknown;
  session_vars: Record<string, string> | null;
  created_at: string;
}

// ─── Hasura-compatible payload ─────────────────────────────────────────────

/**
 * Build a Hasura-compatible event trigger webhook payload.
 */
export function buildEventPayload(event: EventLogRow): unknown {
  return {
    id: event.id,
    event: {
      session_variables: event.session_vars ?? {},
      op: event.operation,
      data: {
        old: event.old_data ?? null,
        new: event.new_data ?? null,
      },
    },
    table: {
      schema: event.table_schema,
      name: event.table_name,
    },
    trigger: {
      name: event.trigger_name,
    },
    created_at: event.created_at,
  };
}

// ─── Event delivery via pg-boss ────────────────────────────────────────────

/**
 * Fetch and enqueue pending events from the event_log table into pg-boss.
 *
 * Called on startup (catchup) and when a NOTIFY is received.
 */
export async function enqueuePendingEvents(
  pool: Pool,
  jobQueue: JobQueue,
  logger: Logger,
  batchSize: number = 100,
  schemaName: string = 'hakkyra',
): Promise<number> {
  // Atomically claim pending events using FOR UPDATE SKIP LOCKED to prevent
  // deadlocks when multiple NOTIFY signals trigger concurrent fetches.
  const result = await pool.query<EventLogRow>(
    `WITH claimed AS (
       SELECT id FROM ${quoteIdent(schemaName)}.event_log
       WHERE status = 'pending' AND next_retry <= now()
       ORDER BY created_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE ${quoteIdent(schemaName)}.event_log e
     SET status = 'processing'
     FROM claimed c
     WHERE e.id = c.id
     RETURNING e.id, e.trigger_name, e.table_schema, e.table_name, e.operation,
               e.old_data, e.new_data, e.session_vars, e.created_at`,
    [batchSize],
  );

  if (result.rows.length === 0) return 0;

  // Enqueue each event into pg-boss
  for (const event of result.rows) {
    await jobQueue.send(`event/${event.trigger_name}`, {
      eventId: event.id,
      payload: buildEventPayload(event),
    });
  }

  logger.debug({ count: result.rows.length }, 'Enqueued pending events');
  return result.rows.length;
}

/**
 * Register pg-boss workers for all event triggers.
 *
 * Each worker delivers the webhook and updates the event_log status.
 */
export async function registerEventWorkers(
  jobQueue: JobQueue,
  pool: Pool,
  tables: TableInfo[],
  logger: Logger,
  schemaName: string = 'hakkyra',
  defaultConcurrency: number = 1,
): Promise<void> {
  const triggerLookup = buildTriggerLookup(tables);

  for (const [triggerName, { trigger }] of triggerLookup) {
    const queueName = `event/${triggerName}`;
    const concurrency = trigger.concurrency ?? defaultConcurrency;

    await registerWebhookWorker<{ eventId: string; payload: unknown }>(
      jobQueue,
      logger,
      {
        queueName,
        label: `event/${triggerName}`,
        queueOptions: {
          retryLimit: trigger.retryConf.numRetries,
          retryDelay: trigger.retryConf.intervalSec,
          retryBackoff: true,
          expireInSeconds: trigger.retryConf.timeoutSec,
        },
        workOptions: { concurrency },
        callbacks: {
          resolveWebhook(job) {
            const { payload } = job.data;
            return {
              url: resolveWebhookUrl(trigger.webhook, trigger.webhookFromEnv),
              headers: resolveWebhookHeaders(trigger.headers),
              payload,
              timeoutMs: trigger.retryConf.timeoutSec * 1000,
            };
          },

          async onSuccess(job, result) {
            const { eventId } = job.data;
            await pool.query(
              `UPDATE ${quoteIdent(schemaName)}.event_log SET status = 'delivered', delivered = true, delivered_at = now(),
               response_status = $2 WHERE id = $1`,
              [eventId, result.statusCode],
            );
          },

          async onFailure(job, result) {
            const { eventId } = job.data;
            await pool.query(
              `UPDATE ${quoteIdent(schemaName)}.event_log SET
               retry_count = retry_count + 1,
               last_error = $2,
               response_status = $3,
               status = CASE WHEN retry_count + 1 >= $4 THEN 'failed' ELSE 'pending' END,
               next_retry = now() + interval '1 second' * $5
               WHERE id = $1`,
              [
                eventId,
                result.error ?? `HTTP ${result.statusCode}`,
                result.statusCode,
                trigger.retryConf.numRetries,
                trigger.retryConf.intervalSec * Math.pow(2, 0), // backoff handled by pg-boss
              ],
            );
          },
        },
      },
    );
  }
}
