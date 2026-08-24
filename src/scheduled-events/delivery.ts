/**
 * One-off scheduled event delivery.
 *
 * A poller claims due events (FOR UPDATE SKIP LOCKED → status 'locked'),
 * delivers the webhook, records every attempt in scheduled_event_invocations,
 * and updates status per the event's retry_conf — matching Hasura's
 * scheduled / locked / delivered / error lifecycle. Stale locks (crashed
 * instances) are reclaimed after 5 minutes.
 */

import type { Pool } from 'pg';
import type { Logger } from 'pino';
import {
  deliverWebhook,
  resolveWebhookUrl,
  resolveWebhookHeaders,
} from '../shared/webhook.js';
import type { WebhookHeader } from '../types.js';
import { quoteIdentifier as quoteIdent } from '../sql/utils.js';

// ─── Types ─────────────────────────────────────────────────────────────────

/** Hasura retry_conf keys. */
export interface ScheduledEventRetryConf {
  num_retries?: number;
  retry_interval_seconds?: number;
  timeout_seconds?: number;
}

/** Hasura header_conf entry: { name, value } or { name, value_from_env }. */
export interface ScheduledEventHeader {
  name: string;
  value?: string;
  value_from_env?: string;
}

export interface ScheduledEventRow {
  id: string;
  webhook_conf: string;
  scheduled_time: string;
  retry_conf: ScheduledEventRetryConf | null;
  payload: unknown;
  header_conf: ScheduledEventHeader[] | null;
  status: string;
  tries: number;
  created_at: string;
  comment: string | null;
}

const DEFAULT_RETRY_CONF: Required<ScheduledEventRetryConf> = {
  num_retries: 0,
  retry_interval_seconds: 10,
  timeout_seconds: 60,
};

/** Reclaim events stuck in 'locked' after this long (crashed instance). */
const STALE_LOCK_SECONDS = 300;

// ─── Claim ─────────────────────────────────────────────────────────────────

/**
 * Atomically claim due scheduled events (status → 'locked').
 */
export async function claimDueScheduledEvents(
  pool: Pool,
  schemaName: string,
  batchSize: number,
): Promise<ScheduledEventRow[]> {
  const result = await pool.query<ScheduledEventRow>(
    `WITH due AS (
       SELECT id FROM ${quoteIdent(schemaName)}.scheduled_events
       WHERE (status = 'scheduled' AND scheduled_time <= now()
              AND (next_retry_at IS NULL OR next_retry_at <= now()))
          OR (status = 'locked' AND locked_at < now() - interval '${STALE_LOCK_SECONDS} seconds')
       ORDER BY scheduled_time ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE ${quoteIdent(schemaName)}.scheduled_events e
     SET status = 'locked', locked_at = now()
     FROM due WHERE e.id = due.id
     RETURNING e.id, e.webhook_conf, e.scheduled_time, e.retry_conf, e.payload,
               e.header_conf, e.status, e.tries, e.created_at, e.comment`,
    [batchSize],
  );
  return result.rows;
}

// ─── Delivery ──────────────────────────────────────────────────────────────

/**
 * Build the webhook payload for a scheduled event (Hasura-compatible shape).
 */
export function buildScheduledEventPayload(event: ScheduledEventRow): unknown {
  return {
    id: event.id,
    scheduled_time: event.scheduled_time,
    created_at: event.created_at,
    payload: event.payload ?? null,
    comment: event.comment ?? null,
  };
}

/**
 * Deliver one claimed scheduled event: POST the webhook, record the
 * invocation, and update the event's status per its retry_conf.
 */
export async function deliverScheduledEvent(
  pool: Pool,
  schemaName: string,
  event: ScheduledEventRow,
  logger: Logger,
): Promise<void> {
  const retryConf = { ...DEFAULT_RETRY_CONF, ...(event.retry_conf ?? {}) };

  const headers: WebhookHeader[] = (event.header_conf ?? []).map((h) => ({
    name: h.name,
    value: h.value,
    valueFromEnv: h.value_from_env,
  }));

  const payload = buildScheduledEventPayload(event);
  const url = resolveWebhookUrl(event.webhook_conf);

  logger.info({ eventId: event.id, url }, 'Delivering scheduled event webhook');

  const result = await deliverWebhook({
    url,
    headers: resolveWebhookHeaders(headers),
    payload,
    timeoutMs: retryConf.timeout_seconds * 1000,
  });

  // Record the invocation (every attempt)
  await pool.query(
    `INSERT INTO ${quoteIdent(schemaName)}.scheduled_event_invocations (event_id, status, request, response)
     VALUES ($1, $2, $3, $4)`,
    [
      event.id,
      result.statusCode ?? null,
      JSON.stringify(payload),
      JSON.stringify({ status: result.statusCode ?? null, body: result.body ?? null, error: result.error ?? null }),
    ],
  );

  if (result.success) {
    await pool.query(
      `UPDATE ${quoteIdent(schemaName)}.scheduled_events
       SET status = 'delivered', tries = tries + 1, locked_at = NULL
       WHERE id = $1`,
      [event.id],
    );
    logger.info(
      { eventId: event.id, statusCode: result.statusCode, durationMs: result.durationMs },
      'Scheduled event delivered',
    );
    return;
  }

  // Failure: retry per retry_conf, or mark as error when exhausted
  const exhausted = event.tries + 1 > retryConf.num_retries;
  if (exhausted) {
    await pool.query(
      `UPDATE ${quoteIdent(schemaName)}.scheduled_events
       SET status = 'error', tries = tries + 1, locked_at = NULL
       WHERE id = $1`,
      [event.id],
    );
  } else {
    await pool.query(
      `UPDATE ${quoteIdent(schemaName)}.scheduled_events
       SET status = 'scheduled', tries = tries + 1, locked_at = NULL,
           next_retry_at = now() + interval '1 second' * $2
       WHERE id = $1`,
      [event.id, retryConf.retry_interval_seconds],
    );
  }

  logger.warn(
    {
      eventId: event.id,
      statusCode: result.statusCode,
      error: result.error,
      tries: event.tries + 1,
      exhausted,
    },
    'Scheduled event delivery failed',
  );
}

/**
 * One poll tick: claim due events and deliver them sequentially.
 * Returns the number of events processed.
 */
export async function processDueScheduledEvents(
  pool: Pool,
  schemaName: string,
  batchSize: number,
  logger: Logger,
): Promise<number> {
  const events = await claimDueScheduledEvents(pool, schemaName, batchSize);
  for (const event of events) {
    try {
      await deliverScheduledEvent(pool, schemaName, event, logger);
    } catch (err) {
      // DB errors etc. — release the lock so the event is retried next tick
      logger.error({ err, eventId: event.id }, 'Scheduled event processing error');
      await pool
        .query(
          `UPDATE ${quoteIdent(schemaName)}.scheduled_events
           SET status = 'scheduled', locked_at = NULL WHERE id = $1 AND status = 'locked'`,
          [event.id],
        )
        .catch(() => undefined);
    }
  }
  return events.length;
}
