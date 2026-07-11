import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose';
import { createVerifier } from '../server/auth.js';

const ISSUER = 'https://kc.example/realms/games';
const AUDIENCE = 'games-web';

// A self-contained IdP: one RSA keypair, its public half published as a JWKS. Tokens signed with the
// private key verify against the JWKS exactly as they would against a real Keycloak.
async function makeIdp() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-1', alg: 'RS256', use: 'sig' };
  const jwks = createLocalJWKSet({ keys: [jwk] });
  const sign = (claims = {}, { iss = ISSUER, aud = AUDIENCE, exp = '5m', key = privateKey } = {}) =>
    new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'test-1' })
      .setIssuer(iss).setAudience(aud).setSubject(claims.sub || 'user-1').setExpirationTime(exp).sign(key);
  return { jwks, sign, privateKey, publicKey };
}

test('a disabled verifier (no issuer) returns null and never rejects', async () => {
  const v = createVerifier({});
  assert.equal(v.enabled, false);
  assert.equal(await v.verify('anything'), null);
});

test('a valid token yields a verified identity', async () => {
  const idp = await makeIdp();
  const v = createVerifier({ issuer: ISSUER, audience: AUDIENCE, jwks: idp.jwks });
  const token = await idp.sign({ name: 'Ada Lovelace', email: 'ada@example.com', preferred_username: 'ada', azp: AUDIENCE });
  const id = await v.verify(token);
  assert.equal(id.name, 'Ada Lovelace');
  assert.equal(id.email, 'ada@example.com');
  assert.equal(id.sub, 'user-1');
});

test('name falls back to preferred_username then email', async () => {
  const idp = await makeIdp();
  const v = createVerifier({ issuer: ISSUER, audience: AUDIENCE, jwks: idp.jwks });
  const byUser = await v.verify(await idp.sign({ preferred_username: 'grace', email: 'g@x.com' }));
  assert.equal(byUser.name, 'grace');
  const byEmail = await v.verify(await idp.sign({ email: 'only@x.com' }));
  assert.equal(byEmail.name, 'only@x.com');
});

test('a token from a DIFFERENT issuer (foreign realm) is rejected', async () => {
  const idp = await makeIdp();
  const v = createVerifier({ issuer: ISSUER, audience: AUDIENCE, jwks: idp.jwks });
  const token = await idp.sign({ name: 'Mallory' }, { iss: 'https://evil.example/realms/other' });
  await assert.rejects(() => v.verify(token), /issuer|iss/i);
});

test('a token for a different audience (another app) is rejected', async () => {
  const idp = await makeIdp();
  const v = createVerifier({ issuer: ISSUER, audience: AUDIENCE, jwks: idp.jwks });
  const token = await idp.sign({ name: 'Mallory' }, { aud: 'some-other-client' });
  await assert.rejects(() => v.verify(token), /audience|aud/i);
});

test('an expired token is rejected', async () => {
  const idp = await makeIdp();
  const v = createVerifier({ issuer: ISSUER, audience: AUDIENCE, jwks: idp.jwks });
  const token = await idp.sign({ name: 'Ada' }, { exp: '-1m' }); // already expired
  await assert.rejects(() => v.verify(token), /exp|expired/i);
});

test('a token signed by the WRONG key (forgery) is rejected', async () => {
  const idp = await makeIdp();
  const attacker = await generateKeyPair('RS256');           // not in the published JWKS
  const v = createVerifier({ issuer: ISSUER, audience: AUDIENCE, jwks: idp.jwks });
  const forged = await idp.sign({ name: 'Mallory' }, { key: attacker.privateKey });
  await assert.rejects(() => v.verify(forged), /signature|verification|key/i);
});
