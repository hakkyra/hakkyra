/**
 * Integration tests for one-off scheduled events (P13.4).
 *
 * Covers the full pipeline: direct table insert (the acme pattern) or
 * /v1/metadata create_scheduled_event → poller claims due events → webhook
 * delivery with retry → invocation logs → status lifecycle
 * (scheduled → locked → delivered | error).
 *
 * Uses real PostgreSQL (docker-compose) and a mock webhook server.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import pino from 'pino';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { MockWebhookServer } from './helpers/mock-webhook.js';
import {
  ensureScheduledEventSchema,
  processDueScheduledEvents,
  createScheduledEventManager,
  registerScheduledEventRoutes,
} from '../src/scheduled-events/index.js';
import type { SessionVariables } from '../src/types.js';
import { TEST_DB_URL, waitForDb } from './setup.js';

const { Pool } = pg;
const logger = pino({ level: 'silent' });

let pool: pg.Pool;
let webhook: MockWebhookServer;

async function waitFor(check: () => Promise<boolean>, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('waitFor timed out');
}

function adminSession(): SessionVariables {
  return { role: 'admin', allowedRoles: ['admin'], isAdmin: true, claims: {} };
}

async function insertEvent(overrides?: Partial<{
  webhook_conf: string;
  scheduled_time: string;
  payload: unknown;
  retry_conf: unknown;
  comment: string;
}>): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO hakkyra.scheduled_events (webhook_conf, scheduled_time, payload, retry_conf, comment)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [
      overrides?.webhook_conf ?? `${webhook.baseUrl}/scheduled/test`,
      overrides?.scheduled_time ?? new Date().toISOString(),
      overrides?.payload !== undefined ? JSON.stringify(overrides.payload) : JSON.stringify({ hello: 'world' }),
      overrides?.retry_conf !== undefined ? JSON.stringify(overrides.retry_conf) : null,
      overrides?.comment ?? null,
    ],
  );
  return result.rows[0].id;
}

beforeAll(async () => {
  await waitForDb();
  pool = new Pool({ connectionString: TEST_DB_URL, max: 5 });
  webhook = new MockWebhookServer();
  await webhook.start();
  await ensureScheduledEventSchema(pool, 'hakkyra');
}, 30_000);

afterAll(async () => {
  await webhook.stop();
  await pool.end();
});

beforeEach(async () => {
  webhook.reset();
  await pool.query(`DELETE FROM hakkyra.scheduled_event_invocations`);
  await pool.query(`DELETE FROM hakkyra.scheduled_events`);
});

// ─── Delivery pipeline ───────────────────────────────────────────────────────

describe('scheduled event delivery', () => {
  it('delivers a due event inserted directly into the table (acme pattern)', async () => {
    const eventId = await insertEvent({ payload: { userId: 42 }, comment: 'welcome-email' });

    const processed = await processDueScheduledEvents(pool, 'hakkyra', 100, logger);
    expect(processed).toBe(1);

    // Webhook received Hasura-shaped payload
    expect(webhook.requests.length).toBe(1);
    const body = webhook.requests[0].body as Record<string, unknown>;
    expect(body.id).toBe(eventId);
    expect(body.payload).toEqual({ userId: 42 });
    expect(body.comment).toBe('welcome-email');
    expect(body.scheduled_time).toBeDefined();

    // Status → delivered, invocation recorded with response
    const row = await pool.query(
      `SELECT status, tries FROM hakkyra.scheduled_events WHERE id = $1`, [eventId],
    );
    expect(row.rows[0].status).toBe('delivered');
    expect(row.rows[0].tries).toBe(1);

    const inv = await pool.query(
      `SELECT status, request, response FROM hakkyra.scheduled_event_invocations WHERE event_id = $1`,
      [eventId],
    );
    expect(inv.rows.length).toBe(1);
    expect(inv.rows[0].status).toBe(200);
    expect(inv.rows[0].request.id).toBe(eventId);
    expect(inv.rows[0].response.status).toBe(200);
  });

  it('does not deliver future events', async () => {
    await insertEvent({ scheduled_time: new Date(Date.now() + 3600_000).toISOString() });
    const processed = await processDueScheduledEvents(pool, 'hakkyra', 100, logger);
    expect(processed).toBe(0);
    expect(webhook.requests.length).toBe(0);
  });

  it('retries per retry_conf then marks error when exhausted', async () => {
    webhook.responseCode = 500;
    const eventId = await insertEvent({
      retry_conf: { num_retries: 2, retry_interval_seconds: 0 },
    });

    // Attempt 1
    await processDueScheduledEvents(pool, 'hakkyra', 100, logger);
    let row = await pool.query(`SELECT status, tries FROM hakkyra.scheduled_events WHERE id = $1`, [eventId]);
    expect(row.rows[0].status).toBe('scheduled');
    expect(row.rows[0].tries).toBe(1);

    // Attempts 2 and 3 (retry_interval 0 → immediately due again)
    await processDueScheduledEvents(pool, 'hakkyra', 100, logger);
    await processDueScheduledEvents(pool, 'hakkyra', 100, logger);

    row = await pool.query(`SELECT status, tries FROM hakkyra.scheduled_events WHERE id = $1`, [eventId]);
    expect(row.rows[0].status).toBe('error');
    expect(row.rows[0].tries).toBe(3);

    // Every attempt logged
    const inv = await pool.query(
      `SELECT count(*)::int AS n FROM hakkyra.scheduled_event_invocations WHERE event_id = $1`,
      [eventId],
    );
    expect(inv.rows[0].n).toBe(3);
  });

  it('manager poller picks up events on its own', async () => {
    const manager = createScheduledEventManager({
      pool, logger, schemaName: 'hakkyra', pollIntervalMs: 100, batchSize: 10,
    });
    await manager.init();
    try {
      const eventId = await insertEvent();
      await waitFor(async () => {
        const r = await pool.query(`SELECT status FROM hakkyra.scheduled_events WHERE id = $1`, [eventId]);
        return r.rows[0]?.status === 'delivered';
      });
      expect(webhook.requests.length).toBeGreaterThanOrEqual(1);
    } finally {
      await manager.stop();
    }
  });
});

// ─── /v1/metadata RPC ───────────────────────────────────────────────────────

describe('/v1/metadata scheduled event RPC', () => {
  let api: FastifyInstance;
  let currentSession: SessionVariables | undefined;

  beforeAll(async () => {
    api = Fastify({ logger: false });
    api.addHook('preHandler', async (request) => {
      request.session = currentSession;
    });
    registerScheduledEventRoutes(api, { pool, schemaName: 'hakkyra' });
    await api.ready();
  });

  afterAll(async () => {
    await api.close();
  });

  beforeEach(() => {
    currentSession = adminSession();
  });

  it('create_scheduled_event inserts a row and returns event_id', async () => {
    const res = await api.inject({
      method: 'POST',
      url: '/v1/metadata',
      payload: {
        type: 'create_scheduled_event',
        args: {
          webhook: `${webhook.baseUrl}/scheduled/api`,
          schedule_at: new Date().toISOString(),
          payload: { source: 'api' },
          headers: [{ name: 'x-test', value: 'yes' }],
          retry_conf: { num_retries: 1, retry_interval_seconds: 5 },
          comment: 'api-created',
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { message: string; event_id: string };
    expect(body.message).toBe('success');
    expect(body.event_id).toBeTruthy();

    const row = await pool.query(
      `SELECT webhook_conf, payload, header_conf, comment FROM hakkyra.scheduled_events WHERE id = $1`,
      [body.event_id],
    );
    expect(row.rows[0].payload).toEqual({ source: 'api' });
    expect(row.rows[0].header_conf).toEqual([{ name: 'x-test', value: 'yes' }]);
    expect(row.rows[0].comment).toBe('api-created');

    // Deliver and verify the header went out
    await processDueScheduledEvents(pool, 'hakkyra', 100, logger);
    expect(webhook.requests.length).toBe(1);
    expect(webhook.requests[0].headers['x-test']).toBe('yes');
  });

  it('get_scheduled_event_invocations returns recorded attempts', async () => {
    const eventId = await insertEvent();
    await processDueScheduledEvents(pool, 'hakkyra', 100, logger);

    const res = await api.inject({
      method: 'POST',
      url: '/v1/metadata',
      payload: { type: 'get_scheduled_event_invocations', args: { event_id: eventId } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { invocations: Array<Record<string, unknown>> };
    expect(body.invocations.length).toBe(1);
    expect(body.invocations[0].event_id).toBe(eventId);
    expect(body.invocations[0].status).toBe(200);
  });

  it('delete_scheduled_event removes a pending event', async () => {
    const eventId = await insertEvent({ scheduled_time: new Date(Date.now() + 3600_000).toISOString() });
    const res = await api.inject({
      method: 'POST',
      url: '/v1/metadata',
      payload: { type: 'delete_scheduled_event', args: { type: 'one_off', event_id: eventId } },
    });
    expect(res.statusCode).toBe(200);
    const row = await pool.query(`SELECT 1 FROM hakkyra.scheduled_events WHERE id = $1`, [eventId]);
    expect(row.rows.length).toBe(0);
  });

  it('rejects non-admin sessions', async () => {
    currentSession = { role: 'client', allowedRoles: ['client'], isAdmin: false, claims: {} };
    const res = await api.inject({
      method: 'POST',
      url: '/v1/metadata',
      payload: { type: 'create_scheduled_event', args: { webhook: 'http://x', schedule_at: 'now' } },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { code: string }).code).toBe('access-denied');
  });

  it('rejects unknown metadata commands', async () => {
    const res = await api.inject({
      method: 'POST',
      url: '/v1/metadata',
      payload: { type: 'export_metadata', args: {} },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe('parse-failed');
  });

  it('rejects create without webhook or schedule_at', async () => {
    const res = await api.inject({
      method: 'POST',
      url: '/v1/metadata',
      payload: { type: 'create_scheduled_event', args: { webhook: 'http://x' } },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe('parse-failed');
  });
});
