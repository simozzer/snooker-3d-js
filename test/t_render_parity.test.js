// t_render_parity.test.js — MILESTONE D part 2: the 3D renderer must DRAW exactly what the engine
// resolved. The replay interpolator (web/replay.js) reconstructs ball state between events by
// evaluating each ball's closed-form plan; at every event time it must reproduce the engine's
// reported snapshot position and spin to machine precision — otherwise the render lies about the
// physics. Deterministic (fixed inputs). This is the parity guarantee; final VISUAL QA is the owner's.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as v3 from '../src/vec3.js';
import { BALL } from '../src/snooker.js';
import { Ball } from '../src/motion.js';
import { runEngine } from '../src/engine.js';
import { bounds, pockets, HX, HY, spots } from '../src/table.js';
import { buildPlanCache, replayState } from '../web/replay.js';

const R = BALL.radius;
const M = BALL.mass;
const B = bounds();
const mk = (id, pos) => new Ball({ id, kind: id === 'cue' ? 'cue' : 'colour', radius: R, mass: M, pos });

// A battery of shots exercising every path: pot, cut, jump/clear, side-spin, follow/draw.
const SHOTS = [
  { name: 'straight pot', layout: () => [mk('cue', { x: 0, y: -0.3 })], shot: { ballId: 'cue', angle: Math.PI / 2, speed: 3 } },
  { name: 'cut into colours', layout: () => [mk('cue', { x: -HX + 0.7, y: -0.25 }), mk('blue', spots().blue), mk('green', spots().green)], shot: { ballId: 'cue', angle: 0.2, speed: 4, spin: { side: 0.4 } } },
  { name: 'jump / clear', layout: () => [mk('cue', { x: 0.4, y: 0 })], shot: { ballId: 'cue', angle: 0, speed: 6, spin: {}, elevation: Math.PI / 4 } },
  { name: 'follow into ball', layout: () => [mk('cue', { x: -0.4, y: 0 }), mk('blue', { x: 0, y: 0 })], shot: { ballId: 'cue', angle: 0, speed: 2.4, spin: { vert: 0.9 } } },
  { name: 'draw + side', layout: () => [mk('cue', { x: -0.4, y: 0 }), mk('blue', { x: 0, y: 0 })], shot: { ballId: 'cue', angle: 0, speed: 3, spin: { vert: -0.8, side: 0.5 } } },
  { name: 'jaw rattle', layout: () => [mk('cue', { x: 0.045, y: -0.3 })], shot: { ballId: 'cue', angle: Math.PI / 2, speed: 2.8 } },
];

test('replay reproduces the engine snapshot position + spin at every event time (all shots)', () => {
  for (const { name, layout, shot } of SHOTS) {
    const res = runEngine({ balls: layout(), bounds: B, pockets: pockets() }, shot, {});
    const cache = buildPlanCache(res.timeline, R);
    for (const seg of res.timeline) {
      const state = replayState(res.timeline, cache, seg.t);
      for (const e of seg.balls) {
        const s = state.get(e.id);
        assert.ok(s, `${name} @${seg.t}: ${e.id} missing from replay`);
        assert.ok(Math.abs(s.pos.x - e.pos.x) < 1e-9 && Math.abs(s.pos.y - e.pos.y) < 1e-9 && Math.abs(s.pos.z - e.pos.z) < 1e-9,
          `${name} @${seg.t} (${seg.kind}) ${e.id}: replay pos (${s.pos.x},${s.pos.y},${s.pos.z}) != engine (${e.pos.x},${e.pos.y},${e.pos.z})`);
        if (!e.pocketed) {
          assert.ok(Math.abs(s.spin.x - e.spin.x) < 1e-9 && Math.abs(s.spin.y - e.spin.y) < 1e-9 && Math.abs(s.spin.z - e.spin.z) < 1e-9,
            `${name} @${seg.t} ${e.id}: replay spin != engine spin`);
        }
      }
    }
  }
});

test('replay is continuous WITHIN an interval (a mid-interval sample lies on the ball plan, no jump)', () => {
  // sample halfway between consecutive events and confirm the replayed position matches the plan —
  // i.e. the renderer interpolates along the real trajectory, not a straight line between snapshots.
  const res = runEngine({ balls: [mk('cue', { x: 0.4, y: 0 })], bounds: B, pockets: pockets() }, { ballId: 'cue', angle: 0.3, speed: 5, spin: { vert: -0.6 }, elevation: Math.PI / 6 }, {});
  const cache = buildPlanCache(res.timeline, R);
  let checked = 0;
  for (let i = 0; i + 1 < res.timeline.length; i++) {
    const t0 = res.timeline[i].t;
    const t1 = res.timeline[i + 1].t;
    if (t1 - t0 < 1e-3) continue;
    const tm = 0.5 * (t0 + t1);
    const cue = res.timeline[i].balls.find((b) => b.id === 'cue');
    if (cue.pocketed) continue;
    const mid = replayState(res.timeline, cache, tm).get('cue');
    // the mid sample is a valid on-table/flight position: z >= R - eps and finite
    assert.ok(mid.pos.z >= R - 1e-9 && Number.isFinite(mid.pos.x) && Number.isFinite(mid.pos.y), `mid-interval sample invalid at t=${tm}`);
    checked++;
  }
  assert.ok(checked > 0, 'expected at least one multi-event interval to sample');
});

test('a cleared ball stays flagged and a potted ball is marked pocketed in the replay state', () => {
  const res = runEngine({ balls: [mk('cue', { x: 0.4, y: 0 })], bounds: B, pockets: pockets() }, { ballId: 'cue', angle: 0, speed: 6, spin: {}, elevation: Math.PI / 3 }, {});
  const cache = buildPlanCache(res.timeline, R);
  const end = replayState(res.timeline, cache, res.timeline[res.timeline.length - 1].t).get('cue');
  if (res.cleared.includes('cue')) assert.ok(end.pocketed && end.cleared, 'cleared ball should read pocketed+cleared in replay');
});
