// dice-online-smoke.mjs — proves the DICE online model end-to-end WITHOUT a browser.
//   node --test tools/dice-online-smoke.mjs
// Dice is physics-driven, so (like the 3D cue games) it nets by STATE TRANSFER: the roller is
// authoritative and relays its resulting engine state after every action; the peer load()s it. A roll
// also carries the base seed so the peer replays the identical tumble (cosmetic — the state is the
// truth). This test verifies, over a real relay:
//   • both clients start from an identical fresh game,
//   • each relayed action (roll → selections → bank) reproduces the roller's state on the peer exactly,
//   • banking threads the turn hand-off over the wire (roll/select keep the turn; bank passes it),
//   • a late joiner resyncs from the move-log's last authoritative state.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { RelayClient } from '../web/net.js';
import { createDice } from '../src/board/dice.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RELAY = join(HERE, '..', 'server', 'relay.js');
const PORT = 8091;
const url = `ws://127.0.0.1:${PORT}`;

const waitFor = (client, event, ms = 4000) => new Promise((resolve, reject) => {
  const to = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
  const off = client.on(event, (d) => { clearTimeout(to); off(); resolve(d); });
});
const moveFrom = (client, seat, ms = 4000) => new Promise((resolve, reject) => {
  const to = setTimeout(() => reject(new Error(`timeout waiting for move from seat ${seat}`)), ms);
  const off = client.on('move', (m) => { if (m.seat === seat) { clearTimeout(to); off(); resolve(m); } });
});
const NAMES = ['Host', 'Guest'];
const stateJSON = (e) => JSON.stringify(e.state());

let server;
before(async () => {
  server = spawn(process.execPath, [RELAY, String(PORT)], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('relay did not start')), 5000);
    server.stdout.on('data', (d) => { if (String(d).includes('listening')) { clearTimeout(to); resolve(); } });
  });
});
after(() => server?.kill('SIGTERM'));

test('two dice clients stay in lockstep by transferring the roller state each action', async () => {
  const host = new RelayClient({ url, autoReconnect: false }); await host.connect();
  const created = await host.create({ game: 'dice', seats: 2 });
  const guest = new RelayClient({ url, autoReconnect: false }); await guest.connect();
  const joinP = guest.join(created.code);
  await waitFor(host, 'peer-joined');
  await joinP;

  const A = createDice(); A.newGame(NAMES); // host = seat 0, rolls first
  const B = createDice(); B.newGame(NAMES); // guest = seat 1
  assert.equal(stateJSON(A), stateJSON(B), 'both engines start identical');

  // Each client load()s ONLY the peer's relayed state (it applied its own action locally).
  host.on('move', (m) => { if (m.seat !== host.seat) A.load(m.payload.state); });
  guest.on('move', (m) => { if (m.seat !== guest.seat) B.load(m.payload.state); });

  // Host relays an action; wait until the guest has received (and thus applied) it.
  const relay = async (payload, next) => {
    const delivered = moveFrom(guest, host.seat);
    host.sendMove(payload, next);
    await delivered;
  };

  // Host's turn: roll three 1s + a 5, keep all four scorers, then bank 1050.
  A.roll([1, 1, 1, 5, 2, 3]);
  await relay({ roll: { seed: 0x1234, thrown: [0, 1, 2, 3, 4, 5] }, state: A.state() }, host.seat); // a roll keeps the turn
  assert.equal(stateJSON(A), stateJSON(B), 'lockstep after the roll');
  assert.equal(B.state().phase, 'pick', 'the peer sees the rolled dice awaiting a pick');

  for (const i of [0, 1, 2, 3]) { // the three 1s and the single 5
    A.toggleSelect(i);
    await relay({ state: A.state() }, host.seat); // a selection keeps the turn
  }
  assert.equal(A.selectionScore(), 1050);
  assert.equal(stateJSON(A), stateJSON(B), 'lockstep after the selections');

  const res = A.bank();
  assert.equal(res.banked, true);
  await relay({ state: A.state() }, guest.seat); // banking passes the turn
  assert.equal(stateJSON(A), stateJSON(B), 'lockstep after the bank');
  assert.equal(B.state().current, 1, 'the turn passed to the guest');
  assert.equal(B.state().players[0].score, 1050, 'the guest sees the host’s banked score');

  host.close(); guest.close();
});

test('a late joiner resyncs from the last relayed state', async () => {
  const host = new RelayClient({ url, autoReconnect: false }); await host.connect();
  const created = await host.create({ game: 'dice', seats: 2 });
  const guest = new RelayClient({ url, autoReconnect: false }); await guest.connect();
  const joinP = guest.join(created.code);
  await waitFor(host, 'peer-joined');
  await joinP;

  const A = createDice(); A.newGame(NAMES);
  const B = createDice(); B.newGame(NAMES);
  guest.on('move', (m) => { if (m.seat !== guest.seat) B.load(m.payload.state); });

  const relay = async (payload, next) => {
    const delivered = moveFrom(guest, host.seat);
    host.sendMove(payload, next);
    await delivered;
  };

  // Host banks a hot-dice-worthy hand (1000 + 750), passing the turn to the guest.
  A.roll([1, 1, 1, 5, 5, 5]);
  await relay({ roll: { seed: 7, thrown: [0, 1, 2, 3, 4, 5] }, state: A.state() }, host.seat);
  for (let i = 0; i < 6; i++) A.toggleSelect(i);
  await relay({ state: A.state() }, host.seat);
  A.bank();
  await relay({ state: A.state() }, guest.seat);
  assert.equal(stateJSON(A), stateJSON(B), 'guest kept up before the resync');

  // A late/reconnecting client replays the log: the last move payload holds the full authoritative
  // state, so resync = load it (exactly what dice-view.js does on 'resumed').
  guest.leave(); // free the seat
  const late = new RelayClient({ url, autoReconnect: false }); await late.connect();
  const rejoined = await late.join(created.code);
  const C = createDice(); C.newGame(NAMES);
  const moves = rejoined.log.filter((e) => e.kind === 'move' && e.payload && e.payload.state);
  if (moves.length) C.load(moves[moves.length - 1].payload.state);
  assert.equal(stateJSON(C), stateJSON(A), 'resync from the log did not reproduce the live game');
  assert.equal(C.state().players[0].score, 1750, 'the resynced client sees the banked score');

  host.close(); guest.close(); late.close();
});
