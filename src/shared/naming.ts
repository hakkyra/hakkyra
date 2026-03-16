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
 */
export function toCamelCase(str: string): string {
  const parts = str.split('_');
  return parts[0] + parts.slice(1).map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join('');
}

/**
 * Get the GraphQL field name for a relationship.
 * Metadata-defined relationships use their name as-is (Hasura behavior).
 * Auto-detected relationships (from FK inference) get camelCase conversion.
 */
export function getRelFieldName(rel: { name: string; fromMetadata?: boolean }): string {
  return rel.fromMetadata ? rel.name : toCamelCase(rel.name);
}
