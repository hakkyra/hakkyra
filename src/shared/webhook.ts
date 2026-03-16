/**
 * Shared webhook delivery utility.
 *
 * Used by event triggers, cron triggers, and actions to deliver
 * HTTP webhooks with retry support and Hasura-compatible payloads.
 */

import { lookup } from 'node:dns/promises';
import { isIPv4, isIPv6 } from 'node:net';
import type { WebhookHeader } from '../types.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface WebhookDeliveryOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  payload: unknown;
  timeoutMs?: number;
  /** When true, skip SSRF checks (for development with private URLs). */
  allowPrivateUrls?: boolean;
  /** Maximum response body size in bytes. Defaults to 1MB (1048576). */
  maxResponseBytes?: number;
}

export interface WebhookDeliveryResult {
  success: boolean;
  statusCode?: number;
  body?: string;
  error?: string;
  durationMs: number;
}

// ─── SSRF Prevention ────────────────────────────────────────────────────────

/**
 * Check whether an IP address is a private/reserved address that should be
 * blocked for SSRF prevention.
 *
 * Blocks:
 * - IPv4 loopback (127.0.0.0/8)
 * - IPv4 RFC 1918 (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
 * - IPv4 link-local (169.254.0.0/16)
 * - IPv4 unspecified (0.0.0.0)
 * - IPv6 loopback (::1)
 * - IPv6 unspecified (::)
 * - IPv6 link-local (fe80::/10)
 * - IPv6 unique local (fc00::/7)
 * - IPv4-mapped IPv6 addresses (::ffff:x.x.x.x) where x.x.x.x is private
 */
export function isPrivateIP(ip: string): boolean {
  // Handle IPv4-mapped IPv6 (::ffff:10.0.0.1)
  const v4MappedMatch = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (v4MappedMatch) {
    return isPrivateIPv4(v4MappedMatch[1]);
  }

  if (isIPv4(ip)) {
    return isPrivateIPv4(ip);
  }

  // IPv6 checks
  const normalizedIp = ip.toLowerCase();
  // Loopback
  if (normalizedIp === '::1') return true;
  // Unspecified
  if (normalizedIp === '::') return true;
  // Link-local (fe80::/10)
  if (normalizedIp.startsWith('fe80:') || normalizedIp.startsWith('fe8') ||
      normalizedIp.startsWith('fe9') || normalizedIp.startsWith('fea') ||
      normalizedIp.startsWith('feb')) return true;
  // Unique local (fc00::/7 = fc00-fdff)
  if (normalizedIp.startsWith('fc') || normalizedIp.startsWith('fd')) return true;

  return false;
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => isNaN(p))) return false;
  const [a, b] = parts;
  // Loopback 127.0.0.0/8
  if (a === 127) return true;
  // Unspecified
  if (a === 0) return true;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // Link-local 169.254.0.0/16
  if (a === 169 && b === 254) return true;
  return false;
}

/**
 * Validate a webhook URL hostname for SSRF. Resolves DNS and checks if the IP is private.
 * @throws Error if the hostname resolves to a private IP.
 */
async function validateWebhookUrl(url: string): Promise<void> {
  let hostname: string;
  try {
    const parsed = new URL(url);
    hostname = parsed.hostname;
    // Remove brackets from IPv6 literal
    if (hostname.startsWith('[') && hostname.endsWith(']')) {
      hostname = hostname.slice(1, -1);
    }
  } catch {
    throw new Error(`Invalid webhook URL: ${url}`);
  }

  // Check if hostname is a raw IP first
  if (isPrivateIP(hostname)) {
    throw new Error(`Webhook URL resolves to a private/reserved IP address: ${hostname}`);
  }

  // DNS resolution
  try {
    const result = await lookup(hostname, { all: true });
    const addresses = Array.isArray(result) ? result : [result];
    for (const entry of addresses) {
      if (isPrivateIP(entry.address)) {
        throw new Error(
          `Webhook URL hostname "${hostname}" resolves to private/reserved IP: ${entry.address}`,
        );
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('private/reserved')) {
      throw err;
    }
    // DNS resolution failures are allowed to pass through — the fetch call
    // will fail with a more descriptive error.
  }
}

/**
 * Resolve DNS for a webhook URL and return a version of the URL that connects
 * directly to the validated IP address, plus the original Host header value.
 *
 * This prevents DNS rebinding attacks (TOCTOU) by resolving DNS once, validating
 * the IP, and then replacing the hostname in the URL with the validated IP so the
 * HTTP client connects to that exact IP without a second DNS lookup.
 *
 * @returns Object with `resolvedUrl` (hostname replaced with IP) and `hostHeader`
 *          (original hostname for the Host header), or null if the hostname is
 *          already a raw IP address.
 * @throws Error if the resolved IP is private/reserved.
 */
export async function resolveAndValidateDns(
  url: string,
  /** @internal Injectable DNS lookup for testing. Defaults to `dns.promises.lookup`. */
  lookupFn?: (hostname: string, options: { all: true }) => Promise<Array<{ address: string; family: number }>>,
): Promise<{
  resolvedUrl: string;
  hostHeader: string;
} | null> {
  const resolveDns = lookupFn ?? (async (h: string, opts: { all: true }) => {
    const result = await lookup(h, opts);
    return Array.isArray(result) ? result : [result];
  });

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid webhook URL: ${url}`);
  }

  let hostname = parsed.hostname;
  // Remove brackets from IPv6 literal
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    hostname = hostname.slice(1, -1);
  }

  // If the hostname is already a raw IP, just validate it and return null
  // (no DNS resolution needed, no rebinding possible).
  if (isIPv4(hostname) || isIPv6(hostname)) {
    if (isPrivateIP(hostname)) {
      throw new Error(`Webhook URL resolves to a private/reserved IP address: ${hostname}`);
    }
    return null;
  }

  // Resolve DNS
  let resolvedAddress: string;
  try {
    const addresses = await resolveDns(hostname, { all: true });

    // Validate ALL resolved addresses
    for (const entry of addresses) {
      if (isPrivateIP(entry.address)) {
        throw new Error(
          `Webhook URL hostname "${hostname}" resolves to private/reserved IP: ${entry.address}`,
        );
      }
    }

    // Use the first resolved address for the connection
    resolvedAddress = addresses[0].address;
  } catch (err) {
    if (err instanceof Error && err.message.includes('private/reserved')) {
      throw err;
    }
    // DNS resolution failures — fall back to pre-flight validation only.
    // The fetch call will perform its own DNS and fail with a descriptive error.
    await validateWebhookUrl(url);
    return null;
  }

  // Build a new URL with the resolved IP replacing the hostname.
  // This ensures the HTTP client connects to the validated IP directly,
  // preventing a second DNS lookup that could return a different (private) IP.
  const originalHost = parsed.host; // includes port if non-default
  const isIPv6Address = resolvedAddress.includes(':');

  // Use URL constructor to safely replace the hostname
  const pinnedUrl = new URL(url);
  pinnedUrl.hostname = isIPv6Address ? `[${resolvedAddress}]` : resolvedAddress;
  const resolvedUrl = pinnedUrl.toString();

  // The Host header must be the original hostname so the target server
  // can route the request correctly (virtual hosting, SNI, etc.)
  return { resolvedUrl, hostHeader: originalHost };
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
  // Resolve Hasura-style {{ENV_VAR}} templates in the URL
  return webhook.replace(/\{\{(\w+)\}\}/g, (_match, envName) => {
    return process.env[envName] ?? '';
  });
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

// ─── Response Body Reader ──────────────────────────────────────────────────

/**
 * Read a response body with a size limit. If the body exceeds the limit,
 * the reading is aborted and an error is thrown.
 */
async function readResponseBody(response: Response, maxBytes: number): Promise<string> {
  // If no body, return empty
  if (!response.body) {
    return response.text();
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        reader.cancel().catch(() => {});
        throw new Error(
          `Webhook response body exceeded maximum size of ${maxBytes} bytes`,
        );
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    // Flush the decoder
    chunks.push(decoder.decode());
  } catch (err) {
    reader.cancel().catch(() => {});
    throw err;
  }

  return chunks.join('');
}

// ─── Module-level webhook security defaults ────────────────────────────────

let _allowPrivateUrls = process.env['NODE_ENV'] === 'test';
let _maxResponseBytes = 1048576; // 1MB

/**
 * Configure global webhook security defaults.
 * Called once at server startup with values from the config.
 */
export function configureWebhookDefaults(options: {
  allowPrivateUrls?: boolean;
  maxResponseBytes?: number;
}): void {
  if (options.allowPrivateUrls !== undefined) {
    _allowPrivateUrls = options.allowPrivateUrls;
  }
  if (options.maxResponseBytes !== undefined) {
    _maxResponseBytes = options.maxResponseBytes;
  }
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
    allowPrivateUrls = _allowPrivateUrls,
    maxResponseBytes = _maxResponseBytes,
  } = options;

  const start = performance.now();

  try {
    // SSRF prevention: resolve DNS and pin to validated IP to prevent DNS rebinding.
    // The resolved URL connects directly to the validated IP, and the original
    // Host header is preserved for correct server-side routing.
    let fetchUrl = url;
    const fetchHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      ...headers,
    };

    if (!allowPrivateUrls) {
      const pinned = await resolveAndValidateDns(url);
      if (pinned) {
        fetchUrl = pinned.resolvedUrl;
        fetchHeaders['Host'] = pinned.hostHeader;
      }
    }

    const response = await fetch(fetchUrl, {
      method,
      headers: fetchHeaders,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const body = await readResponseBody(response, maxResponseBytes);
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
