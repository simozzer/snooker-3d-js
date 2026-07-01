// motion3d.test.js — TRUE 3D dynamics (Milestone A): FLIGHT phase, ball-vs-bed quadratic event,
// generic 3D floor-bounce contact, multi-bounce settling, and an analytic JUMP SHOT.
// Deterministic (fixed inputs, no RNG). Everything resolves through closed-form events — no
// fixed-timestep integration anywhere.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as v3 from '../src/vec3.js';
import { GRAVITY, BALL } from '../src/snooker.js';
import { Ball, PHASE, twoPhasePlan, posAt, velAt, spinAt } from '../src/motion.js';
import { detectBed } from '../src/events.js';
import { resolveContact } from '../src/collisions.js';
import { runEngine } from '../src/engine.js';
import { bounds, pockets } from '../src/table.js';

const R = BALL.radius;
const g = GRAVITY;
const mk = (over = {}) => new Ball({ id: 'cue', kind: 'cue', radius: R, mass: BALL.mass, pos: v3.vec(0, 0, R), ...over });

// vec3 is a mechanical lift of vec2 plus cross — spot-check the new op.
test('vec3.cross follows the right-hand rule', () => {
  const c = v3.cross(v3.vec(1, 0, 0), v3.vec(0, 1, 0));
  assert.deepEqual(c, { x: 0, y: 0, z: 1 });
});

// (a) FLIGHT apex — closed-form parabola. Launch straight up at vz0 from the bed: the plan is a
// FLIGHT plan, apex at t = vz0/g and height R + vz0²/(2g).
test('flight apex time and height match the closed-form parabola', () => {
  const vz0 = 1.2;
  const plan = twoPhasePlan(v3.vec(0, 0, R), v3.vec(0, 0, vz0), { x: 0, y: 0, z: 0 }, R);
  assert.equal(plan.phase, PHASE.FLIGHT);
  const tApex = vz0 / g;
  const hApex = R + (vz0 * vz0) / (2 * g);
  assert.ok(Math.abs(velAt(plan, tApex).z) < 1e-9, `vz at apex ${velAt(plan, tApex).z}`);
  assert.ok(Math.abs(posAt(plan, tApex).z - hApex) < 1e-9, `apex z=${posAt(plan, tApex).z} expected ${hApex}`);
});

// (b) Ball-vs-bed contact time = the quadratic root (return to z=R). Launch up+forward; the bed
// event must land at 2·vz0/g and the ball must have travelled vx·t horizontally by then.
test('floor-contact time matches the ball-vs-bed quadratic root', () => {
  const vx = 0.8;
  const vz0 = 1.0;
  const b = mk({ vel: v3.vec(vx, 0, vz0) });
  const tLand = (2 * vz0) / g;
  const ev = detectBed(b, 0);
  assert.ok(ev, 'a bed event should be detected for an airborne ball');
  assert.ok(Math.abs(ev.time - tLand) < 1e-8, `bed time=${ev.time} expected ${tLand}`);
  const p = posAt(b.plan, ev.time);
  assert.ok(Math.abs(p.z - R) < 1e-8, `z at landing=${p.z}`);
  assert.ok(Math.abs(p.x - vx * tLand) < 1e-8, `x at landing=${p.x} expected ${vx * tLand}`);
});

// Spin is FROZEN in flight (no torque on a sphere in vacuum).
test('spin is frozen through the flight phase', () => {
  const spin = { x: 3, y: -2, z: 5 };
  const plan = twoPhasePlan(v3.vec(0, 0, R), v3.vec(0.5, 0, 1.0), spin, R);
  assert.deepEqual(spinAt(plan, 0.05), spin);
  assert.deepEqual(spinAt(plan, 0.15), spin);
});

// (c) Damped multi-bounce SETTLES in finite events. A jumped ball must bounce a few times and
// come to rest (below the velocity rest threshold) — the event loop settles it, no special case.
test('a jumped ball undergoes a damped multi-bounce and settles in finite events', () => {
  const cue = mk({ vel: v3.vec(0.6, 0, 1.4) });
  const res = runEngine(
    { balls: [cue], bounds: bounds(), pockets: pockets() },
    null,
    { contactBall: 'cue' },
  );
  assert.ok(res.settled, 'sim should settle');
  assert.ok(!res.hitCap, 'must settle well within the safety cap (finite events)');
  const bedHits = res.timeline.filter((s) => s.kind === 'bed').length;
  assert.ok(bedHits >= 2, `expected a multi-bounce (>=2 bed hits), got ${bedHits}`);
  const end = res.balls[0];
  assert.ok(v3.len(end.vel) < 1e-2, `final speed ${v3.len(end.vel)} should be ~0`);
  assert.ok(Math.abs(end.pos.z - R) < 1e-6, `final z=${end.pos.z} should rest at R`);
});

// (d) Backspin checks on landing: the generic floor-contact friction converts spin→velocity, so a
// backspun launch has LESS forward (even reversed) horizontal velocity after the first bounce than
// an identical no-spin launch.
test('backspin checks on landing (post-bounce horizontal velocity reduced vs no-spin)', () => {
  const vx = 1.0;
  const vz0 = 1.2;
  // ω about +y with a forward-moving ball is TOPSPIN; −y is BACKSPIN. Use strong backspin.
  const backspin = { x: 0, y: -80, z: 0 };

  const landAndBounce = (spin) => {
    const b = mk({ vel: v3.vec(vx, 0, vz0), spin });
    const ev = detectBed(b, 0);
    b.pos = posAt(b.plan, ev.time);
    b.vel = velAt(b.plan, ev.time);
    b.spin = spinAt(b.plan, ev.time);
    b.pos.z = R;
    resolveContact(b, { x: 0, y: 0, z: 1 }, 0.5, 0.2);
    return b.vel.x;
  };

  const plainVx = landAndBounce({ x: 0, y: 0, z: 0 });
  const backVx = landAndBounce(backspin);
  assert.ok(backVx < plainVx - 1e-6, `backspin should reduce forward vx: back=${backVx} plain=${plainVx}`);
});

// (7) JUMP SHOT resolves analytically END-TO-END through the event loop. A downward cue strike
// (elevation > 0) produces an upward reaction → FLIGHT → land → resolve, entirely via closed-form
// events (no fixed-timestep loop exists in the engine). Assert it left the bed and settled back.
test('jump shot: downward cue strike → flight → land → settle, all analytic events', () => {
  const cue = mk();
  const res = runEngine(
    { balls: [cue], bounds: bounds(), pockets: pockets() },
    { ballId: 'cue', angle: 0, speed: 3.0, spin: {}, elevation: Math.PI / 6 }, // 30° cue elevation
    { contactBall: 'cue' },
  );
  // it genuinely left the bed: the launch snapshot carries an upward vz and FLIGHT phase, so the
  // ball reaches an analytic apex R + vz0²/(2g) above the bed before the first landing.
  const launch = res.timeline[0].balls[0];
  assert.equal(launch.phase, PHASE.FLIGHT, 'cue should launch into FLIGHT');
  assert.ok(launch.vel.z > 1e-3, `launch vz=${launch.vel.z} should be upward`);
  const apex = R + (launch.vel.z * launch.vel.z) / (2 * g);
  assert.ok(apex > R + 1e-3, `jump shot never left the bed (apex=${apex})`);
  // resolved through at least one bed event and settled in finite events
  const bedHits = res.timeline.filter((s) => s.kind === 'bed').length;
  assert.ok(bedHits >= 1, `expected at least one bed landing, got ${bedHits}`);
  assert.ok(res.settled && !res.hitCap, 'jump shot must settle in finite closed-form events');
  const end = res.balls[0];
  assert.ok(Math.abs(end.pos.z - R) < 1e-6, `cue should rest on the bed, z=${end.pos.z}`);
  assert.ok(end.pos.x > 0, 'cue should have travelled forward down the table');
});

// strike() maps cue elevation to an upward launch: vz = speed·sin(elevation), horizontal scaled by cos.
test('strike elevation maps to an upward launch velocity', () => {
  const cue = mk();
  const el = Math.PI / 6;
  const speed = 2.0;
  // drive strike via the engine's shot path with a 0-event cap so we read the launch state.
  runEngine({ balls: [cue], bounds: bounds(), pockets: pockets() }, { ballId: 'cue', angle: 0, speed, spin: {}, elevation: el }, { maxEvents: 0 });
  assert.ok(Math.abs(cue.vel.z - speed * Math.sin(el)) < 1e-9, `vz=${cue.vel.z}`);
  assert.ok(Math.abs(cue.vel.x - speed * Math.cos(el)) < 1e-9, `vx=${cue.vel.x}`);
  assert.equal(cue.phase, PHASE.FLIGHT);
});
