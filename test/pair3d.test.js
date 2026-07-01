// pair3d.test.js — Milestone B: ball-ball collisions in TRUE 3D. The pair contact normal is the
// 3D centre-to-centre unit vector; the impulse is the isotropic-sphere family (scalar I=⅖mR²)
// with equal-and-opposite updates to both balls' v and ω. Airborne balls now participate in pair
// detection, so a ball can hop onto / hit another mid-air. Deterministic (fixed inputs, no RNG).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as v3 from '../src/vec3.js';
import { BALL, BALL_RESTITUTION, BALL_FRICTION_T } from '../src/snooker.js';
import { Ball } from '../src/motion.js';
import { resolvePair, resolvePair3D } from '../src/collisions.js';
import { runEngine } from '../src/engine.js';
import { bounds, pockets } from '../src/table.js';

const R = BALL.radius;
const M = BALL.mass;
const mk = (id, pos, vel = v3.vec(0, 0, 0), spin = { x: 0, y: 0, z: 0 }) =>
  new Ball({ id, kind: 'cue', radius: R, mass: M, pos, vel, spin });

// (b) REGRESSION: a flat-table ball-ball hit through the 3D resolver must match the 2D resolver
// bit-for-bit (the z term must be inert when both balls sit on the bed). Covers a spun cut shot.
test('flat ball-ball hit: 3D resolver equals the 2D resolver (z term inert on the bed)', () => {
  // offset (cut) contact on the bed, cue carrying right-hand side spin
  const posA = v3.vec(0, 0, R);
  const posB = v3.vec(2 * R * 0.9, 2 * R * Math.sqrt(1 - 0.81) - 1e-4, R); // ~touching, off-axis
  const velA = v3.vec(2.4, 0.3, 0);
  const spinA = { x: 0, y: 0, z: 7 };

  const a2 = mk('a', posA, velA, spinA);
  const b2 = mk('b', posB);
  resolvePair(a2, b2, BALL_RESTITUTION, BALL_FRICTION_T);

  const a3 = mk('a', posA, velA, spinA);
  const b3 = mk('b', posB);
  resolvePair3D(a3, b3, BALL_RESTITUTION, BALL_FRICTION_T);

  const near = (x, y) => Math.abs(x - y) < 1e-12;
  assert.ok(near(a2.vel.x, a3.vel.x) && near(a2.vel.y, a3.vel.y), `a.vel 2D=${JSON.stringify(a2.vel)} 3D=${JSON.stringify(a3.vel)}`);
  assert.ok(near(b2.vel.x, b3.vel.x) && near(b2.vel.y, b3.vel.y), `b.vel 2D=${JSON.stringify(b2.vel)} 3D=${JSON.stringify(b3.vel)}`);
  assert.ok(near(a2.spin.z, a3.spin.z) && near(b2.spin.z, b3.spin.z), 'ω_z must match');
  // no vertical velocity or horizontal-axis spin may appear on the flat table
  assert.ok(Math.abs(a3.vel.z) < 1e-12 && Math.abs(b3.vel.z) < 1e-12, 'no vz on the bed');
  assert.ok(Math.abs(a3.spin.x) < 1e-12 && Math.abs(a3.spin.y) < 1e-12, 'no ω_x/ω_y on the bed');
});

// (a) ON-TOP DEFLECTION: a ball launched into flight comes DOWN onto a resting ball. The 3D normal
// has a z component, so the descending striker hits from ABOVE — the target is driven forward (and
// pressed into the bed, vz<0), and the striker is deflected out of a clean vertical fall.
test('a ball landing on top of a resting ball is deflected (3D normal has a z component)', () => {
  const target = mk('tgt', v3.vec(0.5, 0, R));
  const cue = mk('cue', v3.vec(0.2, 0, R));
  // launch up+forward so the cue descends onto the target: vx≈1.13, vz≈1.30
  const res = runEngine(
    { balls: [cue, target], bounds: bounds(), pockets: pockets() },
    { ballId: 'cue', angle: 0, speed: Math.hypot(1.13, 1.3), spin: {}, elevation: Math.atan2(1.3, 1.13) },
    { contactBall: 'cue' },
  );

  const pair = res.timeline.find((s) => s.kind === 'pair');
  assert.ok(pair, 'a mid-air pair contact should occur');
  const cAt = pair.balls.find((b) => b.id === 'cue');
  const tAt = pair.balls.find((b) => b.id === 'tgt');
  // contact happened with the cue ABOVE the target — the defining "on top" condition
  assert.ok(cAt.pos.z > R + 1e-3, `cue should be above the bed at contact, z=${cAt.pos.z}`);
  // the 3D normal's z component drove the target DOWNWARD (into the bed) — impossible in 2D
  assert.ok(tAt.vel.z < -1e-2, `target should be driven downward, vz=${tAt.vel.z}`);
  // and forward — it's genuinely deflected, not merely pressed down
  assert.ok(tAt.vel.x > 1e-2, `target should be deflected forward, vx=${tAt.vel.x}`);
  const end = res.balls.find((b) => b.id === 'tgt');
  assert.ok(end.pos.x > 0.5 + 1e-2, `target should end up moved forward, x=${end.pos.x}`);
  assert.ok(res.settled && !res.hitCap, 'the whole rally must settle in finite events');
});

// (c) CONSERVATION on a MID-AIR pair contact (frictionless, e=1): linear momentum is conserved
// exactly and kinetic energy is conserved (elastic) — a direct sanity check on the 3D impulse.
test('mid-air pair contact conserves momentum and (at e=1, μ=0) kinetic energy', () => {
  // two balls meeting in the air, moving toward each other along a 3D line (not axis-aligned)
  const a = mk('a', v3.vec(0, 0, 0.30), v3.vec(1.2, 0.4, -0.6));
  // place b so the centre-to-centre gap is exactly 2R along a slanted direction
  const dir = v3.normalize(v3.vec(0.8, 0.2, 0.55));
  const b = mk('b', v3.add(a.pos, v3.scale(dir, 2 * R)), v3.vec(-0.9, 0.1, 0.5));

  const pBefore = v3.add(v3.scale(a.vel, M), v3.scale(b.vel, M));
  const keBefore = 0.5 * M * v3.len2(a.vel) + 0.5 * M * v3.len2(b.vel);

  resolvePair3D(a, b, 1.0, 0); // perfectly elastic, frictionless

  const pAfter = v3.add(v3.scale(a.vel, M), v3.scale(b.vel, M));
  const keAfter = 0.5 * M * v3.len2(a.vel) + 0.5 * M * v3.len2(b.vel);

  assert.ok(v3.len(v3.sub(pAfter, pBefore)) < 1e-12, `momentum drift ${v3.len(v3.sub(pAfter, pBefore))}`);
  assert.ok(Math.abs(keAfter - keBefore) < 1e-12, `KE drift ${Math.abs(keAfter - keBefore)}`);
  // they must actually have interacted (were approaching, so velocities changed)
  assert.ok(v3.len(v3.sub(a.vel, v3.vec(1.2, 0.4, -0.6))) > 1e-3, 'a should have been deflected');
});

// Restitution scaling on a head-on mid-air hit: at e<1 the balls lose closing speed by exactly e.
test('mid-air head-on: closing speed scales by the restitution e', () => {
  const e = 0.6;
  const a = mk('a', v3.vec(0, 0, 0.30), v3.vec(1.0, 0, 0));
  const b = mk('b', v3.vec(2 * R, 0, 0.30), v3.vec(-1.0, 0, 0));
  const n = v3.normalize(v3.sub(a.pos, b.pos));
  const closeBefore = -v3.dot(v3.sub(a.vel, b.vel), n);
  resolvePair3D(a, b, e, 0);
  const closeAfter = v3.dot(v3.sub(a.vel, b.vel), n); // now separating ⇒ positive along n
  assert.ok(Math.abs(closeAfter - e * closeBefore) < 1e-12, `separation ${closeAfter} expected ${e * closeBefore}`);
});
