// relay-smoke.mjs — end-to-end integration test for the multiplayer relay.
//   node --test tools/relay-smoke.mjs
// Spawns the REAL server (server/relay.js) on a scratch port and drives two live WebSocket clients
// through a full board-game exchange: create → join → alternating moves → out-of-turn rejection →
// disconnect → resume-with-log. This exercises the ws transport that the pure rooms.test.js can't.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WebSocket } from 'ws';

const HERE = dirname(fileURLToPath(import.meta.url));
const RELAY = join(HERE, '..', 'server', 'relay.js');
const PORT = 8097;
const URL = `ws://127.0.0.1:${PORT}`;

let server;

before(async () => {
  server = spawn(process.execPath, [RELAY, String(PORT)], { stdio: ['ignore', 'pipe', 'inherit'] });
  // Wait for the "listening" banner so we never connect before the socket is up.
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('relay did not start in time')), 5000);
    server.stdout.on('data', (d) => { if (String(d).includes('listening')) { clearTimeout(to); resolve(); } });
    server.on('exit', (c) => reject(new Error(`relay exited early (${c})`)));
  });
});

after(() => { server?.kill('SIGTERM'); });

// --- a tiny promise-based client: connect, send JSON, and await a message of a given type ---------
function client() {
  const ws = new WebSocket(URL);
  const inbox = [];
  const waiters = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    const i = waiters.findIndex((w) => w.type === m.type);
    if (i !== -1) waiters.splice(i, 1)[0].resolve(m); // hand straight to a waiter…
    else inbox.push(m);                               // …otherwise buffer for a later next()
  });
  return {
    ws,
    ready: once(ws, 'open'),
    send: (m) => ws.send(JSON.stringify(m)),
    // Resolve with the next (or already-received) message of `type`.
    next(type) {
      const found = inbox.find((m) => m.type === type);
      if (found) { inbox.splice(inbox.indexOf(found), 1); return Promise.resolve(found); }
      return new Promise((resolve) => waiters.push({ type, resolve }));
    },
    close: () => ws.close(),
  };
}

test('two clients play a full turn-ordered exchange over the wire', async () => {
  const host = client();
  await host.ready;
  const welcome = await host.next('welcome');
  assert.ok(welcome.pid, 'server hands out a pid');

  host.send({ type: 'create', game: 'draughts' });
  const created = await host.next('created');
  assert.equal(created.seat, 0);
  const code = created.code;

  const guest = client();
  await guest.ready;
  await guest.next('welcome');
  guest.send({ type: 'join', code });
  const joined = await guest.next('joined');
  assert.equal(joined.seat, 1);
  assert.equal(joined.game, 'draughts');
  await host.next('peer-joined'); // host is told someone arrived

  // Host (seat 0, whose turn it is) moves; BOTH clients receive the authoritative move.
  host.send({ type: 'move', code, payload: { from: 'c3', to: 'd4' } });
  const hMove = await host.next('move');
  const gMove = await guest.next('move');
  assert.deepEqual(hMove.payload, { from: 'c3', to: 'd4' });
  assert.deepEqual(gMove.payload, { from: 'c3', to: 'd4' });
  assert.equal(hMove.turn, 1, 'turn handed to guest');
  assert.equal(hMove.seq, 1);

  // Guest (now the turn-holder) replies.
  guest.send({ type: 'move', code, payload: { from: 'f6', to: 'e5' } });
  const gMove2 = await guest.next('move');
  assert.equal(gMove2.turn, 0);
  assert.equal(gMove2.seq, 2);

  host.close();
  guest.close();
});

test('a move out of turn is rejected over the wire', async () => {
  const host = client(); await host.ready; await host.next('welcome');
  host.send({ type: 'create', game: 'draughts' });
  const { code } = await host.next('created');

  const guest = client(); await guest.ready; await guest.next('welcome');
  guest.send({ type: 'join', code }); await guest.next('joined');

  // It's seat 0's turn, but the guest (seat 1) tries to move.
  guest.send({ type: 'move', code, payload: {} });
  const err = await guest.next('error');
  assert.equal(err.error, 'not-your-turn');

  host.close(); guest.close();
});

test('a dropped client resumes its seat and replays the log', async () => {
  const host = client(); await host.ready; const hw = await host.next('welcome');
  host.send({ type: 'create', game: 'draughts' });
  const { code } = await host.next('created');

  const guest = client(); await guest.ready; const gw = await guest.next('welcome');
  guest.send({ type: 'join', code }); await guest.next('joined');

  // Host makes a move while the guest is present, then the guest drops.
  host.send({ type: 'move', code, payload: { n: 1 } });
  await guest.next('move');
  guest.close();
  await once(guest.ws, 'close');

  // A fresh socket resumes the guest's identity and must receive the full log.
  const back = client(); await back.ready; await back.next('welcome');
  back.send({ type: 'resume', pid: gw.pid, code });
  const resumed = await back.next('resumed');
  assert.equal(resumed.seat, 1);
  assert.equal(resumed.log.length, 1);
  assert.deepEqual(resumed.log[0].payload, { n: 1 });

  host.close(); back.close();
});
