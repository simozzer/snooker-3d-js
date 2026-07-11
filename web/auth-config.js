// auth-config.js — where you switch on OIDC login for the games site. Until `enabled` is true (and
// `issuer` points at your Keycloak realm), the app runs exactly as before: no login button, anonymous
// online play. Flip these on once the `games` realm + `games-web` client exist and the site is reached
// over the public HTTPS Tailscale Funnel host (so the redirect URIs resolve).
//
// The `games` realm + public `games-web` client already exist in plaid-keycloak (PKCE S256 enforced).
// NOTE the /auth base path — plaid-keycloak serves under /auth, so it's part of the issuer.
//
// To go live: set enabled:true and fill in the Funnel host, e.g.
//   issuer: 'https://games.<tailnet>.ts.net/auth/realms/games'
// and add that host's redirect URI to the games-web client:
//   https://games.<tailnet>.ts.net/web/board.html*
// (Only http://localhost:8123/web/board.html* is registered so far, for local testing via a
//  `kubectl port-forward svc/plaid-keycloak 8080:8080` in the tenant-tartan-solutions namespace.)
export const AUTH = {
  enabled: true,           // email/password self-registration live; Google/MS/FB can be added later
  issuer: 'https://piserver.tail62d127.ts.net/auth/realms/games',
  clientId: 'games-web',   // public PKCE client in plaid-keycloak
  scopes: 'openid profile email',
  requireLogin: false,
};
