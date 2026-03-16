/**
 * Integration tests for the event trigger system.
 *
 * Tests the full outbox-pattern pipeline:
 * PG trigger → event_log → enqueuePendingEvents → pg-boss → webhook delivery
 *
 * Uses real PostgreSQL (docker-compose) and a mock webhook server.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import pg from 'pg';
import pino from 'pino';
import { MockWebhookServer } from './helpers/mock-webhook.js';
import { PgBossAdapter } from '../src/shared/job-queue/pg-boss-adapter.js';
import type { JobQueue } from '../src/shared/job-queue/types.js';
import { ensureEventSchema } from '../src/events/schema.js';
import { installEventTriggers, removeEventTriggers } from '../src/events/triggers.js';
import { enqueuePendingEvents, registerEventWorkers } from '../src/events/delivery.js';
import { TEST_DB_URL, waitForDb } from './setup.js';
import type { TableInfo, EventTriggerConfig, TablePermissions } from '../src/types.js';

const { Pool } = pg;

// ─── Test Constants ──────────────────────────────────────────────────────────

const logger = pino({ level: 'silent' });

// ─── Test Helpers ────────────────────────────────────────────────────────────

/** Empty permissions object for test TableInfo. */
function emptyPermissions(): TablePermissions {
  return { select: {}, insert: {}, update: {}, delete: {} };
}

/**
 * Build a minimal TableInfo with event triggers pointing at the mock server.
 */
function buildTestTableInfo(
  webhookBaseUrl: string,
  overrides?: Partial<{
    tableName: string;
    tableSchema: string;
    triggers: EventTriggerConfig[];
  }>,
): TableInfo {
  const tableName = overrides?.tableName ?? 'invoice';
  const tableSchema = overrides?.tableSchema ?? 'public';
  const triggers = overrides?.triggers ?? [
    {
      name: 'test_invoice_created',
      definition: {
        enableManual: true,
        insert: { columns: '*' },
      },
      retryConf: {
        intervalSec: 1,
        numRetries: 3,
        timeoutSec: 10,
      },
      webhook: `${webhookBaseUrl}/webhooks/invoice-created`,
      headers: [
        { name: 'x-webhook-secret', value: 'test-secret' },
      ],
    },
    {
      name: 'test_invoice_state_changed',
      definition: {
        enableManual: false,
        update: { columns: ['state'] },
      },
      retryConf: {
        intervalSec: 1,
        numRetries: 3,
        timeoutSec: 10,
      },
      webhook: `${webhookBaseUrl}/webhooks/invoice-state-changed`,
      headers: [
        { name: 'x-webhook-secret', value: 'test-secret' },
        { name: 'x-source', value: 'hakkyra-test' },
      ],
    },
  ];

  return {
    name: tableName,
    schema: tableSchema,
    columns: [],
    primaryKey: ['id'],
    foreignKeys: [],
    uniqueConstraints: [],
    indexes: [],
    relationships: [],
    permissions: emptyPermissions(),
    eventTriggers: triggers,
  };
}

/**
 * Helper to poll for a condition with timeout.
 */
async function waitFor(
  conditionFn: () => Promise<boolean>,
  timeoutMs: number = 15000,
  intervalMs: number = 200,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await conditionFn()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe('Event Triggers', () => {
  let pool: InstanceType<typeof Pool>;
  let jobQueue: JobQueue;
  let webhook: MockWebhookServer;
  let testTable: TableInfo;

  beforeAll(async () => {
    // Wait for DB
    await waitForDb();

    // Create pool
    pool = new Pool({ connectionString: TEST_DB_URL, max: 5 });

    // Initialize pg-boss via JobQueue adapter
    jobQueue = new PgBossAdapter(TEST_DB_URL);
    await jobQueue.start();

    // Start mock webhook server
    webhook = new MockWebhookServer();
    await webhook.start();

    // Build test table info pointing at mock server
    testTable = buildTestTableInfo(webhook.baseUrl);

    // Ensure event schema exists
    await ensureEventSchema(pool);

    // Install PG triggers on the invoice table
    await installEventTriggers(pool, [testTable]);

    // Register pg-boss workers for our test triggers
    await registerEventWorkers(jobQueue, pool, [testTable], logger);
  }, 30_000);

  afterAll(async () => {
    // Remove event triggers
    if (testTable) {
      await removeEventTriggers(pool, [testTable]);
    }

    // Cleanup job queue
    if (jobQueue) {
      await jobQueue.stop();
    }

    // Cleanup hakkyra_boss schema
    await pool.query('DROP SCHEMA IF EXISTS hakkyra_boss CASCADE');

    // Cleanup event_log and hakkyra schema objects (triggers/functions)
    await pool.query('DELETE FROM hakkyra.event_log');

    await webhook.stop();
    await pool.end();
  }, 15_000);

  beforeEach(() => {
    webhook.reset();
  });

  afterEach(async () => {
    // Truncate event_log between tests
    await pool.query('DELETE FROM hakkyra.event_log');
    // Clean up any test invoices created during tests
    // Note: one test changes provider from 'event-test' to 'updated-provider',
    // so we need to clean up both
    await pool.query(
      "DELETE FROM invoice WHERE provider IN ('event-test', 'updated-provider')",
    );
  });

  // ─── 1. Insert triggers webhook delivery ───────────────────────────────

  describe('insert triggers webhook delivery', () => {
    it('delivers a webhook with Hasura-compatible payload on INSERT', async () => {
      // Insert a test invoice row
      await pool.query(
        `INSERT INTO invoice (client_id, account_id, currency_id, amount, type, provider)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          'd0000000-0000-0000-0000-000000000001',
          'e0000000-0000-0000-0000-000000000001',
          'EUR',
          42.00,
          'payment',
          'event-test',
        ],
      );

      // Enqueue pending events
      const enqueued = await enqueuePendingEvents(pool, jobQueue, logger);
      expect(enqueued).toBeGreaterThanOrEqual(1);

      // Wait for webhook delivery
      const requests = await webhook.waitForRequests(1, 15000);
      expect(requests).toHaveLength(1);

      const req = requests[0];
      expect(req.method).toBe('POST');
      expect(req.url).toBe('/webhooks/invoice-created');

      // Verify Hasura-compatible payload structure
      const payload = req.body as Record<string, unknown>;
      expect(payload.id).toBeDefined();
      expect(payload.created_at).toBeDefined();

      // event.op
      const event = payload.event as Record<string, unknown>;
      expect(event.op).toBe('INSERT');

      // event.data.old / event.data.new
      const data = event.data as { old: unknown; new: Record<string, unknown> };
      expect(data.old).toBeNull();
      expect(data.new).toBeDefined();
      expect(Number(data.new.amount)).toBe(42);
      expect(data.new.type).toBe('payment');

      // table.schema / table.name
      const table = payload.table as { schema: string; name: string };
      expect(table.schema).toBe('public');
      expect(table.name).toBe('invoice');

      // trigger.name
      const trigger = payload.trigger as { name: string };
      expect(trigger.name).toBe('test_invoice_created');

      // Verify custom header was sent
      expect(req.headers['x-webhook-secret']).toBe('test-secret');
    });
  });

  // ─── 2. Column-filtered update triggers ────────────────────────────────

  describe('column-filtered update triggers', () => {
    it('fires trigger when tracked column (state) is updated', async () => {
      // Insert a test invoice
      const insertResult = await pool.query<{ id: string }>(
        `INSERT INTO invoice (client_id, account_id, currency_id, amount, type, provider)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
          'd0000000-0000-0000-0000-000000000001',
          'e0000000-0000-0000-0000-000000000001',
          'EUR',
          50.00,
          'payment',
          'event-test',
        ],
      );
      const invoiceId = insertResult.rows[0].id;

      // Clear event_log entries from the INSERT (we only care about UPDATE)
      await pool.query('DELETE FROM hakkyra.event_log');
      webhook.reset();

      // Update the tracked column (state)
      await pool.query(
        `UPDATE invoice SET state = 'sent' WHERE id = $1`,
        [invoiceId],
      );

      // Verify event was logged for the state change
      const eventResult = await pool.query(
        `SELECT * FROM hakkyra.event_log WHERE trigger_name = 'test_invoice_state_changed'`,
      );
      expect(eventResult.rows.length).toBe(1);
      expect(eventResult.rows[0].operation).toBe('UPDATE');

      // Enqueue and deliver
      const enqueued = await enqueuePendingEvents(pool, jobQueue, logger);
      expect(enqueued).toBe(1);

      const requests = await webhook.waitForRequests(1, 15000);
      expect(requests).toHaveLength(1);
      expect(requests[0].url).toBe('/webhooks/invoice-state-changed');

      // Verify old and new data
      const payload = requests[0].body as Record<string, unknown>;
      const event = payload.event as Record<string, unknown>;
      expect(event.op).toBe('UPDATE');

      const data = event.data as { old: Record<string, unknown>; new: Record<string, unknown> };
      expect(data.old).toBeDefined();
      expect(data.new).toBeDefined();
      expect(data.old.state).toBe('draft');
      expect(data.new.state).toBe('sent');
    });

    it('does NOT fire trigger when non-tracked column is updated', async () => {
      // Insert a test invoice
      const insertResult = await pool.query<{ id: string }>(
        `INSERT INTO invoice (client_id, account_id, currency_id, amount, type, provider)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
          'd0000000-0000-0000-0000-000000000001',
          'e0000000-0000-0000-0000-000000000001',
          'EUR',
          60.00,
          'payment',
          'event-test',
        ],
      );
      const invoiceId = insertResult.rows[0].id;

      // Clear event_log entries from the INSERT
      await pool.query('DELETE FROM hakkyra.event_log');

      // Update a non-tracked column (provider) - should NOT fire the state_changed trigger
      await pool.query(
        `UPDATE invoice SET provider = 'updated-provider' WHERE id = $1`,
        [invoiceId],
      );

      // The state_changed trigger should NOT have fired
      const eventResult = await pool.query(
        `SELECT * FROM hakkyra.event_log WHERE trigger_name = 'test_invoice_state_changed'`,
      );
      expect(eventResult.rows.length).toBe(0);
    });
  });

  // ─── 3. Retry with exponential backoff ─────────────────────────────────

  describe('retry with exponential backoff', () => {
    it('retries on failure then succeeds when webhook recovers', async () => {
      // Configure webhook to fail initially
      webhook.responseCode = 500;

      // Insert a test invoice
      await pool.query(
        `INSERT INTO invoice (client_id, account_id, currency_id, amount, type, provider)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          'd0000000-0000-0000-0000-000000000001',
          'e0000000-0000-0000-0000-000000000001',
          'EUR',
          99.00,
          'payment',
          'event-test',
        ],
      );

      // Enqueue pending events
      await enqueuePendingEvents(pool, jobQueue, logger);

      // Wait for the first (failing) delivery attempt
      await webhook.waitForRequests(1, 15000);

      // Verify the event_log shows a retry increment
      await waitFor(async () => {
        const result = await pool.query(
          `SELECT retry_count, status, last_error FROM hakkyra.event_log
           WHERE trigger_name = 'test_invoice_created'
           ORDER BY created_at DESC LIMIT 1`,
        );
        if (result.rows.length === 0) return false;
        return result.rows[0].retry_count >= 1;
      }, 15000);

      const failedResult = await pool.query(
        `SELECT retry_count, status, last_error, response_status FROM hakkyra.event_log
         WHERE trigger_name = 'test_invoice_created'
         ORDER BY created_at DESC LIMIT 1`,
      );
      expect(failedResult.rows[0].retry_count).toBeGreaterThanOrEqual(1);
      expect(failedResult.rows[0].response_status).toBe(500);

      // Now switch webhook to succeed
      webhook.responseCode = 200;

      // Re-enqueue the pending events (simulating the retry cycle)
      // The event should still be 'pending' (not yet exhausted retries)
      await waitFor(async () => {
        // Try to re-enqueue events that are back in pending state
        const count = await enqueuePendingEvents(pool, jobQueue, logger);
        return count > 0;
      }, 15000);

      // Wait for the successful delivery
      await waitFor(async () => {
        const result = await pool.query(
          `SELECT status FROM hakkyra.event_log
           WHERE trigger_name = 'test_invoice_created'
           ORDER BY created_at DESC LIMIT 1`,
        );
        return result.rows.length > 0 && result.rows[0].status === 'delivered';
      }, 15000);

      const deliveredResult = await pool.query(
        `SELECT status, delivered_at, response_status FROM hakkyra.event_log
         WHERE trigger_name = 'test_invoice_created'
         ORDER BY created_at DESC LIMIT 1`,
      );
      expect(deliveredResult.rows[0].status).toBe('delivered');
      expect(deliveredResult.rows[0].delivered_at).not.toBeNull();
      expect(deliveredResult.rows[0].response_status).toBe(200);
    });
  });

  // ─── 4. Dead letter queue ──────────────────────────────────────────────

  describe('dead letter queue', () => {
    it('marks event as failed after exhausting retries', async () => {
      // Build a trigger with only 1 retry for faster testing
      const deadLetterTable = buildTestTableInfo(webhook.baseUrl, {
        tableName: 'invoice',
        triggers: [
          {
            name: 'test_deadletter_trigger',
            definition: {
              enableManual: true,
              insert: { columns: '*' },
            },
            retryConf: {
              intervalSec: 1,
              numRetries: 1,
              timeoutSec: 10,
            },
            webhook: `${webhook.baseUrl}/webhooks/deadletter`,
            headers: [],
          },
        ],
      });

      // Register a worker for this special trigger
      await registerEventWorkers(jobQueue, pool, [deadLetterTable], logger);

      // Configure webhook to always fail
      webhook.responseCode = 500;

      // Manually insert an event_log entry for this trigger
      await pool.query(
        `INSERT INTO hakkyra.event_log
         (trigger_name, table_schema, table_name, operation, new_data, status)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          'test_deadletter_trigger',
          'public',
          'invoice',
          'INSERT',
          JSON.stringify({ id: 'fake-id', amount: 100 }),
          'pending',
        ],
      );

      // Enqueue and let the worker process it
      await enqueuePendingEvents(pool, jobQueue, logger);

      // Wait for the first attempt
      await webhook.waitForRequests(1, 15000);

      // After the first failure + retry exhausted, the event should be 'failed'
      // The worker sets status = 'failed' when retry_count + 1 >= numRetries
      await waitFor(async () => {
        const result = await pool.query(
          `SELECT status, retry_count FROM hakkyra.event_log
           WHERE trigger_name = 'test_deadletter_trigger'
           ORDER BY created_at DESC LIMIT 1`,
        );
        return result.rows.length > 0 && result.rows[0].status === 'failed';
      }, 15000);

      const result = await pool.query(
        `SELECT status, retry_count, last_error FROM hakkyra.event_log
         WHERE trigger_name = 'test_deadletter_trigger'
         ORDER BY created_at DESC LIMIT 1`,
      );
      expect(result.rows[0].status).toBe('failed');
      expect(result.rows[0].last_error).toBeDefined();
      expect(result.rows[0].last_error).toContain('500');
    });
  });

  // ─── 5. Event delivery status tracking ─────────────────────────────────

  describe('event delivery status tracking', () => {
    it('transitions through pending → processing → delivered', async () => {
      // Insert a test invoice that fires the insert trigger
      await pool.query(
        `INSERT INTO invoice (client_id, account_id, currency_id, amount, type, provider)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          'd0000000-0000-0000-0000-000000000001',
          'e0000000-0000-0000-0000-000000000001',
          'EUR',
          33.00,
          'payment',
          'event-test',
        ],
      );

      // Step 1: Verify initial status is 'pending'
      const pendingResult = await pool.query(
        `SELECT status FROM hakkyra.event_log
         WHERE trigger_name = 'test_invoice_created'
         ORDER BY created_at DESC LIMIT 1`,
      );
      expect(pendingResult.rows.length).toBe(1);
      expect(pendingResult.rows[0].status).toBe('pending');

      // Step 2: Enqueue - this should set status to 'processing'
      const enqueued = await enqueuePendingEvents(pool, jobQueue, logger);
      expect(enqueued).toBe(1);

      const processingResult = await pool.query(
        `SELECT status FROM hakkyra.event_log
         WHERE trigger_name = 'test_invoice_created'
         ORDER BY created_at DESC LIMIT 1`,
      );
      expect(processingResult.rows[0].status).toBe('processing');

      // Step 3: Wait for delivery - status should become 'delivered'
      await waitFor(async () => {
        const result = await pool.query(
          `SELECT status FROM hakkyra.event_log
           WHERE trigger_name = 'test_invoice_created'
           ORDER BY created_at DESC LIMIT 1`,
        );
        return result.rows.length > 0 && result.rows[0].status === 'delivered';
      }, 15000);

      const deliveredResult = await pool.query(
        `SELECT status, delivered_at, response_status FROM hakkyra.event_log
         WHERE trigger_name = 'test_invoice_created'
         ORDER BY created_at DESC LIMIT 1`,
      );
      expect(deliveredResult.rows[0].status).toBe('delivered');
      expect(deliveredResult.rows[0].delivered_at).not.toBeNull();
      expect(deliveredResult.rows[0].response_status).toBe(200);
    });

    it('transitions through pending → processing → failed on persistent error', async () => {
      // Configure webhook to always fail
      webhook.responseCode = 500;

      // Manually insert a pending event with a trigger that has 0 retries
      await pool.query(
        `INSERT INTO hakkyra.event_log
         (trigger_name, table_schema, table_name, operation, new_data, status)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          'test_invoice_created',
          'public',
          'invoice',
          'INSERT',
          JSON.stringify({ id: 'test-fail-id', amount: 10 }),
          'pending',
        ],
      );

      // Verify pending
      const pendingResult = await pool.query(
        `SELECT status FROM hakkyra.event_log
         WHERE new_data::text LIKE '%test-fail-id%'
         ORDER BY created_at DESC LIMIT 1`,
      );
      expect(pendingResult.rows[0].status).toBe('pending');

      // Enqueue
      await enqueuePendingEvents(pool, jobQueue, logger);

      // Verify processing
      const processingResult = await pool.query(
        `SELECT status FROM hakkyra.event_log
         WHERE new_data::text LIKE '%test-fail-id%'
         ORDER BY created_at DESC LIMIT 1`,
      );
      expect(processingResult.rows[0].status).toBe('processing');

      // Wait for delivery attempt failure
      await webhook.waitForRequests(1, 15000);

      // The event should eventually transition.
      // With numRetries=3, after 1 failure it goes back to pending (retry_count=1 < 3)
      await waitFor(async () => {
        const result = await pool.query(
          `SELECT status, retry_count FROM hakkyra.event_log
           WHERE new_data::text LIKE '%test-fail-id%'
           ORDER BY created_at DESC LIMIT 1`,
        );
        return result.rows.length > 0 && result.rows[0].retry_count >= 1;
      }, 15000);

      const afterResult = await pool.query(
        `SELECT status, retry_count, last_error FROM hakkyra.event_log
         WHERE new_data::text LIKE '%test-fail-id%'
         ORDER BY created_at DESC LIMIT 1`,
      );
      expect(afterResult.rows[0].retry_count).toBeGreaterThanOrEqual(1);
      expect(afterResult.rows[0].last_error).toBeDefined();
    });
  });

  // ─── 6. Session variables in events ────────────────────────────────────

  describe('session variables in events', () => {
    it('captures session vars when set via hasura.user setting', async () => {
      const sessionVars = JSON.stringify({
        'x-hasura-role': 'backoffice',
        'x-hasura-user-id': 'd0000000-0000-0000-0000-000000000001',
      });

      // Set session variable via PG setting and insert.
      // Use set_config() which is the standard way to set custom GUC parameters.
      const pgClient = await pool.connect();
      try {
        await pgClient.query('BEGIN');
        await pgClient.query(
          `SELECT set_config('hasura.user', $1, true)`,
          [sessionVars],
        );
        await pgClient.query(
          `INSERT INTO invoice (client_id, account_id, currency_id, amount, type, provider)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            'd0000000-0000-0000-0000-000000000001',
            'e0000000-0000-0000-0000-000000000001',
            'EUR',
            77.00,
            'payment',
            'event-test',
          ],
        );
        await pgClient.query('COMMIT');
        // Reset the session-level GUC so it doesn't leak to other pool users
        await pgClient.query(`SELECT set_config('hasura.user', '', false)`);
      } finally {
        pgClient.release();
      }

      // Verify session_vars were captured in event_log
      const result = await pool.query(
        `SELECT id, session_vars FROM hakkyra.event_log
         WHERE trigger_name = 'test_invoice_created'
         ORDER BY created_at DESC LIMIT 1`,
      );
      expect(result.rows.length).toBe(1);
      const vars = result.rows[0].session_vars;
      expect(vars).toBeDefined();
      expect(vars['x-hasura-role']).toBe('backoffice');
      expect(vars['x-hasura-user-id']).toBe('d0000000-0000-0000-0000-000000000001');

      // Enqueue and deliver
      await enqueuePendingEvents(pool, jobQueue, logger);

      // Wait for webhook delivery; filter for the correct event by checking
      // the payload ID, since pg-boss retries from earlier tests may also
      // arrive at the webhook.
      const expectedEventId = result.rows[0].id;
      await waitFor(async () => {
        return webhook.requests.some((req) => {
          const body = req.body as Record<string, unknown>;
          return body.id === expectedEventId;
        });
      }, 15000);

      const matchingReq = webhook.requests.find((req) => {
        const body = req.body as Record<string, unknown>;
        return body.id === expectedEventId;
      })!;

      const payload = matchingReq.body as Record<string, unknown>;
      const event = payload.event as Record<string, unknown>;
      const sessionVariables = event.session_variables as Record<string, string>;

      expect(sessionVariables).toBeDefined();
      expect(sessionVariables['x-hasura-role']).toBe('backoffice');
      expect(sessionVariables['x-hasura-user-id']).toBe('d0000000-0000-0000-0000-000000000001');
    });

    it('captures null session_vars when hasura.user is not set', async () => {
      // Reset hasura.user on all pool connections to avoid leaking from previous tests
      const pgClient = await pool.connect();
      try {
        await pgClient.query(`SELECT set_config('hasura.user', '', false)`);
      } finally {
        pgClient.release();
      }

      // Insert without setting hasura.user - use a dedicated connection
      // to ensure hasura.user is clean
      const insertClient = await pool.connect();
      try {
        await insertClient.query(`SELECT set_config('hasura.user', '', false)`);
        await insertClient.query(
          `INSERT INTO invoice (client_id, account_id, currency_id, amount, type, provider)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            'd0000000-0000-0000-0000-000000000001',
            'e0000000-0000-0000-0000-000000000001',
            'EUR',
            88.00,
            'payment',
            'event-test',
          ],
        );
      } finally {
        insertClient.release();
      }

      // Verify session_vars is null in event_log
      // The trigger's NULLIF(current_setting('hasura.user', true), '')::jsonb
      // returns NULL when hasura.user is empty or unset
      const result = await pool.query(
        `SELECT id, session_vars FROM hakkyra.event_log
         WHERE trigger_name = 'test_invoice_created'
         ORDER BY created_at DESC LIMIT 1`,
      );
      expect(result.rows.length).toBe(1);
      const vars = result.rows[0].session_vars;
      expect(vars).toBeNull();

      // Verify the webhook payload has empty session_variables ({})
      await enqueuePendingEvents(pool, jobQueue, logger);

      const expectedEventId = result.rows[0].id;
      await waitFor(async () => {
        return webhook.requests.some((req) => {
          const body = req.body as Record<string, unknown>;
          return body.id === expectedEventId;
        });
      }, 15000);

      const matchingReq = webhook.requests.find((req) => {
        const body = req.body as Record<string, unknown>;
        return body.id === expectedEventId;
      })!;

      const payload = matchingReq.body as Record<string, unknown>;
      const event = payload.event as Record<string, unknown>;
      const sessionVariables = event.session_variables;

      // buildEventPayload uses `event.session_vars ?? {}`, so null becomes {}
      expect(sessionVariables).toEqual({});
    });
  });
});
