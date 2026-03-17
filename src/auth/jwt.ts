/**
 * JWT verification using the `jose` library.
 *
 * Supports HMAC (HS*), RSA (RS*), ECDSA (ES*), and EdDSA algorithms,
 * as well as remote JWKS endpoints with automatic key rotation.
 */

import {
  jwtVerify,
  createRemoteJWKSet,
  importSPKI,
  importJWK,
} from 'jose';
import type { JWTPayload, CryptoKey as JoseCryptoKey } from 'jose';
import type { AuthConfig } from '../types.js';

// Re-export JWTPayload so consumers can reference it without importing jose directly.
export type { JWTPayload };

const SYMMETRIC_ALGORITHMS = new Set(['HS256', 'HS384', 'HS512']);
const SUPPORTED_ALGORITHMS = new Set([
  'HS256', 'HS384', 'HS512',
  'RS256', 'RS384', 'RS512',
  'ES256', 'ES384', 'ES512',
  'EdDSA',
]);

export interface JWTVerifier {
  verify(token: string): Promise<JWTPayload>;
}

/**
 * Encode a raw secret string into a Uint8Array suitable for HMAC verification.
 */
function encodeSecret(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

/**
 * Resolve the key material from environment variable or inline config.
 */
function resolveKeyString(config: NonNullable<AuthConfig['jwt']>): string {
  if (config.keyEnv) {
    const envValue = process.env[config.keyEnv];
    if (!envValue) {
      throw new Error(`Environment variable "${config.keyEnv}" is not set (required for JWT key)`);
    }
    return envValue;
  }
  if (config.key) {
    return config.key;
  }
  throw new Error('JWT configuration must specify "key", "keyEnv", or "jwkUrl"');
}

/**
 * Create a JWT verifier from the authentication configuration.
 *
 * The returned verifier validates the token signature, expiration, issuer,
 * and audience according to the config.
 */
export async function createJWTVerifier(
  config: AuthConfig['jwt'],
): Promise<JWTVerifier> {
  if (!config) {
    throw new Error('JWT configuration is required');
  }

  const algorithm = config.type;
  if (!SUPPORTED_ALGORITHMS.has(algorithm)) {
    throw new Error(
      `Unsupported JWT algorithm "${algorithm}". ` +
      `Supported: ${[...SUPPORTED_ALGORITHMS].join(', ')}`,
    );
  }

  // Build jose verification options shared across all key types.
  const verifyOptions: {
    algorithms: string[];
    issuer?: string;
    audience?: string;
  } = {
    algorithms: [algorithm],
  };
  if (config.issuer) {
    verifyOptions.issuer = config.issuer;
  }
  if (config.audience) {
    verifyOptions.audience = config.audience;
  }

  // ── JWKS endpoint (remote key set with auto-rotation) ──────────────────
  const jwkUrl = config.jwkUrl ?? (config.jwkUrlEnv ? process.env[config.jwkUrlEnv] : undefined);
  if (jwkUrl) {
    const jwks = createRemoteJWKSet(new URL(jwkUrl));

    // When using JWKS, the key's `alg` field is authoritative — don't
    // restrict to the configured type (which defaults to HS256).
    const { algorithms: _drop, ...jwksBaseOptions } = verifyOptions;
    const jwksOptions = jwksBaseOptions;

    return {
      async verify(token: string): Promise<JWTPayload> {
        const { payload } = await jwtVerify(token, jwks, jwksOptions);
        return payload;
      },
    };
  }

  // ── Static key ─────────────────────────────────────────────────────────
  const keyString = resolveKeyString(config);

  let key: Uint8Array | JoseCryptoKey;

  if (SYMMETRIC_ALGORITHMS.has(algorithm)) {
    // HMAC — use the raw secret bytes.
    key = encodeSecret(keyString);
  } else if (keyString.trimStart().startsWith('{')) {
    // Looks like JSON — treat as JWK.
    const jwk = JSON.parse(keyString) as Record<string, unknown>;
    key = await importJWK(jwk, algorithm) as JoseCryptoKey;
  } else {
    // PEM-encoded SPKI public key.
    key = await importSPKI(keyString, algorithm);
  }

  return {
    async verify(token: string): Promise<JWTPayload> {
      const { payload } = await jwtVerify(token, key, verifyOptions);
      return payload;
    },
  };
}
