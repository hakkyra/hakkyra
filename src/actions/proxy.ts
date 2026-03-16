/**
 * Action webhook proxy.
 *
 * Forwards action input + session variables to the configured handler URL
 * using a Hasura-compatible payload format, and returns the parsed response.
 */

import type { ActionConfig, SessionVariables } from '../types.js';
import {
  deliverWebhook,
  resolveWebhookUrl,
  resolveWebhookHeaders,
} from '../shared/webhook.js';
import { applyRequestTransform, applyResponseTransform } from './transform.js';

// ─── Error Sanitization ─────────────────────────────────────────────────────

/** Max length for webhook error messages returned to clients. */
const MAX_ERROR_LENGTH = 500;

/**
 * Patterns that indicate internal details that should not be exposed:
 * - Stack traces (e.g., "at Module._compile (/app/src/...)")
 * - File paths (e.g., "/home/user/app/src/handler.ts:42:10")
 * - Connection strings (e.g., "postgres://user:pass@host/db")
 * - URLs with embedded credentials (e.g., "https://user:secret@host")
 */
const SENSITIVE_PATTERNS = [
  /\bat\s+\S+\s+\(.*:\d+:\d+\)/g,           // stack trace lines
  /(?:\/[\w.-]+){3,}(?::\d+){0,2}/g,         // absolute file paths (3+ segments)
  /(?:postgres|mysql|mongodb|redis|amqp|https?):\/\/[^\s]*@[^\s]*/gi,  // connection strings / URLs with credentials
];

/**
 * Sanitize a webhook error message for safe client exposure.
 *
 * In dev mode (NODE_ENV !== 'production'), the original message is returned as-is
 * for debugging convenience. In production mode:
 * - Stack traces, file paths, and credential-bearing URLs are stripped
 * - The message is truncated to 500 characters
 */
export function sanitizeWebhookError(message: string): string {
  if (process.env['NODE_ENV'] !== 'production') {
    return message;
  }

  let sanitized = message;

  for (const pattern of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[redacted]');
  }

  // Collapse multiple consecutive [redacted] markers
  sanitized = sanitized.replace(/(\[redacted\]\s*){2,}/g, '[redacted] ');

  // Trim whitespace and truncate
  sanitized = sanitized.trim();
  if (sanitized.length > MAX_ERROR_LENGTH) {
    sanitized = sanitized.slice(0, MAX_ERROR_LENGTH - 3) + '...';
  }

  return sanitized;
}

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ActionExecutionOptions {
  action: ActionConfig;
  input: Record<string, unknown>;
  session: SessionVariables;
  requestQuery?: string;
  clientHeaders?: Record<string, string>;
}

export interface ActionResult {
  success: boolean;
  data?: unknown;
  error?: string;
  extensions?: Record<string, unknown>;
}

// ─── Execution ──────────────────────────────────────────────────────────────

/**
 * Execute an action by proxying to the configured webhook handler.
 *
 * Builds a Hasura-compatible action webhook payload:
 * ```json
 * {
 *   "action": { "name": "actionName" },
 *   "input": { ... },
 *   "session_variables": { "x-hasura-role": "...", ... },
 *   "request_query": "..."
 * }
 * ```
 */
export async function executeAction(options: ActionExecutionOptions): Promise<ActionResult> {
  const { action, input, session, requestQuery, clientHeaders } = options;

  // Resolve handler URL
  const url = resolveWebhookUrl(
    action.definition.handler,
    action.definition.handlerFromEnv,
  );

  if (!url) {
    return {
      success: false,
      error: `No handler URL configured for action "${action.name}"`,
    };
  }

  // Build session variables map (Hasura format)
  const sessionVariables: Record<string, string> = {};
  for (const [key, value] of Object.entries(session.claims)) {
    sessionVariables[key] = Array.isArray(value) ? value.join(',') : value;
  }
  if (session.role) {
    sessionVariables['x-hasura-role'] = session.role;
  }

  // Build Hasura-compatible payload
  const payload = {
    action: { name: action.name },
    input,
    session_variables: sessionVariables,
    request_query: requestQuery ?? '',
  };

  // Resolve configured headers
  const configuredHeaders = resolveWebhookHeaders(action.definition.headers);

  // Merge client headers if forwarding is enabled
  const headers: Record<string, string> = { ...configuredHeaders };
  if (action.definition.forwardClientHeaders && clientHeaders) {
    for (const [key, value] of Object.entries(clientHeaders)) {
      // Don't override configured headers; skip hop-by-hop headers
      const lk = key.toLowerCase();
      if (!(key in headers) && lk !== 'host' && lk !== 'content-length' && lk !== 'content-type') {
        headers[key] = value;
      }
    }
  }

  // Apply request transform if configured
  let finalUrl = url;
  let finalMethod = 'POST';
  let finalBody: unknown = payload;
  let finalHeaders = headers;

  if (action.requestTransform) {
    const transformed = applyRequestTransform(
      action.requestTransform,
      { url, method: 'POST', body: payload, headers },
      { sessionVariables, baseUrl: url },
    );
    finalUrl = transformed.url;
    finalMethod = transformed.method;
    finalBody = transformed.body;
    finalHeaders = transformed.headers;
  }

  // Deliver webhook
  const timeoutMs = (action.definition.timeout ?? 30) * 1000;
  const result = await deliverWebhook({
    url: finalUrl,
    method: finalMethod,
    headers: finalHeaders,
    payload: finalBody,
    timeoutMs,
  });

  if (!result.success) {
    // Try to parse error from response body
    let errorMessage = result.error ?? `Action handler returned ${result.statusCode}`;
    if (result.body) {
      try {
        const parsed = JSON.parse(result.body);
        if (parsed.message) errorMessage = parsed.message;
        else if (parsed.error) errorMessage = parsed.error;
      } catch {
        // body is not JSON — use raw
      }
    }
    return {
      success: false,
      error: sanitizeWebhookError(errorMessage),
      extensions: result.statusCode ? { statusCode: result.statusCode } : undefined,
    };
  }

  // Parse successful response
  try {
    let data = result.body ? JSON.parse(result.body) : null;

    // Apply response transform if configured
    if (action.responseTransform) {
      data = applyResponseTransform(
        action.responseTransform,
        data,
        { sessionVariables },
      );
    }

    return { success: true, data };
  } catch {
    return {
      success: false,
      error: 'Action handler returned invalid JSON',
    };
  }
}
