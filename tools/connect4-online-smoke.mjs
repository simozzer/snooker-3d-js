// connect4-online-smoke.mjs — proves the Connect Four online contract end-to-end WITHOUT a browser.
//   node --test tools/connect4-online-smoke.mjs
// Two real engines, two real RelayClients, one real relay. Each side relays its column {col}; the peer
// applies it. If the deterministic engines ever disagree, serialize() diverges. A late joiner replays
// the log to the identical position.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { RelayClient } from '../web/net.js';
import { createConnect4 } from '../src/board/connect4.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RELAY = join(HERE, '..', 'server', 'relay.js');
const PORT = 8093;
const url = `ws://127.0.0.1:${PORT}`;

const waitFor = (client, event, ms = 3000) => new Promise((resolve, reject) => {
  const to = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
  const off = client.on(event, (d) => { clearTimeout(to); off(); resolve(d); });
});
const moveFrom = (client, seat, ms = 3000) => new Promise((resolve, reject) => {
  const to = setTimeout(() => reject(new Error(`timeout waiting for move from seat ${seat}`)), ms);
  const off = client.on('move', (m) => { if (m.seat === seat) { clearTimeout(to); off(); resolve(m); } });
});
const seatOf = (colour) => (colour === 'r' ? 0 : 1); // seat 0 = Red (moves first)

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
  const created = await host.create({ game: 'connect4' });
  const guest = new RelayClient({ url, autoReconnect: false }); await guest.connect();
  const joinP = guest.join(created.code);
  await waitFor(host, 'peer-joined');
  await joinP;

  const A = createConnect4(); // host = seat 0 = Red (moves first)
  const B = createConnect4(); // guest = seat 1 = Yellow
  host.on('move', (m) => { if (m.seat !== host.seat) A.move({ col: m.payload.col }); });
  guest.on('move', (m) => { if (m.seat !== guest.seat) B.move({ col: m.payload.col }); });

  let plies = 0;
  for (; plies < 20 && !A.status().over; plies++) {
    const mover = A.turn() === 'r' ? { c: host, e: A } : { c: guest, e: B };
    const other = mover.c === host ? guest : host;
    // vary the column so the game actually develops (and isn't just one full column)
    const cols = mover.e.legalMoves();
    const col = cols[plies % cols.length];

    mover.e.move({ col });
    const delivered = moveFrom(other, mover.c.seat);
    mover.c.sendMove({ col }, seatOf(mover.e.turn()));
    await delivered;

    assert.equal(A.serialize(), B.serialize(), `boards diverged at ply ${plies}`);
  }
  assert.ok(plies >= 10, `expected a decent run of moves, got ${plies}`);

  host.close(); guest.close();
});

test('a mid-game joiner replays the log to the identical position', async () => {
  const host = new RelayClient({ url, autoReconnect: false }); await host.connect();
  const created = await host.create({ game: 'connect4' });
  const guest = new RelayClient({ url, autoReconnect: false }); await guest.connect();
  const joinP = guest.join(created.code);
  await waitFor(host, 'peer-joined');
  await joinP;

  const A = createConnect4(), B = createConnect4();
  host.on('move', (m) => { if (m.seat !== host.seat) A.move({ col: m.payload.col }); });
  guest.on('move', (m) => { if (m.seat !== guest.seat) B.move({ col: m.payload.col }); });

  for (let i = 0; i < 6; i++) {
    const mover = A.turn() === 'r' ? { c: host, e: A } : { c: guest, e: B };
    const other = mover.c === host ? guest : host;
    const col = mover.e.legalMoves()[i % 5];
    mover.e.move({ col });
    const delivered = moveFrom(other, mover.c.seat);
    mover.c.sendMove({ col }, seatOf(mover.e.turn()));
    await delivered;
  }

  guest.leave();
  const late = new RelayClient({ url, autoReconnect: false }); await late.connect();
  const joined = await late.join(created.code);
  const C = createConnect4();
  for (const e of joined.log) if (e.kind === 'move') C.move({ col: e.payload.col });
  assert.equal(C.serialize(), A.serialize(), 'replayed log did not reproduce the live board');

  host.close(); late.close();
});
