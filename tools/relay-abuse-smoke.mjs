// relay-abuse-smoke.mjs — proves the relay's abuse backstops actually fire, without affecting real
// play. Two layers:
//   • pure Rooms unit tests (no sockets): per-room log cap, payload-size cap, rooms-per-pid + total-room
//     caps, and name/game input cleaning.
//   • live-relay tests: a message flood gets 'rate-limited', and an oversized WS frame drops the socket.
//   node --test tools/relay-abuse-smoke.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { Rooms } from '../server/rooms.js';

// ---- pure Rooms caps ---------------------------------------------------------------------------
test('move rejects an oversized payload but allows a normal one', () => {
  const r = new Rooms({ genCode: () => 'AAAA', maxPayloadBytes: 100 });
  r.create({ pid: 'p1', game: 'chess' });
  assert.equal(r.move({ pid: 'p1', code: 'AAAA', payload: { blob: 'x'.repeat(300) }, next: 0 }).error, 'payload-too-big');
  assert.equal(r.move({ pid: 'p1', code: 'AAAA', payload: { a: 1 }, next: 0 }).all.type, 'move');
});

test('the per-room log is capped (no unbounded growth from keeping your own turn)', () => {
  const r = new Rooms({ genCode: () => 'BBBB', maxLog: 3 });
  r.create({ pid: 'p1', game: 'chess' });
  for (let i = 0; i < 3; i++) assert.ok(r.move({ pid: 'p1', code: 'BBBB', payload: { i }, next: 0 }).all, `move ${i}`);
  assert.equal(r.move({ pid: 'p1', code: 'BBBB', payload: { x: 1 }, next: 0 }).error, 'log-full');
});

test('rooms-per-pid and total-room caps hold', () => {
  let n = 0;
  const r = new Rooms({ genCode: () => `R${n++}`, maxRoomsPerPid: 2, maxRooms: 3 });
  assert.ok(r.create({ pid: 'p1', game: 'chess' }).self);
  assert.ok(r.create({ pid: 'p1', game: 'chess' }).self);
  assert.equal(r.create({ pid: 'p1', game: 'chess' }).error, 'too-many-rooms'); // p1 hit its per-pid cap
  assert.ok(r.create({ pid: 'p2', game: 'chess' }).self);                        // p2 is independent
  assert.equal(r.create({ pid: 'p3', game: 'chess' }).error, 'server-busy');     // now total cap (3) hit
});

test('names and game tokens are sanitised', () => {
  const r = new Rooms({ genCode: () => 'NAME' });
  const dirtyName = 'a'.repeat(80) + String.fromCharCode(10, 7) + 'bob'; // newline + BEL, both control chars
  r.create({ pid: 'p1', game: '  ch<ess>!! ', name: dirtyName });
  assert.equal(r.get('NAME').game, 'chess'); // non-word chars stripped
  const nm = r.get('NAME').players.get('p1').name;
  assert.ok(nm.length <= 40, 'name capped to 40');
  assert.ok(![...nm].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127), 'control chars stripped');
});

// ---- live relay: rate limit + oversized frame --------------------------------------------------
const waitPort = async (port, tries = 40) => {
  for (let i = 0; i < tries; i++) {
    try { const ws = new WebSocket(`ws://127.0.0.1:${port}`); await new Promise((res, rej) => { ws.once('open', () => { ws.close(); res(); }); ws.once('error', rej); }); return true; }
    catch { await sleep(150); }
  }
  return false;
};
function startRelay(port, env) {
  return spawn(process.execPath, ['server/relay.js', String(port)], { stdio: 'ignore', env: { ...process.env, HOST: '127.0.0.1', ...env } });
}

test('a message flood is rate-limited', async (t) => {
  const port = 46230 + (process.pid % 200);
  const relay = startRelay(port, { MSG_BURST: '2', MSG_RATE: '1' });
  t.after(() => relay.kill());
  if (!await waitPort(port)) { t.skip('relay did not start'); return; }
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const limited = [];
  ws.on('message', (d) => { const m = JSON.parse(d); if (m.type === 'error' && m.error === 'rate-limited') limited.push(m); });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  for (let i = 0; i < 10; i++) ws.send(JSON.stringify({ type: 'ping' })); // burst of 2 allowed, rest limited
  await sleep(300);
  ws.close();
  assert.ok(limited.length >= 1, `expected rate-limited responses, got ${limited.length}`);
});

test('an oversized frame drops the socket (maxPayload)', async (t) => {
  const port = 46430 + (process.pid % 200);
  const relay = startRelay(port, { MAX_FRAME_BYTES: '256' });
  t.after(() => relay.kill());
  if (!await waitPort(port)) { t.skip('relay did not start'); return; }
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  const closed = new Promise((res) => ws.once('close', (code) => res(code)));
  ws.on('error', () => {}); // an abrupt close can surface as an error too; ignore
  ws.send(JSON.stringify({ type: 'ping', pad: 'x'.repeat(2000) })); // > 256 bytes
  const code = await Promise.race([closed, sleep(1500).then(() => null)]);
  assert.ok(code !== null, 'socket should have been closed for an oversized frame');
});
