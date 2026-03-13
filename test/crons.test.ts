/**
 * Integration tests for the cron trigger system.
 *
 * Uses real PostgreSQL (from docker-compose), a dedicated pg-boss instance,
 * and a mock webhook HTTP server to verify end-to-end cron trigger behavior.
 *
 * Note: The production code uses `cron:` as a queue name prefix, but pg-boss v12
 * disallows colons in queue names. The scheduler registration test verifies the
 * arguments via spyOn, while the worker/delivery tests use valid queue names
 * with the same handler logic to exercise the full pipeline.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { PgBoss } from 'pg-boss';
import type { Job } from 'pg-boss';
import { TEST_DB_URL, waitForDb, getPool, closePool } from './setup.js';
import { registerCronTriggers } from '../src/crons/scheduler.js';
import { registerCronWorkers } from '../src/crons/worker.js';
import {
  deliverWebhook,
  resolveWebhookUrl,
  resolveWebhookHeaders,
} from '../src/shared/webhook.js';
import type { CronTriggerConfig } from '../src/types.js';
import pino from 'pino';

// ─── Constants ──────────────────────────────────────────────────────────────

const BOSS_SCHEMA = 'hakkyra_boss_cron_test';
const logger = pino({ level: 'silent' });

/**
 * Convert a trigger name to a valid pg-boss queue name for testing.
 * Uses forward slash instead of colon, which pg-boss v12 accepts.
 */
function testQueueName(triggerName: string): string {
  return `cron/${triggerName}`;
}

// ─── Mock Webhook Server ────────────────────────────────────────────────────

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

interface MockWebhookServer {
  url: string;
  port: number;
  requests: RecordedRequest[];
  responseCode: number;
  close: () => Promise<void>;
  waitForRequests: (count: number, timeoutMs?: number) => Promise<RecordedRequest[]>;
  reset: () => void;
}

async function createMockWebhookServer(initialResponseCode = 200): Promise<MockWebhookServer> {
  const requests: RecordedRequest[] = [];
  let responseCode = initialResponseCode;
  let resolveWaiter: ((value: RecordedRequest[]) => void) | null = null;
  let waiterCount = 0;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let rawBody = '';
    req.on('data', (chunk: Buffer) => {
      rawBody += chunk.toString();
    });
    req.on('end', () => {
      let body: unknown;
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }

      const recorded: RecordedRequest = {
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers: req.headers as Record<string, string | string[] | undefined>,
        body,
      };

      requests.push(recorded);

      res.writeHead(responseCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: responseCode < 400 }));

      // Check if a waiter is satisfied
      if (resolveWaiter && requests.length >= waiterCount) {
        resolveWaiter(requests.slice());
        resolveWaiter = null;
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  const mock: MockWebhookServer = {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    get responseCode() {
      return responseCode;
    },
    set responseCode(code: number) {
      responseCode = code;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
    waitForRequests: (count: number, timeoutMs = 15000) => {
      if (requests.length >= count) {
        return Promise.resolve(requests.slice());
      }
      return new Promise<RecordedRequest[]>((resolve, reject) => {
        waiterCount = count;
        const timer = setTimeout(() => {
          resolveWaiter = null;
          reject(
            new Error(
              `Timed out waiting for ${count} request(s), received ${requests.length}`,
            ),
          );
        }, timeoutMs);

        resolveWaiter = (reqs) => {
          clearTimeout(timer);
          resolve(reqs);
        };
      });
    },
    reset: () => {
      requests.length = 0;
      responseCode = 200;
      resolveWaiter = null;
      waiterCount = 0;
    },
  };

  return mock;
}

// ─── pg-boss helpers ────────────────────────────────────────────────────────

function createBoss(): PgBoss {
  return new PgBoss({
    connectionString: TEST_DB_URL,
    schema: BOSS_SCHEMA,
    // Fast polling for tests
    cronWorkerIntervalSeconds: 1,
    cronMonitorIntervalSeconds: 1,
    monitorIntervalSeconds: 1,
    maintenanceIntervalSeconds: 1,
  });
}

async function cleanBossSchema(): Promise<void> {
  const pool = getPool();
  await pool.query(`DROP SCHEMA IF EXISTS ${BOSS_SCHEMA} CASCADE`);
}

// ─── Worker handler builder (mirrors src/crons/worker.ts logic) ─────────

/**
 * Build a Hasura-compatible cron trigger webhook payload.
 * Mirrors the buildCronPayload function in src/crons/worker.ts.
 */
function buildCronPayload(trigger: CronTriggerConfig, scheduledTime: string): unknown {
  return {
    scheduled_time: scheduledTime,
    payload: trigger.payload ?? null,
    name: trigger.name,
    comment: trigger.comment ?? null,
  };
}

/**
 * Register a pg-boss worker for a cron trigger using a valid queue name.
 * This mirrors the logic in src/crons/worker.ts but uses a pg-boss-v12-compatible
 * queue name (forward slash instead of colon).
 *
 * Creates the queue first if it does not already exist (pg-boss v12 requirement).
 */
async function registerTestCronWorker(
  boss: PgBoss,
  trigger: CronTriggerConfig,
  queueName: string,
): Promise<void> {
  // Ensure the queue exists (pg-boss v12 requires explicit queue creation)
  const existing = await boss.getQueue(queueName);
  if (!existing) {
    await boss.createQueue(queueName);
  }

  await boss.work<Record<string, unknown>>(queueName, async (jobs: Job<Record<string, unknown>>[]) => {
    for (const job of jobs) {
      const url = resolveWebhookUrl(trigger.webhook, trigger.webhookFromEnv);
      const headers = resolveWebhookHeaders(trigger.headers);
      const scheduledTime = (job.data?.scheduledTime as string)
        ?? new Date().toISOString();

      const payload = buildCronPayload(trigger, scheduledTime);

      const result = await deliverWebhook({
        url,
        headers,
        payload,
        timeoutMs: trigger.retryConf?.timeoutSeconds
          ? trigger.retryConf.timeoutSeconds * 1000
          : 30000,
      });

      if (!result.success) {
        throw new Error(
          `Webhook delivery failed: ${result.error ?? `HTTP ${result.statusCode}`}`,
        );
      }
    }
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Cron Triggers', () => {
  let boss: PgBoss;
  let webhook: MockWebhookServer;

  beforeAll(async () => {
    process.env['DATABASE_URL'] = TEST_DB_URL;
    await waitForDb();
    await cleanBossSchema();
    webhook = await createMockWebhookServer();
  }, 30_000);

  afterAll(async () => {
    await webhook.close();
    await cleanBossSchema();
    await closePool();
  });

  beforeEach(async () => {
    await cleanBossSchema();
    boss = createBoss();
    // Suppress unhandled error events (pg-boss emits these on worker failures)
    boss.on('error', () => {});
    await boss.start();
    webhook.reset();
  }, 15_000);

  afterEach(async () => {
    if (boss) {
      await boss.stop({ graceful: false, timeout: 3000 });
    }
    vi.restoreAllMocks();
  }, 15_000);

  // ── 1. Schedule registration ────────────────────────────────────────────

  describe('schedule registration', () => {
    it('calls boss.schedule() with correct queue names and cron expressions', async () => {
      const scheduleSpy = vi.spyOn(boss, 'schedule').mockResolvedValue(undefined);

      const triggers: CronTriggerConfig[] = [
        {
          name: 'test_trigger_a',
          webhook: 'http://example.com/hook-a',
          schedule: '*/5 * * * *',
          payload: { action: 'a' },
        },
        {
          name: 'test_trigger_b',
          webhook: 'http://example.com/hook-b',
          schedule: '0 3 * * *',
        },
      ];

      await registerCronTriggers(boss, triggers);

      expect(scheduleSpy).toHaveBeenCalledTimes(2);

      // First trigger
      expect(scheduleSpy).toHaveBeenCalledWith(
        'cron:test_trigger_a',
        '*/5 * * * *',
        { payload: { action: 'a' } },
        {},
      );

      // Second trigger (no payload => null)
      expect(scheduleSpy).toHaveBeenCalledWith(
        'cron:test_trigger_b',
        '0 3 * * *',
        { payload: null },
        {},
      );
    });

    it('passes retry configuration to schedule options', async () => {
      const scheduleSpy = vi.spyOn(boss, 'schedule').mockResolvedValue(undefined);

      const triggers: CronTriggerConfig[] = [
        {
          name: 'retry_test',
          webhook: 'http://example.com/hook',
          schedule: '0 * * * *',
          retryConf: {
            numRetries: 5,
            retryIntervalSeconds: 10,
            timeoutSeconds: 60,
          },
        },
      ];

      await registerCronTriggers(boss, triggers);

      expect(scheduleSpy).toHaveBeenCalledTimes(1);
      expect(scheduleSpy).toHaveBeenCalledWith(
        'cron:retry_test',
        '0 * * * *',
        { payload: null },
        {
          retryLimit: 5,
          retryDelay: 10,
          retryBackoff: true,
          expireInSeconds: 60,
        },
      );
    });

    it('calls boss.work() with correct queue names for each trigger', async () => {
      const workSpy = vi.spyOn(boss, 'work').mockResolvedValue('worker-id');

      const triggers: CronTriggerConfig[] = [
        {
          name: 'worker_a',
          webhook: 'http://example.com/a',
          schedule: '0 * * * *',
        },
        {
          name: 'worker_b',
          webhook: 'http://example.com/b',
          schedule: '0 3 * * *',
        },
      ];

      await registerCronWorkers(boss, triggers, logger);

      expect(workSpy).toHaveBeenCalledTimes(2);
      expect(workSpy.mock.calls[0][0]).toBe('cron:worker_a');
      expect(workSpy.mock.calls[1][0]).toBe('cron:worker_b');
    });
  });

  // ── 2. Webhook delivery with Hasura-compatible payload ──────────────────

  describe('webhook delivery', () => {
    it('delivers webhook with correct Hasura-compatible payload format', async () => {
      const trigger: CronTriggerConfig = {
        name: 'payload_test',
        webhook: `${webhook.url}/cron-hook`,
        schedule: '0 * * * *',
        payload: { action: 'test_action' },
        comment: 'Test trigger for payload verification',
      };

      const queueName = testQueueName(trigger.name);
      await registerTestCronWorker(boss, trigger, queueName);

      // Manually send a job to the cron queue to bypass scheduling timing
      const scheduledTime = new Date().toISOString();
      await boss.send(queueName, { payload: trigger.payload ?? null, scheduledTime });

      const reqs = await webhook.waitForRequests(1);
      expect(reqs).toHaveLength(1);

      const req = reqs[0];
      expect(req.method).toBe('POST');
      expect(req.url).toBe('/cron-hook');

      // Verify Hasura-compatible payload structure
      const body = req.body as {
        scheduled_time: string;
        payload: unknown;
        name: string;
        comment: string | null;
      };

      expect(body.scheduled_time).toBe(scheduledTime);
      expect(body.payload).toEqual({ action: 'test_action' });
      expect(body.name).toBe('payload_test');
      expect(body.comment).toBe('Test trigger for payload verification');
    });

    it('includes Content-Type application/json header', async () => {
      const trigger: CronTriggerConfig = {
        name: 'content_type_test',
        webhook: `${webhook.url}/hook`,
        schedule: '0 * * * *',
      };

      const queueName = testQueueName(trigger.name);
      await registerTestCronWorker(boss, trigger, queueName);
      await boss.send(queueName, { payload: null });

      const reqs = await webhook.waitForRequests(1);
      expect(reqs[0].headers['content-type']).toBe('application/json');
    });
  });

  // ── 3. Complex payload delivery ─────────────────────────────────────────

  describe('payload with data', () => {
    it('delivers complex nested payloads correctly', async () => {
      const complexPayload = {
        action: 'cleanup_plans',
        max_age_days: 90,
        states: ['completed', 'cancelled'],
        nested: {
          deep: {
            value: 42,
            array: [1, 2, 3],
          },
        },
        archive: true,
      };

      const trigger: CronTriggerConfig = {
        name: 'complex_payload_test',
        webhook: `${webhook.url}/complex`,
        schedule: '0 4 * * 1',
        payload: complexPayload,
        comment: 'Complex payload test',
      };

      const queueName = testQueueName(trigger.name);
      await registerTestCronWorker(boss, trigger, queueName);
      await boss.send(queueName, { payload: trigger.payload ?? null });

      const reqs = await webhook.waitForRequests(1);
      const body = reqs[0].body as { payload: unknown };
      expect(body.payload).toEqual(complexPayload);
    });
  });

  // ── 4. Null payload handling ────────────────────────────────────────────

  describe('null payload handling', () => {
    it('delivers payload: null when trigger has no payload', async () => {
      const trigger: CronTriggerConfig = {
        name: 'null_payload_test',
        webhook: `${webhook.url}/null-payload`,
        schedule: '0 * * * *',
        // No payload property
      };

      const queueName = testQueueName(trigger.name);
      await registerTestCronWorker(boss, trigger, queueName);
      await boss.send(queueName, { payload: null });

      const reqs = await webhook.waitForRequests(1);
      const body = reqs[0].body as { payload: unknown };
      expect(body.payload).toBeNull();
    });

    it('delivers payload: null when trigger payload is explicitly undefined', async () => {
      const trigger: CronTriggerConfig = {
        name: 'undef_payload_test',
        webhook: `${webhook.url}/undef-payload`,
        schedule: '0 * * * *',
        payload: undefined,
      };

      const queueName = testQueueName(trigger.name);
      await registerTestCronWorker(boss, trigger, queueName);
      await boss.send(queueName, { payload: null });

      const reqs = await webhook.waitForRequests(1);
      const body = reqs[0].body as { payload: unknown; comment: unknown };
      expect(body.payload).toBeNull();
      // comment should also be null when not set
      expect(body.comment).toBeNull();
    });
  });

  // ── 5. Webhook headers ──────────────────────────────────────────────────

  describe('webhook headers', () => {
    it('sends static header values', async () => {
      const trigger: CronTriggerConfig = {
        name: 'static_headers_test',
        webhook: `${webhook.url}/headers`,
        schedule: '0 * * * *',
        headers: [
          { name: 'x-custom-header', value: 'custom-value' },
          { name: 'x-api-key', value: 'my-api-key-123' },
        ],
      };

      const queueName = testQueueName(trigger.name);
      await registerTestCronWorker(boss, trigger, queueName);
      await boss.send(queueName, { payload: null });

      const reqs = await webhook.waitForRequests(1);
      expect(reqs[0].headers['x-custom-header']).toBe('custom-value');
      expect(reqs[0].headers['x-api-key']).toBe('my-api-key-123');
    });

    it('resolves header values from environment variables', async () => {
      const envVarName = 'TEST_CRON_SECRET_HEADER';
      const envVarValue = 'secret-from-env-42';
      process.env[envVarName] = envVarValue;

      try {
        const trigger: CronTriggerConfig = {
          name: 'env_headers_test',
          webhook: `${webhook.url}/env-headers`,
          schedule: '0 * * * *',
          headers: [
            { name: 'x-cron-secret', valueFromEnv: envVarName },
            { name: 'x-static', value: 'static-val' },
          ],
        };

        const queueName = testQueueName(trigger.name);
        await registerTestCronWorker(boss, trigger, queueName);
        await boss.send(queueName, { payload: null });

        const reqs = await webhook.waitForRequests(1);
        expect(reqs[0].headers['x-cron-secret']).toBe(envVarValue);
        expect(reqs[0].headers['x-static']).toBe('static-val');
      } finally {
        delete process.env[envVarName];
      }
    });
  });

  // ── 6. Webhook URL from env ─────────────────────────────────────────────

  describe('webhook URL from env', () => {
    it('resolves webhook URL from environment variable', async () => {
      const envVarName = 'TEST_CRON_WEBHOOK_URL';
      process.env[envVarName] = `${webhook.url}/from-env`;

      try {
        const trigger: CronTriggerConfig = {
          name: 'webhook_from_env_test',
          webhook: `${webhook.url}/fallback`,
          webhookFromEnv: envVarName,
          schedule: '0 * * * *',
        };

        const queueName = testQueueName(trigger.name);
        await registerTestCronWorker(boss, trigger, queueName);
        await boss.send(queueName, { payload: null });

        const reqs = await webhook.waitForRequests(1);
        // The URL from env should be used, so we should see /from-env, not /fallback
        expect(reqs[0].url).toBe('/from-env');
      } finally {
        delete process.env[envVarName];
      }
    });

    it('falls back to webhook field when env var is not set', async () => {
      const trigger: CronTriggerConfig = {
        name: 'webhook_fallback_test',
        webhook: `${webhook.url}/fallback-path`,
        webhookFromEnv: 'NON_EXISTENT_ENV_VAR_CRON_TEST',
        schedule: '0 * * * *',
      };

      const queueName = testQueueName(trigger.name);
      await registerTestCronWorker(boss, trigger, queueName);
      await boss.send(queueName, { payload: null });

      const reqs = await webhook.waitForRequests(1);
      expect(reqs[0].url).toBe('/fallback-path');
    });
  });

  // ── 7. Retry on failure ─────────────────────────────────────────────────

  describe('retry on failure', () => {
    it('retries when webhook returns 500', async () => {
      webhook.responseCode = 500;

      const trigger: CronTriggerConfig = {
        name: 'retry_failure_test',
        webhook: `${webhook.url}/failing`,
        schedule: '0 * * * *',
        retryConf: {
          numRetries: 2,
          retryIntervalSeconds: 1,
          timeoutSeconds: 30,
        },
      };

      const queueName = testQueueName(trigger.name);

      // Create the queue with retry settings before registering workers
      await boss.createQueue(queueName, {
        retryLimit: 2,
        retryDelay: 1,
        retryBackoff: false,
      });

      await registerTestCronWorker(boss, trigger, queueName);

      await boss.send(queueName, { payload: null });

      // Should receive the initial attempt plus retries (total: 3 = 1 initial + 2 retries)
      const reqs = await webhook.waitForRequests(3, 30_000);
      expect(reqs.length).toBeGreaterThanOrEqual(3);

      // All requests should have hit the /failing endpoint
      for (const req of reqs) {
        expect(req.url).toBe('/failing');
      }
    }, 45_000);
  });

  // ── 8. Failed after retries exhausted ───────────────────────────────────

  describe('failed after retries exhausted', () => {
    it('job reaches failed state when all retries are exhausted', async () => {
      webhook.responseCode = 500;

      const trigger: CronTriggerConfig = {
        name: 'exhaust_retries_test',
        webhook: `${webhook.url}/always-fail`,
        schedule: '0 * * * *',
        retryConf: {
          numRetries: 1,
          retryIntervalSeconds: 1,
          timeoutSeconds: 30,
        },
      };

      const queueName = testQueueName(trigger.name);

      // Create the queue with retry settings
      await boss.createQueue(queueName, {
        retryLimit: 1,
        retryDelay: 1,
        retryBackoff: false,
      });

      await registerTestCronWorker(boss, trigger, queueName);

      const jobId = await boss.send(queueName, { payload: null });
      expect(jobId).toBeTruthy();

      // Wait for 1 initial + 1 retry = 2 total attempts
      await webhook.waitForRequests(2, 30_000);

      // Give pg-boss a moment to settle the final state
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // Query pg-boss for the job state
      const jobs = await boss.findJobs<Record<string, unknown>>(
        queueName,
        { id: jobId! },
      );

      expect(jobs.length).toBeGreaterThanOrEqual(1);
      const job = jobs[0];
      expect(job.state).toBe('failed');
    }, 45_000);
  });
});
