/**
 * Authentication module.
 *
 * Re-exports JWT verification, webhook authentication, claims extraction,
 * and the Fastify auth hook.
 */

export { createJWTVerifier } from './jwt.js';
export type { JWTVerifier, JWTPayload } from './jwt.js';

export { createWebhookAuthenticator } from './webhook.js';
export type { WebhookAuthenticator, WebhookAuthConfig } from './webhook.js';

export { extractSessionVariables } from './claims.js';

export { createAuthHook } from './middleware.js';

export { authenticateWsConnection } from './ws-auth.js';

export {
  DEFAULT_SESSION_NAMESPACE,
  HASURA_METADATA_NAMESPACE,
  DEFAULT_JWT_CLAIMS_NAMESPACE,
  WELL_KNOWN_SUFFIXES,
  nsKey,
  isSessionVariable,
  extractSuffix,
  resolveSessionVar,
} from './session-namespace.js';
