// t_takeshot_elevation.test.js — takeShot must thread the cue `elevation` through to the engine.
// Regression guard: the game layer once destructured only {angle,speed,spin,cuePlacement} and dropped
// elevation, so the renderer's jump-shot slider silently did nothing. A jump shot must lift the cue
// off the bed; a flat shot must stay pinned to z=R. Sampled densely along the plan (not just at event
// snapshots) so the apex can't be missed. Deterministic: fixed layout, no jitter.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { takeShot } from '../src/game.js';
import { snooker } from '../src/variants/snooker.js';
import { buildPlanCache, replayState } from '../web/replay.js';

const R = snooker.ball.radius;

function maxCueHeight(elevation) {
  const g = {
    variant: snooker,
    frame: snooker.newFrame(),
    pieces: [
      { id: 'cue', color: 'white', group: 'cue', kind: 'cue', pos: { x: 0, y: -0.8 } },
      { id: 'r0', color: 'red', group: 'red', kind: 'red', pos: { x: 0, y: 0.9 } },
    ],
  };
  g.frame.reds = 1;
  g.frame.ballInHand = false;
  const res = takeShot(g, { angle: Math.PI / 2, speed: 4, spin: { side: 0, vert: 0 }, elevation });
  const tl = res.timeline;
  if (tl.length < 2) return R;
  const cache = buildPlanCache(tl, R);
  const endT = tl[tl.length - 1].t;
  let maxZ = 0;
  for (let k = 0; k <= 200; k++) {
    const s = replayState(tl, cache, (endT * k) / 200).get('cue');
    if (s && !s.pocketed) maxZ = Math.max(maxZ, s.pos.z);
  }
  return maxZ;
}

test('takeShot threads cue elevation — a jump shot lifts the cue off the bed', () => {
  const flat = maxCueHeight(0);
  const jump = maxCueHeight((35 * Math.PI) / 180);
  assert.ok(Math.abs(flat - R) < 1e-6, `a flat shot must stay on the bed (z=R=${R}), got ${flat}`);
  assert.ok(jump > R + 0.02, `a 35° elevation shot must leave the bed, got max cue z ${jump}`);
});
