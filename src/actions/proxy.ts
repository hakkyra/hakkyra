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
      error: errorMessage,
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
