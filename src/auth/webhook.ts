/**
 * Webhook-based authentication.
 *
 * An alternative to JWT — when configured, request headers are forwarded
 * to a webhook URL which returns Hasura-compatible session variables.
 *
 * Supports:
 * - GET mode: forward headers as request headers to the webhook
 * - POST mode: forward headers as JSON body to the webhook
 * - Simple in-memory cache with configurable TTL
 * - Timeout handling (default 5s)
 * - Configurable session variable namespace
 */

import { createHash } from 'node:crypto';
import type { AuthConfig, SessionVariables } from '../types.js';
import {
  DEFAULT_SESSION_NAMESPACE,
  WELL_KNOWN_SUFFIXES,
  nsKey,
} from './session-namespace.js';

export type WebhookAuthConfig = NonNullable<AuthConfig['webhook']>;

export interface WebhookAuthenticator {
  authenticate(headers: Record<string, string>): Promise<SessionVariables>;
}

/** Default timeout for webhook requests in milliseconds. */
const DEFAULT_TIMEOUT_MS = 5_000;

// ─── Cache ──────────────────────────────────────────────────────────────────

interface CacheEntry {
  session: SessionVariables;
  expiresAt: number;
}

/**
 * Simple in-memory TTL cache keyed by a hash of the forwarded headers.
 */
class SessionCache {
  private readonly store = new Map<string, CacheEntry>();
  private readonly ttlMs: number;

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
  }

  get enabled(): boolean {
    return this.ttlMs > 0;
  }

  get(key: string): SessionVariables | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;

    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }

    return entry.session;
  }

  set(key: string, session: SessionVariables): void {
    this.store.set(key, {
      session,
      expiresAt: Date.now() + this.ttlMs,
    });
  }
}

/**
 * Compute a deterministic cache key from the headers object.
 */
function computeCacheKey(headers: Record<string, string>): string {
  const sorted = Object.keys(headers)
    .sort()
    .map((k) => `${k}:${headers[k]}`)
    .join('\n');

  return createHash('sha256').update(sorted).digest('hex');
}

// ─── Response parsing ───────────────────────────────────────────────────────

/**
 * Parse the webhook response body into SessionVariables.
 *
 * Webhook responses use the Hasura convention with `X-Hasura-*` keys.
 * The parser accepts both `X-Hasura-*` and `{ns}-*` keys, normalizing
 * claim keys to lowercase.
 *
 * Expected format (Hasura-compatible):
 * ```json
 * {
 *   "X-Hasura-Role": "user",
 *   "X-Hasura-User-Id": "42",
 *   "X-Hasura-Allowed-Roles": ["user", "editor"]
 * }
 * ```
 */
function parseWebhookResponse(body: Record<string, unknown>, sessionNs: string): SessionVariables {
  const claims: Record<string, string | string[]> = {};

  for (const [key, value] of Object.entries(body)) {
    const normalizedKey = key.toLowerCase();
    if (Array.isArray(value)) {
      claims[normalizedKey] = value.map(String);
    } else if (value !== undefined && value !== null) {
      claims[normalizedKey] = String(value);
    }
  }

  // Helper to find a claim by suffix, trying both configured namespace and x-hasura
  function findClaim(suffix: string): string | string[] | undefined {
    const nsLookup = nsKey(sessionNs, suffix);
    if (claims[nsLookup] !== undefined) return claims[nsLookup];
    const hasuraLookup = `x-hasura-${suffix}`;
    if (claims[hasuraLookup] !== undefined) return claims[hasuraLookup];
    return undefined;
  }

  // ── Validate required claims ──────────────────────────────────────────
  const allowedRolesValue = findClaim(WELL_KNOWN_SUFFIXES.ALLOWED_ROLES);
  if (!allowedRolesValue) {
    throw new Error(`Webhook response missing required "${nsKey(sessionNs, WELL_KNOWN_SUFFIXES.ALLOWED_ROLES)}" (or "X-Hasura-Allowed-Roles")`);
  }
  const allowedRoles = Array.isArray(allowedRolesValue)
    ? allowedRolesValue
    : [allowedRolesValue];

  const defaultRole = findClaim(WELL_KNOWN_SUFFIXES.ROLE);
  if (!defaultRole) {
    throw new Error(`Webhook response missing required "${nsKey(sessionNs, WELL_KNOWN_SUFFIXES.ROLE)}" (or "X-Hasura-Role")`);
  }
  const role = Array.isArray(defaultRole) ? defaultRole[0] : defaultRole;

  const userIdValue = findClaim(WELL_KNOWN_SUFFIXES.USER_ID);
  const userId = userIdValue
    ? (Array.isArray(userIdValue) ? userIdValue[0] : userIdValue)
    : undefined;

  return {
    role,
    userId,
    allowedRoles,
    isAdmin: false,
    claims,
  };
}

// ─── Authenticator factory ──────────────────────────────────────────────────

export interface WebhookAuthOptions {
  /** Cache TTL in milliseconds (default 0 = no cache). */
  cacheTtlMs?: number;
  /** Request timeout in milliseconds (default 5000). */
  timeoutMs?: number;
  /** Session variable namespace (default 'x-hk'). */
  sessionNamespace?: string;
}

/**
 * Resolve the webhook URL from the config — supports `urlFromEnv` indirection.
 */
function resolveWebhookUrl(config: WebhookAuthConfig): string {
  if (config.urlFromEnv) {
    const envValue = process.env[config.urlFromEnv];
    if (!envValue) {
      throw new Error(
        `Environment variable "${config.urlFromEnv}" is not set (required for webhook auth URL)`,
      );
    }
    return envValue;
  }
  return config.url;
}

/**
 * Create a webhook authenticator from the authentication configuration.
 *
 * Usage:
 * ```ts
 * const authenticator = createWebhookAuthenticator(config.auth.webhook);
 * const session = await authenticator.authenticate(requestHeaders);
 * ```
 */
export function createWebhookAuthenticator(
  config: WebhookAuthConfig,
  options: WebhookAuthOptions = {},
): WebhookAuthenticator {
  const url = resolveWebhookUrl(config);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cache = new SessionCache(options.cacheTtlMs ?? 0);
  const sessionNs = options.sessionNamespace ?? DEFAULT_SESSION_NAMESPACE;

  return {
    async authenticate(headers: Record<string, string>): Promise<SessionVariables> {
      // ── Check cache ─────────────────────────────────────────────────
      if (cache.enabled) {
        const cacheKey = computeCacheKey(headers);
        const cached = cache.get(cacheKey);
        if (cached) return cached;
      }

      // ── Build and execute the request ───────────────────────────────
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let response: Response;
      try {
        if (config.mode === 'GET') {
          response = await fetch(url, {
            method: 'GET',
            headers,
            signal: controller.signal,
          });
        } else {
          response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(headers),
            signal: controller.signal,
          });
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          throw new Error(`Webhook auth request timed out after ${timeoutMs}ms`);
        }
        throw new Error(
          `Webhook auth request failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        clearTimeout(timer);
      }

      // ── Validate response ───────────────────────────────────────────
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(
          `Webhook returned HTTP ${response.status}${text ? `: ${text}` : ''}`,
        );
      }

      let body: Record<string, unknown>;
      try {
        body = (await response.json()) as Record<string, unknown>;
      } catch {
        throw new Error('Webhook returned invalid JSON');
      }

      const session = parseWebhookResponse(body, sessionNs);

      // ── Populate cache ──────────────────────────────────────────────
      if (cache.enabled) {
        cache.set(computeCacheKey(headers), session);
      }

      return session;
    },
  };
}
