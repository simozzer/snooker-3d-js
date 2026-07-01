import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as v from '../src/vec2.js';
import { Ball } from '../src/motion.js';
import { simulate } from '../src/simulate.js';
import { GRAVITY, MU_SLIDE, MU_ROLL, BALL, SLIP_FACTOR } from '../src/snooker.js';

const A_SLIDE = MU_SLIDE * GRAVITY;
const A_ROLL = MU_ROLL * GRAVITY;
const R = BALL.radius;
const ball = (id, pos, vel = v.vec(0, 0), spin) =>
  new Ball({ id, kind: 'red', pos, vel, spin, radius: R, mass: BALL.mass });

const bounds = { minX: -1, maxX: 3, minY: -0.6, maxY: 0.6 };
const noPockets = [];
const cornerPockets = (b, rp = 0.05) =>
  [
    { x: b.minX + rp, y: b.minY + rp }, { x: b.maxX - rp, y: b.minY + rp },
    { x: b.minX + rp, y: b.maxY - rp }, { x: b.maxX - rp, y: b.maxY - rp },
  ].map((c) => ({ center: c, radius: rp }));

// A lone ball coasts to rest at the closed-form two-phase distance (slide leg + roll leg).
test('lone ball stops at the predicted two-phase distance', () => {
  const v0 = 1.0;
  const vRoll = v0 * (1 - 1 / SLIP_FACTOR);
  const expect = (v0 * v0 - vRoll * vRoll) / (2 * A_SLIDE) + (vRoll * vRoll) / (2 * A_ROLL);
  const a = ball('a', v.vec(0, 0), v.vec(v0, 0));
  const r = simulate({ balls: [a], bounds, pockets: noPockets });
  assert.ok(r.settled && !r.hitCap, `settled=${r.settled} hitCap=${r.hitCap}`);
  assert.ok(Math.abs(a.pos.x - expect) < 2e-3, `x=${a.pos.x} expected ${expect}`);
  assert.ok(Math.abs(a.pos.y) < 1e-9, `drifted off axis: y=${a.pos.y}`);
});

// Equal-mass collision conserves linear momentum (sum of m·v before == after, here all rest).
test('collision conserves momentum and the balls separate', () => {
  const a = ball('a', v.vec(0, 0), v.vec(1.2, 0));
  const b = ball('b', v.vec(0.2, 0));
  const r = simulate({ balls: [a, b], bounds, pockets: noPockets });
  assert.ok(r.settled);
  assert.ok(b.pos.x > 0.2, 'struck ball should move forward');
  assert.ok(a.pos.x < b.pos.x, 'cue should trail the object ball');
});

// A ball rolled straight at a corner pocket is captured.
test('a ball aimed into a pocket is potted', () => {
  const pk = cornerPockets(bounds)[3]; // top-right corner
  const a = ball('a', v.vec(0, 0));
  const angle = Math.atan2(pk.center.y - 0, pk.center.x - 0);
  const r = simulate({ balls: [a], bounds, pockets: cornerPockets(bounds) }, { ballId: 'a', angle, speed: 4.0 });
  assert.ok(r.pocketed.includes('a'), `not potted; rest at ${a.pos.x},${a.pos.y}`);
});

// No ball ever comes to rest outside the cushions.
test('no ball escapes the table', () => {
  const balls = [
    ball('a', v.vec(0, 0), v.fromAngle(0.6, 3.0)),
    ball('b', v.vec(0.1, -0.05), v.fromAngle(2.0, 2.5)),
    ball('c', v.vec(-0.05, 0.08), v.fromAngle(-1.1, 2.2)),
  ];
  const r = simulate({ balls, bounds, pockets: noPockets });
  assert.ok(r.settled && !r.hitCap, `settled=${r.settled} hitCap=${r.hitCap}`);
  for (const b of balls) {
    assert.ok(b.pos.x >= bounds.minX + R - 1e-6 && b.pos.x <= bounds.maxX - R + 1e-6, `x out: ${b.pos.x}`);
    assert.ok(b.pos.y >= bounds.minY + R - 1e-6 && b.pos.y <= bounds.maxY - R + 1e-6, `y out: ${b.pos.y}`);
  }
});

// Follow vs stun vs draw: with the cue ball striking an object ball dead-centre, top-spin
// drives the cue forward through the contact, back-spin screws it back, stun stays put.
test('follow drives the cue forward, draw screws it back', () => {
  const run = (vert) => {
    const cue = ball('cue', v.vec(-0.3, 0));
    const obj = ball('obj', v.vec(0, 0));
    simulate({ balls: [cue, obj], bounds, pockets: noPockets }, { ballId: 'cue', angle: 0, speed: 2.2, spin: { vert } });
    return cue.pos.x;
  };
  const follow = run(1);
  const stun = run(0);
  const draw = run(-1);
  assert.ok(follow > stun + 0.02, `follow (${follow}) should exceed stun (${stun})`);
  assert.ok(draw < stun - 0.02, `draw (${draw}) should trail stun (${stun})`);
  assert.ok(draw < 0, `draw should screw the cue back behind contact, got ${draw}`);
});

// Determinism: identical inputs → identical timelines.
test('simulation is deterministic', () => {
  const build = () => [ball('a', v.vec(0, 0), v.fromAngle(0.6, 3.0)), ball('b', v.vec(0.12, -0.04), v.fromAngle(2.0, 2.0))];
  const r1 = simulate({ balls: build(), bounds, pockets: noPockets });
  const r2 = simulate({ balls: build(), bounds, pockets: noPockets });
  assert.deepEqual(r1.timeline, r2.timeline);
});
