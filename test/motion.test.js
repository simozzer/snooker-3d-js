import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as v from '../src/vec2.js';
import { GRAVITY, MU_SLIDE, MU_ROLL, BALL, SLIP_FACTOR } from '../src/snooker.js';
import { Ball, twoPhasePlan, posAt, velAt, spinAt, slip } from '../src/motion.js';

const A_SLIDE = MU_SLIDE * GRAVITY;
const A_ROLL = MU_ROLL * GRAVITY;
const R = BALL.radius;
const ball = (over = {}) => new Ball({ id: 'b', kind: 'cue', radius: R, mass: BALL.mass, pos: v.vec(0, 0), ...over });

// A no-spin ("stun") shot slides, then begins to roll at exactly 5/7 of its launch speed —
// the classic billiard result (slip dies at tRoll, leaving v = (1 − 1/SLIP_FACTOR)·v0).
test('no-spin shot rolls at 5/7 of launch speed and travels straight', () => {
  const v0 = 2.0;
  const b = ball({ vel: v.vec(v0, 0) });
  const expectVRoll = v0 * (1 - 1 / SLIP_FACTOR); // 5/7 v0
  assert.ok(Math.abs(v.len(b.plan.vRoll) - expectVRoll) < 1e-9, `vRoll=${v.len(b.plan.vRoll)} expected ${expectVRoll}`);
  // travels purely along +x
  const mid = b.posAt(b.rollTime());
  assert.ok(Math.abs(mid.y) < 1e-12, `curved off-axis: y=${mid.y}`);
  // total distance = slide leg + roll leg, both closed-form
  const dSlide = (v0 * v0 - expectVRoll * expectVRoll) / (2 * A_SLIDE);
  const dRoll = (expectVRoll * expectVRoll) / (2 * A_ROLL);
  const end = b.posAt(b.stopTime());
  assert.ok(Math.abs(end.x - (dSlide + dRoll)) < 1e-6, `end.x=${end.x} expected ${dSlide + dRoll}`);
});

// A ball launched with its NATURAL rolling spin never slides: single straight roll phase,
// decelerating only under rolling resistance, stopping at v0²/(2·A_ROLL).
test('a naturally-rolling ball has no slide phase', () => {
  const v0 = 1.5;
  // natural roll: slip u = v + R·perp(s) = 0  =>  s = { x: -vy/R, y: vx/R }
  const spin = { x: 0, y: v0 / R, z: 0 };
  const b = ball({ vel: v.vec(v0, 0), spin });
  assert.ok(v.len(slip(b.vel, b.spin, R)) < 1e-9, 'slip should be ~0');
  assert.ok(b.rollTime() < 1e-12, `tRoll=${b.rollTime()} should be 0`);
  const end = b.posAt(b.stopTime());
  assert.ok(Math.abs(end.x - (v0 * v0) / (2 * A_ROLL)) < 1e-6, `end.x=${end.x}`);
});

// Follow: a ball whose centre is at rest but carries top-spin accelerates FORWARD.
// Draw (screw): back-spin accelerates it BACKWARD. This is the post-collision cue action.
test('residual spin drives a stationary ball (follow forward, draw backward)', () => {
  const follow = ball({ vel: v.vec(0, 0), spin: { x: 0, y: 10, z: 0 } });
  const fEnd = follow.posAt(follow.stopTime());
  assert.ok(fEnd.x > 1e-4, `follow should roll +x, got ${fEnd.x}`);
  assert.ok(Math.abs(fEnd.y) < 1e-12);

  const draw = ball({ vel: v.vec(0, 0), spin: { x: 0, y: -10, z: 0 } });
  const dEnd = draw.posAt(draw.stopTime());
  assert.ok(dEnd.x < -1e-4, `draw should screw back −x, got ${dEnd.x}`);
});

// Swerve: side-spin combined with motion makes the slip non-parallel to v, so the slide
// segment curves sideways (the parabola is genuinely 2D).
test('side-spin produces a curved (swerving) slide path', () => {
  const b = ball({ vel: v.vec(2.0, 0), spin: { x: 5, y: 0, z: 0 } }); // spin.x ⟂ travel
  const mid = b.posAt(b.rollTime() * 0.5);
  assert.ok(Math.abs(mid.y) > 1e-4, `expected lateral curve, y=${mid.y}`);
});

// Segments must join continuously in position and velocity at the slide→roll handover.
test('position and velocity are continuous at the slide→roll transition', () => {
  const b = ball({ vel: v.vec(1.3, 0.4), spin: { x: 2, y: -1, z: 0 } });
  const tR = b.rollTime();
  const pBefore = posAt(b.plan, tR - 1e-7);
  const pAfter = posAt(b.plan, tR + 1e-7);
  assert.ok(v.len(v.sub(pBefore, pAfter)) < 1e-6, 'position jump at transition');
  const vBefore = velAt(b.plan, tR - 1e-7);
  const vAfter = velAt(b.plan, tR + 1e-7);
  assert.ok(v.len(v.sub(vBefore, vAfter)) < 1e-6, 'velocity jump at transition');
});

// After it starts rolling, the horizontal spin matches the natural rolling spin for vRoll.
test('spin settles to the natural rolling value once rolling', () => {
  const b = ball({ vel: v.vec(1.0, 0), spin: { x: 0, y: 0, z: 8 } });
  const tMid = (b.rollTime() + b.stopTime()) / 2;
  const s = spinAt(b.plan, tMid);
  const vMid = velAt(b.plan, tMid);
  // natural roll: v + R·perp(s_h) = 0
  const residualSlip = v.add(vMid, v.scale(v.perp({ x: s.x, y: s.y }), R));
  assert.ok(v.len(residualSlip) < 1e-6, `slip not killed: ${v.len(residualSlip)}`);
  assert.ok(s.z >= 0 && s.z < 8, `side spin should have decayed: ${s.z}`);
});

// A ball at rest with no spin produces an empty (zero-duration) plan.
test('a ball at rest has a zero-duration plan', () => {
  const b = ball();
  assert.equal(b.stopTime(), 0);
  assert.equal(b.moving, false);
});
