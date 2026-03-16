/**
 * Hasura-compatible JWT claims extraction.
 *
 * Supports:
 * - Namespace-based claims (default: `https://hasura.io/jwt/claims`)
 * - `claims_map` for extracting from arbitrary JWT paths
 * - `claims_format: "stringified_json"` (namespace value is a JSON string)
 * - Case-insensitive claim key matching
 * - Configurable session variable namespace (default `x-hk`, set `x-hasura` for compat)
 */

import type { JWTPayload } from 'jose';
import type { AuthConfig, SessionVariables } from '../types.js';
import {
  DEFAULT_JWT_CLAIMS_NAMESPACE,
  WELL_KNOWN_SUFFIXES,
  nsKey,
  DEFAULT_SESSION_NAMESPACE,
} from './session-namespace.js';

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
 * Find a claim by its suffix, trying both the configured namespace and x-hasura namespace.
 * Claims from JWT are stored lowercase. We look up both `{ns}-{suffix}` and `x-hasura-{suffix}`.
 */
function findClaim(
  claims: Record<string, string | string[]>,
  suffix: string,
  sessionNs: string,
): string | string[] | undefined {
  // Try configured namespace first
  const nsLookup = nsKey(sessionNs, suffix);
  if (claims[nsLookup] !== undefined) return claims[nsLookup];

  // Try x-hasura namespace (JWT claims from Hasura-compatible providers)
  const hasuraLookup = `x-hasura-${suffix}`;
  if (claims[hasuraLookup] !== undefined) return claims[hasuraLookup];

  return undefined;
}

/**
 * Extract session variables from a verified JWT payload according to the auth config.
 *
 * Required claims (searched with both configured namespace and x-hasura- prefix):
 * - `{ns}-allowed-roles` (string[])
 * - `{ns}-default-role` (string)
 *
 * Optional claims:
 * - `{ns}-user-id`
 * - Any other `{ns}-*` custom claims
 *
 * @throws If required claims are missing.
 */
export function extractSessionVariables(
  payload: JWTPayload,
  config: AuthConfig,
): SessionVariables {
  let claims: Record<string, string | string[]>;
  const sessionNs = config.sessionNamespace ?? DEFAULT_SESSION_NAMESPACE;

  if (config.jwt?.claimsMap) {
    claims = extractFromClaimsMap(payload, config.jwt.claimsMap);
  } else {
    const namespace = config.jwt?.claimsNamespace ?? DEFAULT_JWT_CLAIMS_NAMESPACE;
    claims = extractFromNamespace(payload, namespace);
  }

  // ── Validate required claims ──────────────────────────────────────────
  const allowedRolesValue = findClaim(claims, WELL_KNOWN_SUFFIXES.ALLOWED_ROLES, sessionNs);
  if (!allowedRolesValue) {
    const key1 = nsKey(sessionNs, WELL_KNOWN_SUFFIXES.ALLOWED_ROLES);
    const key2 = `x-hasura-${WELL_KNOWN_SUFFIXES.ALLOWED_ROLES}`;
    throw new Error(
      `JWT claims missing required "${key1}"${sessionNs !== 'x-hasura' ? ` (or "${key2}")` : ''}`,
    );
  }
  const allowedRoles = Array.isArray(allowedRolesValue)
    ? allowedRolesValue
    : [allowedRolesValue];

  const defaultRole = findClaim(claims, WELL_KNOWN_SUFFIXES.DEFAULT_ROLE, sessionNs);
  if (!defaultRole) {
    const key1 = nsKey(sessionNs, WELL_KNOWN_SUFFIXES.DEFAULT_ROLE);
    const key2 = `x-hasura-${WELL_KNOWN_SUFFIXES.DEFAULT_ROLE}`;
    throw new Error(
      `JWT claims missing required "${key1}"${sessionNs !== 'x-hasura' ? ` (or "${key2}")` : ''}`,
    );
  }
  const role = Array.isArray(defaultRole) ? defaultRole[0] : defaultRole;

  const userIdValue = findClaim(claims, WELL_KNOWN_SUFFIXES.USER_ID, sessionNs);
  const userId = userIdValue
    ? (Array.isArray(userIdValue) ? userIdValue[0] : userIdValue)
    : undefined;

  return {
    role,
    userId,
    allowedRoles,
    isAdmin: config.jwt?.adminRoleIsAdmin === true && role === 'admin',
    claims,
  };
}
