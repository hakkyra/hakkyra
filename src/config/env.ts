/**
 * Environment variable validation.
 *
 * Checks that all environment variables referenced in the config are
 * actually set before the server starts, providing a clear fail-fast
 * error listing every missing variable at once.
 */

import type { HakkyraConfig, WebhookHeader } from '../types.js';

export interface EnvValidationResult {
  valid: boolean;
  missing: string[];
  warnings: string[];
}

/**
 * Validate that all required environment variables referenced in
 * the configuration are defined and non-empty in process.env.
 */
export function validateEnvironment(config: HakkyraConfig): EnvValidationResult {
  const missing: string[] = [];
  const warnings: string[] = [];

  // ── Primary database URL ──────────────────────────────────────────────
  checkRequired(config.databases.primary.urlEnv, 'databases.primary.urlEnv', missing);

  // ── Replica database URLs ─────────────────────────────────────────────
  if (config.databases.replicas) {
    for (let i = 0; i < config.databases.replicas.length; i++) {
      checkRequired(
        config.databases.replicas[i].urlEnv,
        `databases.replicas[${i}].urlEnv`,
        missing,
      );
    }
  }

  // ── Auth: admin secret ────────────────────────────────────────────────
  if (config.auth.adminSecretEnv) {
    checkRequired(config.auth.adminSecretEnv, 'auth.adminSecretEnv', missing);
  }

  // ── Auth: JWT key (only required when no jwkUrl is set) ───────────────
  if (config.auth.jwt?.keyEnv && !config.auth.jwt.jwkUrl) {
    checkRequired(config.auth.jwt.keyEnv, 'auth.jwt.keyEnv', missing);
  }

  // ── Auth: JWT JWK URL from env ─────────────────────────────────────────
  if (config.auth.jwt?.jwkUrlEnv && !config.auth.jwt.jwkUrl) {
    checkRequired(config.auth.jwt.jwkUrlEnv, 'auth.jwt.jwkUrlEnv', missing);
  }

  // ── Auth: webhook URL ─────────────────────────────────────────────────
  if (config.auth.webhook?.urlFromEnv) {
    checkRequired(config.auth.webhook.urlFromEnv, 'auth.webhook.urlFromEnv', missing);
  }

  // ── Redis URL from env ──────────────────────────────────────────────
  if (config.redis?.urlEnv && !config.redis.url) {
    checkRequired(config.redis.urlEnv, 'redis.urlEnv', missing);
  }

  // ── Event triggers ────────────────────────────────────────────────────
  for (const table of config.tables) {
    for (const trigger of table.eventTriggers) {
      if (trigger.webhookFromEnv) {
        checkRequired(
          trigger.webhookFromEnv,
          `event_trigger "${trigger.name}" webhookFromEnv`,
          missing,
        );
      }
      collectHeaderWarnings(trigger.headers, `event_trigger "${trigger.name}"`, warnings);
    }
  }

  // ── Cron triggers ─────────────────────────────────────────────────────
  for (const cron of config.cronTriggers) {
    if (cron.webhookFromEnv) {
      checkRequired(
        cron.webhookFromEnv,
        `cron_trigger "${cron.name}" webhookFromEnv`,
        missing,
      );
    }
    collectHeaderWarnings(cron.headers, `cron_trigger "${cron.name}"`, warnings);
  }

  // ── Actions ───────────────────────────────────────────────────────────
  for (const action of config.actions) {
    if (action.definition.handlerFromEnv) {
      checkRequired(
        action.definition.handlerFromEnv,
        `action "${action.name}" handlerFromEnv`,
        missing,
      );
    }
    collectHeaderWarnings(action.definition.headers, `action "${action.name}"`, warnings);
  }

  return {
    valid: missing.length === 0,
    missing,
    warnings,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function checkRequired(envVar: string, context: string, missing: string[]): void {
  const value = process.env[envVar];
  if (value === undefined || value === '') {
    missing.push(`${envVar} (required by ${context})`);
  }
}

function collectHeaderWarnings(
  headers: WebhookHeader[] | undefined,
  context: string,
  warnings: string[],
): void {
  if (!headers) return;
  for (const header of headers) {
    if (header.valueFromEnv) {
      const value = process.env[header.valueFromEnv];
      if (value === undefined || value === '') {
        warnings.push(
          `${header.valueFromEnv} (header "${header.name}" in ${context}) is not set`,
        );
      }
    }
  }
}
