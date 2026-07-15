// roster-smoke.mjs — unit test for server/roster.js against a MOCK Keycloak (an injected fetch). No
// live server, no secrets. Proves: client_credentials → admin users call, first-name + surname-initials mapping,
// TTL caching, and stale-cache-on-error (a Keycloak blip never blanks the roster).
//   node --test tools/roster-smoke.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoster } from '../server/roster.js';

// A fake Keycloak: hands out a token, then returns a user list. Counts calls so we can assert caching,
// and can be flipped to fail to prove the stale-cache path.
function mockKeycloak(users, { failUsers = false } = {}) {
  const calls = { token: 0, users: 0 };
  const fetchImpl = async (url, opts) => {
    if (url.endsWith('/protocol/openid-connect/token')) {
      calls.token++;
      assert.match(opts.body.toString(), /grant_type=client_credentials/, 'must use client_credentials');
      return { ok: true, json: async () => ({ access_token: 'tok-' + calls.token, expires_in: 60 }) };
    }
    if (url.includes('/admin/realms/')) {
      calls.users++;
      assert.match(opts.headers.authorization, /^Bearer tok-\d+$/, 'sends the bearer token from the token call');
      if (failUsers) return { ok: false, status: 503, json: async () => ({}) };
      return { ok: true, json: async () => users };
    }
    throw new Error('unexpected url ' + url);
  };
  return { fetchImpl, calls };
}

const CFG = { base: 'http://kc.test/auth', realm: 'games', clientId: 'games-roster', clientSecret: 's3cr3t' };

test('disabled without full config — returns [] and never calls out', async () => {
  let called = false;
  const r = createRoster({ realm: 'games', fetchImpl: async () => { called = true; } });
  assert.equal(r.enabled, false);
  assert.deepEqual(await r.list(), []);
  assert.equal(called, false);
});

test('lists first name + two surname initials (fallback to username), skips disabled accounts', async () => {
  const { fetchImpl } = mockKeycloak([
    { id: 'a', firstName: 'Simon', lastName: 'Moscrop', username: 'simon' }, // "Simon Mo"
    { id: 'b', firstName: '  Marie ', lastName: ' Curie ', username: 'marie99' }, // trimmed → "Marie Cu"
    { id: 'c', firstName: 'Prince', username: 'prince' },       // no surname → first name only
    { id: 'e', firstName: '', username: 'pierre' },             // no first name → falls back to username
    { id: 'd', firstName: 'Ghost', lastName: 'Ly', username: 'ghost', enabled: false }, // skipped
  ]);
  const r = createRoster({ ...CFG, fetchImpl });
  const list = await r.list();
  assert.deepEqual(list.map((u) => u.name), ['Simon Mo', 'Marie Cu', 'Prince', 'pierre']);
  assert.deepEqual(list.map((u) => u.sub), ['a', 'b', 'c', 'e'], 'keeps sub internally for correlation');
});

test('caches within TTL, refreshes after it', async () => {
  let t = 1000;
  const { fetchImpl, calls } = mockKeycloak([{ id: 'a', firstName: 'Simon', username: 'simon' }]);
  const r = createRoster({ ...CFG, fetchImpl, ttlMs: 5000, now: () => t });
  await r.list(); await r.list(); await r.list();
  assert.equal(calls.users, 1, 'served from cache within TTL');
  t += 6000;                       // past TTL
  await r.list();                  // serves stale immediately, refreshes in the background
  await new Promise((res) => setImmediate(res)); // let the background refresh settle
  assert.equal(calls.users, 2, 'refreshed after TTL');
});

test('group mode: resolves the group id, then lists ONLY its members (never /users)', async () => {
  const calls = { groups: 0, members: 0 };
  const fetchImpl = async (url) => {
    if (url.endsWith('/protocol/openid-connect/token')) return { ok: true, json: async () => ({ access_token: 'tok' }) };
    if (url.includes('/groups?search=')) {
      calls.groups++;
      return { ok: true, json: async () => [{ id: 'g1', name: 'games-players', path: '/games-players' }, { id: 'g2', name: 'other' }] };
    }
    if (url.includes('/groups/g1/members')) {
      calls.members++;
      return { ok: true, json: async () => [{ id: 'a', firstName: 'Kevin', username: 'kev' }, { id: 'b', firstName: 'Simon', username: 'simonmoscrop' }] };
    }
    if (url.includes('/users')) throw new Error('must NOT hit /users in group mode');
    throw new Error('unexpected url ' + url);
  };
  const r = createRoster({ ...CFG, group: 'games-players', fetchImpl });
  const list = await r.list();
  assert.deepEqual(list.map((u) => u.name), ['Kevin', 'Simon'], 'only the group members appear');
  assert.equal(calls.groups, 1, 'resolved the group id once');
  assert.equal(calls.members, 1, 'listed group members, not all users');
});

test('serves last good cache when Keycloak fails (stale-ok)', async () => {
  let t = 1000, fail = false;
  const fetchImpl = async (url, opts) => {
    if (url.endsWith('/token')) return { ok: true, json: async () => ({ access_token: 'x' }) };
    if (fail) return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, json: async () => [{ id: 'a', firstName: 'Simon', username: 'simon' }] };
  };
  const r = createRoster({ ...CFG, fetchImpl, ttlMs: 100, retryMs: 100, now: () => t });
  assert.equal((await r.list())[0].name, 'Simon');   // warm cache
  fail = true; t += 200;                              // TTL elapsed, next refresh will fail
  const still = await r.list();
  assert.equal(still[0]?.name, 'Simon', 'kept the last good roster despite the 503');
});
