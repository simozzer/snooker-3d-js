// rail3d.test.js — Milestone C: straight rails as horizontal cushion CYLINDERS (analytic rail
// hops). The rail axis sits just below ball-centre height, so the contact normal tilts slightly
// upward and a firm shot HOPS — emergent from the geometry, not hand-coded. A flat shot reduces to
// the old wall model within the small nose-angle tolerance. Rails are finite, leaving pocket gaps.
// Deterministic (fixed inputs, no RNG).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as v3 from '../src/vec3.js';
import { BALL, CUSHION_RESTITUTION, CUSHION_FRICTION_T } from '../src/snooker.js';
import { Ball } from '../src/motion.js';
import { resolveWall } from '../src/collisions.js';
import { runEngine } from '../src/engine.js';
import { bounds, pockets, railCylinders, HY } from '../src/table.js';

const R = BALL.radius;
const M = BALL.mass;
const mk = (id, pos, vel = v3.vec(0, 0, 0), spin = { x: 0, y: 0, z: 0 }) =>
  new Ball({ id, kind: 'cue', radius: R, mass: M, pos, vel, spin });
const layout = (balls) => ({ balls, bounds: bounds(), pockets: pockets() });
const deg = (r) => (r * 180) / Math.PI;

// (a1) A ball rolled diagonally into a rail rebounds: the perpendicular velocity REVERSES and its
// magnitude drops (restitution + a little to the small hop), while the along-rail velocity keeps
// its sign. The angle-out is close to (and slightly steeper than) angle-in — the realistic cushion
// effect — within the nose-geometry + cushion-friction tolerance.
test('diagonal into a rail: perpendicular velocity reverses, along-rail sign kept', () => {
  // aim at the TOP long rail at x=0.3 (clear of the middle pocket at x=0 and the corners)
  const cue = mk('cue', v3.vec(0.3, 0.2, R), v3.vec(1.6, 1.6, 0));
  const res = runEngine(layout([cue]), null, { maxEvents: 1 });
  const rail = res.timeline.find((s) => s.kind === 'rail');
  assert.ok(rail, 'the ball should strike the top rail');
  const c = rail.balls[0];
  assert.ok(c.vel.y < 0, 'the perpendicular (y) velocity must reverse');
  assert.ok(Math.sign(c.vel.x) === 1, 'the along-rail (x) velocity keeps its sign');
  // reflected angle is within ~6° of the incidence angle (cushions steepen the rebound a little)
  const inAngle = deg(Math.atan2(1.6, 1.6));
  const outAngle = deg(Math.atan2(-c.vel.y, c.vel.x));
  assert.ok(Math.abs(inAngle - outAngle) < 6, `angle-in ${inAngle.toFixed(1)}° vs angle-out ${outAngle.toFixed(1)}°`);
  // perpendicular speed lost energy (≤ incoming) but the ball genuinely came off the rail
  const normOut = Math.abs(c.vel.y);
  assert.ok(normOut > 0.3 && normOut < 1.6, `perpendicular speed out ${normOut.toFixed(3)}`);
});

// (a2) REGRESSION: a nearly-flat (slow) rebound off the cylinder matches the OLD flat-wall model
// closely. Tolerance is the nose geometry: the axis is a fraction of R below centre, so the normal
// tilts ~asin(drop/(R+r_c)) ≈ 3°, steepening the rebound and adding a sub-cm hop — both small.
test('cylinder rebound reduces to the flat-wall model for a slow shot (nose tolerance)', () => {
  const vy = 1.0;
  // cylinder path: slow ball into the top rail at x = 0.4
  const cyl = mk('c', v3.vec(0.4, HY - R - 0.05, R), v3.vec(0, vy, 0));
  const res = runEngine(layout([cyl]), null, { maxEvents: 1 });
  const after = res.timeline.find((s) => s.kind === 'rail').balls[0];

  // flat-wall reference: the old resolveWall on the 'y' axis with the same restitution/friction
  const wall = mk('w', v3.vec(0.4, HY - R, R), v3.vec(0, vy, 0));
  resolveWall(wall, 'y', CUSHION_RESTITUTION, 1e-3, CUSHION_FRICTION_T);

  // the reversed perpendicular speed matches within the nose tolerance; the along-rail stays ~0
  assert.ok(Math.abs(after.vel.y - wall.vel.y) < 0.15, `cyl vy ${after.vel.y.toFixed(3)} vs wall ${wall.vel.y.toFixed(3)}`);
  assert.ok(Math.abs(after.vel.x) < 1e-6, 'no along-rail drift on a square hit');
  assert.ok(after.vel.z >= 0 && after.vel.z < 0.15, `slow-shot hop should be tiny, vz=${after.vel.z}`);
});

// (b) A FIRM shot into a rail produces a measurable HOP: z rises above R after the contact, then
// the ball settles through the event loop (multi-bounce). The hop emerges from the below-centre
// nose geometry — nothing special-cases a vertical impulse.
test('a firm shot into a rail hops (z rises above R) and then settles', () => {
  const cue = mk('cue', v3.vec(0.5, 0.2, R), v3.vec(0, 6.0, 0)); // hard, square into the top rail
  const res = runEngine(layout([cue]), null, {});
  const rail = res.timeline.find((s) => s.kind === 'rail');
  assert.ok(rail, 'should strike the rail');
  assert.ok(rail.balls[0].vel.z > 0.05, `rail contact should impart upward velocity, vz=${rail.balls[0].vel.z}`);
  // z genuinely leaves the bed: at least one bed-landing event follows the rail hop
  const bedsAfter = res.timeline.filter((s) => s.kind === 'bed').length;
  assert.ok(bedsAfter >= 1, `a hop must land back on the bed at least once, got ${bedsAfter}`);
  assert.ok(res.settled && !res.hitCap, 'the hop must settle in finite events');
});

// (c) A ball aimed at a POCKET GAP passes the rail plane instead of bouncing (the rail is finite;
// the gap sits inside the pocket-capture circle, so the ball is potted, not rebounded).
test('a ball aimed at a pocket gap passes the rail (potted, not bounced)', () => {
  // straight at the bottom-middle pocket (0, -HY): x=0 is the rail gap
  const cue = mk('cue', v3.vec(0, -0.2, R), v3.vec(0, -3.0, 0));
  const res = runEngine(layout([cue]), null, { contactBall: 'cue' });
  assert.ok(res.pocketed.includes('cue'), 'the ball should drop into the middle pocket, not bounce');
  assert.equal(res.cushionHits, 0, 'it must not register a rail bounce on the way in');
});

// (d) The rail geometry is chosen so a bed-height ball's centre rebounds at exactly |gap| = R —
// the flat-wall stop position. Check the cylinder radius satisfies (R + r_c)² = R² + drop².
test('cushion cylinder radius matches the wall stop position by construction', () => {
  const rails = railCylinders(R, bounds(), pockets());
  const rail = rails[0];
  const drop = R - rail.z;
  assert.ok(Math.abs((R + rail.rc) ** 2 - (R * R + drop * drop)) < 1e-15, 'r_c must satisfy the wall-match identity');
});
