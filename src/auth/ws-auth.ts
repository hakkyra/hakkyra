/**
 * WebSocket authentication for GraphQL subscriptions.
 *
 * Extracts JWT or admin-secret from WebSocket connectionParams,
 * handling the multiple common formats used by GraphQL clients:
 * - { Authorization: "Bearer ..." }
 * - { headers: { Authorization: "Bearer ..." } }
 * - { token: "..." }
 * - { "x-hasura-admin-secret": "..." }
 */

import { timingSafeEqual as cryptoTimingSafeEqual } from 'node:crypto';
import type { AuthConfig, SessionVariables } from '../types.js';
import type { JWTVerifier } from './jwt.js';
import { createJWTVerifier } from './jwt.js';
import { extractSessionVariables } from './claims.js';

// ─── Token Extraction ────────────────────────────────────────────────────────

/**
 * Extract a Bearer token from connectionParams, trying multiple common formats.
 */
function extractBearerToken(connectionParams: Record<string, unknown>): string | null {
  // Format 1: { Authorization: "Bearer <token>" }
  const auth = connectionParams['Authorization'] ?? connectionParams['authorization'];
  if (typeof auth === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(auth);
    if (match) return match[1];
  }

  // Format 2: { headers: { Authorization: "Bearer <token>" } }
  const headers = connectionParams['headers'];
  if (headers && typeof headers === 'object') {
    const headerMap = headers as Record<string, unknown>;
    const headerAuth = headerMap['Authorization'] ?? headerMap['authorization'];
    if (typeof headerAuth === 'string') {
      const match = /^Bearer\s+(.+)$/i.exec(headerAuth);
      if (match) return match[1];
    }
  }

  // Format 3: { token: "<token>" }
  const token = connectionParams['token'];
  if (typeof token === 'string' && token.length > 0) {
    return token;
  }

  return null;
}

/**
 * Extract an admin secret from connectionParams, trying multiple common formats.
 */
function extractAdminSecret(connectionParams: Record<string, unknown>): string | null {
  // Direct: { "x-hasura-admin-secret": "..." }
  const direct = connectionParams['x-hasura-admin-secret'];
  if (typeof direct === 'string') return direct;

  // In headers: { headers: { "x-hasura-admin-secret": "..." } }
  const headers = connectionParams['headers'];
  if (headers && typeof headers === 'object') {
    const headerMap = headers as Record<string, unknown>;
    const headerSecret = headerMap['x-hasura-admin-secret'];
    if (typeof headerSecret === 'string') return headerSecret;
  }

  return null;
}

/**
 * Extract a requested role from connectionParams.
 */
function extractRequestedRole(connectionParams: Record<string, unknown>): string | null {
  const direct = connectionParams['x-hasura-role'];
  if (typeof direct === 'string') return direct;

  const headers = connectionParams['headers'];
  if (headers && typeof headers === 'object') {
    const headerMap = headers as Record<string, unknown>;
    const headerRole = headerMap['x-hasura-role'];
    if (typeof headerRole === 'string') return headerRole;
  }

  return null;
}

// ─── Timing-safe comparison ──────────────────────────────────────────────────

function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);

  if (bufA.length !== bufB.length) {
    cryptoTimingSafeEqual(bufA, bufA);
    return false;
  }

  return cryptoTimingSafeEqual(bufA, bufB);
}

// ─── Main Authentication Function ────────────────────────────────────────────

/**
 * Authenticate a WebSocket connection using connectionParams.
 *
 * Tries, in order:
 * 1. Admin secret check
 * 2. JWT verification
 * 3. Unauthorized role fallback
 *
 * Returns session variables on success, or null if authentication fails
 * (meaning the connection should be rejected).
 */
export async function authenticateWsConnection(
  connectionParams: Record<string, unknown> | undefined | null,
  authConfig: AuthConfig,
): Promise<SessionVariables | null> {
  const params = connectionParams ?? {};

  // Resolve admin secret from env
  const adminSecret = authConfig.adminSecretEnv
    ? process.env[authConfig.adminSecretEnv]
    : undefined;

  // ── 1. Admin secret check ──────────────────────────────────────────────
  if (adminSecret) {
    const providedSecret = extractAdminSecret(params);
    if (providedSecret) {
      if (timingSafeEqual(providedSecret, adminSecret)) {
        const requestedRole = extractRequestedRole(params);
        return {
          role: requestedRole ?? 'admin',
          allowedRoles: ['admin'],
          isAdmin: true,
          claims: {
            'x-hasura-role': requestedRole ?? 'admin',
          },
        };
      }
      // Admin secret provided but invalid — reject
      return null;
    }
  }

  // ── 2. JWT verification ────────────────────────────────────────────────
  const token = extractBearerToken(params);
  if (token) {
    if (!authConfig.jwt) {
      // JWT not configured but token provided — reject
      return null;
    }

    let verifier: JWTVerifier;
    try {
      verifier = await createJWTVerifier(authConfig.jwt);
    } catch {
      return null;
    }

    try {
      const payload = await verifier.verify(token);

      // Reject JWTs without an exp claim when requireExp is enabled
      if (authConfig.jwt?.requireExp !== false && payload.exp === undefined) {
        return null;
      }

      let session = extractSessionVariables(payload, authConfig);

      // Active role resolution
      const requestedRole = extractRequestedRole(params);
      if (requestedRole) {
        if (!session.allowedRoles.includes(requestedRole)) {
          return null;
        }
        session = { ...session, role: requestedRole };
      }

      return session;
    } catch {
      return null;
    }
  }

  // ── 3. Unauthorized role fallback ──────────────────────────────────────
  if (authConfig.unauthorizedRole) {
    return {
      role: authConfig.unauthorizedRole,
      allowedRoles: [authConfig.unauthorizedRole],
      isAdmin: false,
      claims: {
        'x-hasura-default-role': authConfig.unauthorizedRole,
        'x-hasura-allowed-roles': [authConfig.unauthorizedRole],
      },
    };
  }

  // No auth possible — reject
  return null;
}
