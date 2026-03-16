/**
 * Generic webhook worker factory.
 *
 * Extracts the repeated pattern shared by event triggers, cron triggers,
 * and async actions: resolve webhook config -> deliver -> update DB -> throw on failure.
 *
 * Each consumer provides callbacks to extract webhook details from job data,
 * handle success, and handle failure, while the factory handles the common
 * orchestration, logging, and error flow.
 */

import type { Logger } from 'pino';
import type { JobQueue, Job, JobData, QueueOptions, WorkOptions } from './job-queue/types.js';
import {
  deliverWebhook,
  type WebhookDeliveryResult,
} from './webhook.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface WebhookJobConfig<T extends JobData> {
  /** URL to deliver the webhook to. */
  url: string;
  /** HTTP headers to include. */
  headers: Record<string, string>;
  /** JSON payload to send. */
  payload: unknown;
  /** Timeout in milliseconds (default: 30000). */
  timeoutMs?: number;
}

/**
 * Callbacks that the consumer provides to customize webhook worker behavior.
 */
export interface WebhookWorkerCallbacks<T extends JobData> {
  /**
   * Extract webhook URL, headers, payload, and timeout from job data.
   * Return null to skip the job (e.g. if the referenced row no longer exists).
   */
  resolveWebhook(job: Job<T>): Promise<WebhookJobConfig<T> | null> | WebhookJobConfig<T> | null;

  /**
   * Called after a successful webhook delivery.
   * Use this to update DB status, log success, etc.
   */
  onSuccess(job: Job<T>, result: WebhookDeliveryResult): Promise<void>;

  /**
   * Called after a failed webhook delivery.
   * Use this to update DB error state, log failure, etc.
   * The factory will throw after this callback returns, so the job queue retries.
   */
  onFailure(job: Job<T>, result: WebhookDeliveryResult): Promise<void>;
}

export interface WebhookWorkerOptions<T extends JobData> {
  /** Queue name to register the worker on. */
  queueName: string;
  /** Descriptive label for logging (e.g. 'event/my_trigger', 'cron/daily_cleanup'). */
  label: string;
  /** Queue configuration (retry, expiry). If provided, createQueue is called first. */
  queueOptions?: QueueOptions;
  /** Worker concurrency options. */
  workOptions?: WorkOptions;
  /** Callbacks for resolving webhook config and handling results. */
  callbacks: WebhookWorkerCallbacks<T>;
}

// ─── Factory ───────────────────────────────────────────────────────────────

/**
 * Register a webhook delivery worker on the given job queue.
 *
 * The worker loop for each job:
 * 1. Call `resolveWebhook()` to get URL, headers, payload, timeout
 * 2. Call `deliverWebhook()` to POST the payload
 * 3. On success: call `onSuccess()` callback
 * 4. On failure: call `onFailure()` callback, then throw to trigger retry
 */
export async function registerWebhookWorker<T extends JobData>(
  jobQueue: JobQueue,
  logger: Logger,
  options: WebhookWorkerOptions<T>,
): Promise<void> {
  const { queueName, label, queueOptions, workOptions, callbacks } = options;

  // Create/configure the queue if options are provided
  if (queueOptions) {
    await jobQueue.createQueue(queueName, queueOptions);
  }

  await jobQueue.work<T>(queueName, async (jobs: Job<T>[]) => {
    for (const job of jobs) {
      const webhookConfig = await callbacks.resolveWebhook(job);

      // Skip if resolveWebhook returned null (e.g. row not found)
      if (!webhookConfig) {
        continue;
      }

      const { url, headers, payload, timeoutMs } = webhookConfig;

      logger.info(
        { label, url, jobId: job.id },
        `Delivering ${label} webhook`,
      );

      const result = await deliverWebhook({
        url,
        headers,
        payload,
        timeoutMs: timeoutMs ?? 30000,
      });

      if (result.success) {
        await callbacks.onSuccess(job, result);

        logger.info(
          { label, jobId: job.id, statusCode: result.statusCode, durationMs: result.durationMs },
          `${label} webhook delivered`,
        );
      } else {
        await callbacks.onFailure(job, result);

        logger.warn(
          { label, jobId: job.id, statusCode: result.statusCode, error: result.error, durationMs: result.durationMs },
          `${label} webhook delivery failed`,
        );

        // Throw so the job queue knows the job failed and can retry
        throw new Error(`Webhook delivery failed: ${result.error ?? `HTTP ${result.statusCode}`}`);
      }
    }
  }, workOptions);
}
