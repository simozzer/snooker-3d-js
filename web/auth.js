// auth.js — browser-side OIDC login for the games site, dependency-free. It runs the standard
// Authorization Code + PKCE flow against Keycloak (which brokers Google / Microsoft / Facebook), so
// the app never sees a provider secret and never handles passwords. The flow:
//   login(provider) → redirect to Keycloak (optionally straight to a provider via kc_idp_hint)
//   …provider auth…  → Keycloak redirects back with ?code
//   handleRedirect() → swap the code for tokens (PKCE proves it's the same client), stash them, and
//                      strip the code from the address bar. getAccessToken() feeds the relay.
//
// All browser touch-points (current URL, navigation, storage, fetch, clock) are injectable, so the
// whole flow is unit-testable in Node without a real Keycloak — the defaults are the real browser
// APIs. When AUTH.enabled is false, createAuth returns a disabled stub and the app stays anonymous.

// --- small crypto/encoding helpers (Web Crypto + base64url) -------------------------------------
const b64url = (bytes) => {
  let s = '';
  for (const x of new Uint8Array(bytes)) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const b64urlDecode = (str) => {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  s += '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
};
const randomString = (bytes = 32) => { const a = new Uint8Array(bytes); crypto.getRandomValues(a); return b64url(a.buffer); };
const sha256 = async (text) => b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));

// Decode a JWT payload (no verification — the RELAY verifies; here we only read display fields).
export function decodeJwt(token) {
  try { return JSON.parse(b64urlDecode(token.split('.')[1])); } catch { return null; }
}

// Create a login controller. `config` = { enabled, issuer, clientId, scopes }. `deps` overrides the
// browser touch-points for tests: { getHref, assign, replace, storage, fetch, now }.
export function createAuth(config = {}, deps = {}) {
  const { enabled = false, issuer = '', clientId = '', scopes = 'openid profile email' } = config;
  const base = issuer.replace(/\/$/, '');
  const ENDPOINT = {
    auth: `${base}/protocol/openid-connect/auth`,
    token: `${base}/protocol/openid-connect/token`,
    logout: `${base}/protocol/openid-connect/logout`,
  };

  const mem = new Map();
  const getHref = deps.getHref ?? (() => location.href);
  const assign = deps.assign ?? ((url) => { location.href = url; });
  const replace = deps.replace ?? ((url) => { try { history.replaceState({}, '', url); } catch { /* no history */ } });
  const store = deps.storage ?? (typeof sessionStorage !== 'undefined' ? sessionStorage
    : { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) });
  const fetchImpl = deps.fetch ?? ((...a) => fetch(...a));
  const now = deps.now ?? (() => Date.now());

  // The redirect URI is the current page WITHOUT any OAuth params — so ?game= is preserved and the
  // callback lands back on the same game. Register it in Keycloak as a wildcard (…/board.html*).
  const redirectUri = () => {
    const u = new URL(getHref());
    for (const k of ['code', 'state', 'session_state', 'iss']) u.searchParams.delete(k);
    return u.toString();
  };
  const tokens = () => { try { return JSON.parse(store.getItem('oidc_tokens')); } catch { return null; } };
  const saveTokens = (t) => store.setItem('oidc_tokens', JSON.stringify({
    access_token: t.access_token, id_token: t.id_token, refresh_token: t.refresh_token,
    expiresAt: now() + (Number(t.expires_in) || 60) * 1000,
  }));

  if (!enabled || !issuer) {
    // Disabled stub: the app calls these unconditionally, so they must be safe no-ops.
    return { enabled: false, async handleRedirect() { return null; }, async login() {}, logout() {},
      getUser() { return null; }, async getAccessToken() { return null; } };
  }

  async function login(provider) {
    const verifier = randomString();
    const state = randomString(16);
    store.setItem('oidc_verifier', verifier);
    store.setItem('oidc_state', state);
    store.setItem('oidc_redirect', redirectUri()); // remember EXACTLY what we sent (token step must match)
    const params = new URLSearchParams({
      client_id: clientId, redirect_uri: redirectUri(), response_type: 'code',
      scope: scopes, state, code_challenge: await sha256(verifier), code_challenge_method: 'S256',
    });
    if (provider) params.set('kc_idp_hint', provider); // jump straight to google / microsoft / facebook
    assign(`${ENDPOINT.auth}?${params}`);
  }

  // Called once on page load. If we're returning from Keycloak (?code present), exchange it for
  // tokens and clean the URL. Returns the logged-in user (or null).
  async function handleRedirect() {
    const u = new URL(getHref());
    const code = u.searchParams.get('code');
    if (!code) return getUser();
    const state = u.searchParams.get('state');
    const cleanup = () => replace(redirectUri());
    if (!state || state !== store.getItem('oidc_state')) { cleanup(); throw new Error('state-mismatch'); }
    const body = new URLSearchParams({
      grant_type: 'authorization_code', code, client_id: clientId,
      redirect_uri: store.getItem('oidc_redirect') || redirectUri(),
      code_verifier: store.getItem('oidc_verifier') || '',
    });
    const res = await fetchImpl(ENDPOINT.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    if (!res.ok) { cleanup(); throw new Error(`token-exchange-failed (${res.status})`); }
    saveTokens(await res.json());
    for (const k of ['oidc_verifier', 'oidc_state', 'oidc_redirect']) store.removeItem(k);
    cleanup();
    return getUser();
  }

  function getUser() {
    const t = tokens();
    const claims = t?.id_token ? decodeJwt(t.id_token) : null;
    if (!claims) return null;
    return { sub: claims.sub, name: claims.name || claims.preferred_username || claims.email || 'player', email: claims.email ?? null, picture: claims.picture ?? null };
  }

  // The token the relay needs. Refreshes silently when it's within 30s of expiry.
  async function getAccessToken() {
    const t = tokens();
    if (!t) return null;
    if (now() < t.expiresAt - 30_000) return t.access_token;
    if (t.refresh_token) {
      try {
        const res = await fetchImpl(ENDPOINT.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: t.refresh_token }) });
        if (res.ok) { saveTokens(await res.json()); return tokens().access_token; }
      } catch { /* fall through to the stale token */ }
    }
    return t.access_token;
  }

  function logout() {
    const t = tokens();
    store.removeItem('oidc_tokens');
    const params = new URLSearchParams({ post_logout_redirect_uri: redirectUri(), client_id: clientId });
    if (t?.id_token) params.set('id_token_hint', t.id_token);
    assign(`${ENDPOINT.logout}?${params}`);
  }

  return { enabled: true, login, logout, handleRedirect, getUser, getAccessToken };
}
