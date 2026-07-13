// config.js — the ONE place the client is pointed at its backend, and the ONLY file that decides
// where "online" lives. It ships with safe, origin-relative defaults so the static client can be
// mirrored to ANY CDN with nothing internal baked in:
//   • no hostnames, no tailnet names, no realm URLs are hard-coded here;
//   • the relay and login endpoints are derived from wherever the page is actually served from;
//   • a deployment may override any of them WITHOUT editing source, by defining a global
//     __GAMES_CONFIG__ before the modules load — e.g. an un-committed web/config.local.js pulled in
//     with a <script> tag, or a snippet injected by the CDN/proxy at deploy time.
// If the backend is unreachable (or these resolve to nothing), solo and hot-seat play are unaffected —
// only the OPTIONAL online features light up "offline". Nothing here is a secret; it is safe to publish.

const OVERRIDE = (typeof globalThis !== 'undefined' && globalThis.__GAMES_CONFIG__) || {};
const loc = typeof location !== 'undefined' ? location : null;
const isHttps = !!loc && loc.protocol === 'https:';

// The multiplayer relay WebSocket, same-origin by default: behind an HTTPS reverse proxy it's /relay on
// 443; on plain-HTTP LAN/dev it's a sibling service on :8090. Overridable via __GAMES_CONFIG__.relayUrl
// (and, per-visit, the ?relay= query param handled in net.js). Served from a foreign CDN origin with no
// override, this points at a /relay that isn't there — the socket simply fails and the app goes offline.
export function relayUrl() {
  if (OVERRIDE.relayUrl) return OVERRIDE.relayUrl;
  if (!loc) return 'ws://127.0.0.1:8090';                 // Node integration tests
  if (isHttps) return `wss://${loc.host}/relay`;
  return `ws://${loc.hostname || '127.0.0.1'}:8090`;
}

// OIDC login config. The shipped artifact enables NO login: the issuer is empty unless a deployment
// explicitly provides one via __GAMES_CONFIG__.authIssuer (see web/config.local.js, loaded before the
// modules on each page). This keeps the bundle host-agnostic — a bare CDN mirror shows no login button
// at all and the app is fully anonymous — while the real deployment points it at its own Keycloak. We
// never derive the issuer from the serving origin, because the client can't know whether that origin
// actually fronts an identity provider; a wrong guess would only produce a login button that 404s.
export function authConfig() {
  const issuer = OVERRIDE.authIssuer || '';
  return {
    enabled: (OVERRIDE.authEnabled ?? true) && !!issuer, // no issuer ⇒ login off, no matter what
    issuer,
    clientId: OVERRIDE.authClientId || 'games-web',       // public PKCE client id — not a secret
    scopes: 'openid profile email',
    requireLogin: false,
  };
}
