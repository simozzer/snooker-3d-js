// rooms.js — the pure, transport-agnostic heart of the multiplayer relay.
//
// This module knows NOTHING about WebSockets and NOTHING about any specific game. It is the
// authoritative record of who is in a room, whose turn it is, and the ordered move-log — the three
// things a client cannot be trusted to arbitrate for itself. Everything game-specific (legal moves,
// board state, physics) stays in the deterministic engines on the clients: each client replays the
// same ordered log and, because the engines are deterministic, arrives at identical state. So the
// server never simulates anything. It relays a tiny append-only log and enforces turn order.
//
// Two design choices keep this fully game-agnostic while still being authoritative:
//   1. RANDOMNESS lives here, not on the clients. A client that needs a dice roll asks for a
//      `random` value; the server generates ONE value, appends it to the log, and broadcasts it to
//      everyone — so both clients consume the identical number. Unpredictable AND reproducible,
//      without the server knowing what a "dice" is.
//   2. TURN HAND-OFF is declared by the mover. Board games have multi-jumps (same player moves
//      again) and multi-part turns, so the server can't blindly alternate. Each move names the seat
//      the turn passes to next; the server only enforces that the CURRENT turn-holder is the one
//      moving. The client's rules decide when a turn ends — the server just trusts the hand-off and
//      rejects anyone moving out of turn.
//
// Every mutating method returns a plain descriptor of what to send — `{ error }` on rejection, or
// some combination of `self` (to the actor), `peers` (everyone else in the room) and `all`
// (everyone including the actor). The transport layer resolves those to sockets. No I/O here.

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 — unambiguous when read aloud
const CODE_LEN = 4;

// Injectable side-effects (constructor opts) so this module stays pure and unit-testable:
//   randomU32() → a uint32 for `random` requests and seeds; genCode() → a fresh room code;
//   now() → a millisecond clock for idle sweeping. Defaults are the real runtime sources.
function defaultRandomU32() {
  // Prefer crypto for unpredictability (matters for dice fairness); fall back if unavailable.
  if (globalThis.crypto?.getRandomValues) {
    const b = new Uint32Array(1);
    globalThis.crypto.getRandomValues(b);
    return b[0] >>> 0;
  }
  return Math.floor(Math.random() * 0x100000000) >>> 0;
}

export class Rooms {
  constructor({ randomU32 = defaultRandomU32, genCode = null, now = () => Date.now(), roomTtlMs = 30 * 60 * 1000 } = {}) {
    this.rooms = new Map(); // code → room
    this._randomU32 = randomU32;
    this._now = now;
    this.roomTtlMs = roomTtlMs;
    this._genCode = genCode ?? (() => {
      let s = '';
      for (let i = 0; i < CODE_LEN; i++) s += CODE_ALPHABET[this._randomU32() % CODE_ALPHABET.length];
      return s;
    });
  }

  // --- lookups -------------------------------------------------------------------------------
  get(code) { return this.rooms.get(code) ?? null; }

  // The pids currently seated in a room (used by the transport to fan out `all`/`peers`).
  membersOf(code) {
    const room = this.rooms.get(code);
    return room ? [...room.players.keys()] : [];
  }

  // Summary the transport uses to validate a completed game before tallying stats: how many moves
  // were made, which distinct seats actually moved, the participants (pid+seat) so the transport can
  // resolve their identities, and whether this room was already counted. Null if the room is gone.
  playSummary(code) {
    const room = this.rooms.get(code);
    if (!room) return null;
    const moves = room.log.filter((e) => e.kind === 'move');
    return {
      moves: moves.length,
      movers: [...new Set(moves.map((e) => e.seat))],
      participants: [...room.players.values()].map((p) => ({ pid: p.pid, seat: p.seat })),
      counted: room.counted,
    };
  }

  // Mark a room's game as tallied so it can't be double-counted (idempotent).
  markCounted(code) { const room = this.rooms.get(code); if (room) room.counted = true; }

  // A serialisable view of the seats — what a joiner/resumer needs to render the lobby.
  _players(room) {
    return [...room.players.values()]
      .sort((a, b) => a.seat - b.seat)
      .map((p) => ({ seat: p.seat, name: p.name, connected: p.connected }));
  }

  _touch(room) { room.lastActivity = this._now(); }

  // --- room lifecycle ------------------------------------------------------------------------

  // Create a room and seat the caller at seat 0. `seats` bounds how many players may join (2 for the
  // board games we start with). The room's `seed` is fixed here so every client racks/shuffles from
  // the same deterministic RNG.
  create({ pid, game, seats = 2, name = null }) {
    if (!pid) return { error: 'no-pid' };
    if (!game) return { error: 'no-game' };
    seats = Math.max(2, Math.min(8, seats | 0));

    // Find a free code (collisions are astronomically unlikely, but loop defensively).
    let code = this._genCode();
    for (let i = 0; this.rooms.has(code) && i < 50; i++) code = this._genCode();
    if (this.rooms.has(code)) return { error: 'no-code' };

    const room = {
      code, game, seats,
      seed: this._randomU32(),
      turn: 0,          // seat 0 (the creator) moves first
      seq: 0,           // monotonic log sequence number
      counted: false,   // has a completed game here already been tallied into stats?
      log: [],          // ordered [{ seq, seat, kind:'move'|'random', payload?/value? }]
      players: new Map([[pid, { pid, seat: 0, name, connected: true }]]),
      createdAt: this._now(),
      lastActivity: this._now(),
    };
    this.rooms.set(code, room);
    return {
      code,
      self: { type: 'created', code, seat: 0, seed: room.seed, game, seats, turn: room.turn },
    };
  }

  // Join (or transparently resume) a room by code. A pid already present is treated as a resume so a
  // dropped client reconnecting with the same identity gets the full log back rather than a new seat.
  join({ pid, code, name = null }) {
    if (!pid) return { error: 'no-pid' };
    const room = this.rooms.get(code);
    if (!room) return { error: 'no-room' };

    const existing = room.players.get(pid);
    if (existing) return this._resumeInto(room, existing);

    // Reuse the lowest free seat; a free seat is one never taken OR vacated by a departed player.
    const taken = new Set([...room.players.values()].map((p) => p.seat));
    let seat = -1;
    for (let s = 0; s < room.seats; s++) if (!taken.has(s)) { seat = s; break; }
    if (seat === -1) return { error: 'full' };

    room.players.set(pid, { pid, seat, name, connected: true });
    this._touch(room);
    return {
      code,
      self: { type: 'joined', code, seat, seed: room.seed, game: room.game, seats: room.seats,
        turn: room.turn, players: this._players(room), log: room.log },
      peers: { type: 'peer-joined', seat, name, players: this._players(room) },
    };
  }

  // Explicit resume by pid (same effect as re-joining with a known pid) — the transport calls this
  // when a client reconnects. Returns 'no-seat' if this pid was never in the room.
  resume({ pid, code }) {
    const room = this.rooms.get(code);
    if (!room) return { error: 'no-room' };
    const me = room.players.get(pid);
    if (!me) return { error: 'no-seat' };
    return this._resumeInto(room, me);
  }

  _resumeInto(room, me) {
    me.connected = true;
    this._touch(room);
    return {
      code: room.code,
      self: { type: 'resumed', code: room.code, seat: me.seat, seed: room.seed, game: room.game,
        seats: room.seats, turn: room.turn, players: this._players(room), log: room.log },
      peers: { type: 'peer-reconnected', seat: me.seat, players: this._players(room) },
    };
  }

  // --- gameplay ------------------------------------------------------------------------------

  // Append an opaque move to the log and hand the turn to `next`. Only the current turn-holder may
  // move. `payload` is whatever the game's client wants to replay (a board move, a shot token, …);
  // the server never inspects it. `next` is the seat whose turn it becomes — same seat for a
  // multi-jump, the other seat for a normal hand-off; defaults to the next seat round-robin.
  move({ pid, code, payload, next }) {
    const room = this.rooms.get(code);
    if (!room) return { error: 'no-room' };
    const me = room.players.get(pid);
    if (!me) return { error: 'not-in-room' };
    if (me.seat !== room.turn) return { error: 'not-your-turn' };

    let nextTurn = next;
    if (nextTurn == null) nextTurn = (me.seat + 1) % room.seats;
    if (!Number.isInteger(nextTurn) || nextTurn < 0 || nextTurn >= room.seats) return { error: 'bad-turn' };

    const entry = { seq: ++room.seq, seat: me.seat, kind: 'move', payload };
    room.log.push(entry);
    room.turn = nextTurn;
    this._touch(room);
    return { code, all: { type: 'move', seq: entry.seq, seat: entry.seat, payload, turn: room.turn } };
  }

  // Generate one authoritative random value, log it, and broadcast it to everyone so both clients
  // consume the identical number (dice, coin flips, …). Only the turn-holder may request it; the
  // turn does NOT change — a roll is part of the current player's turn.
  random({ pid, code }) {
    const room = this.rooms.get(code);
    if (!room) return { error: 'no-room' };
    const me = room.players.get(pid);
    if (!me) return { error: 'not-in-room' };
    if (me.seat !== room.turn) return { error: 'not-your-turn' };

    const value = this._randomU32();
    const entry = { seq: ++room.seq, seat: me.seat, kind: 'random', value };
    room.log.push(entry);
    this._touch(room);
    return { code, all: { type: 'random', seq: entry.seq, seat: entry.seat, value } };
  }

  // Start a fresh game in the SAME room (a rematch): new seed, cleared log, turn back to seat 0, and
  // the tally-guard reset so the next result counts again. Seats/players are untouched. A no-op if the
  // board is already fresh (so two players both clicking Rematch don't reshuffle twice). Any member may
  // call it — a finished 2-player game is a mutual "play again".
  rematch({ pid, code }) {
    const room = this.rooms.get(code);
    if (!room) return { error: 'no-room' };
    if (!room.players.has(pid)) return { error: 'not-in-room' };
    if (room.log.length === 0 && room.turn === 0 && !room.counted) return null; // already fresh
    room.seed = this._randomU32();
    room.turn = 0;
    room.seq = 0;
    room.counted = false;
    room.log = [];
    this._touch(room);
    return { code, all: { type: 'rematch', seed: room.seed, turn: room.turn, game: room.game, seats: room.seats } };
  }

  // --- departures & housekeeping -------------------------------------------------------------

  // Mark a player disconnected but KEEP their seat (so they can resume). Returns the rooms they were
  // in and a `peer-left` notice for the survivors. The transport calls this on socket close.
  disconnect(pid) {
    const out = [];
    for (const room of this.rooms.values()) {
      const me = room.players.get(pid);
      if (!me) continue;
      me.connected = false;
      this._touch(room);
      out.push({ code: room.code, peers: { type: 'peer-left', seat: me.seat, players: this._players(room) } });
    }
    return out;
  }

  // Permanently drop a player from a room (an explicit "leave", vs a droppable disconnect).
  leave({ pid, code }) {
    const room = this.rooms.get(code);
    if (!room) return { error: 'no-room' };
    const me = room.players.get(pid);
    if (!me) return { error: 'not-in-room' };
    room.players.delete(pid);
    this._touch(room);
    if (room.players.size === 0) { this.rooms.delete(code); return { code, closed: true }; }
    return { code, peers: { type: 'peer-left', seat: me.seat, players: this._players(room) } };
  }

  // Reap rooms that have been idle past the TTL (called periodically by the transport). Returns the
  // codes removed so the transport can notify any stragglers. Empty rooms are always removed.
  sweep() {
    const now = this._now();
    const removed = [];
    for (const [code, room] of this.rooms) {
      if (room.players.size === 0 || now - room.lastActivity > this.roomTtlMs) {
        this.rooms.delete(code);
        removed.push(code);
      }
    }
    return removed;
  }
}
