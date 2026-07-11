// draughts-online-smoke.mjs — proves the draughts online contract end-to-end WITHOUT a browser.
//   node --test tools/draughts-online-smoke.mjs
// Two real draughts engines, two real RelayClients, one real relay. Each side plays its own legal
// moves locally and relays {from,path}; the peer applies it. If the deterministic engines ever
// disagree, serialize() diverges and the test fails. Also checks that a late joiner replays the
// move-log to the identical live position — the exact resync web/games/draughts-view.js performs.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { RelayClient } from '../web/net.js';
import { createDraughts } from '../src/board/draughts.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RELAY = join(HERE, '..', 'server', 'relay.js');
const PORT = 8099;
const url = `ws://127.0.0.1:${PORT}`;

const waitFor = (client, event, ms = 3000) => new Promise((resolve, reject) => {
  const to = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
  const off = client.on(event, (d) => { clearTimeout(to); off(); resolve(d); });
});
// Resolve when a move FROM a specific seat arrives — a client also receives its own move-echoes, so
// waiting on bare 'move' can be satisfied by the wrong one (a stale self-echo).
const moveFrom = (client, seat, ms = 3000) => new Promise((resolve, reject) => {
  const to = setTimeout(() => reject(new Error(`timeout waiting for move from seat ${seat}`)), ms);
  const off = client.on('move', (m) => { if (m.seat === seat) { clearTimeout(to); off(); resolve(m); } });
});
const seatOf = (colour) => (colour === 'r' ? 0 : 1);

let server;
before(async () => {
  server = spawn(process.execPath, [RELAY, String(PORT)], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('relay did not start')), 5000);
    server.stdout.on('data', (d) => { if (String(d).includes('listening')) { clearTimeout(to); resolve(); } });
  });
});
after(() => server?.kill('SIGTERM'));

test('two engines stay in perfect lockstep over the relay', async () => {
  const host = new RelayClient({ url, autoReconnect: false }); await host.connect();
  const created = await host.create({ game: 'draughts' });
  const guest = new RelayClient({ url, autoReconnect: false }); await guest.connect();
  const joinP = guest.join(created.code);
  await waitFor(host, 'peer-joined');
  await joinP;

  const A = createDraughts(); // host = seat 0 = Red (moves first)
  const B = createDraughts(); // guest = seat 1 = White
  // Each engine applies ONLY the peer's moves (it applied its own locally before relaying).
  host.on('move', (m) => { if (m.seat !== host.seat) A.move({ from: m.payload.from, path: m.payload.path }); });
  guest.on('move', (m) => { if (m.seat !== guest.seat) B.move({ from: m.payload.from, path: m.payload.path }); });

  let plies = 0;
  for (; plies < 16 && !A.status().over; plies++) {
    const mover = A.turn() === 'r' ? { c: host, e: A } : { c: guest, e: B };
    const other = mover.c === host ? guest : host;
    const move = mover.e.allLegalMoves()[0];
    if (!move) break;

    mover.e.move(move);                                   // optimistic local apply
    const delivered = moveFrom(other, mover.c.seat);
    mover.c.sendMove({ from: move.from, path: move.path }, seatOf(mover.e.turn()));
    await delivered;

    assert.equal(A.serialize(), B.serialize(), `boards diverged at ply ${plies}`);
  }
  assert.ok(plies >= 8, `expected a decent run of moves, got ${plies}`);

  host.close(); guest.close();
});

test('a mid-game joiner replays the log to the identical position', async () => {
  const host = new RelayClient({ url, autoReconnect: false }); await host.connect();
  const created = await host.create({ game: 'draughts' });
  const guest = new RelayClient({ url, autoReconnect: false }); await guest.connect();
  const joinP = guest.join(created.code);
  await waitFor(host, 'peer-joined');
  await joinP;

  const A = createDraughts(), B = createDraughts();
  host.on('move', (m) => { if (m.seat !== host.seat) A.move({ from: m.payload.from, path: m.payload.path }); });
  guest.on('move', (m) => { if (m.seat !== guest.seat) B.move({ from: m.payload.from, path: m.payload.path }); });

  for (let i = 0; i < 5; i++) {
    const mover = A.turn() === 'r' ? { c: host, e: A } : { c: guest, e: B };
    const other = mover.c === host ? guest : host;
    const move = mover.e.allLegalMoves()[0];
    mover.e.move(move);
    const delivered = moveFrom(other, mover.c.seat);
    mover.c.sendMove({ from: move.from, path: move.path }, seatOf(mover.e.turn()));
    await delivered;
  }

  // A spectator/late player joins: replay joined.log into a fresh engine (view.onlineResync path).
  guest.leave();
  const late = new RelayClient({ url, autoReconnect: false }); await late.connect();
  const joined = await late.join(created.code);
  const C = createDraughts();
  for (const e of joined.log) if (e.kind === 'move') C.move({ from: e.payload.from, path: e.payload.path });
  assert.equal(C.serialize(), A.serialize(), 'replayed log did not reproduce the live board');

  host.close(); late.close();
});
