/**
 * P13.17: Event delivery must wake the pg-boss worker on enqueue instead of
 * waiting out the polling interval (2s default).
 *
 * PgBossAdapter.work() captures the worker id returned by boss.work(), and
 * PgBossAdapter.send() calls boss.notifyWorker(id) after enqueuing so the
 * worker's poll delay is aborted and delivery starts at once.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { PgBoss } from 'pg-boss';
import { PgBossAdapter } from '../src/shared/job-queue/pg-boss-adapter.js';
import { TEST_DB_URL, waitForDb } from './setup.js';

/** Reach into the adapter for its internal pg-boss instance (test-only). */
function bossOf(adapter: PgBossAdapter): PgBoss {
  return (adapter as unknown as { boss: PgBoss }).boss;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await sleep(25);
  }
}

describe('P13.17: pg-boss worker wake-up on send', () => {
  let adapter: PgBossAdapter;

  beforeEach(async () => {
    await waitForDb();
    adapter = new PgBossAdapter(TEST_DB_URL);
    await adapter.start();
  });

  afterEach(async () => {
    await adapter.stop();
  });

  // Retries absorb latency spikes under full-suite load; a missing notifyWorker
  // fails deterministically (~1500ms) on every attempt.
  it('delivers a job enqueued mid-poll-window immediately instead of waiting out the interval', { retry: 2 }, async () => {
    // pg-boss default pollingInterval is 2000ms. The worker fetches once on
    // registration, then sleeps ~2s. A job sent 500ms into that sleep would
    // not run until the ~2s mark without an explicit worker notification.
    const queue = 'notify-timing-test';
    await adapter.createQueue(queue);

    let deliveredLatencyMs: number | null = null;
    await adapter.work<{ sentAt: number }>(queue, async (jobs) => {
      for (const job of jobs) {
        deliveredLatencyMs = Date.now() - job.data.sentAt;
      }
    });

    // Let the worker complete its first (empty) fetch and enter its poll sleep
    await sleep(500);

    await adapter.send(queue, { sentAt: Date.now() });

    await waitFor(() => deliveredLatencyMs !== null, 5000);

    // Without notifyWorker the latency is ~1500ms (remainder of the 2s poll).
    // With it, delivery starts within milliseconds.
    expect(deliveredLatencyMs!).toBeLessThan(1200);
  });

  it('send() calls boss.notifyWorker with the worker id returned by boss.work()', async () => {
    const queue = 'notify-mechanism-test';
    await adapter.createQueue(queue);

    const boss = bossOf(adapter);
    const workSpy = vi.spyOn(boss, 'work');
    const notifySpy = vi.spyOn(boss, 'notifyWorker');

    await adapter.work(queue, async () => {});
    const workerId = await workSpy.mock.results[0]!.value;
    expect(typeof workerId).toBe('string');

    await adapter.send(queue, { hello: 'world' });

    expect(notifySpy).toHaveBeenCalledWith(workerId);
  });

  it('send() to a queue without a local worker does not call notifyWorker', async () => {
    const queue = 'notify-no-worker-test';
    await adapter.createQueue(queue);

    const notifySpy = vi.spyOn(bossOf(adapter), 'notifyWorker');

    await adapter.send(queue, { hello: 'world' });

    expect(notifySpy).not.toHaveBeenCalled();
  });
});
