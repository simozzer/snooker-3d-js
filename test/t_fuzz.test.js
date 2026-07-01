// t_fuzz.test.js — MILESTONE T groups 3 & 4: no-tunnel/no-escape fuzz + termination / no-Zeno.
// A fixed-seed grid of launches (angle × speed × spin × elevation) — every ball must always be a
// valid physical state (on/above bed inside the cushion box, potted, or settled) and every legal
// shot must settle in a bounded event count. Deterministic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as v3 from '../src/vec3.js';
import { BALL, MAX_SPEED } from '../src/snooker.js';
import { Ball, twoPhasePlan, posAt } from '../src/motion.js';
import { runEngine } from '../src/engine.js';
import { bounds, pockets, HX, HY } from '../src/table.js';

const R = BALL.radius;
const M = BALL.mass;
const B = bounds();
const mk = (id, pos) => new Ball({ id, kind: 'cue', radius: R, mass: M, pos, vel: v3.vec(0, 0, 0), spin: v3.vec(0, 0, 0) });

function finite(p) {
  return Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
}

// A ball may exceed the cushion box ONLY inside a pocket's capture circle (it is being potted —
// crossing the rail line into the pocket mouth is legitimate, not a tunnel).
const P = pockets();
function inBoundsOrPocket(p) {
  if (Math.abs(p.x) <= HX - R + 3e-3 && Math.abs(p.y) <= HY - R + 3e-3) return true;
  return P.some((pk) => Math.hypot(p.x - pk.center.x, p.y - pk.center.y) <= pk.radius + R);
}

// A single-ball launch grid: assert the ball never goes out of bounds / below bed / NaN, at every
// event AND densely between events (re-planning from each snapshot and sampling the arc).
test('single-ball launch grid: never escapes, never below bed, never NaN (angle×speed×spin×elev)', () => {
  const angles = 8, speeds = [1.5, 3.5, 5.5, MAX_SPEED];
  let checked = 0;
  for (let ai = 0; ai < angles; ai++) {
    const angle = (2 * Math.PI * ai) / angles;
    for (const speed of speeds) {
      for (const side of [-0.8, 0, 0.8]) {
        for (const vert of [-0.8, 0, 0.8]) {
          for (const elevation of [0, Math.PI / 8, Math.PI / 5]) {
            const cue = mk('cue', v3.vec(0, 0, R));
            const res = runEngine({ balls: [cue], bounds: B, pockets: pockets() }, { ballId: 'cue', angle, speed, spin: { side, vert }, elevation }, {});
            assert.ok(res.settled && !res.hitCap, `settle failed (a=${angle.toFixed(2)} s=${speed} side=${side} vert=${vert} el=${elevation.toFixed(2)}) events=${res.events}`);
            // Milestone C2: a ball that legitimately LEAPS the cushion is `cleared` (out of play) —
            // its arc does exit the box, so escape-checking excludes cleared balls (that outcome IS
            // leaving the table). Everything else must stay inside / potted / on-bed as before.
            const cleared = new Set(res.cleared);
            for (let si = 0; si < res.timeline.length - 1; si++) {
              const seg = res.timeline[si];
              const dt = res.timeline[si + 1].t - seg.t;
              for (const b of seg.balls) {
                if (b.pocketed || cleared.has(b.id)) continue;
                const plan = twoPhasePlan(b.pos, b.vel, b.spin, R);
                for (let k = 0; k <= 6; k++) {
                  const p = posAt(plan, (dt * k) / 6);
                  assert.ok(finite(p), `NaN/Inf position`);
                  assert.ok(p.z >= R - 1e-6, `below bed: z=${p.z}`);
                  assert.ok(inBoundsOrPocket(p), `escaped to (${p.x.toFixed(3)},${p.y.toFixed(3)})`);
                }
              }
            }
            checked++;
          }
        }
      }
    }
  }
  assert.ok(checked === angles * speeds.length * 3 * 3 * 3, `grid coverage ${checked}`);
});

// Multi-ball fuzz: cue + two object balls, a fixed-seed grid — same invariants, cross-contact case.
test('multi-ball fuzz: no escape, no below-bed, no NaN, all settle (fixed-seed grid)', () => {
  function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  const r = rng(20260701);
  const sp = (a, b) => a + (b - a) * r();
  for (let trial = 0; trial < 60; trial++) {
    const balls = [
      mk('cue', v3.vec(sp(-0.9, -0.3), sp(-0.4, 0.4), R)),
      mk('o1', v3.vec(sp(-0.2, 0.5), sp(-0.4, 0.4), R)),
      mk('o2', v3.vec(sp(-0.2, 0.9), sp(-0.4, 0.4), R)),
    ];
    // keep them non-overlapping
    let ok = true;
    for (let i = 0; i < balls.length; i++) for (let j = i + 1; j < balls.length; j++) if (v3.len(v3.sub(balls[i].pos, balls[j].pos)) < 2.2 * R) ok = false;
    if (!ok) continue;
    const shot = { ballId: 'cue', angle: sp(0, 2 * Math.PI), speed: sp(2, MAX_SPEED), spin: { side: sp(-0.9, 0.9), vert: sp(-0.9, 0.9) }, elevation: r() < 0.25 ? sp(0, Math.PI / 6) : 0 };
    const res = runEngine({ balls, bounds: B, pockets: pockets() }, shot, {});
    assert.ok(res.settled && !res.hitCap, `trial ${trial}: not settled (events=${res.events})`);
    for (const b of res.balls) {
      if (b.pocketed) continue;
      assert.ok(finite(b.pos) && finite(b.vel), `trial ${trial}: NaN state`);
      assert.ok(Math.abs(b.pos.z - R) < 1e-6, `trial ${trial}: ${b.id} not resting on bed, z=${b.pos.z}`);
      assert.ok(Math.abs(b.pos.x) <= HX - R + 3e-3 && Math.abs(b.pos.y) <= HY - R + 3e-3, `trial ${trial}: ${b.id} outside at (${b.pos.x.toFixed(3)},${b.pos.y.toFixed(3)})`);
    }
  }
});

// Termination: every legal shot reaches rest in a BOUNDED number of events and finite time.
test('every shot terminates: bounded event count, finite settle time, no cap hit (grid)', () => {
  let maxEvents = 0;
  for (let ai = 0; ai < 12; ai++) {
    for (const speed of [2, 5, MAX_SPEED]) {
      for (const elevation of [0, Math.PI / 6]) {
        const cue = mk('cue', v3.vec(-0.5, 0.1, R));
        const res = runEngine({ balls: [cue], bounds: B, pockets: pockets() }, { ballId: 'cue', angle: (2 * Math.PI * ai) / 12, speed, spin: { side: 0.6, vert: -0.6 }, elevation }, {});
        assert.ok(res.settled, `did not settle`);
        assert.ok(!res.hitCap, `hit the safety cap`);
        assert.ok(res.events < 2000, `event count ${res.events} unexpectedly large (possible Zeno)`);
        const endT = res.timeline[res.timeline.length - 1].t;
        assert.ok(Number.isFinite(endT) && endT < 60, `settle time ${endT}s not finite/bounded`);
        maxEvents = Math.max(maxEvents, res.events);
      }
    }
  }
  assert.ok(maxEvents > 0);
});

// No-Zeno: within one bounce episode the intervals decay (geometric restitution) and the chain is
// finite. A jump launched straight up-and-forward on an otherwise open path bounces on the bed
// several times before rolling; those consecutive bed intervals (the FIRST episode, before any
// rail hop starts a fresh one) must be strictly non-increasing.
test('multi-bounce jump: bounce intervals decay within an episode and terminate (no Zeno)', () => {
  // near-vertical launch from the centre spot: the ball bounces in place many times with no rail.
  const cue = mk('cue', v3.vec(0, 0, R));
  const res = runEngine({ balls: [cue], bounds: B, pockets: pockets() }, { ballId: 'cue', angle: 0, speed: 2, spin: {}, elevation: 1.45 }, {});
  // first bounce episode = bed events up to (not past) the first rail event
  const firstRail = res.timeline.findIndex((s) => s.kind === 'rail');
  const cut = firstRail === -1 ? res.timeline.length : firstRail;
  const bedTimes = res.timeline.slice(0, cut).filter((s) => s.kind === 'bed').map((s) => s.t);
  assert.ok(bedTimes.length >= 3, `expected a multi-bounce episode, got ${bedTimes.length} bed events`);
  const gaps = [];
  for (let i = 1; i < bedTimes.length; i++) gaps.push(bedTimes[i] - bedTimes[i - 1]);
  for (let i = 1; i < gaps.length; i++) {
    assert.ok(gaps[i] <= gaps[i - 1] + 1e-9, `bounce interval ${i} rose: ${gaps[i - 1]} → ${gaps[i]}`);
  }
  assert.ok(res.settled && !res.hitCap, 'the bounce chain must terminate');
});
