/**
 * Action request/response transformation engine.
 *
 * Supports simple template interpolation with `{{$variable.path}}` syntax:
 * - `{{$body.field}}` — reference request/response body fields
 * - `{{$body.input.nested.field}}` — nested field access
 * - `{{$session_variables.x-hasura-user-id}}` — session variable
 * - `{{$base_url}}` — the base URL from the action handler config
 *
 * Templates can be strings (interpolated) or objects/arrays (recursively processed).
 */

import type { RequestTransform, ResponseTransform } from '../types.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface OriginalRequest {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

export interface TransformContext {
  sessionVariables: Record<string, string>;
  baseUrl: string;
}

export interface TransformedRequest {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

// ─── Path Access ────────────────────────────────────────────────────────────

/**
 * Access a nested value from an object using dot-notation path.
 * Returns `null` for missing paths.
 */
function getByPath(obj: unknown, path: string): unknown {
  if (obj === null || obj === undefined) return null;

  const segments = path.split('.');
  let current: unknown = obj;

  for (const segment of segments) {
    if (current === null || current === undefined) return null;
    if (typeof current !== 'object') return null;
    current = (current as Record<string, unknown>)[segment];
  }

  return current ?? null;
}

// ─── Template Variables ─────────────────────────────────────────────────────

/**
 * Build the variable context available to templates.
 */
function buildVariables(
  body: unknown,
  context: TransformContext,
): Record<string, unknown> {
  return {
    $body: body,
    $session_variables: context.sessionVariables,
    $base_url: context.baseUrl,
  };
}

// ─── Template Interpolation ─────────────────────────────────────────────────

/** Regex to match `{{$variable.path}}` placeholders. */
const TEMPLATE_RE = /\{\{(\$[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_\-]+)*)\}\}/g;

/**
 * Resolve a single template variable reference (e.g., `$body.input.amount`).
 */
function resolveVariable(ref: string, variables: Record<string, unknown>): unknown {
  // Handle top-level variables like `$base_url`
  if (ref in variables) {
    return variables[ref];
  }

  // Handle dotted paths like `$body.input.amount`
  const dotIndex = ref.indexOf('.');
  if (dotIndex === -1) {
    return null;
  }

  const rootKey = ref.substring(0, dotIndex);
  const restPath = ref.substring(dotIndex + 1);
  const root = variables[rootKey];

  return getByPath(root, restPath);
}

/**
 * Interpolate a string template, replacing `{{$var.path}}` with resolved values.
 *
 * If the entire string is a single template expression (e.g., `"{{$body.input}}"`),
 * the resolved value is returned as-is (preserving its original type).
 * Otherwise, all placeholders are stringified and concatenated.
 */
export function interpolateString(
  template: string,
  variables: Record<string, unknown>,
): unknown {
  // Check if the entire string is a single template expression
  const trimmed = template.trim();
  const singleMatch = /^\{\{(\$[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_\-]+)*)\}\}$/.exec(trimmed);
  if (singleMatch) {
    return resolveVariable(singleMatch[1], variables);
  }

  // Multiple or partial — string interpolation
  return template.replace(TEMPLATE_RE, (_match, ref: string) => {
    const value = resolveVariable(ref, variables);
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  });
}

/**
 * Recursively interpolate a template value (string, object, or array).
 * Non-template primitives are returned as-is.
 */
export function interpolateTemplate(
  template: unknown,
  variables: Record<string, unknown>,
): unknown {
  if (typeof template === 'string') {
    return interpolateString(template, variables);
  }

  if (Array.isArray(template)) {
    return template.map((item) => interpolateTemplate(item, variables));
  }

  if (template !== null && typeof template === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(template as Record<string, unknown>)) {
      result[key] = interpolateTemplate(value, variables);
    }
    return result;
  }

  // number, boolean, null — pass through
  return template;
}

// ─── Path Traversal Protection ──────────────────────────────────────────────

/**
 * Validate that a URL does not contain path traversal patterns.
 * Throws an error if `..` segments are found in the URL path.
 *
 * Checks both the raw URL string and the decoded form to catch
 * encoded traversal patterns like `%2e%2e`.
 */
export function validateUrlSafe(url: string): void {
  // Check the raw URL string for ".." path segments (before URL constructor
  // normalizes them away). We extract the path portion (between scheme+authority
  // and any query/fragment) to avoid false positives on ".." in query params.
  try {
    const parsed = new URL(url);
    // Check the raw path portion from the original URL string.
    // The URL constructor normalizes ".." away, so we need to inspect
    // the raw string to detect traversal attempts.
    const rawPath = url.slice(
      url.indexOf(parsed.host) + parsed.host.length,
      url.includes('?') ? url.indexOf('?') : url.includes('#') ? url.indexOf('#') : url.length,
    );
    const decodedRawPath = decodeURIComponent(rawPath);
    const segments = decodedRawPath.split('/');
    for (const segment of segments) {
      if (segment === '..') {
        throw new Error(`Path traversal detected in URL: "${url}"`);
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Path traversal')) {
      throw err;
    }
    // If URL parsing fails, it's not a valid URL — let it through
    // and let the HTTP client handle the error downstream.
  }
}

// ─── Request Transform ──────────────────────────────────────────────────────

/**
 * Apply a request transform to modify the outgoing webhook request.
 *
 * Transforms URL, method, body, headers, and query parameters.
 * All string values support `{{$variable.path}}` template interpolation.
 */
export function applyRequestTransform(
  transform: RequestTransform,
  originalRequest: OriginalRequest,
  context: TransformContext,
): TransformedRequest {
  const variables = buildVariables(originalRequest.body, context);

  let url = originalRequest.url;
  let method = originalRequest.method;
  let body: unknown = originalRequest.body;
  const headers = { ...originalRequest.headers };

  // Override method
  if (transform.method) {
    method = transform.method;
  }

  // Override URL with template
  if (transform.url) {
    const resolved = interpolateString(transform.url, variables);
    url = typeof resolved === 'string' ? resolved : String(resolved);
  }

  // Override body with template
  if (transform.body !== undefined) {
    body = interpolateTemplate(transform.body, variables);
  }

  // Override content type
  if (transform.contentType) {
    headers['Content-Type'] = transform.contentType;
  }

  // Add/override query params
  if (transform.queryParams) {
    const urlObj = new URL(url);
    for (const [key, valueTemplate] of Object.entries(transform.queryParams)) {
      const resolved = interpolateString(valueTemplate, variables);
      const stringValue = resolved === null || resolved === undefined
        ? ''
        : typeof resolved === 'object'
          ? JSON.stringify(resolved)
          : String(resolved);
      urlObj.searchParams.set(key, stringValue);
    }
    url = urlObj.toString();
  }

  // Add/override headers
  if (transform.headers) {
    for (const [key, valueTemplate] of Object.entries(transform.headers)) {
      const resolved = interpolateString(valueTemplate, variables);
      headers[key] = resolved === null || resolved === undefined
        ? ''
        : typeof resolved === 'object'
          ? JSON.stringify(resolved)
          : String(resolved);
    }
  }

  // Validate the final URL for path traversal attacks
  validateUrlSafe(url);

  return { url, method, body, headers };
}

// ─── Response Transform ─────────────────────────────────────────────────────

/**
 * Apply a response transform to modify the webhook response body.
 *
 * Only body transformation is supported for responses.
 */
export function applyResponseTransform(
  transform: ResponseTransform,
  responseBody: unknown,
  context: { sessionVariables: Record<string, string> },
): unknown {
  if (transform.body === undefined) {
    return responseBody;
  }

  const variables: Record<string, unknown> = {
    $body: responseBody,
    $session_variables: context.sessionVariables,
  };

  return interpolateTemplate(transform.body, variables);
}
