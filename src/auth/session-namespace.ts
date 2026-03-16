/**
 * Session variable namespace utilities.
 *
 * Centralizes all logic for mapping between the Hasura metadata namespace
 * (`x-hasura-*`) and the configurable runtime namespace (default: `x-hk-*`).
 *
 * YAML metadata always uses `x-hasura-*` for Hasura compatibility.
 * At runtime, the configured namespace is used for:
 * - JWT claims keys
 * - Webhook response keys
 * - HTTP headers (role override, admin secret)
 * - PostgreSQL session variables (set_config)
 * - Session variable resolution in permission filters and presets
 *
 * The default namespace is `x-hk`. Set to `x-hasura` for full Hasura
 * backwards compatibility.
 */

/** Default session variable namespace. */
export const DEFAULT_SESSION_NAMESPACE: string = 'x-hk';

/** The namespace used in Hasura metadata YAML files. */
export const HASURA_METADATA_NAMESPACE = 'x-hasura';

/** Default JWT claims namespace key (Hasura-compatible). */
export const DEFAULT_JWT_CLAIMS_NAMESPACE = 'https://hasura.io/jwt/claims';

/**
 * Well-known session variable suffixes (after the namespace prefix + hyphen).
 */
export const WELL_KNOWN_SUFFIXES = {
  ROLE: 'role',
  USER_ID: 'user-id',
  ALLOWED_ROLES: 'allowed-roles',
  DEFAULT_ROLE: 'default-role',
  ADMIN_SECRET: 'admin-secret',
} as const;

/**
 * Build a namespaced session variable key.
 *
 * @example
 * nsKey('x-hk', 'role')       // 'x-hk-role'
 * nsKey('x-hasura', 'user-id') // 'x-hasura-user-id'
 */
export function nsKey(namespace: string, suffix: string): string {
  return `${namespace}-${suffix}`;
}

/**
 * Check whether a string value is a session variable reference.
 *
 * Accepts both the configured namespace prefix and the Hasura metadata
 * prefix (`x-hasura-`), so that YAML permission filters (which always
 * use `x-hasura-*`) work regardless of the configured namespace.
 */
export function isSessionVariable(value: unknown, namespace: string): value is string {
  if (typeof value !== 'string') return false;
  const lower = value.toLowerCase();
  return lower.startsWith(`${namespace}-`) || lower.startsWith(`${HASURA_METADATA_NAMESPACE}-`);
}

/**
 * Extract the suffix from a session variable reference, normalizing
 * away both the configured namespace and the Hasura metadata namespace.
 *
 * @example
 * extractSuffix('x-hasura-user-id', 'x-hk') // 'user-id'
 * extractSuffix('x-hk-user-id', 'x-hk')     // 'user-id'
 * extractSuffix('X-Hasura-Role', 'x-hk')     // 'role'
 */
export function extractSuffix(variable: string, namespace: string): string {
  const lower = variable.toLowerCase();
  if (lower.startsWith(`${namespace}-`)) {
    return lower.slice(namespace.length + 1);
  }
  if (lower.startsWith(`${HASURA_METADATA_NAMESPACE}-`)) {
    return lower.slice(HASURA_METADATA_NAMESPACE.length + 1);
  }
  return lower;
}

/**
 * Resolve a session variable reference against the session, supporting
 * both the configured namespace and the Hasura metadata namespace.
 *
 * Well-known variables (role, user-id, allowed-roles) are resolved from
 * structured session fields. Other variables are looked up in claims.
 */
export function resolveSessionVar(
  value: string,
  session: { role?: string; userId?: string; allowedRoles?: string[]; claims: Record<string, string | string[]> },
  namespace: string,
): unknown {
  const suffix = extractSuffix(value, namespace);

  // Well-known variables
  if (suffix === WELL_KNOWN_SUFFIXES.ROLE) return session.role;
  if (suffix === WELL_KNOWN_SUFFIXES.USER_ID) return session.userId;
  if (suffix === WELL_KNOWN_SUFFIXES.ALLOWED_ROLES) return session.allowedRoles;
  if (suffix === WELL_KNOWN_SUFFIXES.DEFAULT_ROLE) return session.role;

  // Look up in claims map — try the namespaced key first, then the suffix
  const nsKeyLower = nsKey(namespace, suffix);
  if (nsKeyLower in session.claims) return session.claims[nsKeyLower];

  // Try Hasura-namespaced key (for backwards compat when claims come from metadata)
  const hasuraKey = nsKey(HASURA_METADATA_NAMESPACE, suffix);
  if (hasuraKey in session.claims) return session.claims[hasuraKey];

  // Try suffix directly
  if (suffix in session.claims) return session.claims[suffix];

  // Case-insensitive search
  for (const [k, v] of Object.entries(session.claims)) {
    if (k.toLowerCase() === nsKeyLower || k.toLowerCase() === hasuraKey || k.toLowerCase() === suffix) {
      return v;
    }
  }

  return undefined;
}
