/**
 * Event trigger webhook delivery.
 *
 * Listens for new events via pg-listen NOTIFY, fetches pending events
 * from the event_log table, and delivers them via webhook with retry.
 */

import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { TableInfo, EventTriggerConfig } from '../types.js';
import type { JobQueue, Job } from '../shared/job-queue/types.js';
import {
  deliverWebhook,
  resolveWebhookUrl,
  resolveWebhookHeaders,
} from '../shared/webhook.js';

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
 * Build a trigger config lookup from all tables.
 */
function buildTriggerLookup(tables: TableInfo[]): Map<string, { trigger: EventTriggerConfig; table: TableInfo }> {
  const lookup = new Map<string, { trigger: EventTriggerConfig; table: TableInfo }>();
  for (const table of tables) {
    for (const trigger of table.eventTriggers) {
      lookup.set(trigger.name, { trigger, table });
    }
  }
  return lookup;
}

/**
 * Double-quote a SQL identifier to prevent injection.
 */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

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

    // Configure the queue with retry settings
    await jobQueue.createQueue(queueName, {
      retryLimit: trigger.retryConf.numRetries,
      retryDelay: trigger.retryConf.intervalSec,
      retryBackoff: true,
      expireInSeconds: trigger.retryConf.timeoutSec,
    });

    await jobQueue.work<{ eventId: string; payload: unknown }>(queueName, async (jobs: Job<{ eventId: string; payload: unknown }>[]) => {
      for (const job of jobs) {
      const { eventId, payload } = job.data;

      const url = resolveWebhookUrl(trigger.webhook, trigger.webhookFromEnv);
      const headers = resolveWebhookHeaders(trigger.headers);

      logger.info(
        { trigger: triggerName, eventId, url, jobId: job.id },
        'Delivering event trigger webhook',
      );

      const result = await deliverWebhook({
        url,
        headers,
        payload,
        timeoutMs: trigger.retryConf.timeoutSec * 1000,
      });

      if (result.success) {
        // Mark as delivered
        await pool.query(
          `UPDATE ${quoteIdent(schemaName)}.event_log SET status = 'delivered', delivered_at = now(),
           response_status = $2 WHERE id = $1`,
          [eventId, result.statusCode],
        );

        logger.info(
          { trigger: triggerName, eventId, statusCode: result.statusCode, durationMs: result.durationMs },
          'Event webhook delivered',
        );
      } else {
        // Update error info
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

        logger.warn(
          { trigger: triggerName, eventId, statusCode: result.statusCode, error: result.error },
          'Event webhook delivery failed',
        );

        // Throw so pg-boss knows the job failed
        throw new Error(`Webhook delivery failed: ${result.error ?? `HTTP ${result.statusCode}`}`);
      }
      }
    }, { concurrency });
  }
}
