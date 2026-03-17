/**
 * Kriti template language integration using the kriti-lang package.
 *
 * Wraps the kriti-lang `evaluate()` function for use in Hakkyra action
 * transforms, adding:
 * - Per-field evaluation for object/array body templates
 * - Automatic quoting of mixed text+expression templates
 * - URL template evaluation with path traversal protection
 * - Graceful error handling (null for missing paths)
 */

import { evaluate } from 'kriti-lang';

type KritiVars = NonNullable<Parameters<typeof evaluate>[1]>;
type KritiContext = Record<string, unknown>;

// ─── String Evaluation ──────────────────────────────────────────────────────

/**
 * Check if a template is a single `{{ expression }}` with nothing outside it.
 * Uses a count-based check rather than regex to avoid greedy matching issues.
 */
function isSingleExpression(s: string): boolean {
  const first = s.indexOf('{{');
  if (first !== 0) return false;
  const last = s.lastIndexOf('}}');
  if (last !== s.length - 2) return false;
  // Ensure there's only one {{ }} pair
  const secondOpen = s.indexOf('{{', first + 2);
  return secondOpen === -1 || secondOpen >= last;
}

/**
 * Evaluate a Kriti string template using kriti-lang.
 *
 * Handles three cases:
 * 1. No `{{` at all → return the raw string (static value)
 * 2. Entire string is a single `{{ expression }}` → evaluate, return typed value
 * 3. Mixed literal text + expressions → wrap in quotes so kriti-lang treats it
 *    as a string interpolation template, then evaluate
 */
export function evaluateKritiString(
  template: string,
  context: KritiContext,
): unknown {
  const trimmed = template.trim();
  if (!trimmed) return '';

  // No Kriti expressions → return as-is
  if (!trimmed.includes('{{')) return template;

  // Single expression → evaluate directly (preserves typed value)
  if (isSingleExpression(trimmed)) {
    try {
      return evaluate(trimmed, context as KritiVars);
    } catch {
      return null;
    }
  }

  // Multi-expression or mixed template. First try evaluating directly — this
  // handles conditionals, range loops, and other complex Kriti structures.
  try {
    return evaluate(trimmed, context as KritiVars);
  } catch {
    // Direct evaluation failed (likely because there's literal text outside
    // {{ }} blocks). Wrap in quotes for kriti-lang string interpolation.
  }

  const escaped = trimmed.replace(/(?<!\{)\"/g, (match, offset: number) => {
    // Don't escape quotes that are inside {{ }} blocks
    const before = trimmed.slice(0, offset);
    const opens = (before.match(/\{\{/g) || []).length;
    const closes = (before.match(/\}\}/g) || []).length;
    return opens > closes ? match : `\\"`;
  });

  try {
    return evaluate(`"${escaped}"`, context as KritiVars);
  } catch {
    return null;
  }
}

// ─── Template Object/Array Evaluation ───────────────────────────────────────

/**
 * Recursively evaluate a Kriti template value (string, object, or array).
 * Non-template primitives are returned as-is.
 */
export function evaluateKritiTemplate(
  template: unknown,
  context: KritiContext,
): unknown {
  if (typeof template === 'string') {
    return evaluateKritiString(template, context);
  }

  if (Array.isArray(template)) {
    return template.map((item) => evaluateKritiTemplate(item, context));
  }

  if (template !== null && typeof template === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(
      template as Record<string, unknown>,
    )) {
      result[key] = evaluateKritiTemplate(value, context);
    }
    return result;
  }

  // number, boolean, null — pass through
  return template;
}

// ─── URL Template Evaluation ────────────────────────────────────────────────

/** Regex matching `{{ expression }}` blocks for URL template scanning. */
const KRITI_BLOCK_RE = /\{\{(.*?)\}\}/gs;

/**
 * Evaluate a Kriti URL template with path traversal protection.
 *
 * For URL templates, we evaluate each `{{ expression }}` individually and
 * apply encodeURIComponent to user-controlled values while leaving trusted
 * values ($base_url) unencoded.
 *
 * If the entire template is a single expression, the result is returned as-is
 * (it represents the full URL, not a path segment).
 */
export function evaluateKritiUrlTemplate(
  template: string,
  context: KritiContext,
): string {
  const trimmed = template.trim();

  // If the entire string is a single expression, resolve directly
  if (isSingleExpression(trimmed)) {
    try {
      const value = evaluate(trimmed, context as KritiVars);
      if (value === null || value === undefined) return '';
      if (typeof value === 'object') return JSON.stringify(value);
      return String(value);
    } catch {
      return '';
    }
  }

  // Multiple or partial — evaluate each expression individually and encode
  // user-controlled values to prevent path injection.
  return template.replace(KRITI_BLOCK_RE, (_fullMatch, expr: string) => {
    const exprTrimmed = expr.trim();

    let value: unknown;
    try {
      value = evaluate(`{{${expr}}}`, context as KritiVars);
    } catch {
      return '';
    }

    if (value === null || value === undefined) return '';
    const stringValue =
      typeof value === 'object' ? JSON.stringify(value) : String(value);

    // $base_url is a trusted server config value — do not encode
    if (exprTrimmed === '$base_url') {
      return stringValue;
    }

    // Encode and check for path traversal
    const encoded = encodeURIComponent(stringValue);
    const encodedSegments = encoded.split('%2F');
    for (const seg of encodedSegments) {
      const decoded = decodeURIComponent(seg);
      if (decoded === '..' || decoded === '.') {
        throw new Error(
          `Path traversal detected in interpolated URL value: "${stringValue}"`,
        );
      }
    }

    return encoded;
  });
}
