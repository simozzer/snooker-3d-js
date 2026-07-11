// net-smoke.mjs — integration test for the browser client web/net.js against the REAL relay.
//   node --test tools/net-smoke.mjs
// Node ≥21 exposes a global WebSocket, so the exact same client the browser runs can be driven here.
// Covers the two-client happy path (create → join → move relayed to the peer) and mid-game join
// resync (a late joiner receives the full move-log).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { RelayClient } from '../web/net.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RELAY = join(HERE, '..', 'server', 'relay.js');
const PORT = 8098;
const url = `ws://127.0.0.1:${PORT}`;

// Resolve when a client emits `event`, or reject after a timeout so a hang fails loudly.
const waitFor = (client, event, ms = 3000) => new Promise((resolve, reject) => {
  const to = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
  const off = client.on(event, (d) => { clearTimeout(to); off(); resolve(d); });
});

let server;
before(async () => {
  server = spawn(process.execPath, [RELAY, String(PORT)], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('relay did not start')), 5000);
    server.stdout.on('data', (d) => { if (String(d).includes('listening')) { clearTimeout(to); resolve(); } });
  });
});
after(() => server?.kill('SIGTERM'));

test('host creates, guest joins, and a move reaches the peer', async () => {
  const host = new RelayClient({ url, autoReconnect: false });
  await host.connect();
  const created = await host.create({ game: 'draughts' });
  assert.equal(created.seat, 0);

  const guest = new RelayClient({ url, autoReconnect: false });
  await guest.connect();
  const joinedP = guest.join(created.code);
  const peerJoined = await waitFor(host, 'peer-joined');
  const joined = await joinedP;
  assert.equal(joined.seat, 1);
  assert.equal(peerJoined.seat, 1);

  // Host moves; the GUEST must receive it (and the host sees its own echo).
  const guestGetsMove = waitFor(guest, 'move');
  host.sendMove({ from: { row: 5, col: 0 }, path: [{ row: 4, col: 1 }] });
  const relayed = await guestGetsMove;
  assert.deepEqual(relayed.payload.path, [{ row: 4, col: 1 }]);
  assert.equal(relayed.seat, 0);
  assert.equal(relayed.turn, 1);

  host.close(); guest.close();
});

test('a late joiner receives the full move-log to resync', async () => {
  const host = new RelayClient({ url, autoReconnect: false });
  await host.connect();
  const created = await host.create({ game: 'draughts' });

  // A guest joins, one move happens, guest leaves — the log now has one entry.
  const g1 = new RelayClient({ url, autoReconnect: false });
  await g1.connect();
  await g1.join(created.code);
  await waitFor(host, 'peer-joined');
  const g1move = waitFor(g1, 'move');
  host.sendMove({ from: { row: 5, col: 2 }, path: [{ row: 4, col: 3 }] });
  await g1move;
  g1.leave();
  g1.close();

  // A fresh guest joins mid-game and must get the move-log so it can replay to the live position.
  const g2 = new RelayClient({ url, autoReconnect: false });
  await g2.connect();
  const joined = await g2.join(created.code);
  assert.equal(joined.log.length, 1);
  assert.deepEqual(joined.log[0].payload.path, [{ row: 4, col: 3 }]);

  host.close(); g2.close();
});
