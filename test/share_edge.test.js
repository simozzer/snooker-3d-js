// share_edge.test.js — codec edge cases beyond the happy path: every variant round-trips, an empty
// frame is just the rack, boundary field values survive quantisation, unknown variants fall back safely,
// and a corrupt token is rejected rather than silently mis-decoded.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFrame, decodeFrame, replayFrame, verifyFrame, encodeFromFrame, variantId, variantById, mulberry32, SHARE_VERSION } from '../src/share.js';
import { newGame } from '../src/game.js';
import { snooker } from '../src/variants/snooker.js';
import { pool } from '../src/variants/pool.js';
import { nineball } from '../src/variants/nineball.js';

test('every variant id round-trips through encode/decode', () => {
  for (const v of [snooker, pool, nineball]) {
    const dec = decodeFrame(encodeFrame({ variantId: variantId(v), seed: 3, shots: [] }));
    assert.equal(dec.variantId, variantId(v));
    assert.equal(variantById(dec.variantId), v);
  }
});

test('an empty frame (no shots) encodes, decodes, and replays to just the rack', () => {
  const token = encodeFrame({ variantId: variantId(pool), seed: 77, shots: [] });
  const { game, steps } = replayFrame(decodeFrame(token));
  assert.equal(steps.length, 0);
  const fresh = newGame(pool, { rng: mulberry32(77) });
  assert.equal(game.pieces.length, fresh.pieces.length);
});

test('boundary field values survive quantisation', () => {
  const shots = [
    { angle: 0, speed: 0, spin: { side: -1, vert: 1 }, elevation: 0, cuePlacement: { x: -2, y: 2 } },
    { angle: 6.2, speed: 8, spin: { side: 1, vert: -1 }, elevation: Math.PI / 2, cuePlacement: { x: 2, y: -2 } },
  ];
  const d = decodeFrame(encodeFrame({ variantId: 0, seed: 1, shots }));
  assert.ok(Math.abs(d.shots[0].speed - 0) < 1e-6);
  assert.ok(Math.abs(d.shots[1].speed - 8) < 2e-3, 'MAX_SPEED round-trips');
  assert.ok(Math.abs(d.shots[0].spin.side - -1) < 1e-3 && Math.abs(d.shots[0].spin.vert - 1) < 1e-3);
  assert.ok(Math.abs(d.shots[1].spin.side - 1) < 1e-3 && Math.abs(d.shots[1].spin.vert - -1) < 1e-3);
  assert.ok(Math.abs(d.shots[0].cuePlacement.x - -2) < 2e-4 && Math.abs(d.shots[1].cuePlacement.x - 2) < 2e-4);
});

test('an out-of-range variant id falls back to snooker (never crashes the reader)', () => {
  assert.equal(variantById(200), snooker);
  assert.equal(variantById(-1), snooker);
});

test('a corrupt / truncated token is rejected, not silently mis-read', () => {
  assert.throws(() => decodeFrame('!!!!not-base64!!!!'));
  // a byte buffer whose first byte isn't the current version
  const bad = String.fromCharCode(...[]); // empty
  assert.throws(() => verifyFrame('Zm9v')); // "foo" → version byte 'f' (102) ≠ SHARE_VERSION
  assert.equal(SHARE_VERSION, 1);
});

test('encodeFromFrame is equivalent to encodeFrame with the variant id', () => {
  const shots = [{ angle: 1, speed: 3, spin: { side: 0, vert: 0 }, elevation: 0, cuePlacement: null }];
  assert.equal(encodeFromFrame(nineball, 9, shots), encodeFrame({ variantId: variantId(nineball), seed: 9, shots }));
});

test('verifyFrame reports the variant and a non-negative break for any valid token', () => {
  for (const v of [snooker, pool, nineball]) {
    const token = encodeFrame({ variantId: variantId(v), seed: 11, shots: [{ angle: 0, speed: 4, spin: { side: 0, vert: 0 }, elevation: 0, cuePlacement: { x: -0.5, y: 0 } }] });
    const r = verifyFrame(token);
    assert.equal(r.variant, v.id);
    assert.ok(r.highBreak >= 0);
    assert.equal(r.shots, 1);
  }
});
