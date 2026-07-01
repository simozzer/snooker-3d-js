// validation.test.js — PHYSICS VALIDATION against the named, measurable cue-sports results.
//
// These aren't unit tests of the code — they assert the ENGINE reproduces real-table physics that
// any player or physicist can check, so the "physically accurate" claim is defensible. Each test
// fires a canonical shot on an open table (no cushions/pockets) and measures the post-collision
// settled roll directions (plan.vRoll — the straight rolling leg each ball ends up on).
//
// References (the standard cue-physics canon):
//   • 90° rule — a STUN cue ball (sliding, ~no spin at impact) leaves the object ball at ~90°.
//   • 30° rule — a ROLLING cue ball into a ~half-ball (medium) cut deflects ~30° from its line.
//   • Cut-induced throw — friction at contact "throws" the object a few degrees off the ghost line.
// See Coriolis (1835) and Dr. Dave Alciatore's empirical billiard-physics work.
//
// Tolerances reflect the engine's MEASURED accuracy (see scratchpad probe), chosen to bracket
// current behaviour and catch regressions — not to claim perfection. Current engine: reproduces
// the 90° rule to within ~8°, the 30° rule to within ~5° at full roll, with ~3° of cut throw.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBalls } from '../src/game.js';
import { simulate } from '../src/simulate.js';
import { BALL } from '../src/snooker.js';

const R = BALL.radius;
const OPEN = { minX: -100, maxX: 100, minY: -100, maxY: 100 }; // no cushions in reach
const deg = (r) => (r * 180) / Math.PI;
const dirOf = (vec) => Math.atan2(vec.y, vec.x);
// smallest angle (deg) between two directions given as radians
const sep = (a, b) => { let d = Math.abs(deg(a) - deg(b)); return d > 180 ? 360 - d : d; };

// Cue at origin travelling +x; object ball offset by impact parameter b at distance d.
// b is the perpendicular miss distance of the centres → cut angle θ with sin θ = b/2R.
// Returns the settled roll directions (radians) of cue and object, and whether contact happened.
function fire({ d, b, speed, vert = 0 }) {
  const pieces = [
    { id: 'cue', kind: 'cue', color: 'cue', pos: { x: 0, y: 0 } },
    { id: 'obj', kind: 'red', color: 'red', pos: { x: d, y: b } },
  ];
  const balls = buildBalls(pieces, BALL);
  const res = simulate({ balls, bounds: OPEN, pockets: [] }, { ballId: 'cue', angle: 0, speed, spin: { side: 0, vert } }, { timeline: false, contactBall: 'cue' });
  const cue = res.balls.find((x) => x.id === 'cue');
  const obj = res.balls.find((x) => x.id === 'obj');
  return { cueDir: dirOf(cue.plan.vRoll), objDir: dirOf(obj.plan.vRoll), hit: res.firstContact === 'obj' };
}

test('90° rule: a stun shot leaves the object ball near a right angle', () => {
  // Object very close + fast → the cue is still SLIDING with ~no developed spin at impact (a stun).
  for (const b of [0.5 * R, R, 1.5 * R]) {
    const s = fire({ d: 0.05, b, speed: 4.0 });
    assert.ok(s.hit, 'the cue must actually strike the object');
    const angle = sep(s.cueDir, s.objDir);
    assert.ok(Math.abs(angle - 90) <= 12, `stun separation ${angle.toFixed(1)}° should be ~90° (cut ${deg(Math.asin(b / (2 * R))).toFixed(0)}°)`);
  }
});

test('30° rule: a rolling cue ball deflects ~30° on a half-ball cut', () => {
  // Long approach (vert=0) → the cue reaches natural roll before impact.
  const s = fire({ d: 1.2, b: R, speed: 3.0 });
  assert.ok(s.hit);
  const deflect = sep(s.cueDir, 0); // angle off the original +x line
  assert.ok(Math.abs(deflect - 30) <= 8, `rolling-cue deflection ${deflect.toFixed(1)}° should be ~30°`);
});

test('slide→roll trend: deflection falls toward 30° the more the cue rolls before impact', () => {
  // The two-phase model: a sliding (stun-like) cue carries ~90°; as it rolls it settles toward 30°.
  const near = sep(fire({ d: 0.4, b: R, speed: 3.0 }).cueDir, 0);
  const far = sep(fire({ d: 1.2, b: R, speed: 3.0 }).cueDir, 0);
  assert.ok(near > far, `more slide → larger deflection (near ${near.toFixed(1)}° should exceed far ${far.toFixed(1)}°)`);
  assert.ok(far >= 25 && far < near, `full-roll deflection ${far.toFixed(1)}° should be in the 30°-rule band`);
});

test('cut-induced throw: the object ball is thrown a few degrees off the ghost-ball line', () => {
  // Geometric ghost-ball line for a half-ball cut is asin(b/2R) = 30°. Friction throws the object
  // UNDER that (reducing the effective cut). A rolling cue isolates the effect cleanly.
  const geom = deg(Math.asin(R / (2 * R))); // 30°
  const s = fire({ d: 1.2, b: R, speed: 3.0 });
  const objAngle = deg(s.objDir);
  const throwDeg = geom - objAngle; // positive = thrown toward the cue's line (the real direction)
  assert.ok(throwDeg > 0.3, `expected measurable throw, got ${throwDeg.toFixed(2)}°`);
  assert.ok(throwDeg < 8, `throw ${throwDeg.toFixed(2)}° should be within the realistic few-degree band`);
});
