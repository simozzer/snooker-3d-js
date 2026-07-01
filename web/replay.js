// replay.js — the PURE interpolation core of the 3D renderer (no three.js, no DOM), so it can be
// unit-tested headlessly. Given the engine's timeline it reconstructs the ball state at any time by
// evaluating each ball's closed-form plan on its interval. By construction the state AT an event
// time equals the engine's reported snapshot (posAt(plan, 0) = snapshot pos) — that is the
// render-vs-engine parity the renderer relies on.

import { twoPhasePlan, posAt, spinAt } from '../src/motion.js';

// Rebuild every interval's per-ball plan once, so replayState is a cheap lookup + evaluate.
export function buildPlanCache(timeline, R) {
  const cache = new Map();
  for (let i = 0; i < timeline.length; i++) {
    for (const e of timeline[i].balls) {
      if (e.pocketed) continue; // pocketed balls read their snapshot pos directly — no plan needed
      cache.set(`${i}:${e.id}`, twoPhasePlan(e.pos, e.vel, e.spin, R));
    }
  }
  return cache;
}

// State of every ball at absolute time t: find the interval [seg.t, next.t) containing t, and
// evaluate each ball's plan (built from seg's start snapshot) at (t − seg.t). Pocketed balls stay
// at their snapshot position. Returns id → { pos:{x,y,z}, spin:{x,y,z}, phase, pocketed, cleared }.
export function replayState(timeline, cache, t) {
  let i = 0;
  while (i + 1 < timeline.length && timeline[i + 1].t <= t) i += 1;
  const seg = timeline[i];
  const out = new Map();
  const local = t - seg.t;
  for (const e of seg.balls) {
    if (e.pocketed) {
      out.set(e.id, { pos: { ...e.pos }, spin: { x: 0, y: 0, z: 0 }, phase: e.phase, pocketed: true, cleared: e.cleared });
    } else {
      const plan = cache.get(`${i}:${e.id}`);
      out.set(e.id, { pos: posAt(plan, local), spin: spinAt(plan, local), phase: e.phase, pocketed: false, cleared: false });
    }
  }
  return out;
}
