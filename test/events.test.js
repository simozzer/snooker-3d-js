// events.test.js — DIRECT tests of the analytic event-detection layer (detectPair / detectWall /
// detectPocket). These are the engine's safety-critical core: get a contact TIME wrong and balls
// tunnel, double-collide, or stick. The full-simulation suite covers them indirectly ("no ball
// tunnels…"); here we pin each detector against an independent BRUTE-FORCE scan of the exact
// trajectory (posAt is the ground-truth path), and exercise the subtle approach-vs-separation
// logic that stops a just-resolved contact from being re-detected at dt≈0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as v from '../src/vec2.js';
import { Ball, posAt } from '../src/motion.js';
import { detectPair, detectWall, detectPocket } from '../src/events.js';
import { BALL } from '../src/snooker.js';

const R = BALL.radius;
const ball = (id, pos, vel = v.vec(0, 0), spin) =>
  new Ball({ id, kind: 'red', pos, vel, spin, radius: R, mass: BALL.mass });

const bounds = { minX: -1, maxX: 3, minY: -0.6, maxY: 0.6 };

// First time in (0, horizon] where |pA − pB| ≤ sumR, by a fine scan of the exact trajectories.
// Valid as an oracle for a CLEAN approach (monotone gap at the crossing) — not a sub-step graze.
function bruteContact(a, b, horizon = 6, dt = 2e-5) {
  const sumR = a.radius + b.radius;
  for (let t = 0; t <= horizon; t += dt) {
    if (v.len(v.sub(posAt(a.plan, t), posAt(b.plan, t))) <= sumR) return t;
  }
  return Infinity;
}

// First time the ball centre reaches a given axis-aligned wall coordinate, by a fine scan.
function bruteWall(a, axis, target, horizon = 8, dt = 2e-5) {
  for (let t = 0; t <= horizon; t += dt) {
    const p = posAt(a.plan, t);
    if (axis === 'xMax' && p.x >= target) return t;
    if (axis === 'xMin' && p.x <= target) return t;
    if (axis === 'yMax' && p.y >= target) return t;
    if (axis === 'yMin' && p.y <= target) return t;
  }
  return Infinity;
}

test('detectPair: head-on approach time matches a brute trajectory scan', () => {
  const a = ball('a', v.vec(0, 0), v.vec(1.5, 0)); // rolling toward b
  const b = ball('b', v.vec(0.5, 0)); // at rest in the way
  const t = detectPair(a, b, 0);
  const ref = bruteContact(a, b);
  assert.ok(Number.isFinite(t) && t > 0, `expected a finite positive contact, got ${t}`);
  assert.ok(Math.abs(t - ref) < 1e-3, `analytic ${t} vs brute ${ref}`);
});

test('detectPair: a separating pair in contact is NOT re-detected', () => {
  // Touching exactly (gap = R) but moving APART. The downward-crossing search must skip the
  // contact they are sitting on — otherwise a just-resolved collision fires again every step.
  const a = ball('a', v.vec(0, 0), v.vec(-1.0, 0)); // moving −x
  const b = ball('b', v.vec(2 * R, 0), v.vec(1.0, 0)); // moving +x, i.e. away from a
  const t = detectPair(a, b, 0);
  assert.equal(t, Infinity, 'a separating contact must not be re-reported');
});

test('detectPair: balls on non-colliding parallel paths never contact', () => {
  const a = ball('a', v.vec(0, 0), v.vec(2.0, 0));
  const b = ball('b', v.vec(0, 4 * R), v.vec(2.0, 0)); // parallel, a clear gap apart
  assert.equal(detectPair(a, b, 0), Infinity);
});

test('detectWall: cushion arrival time and axis match a brute scan', () => {
  const a = ball('a', v.vec(0, 0), v.vec(3.0, 0)); // straight at the right cushion
  const hit = detectWall(a, bounds, 0);
  assert.ok(hit && hit.axis === 'x', `expected an x-axis cushion, got ${JSON.stringify(hit)}`);
  const ref = bruteWall(a, 'xMax', bounds.maxX - R);
  assert.ok(Math.abs(hit.time - ref) < 1e-3, `analytic ${hit?.time} vs brute ${ref}`);
});

test('detectWall: the cushion a ball is LEAVING is not re-detected', () => {
  // Just off the right cushion, moving away (−x) with enough pace to cross the table. The right
  // wall must not fire at t≈0; the only real future event is the far LEFT cushion, much later.
  const a = ball('a', v.vec(bounds.maxX - R - 1e-3, 0), v.vec(-1.8, 0));
  const hit = detectWall(a, bounds, 0);
  assert.ok(hit, 'should still find the far (left) cushion');
  assert.ok(hit.time > 0.1, `must not re-detect the departing cushion at t≈0 (got ${hit.time})`);
  const ref = bruteWall(a, 'xMin', bounds.minX + R);
  assert.ok(Math.abs(hit.time - ref) < 1e-2, `left-cushion analytic ${hit.time} vs brute ${ref}`);
});

test('detectPocket: a ball rolled into a corner is captured at the right pocket', () => {
  const rp = 0.05;
  const pockets = [
    { center: { x: bounds.minX + rp, y: bounds.minY + rp }, radius: rp },
    { center: { x: bounds.maxX - rp, y: bounds.maxY - rp }, radius: rp }, // top-right, index 1
  ];
  const target = pockets[1].center;
  const a = ball('a', v.vec(0, 0), v.fromAngle(Math.atan2(target.y, target.x), 4.0));
  const cap = detectPocket(a, pockets, 0);
  assert.ok(cap && cap.pocketIndex === 1, `expected capture at pocket 1, got ${JSON.stringify(cap)}`);
  // brute: first time the centre falls within the pocket radius
  let ref = Infinity;
  for (let t = 0; t <= 6; t += 2e-5) {
    if (v.len(v.sub(posAt(a.plan, t), target)) <= rp) { ref = t; break; }
  }
  assert.ok(Math.abs(cap.time - ref) < 1e-3, `analytic ${cap.time} vs brute ${ref}`);
});

test('detectPocket: a ball rolling away from every pocket is not captured', () => {
  const rp = 0.05;
  const pockets = [{ center: { x: bounds.maxX - rp, y: bounds.maxY - rp }, radius: rp }];
  const a = ball('a', v.vec(0, 0), v.vec(-1.0, 0)); // heading away from the lone top-right pocket
  assert.equal(detectPocket(a, pockets, 0), null);
});
