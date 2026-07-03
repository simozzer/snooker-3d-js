// share.test.js — the shareable-frame codec: encode → decode round-trips within quantisation tolerance,
// tokens are URL-safe and compact, the seed reproduces the exact rack, and replaying a decoded token is
// deterministic (same physics on any machine) — the property leaderboards / async challenges rely on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFrame, decodeFrame, replayFrame, mulberry32, variantId } from '../src/share.js';
import { newGame } from '../src/game.js';
import { pool } from '../src/variants/pool.js';

const posKey = (game) => game.pieces.map((p) => `${p.id}:${p.pos.x.toFixed(9)},${p.pos.y.toFixed(9)}`).sort().join('|');

test('encode → decode round-trips fields within quantisation tolerance', () => {
  const shots = [
    { angle: 1.2345, speed: 5.5, spin: { side: 0.3, vert: -0.4 }, elevation: 0.2, cuePlacement: { x: -0.5, y: 0.1 } },
    { angle: 3.0, speed: 2.0, spin: { side: 0, vert: 0 }, elevation: 0, cuePlacement: null },
  ];
  const dec = decodeFrame(encodeFrame({ variantId: 1, seed: 12345, shots }));
  assert.equal(dec.variantId, 1);
  assert.equal(dec.seed, 12345);
  assert.equal(dec.shots.length, 2);
  assert.ok(Math.abs(dec.shots[0].angle - 1.2345) < 1e-3, 'angle');
  assert.ok(Math.abs(dec.shots[0].speed - 5.5) < 1e-3, 'speed');
  assert.ok(Math.abs(dec.shots[0].spin.side - 0.3) < 1e-3, 'side');
  assert.ok(Math.abs(dec.shots[0].spin.vert - -0.4) < 1e-3, 'vert');
  assert.ok(Math.abs(dec.shots[0].elevation - 0.2) < 1e-3, 'elevation');
  assert.ok(Math.abs(dec.shots[0].cuePlacement.x - -0.5) < 2e-4, 'placement x');
  assert.ok(Math.abs(dec.shots[0].cuePlacement.y - 0.1) < 2e-4, 'placement y');
  assert.equal(dec.shots[1].cuePlacement, null, 'no placement flag round-trips');
});

test('token is URL-safe and compact', () => {
  const shots = Array.from({ length: 24 }, (_, i) => ({ angle: i * 0.25, speed: 3 + i * 0.1, spin: { side: 0, vert: 0 }, elevation: 0, cuePlacement: i === 0 ? { x: 0, y: 0 } : null }));
  const token = encodeFrame({ variantId: 0, seed: 7, shots });
  assert.match(token, /^[A-Za-z0-9_-]+$/, 'URL-safe alphabet only');
  assert.ok(token.length < 420, `a 24-shot frame token should be compact, got ${token.length}`);
});

test('the seed reproduces the exact rack (replayFrame start == newGame with same seed)', () => {
  const seed = 4242;
  const direct = newGame(pool, { rng: mulberry32(seed) });
  const viaShare = replayFrame({ variantId: variantId(pool), seed, shots: [] });
  assert.equal(posKey(viaShare.game), posKey(direct), 'shared-seed rack diverged from a direct newGame');
});

test('replaying a decoded token is deterministic and reproduces the frame bit-for-bit', () => {
  // a break-ish opener that actually scatters the pack, plus a follow-up
  const shots = [
    { angle: 0.02, speed: 6.6, spin: { side: 0, vert: 0 }, elevation: 0, cuePlacement: { x: -0.6, y: 0.0 } },
    { angle: 0.6, speed: 3.2, spin: { side: 0.2, vert: 0 }, elevation: 0, cuePlacement: null },
  ];
  const token = encodeFrame({ variantId: variantId(pool), seed: 999, shots });

  const A = replayFrame(decodeFrame(token));
  const B = replayFrame(decodeFrame(token)); // a second "machine" decoding the same link
  assert.equal(posKey(A.game), posKey(B.game), 'two decodes of the same token produced different physics');
  assert.ok(A.steps.length >= 1 && A.steps[0].timeline.length > 1, 'the shot produced a real timeline');
  // the pack actually moved (the shots did something)
  const fresh = newGame(pool, { rng: mulberry32(999) });
  assert.notEqual(posKey(A.game), posKey(fresh), 'replayed frame is identical to the untouched rack — shots had no effect');
});

test('a full encode→decode→encode cycle is stable (canonical token)', () => {
  const shots = [
    { angle: 2.1, speed: 4.0, spin: { side: -0.5, vert: 0.6 }, elevation: 0.35, cuePlacement: { x: 0.3, y: -0.2 } },
  ];
  const t1 = encodeFrame({ variantId: 2, seed: 1, shots });
  const t2 = encodeFrame({ variantId: 2, seed: 1, shots: decodeFrame(t1).shots });
  assert.equal(t1, t2, 'decoding then re-encoding a token should be idempotent');
});
