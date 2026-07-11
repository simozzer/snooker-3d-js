import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAuth, decodeJwt } from '../web/auth.js';

const ISSUER = 'https://games.example/realms/games';
const CLIENT = 'games-web';

// A test rig: controllable current URL, captured navigations, a Map-backed store, a mock token
// endpoint, and a fixed clock — all injected so the real browser flow runs headless in Node.
function rig(href) {
  const state = { href, assigned: null, replaced: null, fetchCalls: [] };
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  let tokenResponse = { access_token: 'AT', id_token: null, refresh_token: 'RT', expires_in: 300 };
  const deps = {
    getHref: () => state.href,
    assign: (u) => { state.assigned = u; },
    replace: (u) => { state.replaced = u; },
    storage,
    now: () => 1_000_000,
    fetch: async (url, opts) => {
      state.fetchCalls.push({ url, body: opts?.body?.toString() });
      return { ok: true, status: 200, json: async () => tokenResponse };
    },
  };
  return { state, storage, deps, setTokenResponse: (r) => { tokenResponse = r; } };
}

const jwt = (payload) => `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.`;

test('a disabled config yields a safe anonymous stub', async () => {
  const a = createAuth({ enabled: false });
  assert.equal(a.enabled, false);
  assert.equal(a.getUser(), null);
  assert.equal(await a.getAccessToken(), null);
  await a.login('google'); // must not throw
});

test('login builds a PKCE auth URL with a challenge matching the stored verifier', async () => {
  const r = rig('https://games.example/web/board.html?game=draughts');
  const a = createAuth({ enabled: true, issuer: ISSUER, clientId: CLIENT }, r.deps);
  await a.login('google');

  const u = new URL(r.state.assigned);
  assert.equal(u.origin + u.pathname, `${ISSUER}/protocol/openid-connect/auth`);
  assert.equal(u.searchParams.get('client_id'), CLIENT);
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('kc_idp_hint'), 'google');
  // redirect_uri preserves ?game= (so we return to the same game) and drops nothing else.
  assert.equal(u.searchParams.get('redirect_uri'), 'https://games.example/web/board.html?game=draughts');

  // challenge == base64url(sha256(verifier))
  const verifier = r.storage.getItem('oidc_verifier');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const expected = Buffer.from(digest).toString('base64url');
  assert.equal(u.searchParams.get('code_challenge'), expected);
});

test('handleRedirect swaps the code for tokens, returns the user, and cleans the URL', async () => {
  const r = rig('https://games.example/web/board.html?game=draughts');
  const a = createAuth({ enabled: true, issuer: ISSUER, clientId: CLIENT }, r.deps);
  // Simulate the pre-redirect state login() would have stored, then the callback URL.
  r.storage.setItem('oidc_state', 'S1');
  r.storage.setItem('oidc_verifier', 'VERIFIER');
  r.storage.setItem('oidc_redirect', 'https://games.example/web/board.html?game=draughts');
  r.setTokenResponse({ access_token: 'AT123', refresh_token: 'RT', expires_in: 300, id_token: jwt({ sub: 'u1', name: 'Ada Lovelace', email: 'ada@x.com' }) });
  r.state.href = 'https://games.example/web/board.html?game=draughts&code=CODE1&state=S1';

  const user = await a.handleRedirect();
  assert.equal(user.name, 'Ada Lovelace');
  assert.equal(user.sub, 'u1');

  // The POST carried the auth-code grant with our verifier and the matching redirect_uri.
  const call = r.state.fetchCalls[0];
  assert.equal(call.url, `${ISSUER}/protocol/openid-connect/token`);
  assert.match(call.body, /grant_type=authorization_code/);
  assert.match(call.body, /code=CODE1/);
  assert.match(call.body, /code_verifier=VERIFIER/);

  // Address bar cleaned of code/state; ?game= kept.
  assert.equal(r.state.replaced, 'https://games.example/web/board.html?game=draughts');
  // Token is now available to feed the relay.
  assert.equal(await a.getAccessToken(), 'AT123');
});

test('a mismatched state is rejected (CSRF protection)', async () => {
  const r = rig('https://games.example/web/board.html?code=X&state=WRONG');
  const a = createAuth({ enabled: true, issuer: ISSUER, clientId: CLIENT }, r.deps);
  r.storage.setItem('oidc_state', 'EXPECTED');
  await assert.rejects(() => a.handleRedirect(), /state-mismatch/);
});

test('getAccessToken refreshes silently when the token has expired', async () => {
  const r = rig('https://games.example/web/board.html');
  const a = createAuth({ enabled: true, issuer: ISSUER, clientId: CLIENT }, r.deps);
  // Seed an already-expired token with a refresh token; now() is 1_000_000.
  r.storage.setItem('oidc_tokens', JSON.stringify({ access_token: 'OLD', refresh_token: 'RT', expiresAt: 500_000 }));
  r.setTokenResponse({ access_token: 'FRESH', refresh_token: 'RT2', expires_in: 300 });
  assert.equal(await a.getAccessToken(), 'FRESH');
  assert.match(r.state.fetchCalls[0].body, /grant_type=refresh_token/);
});

test('decodeJwt reads the payload without verifying', () => {
  const p = decodeJwt(jwt({ sub: 'abc', name: 'Grace' }));
  assert.equal(p.sub, 'abc');
  assert.equal(p.name, 'Grace');
});
