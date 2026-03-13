/**
 * Cron trigger worker.
 *
 * Registers pg-boss workers for each cron trigger that deliver
 * webhooks with Hasura-compatible payload format.
 */

import type { Logger } from 'pino';
import type { CronTriggerConfig } from '../types.js';
import type { JobQueue, Job } from '../shared/job-queue/types.js';
import {
  deliverWebhook,
  resolveWebhookUrl,
  resolveWebhookHeaders,
} from '../shared/webhook.js';

/**
 * Build a Hasura-compatible cron trigger webhook payload.
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
    const queueName = `cron:${trigger.name}`;

    await jobQueue.work<Record<string, unknown>>(queueName, async (jobs: Job<Record<string, unknown>>[]) => {
      for (const job of jobs) {
        const url = resolveWebhookUrl(trigger.webhook, trigger.webhookFromEnv);
        const headers = resolveWebhookHeaders(trigger.headers);
        const scheduledTime = job.data?.scheduledTime as string
          ?? new Date().toISOString();

        const payload = buildCronPayload(trigger, scheduledTime);

        logger.info(
          { trigger: trigger.name, url, jobId: job.id },
          'Delivering cron trigger webhook',
        );

        const result = await deliverWebhook({
          url,
          headers,
          payload,
          timeoutMs: trigger.retryConf?.timeoutSeconds
            ? trigger.retryConf.timeoutSeconds * 1000
            : 30000,
        });

        if (!result.success) {
          logger.warn(
            {
              trigger: trigger.name,
              statusCode: result.statusCode,
              error: result.error,
              durationMs: result.durationMs,
            },
            'Cron trigger webhook delivery failed',
          );
          throw new Error(
            `Webhook delivery failed: ${result.error ?? `HTTP ${result.statusCode}`}`,
          );
        }

        logger.info(
          {
            trigger: trigger.name,
            statusCode: result.statusCode,
            durationMs: result.durationMs,
          },
          'Cron trigger webhook delivered successfully',
        );
      }
    });
  }
}
