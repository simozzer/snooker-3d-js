// roster.js — OPTIONAL registered-user roster from Keycloak's admin API. When configured with a
// service-account client (client_credentials grant + the `view-users` role on the realm), the relay
// can list everyone who has an ACCOUNT — not just who's online, and not just who's played a game — so
// the Community page can show the whole membership by first name + two surname initials.
//
// It is deliberately OPTIONAL and secret-free by default: with no KC_ROSTER_* env the roster is
// disabled and the relay behaves exactly as before (mirrors auth.js). The client secret lives only in
// this server process's environment — never in the browser bundle, never on the CDN. Only a first name
// plus the surname's first and last letter (falling back to username) ever leave this module — never a
// full surname; the OIDC `sub` is kept internal for correlation.
//
// Resilience: the user list is cached and refreshed on a TTL. A transient Keycloak blip serves the
// last good cache (stale-ok) rather than blanking the page, and failures back off so we don't hammer.

const FIVE_MIN = 5 * 60 * 1000;

// Community display name: the first name plus the first and last letters of the surname with the
// middle hidden (e.g. "Moscrop" → "M·p", so "Simon M·p"). Distinguishes Cook from Cooper on the
// Community page while never printing the full surname. Falls back to the username when there's no
// first name. Exported so the client can format identically (see lobby.js).
export function communityName(first, last, username) {
  const f = (first && String(first).trim()) || '';
  const l = (last && String(last).trim()) || '';
  if (f && l) {
    const tag = l.length > 1
      ? `${l[0].toUpperCase()}·${l[l.length - 1].toLowerCase()}` // "Moscrop" → "M·p"
      : l[0].toUpperCase();                                          // single-letter surname → just it
    return `${f} ${tag}`;
  }
  return f || (username && String(username).trim()) || null;
}

export function createRoster({
  base = null,            // Keycloak base incl. context path, e.g. http://10.43.180.247:8080/auth
  realm = null,           // realm holding the game accounts, e.g. games
  clientId = null,        // the service-account client id
  clientSecret = null,    // its secret (from env only)
  group = null,           // OPTIONAL group name — list only its members instead of ALL realm users
  ttlMs = FIVE_MIN,
  retryMs = 30_000,       // back-off before retrying after a failed refresh
  maxUsers = 2000,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
} = {}) {
  const enabled = !!(base && realm && clientId && clientSecret && fetchImpl);
  const b = base ? base.replace(/\/$/, '') : base;

  let cache = [];          // last good [{ sub, name, username }]
  let nextTryAt = 0;       // don't attempt a refresh before this (TTL / back-off)
  let inflight = null;     // de-dupe concurrent refreshes
  let groupId = null;      // resolved once from `group`, then cached

  async function token() {
    const res = await fetchImpl(`${b}/realms/${realm}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
    });
    if (!res.ok) throw new Error(`token ${res.status}`);
    const j = await res.json();
    if (!j.access_token) throw new Error('token: no access_token');
    return j.access_token;
  }

  // Resolve a group NAME to its id (top-level group). Cached after the first success.
  async function resolveGroupId(at) {
    const res = await fetchImpl(`${b}/admin/realms/${realm}/groups?search=${encodeURIComponent(group)}&max=100`, {
      headers: { authorization: `Bearer ${at}` },
    });
    if (!res.ok) throw new Error(`groups ${res.status}`);
    const arr = await res.json();
    const match = (Array.isArray(arr) ? arr : []).find((g) => g.name === group || g.path === group || g.path === `/${group}`);
    if (!match) throw new Error(`group not found: ${group}`);
    return match.id;
  }

  async function fetchUsers() {
    const at = await token();
    // With a group configured, list only its members (so registered-but-not-a-player accounts stay
    // out of the roster); otherwise the whole realm. `briefRepresentation` carries firstName + lastName.
    let url;
    if (group) {
      if (!groupId) groupId = await resolveGroupId(at);
      url = `${b}/admin/realms/${realm}/groups/${groupId}/members?briefRepresentation=true&max=${maxUsers}`;
    } else {
      url = `${b}/admin/realms/${realm}/users?briefRepresentation=true&max=${maxUsers}`;
    }
    const res = await fetchImpl(url, { headers: { authorization: `Bearer ${at}` } });
    if (!res.ok) throw new Error(`${group ? 'members' : 'users'} ${res.status}`);
    const arr = await res.json();
    // First name + the surname's first and last letter (fall back to username); skip disabled accounts.
    return (Array.isArray(arr) ? arr : [])
      .filter((u) => u && u.enabled !== false && (u.firstName || u.username))
      .map((u) => ({ sub: u.id, name: communityName(u.firstName, u.lastName, u.username), username: u.username || null }));
  }

  async function refresh() {
    const users = await fetchUsers();
    cache = users; nextTryAt = now() + ttlMs;
    return cache;
  }

  return {
    enabled,

    // The registered-user roster. Refreshes past its TTL; serves the last good cache immediately while
    // a refresh runs, and on the very first load waits for it. Errors are logged and backed off, never
    // thrown — the caller always gets an array.
    async list() {
      if (!enabled) return [];
      if (now() >= nextTryAt && !inflight) {
        inflight = refresh()
          .catch((e) => { console.error('roster refresh failed:', e.message); nextTryAt = now() + retryMs; return cache; })
          .finally(() => { inflight = null; });
      }
      if (cache.length) return cache;         // good or stale — don't block
      if (inflight) { try { return await inflight; } catch { return cache; } }
      return cache;                            // [] until the first successful load
    },

    // Warm the cache at boot so the first Community request is instant. Never throws.
    async warm() { if (enabled) { try { await this.list(); } catch { /* logged in list() */ } } },
  };
}

// Build a roster straight from process.env. Disabled (and harmless) unless the four required vars are set.
//   KC_ROSTER_BASE           e.g. http://10.43.180.247:8080/auth
//   KC_ROSTER_REALM          e.g. games
//   KC_ROSTER_CLIENT_ID      the service-account client id
//   KC_ROSTER_CLIENT_SECRET  its secret
//   KC_ROSTER_GROUP          (optional) group name to scope the roster to, e.g. games-players
export function rosterFromEnv(env = process.env) {
  return createRoster({
    base: env.KC_ROSTER_BASE || null,
    realm: env.KC_ROSTER_REALM || null,
    clientId: env.KC_ROSTER_CLIENT_ID || null,
    clientSecret: env.KC_ROSTER_CLIENT_SECRET || null,
    group: env.KC_ROSTER_GROUP || null,   // e.g. games-players — list only this group's members
    ttlMs: env.KC_ROSTER_TTL_MS ? Number(env.KC_ROSTER_TTL_MS) : undefined,
  });
}
