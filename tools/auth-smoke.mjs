// auth-smoke.mjs — end-to-end test of the relay's OIDC gating against a MOCK identity provider.
//   node --test tools/auth-smoke.mjs
// Stands up a tiny HTTP server publishing a JWKS (as Keycloak would), spawns the real relay with
// REQUIRE_AUTH and pointed at that JWKS, and drives a real RelayClient: create is refused until a
// valid token is presented; a forged/foreign token is rejected; a genuine token unlocks the room.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { RelayClient } from '../web/net.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RELAY = join(HERE, '..', 'server', 'relay.js');
const RELAY_PORT = 8100 + (process.pid % 300);
const JWKS_PORT = 8500 + (process.pid % 300);
const url = `ws://127.0.0.1:${RELAY_PORT}`;
const ISSUER = 'https://kc.test/realms/games';
const AUDIENCE = 'games-web';

const waitFor = (client, event, ms = 3000) => new Promise((resolve, reject) => {
  const to = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
  const off = client.on(event, (d) => { clearTimeout(to); off(); resolve(d); });
});

let jwksServer, relay, privateKey, attackerKey;
const sign = (claims, { iss = ISSUER, aud = AUDIENCE, exp = '5m', key } = {}) =>
  new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'test-1' })
    .setIssuer(iss).setAudience(aud).setSubject(claims.sub || 'user-1').setExpirationTime(exp).sign(key || privateKey);

before(async () => {
  const kp = await generateKeyPair('RS256');
  privateKey = kp.privateKey;
  attackerKey = (await generateKeyPair('RS256')).privateKey;
  const jwk = { ...(await exportJWK(kp.publicKey)), kid: 'test-1', alg: 'RS256', use: 'sig' };

  // Publish the JWKS the relay will fetch to verify signatures.
  jwksServer = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise((r) => jwksServer.listen(JWKS_PORT, r));

  relay = spawn(process.execPath, [RELAY, String(RELAY_PORT)], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, OIDC_ISSUER: ISSUER, OIDC_AUDIENCE: AUDIENCE, OIDC_JWKS_URI: `http://127.0.0.1:${JWKS_PORT}/certs`, REQUIRE_AUTH: '1',
      DATA_DIR: mkdtempSync(join(tmpdir(), 'relay-stats-')) }, // isolate stats file from the repo
  });
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('relay did not start')), 5000);
    relay.stdout.on('data', (d) => { if (String(d).includes('listening')) { clearTimeout(to); resolve(); } });
  });
});

after(() => { relay?.kill('SIGTERM'); jwksServer?.close(); });

test('the relay advertises that auth is required', async () => {
  const c = new RelayClient({ url, autoReconnect: false });
  const welcome = await c.connect();
  assert.equal(welcome.authRequired, true);
  c.close();
});

test('create is refused without a token, and allowed with a valid one', async () => {
  const c = new RelayClient({ url, autoReconnect: false });
  await c.connect();
  await assert.rejects(() => c.create({ game: 'draughts' }), /auth-required/);

  const authed = await c.authenticate(await sign({ name: 'Ada', preferred_username: 'ada' }));
  assert.equal(authed.name, 'Ada');

  const created = await c.create({ game: 'draughts' });
  assert.equal(created.seat, 0);
  c.close();
});

test('a forged token (wrong key) is rejected', async () => {
  const c = new RelayClient({ url, autoReconnect: false });
  await c.connect();
  const forged = await sign({ name: 'Mallory' }, { key: attackerKey });
  await assert.rejects(() => c.authenticate(forged), /auth-failed/);
  await assert.rejects(() => c.create({ game: 'draughts' }), /auth-required/); // still not authed
  c.close();
});

test('the verified name is used as the player name (not a client-supplied one)', async () => {
  const c = new RelayClient({ url, autoReconnect: false });
  await c.connect();
  await c.authenticate(await sign({ name: 'Real Name', preferred_username: 'real' }));
  const created = await c.create({ game: 'draughts', name: 'Spoofed' }); // client tries to override

  // A second client joins and reads the seat list — seat 0 must carry the TOKEN name, not 'Spoofed'.
  const g = new RelayClient({ url, autoReconnect: false });
  await g.connect();
  await g.authenticate(await sign({ name: 'Guest', sub: 'user-2' }));
  const joined = await g.join(created.code);
  const host = joined.players.find((p) => p.seat === 0);
  assert.equal(host.name, 'Real Name');
  c.close(); g.close();
});

test('a finished game is tallied per authenticated player (win/loss)', async () => {
  const host = new RelayClient({ url, autoReconnect: false }); await host.connect();
  const ha = await host.authenticate(await sign({ name: 'Ada', sub: 'ada-stats' }));
  assert.equal(ha.games, 0); // fresh identity greeted with zero totals
  const created = await host.create({ game: 'draughts' });

  const guest = new RelayClient({ url, autoReconnect: false }); await guest.connect();
  await guest.authenticate(await sign({ name: 'Bob', sub: 'bob-stats' }));
  const jp = guest.join(created.code);
  await waitFor(host, 'peer-joined'); await jp;

  // Two real moves (both seats) so the game qualifies to be counted.
  host.sendMove({ n: 1 }, 1); await waitFor(guest, 'move');
  guest.sendMove({ n: 2 }, 0); await waitFor(host, 'move');

  const hostStats = waitFor(host, 'stats'); const guestStats = waitFor(guest, 'stats');
  host.sendGameOver(0); // seat 0 (Ada) wins
  const hs = await hostStats, gs = await guestStats;
  assert.deepEqual({ games: hs.games, wins: hs.wins }, { games: 1, wins: 1 }, 'winner: 1 game, 1 win');
  assert.deepEqual({ games: gs.games, wins: gs.wins }, { games: 1, wins: 0 }, 'loser: 1 game, 0 wins');

  // A second game-over for the same room must NOT double-count.
  host.sendGameOver(0);
  const reAuth = await host.authenticate(await sign({ name: 'Ada', sub: 'ada-stats' }));
  assert.equal(reAuth.games, 1, 'still 1 game — room counted only once');
  host.close(); guest.close();
});
