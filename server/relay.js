// relay.js — the WebSocket transport for the multiplayer relay.
//   node server/relay.js [port]      (default 8090; or set PORT)
//
// This is deliberately thin: it owns sockets and JSON framing, and delegates every decision about
// rooms, turns and the move-log to the pure `Rooms` engine (rooms.js). Each client message is a JSON
// object `{ type, ... }`; the server replies/broadcasts JSON objects the client's netcode applies.
// The engine returns { error } | { self, peers, all }; we resolve those to the right sockets here.
//
// `ws` is the only runtime dependency in the whole repo, and it lives ONLY in this server process —
// the browser bundle stays zero-build. Install with `npm install` before running.

import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import { Rooms } from './rooms.js';
import { verifierFromEnv } from './auth.js';

const PORT = Number(process.argv[2] ?? process.env.PORT ?? 8090);
const HEARTBEAT_MS = 30_000;   // ping every 30s; a socket that misses a pong is dead
const SWEEP_MS = 60_000;       // reap idle rooms once a minute

// Optional OIDC identity (see auth.js). Disabled unless OIDC_ISSUER is set, so dev/tests are anonymous.
// REQUIRE_AUTH makes a verified token mandatory to create/join a room.
const verifier = verifierFromEnv();
const REQUIRE_AUTH = process.env.REQUIRE_AUTH === '1' || process.env.REQUIRE_AUTH === 'true';
if (verifier.enabled) console.log(`auth: verifying tokens from ${process.env.OIDC_ISSUER}${REQUIRE_AUTH ? ' (required)' : ' (optional)'}`);

const rooms = new Rooms();
const sockets = new Map(); // pid → ws

const send = (ws, msg) => { if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); };
const toPid = (pid, msg) => send(sockets.get(pid), msg);
const up = (c) => (typeof c === 'string' ? c.toUpperCase() : c); // room codes are case-insensitive

// Apply an engine result to the wire: `self` → the actor, `peers` → everyone else in the room,
// `all` → everyone including the actor. `error` → just tell the actor.
function dispatch(ws, pid, result) {
  if (!result) return;
  if (result.error) { send(ws, { type: 'error', error: result.error }); return; }
  if (result.self) send(ws, result.self);
  const members = result.code ? rooms.membersOf(result.code) : [];
  if (result.peers) for (const m of members) if (m !== pid) toPid(m, result.peers);
  if (result.all) for (const m of members) toPid(m, result.all);
}

const wss = new WebSocketServer({ port: PORT });

wss.on('connection', (ws) => {
  const pid = randomUUID();
  ws.pid = pid;
  ws.isAlive = true;
  sockets.set(pid, ws);
  ws.on('pong', () => { ws.isAlive = true; });

  ws.identity = null; // set once a valid token is presented via an 'auth' message

  // Tell the client its identity so it can resume with the same pid after a drop. `authRequired`
  // lets the client know it must log in before it can create/join.
  send(ws, { type: 'welcome', pid, authRequired: REQUIRE_AUTH });

  // A verified name (from the token) always wins over a client-supplied one, so identities can't be
  // spoofed. `guard` blocks create/join when auth is required but the socket isn't authenticated.
  const trustedName = (fallback) => ws.identity?.name ?? fallback ?? null;
  const guard = () => { if (REQUIRE_AUTH && !ws.identity) { send(ws, { type: 'error', error: 'auth-required' }); return false; } return true; };

  ws.on('message', async (data) => {
    let m;
    try { m = JSON.parse(data); } catch { return send(ws, { type: 'error', error: 'bad-json' }); }
    if (!m || typeof m.type !== 'string') return send(ws, { type: 'error', error: 'bad-msg' });

    switch (m.type) {
      case 'auth':
        try {
          ws.identity = await verifier.verify(m.token);
          send(ws, { type: 'authed', name: ws.identity?.name ?? null, sub: ws.identity?.sub ?? null });
        } catch {
          ws.identity = null;
          send(ws, { type: 'error', error: 'auth-failed' });
        }
        break;
      case 'create':
        if (!guard()) break;
        dispatch(ws, pid, rooms.create({ pid, game: m.game, seats: m.seats, name: trustedName(m.name) }));
        break;
      case 'join':
        if (!guard()) break;
        dispatch(ws, pid, rooms.join({ pid, code: up(m.code), name: trustedName(m.name) }));
        break;
      case 'resume':
        // A reconnecting client re-registers its old pid on THIS socket, then resumes its seat.
        if (m.pid && m.pid !== pid) { sockets.delete(pid); ws.pid = m.pid; sockets.set(m.pid, ws); }
        dispatch(ws, ws.pid, rooms.resume({ pid: ws.pid, code: up(m.code) }));
        break;
      case 'move':
        dispatch(ws, ws.pid, rooms.move({ pid: ws.pid, code: up(m.code), payload: m.payload, next: m.next }));
        break;
      case 'random':
        dispatch(ws, ws.pid, rooms.random({ pid: ws.pid, code: up(m.code) }));
        break;
      case 'leave':
        dispatch(ws, ws.pid, rooms.leave({ pid: ws.pid, code: up(m.code) }));
        break;
      case 'ping':
        send(ws, { type: 'pong' });
        break;
      default:
        send(ws, { type: 'error', error: 'unknown-type' });
    }
  });

  ws.on('close', () => {
    const gonePid = ws.pid;
    if (sockets.get(gonePid) === ws) sockets.delete(gonePid);
    // Keep the seat (droppable disconnect) and notify survivors so they can show "opponent away".
    for (const r of rooms.disconnect(gonePid)) {
      for (const mm of rooms.membersOf(r.code)) if (mm !== gonePid) toPid(mm, r.peers);
    }
  });

  ws.on('error', () => { /* close will follow; nothing extra to do */ });
});

// Heartbeat: terminate sockets that stopped answering pings.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* terminating anyway */ }
  }
}, HEARTBEAT_MS);

// Reap idle/empty rooms so memory doesn't grow unbounded.
const sweeper = setInterval(() => {
  for (const code of rooms.sweep()) {
    for (const mm of rooms.membersOf(code)) toPid(mm, { type: 'room-closed', code });
  }
}, SWEEP_MS);

wss.on('close', () => { clearInterval(heartbeat); clearInterval(sweeper); });

console.log(`relay listening on ws://0.0.0.0:${PORT}`);

// Clean shutdown for containers (SIGTERM from k8s) and Ctrl+C.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { console.log(`\n${sig} — closing relay`); wss.close(() => process.exit(0)); });
}
