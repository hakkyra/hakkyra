/**
 * Cron trigger worker.
 *
 * Registers pg-boss workers for each cron trigger that deliver
 * webhooks with Hasura-compatible payload format.
 */

import type { Logger } from 'pino';
import type { CronTriggerConfig } from '../types.js';
import type { JobQueue } from '../shared/job-queue/types.js';
import {
  resolveWebhookUrl,
  resolveWebhookHeaders,
} from '../shared/webhook.js';
import { registerWebhookWorker } from '../shared/webhook-worker.js';

/**
 * Build a Hasura-compatible cron trigger webhook payload.
 */
export function buildCronPayload(trigger: CronTriggerConfig, scheduledTime: string): unknown {
  return {
    scheduled_time: scheduledTime,
    payload: trigger.payload ?? null,
    name: trigger.name,
    comment: trigger.comment ?? null,
  };
}

/**
 * Register workers for all cron triggers.
 *
 * Each worker:
 * 1. Resolves the webhook URL and headers
 * 2. Builds a Hasura-compatible payload
 * 3. Delivers the webhook via HTTP POST
 * 4. Throws on failure (job queue handles retry)
 */
export async function registerCronWorkers(
  jobQueue: JobQueue,
  triggers: CronTriggerConfig[],
  logger: Logger,
): Promise<void> {
  for (const trigger of triggers) {
    const queueName = `cron/${trigger.name}`;

    await registerWebhookWorker<Record<string, unknown>>(
      jobQueue,
      logger,
      {
        queueName,
        label: `cron/${trigger.name}`,
        callbacks: {
          resolveWebhook(job) {
            const scheduledTime = job.data?.scheduledTime as string
              ?? new Date().toISOString();

            return {
              url: resolveWebhookUrl(trigger.webhook, trigger.webhookFromEnv),
              headers: resolveWebhookHeaders(trigger.headers),
              payload: buildCronPayload(trigger, scheduledTime),
              timeoutMs: trigger.retryConf?.timeoutSeconds
                ? trigger.retryConf.timeoutSeconds * 1000
                : 30000,
            };
          },

          async onSuccess(_job, _result) {
            // Crons have no DB state to update on success.
            // Logging is handled by the webhook worker factory.
          },

          async onFailure(_job, _result) {
            // Crons have no DB state to update on failure.
            // The factory logs the failure and throws for retry.
            // Previously crons only logged a warning — now error details
            // are logged consistently via the shared factory.
          },
        },
      },
    );
  }
}
