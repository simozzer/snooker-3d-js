// backgammon-online-smoke.mjs — proves the backgammon online contract end-to-end WITHOUT a browser,
// and is the first live exercise of the relay's authoritative `random` (dice) path.
//   node --test tools/backgammon-online-smoke.mjs
// Two real backgammon engines, two real RelayClients, one real relay. Each turn: the turn-holder asks
// the relay for ONE authoritative uint32; BOTH clients derive the same dice via the view's own
// diceFromU32 and roll identically. The mover then relays each checker move {from,to} (or a {pass}
// when a roll has no legal play); the peer replays it. If the deterministic engines ever disagree,
// serialize() diverges and the test fails. A late joiner replays the interleaved roll+move log to the
// identical position — the exact resync web/games/backgammon-view.js performs.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { RelayClient } from '../web/net.js';
import { createBackgammon } from '../src/board/backgammon.js';
import { diceFromU32 } from '../web/games/backgammon-view.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RELAY = join(HERE, '..', 'server', 'relay.js');
const PORT = 8095;
const url = `ws://127.0.0.1:${PORT}`;

const waitFor = (client, event, ms = 3000) => new Promise((resolve, reject) => {
  const to = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
  const off = client.on(event, (d) => { clearTimeout(to); off(); resolve(d); });
});
// Resolve when a message of `event` FROM a specific seat arrives (a client hears its own echoes too).
const fromSeat = (client, event, seat, ms = 3000) => new Promise((resolve, reject) => {
  const to = setTimeout(() => reject(new Error(`timeout waiting for ${event} from seat ${seat}`)), ms);
  const off = client.on(event, (m) => { if (m.seat === seat) { clearTimeout(to); off(); resolve(m); } });
});
const otherOf = (client) => (client.seat === 0 ? 1 : 0);

// Apply a peer entry to a mirror engine exactly as backgammon-view.js does on receipt.
function applyPeerMove(E, p) {
  if (p.pass) { E.endTurn(); return; }
  E.move({ from: p.from, to: p.to });
  if (E.state().movesLeft.length === 0 || !E.canMove()) E.endTurn();
}

let server;
before(async () => {
  server = spawn(process.execPath, [RELAY, String(PORT)], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('relay did not start')), 5000);
    server.stdout.on('data', (d) => { if (String(d).includes('listening')) { clearTimeout(to); resolve(); } });
  });
});
after(() => server?.kill('SIGTERM'));

// Drive one full turn for whichever side is on move; returns nothing (mutates engines + relay state).
async function playTurn(host, guest, A, B) {
  const mover = A.turn() === 'w' ? { c: host, e: A } : { c: guest, e: B };
  const other = mover.c === host ? guest : host;

  // Roll: request one authoritative value; both clients receive it (the peer's handler rolls B/A).
  const myRoll = fromSeat(mover.c, 'random', mover.c.seat);
  const peerRoll = fromSeat(other, 'random', mover.c.seat);
  mover.c.requestRandom();
  const rollMsg = await myRoll;
  await peerRoll; // ensure the peer engine has rolled before we relay any move
  const [d1, d2] = diceFromU32(rollMsg.value);
  const r = mover.e.roll(d1, d2);

  if (!r.canMove) {
    const delivered = fromSeat(other, 'move', mover.c.seat);
    mover.c.sendMove({ pass: true }, otherOf(mover.c));
    mover.e.endTurn();
    await delivered;
    return;
  }
  for (;;) {
    const mv = mover.e.allLegalMoves()[0];
    mover.e.move(mv);
    const complete = mover.e.state().movesLeft.length === 0 || !mover.e.canMove();
    const delivered = fromSeat(other, 'move', mover.c.seat);
    mover.c.sendMove({ from: mv.from, to: mv.to }, complete ? otherOf(mover.c) : mover.c.seat);
    await delivered;
    if (complete) { mover.e.endTurn(); break; }
  }
}

test('two engines stay in lockstep across rolls, moves, hits and passes', async () => {
  const host = new RelayClient({ url, autoReconnect: false }); await host.connect();
  const created = await host.create({ game: 'backgammon' });
  const guest = new RelayClient({ url, autoReconnect: false }); await guest.connect();
  const joinP = guest.join(created.code);
  await waitFor(host, 'peer-joined');
  await joinP;

  const A = createBackgammon(); // host = seat 0 = White (rolls first)
  const B = createBackgammon(); // guest = seat 1 = Black
  // Peers roll on the OTHER side's random and apply the OTHER side's moves (each drives its own locally).
  host.on('random', (m) => { if (m.seat !== host.seat) { const [d1, d2] = diceFromU32(m.value); A.roll(d1, d2); } });
  guest.on('random', (m) => { if (m.seat !== guest.seat) { const [d1, d2] = diceFromU32(m.value); B.roll(d1, d2); } });
  host.on('move', (m) => { if (m.seat !== host.seat) applyPeerMove(A, m.payload); });
  guest.on('move', (m) => { if (m.seat !== guest.seat) applyPeerMove(B, m.payload); });

  let turns = 0;
  for (; turns < 24 && !A.status().over; turns++) {
    await playTurn(host, guest, A, B);
    assert.equal(A.serialize(), B.serialize(), `boards diverged after turn ${turns}`);
  }
  assert.ok(turns >= 12, `expected a decent run of turns, got ${turns}`);

  host.close(); guest.close();
});

test('a mid-game joiner replays the roll+move log to the identical position', async () => {
  const host = new RelayClient({ url, autoReconnect: false }); await host.connect();
  const created = await host.create({ game: 'backgammon' });
  const guest = new RelayClient({ url, autoReconnect: false }); await guest.connect();
  const joinP = guest.join(created.code);
  await waitFor(host, 'peer-joined');
  await joinP;

  const A = createBackgammon(), B = createBackgammon();
  host.on('random', (m) => { if (m.seat !== host.seat) { const [d1, d2] = diceFromU32(m.value); A.roll(d1, d2); } });
  guest.on('random', (m) => { if (m.seat !== guest.seat) { const [d1, d2] = diceFromU32(m.value); B.roll(d1, d2); } });
  host.on('move', (m) => { if (m.seat !== host.seat) applyPeerMove(A, m.payload); });
  guest.on('move', (m) => { if (m.seat !== guest.seat) applyPeerMove(B, m.payload); });

  for (let i = 0; i < 6 && !A.status().over; i++) await playTurn(host, guest, A, B);

  // A late player joins: replay joined.log into a fresh engine exactly like view.onlineResync.
  guest.leave();
  const late = new RelayClient({ url, autoReconnect: false }); await late.connect();
  const joined = await late.join(created.code);
  const C = createBackgammon();
  for (const e of joined.log) {
    if (e.kind === 'random') { const [d1, d2] = diceFromU32(e.value); C.roll(d1, d2); }
    else if (e.kind === 'move' && e.payload) applyPeerMove(C, e.payload);
  }
  assert.equal(C.serialize(), A.serialize(), 'replayed log did not reproduce the live board');

  host.close(); late.close();
});
