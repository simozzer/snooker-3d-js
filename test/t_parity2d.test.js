// t_parity2d.test.js — MILESTONE T group 2: the 2D↔3D regression firewall. For flat-table shots
// the 3D engine must reproduce the pre-existing 2D physics: the ball-ball/bed contacts keep balls
// pinned to the bed (z=R, vz=0) — only the deliberate cushion hop breaks flatness — and the pair
// resolver agrees bit-for-bit with the retained 2D reference resolvePair. Deterministic PRNG.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as v3 from '../src/vec3.js';
import { BALL, BALL_RESTITUTION, BALL_FRICTION_T, CUSHION_RESTITUTION } from '../src/snooker.js';
import { Ball } from '../src/motion.js';
import { resolvePair, resolvePair3D } from '../src/collisions.js';
import { runEngine } from '../src/engine.js';
import { bounds, pockets, HX, HY } from '../src/table.js';

const R = BALL.radius;
const M = BALL.mass;
function rng(seed) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const span = (r, a, b) => a + (b - a) * r();
const mk = (id, pos, vel, spin) => new Ball({ id, kind: 'cue', radius: R, mass: M, pos, vel, spin });

// The flat-game invariant: on the bed, the BALL-BALL and BED physics introduce no vertical motion
// — a flat shot stays pinned at z=R with vz=0 UNTIL (and unless) a CUSHION is struck. The cushion
// cylinder (rail) and the rounded pocket JAWS (Milestone C2, 3D tori) are the deliberate vz
// sources: a firm-shot rail hop and a jaw clip both legitimately lift the ball. So we assert the
// bed-flatness only up to the first rail/jaw event. Before any cushion/jaw contact, no pair/bed
// event may lift a ball off the table — the "z term is inert for ball-ball on the bed" guarantee
// (the exact contract the follow/draw-pump bug violated). ω_x/ω_y (roll/follow/draw) is allowed.
function assertFlatUntilRail(res, label) {
  for (const s of res.timeline) {
    if (s.kind === 'rail' || s.kind === 'jaw') return; // a legitimate hop may follow either cushion contact
    for (const b of s.balls) {
      if (b.pocketed) continue;
      assert.ok(Math.abs(b.pos.z - R) < 1e-9, `${label} @${s.t} (${s.kind}) ${b.id}: z=${b.pos.z} left the bed pre-cushion`);
      assert.ok(Math.abs(b.vel.z) < 1e-9, `${label} @${s.t} (${s.kind}) ${b.id}: vz=${b.vel.z} — a flat ball-ball/bed event hopped`);
    }
  }
}

test('flat shots stay pinned to the bed through ball-ball/bed events until a cushion (36 shots)', () => {
  const r = rng(4242);
  for (let i = 0; i < 36; i++) {
    const cue = mk('cue', v3.vec(span(r, -0.9, 0.9), span(r, -0.4, 0.4), R), v3.vec(0, 0, 0), v3.vec(0, 0, 0));
    const obj = mk('obj', v3.vec(span(r, -0.9, 0.9), span(r, -0.4, 0.4), R), v3.vec(0, 0, 0), v3.vec(0, 0, 0));
    // keep them apart at the start
    if (v3.len(v3.sub(cue.pos, obj.pos)) < 3 * R) obj.pos = v3.add(obj.pos, v3.vec(0.2, 0.2, 0));
    const shot = { ballId: 'cue', angle: span(r, 0, 2 * Math.PI), speed: span(r, 1, 7), spin: { side: span(r, -0.9, 0.9), vert: span(r, -0.9, 0.9) } }; // NO elevation
    const res = runEngine({ balls: [cue, obj], bounds: bounds(), pockets: pockets() }, shot, {});
    assertFlatUntilRail(res, `shot ${i}`);
  }
});

test('resolvePair3D matches the 2D resolvePair bit-for-bit on flat contacts (50 cut/spin cases)', () => {
  const r = rng(8080);
  for (let i = 0; i < 50; i++) {
    // random flat contact: b offset from a by 2R along a horizontal direction, cue spun.
    // CRUCIALLY the cue also carries heavy FOLLOW/DRAW spin (ω_x, ω_y) — the exact input that the
    // follow/draw-pump bug turned into a spurious vertical impulse. On the bed the 3D resolver must
    // still (a) match the 2D in-plane result (2D has no ω_x/ω_y), (b) inject NO vz, (c) leave ω_x/ω_y
    // untouched (they pass through and re-express as the post-contact slide).
    const ang = span(r, 0, 2 * Math.PI);
    const n = v3.vec(Math.cos(ang), Math.sin(ang), 0);
    const posA = v3.vec(0, 0, R);
    const posB = v3.add(posA, v3.scale(n, 2 * R - 1e-5));
    const velA = v3.vec(span(r, -3, 3), span(r, -3, 3), 0);
    const spinA = v3.vec(span(r, -300, 300), span(r, -300, 300), span(r, -12, 12)); // heavy follow/draw + side
    const velB = v3.vec(span(r, -1, 1), span(r, -1, 1), 0);
    const spinB = v3.vec(span(r, -300, 300), span(r, -300, 300), span(r, -12, 12));

    const a2 = mk('a', posA, velA, spinA); const b2 = mk('b', posB, velB, spinB);
    const a3 = mk('a', posA, velA, spinA); const b3 = mk('b', posB, velB, spinB);
    resolvePair(a2, b2, BALL_RESTITUTION, BALL_FRICTION_T); // 2D reference (only sees ω_z)
    resolvePair3D(a3, b3, BALL_RESTITUTION, BALL_FRICTION_T);

    for (const [x, y, msg] of [[a2.vel, a3.vel, 'a.vel'], [b2.vel, b3.vel, 'b.vel']]) {
      assert.ok(Math.abs(x.x - y.x) < 1e-12 && Math.abs(x.y - y.y) < 1e-12, `case ${i}: ${msg} in-plane mismatch`);
    }
    assert.ok(Math.abs(a2.spin.z - a3.spin.z) < 1e-12 && Math.abs(b2.spin.z - b3.spin.z) < 1e-12, `case ${i}: ω_z mismatch`);
    // no vertical leak, and follow/draw spin passed through UNCHANGED (the pump-bug guard)
    assert.ok(Math.abs(a3.vel.z) < 1e-12 && Math.abs(b3.vel.z) < 1e-12, `case ${i}: vz injected on the bed`);
    assert.ok(Math.abs(a3.spin.x - spinA.x) < 1e-12 && Math.abs(a3.spin.y - spinA.y) < 1e-12, `case ${i}: cue follow/draw spin was altered`);
    assert.ok(Math.abs(b3.spin.x - spinB.x) < 1e-12 && Math.abs(b3.spin.y - spinB.y) < 1e-12, `case ${i}: object follow/draw spin was altered`);
  }
});

test('a straight rail-square shot matches the flat-wall perpendicular reversal within nose tolerance', () => {
  // A slow, square shot at a rail must reverse the perpendicular velocity like resolveWall, with a
  // negligible geometric hop (the documented ~3° nose tolerance).
  const r = rng(1616);
  for (let i = 0; i < 12; i++) {
    const vy = span(r, 0.6, 1.4);
    const x = span(r, 0.15, 0.9); // clear of the middle pocket at x=0
    const cyl = mk('c', v3.vec(x, HY - R - 0.05, R), v3.vec(0, vy, 0), v3.vec(0, 0, 0));
    const res = runEngine({ balls: [cyl], bounds: bounds(), pockets: pockets() }, null, { maxEvents: 1 });
    const after = res.timeline.find((s) => s.kind === 'rail').balls[0];

    // The reversed perpendicular speed must track the restitution: the ratio to the ideal −e·vy sits
    // in a stable, measured band [0.70, 1.0]. The nose tilt genuinely diverts up to ~30% of the
    // rebound into the small hop + tilt-friction (verified sweep), so the band is wide — but it is
    // bounded and one-sided (≤ 1: the cylinder can NEVER return MORE than the ideal elastic reversal,
    // which a restitution-too-high bug would violate; and a much-too-low e would drop below 0.70).
    const ratio = -after.vel.y / (CUSHION_RESTITUTION * vy);
    assert.ok(ratio > 0.70 && ratio <= 1.0 + 1e-9, `case ${i}: reversed/(-e·vy) ratio ${ratio.toFixed(4)} outside [0.70,1.0]`);
    assert.ok(after.vel.y < 0, `case ${i}: perpendicular velocity must reverse`);
    assert.ok(Math.abs(after.vel.x) < 1e-6, `case ${i}: square hit gained along-rail drift ${after.vel.x}`);
    assert.ok(after.vel.z >= 0 && after.vel.z < 0.14, `case ${i}: slow-shot hop too large ${after.vel.z}`);
    // energy diverted to the hop is bounded — it can't exceed the perpendicular rebound
    assert.ok(after.vel.z < CUSHION_RESTITUTION * vy * 0.2, `case ${i}: hop disproportionate to the rebound`);
  }
});

test('multi-ball flat break settles on the bed with no out-of-plane state', () => {
  // A small cluster struck hard — the worst case for cross-contact resolution — must stay flat.
  const balls = [mk('cue', v3.vec(-0.8, 0, R), v3.vec(0, 0, 0), v3.vec(0, 0, 0))];
  const rackR = 2 * R + 1e-4;
  let id = 0;
  for (let row = 0; row < 3; row++) {
    for (let k = 0; k <= row; k++) {
      balls.push(mk(`r${id++}`, v3.vec(0.2 + row * rackR * 0.87, (k - row / 2) * rackR, R), v3.vec(0, 0, 0), v3.vec(0, 0, 0)));
    }
  }
  const res = runEngine({ balls, bounds: bounds(), pockets: pockets() }, { ballId: 'cue', angle: 0, speed: 7, spin: { side: 0.4 } }, {});
  assertFlatUntilRail(res, "break");
  assert.ok(res.settled && !res.hitCap, 'the break must settle within the cap');
  for (const b of res.balls) {
    if (b.pocketed) continue;
    assert.ok(Math.abs(b.pos.x) <= HX - R + 2e-3 && Math.abs(b.pos.y) <= HY - R + 2e-3, `${b.id} outside table at (${b.pos.x},${b.pos.y})`);
  }
});
