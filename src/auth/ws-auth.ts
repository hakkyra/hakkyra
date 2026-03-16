/**
 * WebSocket authentication for GraphQL subscriptions.
 *
 * Extracts JWT or admin-secret from WebSocket connectionParams,
 * handling the multiple common formats used by GraphQL clients:
 * - { Authorization: "Bearer ..." }
 * - { headers: { Authorization: "Bearer ..." } }
 * - { token: "..." }
 * - { "{ns}-admin-secret": "..." } (also accepts "x-hasura-admin-secret")
 */

import { timingSafeEqual as cryptoTimingSafeEqual } from 'node:crypto';
import type { AuthConfig, SessionVariables } from '../types.js';
import type { JWTVerifier } from './jwt.js';
import { createJWTVerifier } from './jwt.js';
import { extractSessionVariables } from './claims.js';
import {
  DEFAULT_SESSION_NAMESPACE,
  WELL_KNOWN_SUFFIXES,
  nsKey,
} from './session-namespace.js';

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
 * Extract an admin secret from connectionParams, trying both the configured
 * namespace and the Hasura-compatible x-hasura-admin-secret.
 */
function extractAdminSecret(connectionParams: Record<string, unknown>, sessionNs: string): string | null {
  const nsAdminSecret = nsKey(sessionNs, WELL_KNOWN_SUFFIXES.ADMIN_SECRET);

  // Direct: { "{ns}-admin-secret": "..." }
  const direct = connectionParams[nsAdminSecret];
  if (typeof direct === 'string') return direct;

  // Fallback: { "x-hasura-admin-secret": "..." }
  if (sessionNs !== 'x-hasura') {
    const hasuraDirect = connectionParams['x-hasura-admin-secret'];
    if (typeof hasuraDirect === 'string') return hasuraDirect;
  }

  // In headers: { headers: { "{ns}-admin-secret": "..." } }
  const headers = connectionParams['headers'];
  if (headers && typeof headers === 'object') {
    const headerMap = headers as Record<string, unknown>;
    const headerSecret = headerMap[nsAdminSecret];
    if (typeof headerSecret === 'string') return headerSecret;

    if (sessionNs !== 'x-hasura') {
      const hasuraHeaderSecret = headerMap['x-hasura-admin-secret'];
      if (typeof hasuraHeaderSecret === 'string') return hasuraHeaderSecret;
    }
  }

  return null;
}

/**
 * Extract a requested role from connectionParams, checking both the configured
 * namespace and the Hasura-compatible x-hasura-role.
 */
function extractRequestedRole(connectionParams: Record<string, unknown>, sessionNs: string): string | null {
  const nsRole = nsKey(sessionNs, WELL_KNOWN_SUFFIXES.ROLE);

  const direct = connectionParams[nsRole];
  if (typeof direct === 'string') return direct;

  // Fallback: x-hasura-role
  if (sessionNs !== 'x-hasura') {
    const hasuraDirect = connectionParams['x-hasura-role'];
    if (typeof hasuraDirect === 'string') return hasuraDirect;
  }

  const headers = connectionParams['headers'];
  if (headers && typeof headers === 'object') {
    const headerMap = headers as Record<string, unknown>;
    const headerRole = headerMap[nsRole];
    if (typeof headerRole === 'string') return headerRole;

    if (sessionNs !== 'x-hasura') {
      const hasuraHeaderRole = headerMap['x-hasura-role'];
      if (typeof hasuraHeaderRole === 'string') return hasuraHeaderRole;
    }
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
  const sessionNs = authConfig.sessionNamespace ?? DEFAULT_SESSION_NAMESPACE;

  // Resolve admin secret from env
  const adminSecret = authConfig.adminSecretEnv
    ? process.env[authConfig.adminSecretEnv]
    : undefined;

  // ── 1. Admin secret check ──────────────────────────────────────────────
  if (adminSecret) {
    const providedSecret = extractAdminSecret(params, sessionNs);
    if (providedSecret) {
      if (timingSafeEqual(providedSecret, adminSecret)) {
        const requestedRole = extractRequestedRole(params, sessionNs);
        return {
          role: requestedRole ?? 'admin',
          allowedRoles: ['admin'],
          isAdmin: true,
          claims: {
            [nsKey(sessionNs, WELL_KNOWN_SUFFIXES.ROLE)]: requestedRole ?? 'admin',
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
      const requestedRole = extractRequestedRole(params, sessionNs);
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
        [nsKey(sessionNs, WELL_KNOWN_SUFFIXES.DEFAULT_ROLE)]: authConfig.unauthorizedRole,
        [nsKey(sessionNs, WELL_KNOWN_SUFFIXES.ALLOWED_ROLES)]: [authConfig.unauthorizedRole],
      },
    };
  }

  // No auth possible — reject
  return null;
}
