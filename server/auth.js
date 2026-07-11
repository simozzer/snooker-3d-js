// auth.js — OPTIONAL OIDC token verification for the relay. When configured, the relay can trust a
// player's identity because the browser presents a JWT that Keycloak (brokering Google / Microsoft /
// Facebook) issued, and we verify its signature against Keycloak's published public keys. No secret is
// shared and no per-request callout is made: jose fetches the JWKS once and caches it, then every
// token is checked offline. Verification is game-scoped — the token must come from OUR realm (issuer)
// and, if set, name OUR client (audience) — so a token minted for any other app is rejected.
//
// It is deliberately OPTIONAL: with no issuer configured the verifier is disabled and the relay runs
// exactly as before (anonymous pids), so local dev and the existing tests need no identity server.

import { createRemoteJWKSet, jwtVerify } from 'jose';

// Build a verifier from config (usually env, see relay.js). `jwks` is an injectable key resolver so
// tests can supply a local key set instead of a live Keycloak — the verification path is identical.
//   issuer   — the realm base URL, e.g. https://kc.example/realms/games (checked as the `iss` claim)
//   audience — optional expected `aud` (your client id); omit to skip audience checks
//   jwksUri  — override the JWKS endpoint; defaults to Keycloak's standard certs path under `issuer`
export function createVerifier({ issuer = null, audience = null, jwksUri = null, jwks = null } = {}) {
  const enabled = !!(issuer && (jwks || jwksUri || issuer));
  const keys = enabled
    ? (jwks ?? createRemoteJWKSet(new URL(jwksUri || `${issuer.replace(/\/$/, '')}/protocol/openid-connect/certs`)))
    : null;

  return {
    enabled,
    // Verify a token and return a compact identity, or throw if it is invalid/expired/foreign.
    // Returns null when auth is disabled (caller treats the connection as anonymous).
    async verify(token) {
      if (!enabled) return null;
      if (!token || typeof token !== 'string') throw new Error('no-token');
      const opts = { issuer };
      if (audience) opts.audience = audience;
      const { payload } = await jwtVerify(token, keys, opts); // checks signature, exp/nbf, iss, aud
      return {
        sub: payload.sub,
        name: payload.name || payload.preferred_username || payload.email || 'player',
        email: payload.email ?? null,
        // who the token was minted for — useful for logging/debugging cross-app tokens
        azp: payload.azp ?? null,
      };
    },
  };
}

// Convenience: build a verifier straight from process.env. Returns a disabled verifier if OIDC_ISSUER
// is unset, so the relay is secure-by-configuration but harmless by default.
export function verifierFromEnv(env = process.env) {
  return createVerifier({
    issuer: env.OIDC_ISSUER || null,
    audience: env.OIDC_AUDIENCE || null,
    jwksUri: env.OIDC_JWKS_URI || null,
  });
}
