/**
 * Shared naming utilities for case conversion.
 *
 * Centralizes snake_case/camelCase/PascalCase conversions so that both
 * the schema layer and the SQL layer can import from a single location
 * without creating cross-layer dependency cycles.
 */

/**
 * Convert a snake_case or plain string to PascalCase.
 * "user_accounts" -> "UserAccounts", "users" -> "Users"
 */
export function toPascalCase(str: string): string {
  return str
    .split('_')
    .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1))
    .join('');
}

/**
 * Convert a snake_case string to camelCase.
 * "created_at" -> "createdAt", "user_id" -> "userId"
 *
 * Leading underscores are preserved rather than treated as separators,
 * matching Hasura: "_uniq_key" -> "_uniqKey". They are a common PL/pgSQL
 * convention for function argument names (avoiding column name collisions).
 */
export function toCamelCase(str: string): string {
  const leading = /^_+/.exec(str)?.[0] ?? '';
  const parts = str.slice(leading.length).split('_');
  return leading + parts[0] + parts.slice(1).map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join('');
}

/**
 * Get the GraphQL field name for a relationship.
 * Metadata-defined relationships use their name as-is (Hasura behavior).
 * Auto-detected relationships (from FK inference) get camelCase conversion.
 */
export function getRelFieldName(rel: { name: string; fromMetadata?: boolean }): string {
  return rel.fromMetadata ? rel.name : toCamelCase(rel.name);
}
