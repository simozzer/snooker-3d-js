// share.js — a compact, URL-safe codec for a whole frame: the game variant + the rack seed + the shots
// played. Because the engine is deterministic, (variant, seed, shots) reproduces the exact frame
// bit-for-bit on any machine — so a frame, a trick shot, or a claimed break rides in a short link, and a
// verifier can RE-SIMULATE it to confirm the outcome (cheat-proof leaderboards) without trusting the
// sender. This is the foundation both async "beat this" challenges and verified scores build on.
//
// Layout (little-endian): [ver:u8][variantId:u8][seed:u32][shotCount:u16] then per shot
//   [flags:u8 (bit0=hasCuePlacement)][angle:u16][speed:u16][side:i16][vert:i16][elev:u16]
//   (+ if placement) [x:i16][y:i16]
// Fields are quantised (angle→2π, speed→MAX_SPEED, spin→±1, elev→π/2, pos→±POS_MAX m), then the byte
// buffer is base64url-encoded. So the CANONICAL frame is the replay of the DECODED shots — encode then
// decode once, and every machine that decodes the token replays identical physics.

import { newGame, takeShot } from './game.js';
import { snooker } from './variants/snooker.js';
import { pool } from './variants/pool.js';
import { nineball } from './variants/nineball.js';
import { MAX_SPEED } from './snooker.js';

export const SHARE_VERSION = 1;
const VARIANTS = [snooker, pool, nineball]; // index = variantId (stable — append only)
export const variantId = (v) => Math.max(0, VARIANTS.indexOf(v));
export const variantById = (id) => VARIANTS[id] ?? snooker;

const ELEV_MAX = Math.PI / 2; // 90° cap for the elevation quantiser (human cue-lift maxes at 60°)
const POS_MAX = 2.0; // metres: half-extent bound for cue-placement quantisation (snooker HX ≈ 1.78)
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// Standard mulberry32 — MUST match the renderer's rack RNG so a shared seed reproduces the same rack.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// --- base64url over bytes (no padding; works in Node and the browser without Buffer/btoa) -----
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64REV = (() => { const m = {}; for (let i = 0; i < B64.length; i++) m[B64[i]] = i; return m; })();
function bytesToB64url(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i], b1 = i + 1 < bytes.length ? bytes[i + 1] : 0, b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64[b0 >> 2] + B64[((b0 & 3) << 4) | (b1 >> 4)];
    if (i + 1 < bytes.length) out += B64[((b1 & 15) << 2) | (b2 >> 6)];
    if (i + 2 < bytes.length) out += B64[b2 & 63];
  }
  return out;
}
function b64urlToBytes(str) {
  const out = [];
  for (let i = 0; i < str.length; i += 4) {
    const c0 = B64REV[str[i]], c1 = B64REV[str[i + 1]], c2 = B64REV[str[i + 2]], c3 = B64REV[str[i + 3]];
    out.push((c0 << 2) | (c1 >> 4));
    if (str[i + 2] !== undefined) out.push(((c1 & 15) << 4) | (c2 >> 2));
    if (str[i + 3] !== undefined) out.push(((c2 & 3) << 6) | c3);
  }
  return new Uint8Array(out);
}

// --- encode / decode -------------------------------------------------------------------------

export function encodeFrame({ variantId = 0, seed = 0, shots = [] }) {
  let size = 8;
  for (const s of shots) size += 11 + (s.cuePlacement ? 4 : 0);
  const dv = new DataView(new ArrayBuffer(size));
  let o = 0;
  dv.setUint8(o++, SHARE_VERSION);
  dv.setUint8(o++, variantId & 255);
  dv.setUint32(o, seed >>> 0, true); o += 4;
  dv.setUint16(o, shots.length, true); o += 2;
  for (const s of shots) {
    const hp = s.cuePlacement ? 1 : 0;
    dv.setUint8(o++, hp);
    const ang = ((s.angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    dv.setUint16(o, Math.round((ang / (2 * Math.PI)) * 65535), true); o += 2;
    dv.setUint16(o, Math.round((clamp(s.speed, 0, MAX_SPEED) / MAX_SPEED) * 65535), true); o += 2;
    dv.setInt16(o, Math.round(clamp(s.spin?.side ?? 0, -1, 1) * 32767), true); o += 2;
    dv.setInt16(o, Math.round(clamp(s.spin?.vert ?? 0, -1, 1) * 32767), true); o += 2;
    dv.setUint16(o, Math.round((clamp(s.elevation ?? 0, 0, ELEV_MAX) / ELEV_MAX) * 65535), true); o += 2;
    if (hp) {
      dv.setInt16(o, Math.round((clamp(s.cuePlacement.x, -POS_MAX, POS_MAX) / POS_MAX) * 32767), true); o += 2;
      dv.setInt16(o, Math.round((clamp(s.cuePlacement.y, -POS_MAX, POS_MAX) / POS_MAX) * 32767), true); o += 2;
    }
  }
  return bytesToB64url(new Uint8Array(dv.buffer));
}

export function decodeFrame(token) {
  const bytes = b64urlToBytes(token);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  const version = dv.getUint8(o++);
  if (version !== SHARE_VERSION) throw new Error(`unsupported share version ${version}`);
  const vId = dv.getUint8(o++);
  const seed = dv.getUint32(o, true); o += 4;
  const n = dv.getUint16(o, true); o += 2;
  const shots = [];
  for (let i = 0; i < n; i++) {
    const hp = dv.getUint8(o++);
    const angle = (dv.getUint16(o, true) / 65535) * 2 * Math.PI; o += 2;
    const speed = (dv.getUint16(o, true) / 65535) * MAX_SPEED; o += 2;
    const side = dv.getInt16(o, true) / 32767; o += 2;
    const vert = dv.getInt16(o, true) / 32767; o += 2;
    const elevation = (dv.getUint16(o, true) / 65535) * ELEV_MAX; o += 2;
    let cuePlacement = null;
    if (hp) {
      const x = (dv.getInt16(o, true) / 32767) * POS_MAX; o += 2;
      const y = (dv.getInt16(o, true) / 32767) * POS_MAX; o += 2;
      cuePlacement = { x, y };
    }
    shots.push({ angle, speed, spin: { side, vert }, elevation, cuePlacement });
  }
  return { variantId: vId, seed, shots };
}

// --- deterministic replay --------------------------------------------------------------------
// Reconstruct the frame from (variantId, seed, shots): rack with the seeded RNG, then apply every shot.
// Returns the reconstructed game plus per-shot { shot, timeline, outcome } so a caller can watch it play
// out or read the final scores. Pure and deterministic → identical on any machine that decodes the token.
export function replayFrame({ variantId: vId = 0, seed = 0, shots = [] }) {
  const variant = variantById(vId);
  const game = newGame(variant, { rng: mulberry32(seed) });
  const usesPoints = Array.isArray(game.frame.scores);
  const steps = [];
  for (const shot of shots) {
    const shooter = game.frame.turn;
    const scoresBefore = usesPoints ? [...game.frame.scores] : null;
    const before = new Set(game.pieces.filter((p) => p.id !== 'cue').map((p) => p.id));
    const res = takeShot(game, shot);
    let pots = 0;
    for (const id of before) if (!game.pieces.some((p) => p.id === id)) pots += 1; // object balls removed this shot
    const gain = usesPoints ? game.frame.scores[shooter] - scoresBefore[shooter] : pots;
    steps.push({ shot, timeline: res.timeline, outcome: res.outcome, shooter, gain, pots, continues: !!res.outcome.continues });
    if (game.frame.frameOver) break;
  }
  return { variant, game, steps, usesPoints };
}

// Rank-worthy summary of a replayed frame: winner, final scores, and highest break (a player's best run
// in one unbroken visit — points in snooker/billiards, balls potted otherwise). Pure — derived only from
// the deterministic replay, so a leaderboard server can re-run this to VERIFY a claimed score.
export function summarize(replay) {
  const { variant, game, steps, usesPoints } = replay;
  let brk = 0, owner = null, high = 0, highBy = null;
  for (const s of steps) {
    if (owner !== s.shooter) { brk = 0; owner = s.shooter; } // a new player at the table → break resets
    if (s.gain > 0) { brk += s.gain; if (brk > high) { high = brk; highBy = s.shooter; } }
  }
  return {
    variant: variant.id,
    variantId: variantId(variant),
    frameOver: game.frame.frameOver,
    winner: typeof game.frame.winner === 'number' ? game.frame.winner : (game.frame.winner ?? null),
    scores: usesPoints ? [...game.frame.scores] : null,
    highBreak: high,
    highBreakBy: highBy,
    shots: steps.length,
    unit: usesPoints ? 'points' : 'balls',
  };
}

// Decode + replay + summarise a token — the exact operation a verifying server runs. Throws on a bad
// token; returns { valid:true, seed, ...summary } otherwise.
export function verifyFrame(token) {
  const decoded = decodeFrame(token);
  const replay = replayFrame(decoded);
  return { valid: true, seed: decoded.seed, ...summarize(replay) };
}

// Convenience: a token straight from an in-progress frame's (variant, seed, executed shots).
export function encodeFromFrame(variant, seed, shots) {
  return encodeFrame({ variantId: variantId(variant), seed, shots });
}
