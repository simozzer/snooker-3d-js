// chess-online-smoke.mjs — proves the chess online contract end-to-end WITHOUT a browser.
//   node --test tools/chess-online-smoke.mjs
// Two real chess engines, two real RelayClients, one real relay. Each side plays its own legal moves
// locally and relays {from,to,promotion}; the peer applies it. If the deterministic engines ever
// disagree, fen() diverges and the test fails. Also checks that a late joiner replays the move-log to
// the identical live position — the exact resync web/games/chess-view.js performs.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { RelayClient } from '../web/net.js';
import { createChess } from '../src/board/chess.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RELAY = join(HERE, '..', 'server', 'relay.js');
const PORT = 8096;
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
const seatOf = (colour) => (colour === 'w' ? 0 : 1); // seat 0 = White (creator, moves first)
const applyPayload = (e, p) => e.move({ from: p.from, to: p.to, promotion: p.promotion });

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
  const created = await host.create({ game: 'chess' });
  const guest = new RelayClient({ url, autoReconnect: false }); await guest.connect();
  const joinP = guest.join(created.code);
  await waitFor(host, 'peer-joined');
  await joinP;

  const A = createChess(); // host = seat 0 = White (moves first)
  const B = createChess(); // guest = seat 1 = Black
  // Each engine applies ONLY the peer's moves (it applied its own locally before relaying).
  host.on('move', (m) => { if (m.seat !== host.seat) applyPayload(A, m.payload); });
  guest.on('move', (m) => { if (m.seat !== guest.seat) applyPayload(B, m.payload); });

  let plies = 0;
  for (; plies < 16 && !A.status().over; plies++) {
    const mover = A.turn() === 'w' ? { c: host, e: A } : { c: guest, e: B };
    const other = mover.c === host ? guest : host;
    const move = mover.e.allLegalMoves()[0];
    if (!move) break;

    mover.e.move(move);                                   // optimistic local apply
    const delivered = moveFrom(other, mover.c.seat);
    mover.c.sendMove({ from: move.from, to: move.to, promotion: move.promotion }, seatOf(mover.e.turn()));
    await delivered;

    assert.equal(A.fen(), B.fen(), `boards diverged at ply ${plies}`);
  }
  assert.ok(plies >= 8, `expected a decent run of moves, got ${plies}`);

  host.close(); guest.close();
});

test('a mid-game joiner replays the log to the identical position', async () => {
  const host = new RelayClient({ url, autoReconnect: false }); await host.connect();
  const created = await host.create({ game: 'chess' });
  const guest = new RelayClient({ url, autoReconnect: false }); await guest.connect();
  const joinP = guest.join(created.code);
  await waitFor(host, 'peer-joined');
  await joinP;

  const A = createChess(), B = createChess();
  host.on('move', (m) => { if (m.seat !== host.seat) applyPayload(A, m.payload); });
  guest.on('move', (m) => { if (m.seat !== guest.seat) applyPayload(B, m.payload); });

  for (let i = 0; i < 5; i++) {
    const mover = A.turn() === 'w' ? { c: host, e: A } : { c: guest, e: B };
    const other = mover.c === host ? guest : host;
    const move = mover.e.allLegalMoves()[0];
    mover.e.move(move);
    const delivered = moveFrom(other, mover.c.seat);
    mover.c.sendMove({ from: move.from, to: move.to, promotion: move.promotion }, seatOf(mover.e.turn()));
    await delivered;
  }

  // A spectator/late player joins: replay joined.log into a fresh engine (view.onlineResync path).
  guest.leave();
  const late = new RelayClient({ url, autoReconnect: false }); await late.connect();
  const joined = await late.join(created.code);
  const C = createChess();
  for (const e of joined.log) if (e.kind === 'move') applyPayload(C, e.payload);
  assert.equal(C.fen(), A.fen(), 'replayed log did not reproduce the live board');

  host.close(); late.close();
});
