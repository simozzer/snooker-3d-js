// t_analytic.test.js — MILESTONE T groups 5 & 6: analytic-event correctness (vs an independent
// dense numerical sampler) and determinism. The closed-form first-crossing times (bed, ball-ball,
// rail) must agree with a fine fixed-dt march of the SAME trajectories — proving the analytic
// solver isn't missing or mis-ordering events. And identical inputs must give identical results.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as v3 from '../src/vec3.js';
import { BALL, GRAVITY } from '../src/snooker.js';
import { Ball, posAt } from '../src/motion.js';
import { detectBed, detectPair, detectRail } from '../src/events.js';
import { runEngine } from '../src/engine.js';
import { bounds, pockets, railCylinders } from '../src/table.js';

const R = BALL.radius;
const M = BALL.mass;
const mk = (id, pos, vel, spin = v3.vec(0, 0, 0)) => new Ball({ id, kind: 'cue', radius: R, mass: M, pos, vel, spin });
function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const span = (r, a, b) => a + (b - a) * r();

// Dense fixed-dt march of a plan; returns the first t in (0, horizon] where pred(pos) first holds,
// bracketed to the step. An INDEPENDENT truth source for the analytic solvers.
function sampledFirst(plan, pred, horizon, dt = 2e-5) {
  let prev = false;
  for (let t = 0; t <= horizon; t += dt) {
    const p = posAt(plan, t);
    const hit = pred(p);
    if (hit && !prev && t > dt) return t;
    if (hit && t <= dt && pred(posAt(plan, 0))) { /* already in contact at t0: ignore */ }
    prev = hit;
  }
  return Infinity;
}

test('detectBed first-contact time matches a dense numerical march (30 airborne seeds)', () => {
  const r = rng(11);
  for (let i = 0; i < 30; i++) {
    const vz = span(r, 0.5, 3);
    const b = mk('b', v3.vec(span(r, -0.5, 0.5), span(r, -0.3, 0.3), R), v3.vec(span(r, -2, 2), span(r, -2, 2), vz));
    const ev = detectBed(b, 0);
    assert.ok(ev, `seed ${i}: analytic found no bed contact`);
    // sampled first return to z<=R after launch (skip the launch instant at z=R rising). Horizon is
    // the closed-form flight time 2·vz/g with a margin. The sampler brackets to its step dt, so the
    // analytic (exact) answer must sit within a couple of steps — tolerance tracks dt, not 25×.
    const tSampled = sampledFirst(b.plan, (p) => p.z <= R + 1e-9, (2 * vz) / GRAVITY + 0.01);
    assert.ok(Math.abs(ev.time - tSampled) < 6e-5, `seed ${i}: analytic ${ev.time} vs sampled ${tSampled}`);
  }
});

test('detectPair first-contact time matches a dense numerical march (30 approaching seeds)', () => {
  const r = rng(22);
  let done = 0;
  for (let i = 0; i < 60 && done < 30; i++) {
    const a = mk('a', v3.vec(span(r, -0.6, -0.2), span(r, -0.2, 0.2), R), v3.vec(span(r, 1, 4), span(r, -1, 1), 0), v3.vec(0, 0, span(r, -8, 8)));
    const b = mk('b', v3.vec(span(r, 0.1, 0.5), span(r, -0.2, 0.2), R), v3.vec(0, 0, 0), v3.vec(0, 0, 0));
    if (v3.len(v3.sub(a.pos, b.pos)) < 3 * R) continue;
    const tAnalytic = detectPair(a, b, 0);
    // sampled: first time centre-centre distance <= 2R, marching both plans
    const horizon = Math.max(a.plan.tStop, b.plan.tStop) + 0.1;
    let tSampled = Infinity;
    for (let t = 2e-5; t <= horizon; t += 2e-5) {
      if (v3.len(v3.sub(posAt(a.plan, t), posAt(b.plan, t))) <= 2 * R) { tSampled = t; break; }
    }
    if (tSampled === Infinity && tAnalytic === Infinity) { done++; continue; } // agree: no contact
    assert.ok(Math.abs(tAnalytic - tSampled) < 1e-3, `seed ${i}: analytic ${tAnalytic} vs sampled ${tSampled}`);
    done++;
  }
  assert.ok(done >= 30, `only exercised ${done} pair cases`);
});

test('detectRail first-contact time matches a dense numerical march (rail cylinder distance)', () => {
  const r = rng(33);
  const rails = railCylinders(R, bounds(), pockets());
  for (let i = 0; i < 24; i++) {
    // launch a bed ball toward the top rail from the lower half at a clear x
    const x0 = span(r, -1.5, 1.5);
    const b = mk('b', v3.vec(x0, span(r, -0.6, 0), R), v3.vec(span(r, -1, 1), span(r, 1.5, 4), 0), v3.vec(0, 0, 0));
    const ev = detectRail(b, rails, 0);
    if (!ev) continue; // some launches miss (aimed at a pocket gap) — skip, covered elsewhere
    // sampled: first time the perpendicular-plane distance to the hit rail's axis <= R+rc,
    // within its along-span (mirror the analytic contact condition independently)
    const rail = ev.rail;
    const perpAx = rail.axis === 'x' ? 'y' : 'x';
    const along = rail.axis;
    let tSampled = Infinity;
    for (let t = 2e-5; t <= b.plan.tStop; t += 2e-5) {
      const p = posAt(b.plan, t);
      const d = Math.hypot(p[perpAx] - rail.perp, p.z - rail.z);
      if (d <= R + rail.rc && p[along] >= rail.span[0] && p[along] <= rail.span[1]) { tSampled = t; break; }
    }
    assert.ok(tSampled < Infinity, `seed ${i}: sampler found no rail contact the analytic did`);
    assert.ok(Math.abs(ev.time - tSampled) < 1e-3, `seed ${i}: analytic ${ev.time} vs sampled ${tSampled}`);
  }
});

test('the analytic solver picks the EARLIEST of competing crossings (bed vs rail ordering)', () => {
  // A ball launched low toward a near rail while airborne: the engine must resolve whichever
  // physical contact (bed landing or rail) actually comes first — cross-check the ordering.
  const r = rng(44);
  let asserted = 0;
  for (let i = 0; i < 30; i++) {
    const b = mk('b', v3.vec(span(r, 1.0, 1.5), 0, R), v3.vec(span(r, 1, 3), 0, span(r, 0.4, 1.5)));
    const rails = railCylinders(R, bounds(), pockets());
    const bed = detectBed(b, 0);
    const rail = detectRail(b, rails, 0);
    const firstAnalytic = Math.min(bed ? bed.time : Infinity, rail ? rail.time : Infinity);
    // sampled: march until either z<=R (bed, after launch) or the rail is reached — matching
    // detectRail's actual condition (the EARLIER of the cylinder distance ≤ R+rc OR the horizontal
    // perpendicular distance ≤ R, i.e. reaching the wall line), within the rail's along-span.
    let tSampled = Infinity;
    for (let t = 2e-5; t <= b.plan.tStop + 0.05; t += 2e-5) {
      const p = posAt(b.plan, t);
      const nearRail = rails.some((rl) => {
        const perpAx = rl.axis === 'x' ? 'y' : 'x';
        const inSpan = p[rl.axis] >= rl.span[0] && p[rl.axis] <= rl.span[1];
        const cyl = Math.hypot(p[perpAx] - rl.perp, p.z - rl.z) <= R + rl.rc;
        const flat = Math.abs(p[perpAx] - rl.perp) <= R;
        return inSpan && (cyl || flat);
      });
      if ((t > 2e-5 && p.z <= R + 1e-9) || nearRail) { tSampled = t; break; }
    }
    if (tSampled === Infinity) continue;
    assert.ok(Math.abs(firstAnalytic - tSampled) < 1e-3, `seed ${i}: first analytic ${firstAnalytic} vs sampled ${tSampled}`);
    asserted++;
  }
  assert.ok(asserted >= 15, `only ${asserted} competing-crossing cases actually asserted (vacuous risk)`);
});

// DETERMINISM — identical inputs ⇒ identical event sequence and final state, repeated many times.
function fingerprint(res) {
  const seq = res.timeline.map((s) => `${s.t.toFixed(9)}:${s.kind}:${s.hit ? JSON.stringify(s.hit) : ''}`).join('|');
  const fin = res.balls.map((b) => `${b.id}:${b.pos.x.toFixed(12)},${b.pos.y.toFixed(12)},${b.pos.z.toFixed(12)}`).join(';');
  return seq + '#' + fin;
}

test('determinism: identical inputs give an identical event sequence + final state (30 repeats × 5 shots)', () => {
  const r = rng(2718);
  const shots = [];
  for (let i = 0; i < 5; i++) shots.push({ ballId: 'cue', angle: span(r, 0, 2 * Math.PI), speed: span(r, 2, 7), spin: { side: span(r, -0.9, 0.9), vert: span(r, -0.9, 0.9) }, elevation: i % 2 ? span(r, 0, 0.4) : 0 });
  for (const shot of shots) {
    let ref = null;
    for (let rep = 0; rep < 30; rep++) {
      const cue = mk('cue', v3.vec(-0.7, 0.05, R), v3.vec(0, 0, 0));
      const obj = mk('obj', v3.vec(0.1, -0.05, R), v3.vec(0, 0, 0));
      const res = runEngine({ balls: [cue, obj], bounds: bounds(), pockets: pockets() }, shot, {});
      const fp = fingerprint(res);
      if (ref === null) ref = fp;
      else assert.equal(fp, ref, `nondeterminism at repeat ${rep}`);
    }
  }
});

test('determinism: a hard multi-ball break is reproducible to the last bit (15 repeats)', () => {
  const rackR = 2 * R + 1e-4;
  const build = () => {
    const balls = [mk('cue', v3.vec(-0.8, 0, R), v3.vec(0, 0, 0))];
    let id = 0;
    for (let row = 0; row < 3; row++) for (let k = 0; k <= row; k++) balls.push(mk(`r${id++}`, v3.vec(0.2 + row * rackR * 0.87, (k - row / 2) * rackR, R), v3.vec(0, 0, 0)));
    return balls;
  };
  let ref = null;
  for (let rep = 0; rep < 15; rep++) {
    const res = runEngine({ balls: build(), bounds: bounds(), pockets: pockets() }, { ballId: 'cue', angle: 0.03, speed: 7.5, spin: { side: 0.5, vert: 0.3 } }, {});
    const fp = fingerprint(res);
    if (ref === null) ref = fp; else assert.equal(fp, ref, `break nondeterministic at repeat ${rep}`);
  }
});
