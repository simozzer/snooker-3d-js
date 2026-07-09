// dice-physics.test.js — unit tests for the headless 3D dice simulator (src/board/dice-physics.js).
// The sim is seeded, so a throw is fully replayable; the tests pin the properties a physical die roll
// must have: it settles flat on the floor inside the tray, every read is a real 1..6, opposite faces
// sum to 7, the same seed reproduces the same throw, and over many throws the faces come up uniformly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDiceSim, readUpValue, FACES } from '../src/board/dice-physics.js';

// Lowest corner height of a die pose {p,q} for a die of side `size`.
function minCornerY(d, size) {
  const H = size / 2;
  let min = Infinity;
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    const c = { x: sx * H, y: sy * H, z: sz * H }, q = d.q;
    const tx = 2 * (q.y * c.z - q.z * c.y);
    const ty = 2 * (q.z * c.x - q.x * c.z);
    const tz = 2 * (q.x * c.y - q.y * c.x);
    const wy = d.p.y + c.y + q.w * ty + (q.z * tx - q.x * tz);
    min = Math.min(min, wy);
  }
  return min;
}

test('face map: opposite faces sum to 7 and cover 1..6 once each', () => {
  const seen = new Set();
  for (const f of FACES) seen.add(f.value);
  assert.equal(seen.size, 6);
  const opp = (n) => FACES.find((f) => f.n.x === -n.x && f.n.y === -n.y && f.n.z === -n.z);
  for (const f of FACES) assert.equal(f.value + opp(f.n).value, 7);
});

test('readUpValue: the identity orientation shows the +Y face (1)', () => {
  assert.equal(readUpValue({ x: 0, y: 0, z: 0, w: 1 }), 1);
  // a 180° flip about X points -Y (6) upward
  assert.equal(readUpValue({ x: 1, y: 0, z: 0, w: 0 }), 6);
});

test('a throw is deterministic for a given seed', () => {
  const sim = createDiceSim({ count: 6 });
  const a = sim.simulate(4242);
  const b = sim.simulate(4242);
  assert.deepEqual(a.values, b.values);
  // final poses match exactly too
  const la = a.frames.at(-1), lb = b.frames.at(-1);
  assert.deepEqual(la, lb);
});

test('every die settles flat on the floor, inside the tray, reading a valid 1..6', () => {
  const sim = createDiceSim({ count: 6 });
  const { tray, size } = sim;
  for (let seed = 1; seed <= 40; seed++) {
    const r = sim.simulate(seed);
    assert.equal(r.values.length, 6);
    for (const v of r.values) assert.ok(v >= 1 && v <= 6 && Number.isInteger(v), `value ${v} out of range`);
    const last = r.frames.at(-1);
    for (const d of last) {
      assert.ok(Math.abs(minCornerY(d, size)) < 0.03, `die not resting on floor (minY=${minCornerY(d, size)})`);
      assert.ok(Math.abs(d.p.x) <= tray.halfX + 0.01, 'die stayed within the tray in X');
      assert.ok(Math.abs(d.p.z) <= tray.halfZ + 0.01, 'die stayed within the tray in Z');
    }
  }
});

test('throws settle well before the time cap', () => {
  const sim = createDiceSim({ count: 6 });
  let total = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const r = sim.simulate(seed);
    assert.ok(r.settledAt < 5, `seed ${seed} did not settle (t=${r.settledAt})`);
    total += r.settledAt;
  }
  assert.ok(total / 40 < 2.5, 'average settle time is animation-friendly');
});

test('the sampled trajectory starts airborne and ends at rest', () => {
  const sim = createDiceSim({ count: 6 });
  const r = sim.simulate(7);
  assert.ok(r.frames.length >= 2);
  const first = r.frames[0], last = r.frames.at(-1);
  // at least one die starts clearly above the floor ...
  assert.ok(first.some((d) => d.p.y > sim.size), 'dice start above the tray');
  // ... and all rest near the floor by the end
  for (const d of last) assert.ok(d.p.y < sim.size * 1.2, 'dice have come down to rest');
});

test('faces come up roughly uniformly over many throws', () => {
  const sim = createDiceSim({ count: 6 });
  const dist = [0, 0, 0, 0, 0, 0];
  let n = 0;
  for (let seed = 1; seed <= 500; seed++) for (const v of sim.simulate(seed).values) { dist[v - 1]++; n++; }
  const expected = n / 6;
  for (let i = 0; i < 6; i++) {
    const ratio = dist[i] / expected;
    assert.ok(ratio > 0.82 && ratio < 1.18, `face ${i + 1} came up ${dist[i]} (ratio ${ratio.toFixed(2)}) — not uniform`);
  }
});

test('a single die and a full set both simulate cleanly', () => {
  for (const count of [1, 3, 6]) {
    const sim = createDiceSim({ count });
    const r = sim.simulate(99);
    assert.equal(r.values.length, count);
    assert.equal(r.frames.at(-1).length, count);
  }
});
