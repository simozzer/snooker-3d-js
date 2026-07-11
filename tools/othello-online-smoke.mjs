// othello-online-smoke.mjs — proves the Othello online contract end-to-end WITHOUT a browser.
//   node --test tools/othello-online-smoke.mjs
// Two real Othello engines, two real RelayClients, one real relay. Each side plays its own legal moves
// and relays the cell {r,c}; the peer applies it. Passes are handled inside the engine (no wire
// message), so the mover just names the seat it becomes after its move. If the deterministic engines
// ever disagree, serialize() diverges and the test fails. A late joiner replays the log to the same spot.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { RelayClient } from '../web/net.js';
import { createOthello } from '../src/board/othello.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RELAY = join(HERE, '..', 'server', 'relay.js');
const PORT = 8094;
const url = `ws://127.0.0.1:${PORT}`;

const waitFor = (client, event, ms = 3000) => new Promise((resolve, reject) => {
  const to = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
  const off = client.on(event, (d) => { clearTimeout(to); off(); resolve(d); });
});
const moveFrom = (client, seat, ms = 3000) => new Promise((resolve, reject) => {
  const to = setTimeout(() => reject(new Error(`timeout waiting for move from seat ${seat}`)), ms);
  const off = client.on('move', (m) => { if (m.seat === seat) { clearTimeout(to); off(); resolve(m); } });
});
const seatOf = (colour) => (colour === 'b' ? 0 : 1); // seat 0 = Black (moves first)
const apply = (e, p) => e.move({ r: p.r, c: p.c });

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
  const created = await host.create({ game: 'othello' });
  const guest = new RelayClient({ url, autoReconnect: false }); await guest.connect();
  const joinP = guest.join(created.code);
  await waitFor(host, 'peer-joined');
  await joinP;

  const A = createOthello(); // host = seat 0 = Black (moves first)
  const B = createOthello(); // guest = seat 1 = White
  host.on('move', (m) => { if (m.seat !== host.seat) apply(A, m.payload); });
  guest.on('move', (m) => { if (m.seat !== guest.seat) apply(B, m.payload); });

  let plies = 0;
  for (; plies < 24 && !A.status().over; plies++) {
    const mover = A.turn() === 'b' ? { c: host, e: A } : { c: guest, e: B };
    const other = mover.c === host ? guest : host;
    const move = mover.e.legalMoves()[0];
    if (!move) break;

    mover.e.move(move);                                   // optimistic local apply
    const delivered = moveFrom(other, mover.c.seat);
    mover.c.sendMove({ r: move.r, c: move.c }, seatOf(mover.e.turn()));
    await delivered;

    assert.equal(A.serialize(), B.serialize(), `boards diverged at ply ${plies}`);
  }
  assert.ok(plies >= 12, `expected a decent run of moves, got ${plies}`);

  host.close(); guest.close();
});

test('a mid-game joiner replays the log to the identical position', async () => {
  const host = new RelayClient({ url, autoReconnect: false }); await host.connect();
  const created = await host.create({ game: 'othello' });
  const guest = new RelayClient({ url, autoReconnect: false }); await guest.connect();
  const joinP = guest.join(created.code);
  await waitFor(host, 'peer-joined');
  await joinP;

  const A = createOthello(), B = createOthello();
  host.on('move', (m) => { if (m.seat !== host.seat) apply(A, m.payload); });
  guest.on('move', (m) => { if (m.seat !== guest.seat) apply(B, m.payload); });

  for (let i = 0; i < 6; i++) {
    const mover = A.turn() === 'b' ? { c: host, e: A } : { c: guest, e: B };
    const other = mover.c === host ? guest : host;
    const move = mover.e.legalMoves()[0];
    mover.e.move(move);
    const delivered = moveFrom(other, mover.c.seat);
    mover.c.sendMove({ r: move.r, c: move.c }, seatOf(mover.e.turn()));
    await delivered;
  }

  guest.leave();
  const late = new RelayClient({ url, autoReconnect: false }); await late.connect();
  const joined = await late.join(created.code);
  const C = createOthello();
  for (const e of joined.log) if (e.kind === 'move') apply(C, e.payload);
  assert.equal(C.serialize(), A.serialize(), 'replayed log did not reproduce the live board');

  host.close(); late.close();
});
