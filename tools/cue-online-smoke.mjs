// cue-online-smoke.mjs — proves the 3D cue-sports online model end-to-end WITHOUT a browser.
//   node --test tools/cue-online-smoke.mjs
// Two real game engines (src/game.js takeShot), two real RelayClients, one real relay. Unlike the
// board games (which relay opaque moves and re-simulate), the cue games relay the RESTING TABLE the
// shooter's shot produced; the peer APPLIES it (no re-simulation). This test verifies:
//   • the SHARED rack seed makes both clients rack identically (rack determinism IS required),
//   • each transferred snapshot reproduces the shooter's table + frame on the peer to micron precision,
//   • the turn hand-off threads over the wire (a pot keeps the table; a foul/safety passes it),
//   • a late joiner resyncs from the move-log's last authoritative snapshot.
// If the transfer ever corrupts a position or the frame, serializeTable diverges and the test fails.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { RelayClient } from '../web/net.js';
import { newGame, takeShot } from '../src/game.js';
import { snooker } from '../src/variants/snooker.js';
import { serializeTable, applyTable, shotPayload } from '../web/games/cue-online.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RELAY = join(HERE, '..', 'server', 'relay.js');
const PORT = 8092;
const url = `ws://127.0.0.1:${PORT}`;

const waitFor = (client, event, ms = 4000) => new Promise((resolve, reject) => {
  const to = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
  const off = client.on(event, (d) => { clearTimeout(to); off(); resolve(d); });
});
const moveFrom = (client, seat, ms = 4000) => new Promise((resolve, reject) => {
  const to = setTimeout(() => reject(new Error(`timeout waiting for move from seat ${seat}`)), ms);
  const off = client.on('move', (m) => { if (m.seat === seat) { clearTimeout(to); off(); resolve(m); } });
});

// A deterministic PRNG (identical to the renderer's mulberry32) so both clients rack the same table.
function mulberry32(seed) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const tableJSON = (state) => JSON.stringify(serializeTable(state));

// Pick a plausible shot for whoever is at the table: aim the cue at the centroid of the object balls,
// with a per-shot-index angle wobble so the run varies and actually strikes the pack. Deterministic in
// the shot index so the whole test is reproducible.
function pickShot(state, shotIdx, seed) {
  const cue = state.pieces.find((p) => p.id === 'cue');
  const origin = cue ? cue.pos : snooker.defaultPlacement(state);
  const objs = state.pieces.filter((p) => p.id !== 'cue');
  const cx = objs.reduce((s, p) => s + p.pos.x, 0) / objs.length;
  const cy = objs.reduce((s, p) => s + p.pos.y, 0) / objs.length;
  const wobble = (mulberry32(seed + shotIdx * 2654435761)() - 0.5) * 0.35;
  return { angle: Math.atan2(cy - origin.y, cx - origin.x) + wobble, speed: shotIdx === 0 ? 5.2 : 3.8, spin: { side: 0, vert: 0 }, elevation: 0, cuePlacement: null };
}

// No two balls should interpenetrate after a transferred layout is applied (a clean table to shoot from).
function noOverlaps(state) {
  const r = snooker.ball.radius, ps = state.pieces;
  for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
    if (Math.hypot(ps[i].pos.x - ps[j].pos.x, ps[i].pos.y - ps[j].pos.y) < 2 * r - 1e-4) return false;
  }
  return true;
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

test('two cue-game clients stay in lockstep by transferring the resting table each shot', async () => {
  const host = new RelayClient({ url, autoReconnect: false }); await host.connect();
  const created = await host.create({ game: 'snooker', seats: 2 });
  const guest = new RelayClient({ url, autoReconnect: false }); await guest.connect();
  const joinP = guest.join(created.code);
  await waitFor(host, 'peer-joined');
  const joined = await joinP;

  // Shared seed → both rack the SAME opening (this determinism IS required; the rack isn't transferred).
  assert.equal(created.seed, joined.seed, 'both clients must get the same rack seed');
  const A = newGame(snooker, { rng: mulberry32(created.seed) }); // host = seat 0, breaks
  const B = newGame(snooker, { rng: mulberry32(joined.seed) });  // guest = seat 1
  assert.equal(tableJSON(A), tableJSON(B), 'shared seed did not produce identical racks');

  // Each client applies ONLY the peer's transferred snapshot (it resolved its own shot locally).
  host.on('move', (m) => { if (m.seat !== host.seat) applyTable(A, m.payload); });
  guest.on('move', (m) => { if (m.seat !== guest.seat) applyTable(B, m.payload); });

  const engineOf = (seat) => (seat === host.seat ? { c: host, e: A } : { c: guest, e: B });
  let turn = 0;          // seat 0 (host) breaks
  let shots = 0, handoffs = 0;
  for (; shots < 12 && !A.frame.frameOver; shots++) {
    const { c: shooter, e: game } = engineOf(turn);
    const other = shooter === host ? guest : host;

    const shot = pickShot(game, shots, created.seed);
    takeShot(game, shot);                                // shooter resolves locally → authoritative
    const next = game.frame.turn;                        // pot ⇒ same seat keeps the table
    if (next !== turn) handoffs++;

    const delivered = moveFrom(other, shooter.seat);
    shooter.sendMove(shotPayload(shot, game), next);     // relay the shot token + the resting table
    await delivered;

    assert.equal(tableJSON(A), tableJSON(B), `tables diverged after shot ${shots}`);
    assert.ok(noOverlaps(turn === host.seat ? B : A), `overlap in the applied layout after shot ${shots}`);
    turn = next;
  }
  assert.ok(shots >= 6, `expected a decent run of shots, got ${shots}`);
  assert.ok(handoffs >= 1, 'the turn never changed hands — hand-off not exercised');

  host.close(); guest.close();
});

test('a late joiner resyncs from the last authoritative snapshot in the log', async () => {
  const host = new RelayClient({ url, autoReconnect: false }); await host.connect();
  const created = await host.create({ game: 'snooker', seats: 2 });
  const guest = new RelayClient({ url, autoReconnect: false }); await guest.connect();
  const joinP = guest.join(created.code);
  await waitFor(host, 'peer-joined');
  await joinP;

  const A = newGame(snooker, { rng: mulberry32(created.seed) });
  const B = newGame(snooker, { rng: mulberry32(created.seed) });
  host.on('move', (m) => { if (m.seat !== host.seat) applyTable(A, m.payload); });
  guest.on('move', (m) => { if (m.seat !== guest.seat) applyTable(B, m.payload); });

  let turn = 0;
  for (let i = 0; i < 4; i++) {
    const shooter = turn === host.seat ? host : guest;
    const game = turn === host.seat ? A : B;
    const other = shooter === host ? guest : host;
    takeShot(game, pickShot(game, i, created.seed));
    const next = game.frame.turn;
    const delivered = moveFrom(other, shooter.seat);
    shooter.sendMove(shotPayload({}, game), next);
    await delivered;
    turn = next;
  }

  // A reconnecting/late client replays the log: the LAST move payload holds the full authoritative
  // table, so resync = apply it (exactly what render3d.js does on 'resumed').
  const live = turn === host.seat ? A : B;
  guest.leave(); // free a seat so a fresh client can take it and replay the log
  const late = new RelayClient({ url, autoReconnect: false }); await late.connect();
  const rejoined = await late.join(created.code);
  const C = newGame(snooker, { rng: mulberry32(created.seed) });
  const moves = rejoined.log.filter((e) => e.kind === 'move');
  if (moves.length) applyTable(C, moves[moves.length - 1].payload);
  assert.equal(tableJSON(C), tableJSON(live), 'resync from the log did not reproduce the live table');

  host.close(); guest.close(); late.close();
});
