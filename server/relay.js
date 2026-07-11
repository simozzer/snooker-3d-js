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
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { Rooms } from './rooms.js';
import { verifierFromEnv } from './auth.js';
import { Stats } from './stats.js';

const PORT = Number(process.argv[2] ?? process.env.PORT ?? 8090);
const HEARTBEAT_MS = 30_000;   // ping every 30s; a socket that misses a pong is dead
const SWEEP_MS = 60_000;       // reap idle rooms once a minute
const MIN_MOVES = 2;           // a game must have at least this many moves before it counts in stats

// Per-player stats (games/wins), persisted as JSON. Keyed by OIDC sub, so only logged-in players count.
const DATA_DIR = process.env.DATA_DIR || './data';
const STATS_FILE = join(DATA_DIR, 'stats.json');
const loadStats = () => { try { return JSON.parse(readFileSync(STATS_FILE, 'utf8')); } catch { return {}; } };
const persistStats = (snap) => {
  try { mkdirSync(DATA_DIR, { recursive: true }); const tmp = `${STATS_FILE}.tmp`; writeFileSync(tmp, JSON.stringify(snap)); renameSync(tmp, STATS_FILE); }
  catch (e) { console.error('stats persist failed:', e.message); }
};
const stats = new Stats({ initial: loadStats(), persist: persistStats });

// Optional OIDC identity (see auth.js). Disabled unless OIDC_ISSUER is set, so dev/tests are anonymous.
// REQUIRE_AUTH makes a verified token mandatory to create/join a room.
const verifier = verifierFromEnv();
const REQUIRE_AUTH = process.env.REQUIRE_AUTH === '1' || process.env.REQUIRE_AUTH === 'true';
if (verifier.enabled) console.log(`auth: verifying tokens from ${process.env.OIDC_ISSUER}${REQUIRE_AUTH ? ' (required)' : ' (optional)'}`);

const rooms = new Rooms();
const sockets = new Map(); // pid → ws

// Presence: which authenticated players are online, so a signed-in host can invite a friend BY NAME.
// Keyed by lower-cased display name → the set of that person's live sockets (a name may be open in
// more than one tab). Anonymous sockets are absent. Names aren't globally unique, but for a friend
// group they're distinct enough; an ambiguous name simply rings every match.
const presence = new Map(); // name(lower) → Set<ws>
const addPresence = (ws) => {
  const n = ws.identity?.name?.toLowerCase();
  if (!n) return;
  if (!presence.has(n)) presence.set(n, new Set());
  presence.get(n).add(ws);
};
const dropPresence = (ws) => { for (const [n, set] of presence) { set.delete(ws); if (!set.size) presence.delete(n); } };

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
          if (ws.identity) addPresence(ws); // now reachable by name for invites
          const st = stats.get(ws.identity?.sub); // greet the player with their running totals
          send(ws, { type: 'authed', name: ws.identity?.name ?? null, sub: ws.identity?.sub ?? null, games: st.games, wins: st.wins });
        } catch {
          ws.identity = null;
          send(ws, { type: 'error', error: 'auth-failed' });
        }
        break;
      case 'game-over': {
        // Tally a finished game — but only a REAL one: both seats moved, enough moves, once per room.
        // Anonymous participants simply aren't recorded (no identity). Clients report this; the guards
        // mean gaming the count requires actually playing real games against a real opponent.
        const goCode = up(m.code);
        const sum = rooms.playSummary(goCode);
        if (!sum || sum.counted || sum.movers.length < 2 || sum.moves < MIN_MOVES) break;
        const gameType = rooms.get(goCode)?.game ?? null; // so the result lands in the right score table
        rooms.markCounted(goCode);
        const winner = Number.isInteger(m.winner) ? m.winner : null;
        for (const part of sum.participants) {
          const w = sockets.get(part.pid);
          if (!w?.identity?.sub) continue;
          const rec = stats.recordGame(w.identity.sub, w.identity.name, winner !== null && part.seat === winner, gameType);
          send(w, { type: 'stats', games: rec.games, wins: rec.wins });
        }
        break;
      }
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
      case 'rematch':
        dispatch(ws, ws.pid, rooms.rematch({ pid: ws.pid, code: up(m.code) }));
        break;
      case 'leave':
        dispatch(ws, ws.pid, rooms.leave({ pid: ws.pid, code: up(m.code) }));
        break;
      case 'leaderboard':
        // Public: top players by wins. Just names + counts (no identity), so anyone may read it.
        send(ws, { type: 'leaderboard', top: stats.top(10) });
        break;
      case 'scores':
        // Public: the full Community score board — overall top plus a per-game breakdown.
        send(ws, { type: 'scores', ...stats.board(10) });
        break;
      case 'online': {
        // Public: who's here right now. `count` is every open socket (anyone with a compendium page
        // open); `users` are the signed-in players (deduped by name), with what they're mid-game in.
        const playing = rooms.playingMap();
        const users = [];
        for (const set of presence.values()) {
          let name = null, game = null;
          for (const w of set) { name = w.identity?.name ?? name; game = playing.get(w.pid) ?? game; }
          if (name) users.push({ name, playing: game });
        }
        users.sort((a, b) => a.name.localeCompare(b.name));
        send(ws, { type: 'online', count: wss.clients.size, signedIn: users.length, users });
        break;
      }
      case 'invite': {
        // A signed-in host rings a friend by name to join THEIR room. Requires a verified identity (so
        // the invite carries a real "from"), and that the host actually holds a seat in that room.
        if (!ws.identity) { send(ws, { type: 'error', error: 'auth-required' }); break; }
        const to = String(m.to ?? '').trim().toLowerCase();
        const code = up(m.code);
        const room = rooms.get(code);
        if (!room || !room.players.has(ws.pid)) { send(ws, { type: 'error', error: 'not-in-room' }); break; }
        const targets = [...(presence.get(to) ?? [])].filter((t) => t !== ws && t.readyState === t.OPEN);
        for (const t of targets) send(t, { type: 'invited', from: ws.identity.name, code, game: room.game });
        send(ws, { type: 'invite-sent', to: m.to, delivered: targets.length }); // 0 → not online
        break;
      }
      case 'ping':
        send(ws, { type: 'pong' });
        break;
      default:
        send(ws, { type: 'error', error: 'unknown-type' });
    }
  });

  ws.on('close', () => {
    const gonePid = ws.pid;
    dropPresence(ws);
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

// Clean, PROMPT shutdown (systemd/k8s SIGTERM, Ctrl+C). Terminate live sockets so wss.close resolves
// immediately instead of waiting for idle clients to drop, with a hard-stop fallback.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n${sig} — closing relay`);
    for (const ws of wss.clients) { try { ws.terminate(); } catch { /* already gone */ } }
    wss.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
