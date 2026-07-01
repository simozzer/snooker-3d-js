// roots.test.js — ROBUSTNESS of the collision-time root finder against the skip-through
// (tunnelling) failure mode of event-driven detection.
//
// The live engine never SAMPLES a trajectory to find a contact (see events.js): within a motion
// segment the path is exactly P + V·t + C·t², so every contact condition is an exact quartic, and
// firstQuarticRoot brackets it at the quartic's CRITICAL POINTS (roots of q', via the closed-form
// cubic). Each resulting sub-interval is monotonic, so a brief graze — the balls touching and
// separating inside a window narrower than any fixed step — cannot hide between samples: its local
// minimum IS a critical point and becomes a bracket boundary.
//
// These tests pin that property down. The headline case builds a graze so brief that a naive
// fixed-step scanner provably steps right over it, and asserts the real solver still finds it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstQuarticRoot, cubicRoots, smallestPositiveQuadratic } from '../src/roots.js';

// Build the quartic k4·(t−r1)(t−r2)(t²+b·t+c). With disc(t²+b·t+c) < 0 the trailing factor is
// strictly positive everywhere, so the only sign changes of q are the graze entry/exit at r1,r2.
function grazeQuartic(r1, r2, k4 = 1, b = 0, c = 1) {
  const p = -(r1 + r2);
  const q0 = r1 * r2;
  return {
    k4,
    k3: k4 * (b + p),
    k2: k4 * (c + p * b + q0),
    k1: k4 * (p * c + q0 * b),
    k0: k4 * (q0 * c),
  };
}

// What a fixed-step sampler (roots.firstRoot, the unused fallback) would do: scan `steps` equal
// slices for the first endpoint where q ≤ 0. Reproduced here only to demonstrate the skip-through
// it suffers — the reason the live paths use the exact critical-point bracketing instead.
function naiveSamplerFirstRoot(K, lo, hi, steps = 256) {
  const q = (t) => (((K.k4 * t + K.k3) * t + K.k2) * t + K.k1) * t + K.k0;
  const dt = (hi - lo) / steps;
  for (let i = 1; i <= steps; i++) {
    if (q(lo + i * dt) <= 0) return lo + i * dt;
  }
  return Infinity;
}

test('finds a graze briefer than a fixed sampler step (no skip-through)', () => {
  // Graze opens at t=0.503 and closes 1e-4 later — far narrower than a 256-step slice over [0,1]
  // (~3.9e-3). r1 is deliberately off the sample grid so the scanner lands either side of it.
  const r1 = 0.503;
  const r2 = r1 + 1e-4;
  const K = grazeQuartic(r1, r2);

  const t = firstQuarticRoot(K.k4, K.k3, K.k2, K.k1, K.k0, 0, 1);
  assert.ok(Math.abs(t - r1) < 1e-6, `expected first contact ≈ ${r1}, got ${t}`);

  // And confirm this is a real trap, not a soft one: the naive sampler steps clean over it.
  const miss = naiveSamplerFirstRoot(K, 0, 1, 256);
  assert.equal(miss, Infinity, 'sampler should miss the sub-step graze (that is the whole point)');
});

test('reports NO contact for a near-miss (gap dips toward 0 but never reaches it)', () => {
  // Complex conjugate roots near t≈0.5: |Δp| has a local minimum > R, the balls never touch.
  // q(t) = (t² − t + 0.2501) · (t² + 1) > 0 ∀t  (first factor disc = 1 − 1.0004 < 0).
  const f1 = { b: -1, c: 0.2501 };
  const p = f1.b;
  const q0 = f1.c;
  const b = 0;
  const c = 1;
  const K = {
    k4: 1,
    k3: b + p,
    k2: c + p * b + q0,
    k1: p * c + q0 * b,
    k0: q0 * c,
  };
  const t = firstQuarticRoot(K.k4, K.k3, K.k2, K.k1, K.k0, 0, 1);
  assert.equal(t, Infinity, 'a never-touching near-miss must not register a contact');
});

test('fuzz: first contact is exact across randomised brief grazes', () => {
  // The analytic root IS the ground truth: q = k4·(t−r1)(t−r2)·(positive) is > 0 for t < r1, so
  // the first downward crossing is exactly r1. (No sampler can serve as the oracle here — even a
  // 400k-step scan over [0,1] steps over a sub-2.5e-6 graze, the very flaw under test.)
  // Deterministic LCG so the run is reproducible (no Date/Math.random dependence on CI).
  let s = 0x2545f491;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

  let checked = 0;
  let tightest = Infinity;
  for (let i = 0; i < 400; i++) {
    const r1 = 0.05 + rnd() * 0.9; // first contact somewhere in (0,1)
    const width = 10 ** (-1 - rnd() * 5); // graze width 1e-1 … 1e-6
    const r2 = Math.min(r1 + width, 0.999);
    if (r2 <= r1) continue;
    const k4 = 0.2 + rnd() * 5; // vary scale/conditioning
    const K = grazeQuartic(r1, r2, k4);

    const got = firstQuarticRoot(K.k4, K.k3, K.k2, K.k1, K.k0, 0, 1);
    assert.ok(
      Math.abs(got - r1) < 1e-5,
      `case ${i}: solver ${got} vs analytic ${r1} (graze width ${width})`,
    );
    tightest = Math.min(tightest, r2 - r1);
    checked++;
  }
  assert.ok(checked > 300, `expected to exercise >300 grazes, ran ${checked}`);
  assert.ok(tightest < 1e-5, `should have exercised sub-1e-5 grazes, tightest was ${tightest}`);
});

// --- cubicRoots: the bracket-finder underneath firstQuarticRoot (it locates the quartic's
// critical points by solving q'=0). If this is wrong, the monotonic bracketing above breaks. ---

const cubicAt = (a, b, c, d, t) => ((a * t + b) * t + c) * t + d;

test('cubicRoots: one real root (Cardano, single-real branch)', () => {
  // (t−2)(t²+1) = t³ − 2t² + t − 2 → one real root at 2, two complex.
  const roots = cubicRoots(1, -2, 1, -2);
  assert.equal(roots.length, 1);
  assert.ok(Math.abs(roots[0] - 2) < 1e-9, `got ${roots[0]}`);
});

test('cubicRoots: three distinct real roots (trig branch)', () => {
  // (t−1)(t−2)(t−3) = t³ − 6t² + 11t − 6.
  const roots = cubicRoots(1, -6, 11, -6).sort((x, y) => x - y);
  assert.equal(roots.length, 3);
  for (const [i, want] of [1, 2, 3].entries()) {
    assert.ok(Math.abs(roots[i] - want) < 1e-9, `root ${i}: ${roots[i]} vs ${want}`);
  }
});

test('cubicRoots: a repeated root is found (near-zero discriminant)', () => {
  // (t−1)²(t+2) = t³ − 3t + 2 → double root at 1, single at −2.
  const roots = cubicRoots(1, 0, -3, 2);
  assert.ok(roots.length >= 1);
  for (const r of roots) assert.ok(Math.abs(cubicAt(1, 0, -3, 2, r)) < 1e-7, `residual at ${r}`);
  assert.ok(roots.some((r) => Math.abs(r - 1) < 1e-5), 'should recover the double root at 1');
  assert.ok(roots.some((r) => Math.abs(r + 2) < 1e-5), 'should recover the single root at −2');
});

test('cubicRoots: degenerates to the quadratic when the leading term vanishes', () => {
  // a=0 → t² − 3t + 2, roots {1, 2}.
  const roots = cubicRoots(0, 1, -3, 2).sort((x, y) => x - y);
  assert.equal(roots.length, 2);
  assert.ok(Math.abs(roots[0] - 1) < 1e-12 && Math.abs(roots[1] - 2) < 1e-12);
});

test('cubicRoots: returned roots satisfy the cubic across a randomised sweep', () => {
  let s = 0x1234567;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5) * 8;
  for (let i = 0; i < 300; i++) {
    const a = rnd() || 1;
    const b = rnd();
    const c = rnd();
    const d = rnd();
    for (const r of cubicRoots(a, b, c, d)) {
      // Scale the residual tolerance by the local slope so flat/steep cubics are judged fairly.
      const slope = Math.max(1, Math.abs((3 * a * r + 2 * b) * r + c));
      assert.ok(Math.abs(cubicAt(a, b, c, d, r)) < 1e-6 * slope, `case ${i}: residual at ${r}`);
    }
  }
});

// --- smallestPositiveQuadratic: the exact Phase-1 (straight-line) wall/pair time solve. ---

test('smallestPositiveQuadratic: returns the smaller positive root', () => {
  // (t−1)(t−3) = t² − 4t + 3.
  assert.ok(Math.abs(smallestPositiveQuadratic(1, -4, 3) - 1) < 1e-12);
});

test('smallestPositiveQuadratic: both roots negative → Infinity', () => {
  // (t+1)(t+3) = t² + 4t + 3.
  assert.equal(smallestPositiveQuadratic(1, 4, 3), Infinity);
});

test('smallestPositiveQuadratic: no real roots → Infinity', () => {
  assert.equal(smallestPositiveQuadratic(1, 0, 1), Infinity); // t² + 1
});

test('smallestPositiveQuadratic: linear fallback when a≈0', () => {
  // 2t − 1 = 0 → t = 0.5.
  assert.ok(Math.abs(smallestPositiveQuadratic(0, 2, -1) - 0.5) < 1e-12);
});

test('smallestPositiveQuadratic: minT skips a root at/just below the floor', () => {
  // roots {1, 3}; with minT=2 the first valid root is 3.
  assert.ok(Math.abs(smallestPositiveQuadratic(1, -4, 3, 2) - 3) < 1e-12);
});
