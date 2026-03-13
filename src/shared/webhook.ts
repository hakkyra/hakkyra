/**
 * Shared webhook delivery utility.
 *
 * Used by event triggers, cron triggers, and actions to deliver
 * HTTP webhooks with retry support and Hasura-compatible payloads.
 */

import type { WebhookHeader } from '../types.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface WebhookDeliveryOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  payload: unknown;
  timeoutMs?: number;
}

export interface WebhookDeliveryResult {
  success: boolean;
  statusCode?: number;
  body?: string;
  error?: string;
  durationMs: number;
}

// ─── Webhook URL resolution ────────────────────────────────────────────────

/**
 * Resolve a webhook URL, preferring env var if specified.
 */
export function resolveWebhookUrl(webhook: string, webhookFromEnv?: string): string {
  if (webhookFromEnv) {
    const envValue = process.env[webhookFromEnv];
    if (envValue) return envValue;
  }
  return webhook;
}

/**
 * Resolve webhook headers, substituting env var references.
 */
export function resolveWebhookHeaders(headers?: WebhookHeader[]): Record<string, string> {
  if (!headers || headers.length === 0) return {};

  const resolved: Record<string, string> = {};
  for (const header of headers) {
    if (header.valueFromEnv) {
      const envValue = process.env[header.valueFromEnv];
      if (envValue) {
        resolved[header.name] = envValue;
      }
    } else if (header.value) {
      resolved[header.name] = header.value;
    }
  }
  return resolved;
}

// ─── Delivery ──────────────────────────────────────────────────────────────

/**
 * Deliver a webhook HTTP POST with JSON payload.
 *
 * Returns a structured result indicating success/failure, status code,
 * response body, and timing information.
 */
export async function deliverWebhook(options: WebhookDeliveryOptions): Promise<WebhookDeliveryResult> {
  const {
    url,
    method = 'POST',
    headers = {},
    payload,
    timeoutMs = 30000,
  } = options;

  const start = performance.now();

  try {
    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const body = await response.text();
    const durationMs = Math.round(performance.now() - start);

    return {
      success: response.ok,
      statusCode: response.status,
      body,
      durationMs,
    };
  } catch (err) {
    const durationMs = Math.round(performance.now() - start);
    const error = err instanceof Error ? err.message : String(err);

    return {
      success: false,
      error,
      durationMs,
    };
  }
}

// ─── Retry helpers ─────────────────────────────────────────────────────────

/**
 * Calculate exponential backoff delay for a retry attempt.
 *
 * @param attempt - The retry attempt number (0-based)
 * @param baseIntervalSec - Base interval in seconds
 * @param capSeconds - Maximum backoff cap in seconds (default: 3600)
 * @returns Delay in milliseconds
 */
export function calculateBackoffMs(attempt: number, baseIntervalSec: number, capSeconds: number = 3600): number {
  // Exponential backoff: base * 2^attempt, capped at capSeconds
  const delaySec = Math.min(baseIntervalSec * Math.pow(2, attempt), capSeconds);
  return delaySec * 1000;
}
