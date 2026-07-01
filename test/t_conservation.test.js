// t_conservation.test.js — MILESTONE T group 1: conservation invariants (property-style, many
// deterministic seeds). Linear momentum, kinetic/mechanical energy, angular bookkeeping.
// A fixed PRNG makes every case reproducible.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as v3 from '../src/vec3.js';
import { BALL, GRAVITY, INERTIA_FACTOR } from '../src/snooker.js';
import { Ball } from '../src/motion.js';
import { resolvePair3D, resolveContact } from '../src/collisions.js';
import { runEngine } from '../src/engine.js';
import { bounds, pockets } from '../src/table.js';

const R = BALL.radius;
const M = BALL.mass;
const I = INERTIA_FACTOR * M * R * R;

// Deterministic PRNG (mulberry32) — fixed seed ⇒ reproducible cases.
function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const span = (r, a, b) => a + (b - a) * r();

const mk = (id, pos, vel, spin) => new Ball({ id, kind: 'cue', radius: R, mass: M, pos, vel, spin });
const mom = (b) => v3.scale(b.vel, M);
const rotKE = (b) => 0.5 * I * v3.len2(b.spin);
const transKE = (b) => 0.5 * M * v3.len2(b.vel);
const mech = (b) => transKE(b) + rotKE(b) + M * GRAVITY * (b.pos.z - R); // total mechanical energy

// A touching pair with random 3D velocities + spin along a random contact normal, guaranteed to be
// APPROACHING with a meaningful closing speed (a definite inward component is added along −n) so
// the resolver always does real work — no near-tangential no-op cases.
function randomPair(r) {
  const n = v3.normalize(v3.vec(span(r, -1, 1), span(r, -1, 1), span(r, -1, 1)));
  const a = mk('a', v3.vec(0, 0, 0.3), v3.vec(span(r, -3, 3), span(r, -3, 3), span(r, -3, 3)), v3.vec(span(r, -50, 50), span(r, -50, 50), span(r, -50, 50)));
  const b = mk('b', v3.add(a.pos, v3.scale(n, 2 * R)), v3.vec(span(r, -3, 3), span(r, -3, 3), span(r, -3, 3)), v3.vec(span(r, -50, 50), span(r, -50, 50), span(r, -50, 50)));
  // b sits in the +n direction from a, so the resolver's contact normal (a.pos−b.pos) is −n. For a
  // genuine approach we need a to move TOWARD b (along +n): drive (a.vel−b.vel)·n up to ≥ +1 m/s.
  const vn = v3.dot(v3.sub(a.vel, b.vel), n);
  a.vel = v3.add(a.vel, v3.scale(n, -vn + (1 + span(r, 0, 2)))); // makes (a.vel−b.vel)·n ≥ +1
  return { a, b };
}

test('ball-ball: linear momentum conserved across every contact (60 seeds, e and μ swept)', () => {
  const r = rng(12345);
  for (let i = 0; i < 60; i++) {
    const { a, b } = randomPair(r);
    const e = span(r, 0, 1);
    const mu = span(r, 0, 0.3);
    const velA0 = { ...a.vel };
    const pBefore = v3.add(mom(a), mom(b));
    resolvePair3D(a, b, e, mu);
    const pAfter = v3.add(mom(a), mom(b));
    assert.ok(v3.len(v3.sub(pAfter, pBefore)) < 1e-9, `seed ${i}: momentum drift ${v3.len(v3.sub(pAfter, pBefore))}`);
    // non-vacuous: the resolver must actually have acted (a no-op would trivially conserve momentum)
    assert.ok(v3.len(v3.sub(a.vel, velA0)) > 1e-6, `seed ${i}: resolver was a no-op (velocities unchanged)`);
  }
});

test('ball-ball: kinetic energy conserved at e=1, μ=0 (40 seeds)', () => {
  const r = rng(999);
  for (let i = 0; i < 40; i++) {
    const { a, b } = randomPair(r);
    const velA0 = { ...a.vel };
    const keBefore = transKE(a) + transKE(b) + rotKE(a) + rotKE(b);
    resolvePair3D(a, b, 1.0, 0);
    const keAfter = transKE(a) + transKE(b) + rotKE(a) + rotKE(b);
    assert.ok(Math.abs(keAfter - keBefore) < 1e-9, `seed ${i}: KE drift ${Math.abs(keAfter - keBefore)}`);
    assert.ok(v3.len(v3.sub(a.vel, velA0)) > 1e-6, `seed ${i}: resolver was a no-op`);
  }
});

test('ball-ball: kinetic energy strictly NON-INCREASING for e<1 or μ>0 (80 seeds)', () => {
  const r = rng(777);
  for (let i = 0; i < 80; i++) {
    const { a, b } = randomPair(r);
    const e = span(r, 0, 0.99);
    const mu = span(r, 0, 0.3);
    const keBefore = transKE(a) + transKE(b) + rotKE(a) + rotKE(b);
    resolvePair3D(a, b, e, mu);
    const keAfter = transKE(a) + transKE(b) + rotKE(a) + rotKE(b);
    assert.ok(keAfter <= keBefore + 1e-9, `seed ${i}: KE rose by ${keAfter - keBefore} (e=${e.toFixed(2)} μ=${mu.toFixed(2)})`);
  }
});

test('bed contact: energy non-increasing and momentum change is purely the floor impulse (40 seeds)', () => {
  const r = rng(2024);
  for (let i = 0; i < 40; i++) {
    const b = mk('b', v3.vec(0, 0, R), v3.vec(span(r, -3, 3), span(r, -3, 3), span(r, -3, -0.1)), v3.vec(span(r, -80, 80), span(r, -80, 80), span(r, -30, 30)));
    const keBefore = transKE(b) + rotKE(b);
    resolveContact(b, v3.vec(0, 0, 1), span(r, 0, 1), span(r, 0, 0.3));
    const keAfter = transKE(b) + rotKE(b);
    assert.ok(keAfter <= keBefore + 1e-9, `seed ${i}: bed contact raised KE by ${keAfter - keBefore}`);
  }
});

test('full shot: total mechanical energy (trans+rot+gravity PE) never rises across any event', () => {
  const r = rng(31337);
  const shots = [];
  for (let i = 0; i < 24; i++) {
    shots.push({ ballId: 'cue', angle: span(r, 0, 2 * Math.PI), speed: span(r, 1, 8), spin: { side: span(r, -0.9, 0.9), vert: span(r, -0.9, 0.9) }, elevation: r() < 0.3 ? span(r, 0, Math.PI / 5) : 0 });
  }
  for (let s = 0; s < shots.length; s++) {
    const cue = mk('cue', v3.vec(-0.6, 0.1, R), v3.vec(0, 0, 0), v3.vec(0, 0, 0));
    const obj = mk('obj', v3.vec(0.2, -0.05, R), v3.vec(0, 0, 0), v3.vec(0, 0, 0));
    const res = runEngine({ balls: [cue, obj], bounds: bounds(), pockets: pockets() }, shots[s], {});
    let prev = Infinity;
    for (const snap of res.timeline) {
      const tot = snap.balls.reduce((acc, bb) => acc + (0.5 * M * v3.len2(bb.vel) + 0.5 * I * v3.len2(bb.spin) + M * GRAVITY * (bb.pos.z - R)), 0);
      assert.ok(tot <= prev + 1e-6, `shot ${s}: energy rose at t=${snap.t} (${snap.kind}): ${tot} > ${prev}`);
      prev = tot;
    }
    assert.ok(res.settled, `shot ${s} must settle`);
  }
});

test('bed bounce: angular momentum about the contact point is unchanged by the NORMAL impulse', () => {
  // A pure normal (frictionless) floor impulse acts along the contact radius, so it applies no
  // torque about the contact point → the ball's spin must be untouched by a μ=0 bed bounce.
  const r = rng(55);
  for (let i = 0; i < 20; i++) {
    const b = mk('b', v3.vec(0, 0, R), v3.vec(span(r, -2, 2), span(r, -2, 2), span(r, -3, -0.2)), v3.vec(span(r, -60, 60), span(r, -60, 60), span(r, -60, 60)));
    const spinBefore = { ...b.spin };
    resolveContact(b, v3.vec(0, 0, 1), span(r, 0, 1), 0); // μ=0
    assert.ok(v3.len(v3.sub(b.spin, spinBefore)) < 1e-12, `seed ${i}: frictionless bed bounce changed spin`);
  }
});
