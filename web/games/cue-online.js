// cue-online.js — online multiplayer for the 3D cue-sports games (snooker / pool / 9-ball / carrom).
//
// These games are turn-based: the balls are STATIC between turns, so every turn boundary is a clean,
// discrete snapshot. We exploit that instead of streaming physics: the shooter simulates their own
// shot LOCALLY (authoritative), then hands the resulting RESTING table + frame state to the opponent.
// The opponent re-plays the shot token just for the animation, then SNAPS to the transferred truth —
// so cross-client float determinism is never required (only the shooter simulates any given shot).
//
// This split keeps the netcode tiny and testable:
//   • serializeTable/applyTable — pure state (de)serialisation, unit-tested in Node with no browser.
//   • createCueOnline           — a thin controller over the shared RelayClient (server/relay.js):
//       create/join a room, learn our seat + the SHARED rack seed, relay each shot, tally the result.
// The relay itself is game-agnostic (opaque move payloads + a shared per-room seed), the same transport
// the board games use — see web/net.js and web/board.js.

import { RelayClient } from '../net.js';

// Micron precision: positions are SI metres, so 6 dp (1e-6 m = 1 micron) makes the received layout
// clean to shoot from next — no ball overlaps or re-spot glitches — while keeping the payload small.
const q6 = (n) => Math.round(n * 1e6) / 1e6;

// Snapshot the authoritative resting table + frame after a shot. Spreading each piece preserves every
// field (id, kind, color, group, label, …) regardless of variant; only the position is rounded. The
// frame is plain rules data (turn, scores, ballInHand, frameOver, winner, …) and JSON round-trips.
export function serializeTable(state) {
  return {
    pieces: state.pieces.map((p) => ({ ...p, pos: { x: q6(p.pos.x), y: q6(p.pos.y) } })),
    frame: state.frame,
  };
}

// Overwrite a game state with a received snapshot (deep, so the two clients never share references).
// This is the authoritative correction: after animating the relayed shot, the opponent lands here.
export function applyTable(state, snap) {
  state.pieces = snap.pieces.map((p) => ({ ...p, pos: { x: p.pos.x, y: p.pos.y } }));
  state.frame = structuredClone(snap.frame);
  return state;
}

// The wire payload for one shot: the shot token (so the opponent can ANIMATE it) plus the authoritative
// resting table + frame it produced (so they SNAP to it, covering any local float drift).
export function shotPayload(shot, state) {
  const s = shot || {};
  return {
    shot: { angle: s.angle, speed: s.speed, spin: { side: s.spin?.side ?? 0, vert: s.spin?.vert ?? 0 }, elevation: s.elevation ?? 0, cuePlacement: s.cuePlacement ?? null },
    ...serializeTable(state),
  };
}

// The controller. Transport + identity only (seat, shared seed, room code); the renderer owns all
// turn/rules logic and calls back through these hooks:
//   onReady(seat, seed, log)  — both players seated; start the frame from the shared seed (or, on a
//                               reconnect, sync to the last logged shot — see `log`).
//   onRemoteShot(payload, turn) — the opponent shot; animate payload.shot then snap to payload's table.
//   onStatus(text) / onError(msg) / onPeerLeft() / onPeerBack() / onRematch(seed) — lobby chrome.
export function createCueOnline({ onReady, onRemoteShot, onStatus, onError, onPeerLeft, onPeerBack, onRematch, url } = {}) {
  const relay = new RelayClient(url ? { url } : {});
  let seat = -1;
  let seed = 0;
  let code = null;
  let gameId = null;   // the room's game type (snooker/pool/…) so a joiner adopts the host's variant
  let started = false;

  const start = (log) => { if (!started) { started = true; onReady?.(seat, seed, log || [], gameId); } };

  relay.on('created', (m) => { seat = m.seat; seed = m.seed >>> 0; code = m.code; gameId = m.game; onStatus?.({ state: 'waiting', code: m.code }); });
  relay.on('joined', (m) => { seat = m.seat; seed = m.seed >>> 0; code = m.code; gameId = m.game; start(m.log); });   // guest: opponent already here
  relay.on('resumed', (m) => { seat = m.seat; seed = m.seed >>> 0; code = m.code; gameId = m.game; start(m.log); });  // reconnect: replay to current
  relay.on('peer-joined', () => start());                     // host: the guest just arrived → begin
  relay.on('peer-reconnected', () => onPeerBack?.());
  relay.on('peer-left', () => onPeerLeft?.());
  relay.on('move', (m) => { if (m.seat !== seat) onRemoteShot?.(m.payload, m.turn); }); // ignore our own echo
  relay.on('rematch', (m) => { seed = m.seed >>> 0; started = true; onRematch?.(seed); });
  relay.on('room-closed', () => onError?.('room-closed'));
  relay.on('error', (m) => onError?.(m.error));
  relay.on('neterror', () => onStatus?.({ state: 'offline' }));

  return {
    connect: () => relay.connect(),
    authenticate: (token) => relay.authenticate(token),
    create: (game) => relay.create({ game, seats: 2 }),
    join: (c) => relay.join(String(c || '').trim().toUpperCase()),
    // Relay one resolved shot. `next` is the seat whose turn it now is (same seat if the shooter keeps
    // the table after a pot — the relay lets the turn-holder keep moving, like backgammon's multi-move).
    sendShot: (payload, next) => relay.sendMove(payload, next),
    reportGameOver: (winnerSeat) => relay.sendGameOver(winnerSeat),
    rematch: () => relay.rematch(),
    leave: () => { relay.leave(); started = false; },
    close: () => relay.close(),
    seat: () => seat,
    seed: () => seed,
    code: () => code,
    started: () => started,
  };
}
