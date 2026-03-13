/**
 * Fastify authentication plugin.
 *
 * Registers a `preHandler` hook that:
 * 1. Checks for admin secret header
 * 2. Verifies JWT from Authorization header
 * 3. Resolves active role from `x-hasura-role` header
 * 4. Tries webhook authentication if configured
 * 5. Falls back to `unauthorizedRole` if configured
 * 6. Attaches `SessionVariables` to the request
 */

import { timingSafeEqual as cryptoTimingSafeEqual } from 'node:crypto';
import fp from 'fastify-plugin';
import type { FastifyPluginCallback, FastifyRequest, FastifyReply } from 'fastify';
import type { AuthConfig, SessionVariables } from '../types.js';
import type { JWTVerifier } from './jwt.js';
import { createJWTVerifier } from './jwt.js';
import { extractSessionVariables } from './claims.js';
import type { WebhookAuthenticator } from './webhook.js';
import { createWebhookAuthenticator } from './webhook.js';

// Fastify request augmentation key
const SESSION_KEY = 'session';

declare module 'fastify' {
  interface FastifyRequest {
    session: SessionVariables | null;
  }
}

/**
 * Build the admin session used when the request supplies a valid admin secret.
 * The admin can optionally assume a specific role via the `x-hasura-role` header.
 */
function buildAdminSession(request: FastifyRequest): SessionVariables {
  const requestedRole = getSingleHeader(request, 'x-hasura-role');

  return {
    role: requestedRole ?? 'admin',
    allowedRoles: ['admin'],
    isAdmin: true,
    claims: {
      'x-hasura-role': requestedRole ?? 'admin',
    },
  };
}

/**
 * Build a session for the configured unauthorized (anonymous) role.
 */
function buildUnauthorizedSession(role: string): SessionVariables {
  return {
    role,
    allowedRoles: [role],
    isAdmin: false,
    claims: {
      'x-hasura-default-role': role,
      'x-hasura-allowed-roles': [role],
    },
  };
}

/**
 * Safely get a single string value from a header that may be string | string[] | undefined.
 */
function getSingleHeader(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

/**
 * Send a 401 Unauthorized response.
 */
function sendUnauthorized(reply: FastifyReply, message: string): void {
  void reply.code(401).send({ error: 'unauthorized', message });
}

/**
 * Create the Fastify authentication plugin.
 *
 * Usage:
 * ```ts
 * const app = fastify();
 * app.register(createAuthHook(config));
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createAuthHook(config: AuthConfig): any {
  return fp(function authPlugin(instance: any, _opts: any, done: (err?: Error) => void) {
    // Decorate request with the session property (initial value is used for type inference).
    if (!instance.hasRequestDecorator(SESSION_KEY)) {
      instance.decorateRequest(SESSION_KEY, null);
    }

    // Lazily initialize the JWT verifier (async key import).
    let verifierPromise: Promise<JWTVerifier> | undefined;

    if (config.jwt) {
      verifierPromise = createJWTVerifier(config.jwt);
    }

    // Initialize the webhook authenticator if configured.
    let webhookAuthenticator: WebhookAuthenticator | undefined;

    if (config.webhook) {
      webhookAuthenticator = createWebhookAuthenticator(config.webhook);
    }

    // Resolve the admin secret from environment once at startup.
    const adminSecret = config.adminSecretEnv
      ? process.env[config.adminSecretEnv]
      : undefined;

    instance.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
      // ── 1. Admin secret check ──────────────────────────────────────────
      if (adminSecret) {
        const headerSecret = getSingleHeader(request, 'x-hasura-admin-secret');
        if (headerSecret) {
          if (timingSafeEqual(headerSecret, adminSecret)) {
            request.session = buildAdminSession(request);
            return;
          }
          sendUnauthorized(reply, 'Invalid admin secret');
          return;
        }
      }

      // ── 2. JWT verification ────────────────────────────────────────────
      const authHeader = getSingleHeader(request, 'authorization');
      if (authHeader) {
        const match = /^Bearer\s+(.+)$/i.exec(authHeader);
        if (!match) {
          sendUnauthorized(reply, 'Authorization header must use Bearer scheme');
          return;
        }

        if (!verifierPromise) {
          sendUnauthorized(reply, 'JWT verification is not configured');
          return;
        }

        const token = match[1];
        let verifier: JWTVerifier;
        try {
          verifier = await verifierPromise;
        } catch (err) {
          request.log.error({ err }, 'Failed to initialize JWT verifier');
          sendUnauthorized(reply, 'JWT verification unavailable');
          return;
        }

        let session: SessionVariables;
        try {
          const payload = await verifier.verify(token);
          session = extractSessionVariables(payload, config);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'JWT verification failed';
          request.log.warn({ err }, 'JWT verification failed');
          sendUnauthorized(reply, message);
          return;
        }

        // ── 3. Active role resolution ──────────────────────────────────
        const requestedRole = getSingleHeader(request, 'x-hasura-role');
        if (requestedRole) {
          if (!session.allowedRoles.includes(requestedRole)) {
            sendUnauthorized(
              reply,
              `Role "${requestedRole}" is not in the allowed roles list`,
            );
            return;
          }
          session = { ...session, role: requestedRole };
        }

        request.session = session;
        return;
      }

      // ── 4. Webhook authentication ──────────────────────────────────────
      if (webhookAuthenticator) {
        // Collect request headers as a flat string→string map.
        const flatHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(request.headers)) {
          if (value !== undefined) {
            flatHeaders[key] = Array.isArray(value) ? value.join(', ') : value;
          }
        }

        try {
          let session = await webhookAuthenticator.authenticate(flatHeaders);

          // ── Active role resolution ────────────────────────────────────
          const requestedRole = getSingleHeader(request, 'x-hasura-role');
          if (requestedRole) {
            if (!session.allowedRoles.includes(requestedRole)) {
              sendUnauthorized(
                reply,
                `Role "${requestedRole}" is not in the allowed roles list`,
              );
              return;
            }
            session = { ...session, role: requestedRole };
          }

          request.session = session;
          return;
        } catch (err) {
          request.log.warn({ err }, 'Webhook authentication failed');
          // Fall through to unauthorized role or reject.
        }
      }

      // ── 5. Unauthorized role fallback ──────────────────────────────────
      if (config.unauthorizedRole) {
        request.session = buildUnauthorizedSession(config.unauthorizedRole);
        return;
      }

      // ── 6. No auth at all — reject ────────────────────────────────────
      sendUnauthorized(reply, 'Authentication required');
    });

    done();
  });
}

/**
 * Constant-time string comparison to prevent timing attacks on the admin secret.
 *
 * Uses Node.js `crypto.timingSafeEqual`. When lengths differ, we still perform
 * a constant-time comparison against a buffer of the correct length to avoid
 * leaking length information through timing.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);

  if (bufA.length !== bufB.length) {
    // Compare bufA against itself so the timing is consistent,
    // but always return false.
    cryptoTimingSafeEqual(bufA, bufA);
    return false;
  }

  return cryptoTimingSafeEqual(bufA, bufB);
}
