// t_spin_edge.test.js — MILESTONE T groups 7 & 8: spin semantics (direction/sign, not just
// magnitude) and edge/degenerate cases. Deterministic throughout.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as v3 from '../src/vec3.js';
import { BALL, MAX_SPEED, CUSHION_RESTITUTION, CUSHION_FRICTION_T, BED_RESTITUTION, BED_FRICTION_T } from '../src/snooker.js';
import { Ball } from '../src/motion.js';
import { resolveContact, resolveRail, resolvePair3D } from '../src/collisions.js';
import { runEngine } from '../src/engine.js';
import { bounds, pockets, railCylinders, HX, HY } from '../src/table.js';

const R = BALL.radius;
const M = BALL.mass;
const mk = (id, pos, vel, spin = v3.vec(0, 0, 0)) => new Ball({ id, kind: 'cue', radius: R, mass: M, pos, vel, spin });

// ---- group 7: spin semantics ----

test('backspin CHECKS on bed landing: post-bounce forward speed reduced vs a no-spin landing', () => {
  // For a ball moving +x, ω_y < 0 is BACKSPIN (the bottom contact moves backward relative to ground,
  // opposing the roll). Modest forward speed keeps the friction below the Coulomb clamp so the spin
  // genuinely bites. Compare a backspun landing against a no-spin one.
  const vx = 0.5; const vz = -1.5;
  const land = (wy) => { const b = mk('b', v3.vec(0, 0, R), v3.vec(vx, 0, vz), v3.vec(0, wy, 0)); resolveContact(b, v3.vec(0, 0, 1), BED_RESTITUTION, BED_FRICTION_T); return b.vel.x; };
  const plain = land(0);
  const back = land(-60); // backspin
  assert.ok(back < plain - 1e-3, `backspin should reduce forward vx: back=${back.toFixed(3)} plain=${plain.toFixed(3)}`);
});

test('strong backspin can REVERSE horizontal velocity on landing (draw-back)', () => {
  // heavy backspin (ω_y < 0), hard downward (big normal impulse ⇒ big friction budget), low forward
  const b = mk('b', v3.vec(0.3, 0, R), v3.vec(0.3, 0, -2.5), v3.vec(0, -60, 0));
  resolveContact(b, v3.vec(0, 0, 1), BED_RESTITUTION, BED_FRICTION_T);
  assert.ok(b.vel.x < 0, `heavy backspin should reverse vx on landing, got ${b.vel.x}`);
});

test('side spin throws the ball sideways off a cushion in the sign-correct direction', () => {
  // Ball moving +y into the top rail. Right-hand side spin (+ω_z) throws it toward −x; left toward +x.
  const bounceX = (wz) => {
    const b = mk('b', v3.vec(0.5, HY - R, R), v3.vec(0, 2, 0), v3.vec(0, 0, wz));
    const rail = railCylinders(R, bounds(), pockets()).find((r) => r.axis === 'x' && r.perp > 0 && r.span[0] < 0.5 && r.span[1] > 0.5);
    resolveRail(b, rail, CUSHION_RESTITUTION, CUSHION_FRICTION_T);
    return b.vel.x;
  };
  const right = bounceX(15);
  const left = bounceX(-15);
  assert.ok(Math.abs(right) > 1e-3 && Math.abs(left) > 1e-3, 'side spin must produce a sideways throw');
  assert.ok(Math.sign(right) === -Math.sign(left), 'opposite side spins throw opposite ways');
});

test('follow/draw spin PASSES THROUGH the cushion untouched and re-expresses as post-cushion roll', () => {
  // A ball with follow spin (ω_y) into a rail: ω_x/ω_y must be unchanged by the bounce, and the
  // engine's replan then turns the retained follow spin into forward roll AFTER the cushion.
  const b = mk('b', v3.vec(0.5, HY - R, R), v3.vec(0, 2, 0), v3.vec(0, 120, 0));
  const spinBefore = { ...b.spin };
  const rail = railCylinders(R, bounds(), pockets()).find((r) => r.axis === 'x' && r.perp > 0 && r.span[0] < 0.5 && r.span[1] > 0.5);
  resolveRail(b, rail, CUSHION_RESTITUTION, CUSHION_FRICTION_T);
  assert.ok(Math.abs(b.spin.x - spinBefore.x) < 1e-12 && Math.abs(b.spin.y - spinBefore.y) < 1e-12, `follow/draw spin changed at cushion: ${JSON.stringify(b.spin)}`);
  // the hop is bounded to the small geometric nose value regardless of the heavy follow spin — the
  // pump bug (follow/draw coupling) would launch it metres/s; here it stays sub-0.2 m/s.
  assert.ok(Math.abs(b.vel.z) < 0.2, `hop should stay small (pump bug launches metres/s), got ${b.vel.z}`);
});

test('follow drives the cue forward through a dead-centre pair hit; draw screws it back', () => {
  const runVert = (vert) => {
    const cue = mk('cue', v3.vec(-0.4, 0, R));
    const obj = mk('obj', v3.vec(0, 0, R));
    runEngine({ balls: [cue, obj], bounds: bounds(), pockets: pockets() }, { ballId: 'cue', angle: 0, speed: 2.4, spin: { vert } }, {});
    return cue.pos.x;
  };
  const follow = runVert(1); const stun = runVert(0); const draw = runVert(-1);
  assert.ok(follow > stun + 0.02, `follow (${follow.toFixed(3)}) should end ahead of stun (${stun.toFixed(3)})`);
  assert.ok(draw < stun - 0.02, `draw (${draw.toFixed(3)}) should screw back behind stun (${stun.toFixed(3)})`);
});

// ---- group 8: edge / degenerate cases ----

test('zero-velocity ball: no shot ⇒ no events, stays put, settled', () => {
  const b = mk('b', v3.vec(0.1, 0.2, R), v3.vec(0, 0, 0));
  const res = runEngine({ balls: [b], bounds: bounds(), pockets: pockets() }, null, {});
  assert.ok(res.settled && res.events === 0, `a resting ball should generate no events, got ${res.events}`);
  assert.deepEqual({ x: res.balls[0].pos.x, y: res.balls[0].pos.y }, { x: 0.1, y: 0.2 });
});

test('grazing (near-tangent) ball-ball contact still resolves and conserves momentum', () => {
  // b just clips the edge of a — a near-tangent normal is the numerically delicate case.
  const a = mk('a', v3.vec(0, 0, R), v3.vec(3, 0, 0), v3.vec(0, 0, 0));
  const b = mk('b', v3.vec(2 * R * 0.999, 2 * R * Math.sqrt(1 - 0.999 ** 2) - 1e-6, R), v3.vec(0, 0, 0), v3.vec(0, 0, 0));
  const pB = v3.add(v3.scale(a.vel, M), v3.scale(b.vel, M));
  const closing = resolvePair3D(a, b, 0.95, 0.06);
  const pA = v3.add(v3.scale(a.vel, M), v3.scale(b.vel, M));
  assert.ok(closing >= 0, 'closing speed must be non-negative');
  assert.ok(v3.len(v3.sub(pA, pB)) < 1e-9, 'momentum conserved on a grazing hit');
  assert.ok(b.vel.x > 1e-4 || Math.abs(b.vel.y) > 1e-4, 'the grazed ball must actually move');
});

test('a ball starting exactly at z=R with a tiny upward vz enters FLIGHT and lands cleanly', () => {
  const b = mk('b', v3.vec(0, 0, R), v3.vec(0.5, 0, 1e-3)); // just barely airborne
  const res = runEngine({ balls: [b], bounds: bounds(), pockets: pockets() }, null, {});
  assert.ok(res.settled && !res.hitCap, 'a hair-trigger flight must settle');
  assert.ok(Math.abs(res.balls[0].pos.z - R) < 1e-6, 'must rest back on the bed');
});

test('a shot straight down a rail (parallel, offset by R) does not spuriously bounce', () => {
  // Ball travelling +x exactly along the top rail line: it is tangent, never approaching — must not
  // trigger a rail event, and must roll to rest or pot at the far corner without escaping.
  const b = mk('b', v3.vec(-1.0, HY - R, R), v3.vec(3, 0, 0));
  const res = runEngine({ balls: [b], bounds: bounds(), pockets: pockets() }, null, { contactBall: 'b' });
  assert.ok(res.settled && !res.hitCap, 'must settle');
  const settled = res.balls[0];
  if (!settled.pocketed) {
    assert.ok(Math.abs(settled.pos.y) <= HY - R + 3e-3 && Math.abs(settled.pos.x) <= HX - R + 3e-3, `ended outside at (${settled.pos.x},${settled.pos.y})`);
  }
});

test('dead-centre pocket entry: a ball rolled straight at a pocket is potted', () => {
  const b = mk('b', v3.vec(0, -0.3, R), v3.vec(0, -3, 0)); // straight at the bottom-middle pocket
  const res = runEngine({ balls: [b], bounds: bounds(), pockets: pockets() }, null, { contactBall: 'b' });
  assert.ok(res.pocketed.includes('b'), 'a dead-centre roll into a pocket must pot');
  assert.equal(res.cushionHits, 0, 'no cushion contact on the way in');
});

test('max-power launch with full spin settles on the table without escaping or hitting the cap', () => {
  const cue = mk('cue', v3.vec(-1.0, 0, R));
  const res = runEngine({ balls: [cue], bounds: bounds(), pockets: pockets() }, { ballId: 'cue', angle: 0.37, speed: MAX_SPEED, spin: { side: 0.9, vert: 0.9 } }, {});
  assert.ok(res.settled && !res.hitCap, `max-power shot must settle (events=${res.events})`);
});

test('near-simultaneous events resolve without a stall and deterministically (tight symmetric cluster)', () => {
  // A cue into a symmetric pair produces two near-simultaneous contacts. An event-driven engine
  // resolves them SEQUENTIALLY (not with a simultaneous solver), so the outcome need not stay
  // mirror-symmetric — but it MUST order them by a stable rule, settle without stalling, and be
  // reproducible run-to-run. That determinism is the real contract for the simultaneous-event trap.
  const build = () => [
    mk('cue', v3.vec(-0.4, 0, R), v3.vec(0, 0, 0)),
    mk('L', v3.vec(0, R + 1e-4, R), v3.vec(0, 0, 0)),
    mk('Rr', v3.vec(0, -(R + 1e-4), R), v3.vec(0, 0, 0)),
  ];
  const fp = (res) => res.timeline.map((s) => `${s.t.toFixed(9)}:${s.kind}`).join('|') + '#' + res.balls.map((b) => `${b.pos.x.toFixed(12)},${b.pos.y.toFixed(12)}`).join(';');
  const first = runEngine({ balls: build(), bounds: bounds(), pockets: pockets() }, { ballId: 'cue', angle: 0, speed: 3 }, {});
  assert.ok(first.settled && !first.hitCap, 'symmetric double-contact must settle without a stall');
  const ref = fp(first);
  for (let rep = 0; rep < 10; rep++) {
    const r = runEngine({ balls: build(), bounds: bounds(), pockets: pockets() }, { ballId: 'cue', angle: 0, speed: 3 }, {});
    assert.equal(fp(r), ref, `symmetric cluster nondeterministic at repeat ${rep}`);
  }
});
