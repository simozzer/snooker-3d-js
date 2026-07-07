// t_trick_obstacle.test.js — an OBJECT ball must bank off a laid cue-stick rail, not pass through it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tableGeom, cueRail } from '../src/trickshots.js';
import { simulate } from '../src/simulate.js';
import { Ball } from '../src/motion.js';
import * as v3 from '../src/vec3.js';
import { buildPlanCache, replayState } from '../web/replay.js';

// Fire the struck ball straight at a horizontal cue-rail (perp y=0). `fromY<0` approaches from below
// (+y), `fromY>0` from above (−y). `approachSide` is the rail's one-sided guard sign.
function bankTest(struckId, fromY, approachSide) {
  const g = tableGeom('pool');
  const rail = cueRail(g, 'x', 0, [-0.3, 0.3], approachSide);
  const mk = (id, x, y) => new Ball({ id, kind: id === 'cue' ? 'cue' : 'object', radius: g.R, mass: g.mass, pos: v3.vec(x, y, g.R), spin: v3.vec(0, 0, 0) });
  const balls = [mk('cue', 0.4, 0.4), mk('b1', 0.15, fromY)];
  const angle = fromY < 0 ? Math.PI / 2 : -Math.PI / 2; // toward y=0
  const res = simulate(
    { balls, bounds: g.bounds, pockets: g.pockets, rails: [...g.rails, rail] },
    { ballId: struckId, angle, speed: 3.0, spin: { side: 0, vert: 0 }, elevation: 0 },
    { contactBall: struckId },
  );
  const final = res.balls.find((b) => b.id === struckId);
  const railHit = res.timeline.some((e) => e.kind === 'rail' && e.hit && e.hit.id === struckId);
  // "passed through" = ended on the far side of the rail from where it started
  const passedThrough = final && Math.sign(final.pos.y) === Math.sign(-fromY) && Math.abs(final.pos.y) > 0.05;
  return { finalY: final ? final.pos.y : null, railHit, passedThrough };
}

test('object ball banks off a cue-rail approached from the guard side', () => {
  const r = bankTest('b1', -0.30, 1); // approachSide +1, from below
  assert.ok(r.railHit && !r.passedThrough, `should bank, got y=${r.finalY} hit=${r.railHit}`);
});

test('object ball banks off a cue-rail approached from the OPPOSITE side', () => {
  const r = bankTest('b1', 0.30, 1); // approachSide +1, but approached from ABOVE (the other face)
  assert.ok(r.railHit && !r.passedThrough, `must not pass through from the far side — got y=${r.finalY} hit=${r.railHit}`);
});

test('object ball banks off a cue-rail with the opposite guard sign', () => {
  const r = bankTest('b1', -0.30, -1); // approachSide -1, from below
  assert.ok(r.railHit && !r.passedThrough, `should bank, got y=${r.finalY} hit=${r.railHit}`);
});

test('the REPLAY (what is rendered) also banks the object ball — no pass-through on screen', () => {
  const g = tableGeom('pool');
  const rail = cueRail(g, 'x', 0, [-0.3, 0.3], 1);
  const mk = (id, x, y) => new Ball({ id, kind: id === 'cue' ? 'cue' : 'object', radius: g.R, mass: g.mass, pos: v3.vec(x, y, g.R), spin: v3.vec(0, 0, 0) });
  const balls = [mk('cue', 0.4, 0.4), mk('b1', 0.15, -0.30)];
  const res = simulate(
    { balls, bounds: g.bounds, pockets: g.pockets, rails: [...g.rails, rail] },
    { ballId: 'b1', angle: Math.PI / 2, speed: 3.0, spin: { side: 0, vert: 0 }, elevation: 0 },
    { contactBall: 'b1' },
  );
  const cache = buildPlanCache(res.timeline, g.R);
  const end = res.timeline[res.timeline.length - 1].t;
  // sample b1's y across the whole replay — its MAX y (closest approach to the rail at y=0) must not
  // cross the rail into positive y by more than a ball radius (i.e. it visibly banks, not passes through)
  let maxY = -Infinity;
  for (let k = 0; k <= 60; k++) {
    const st = replayState(res.timeline, cache, (k / 60) * end).get('b1');
    if (st && !st.pocketed) maxY = Math.max(maxY, st.pos.y);
  }
  assert.ok(maxY < g.R, `replayed object ball must bank at the rail, not cross it — reached y=${maxY.toFixed(4)} (R=${g.R.toFixed(4)})`);
});
