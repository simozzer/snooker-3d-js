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

// A die is "flat" when one of its face normals points essentially straight up.
function upFaceY(d) {
  const q = d.q;
  let best = -Infinity;
  for (const f of FACES) {
    const v = f.n;
    const tx = 2 * (q.y * v.z - q.z * v.y);
    const ty = 2 * (q.z * v.x - q.x * v.z);
    const tz = 2 * (q.x * v.y - q.y * v.x);
    const wy = v.y + q.w * ty + (q.z * tx - q.x * tz);
    best = Math.max(best, wy);
  }
  return best;
}

test('a clean (uncocked) throw lays every die flat on the floor, inside the tray, reading 1..6', () => {
  const sim = createDiceSim({ count: 6 });
  const { tray, size } = sim;
  let clean = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const r = sim.simulate(seed);
    assert.equal(r.values.length, 6);
    for (const v of r.values) assert.ok(v >= 1 && v <= 6 && Number.isInteger(v), `value ${v} out of range`);
    if (r.cocked) continue; // a cocked throw is deliberately left un-flattened for the view to re-roll
    clean++;
    const last = r.frames.at(-1);
    for (const d of last) {
      assert.ok(Math.abs(minCornerY(d, size)) < 0.03, `die not resting on floor (minY=${minCornerY(d, size)})`);
      assert.ok(upFaceY(d) > 0.999, `clean die not laid flat (upFaceY=${upFaceY(d).toFixed(4)})`);
      assert.ok(Math.abs(d.p.x) <= tray.halfX + 0.01, 'die stayed within the tray in X');
      assert.ok(Math.abs(d.p.z) <= tray.halfZ + 0.01, 'die stayed within the tray in Z');
    }
  }
  // Cocked throws should be the rare exception, not the rule — the physics settles flat almost always.
  assert.ok(clean >= 36, `too many cocked throws (${40 - clean}/40) — physics is not settling flat`);
});

test('flat-laid dice rest at varied headings, not all parallel to the tray walls', () => {
  // The old snap-to-grid always left the die's X axis on a world axis (yaw a multiple of 90°). Laying
  // flat while keeping the natural heading must produce a spread of yaws across dice/throws.
  const sim = createDiceSim({ count: 6 });
  const yaws = [];
  for (let seed = 1; seed <= 20; seed++) {
    const r = sim.simulate(seed);
    if (r.cocked) continue;
    for (const d of r.frames.at(-1)) {
      const q = d.q; // heading = atan2 of the die's local +X projected onto the floor
      const fx = 1 - 2 * (q.y * q.y + q.z * q.z);
      const fz = 2 * (q.x * q.z - q.w * q.y);
      let yaw = Math.atan2(fz, fx) * 180 / Math.PI; // -180..180
      yaw = ((yaw % 90) + 90) % 90;                 // fold into 0..90 (a cube face has 90° symmetry)
      yaws.push(yaw);
    }
  }
  // If everything were axis-aligned these would all sit at ~0/90 (folded → ~0). A genuine spread has a
  // healthy fraction landing mid-range.
  const midRange = yaws.filter((y) => y > 15 && y < 75).length / yaws.length;
  assert.ok(midRange > 0.4, `headings look grid-aligned, not natural (mid-range fraction ${midRange.toFixed(2)})`);
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
