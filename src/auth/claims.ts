/**
 * Hasura-compatible JWT claims extraction.
 *
 * Supports:
 * - Namespace-based claims (default: `https://hasura.io/jwt/claims`)
 * - `claims_map` for extracting from arbitrary JWT paths
 * - `claims_format: "stringified_json"` (namespace value is a JSON string)
 * - Case-insensitive claim key matching
 */

import type { JWTPayload } from 'jose';
import type { AuthConfig, SessionVariables } from '../types.js';

const DEFAULT_NAMESPACE = 'https://hasura.io/jwt/claims';

/**
 * Resolve a JSONPath-like expression (e.g. `$.user.roles`) against an object.
 *
 * Only supports simple dot-notation paths starting with `$`.
 * Array indexing is not supported — this mirrors Hasura's `claims_map` path semantics.
 */
function resolvePath(obj: unknown, path: string): unknown {
  if (!path.startsWith('$.')) {
    return undefined;
  }

  const segments = path.slice(2).split('.');
  let current: unknown = obj;

  for (const segment of segments) {
    if (current == null || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

/**
 * Build a claims record from a `claims_map` configuration.
 *
 * Each entry in the map specifies a JSON path into the JWT payload
 * and an optional default value.
 */
function extractFromClaimsMap(
  payload: JWTPayload,
  claimsMap: Record<string, { path: string; default?: string }>,
): Record<string, string | string[]> {
  const claims: Record<string, string | string[]> = {};

  for (const [claimKey, mapping] of Object.entries(claimsMap)) {
    const normalizedKey = claimKey.toLowerCase();
    let value = resolvePath(payload, mapping.path);

    if (value === undefined && mapping.default !== undefined) {
      value = mapping.default;
    }

    if (value !== undefined) {
      if (Array.isArray(value)) {
        claims[normalizedKey] = value.map(String);
      } else {
        claims[normalizedKey] = String(value);
      }
    }
  }

  return claims;
}

/**
 * Build a claims record from a namespace within the JWT payload.
 *
 * The namespace value can be either a plain object or a stringified JSON object.
 */
function extractFromNamespace(
  payload: JWTPayload,
  namespace: string,
): Record<string, string | string[]> {
  let namespaceClaims = payload[namespace];

  if (namespaceClaims === undefined) {
    return {};
  }

  // Handle stringified JSON claims format.
  if (typeof namespaceClaims === 'string') {
    try {
      namespaceClaims = JSON.parse(namespaceClaims) as unknown;
    } catch {
      throw new Error(
        `Failed to parse stringified JSON claims from namespace "${namespace}"`,
      );
    }
  }

  if (typeof namespaceClaims !== 'object' || namespaceClaims === null) {
    throw new Error(
      `Claims namespace "${namespace}" must contain an object, got ${typeof namespaceClaims}`,
    );
  }

  const claims: Record<string, string | string[]> = {};

  for (const [key, value] of Object.entries(namespaceClaims as Record<string, unknown>)) {
    const normalizedKey = key.toLowerCase();
    if (Array.isArray(value)) {
      claims[normalizedKey] = value.map(String);
    } else if (value !== undefined && value !== null) {
      claims[normalizedKey] = String(value);
    }
  }

  return claims;
}

/**
 * Extract session variables from a verified JWT payload according to the auth config.
 *
 * Required claims:
 * - `x-hasura-allowed-roles` (string[])
 * - `x-hasura-default-role` (string)
 *
 * Optional claims:
 * - `x-hasura-user-id`
 * - Any other `x-hasura-*` custom claims
 *
 * @throws If required claims are missing.
 */
export function extractSessionVariables(
  payload: JWTPayload,
  config: AuthConfig,
): SessionVariables {
  let claims: Record<string, string | string[]>;

  if (config.jwt?.claimsMap) {
    claims = extractFromClaimsMap(payload, config.jwt.claimsMap);
  } else {
    const namespace = config.jwt?.claimsNamespace ?? DEFAULT_NAMESPACE;
    claims = extractFromNamespace(payload, namespace);
  }

  // ── Validate required claims ──────────────────────────────────────────
  const allowedRolesValue = claims['x-hasura-allowed-roles'];
  if (!allowedRolesValue) {
    throw new Error('JWT claims missing required "x-hasura-allowed-roles"');
  }
  const allowedRoles = Array.isArray(allowedRolesValue)
    ? allowedRolesValue
    : [allowedRolesValue];

  const defaultRole = claims['x-hasura-default-role'];
  if (!defaultRole) {
    throw new Error('JWT claims missing required "x-hasura-default-role"');
  }
  const role = Array.isArray(defaultRole) ? defaultRole[0] : defaultRole;

  const userIdValue = claims['x-hasura-user-id'];
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
